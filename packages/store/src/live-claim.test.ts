import assert from "node:assert/strict"
import test from "node:test"
import { importCommit } from "./cutover"
import { moveTask, updateTask } from "./tasks"
import { approveAcceptanceCriterion, reviseAcceptance } from "./acceptance"
import { getActiveExclusiveClaimForTask, getClaim, getLiveActiveClaim, getTask } from "./projections"
import { claimTask } from "./claims"
import { StoreHandle } from "./store-handle"
import { repairStore } from "./repair"
import { cleanupDir, setupGoldenRepo } from "./__test-helpers__"

/**
 * T-140 / C1 (D14), attempt 2 (ea700a4): read-time lease truth. These tests
 * isolate the delta on top of fd577ca -- getLiveActiveClaim's expiry
 * boundary, that it writes nothing, reclaim without a sweeper, and moveTask's
 * done/cancelled/archived branch journaling `task.claim-expired` (by
 * `system`) for a ghost claim instead of a fictitious `task.claim-released`,
 * while still releasing a live one exactly as before.
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

test("getLiveActiveClaim's expiry boundary is exact (expiresAt <= now is expired); getActiveExclusiveClaimForTask takes no `now` and so cannot be filtered by it", () => {
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

    // getActiveExclusiveClaimForTask has no `now` parameter, so it reads the same row
    // regardless of what instant getLiveActiveClaim was just probed at above
    // -- one call here is the whole proof, a loop over the three `now`s would
    // just invoke it three times with nothing to vary.
    const active = getActiveExclusiveClaimForTask(handle.db, "T-101");
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
    const row = getActiveExclusiveClaimForTask(handle.db, "T-101");
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
// D14 attempt 2 (ea700a4): moveTask's done/cancelled/archived branch journals
// `task.claim-expired` (by `system`) for a ghost claim, `task.claim-released`
// (by the closing actor) for a live one.
// ---------------------------------------------------------------------------

function assertGhostClosed(handle: StoreHandle, taskId: string, oldClaimId: string, closeResult: { ok: true; releasedClaimId?: string; expiredClaimId?: string }) {
  assert.equal(closeResult.releasedClaimId, undefined, "closing over a ghost reports no releasedClaimId");
  assert.equal(closeResult.expiredClaimId, oldClaimId, "closing over a ghost reports the expired claim's id");
  assert.equal(claimReleasedEvents(handle, taskId).length, 0, "no task.claim-released for a ghost claim");
  const expired = claimExpiredEvents(handle, taskId);
  assert.equal(expired.length, 1, "exactly one task.claim-expired for the ghost");
  assert.equal((expired[0]!.payload as { claimId: string }).claimId, oldClaimId);
  assert.equal(expired[0]!.actor, "system", "the close's own actor never appears on this event -- the row was true before it closed anything");
  assert.equal(getActiveExclusiveClaimForTask(handle.db, taskId), undefined, "the row is retired: no longer active");
  const retired = getClaim(handle.db, oldClaimId);
  assert.ok(retired);
  assert.equal(retired!.state, "expired");
  assert.equal(getTask(handle.db, taskId)!.executionState, "unclaimed", "task.claim-expired clears executionState too, same as a reclaim would");
}

function assertLiveClosed(handle: StoreHandle, taskId: string, liveClaimId: string, closeResult: { ok: true; releasedClaimId?: string; expiredClaimId?: string }) {
  assert.equal(closeResult.releasedClaimId, liveClaimId);
  assert.ok(!("expiredClaimId" in closeResult), "a close that releases a live claim keeps the exact result shape it always had -- no expiredClaimId key at all");
  const released = claimReleasedEvents(handle, taskId);
  assert.equal(released.length, 1, "exactly one task.claim-released for a live claim");
  assert.equal((released[0]!.payload as { claimId: string }).claimId, liveClaimId);
  assert.equal(claimExpiredEvents(handle, taskId).length, 0, "no task.claim-expired comes from closing a live claim");
  assert.equal(getActiveExclusiveClaimForTask(handle.db, taskId), undefined, "the live claim row is retired on release");
  assert.equal(getTask(handle.db, taskId)!.executionState, "unclaimed", "releasing a live claim flips executionState back");
}

test("move done over an expired (ghost) claim: ok, task.claim-expired by system (not released), executionState clears, completedOn still stamped, patch still lands", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const claim = claimNormalTask(handle, "T-101", { now: () => new Date("2026-10-14T10:00:00.000Z") });
    moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });
    approveAllCriteria(handle, "T-101", ["Golden task acceptance is complete."]);

    const expiresAtMs = new Date(claim.claim!.expiresAt).getTime();
    const afterExpiry = () => new Date(expiresAtMs + 1);

    const result = moveTask(handle, { taskId: "T-101", to: "done", actor: "test", now: afterExpiry });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assertGhostClosed(handle, "T-101", claim.claim!.claimId, result);

    const patched = handle.listEvents().filter(
      event => event.eventType === "task.patched" && (event.payload as { taskId: string }).taskId === "T-101"
    );
    const lastPatch = patched[patched.length - 1]!;
    assert.equal((lastPatch.payload as { patch: Record<string, unknown> }).patch.planningState, "done", "closing is not blocked by the ghost");
    assert.ok((lastPatch.payload as { patch: { completedOn?: string } }).patch.completedOn, "completedOn is still stamped");

    // Closing already expired the row, so this is no longer the only cleanup
    // path for it -- but admission still refuses outright, since T-101 is now
    // terminal (done), before it would even look at the (already-gone) lease.
    const reclaimAt = () => new Date(expiresAtMs + 2);
    const reclaim = claimTask(handle, { taskId: "T-101", actor: "worker-2", now: reclaimAt });
    assert.equal(reclaim.ok, false, "T-101 is done (terminal), so admission itself is refused");
    if (!reclaim.ok) assert.equal(reclaim.reason, "terminal-state");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("move done over a live claim still releases it: releasedClaimId set, exactly one task.claim-released, no task.claim-expired", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const claim = claimNormalTask(handle, "T-101", { now: () => new Date("2026-10-14T10:00:00.000Z") });
    moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });
    approveAllCriteria(handle, "T-101", ["Golden task acceptance is complete."]);

    const stillLive = () => new Date("2026-10-14T10:00:01.000Z"); // 1s later, well inside the 30m default lease
    const result = moveTask(handle, { taskId: "T-101", to: "done", actor: "test", now: stillLive });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assertLiveClosed(handle, "T-101", claim.claim!.claimId, result);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("move cancelled: ghost claim is expired (not released), live claim releases exactly once", () => {
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
      if (!result.ok) continue;

      if (liveAtMoveTime) {
        assertLiveClosed(handle, "T-101", claim.claim!.claimId, result);
      } else {
        assertGhostClosed(handle, "T-101", claim.claim!.claimId, result);
      }
    } finally {
      handle.close(); restoreEnv(); cleanupDir(repoDir);
    }
  }
});

test("move archived: ghost claim is expired (not released), live claim releases exactly once", () => {
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
      if (!result.ok) continue;

      if (liveAtMoveTime) {
        assertLiveClosed(handle, "T-101", claim.claim!.claimId, result);
      } else {
        assertGhostClosed(handle, "T-101", claim.claim!.claimId, result);
      }
    } finally {
      handle.close(); restoreEnv(); cleanupDir(repoDir);
    }
  }
});

test("replay: closing over a ghost reproduces from the journal alone -- the claim row is expired and executionState is out of claimed after repair + reopen", () => {
  const { repoDir, restoreEnv, handle, committed } = materialize();
  try {
    const claim = claimNormalTask(handle, "T-101", { now: () => new Date("2026-10-14T10:00:00.000Z") });
    moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });
    approveAllCriteria(handle, "T-101", ["Golden task acceptance is complete."]);

    const expiresAtMs = new Date(claim.claim!.expiresAt).getTime();
    const afterExpiry = () => new Date(expiresAtMs + 1);
    const result = moveTask(handle, { taskId: "T-101", to: "done", actor: "test", now: afterExpiry });
    assert.equal(result.ok, true, JSON.stringify(result));
    handle.close();

    assert.equal(repairStore(committed.storeDir).status, "ok", "full rebuild from the journal alone");
    const replayed = StoreHandle.open(committed.storeDir);
    try {
      assert.equal(getActiveExclusiveClaimForTask(replayed.db, "T-101"), undefined, "replay reproduces the row as not-active");
      const retired = getClaim(replayed.db, claim.claim!.claimId);
      assert.ok(retired);
      assert.equal(retired!.state, "expired", "replay reproduces the row as expired, not a surviving ghost");
      assert.equal(getTask(replayed.db, "T-101")!.executionState, "unclaimed", "replay reproduces executionState out of claimed");
      assert.equal(getTask(replayed.db, "T-101")!.planningState, "done");
    } finally {
      replayed.close();
    }
  } finally {
    restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 43a3f67 (attempt 3): F2 -- one clock reading judges the lease AND stamps
// the claim event, so a clock that advances between calls cannot date a
// release after the very expiresAt it just read as live.
// ---------------------------------------------------------------------------

/** A clock that advances by `stepMs` on every call, starting at `startMs`. Returns the function and how many times it has been read so far. */
function tickingClock(startMs: number, stepMs: number) {
  let calls = 0;
  const now = () => new Date(startMs + calls++ * stepMs);
  return { now, callCount: () => calls };
}

test("F2 guard: closing a LIVE claim stamps task.claim-released with the exact instant that judged the lease live, never a later tick past expiresAt", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const claim = claimNormalTask(handle, "T-101", { now: () => new Date("2026-10-14T10:00:00.000Z"), leaseDurationMs: 1000 });
    moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });
    approveAllCriteria(handle, "T-101", ["Golden task acceptance is complete."]);

    const expiresAtMs = new Date(claim.claim!.expiresAt).getTime();
    const firstTickMs = expiresAtMs - 1; // 1ms before expiry: live
    const clock = tickingClock(firstTickMs, 5);

    const result = moveTask(handle, { taskId: "T-101", to: "done", actor: "test", now: clock.now });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.equal(result.releasedClaimId, claim.claim!.claimId, "sanity: the lease was read as live");
    assert.ok(clock.callCount() > 1, "sanity: the clock was read more than once across the whole move (occurredAt/updatedOn/completedOn read it again afterward, on purpose)");

    const released = claimReleasedEvents(handle, "T-101");
    assert.equal(released.length, 1);
    const occurredAtMs = new Date(released[0]!.occurredAt).getTime();
    assert.equal(occurredAtMs, firstTickMs, "the release must be stamped with the exact instant that judged the lease live, not a later tick");
    assert.ok(occurredAtMs < expiresAtMs, "and that instant must never be at or past the expiresAt it was just read as live against");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("F2 guard: closing a GHOST claim stamps task.claim-expired with the exact first instant the clock was read, the same one that judged the lease dead", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const claim = claimNormalTask(handle, "T-101", { now: () => new Date("2026-10-14T10:00:00.000Z"), leaseDurationMs: 1000 });
    moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });
    approveAllCriteria(handle, "T-101", ["Golden task acceptance is complete."]);

    const expiresAtMs = new Date(claim.claim!.expiresAt).getTime();
    const firstTickMs = expiresAtMs + 1; // 1ms after expiry: already dead
    const clock = tickingClock(firstTickMs, 5);

    const result = moveTask(handle, { taskId: "T-101", to: "done", actor: "test", now: clock.now });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) assert.equal(result.expiredClaimId, claim.claim!.claimId, "sanity: the lease was read as already dead");
    assert.ok(clock.callCount() > 1, "sanity: the clock keeps advancing for occurredAt/updatedOn/completedOn after the claim decision");

    const expired = claimExpiredEvents(handle, "T-101");
    assert.equal(expired.length, 1);
    const occurredAtMs = new Date(expired[0]!.occurredAt).getTime();
    assert.equal(occurredAtMs, firstTickMs, "the expiry must be stamped with the exact first instant read -- the same one `getLiveActiveClaim` used to call it dead");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// F4 -- both claim fields are present only when they happened, so `"…" in
// result` is honest for a close with NO claim at all (never-claimed task).
// ---------------------------------------------------------------------------

test("F4 guard: closing a task that was never claimed carries neither releasedClaimId nor expiredClaimId as a key", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    moveTask(handle, { taskId: "T-101", to: "ready", actor: "test" });
    moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });
    approveAllCriteria(handle, "T-101", ["Golden task acceptance is complete."]);

    const result = moveTask(handle, { taskId: "T-101", to: "done", actor: "test" });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.ok(!("releasedClaimId" in result), "no claim was ever taken, so no releasedClaimId key");
    assert.ok(!("expiredClaimId" in result), "no claim was ever taken, so no expiredClaimId key");
    assert.equal(claimReleasedEvents(handle, "T-101").length, 0);
    assert.equal(claimExpiredEvents(handle, "T-101").length, 0);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});
