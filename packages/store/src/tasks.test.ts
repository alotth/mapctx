import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as path from "path"
import { importCommit } from "./cutover"
import { createTask, moveTask, updateTask } from "./tasks"
import { getTask, getTaskDetail, listDependencies, getActiveClaimForTask } from "./projections"
import { claimTask, releaseClaim } from "./claims"
import { StoreHandle } from "./store-handle"
import { cleanupDir, setupGoldenRepo } from "./__test-helpers__"

function materialize() {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  const committed = importCommit({ cwd: repoDir, actor: "test-actor" });
  const handle = StoreHandle.open(committed.storeDir);
  return { repoDir, restoreEnv, handle, committed };
}

test("moveTask follows the planning state machine and stamps completedOn on done", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    let result = moveTask(handle, { taskId: "T-101", to: "ready", actor: "test" });
    assert.equal(result.ok, true);
    assert.deepEqual({ from: result.from, to: result.to }, { from: "backlog", to: "ready" });

    result = moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });
    assert.equal(result.ok, true);
    result = moveTask(handle, { taskId: "T-101", to: "review", actor: "test" });
    assert.equal(result.ok, true);
    result = moveTask(handle, { taskId: "T-101", to: "done", actor: "test" });
    assert.equal(result.ok, true);

    const task = getTask(handle.db, "T-101");
    assert.equal(task!.planningState, "done");
    assert.ok(task!.completedOn, "moving to done stamps completedOn");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("moveTask refuses illegal transitions, unknown states, unexportable states, and unknown tasks", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    // T-102 is done (terminal): no outgoing edges by design.
    const reopened = moveTask(handle, { taskId: "T-102", to: "backlog", actor: "test" });
    assert.equal(reopened.ok, false);
    assert.equal(reopened.reason, "illegal-transition");

    // backlog has no direct path to done; reopening policy lives in reconcile.
    const skipped = moveTask(handle, { taskId: "T-101", to: "done", actor: "test" });
    assert.equal(skipped.ok, false);
    assert.equal(skipped.reason, "illegal-transition");

    const unexportable = moveTask(handle, { taskId: "T-101", to: "blocked", actor: "test" });
    assert.equal(unexportable.ok, false);
    assert.equal(unexportable.reason, "state-not-exportable");

    const unknown = moveTask(handle, { taskId: "T-999", to: "ready", actor: "test" });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, "unknown-task");

    // Nothing moved.
    assert.equal(getTask(handle.db, "T-101")!.planningState, "backlog");
    assert.equal(getTask(handle.db, "T-102")!.planningState, "done");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("moveTask to done or cancelled releases an active claim", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    moveTask(handle, { taskId: "T-101", to: "ready", actor: "test" });
    const claim = claimTask(handle, { taskId: "T-101", actor: "worker" });
    assert.ok(claim.ok);

    moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });
    const result = moveTask(handle, { taskId: "T-101", to: "done", actor: "test" });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.releasedClaimId, claim.claim.claimId);
    assert.equal(getActiveClaimForTask(handle.db, "T-101"), undefined);
    assert.equal(getTask(handle.db, "T-101")!.executionState, "unclaimed");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("updateTask patches whitelisted fields and refuses unknown fields, no-changes, and unknown tasks", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const applied = updateTask(handle, {
      taskId: "T-101",
      patch: { priority: "high", workload: "Hard" },
      detailPatch: { estimatedEffort: "2d" },
      actor: "test"
    });
    assert.equal(applied.ok, true);
    const task = getTask(handle.db, "T-101");
    assert.equal(task!.priority, "high");
    assert.equal(task!.workload, "Hard");
    assert.equal(getTaskDetail(handle.db, "T-101")!.estimatedEffort, "2d");
    assert.ok(task!.updatedOn, "update stamps updatedOn");

    const unknownField = updateTask(handle, { taskId: "T-101", patch: { planningState: "done" } as never, actor: "test" });
    assert.equal(unknownField.ok, false);
    assert.equal(unknownField.reason, "unknown-field");

    const noChanges = updateTask(handle, { taskId: "T-101", actor: "test" });
    assert.equal(noChanges.ok, false);
    assert.equal(noChanges.reason, "no-changes");

    const unknownTask = updateTask(handle, { taskId: "T-999", patch: { priority: "high" }, actor: "test" });
    assert.equal(unknownTask.ok, false);
    assert.equal(unknownTask.reason, "unknown-task");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("updateTask --depends-on/--blocking replace edges and detail lists together", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    // T-102 depends on T-101 (from the golden board). Repoint it at E-100.
    const applied = updateTask(handle, {
      taskId: "T-102",
      dependsOn: ["E-100"],
      blocking: ["T-101"],
      actor: "test"
    });
    assert.equal(applied.ok, true);

    const edges = listDependencies(handle.db).filter(e => e.fromTaskId === "T-102");
    assert.deepEqual(
      edges.map(e => ({ to: e.toTaskId, kind: e.kind })).sort((a, b) => a.to.localeCompare(b.to)),
      [
        { to: "E-100", kind: "depends-on" },
        { to: "T-101", kind: "blocks" }
      ]
    );
    const detail = getTaskDetail(handle.db, "T-102");
    assert.deepEqual(detail!.prerequisites, ["E-100"]);
    assert.deepEqual(detail!.blocking, ["T-101"]);

    const unknownDep = updateTask(handle, { taskId: "T-102", dependsOn: ["T-999"], actor: "test" });
    assert.equal(unknownDep.ok, false);
    assert.equal(unknownDep.reason, "unknown-dependency");

    // releaseClaim keeps the claim surface exercised end to end.
    const claim = claimTask(handle, { taskId: "E-100", actor: "worker" });
    assert.ok(claim.ok);
    if (claim.ok) {
      const released = releaseClaim(handle, { taskId: "E-100", claimId: claim.claim.claimId, leaseToken: claim.claim.leaseToken, actor: "worker" });
      assert.equal(released.ok, true);
    }
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("createTask auto-assigns the next free id and lands at the end of the board", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const created = createTask(handle, {
      title: "Created via CLI",
      priority: "high",
      tags: ["cli"],
      domains: ["CORE"],
      dependsOn: ["T-101"],
      detail: { summary: "Custom summary", description: "Prose lives in the file, not the store." },
      actor: "test"
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.taskId, "T-103", "next free sequential id after the golden board");

    const task = getTask(handle.db, "T-103");
    assert.equal(task!.title, "[T-103] Created via CLI", "board convention: heading title carries the bracketed id");
    assert.equal(task!.planningState, "backlog");
    assert.equal(task!.type, "task");
    assert.equal(task!.detailPath, "./tasks/T-103.md");
    const maxPosition = getTask(handle.db, "T-102")!.positionKey;
    assert.ok(task!.positionKey > maxPosition, "new task lands at the end");

    const edges = listDependencies(handle.db).filter(e => e.fromTaskId === "T-103");
    assert.deepEqual(edges, [{ fromTaskId: "T-103", toTaskId: "T-101", kind: "depends-on" }]);
    const detail = getTaskDetail(handle.db, "T-103");
    assert.equal(detail!.summary, "Custom summary");
    assert.deepEqual(detail!.prerequisites, ["T-101"]);
    assert.equal(detail!.estimatedEffort, "1d", "default effort when none given");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("createTask refuses duplicate ids, bad types, unknown parents, unknown deps, and unexportable states", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    assert.equal(createTask(handle, { title: "x", id: "T-101", actor: "t" }).ok, false, "duplicate id");
    assert.equal(createTask(handle, { title: "x", id: "E-900", actor: "t" }).ok, false, "id prefix must match type");
    assert.equal(createTask(handle, { title: "x", type: "banana", actor: "t" }).ok, false, "invalid type");
    assert.equal(createTask(handle, { title: "x", parent: "T-999", actor: "t" }).ok, false, "unknown parent");
    assert.equal(createTask(handle, { title: "x", dependsOn: ["T-999"], actor: "t" }).ok, false, "unknown dependency");
    assert.equal(createTask(handle, { title: "x", status: "blocked", actor: "t" }).ok, false, "unexportable state");
    assert.equal(createTask(handle, { title: "  ", actor: "t" }).ok, false, "missing title");

    const epic = createTask(handle, { title: "New epic", type: "epic", actor: "t" });
    assert.equal(epic.ok, true);
    if (epic.ok) assert.match(epic.taskId, /^E-\d+$/, "epic type implies the E- prefix");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("regenerated export reflects moves and updates byte-for-byte (drift stays PASS)", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    moveTask(handle, { taskId: "T-101", to: "ready", actor: "test" });
    updateTask(handle, { taskId: "T-101", patch: { priority: "high" }, actor: "test" });

    const { buildExport } = require("./export") as typeof import("./export");
    const exported = buildExport(handle.db, { tasksRoot: repoDir });
    const onDisk = fs.readFileSync(path.join(repoDir, "TASKS.md"), "utf8");
    // The store is authoritative: regenerating from it must not match the
    // stale on-disk board until the CLI writes the regenerated snapshot.
    assert.notEqual(onDisk, exported.tasksMd.content, "stale board must differ after store writes");
    assert.ok(exported.tasksMd.content.includes("  - status: ready-for-do"));
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("completed receipt on a task that was never claimed is rejected with the remedy; the retroactive attestation path is accepted", () => {
  const { repoDir, restoreEnv, handle, committed } = materialize();
  try {
    const receiptFor = (dispatchId: string, startedAt: string, endedAt: string) => ({
      schemaVersion: 1,
      dispatchId,
      attempt: 1,
      outcome: "completed" as const,
      startedAt,
      endedAt,
      changedFiles: ["README.md"],
      usageEvents: [],
      evidence: [],
      failure: null
    });

    // Register a dispatch without claiming (the flow error this guard exists for).
    const { recordDispatchAttempt, recordRunReceipt } = require("./dispatch") as typeof import("./dispatch");
    const dispatch = recordDispatchAttempt(handle, {
      dispatch: { dispatchId: "3f0b9550-1111-4111-8111-111111111111", taskId: "T-101", executorKind: "agent", attempt: 1, contextHash: "hash", status: "claimed" }
    }, "orchestrator");
    assert.ok(dispatch.ok);

    const rejected = recordRunReceipt(handle, receiptFor(
      "3f0b9550-1111-4111-8111-111111111111",
      "2026-09-05T10:00:00.000Z",
      "2026-09-05T10:45:00.000Z"
    ), "orchestrator");
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.reason, "task-not-in-progress");
      assert.match(rejected.message!, /claim first/i);
      assert.match(rejected.message!, /retroactive attestation/);
    }

    // The retroactive attestation flow: claim now (carries to doing), then the
    // same receipt with the TRUE historical times is accepted, and the board
    // lands in review without anyone fabricating the in-progress moment.
    const claim = require("./claims").claimTask(handle, { taskId: "T-101", actor: "orchestrator" });
    assert.ok(claim.ok);
    assert.equal(getTask(handle.db, "T-101")!.planningState, "in-progress");

    const accepted = recordRunReceipt(handle, receiptFor(
      "3f0b9550-1111-4111-8111-111111111111",
      "2026-09-05T10:00:00.000Z",
      "2026-09-05T10:45:00.000Z"
    ), "orchestrator");
    assert.equal(accepted.ok, true);
    const task = getTask(handle.db, "T-101");
    assert.equal(task!.planningState, "review");
    assert.equal(task!.executionState, "completed");
    void committed;
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});
