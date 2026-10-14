import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";
import {
  approveAcceptanceCriterion,
  claimTask,
  createTask,
  getActiveClaimForTask,
  getClaim,
  reviseAcceptance,
  StoreHandle,
  upsertProject
} from "@mapctx/store";
import { buildExport } from "@mapctx/store";
import { finishTask } from "./checkpoint";

/**
 * T-140 (43a3f67, F1): `finishTask` must carry `moveTask`'s claim effect
 * through -- `releasedClaimId` for a live claim, `expiredClaimId` for a
 * ghost -- on every result shape where the move actually ran: default
 * (published), `snapshot: "none"` (skipped), and a checkpoint failure.
 */

const PROJECT_ID = "00000000-0000-0000-0000-00000000f140";

type Fixture = {
  repoDir: string;
  storeDir: string;
  handle: StoreHandle;
  taskId: string;
  close: () => void;
};

/** Same shape as checkpoint.test.ts's openFixture, with a claimable task (workload + estimate, status "ready"). */
function openFixture(): Fixture {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-finish-claim-repo-"));
  const mapctxHome = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-finish-claim-home-"));
  const previousHome = process.env.MAPCTX_HOME;
  process.env.MAPCTX_HOME = mapctxHome;
  const storeDir = path.join(mapctxHome, "projects", PROJECT_ID);
  fs.writeFileSync(path.join(repoDir, "mapctx.toml"), [
    "schemaVersion = 1",
    `projectId = "${PROJECT_ID}"`,
    'plansAuthority = "store"',
    ""
  ].join("\n"), "utf8");
  const handle = StoreHandle.open(storeDir);
  upsertProject(handle.db, {
    projectId: PROJECT_ID,
    boardTitle: "Finish claim-effect fixture",
    workDomains: [{ key: "CORE", description: "core" }],
    notesMarkdown: "",
    plansAuthority: "store",
    sourceSnapshotHash: null
  });
  const created = createTask(handle, {
    id: "T-001", title: "Finish claim-effect task", actor: "test",
    status: "ready", workload: "Normal", detail: { estimatedEffort: "1d" }
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const taskId = created.ok ? created.taskId : "T-001";
  const exported = buildExport(handle.db, { tasksRoot: repoDir });
  fs.mkdirSync(path.join(repoDir, "tasks"), { recursive: true });
  fs.writeFileSync(exported.tasksMd.path, exported.tasksMd.content, "utf8");
  for (const file of exported.taskDetailFiles) fs.writeFileSync(file.path, file.content, "utf8");
  return {
    repoDir,
    storeDir,
    handle,
    taskId,
    close: () => {
      handle.close();
      if (previousHome === undefined) delete process.env.MAPCTX_HOME;
      else process.env.MAPCTX_HOME = previousHome;
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(mapctxHome, { recursive: true, force: true });
    }
  };
}

/** Claims the fixture's task (ready -> in-progress via the claim path) and approves one acceptance criterion so the done gate passes. */
function claimAndApprove(fixture: Fixture, opts: { now?: () => Date; leaseDurationMs?: number } = {}) {
  const claim = claimTask(fixture.handle, { taskId: fixture.taskId, actor: "worker", now: opts.now, leaseDurationMs: opts.leaseDurationMs });
  assert.ok(claim.ok, JSON.stringify(claim));
  const revised = reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: "criteria", texts: ["one criterion"], actor: "author", expectRevision: 0 });
  assert.equal(revised.ok, true, JSON.stringify(revised));
  if (revised.ok) {
    const approved = approveAcceptanceCriterion(fixture.handle, { taskId: fixture.taskId, index: 0, expectRevision: revised.revision, actor: "reviewer" });
    assert.equal(approved.ok, true, JSON.stringify(approved));
  }
  return claim;
}

function claimReleasedEvents(handle: StoreHandle, taskId: string) {
  return handle.listEvents().filter(
    event => event.eventType === "task.claim-released" && (event.payload as { taskId: string }).taskId === taskId
  );
}

function claimExpiredEvents(handle: StoreHandle, taskId: string) {
  return handle.listEvents().filter(
    event => event.eventType === "task.claim-expired" && (event.payload as { taskId: string }).taskId === taskId
  );
}

test("finish over a ghost claim (default, published): move.expiredClaimId set, no releasedClaimId key, task.claim-expired by system, row expired, executionState unclaimed", () => {
  const fixture = openFixture();
  try {
    const claim = claimAndApprove(fixture, { now: () => new Date("2026-10-14T10:00:00.000Z") });
    const expiresAtMs = new Date(claim.claim!.expiresAt).getTime();
    const afterExpiry = () => new Date(expiresAtMs + 1);

    const result = finishTask(fixture.handle, fixture.repoDir, { taskId: fixture.taskId, actor: "finisher", now: afterExpiry });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.snapshot, "published");

    assert.equal(result.move.expiredClaimId, claim.claim!.claimId);
    assert.ok(!("releasedClaimId" in result.move), "a close over a ghost must not carry a releasedClaimId key at all");

    assert.equal(claimReleasedEvents(fixture.handle, fixture.taskId).length, 0);
    const expired = claimExpiredEvents(fixture.handle, fixture.taskId);
    assert.equal(expired.length, 1);
    assert.equal((expired[0]!.payload as { claimId: string }).claimId, claim.claim!.claimId);
    assert.equal(expired[0]!.actor, "system");

    assert.equal(getActiveClaimForTask(fixture.handle.db, fixture.taskId), undefined);
    const retired = getClaim(fixture.handle.db, claim.claim!.claimId);
    assert.ok(retired);
    assert.equal(retired!.state, "expired");
    const task = fixture.handle.db.prepare("SELECT execution_state FROM task_projection WHERE task_id = ?").get(fixture.taskId) as { execution_state: string };
    assert.equal(task.execution_state, "unclaimed");
  } finally {
    fixture.close();
  }
});

test("finish over a ghost claim with snapshot: \"none\": same claim effect, snapshot: \"skipped\", no checkpoint key", () => {
  const fixture = openFixture();
  try {
    const claim = claimAndApprove(fixture, { now: () => new Date("2026-10-14T10:00:00.000Z") });
    const expiresAtMs = new Date(claim.claim!.expiresAt).getTime();
    const afterExpiry = () => new Date(expiresAtMs + 1);

    const result = finishTask(fixture.handle, fixture.repoDir, { taskId: fixture.taskId, actor: "finisher", now: afterExpiry, snapshot: "none" });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.snapshot, "skipped");
    assert.ok(!("checkpoint" in result), "skipped snapshot carries no checkpoint key");

    assert.equal(result.move.expiredClaimId, claim.claim!.claimId);
    assert.ok(!("releasedClaimId" in result.move));
    assert.equal(claimExpiredEvents(fixture.handle, fixture.taskId).length, 1);
    assert.equal(claimReleasedEvents(fixture.handle, fixture.taskId).length, 0);
  } finally {
    fixture.close();
  }
});

test("finish over a live claim: move.releasedClaimId set, no expiredClaimId key", () => {
  const fixture = openFixture();
  try {
    const claim = claimAndApprove(fixture, { now: () => new Date("2026-10-14T10:00:00.000Z") });
    const stillLive = () => new Date("2026-10-14T10:00:01.000Z"); // 1s later, well inside the 30m default lease

    const result = finishTask(fixture.handle, fixture.repoDir, { taskId: fixture.taskId, actor: "finisher", now: stillLive, snapshot: "none" });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;

    assert.equal(result.move.releasedClaimId, claim.claim!.claimId);
    assert.ok(!("expiredClaimId" in result.move), "a close that releases a live claim must not carry an expiredClaimId key at all");
    assert.equal(claimReleasedEvents(fixture.handle, fixture.taskId).length, 1);
    assert.equal(claimExpiredEvents(fixture.handle, fixture.taskId).length, 0);
  } finally {
    fixture.close();
  }
});

// ---------------------------------------------------------------------------
// Checkpoint-failure result: the move already landed (claim already
// retired), and the checkpoint-stage failure must still carry that claim
// effect -- the whole point of that result shape is to make split state
// explicit. Forced deterministically the same way finish-no-snapshot.test.ts
// does: chmod tasks/ read-only so the publish step's temp-file write fails
// with EACCES, after the done move (and its claim effect) already committed.
// ---------------------------------------------------------------------------

test("a checkpoint-stage failure during finish still reports the claim effect from the move that already landed (ghost case)", () => {
  const fixture = openFixture();
  try {
    const claim = claimAndApprove(fixture, { now: () => new Date("2026-10-14T10:00:00.000Z") });
    const expiresAtMs = new Date(claim.claim!.expiresAt).getTime();
    const afterExpiry = () => new Date(expiresAtMs + 1);

    const tasksDir = path.join(fixture.repoDir, "tasks");
    fs.chmodSync(tasksDir, 0o500);
    try {
      const result = finishTask(fixture.handle, fixture.repoDir, { taskId: fixture.taskId, actor: "finisher", now: afterExpiry });
      assert.equal(result.ok, false, JSON.stringify(result));
      if (result.ok) return;
      assert.equal(result.stage, "checkpoint");
      assert.equal(result.move.performed, true, "the done move landed before the checkpoint write failed");
      assert.equal(result.move.expiredClaimId, claim.claim!.claimId, "the checkpoint-failure result must still carry the claim effect from the move that already landed");
      assert.ok(!("releasedClaimId" in result.move));
    } finally {
      fs.chmodSync(tasksDir, 0o700);
    }

    assert.equal(claimExpiredEvents(fixture.handle, fixture.taskId).length, 1, "the move's claim-expired event is durable even though the checkpoint failed");
  } finally {
    fixture.close();
  }
});
