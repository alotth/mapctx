import assert from "node:assert/strict"
import test from "node:test"
import { importCommit } from "./cutover"
import { moveTask, updateTask } from "./tasks"
import { approveAcceptanceCriterion, reviseAcceptance } from "./acceptance"
import { getActiveClaimForTask, getLiveActiveClaim, getTask } from "./projections"
import { claimTask } from "./claims"
import { StoreHandle } from "./store-handle"
import { cleanupDir, setupGoldenRepo } from "./__test-helpers__"

/**
 * T-140 / C1 (D14): read-time lease truth. These tests isolate the delta on
 * top of fd577ca -- getLiveActiveClaim's expiry boundary, that it writes
 * nothing, reclaim without a sweeper, and moveTask's done/cancelled/archived
 * branch no longer releasing a ghost claim (while still releasing a live
 * one).
 */

function materialize() {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  const committed = importCommit({ cwd: repoDir, actor: "test-actor" });
  const handle = StoreHandle.open(committed.storeDir);
  return { repoDir, restoreEnv, handle, committed };
}

/** T-120: the done gate reads store acceptance; tests author + approve it explicitly. */
function approveAllCriteria(handle: StoreHandle, taskId: string, texts: string[]): void {
  const revised = reviseAcceptance(handle, { taskId, condition: "criteria", texts, actor: "test", expectRevision: 0 });
  assert.ok(revised.ok, JSON.stringify(revised));
  if (!revised.ok) return;
  revised.criteria.forEach((criterion, index) => {
    const approved = approveAcceptanceCriterion(handle, { taskId, index, actor: "test", expectRevision: revised.revision });
    assert.ok(approved.ok, JSON.stringify(approved));
  });
}

function claimNormalTask(handle: StoreHandle, taskId: string, opts: { now?: () => Date; leaseDurationMs?: number } = {}) {
  moveTask(handle, { taskId, to: "ready", actor: "test" });
  updateTask(handle, { taskId, patch: { workload: "Normal" }, actor: "test" });
  const claim = claimTask(handle, { taskId, actor: "worker", now: opts.now, leaseDurationMs: opts.leaseDurationMs });
  assert.ok(claim.ok, JSON.stringify(claim));
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

test("getLiveActiveClaim's expiry boundary is exact (expiresAt <= now is expired); getActiveClaimForTask takes no `now` and so cannot be filtered by it", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const claim = claimNormalTask(handle, "T-101", { now: () => new Date("2026-10-14T10:00:00.000Z") });
    const expiresAtMs = new Date(claim.claim!.expiresAt).getTime();

    const justBefore = () => new Date(expiresAtMs - 1);
    const exactly = () => new Date(expiresAtMs);
    const justAfter = () => new Date(expiresAtMs + 1);

    assert.ok(getLiveActiveClaim(handle.db, "T-101", justBefore), "1ms before expiry: still live");
    assert.equal(getLiveActiveClaim(handle.db, "T-101", exactly), undefined, "at the exact expiry instant: not live");
    assert.equal(getLiveActiveClaim(handle.db, "T-101", justAfter), undefined, "1ms after expiry: not live");

    // getActiveClaimForTask has no `now` parameter, so it reads the same row
    // regardless of what instant getLiveActiveClaim was just probed at above
    // -- one call here is the whole proof, a loop over the three `now`s would
    // just invoke it three times with nothing to vary.
    const active = getActiveClaimForTask(handle.db, "T-101");
    assert.ok(active, "admission getter stays unfiltered");
    assert.equal(active!.claimId, claim.claim!.claimId);
    assert.equal(active!.state, "active");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("getLiveActiveClaim is a pure read: journal and projection are unchanged by reading an expired claim", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const claim = claimNormalTask(handle, "T-101", { now: () => new Date("2026-10-14T10:00:00.000Z") });
    const expiresAtMs = new Date(claim.claim!.expiresAt).getTime();
    const afterExpiry = () => new Date(expiresAtMs + 1);

    const eventsBefore = handle.listEvents().length;
    const result = getLiveActiveClaim(handle.db, "T-101", afterExpiry);
    assert.equal(result, undefined);
    const eventsAfter = handle.listEvents().length;

    assert.equal(eventsAfter, eventsBefore, "reading an expired claim journals no event");
    const row = getActiveClaimForTask(handle.db, "T-101");
    assert.ok(row, "projection row is untouched by the read");
    assert.equal(row!.state, "active");
    assert.equal(row!.claimId, claim.claim!.claimId);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("reclaim works without a sweeper: claimTask past expiry expires the old claim and admits a new one in one call", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const claimedAt = () => new Date("2026-10-14T10:00:00.000Z");
    const first = claimNormalTask(handle, "T-101", { now: claimedAt, leaseDurationMs: 1000 });
    const firstClaimId = first.claim!.claimId;

    const reclaimAt = () => new Date("2026-10-14T10:00:02.000Z"); // 2s later, past the 1s lease
    const second = claimTask(handle, { taskId: "T-101", actor: "worker-2", now: reclaimAt });
    assert.equal(second.ok, true, JSON.stringify(second));
    if (!second.ok) return;
    assert.equal(second.expiredPrevious, firstClaimId, "reclaim reports the expired claim it replaced");
    assert.notEqual(second.claim.claimId, firstClaimId, "reclaim mints a new claim, not a resurrection of the old one");

    const expired = claimExpiredEvents(handle, "T-101");
    assert.equal(expired.length, 1, "exactly one task.claim-expired for the old claim");
    assert.equal((expired[0]!.payload as { claimId: string }).claimId, firstClaimId);

    const live = getLiveActiveClaim(handle.db, "T-101", reclaimAt);
    assert.ok(live);
    assert.equal(live!.claimId, second.claim.claimId);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// D14: moveTask's done/cancelled/archived branch reads live lease truth.
// ---------------------------------------------------------------------------

test("move done over an expired (ghost) claim: ok, no releasedClaimId, zero task.claim-released events, completedOn still stamped, and the ghost row stays active for a later claimTask to expire", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const claim = claimNormalTask(handle, "T-101", { now: () => new Date("2026-10-14T10:00:00.000Z") });
    moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });
    approveAllCriteria(handle, "T-101", ["Golden task acceptance is complete."]);

    const expiresAtMs = new Date(claim.claim!.expiresAt).getTime();
    const afterExpiry = () => new Date(expiresAtMs + 1);

    const result = moveTask(handle, { taskId: "T-101", to: "done", actor: "test", now: afterExpiry });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.equal(result.releasedClaimId, undefined, "closing over a ghost reports no releasedClaimId");

    assert.equal(claimReleasedEvents(handle, "T-101").length, 0, "no task.claim-released for a ghost claim");

    const patched = handle.listEvents().filter(
      event => event.eventType === "task.patched" && (event.payload as { taskId: string }).taskId === "T-101"
    );
    const lastPatch = patched[patched.length - 1]!;
    assert.deepEqual((lastPatch.payload as { patch: Record<string, unknown> }).patch.planningState, "done", "closing is not blocked by the ghost");
    assert.ok((lastPatch.payload as { patch: { completedOn?: string } }).patch.completedOn, "completedOn is still stamped");

    const ghostRow = getActiveClaimForTask(handle.db, "T-101");
    assert.ok(ghostRow, "the ghost row is left alone by this path, not retired");
    assert.equal(ghostRow!.claimId, claim.claim!.claimId);
    assert.equal(ghostRow!.state, "active");

    // executionState only leaves "claimed" via task.claim-released or
    // task.claim-expired (events.ts:278-291). Neither fires on this path, so
    // the task closes "done" while still reporting "claimed" underneath --
    // a real, observable consequence of D14, not an oversight.
    assert.equal(getTask(handle.db, "T-101")!.executionState, "claimed");

    // A later claim admission is still the one honest path to retire it.
    const reclaimAt = () => new Date(expiresAtMs + 2);
    const reclaim = claimTask(handle, { taskId: "T-101", actor: "worker-2", now: reclaimAt });
    assert.equal(reclaim.ok, false, "T-101 is done (terminal), so admission itself is refused");
    if (!reclaim.ok) assert.equal(reclaim.reason, "terminal-state");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("move done over a live claim still releases it: releasedClaimId set, exactly one task.claim-released", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const claim = claimNormalTask(handle, "T-101", { now: () => new Date("2026-10-14T10:00:00.000Z") });
    moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });
    approveAllCriteria(handle, "T-101", ["Golden task acceptance is complete."]);

    const stillLive = () => new Date("2026-10-14T10:00:01.000Z"); // 1s later, well inside the 30m default lease
    const result = moveTask(handle, { taskId: "T-101", to: "done", actor: "test", now: stillLive });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.equal(result.releasedClaimId, claim.claim!.claimId);

    const released = claimReleasedEvents(handle, "T-101");
    assert.equal(released.length, 1, "exactly one task.claim-released for a live claim");
    assert.equal((released[0]!.payload as { claimId: string }).claimId, claim.claim!.claimId);

    assert.equal(getActiveClaimForTask(handle.db, "T-101"), undefined, "the live claim row is retired on release");
    assert.equal(getTask(handle.db, "T-101")!.executionState, "unclaimed", "releasing a live claim flips executionState back");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("move cancelled: ghost claim releases nothing, live claim releases exactly once", () => {
  for (const liveAtMoveTime of [false, true]) {
    const { repoDir, restoreEnv, handle } = materialize();
    try {
      const claim = claimNormalTask(handle, "T-101", { now: () => new Date("2026-10-14T10:00:00.000Z"), leaseDurationMs: 1000 });
      moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });

      const moveAt = liveAtMoveTime
        ? () => new Date("2026-10-14T10:00:00.500Z") // inside the 1s lease
        : () => new Date("2026-10-14T10:00:02.000Z"); // past the 1s lease

      const result = moveTask(handle, { taskId: "T-101", to: "cancelled", actor: "operator", now: moveAt });
      assert.equal(result.ok, true, JSON.stringify(result));

      const released = claimReleasedEvents(handle, "T-101");
      if (liveAtMoveTime) {
        if (result.ok) assert.equal(result.releasedClaimId, claim.claim!.claimId);
        assert.equal(released.length, 1, "live claim: exactly one release event");
        assert.equal(getTask(handle.db, "T-101")!.executionState, "unclaimed", "release flips executionState back");
      } else {
        if (result.ok) assert.equal(result.releasedClaimId, undefined, "ghost claim: no releasedClaimId");
        assert.equal(released.length, 0, "ghost claim: no release event");
        const ghostRow = getActiveClaimForTask(handle.db, "T-101");
        assert.ok(ghostRow, "ghost row left alone by cancelled, same as done");
        // Same consequence as the done-over-ghost case: no claim-released
        // means executionState never leaves "claimed", even though planning
        // is now terminal (cancelled).
        assert.equal(getTask(handle.db, "T-101")!.executionState, "claimed");
      }
    } finally {
      handle.close(); restoreEnv(); cleanupDir(repoDir);
    }
  }
});

test("move archived: ghost claim releases nothing, live claim releases exactly once", () => {
  for (const liveAtMoveTime of [false, true]) {
    const { repoDir, restoreEnv, handle } = materialize();
    try {
      const claim = claimNormalTask(handle, "T-101", { now: () => new Date("2026-10-14T10:00:00.000Z"), leaseDurationMs: 1000 });
      moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });

      const moveAt = liveAtMoveTime
        ? () => new Date("2026-10-14T10:00:00.500Z") // inside the 1s lease
        : () => new Date("2026-10-14T10:00:02.000Z"); // past the 1s lease

      const result = moveTask(handle, { taskId: "T-101", to: "archived", actor: "operator", now: moveAt });
      assert.equal(result.ok, true, JSON.stringify(result));

      const released = claimReleasedEvents(handle, "T-101");
      if (liveAtMoveTime) {
        if (result.ok) assert.equal(result.releasedClaimId, claim.claim!.claimId);
        assert.equal(released.length, 1, "live claim: exactly one release event");
        assert.equal(getTask(handle.db, "T-101")!.executionState, "unclaimed", "release flips executionState back");
      } else {
        if (result.ok) assert.equal(result.releasedClaimId, undefined, "ghost claim: no releasedClaimId");
        assert.equal(released.length, 0, "ghost claim: no release event");
        const ghostRow = getActiveClaimForTask(handle.db, "T-101");
        assert.ok(ghostRow, "ghost row left alone by archived, same as done");
        assert.equal(getTask(handle.db, "T-101")!.executionState, "claimed", "no claim-released means executionState never leaves claimed");
      }
    } finally {
      handle.close(); restoreEnv(); cleanupDir(repoDir);
    }
  }
});
