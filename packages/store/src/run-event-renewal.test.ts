import assert from "node:assert/strict"
import test from "node:test"
import { claimTask, renewClaim } from "./claims"
import { recordDispatchAttempt, recordRunEvent, recordRunReceipt } from "./dispatch"
import { startTask } from "./start"
import { createTask } from "./tasks"
import { getActiveClaimForTask } from "./projections"
import { StoreHandle } from "./store-handle"
import { importCommit } from "./cutover"
import { cleanupDir, setupGoldenRepo } from "./__test-helpers__"

/**
 * T-143 (C4 / a51f6ab): `mapctx run event` renews the claim as a by-product
 * of recording liveness, addressed by dispatchId, with no credential.
 * `appendRunEventClaimRenewal` runs inside the SAME transaction as the
 * event append, after it; a duplicate/conflicting event never reaches it.
 */

function materialize() {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  const committed = importCommit({ cwd: repoDir, actor: "test-actor" });
  const handle = StoreHandle.open(committed.storeDir);
  return { repoDir, restoreEnv, handle, committed };
}

function claimableTask(handle: StoreHandle, id: string, effort = "4h") {
  const created = createTask(handle, { id, title: `Run event task ${id}`, workload: "Normal", detail: { estimatedEffort: effort }, actor: "test" });
  assert.equal(created.ok, true, JSON.stringify(created));
  return id;
}

function runEvent(dispatchId: string, attempt: number, sequence: number, timestamp: string, type: "heartbeat" | "progress" | "started" | "completed" = "heartbeat") {
  return { schemaVersion: 1 as const, dispatchId, attempt, sequence, type, timestamp, payload: {} };
}

function receiptFor(dispatchId: string, attempt: number, startedAt: string, endedAt: string) {
  return {
    schemaVersion: 1 as const,
    dispatchId,
    attempt,
    outcome: "completed" as const,
    startedAt,
    endedAt,
    changedFiles: ["README.md"],
    usageEvents: [],
    evidence: [],
    failure: null
  };
}

function eventCount(handle: StoreHandle, eventType: string): number {
  return handle.listEvents().filter(e => e.eventType === eventType).length;
}

// ---------------------------------------------------------------------------
// 4. Renews: event on the latest attempt, claim live, no receipt.
// ---------------------------------------------------------------------------

test("a liveness event on the latest attempt with a live claim and no receipt renews: exactly one task.claim-renewed, journaled AFTER run.event-recorded", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-920");
    const claimedAt = () => new Date("2026-10-16T09:00:00.000Z");
    const started = startTask(handle, { taskId: "T-920", actor: "worker", now: claimedAt, status: "running" });
    assert.ok(started.ok, JSON.stringify(started));
    if (!started.ok) return;

    const result = recordRunEvent(
      handle,
      runEvent(started.dispatch.dispatchId, started.dispatch.attempt, 0, "2026-10-16T09:20:00.000Z"),
      "worker",
      started.dispatch.dispatchId,
      { renew: { now: () => new Date("2026-10-16T09:20:00.000Z") } }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.ok(result.renewal);
    assert.equal(result.renewal!.renewed, true);
    if (result.renewal!.renewed) {
      assert.equal(result.renewal!.claimId, started.claim.claimId);
      assert.ok(new Date(result.renewal!.expiresAt).getTime() > new Date(started.claim.expiresAt).getTime(), "expiresAt must have advanced");
    }

    assert.equal(eventCount(handle, "task.claim-renewed"), 1);
    const events = handle.listEvents();
    const eventIndex = events.findIndex(e => e.eventType === "run.event-recorded");
    const renewIndex = events.findIndex(e => e.eventType === "task.claim-renewed");
    assert.ok(eventIndex >= 0 && renewIndex >= 0);
    assert.ok(renewIndex > eventIndex, "task.claim-renewed must be journaled after run.event-recorded, in the same transaction");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 5. Stale attempt: event journaled, renewal refused, zero task.claim-renewed.
// ---------------------------------------------------------------------------

test("an event on an attempt that is no longer the latest is journaled but renews nothing: reason stale-attempt, zero task.claim-renewed", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-921");
    const claimedAt = () => new Date("2026-10-16T09:00:00.000Z");
    const started = startTask(handle, { taskId: "T-921", actor: "worker", now: claimedAt, status: "running" });
    assert.ok(started.ok, JSON.stringify(started));
    if (!started.ok) return;
    const { dispatchId } = started.dispatch;

    const nextAttempt = recordDispatchAttempt(handle, {
      dispatchId, taskId: "T-921", executorKind: "cli", contextHash: "retry-hash", attempt: started.dispatch.attempt + 1, status: "running"
    }, "worker");
    assert.ok(nextAttempt.ok, JSON.stringify(nextAttempt));

    const result = recordRunEvent(
      handle,
      runEvent(dispatchId, started.dispatch.attempt, 0, "2026-10-16T09:10:00.000Z"), // the now-stale attempt 1
      "worker",
      dispatchId,
      { renew: { now: () => new Date("2026-10-16T09:10:00.000Z") } }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.ok(result.renewal);
    assert.equal(result.renewal!.renewed, false);
    if (!result.renewal!.renewed) assert.equal(result.renewal!.reason, "stale-attempt");

    assert.equal(eventCount(handle, "task.claim-renewed"), 0);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 6. Receipt already landed on the latest attempt: journaled, nothing renews.
// ---------------------------------------------------------------------------

test("an event on an attempt whose receipt already landed is journaled but renews nothing: reason receipt-landed", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-922");
    const claimedAt = () => new Date("2026-10-16T09:00:00.000Z");
    const started = startTask(handle, { taskId: "T-922", actor: "worker", now: claimedAt, status: "running" });
    assert.ok(started.ok, JSON.stringify(started));
    if (!started.ok) return;
    const { dispatchId, attempt } = started.dispatch;

    const receipt = recordRunReceipt(handle, receiptFor(dispatchId, attempt, "2026-10-16T09:00:00.000Z", "2026-10-16T09:15:00.000Z"), "worker");
    assert.ok(receipt.ok, JSON.stringify(receipt));

    const result = recordRunEvent(
      handle,
      runEvent(dispatchId, attempt, 0, "2026-10-16T09:20:00.000Z"),
      "worker",
      dispatchId,
      { renew: { now: () => new Date("2026-10-16T09:20:00.000Z") } }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.ok(result.renewal);
    assert.equal(result.renewal!.renewed, false);
    if (!result.renewal!.renewed) assert.equal(result.renewal!.reason, "receipt-landed");
    assert.equal(eventCount(handle, "task.claim-renewed"), 0);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 7. Duplicate/conflicting events: the pre-existing rule. Nothing (event or
// renewal) is journaled for either.
// ---------------------------------------------------------------------------

test("a duplicate (dispatch, attempt, sequence) refuses before any append: no new run.event-recorded, no task.claim-renewed", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-923");
    const claimedAt = () => new Date("2026-10-16T09:00:00.000Z");
    const started = startTask(handle, { taskId: "T-923", actor: "worker", now: claimedAt, status: "running" });
    assert.ok(started.ok, JSON.stringify(started));
    if (!started.ok) return;
    const { dispatchId, attempt } = started.dispatch;
    const event = runEvent(dispatchId, attempt, 0, "2026-10-16T09:05:00.000Z");

    const first = recordRunEvent(handle, event, "worker", dispatchId, { renew: { now: () => new Date("2026-10-16T09:05:00.000Z") } });
    assert.equal(first.ok, true, JSON.stringify(first));

    const eventsBefore = eventCount(handle, "run.event-recorded");
    const renewsBefore = eventCount(handle, "task.claim-renewed");

    const duplicate = recordRunEvent(handle, event, "worker", dispatchId, { renew: { now: () => new Date("2026-10-16T09:10:00.000Z") } });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.reason, "duplicate-run-event");

    assert.equal(eventCount(handle, "run.event-recorded"), eventsBefore, "no new event journaled for the duplicate");
    assert.equal(eventCount(handle, "task.claim-renewed"), renewsBefore, "no renewal from the duplicate's refusal");

    const conflicting = recordRunEvent(
      handle,
      runEvent(dispatchId, attempt, 0, "2026-10-16T09:05:00.000Z", "progress"), // same key, different type
      "worker", dispatchId,
      { renew: { now: () => new Date("2026-10-16T09:15:00.000Z") } }
    );
    assert.equal(conflicting.ok, false);
    if (!conflicting.ok) assert.equal(conflicting.reason, "conflicting-run-event");
    assert.equal(eventCount(handle, "run.event-recorded"), eventsBefore, "no new event journaled for the conflicting one either");
    assert.equal(eventCount(handle, "task.claim-renewed"), renewsBefore, "no renewal from the conflicting refusal");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 8. The 24h ceiling: past it, journaled but not renewed; inside it, clamped.
// ---------------------------------------------------------------------------

test("past the 24h ceiling (measured from claimedAt), heartbeats are journaled but do not renew, reason ceiling-reached, even in sequence", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-924");
    const claimedAtMs = new Date("2026-10-16T09:00:00.000Z").getTime();
    // An explicit initial lease LONGER than the ceiling (claimTask itself does
    // not enforce the ceiling -- only renewal does), so the claim's own
    // expiresAt is still in the future at the probing instant below. Without
    // this, the probe would hit claim-expired first (the claim's normal
    // derived ~2h lease is long gone by hour 24) and never reach the
    // ceiling-reached branch this test exists to pin.
    const started = startTask(handle, { taskId: "T-924", actor: "worker", now: () => new Date(claimedAtMs), status: "running", leaseDurationMs: 30 * 60 * 60 * 1000 });
    assert.ok(started.ok, JSON.stringify(started));
    if (!started.ok) return;
    const { dispatchId, attempt } = started.dispatch;
    const ceilingMs = claimedAtMs + 24 * 60 * 60 * 1000;

    for (let i = 0; i < 2; i += 1) {
      const nowMs = ceilingMs + i * 1000; // at and past the ceiling, in sequence
      const result = recordRunEvent(
        handle,
        runEvent(dispatchId, attempt, i, new Date(nowMs).toISOString()),
        "worker", dispatchId,
        { renew: { now: () => new Date(nowMs) } }
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) return;
      assert.ok(result.renewal);
      assert.equal(result.renewal!.renewed, false, `event ${i}: must not renew past the ceiling`);
      if (!result.renewal!.renewed) assert.equal(result.renewal!.reason, "ceiling-reached");
    }
    assert.equal(eventCount(handle, "task.claim-renewed"), 0);
    assert.equal(eventCount(handle, "run.event-recorded"), 2, "both events are still journaled");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("inside the 24h window, a renewal that would cross the ceiling is clamped to it, not refused: expiresAt === claimedAt + 24h, cappedByCeiling true", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-925");
    const claimedAtMs = new Date("2026-10-16T09:00:00.000Z").getTime();
    // The claim's own initial lease must still be alive at the probing
    // instant (23h in), so it is not simply expired by then -- 23.5h, well
    // past the normal ~2h derived lease, for the same reason as the test above.
    const started = startTask(handle, { taskId: "T-925", actor: "worker", now: () => new Date(claimedAtMs), status: "running", leaseDurationMs: 23.5 * 60 * 60 * 1000 });
    assert.ok(started.ok, JSON.stringify(started));
    if (!started.ok) return;
    const { dispatchId, attempt } = started.dispatch;
    const ceilingMs = claimedAtMs + 24 * 60 * 60 * 1000;
    const nowMs = claimedAtMs + 23 * 60 * 60 * 1000; // 1h before the ceiling; derived lease (2h, from 4h effort x 0.5) would cross it

    const result = recordRunEvent(
      handle,
      runEvent(dispatchId, attempt, 0, new Date(nowMs).toISOString()),
      "worker", dispatchId,
      { renew: { now: () => new Date(nowMs) } }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.ok(result.renewal);
    assert.equal(result.renewal!.renewed, true);
    if (result.renewal!.renewed) {
      assert.equal(result.renewal!.expiresAt, new Date(ceilingMs).toISOString());
      assert.equal(result.renewal!.cappedByCeiling, true);
    }
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 9. The 24h ceiling on the explicit renewClaim path too (D4 applies everywhere).
// ---------------------------------------------------------------------------

test("renewClaim itself refuses past the 24h ceiling: reason ceiling-reached", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-926");
    const claimedAtMs = new Date("2026-10-16T09:00:00.000Z").getTime();
    // Same reason as the two tests above: the claim's OWN lease must still
    // be alive at the probing instant, or the earlier claim-expired check
    // fires first and this test never reaches ceiling-reached.
    const claim = claimTask(handle, { taskId: "T-926", actor: "worker", now: () => new Date(claimedAtMs), leaseDurationMs: 30 * 60 * 60 * 1000 });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;

    const pastCeiling = renewClaim(handle, {
      taskId: "T-926", claimId: claim.claim.claimId, leaseToken: claim.claim.leaseToken, actor: "x",
      now: () => new Date(claimedAtMs + 24 * 60 * 60 * 1000)
    });
    assert.equal(pastCeiling.ok, false);
    if (!pastCeiling.ok) assert.equal(pastCeiling.reason, "ceiling-reached");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 10. Missing/expired claim: no-active-claim; claim-expired writes nothing
// (no task.claim-expired from this path).
// ---------------------------------------------------------------------------

test("no active claim at all: reason no-active-claim", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-927");
    // A dispatch with NO claim ever taken (requireActiveClaim defaults
    // false). Admission status is "claimed", not "running": the execution
    // state machine's unclaimed -> running edge is illegal (only
    // unclaimed -> claimed is), and there really is no claim here to carry
    // it to "claimed" either way.
    const dispatch = recordDispatchAttempt(handle, {
      dispatchId: "11111111-1111-4111-8111-111111111111", taskId: "T-927", executorKind: "cli", contextHash: "hash", attempt: 1, status: "claimed"
    }, "worker");
    assert.ok(dispatch.ok, JSON.stringify(dispatch));

    const result = recordRunEvent(
      handle,
      runEvent(dispatch.dispatch.dispatchId, 1, 0, "2026-10-16T09:00:00.000Z"),
      "worker", dispatch.dispatch.dispatchId,
      { renew: { now: () => new Date("2026-10-16T09:00:00.000Z") } }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.ok(result.renewal);
    assert.equal(result.renewal!.renewed, false);
    if (!result.renewal!.renewed) assert.equal(result.renewal!.reason, "no-active-claim");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("an expired claim: reason claim-expired, and NO task.claim-expired is journaled by this path (count before/after)", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-928");
    const claimedAt = () => new Date("2026-10-16T09:00:00.000Z");
    const started = startTask(handle, { taskId: "T-928", actor: "worker", now: claimedAt, leaseDurationMs: 1000, status: "running" });
    assert.ok(started.ok, JSON.stringify(started));
    if (!started.ok) return;
    const { dispatchId, attempt } = started.dispatch;

    const expiredEventsBefore = eventCount(handle, "task.claim-expired");
    const afterExpiry = () => new Date("2026-10-16T09:00:02.000Z"); // 2s later, past the 1s lease

    const result = recordRunEvent(
      handle,
      runEvent(dispatchId, attempt, 0, afterExpiry().toISOString()),
      "worker", dispatchId,
      { renew: { now: afterExpiry } }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.ok(result.renewal);
    assert.equal(result.renewal!.renewed, false);
    if (!result.renewal!.renewed) assert.equal(result.renewal!.reason, "claim-expired");

    assert.equal(eventCount(handle, "task.claim-expired"), expiredEventsBefore, "this by-product path writes no claim lifecycle event on expiry");
    assert.ok(getActiveClaimForTask(handle.db, "T-928"), "the row is untouched -- still 'active' (a ghost), this path writes nothing to retire it");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 11. Resolves the task's one active claim via dispatch -> taskId, even when
// the claim and the dispatch were created independently of each other.
// ---------------------------------------------------------------------------

test("resolves and renews the task's one active claim via dispatch -> taskId, even when the claim was never minted alongside the dispatch", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-929");
    const claimedAt = () => new Date("2026-10-16T09:00:00.000Z");
    // Claim and dispatch minted independently -- proves resolution goes
    // through taskId, not through any reference the dispatch itself carries.
    const claim = claimTask(handle, { taskId: "T-929", actor: "worker", now: claimedAt });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;
    const dispatch = recordDispatchAttempt(handle, {
      dispatchId: "22222222-2222-4222-8222-222222222222", taskId: "T-929", executorKind: "cli", contextHash: "hash", attempt: 1, status: "running"
    }, "worker");
    assert.ok(dispatch.ok, JSON.stringify(dispatch));

    const result = recordRunEvent(
      handle,
      runEvent(dispatch.dispatch.dispatchId, 1, 0, "2026-10-16T09:05:00.000Z"),
      "worker", dispatch.dispatch.dispatchId,
      { renew: { now: () => new Date("2026-10-16T09:05:00.000Z") } }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.ok(result.renewal);
    assert.equal(result.renewal!.renewed, true);
    if (result.renewal!.renewed) assert.equal(result.renewal!.claimId, claim.claim.claimId);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 12. Opt-in: no {renew} option means no renewal key at all.
// ---------------------------------------------------------------------------

test("recordRunEvent without {renew} returns exactly {ok:true, event} -- no renewal key, protecting every pre-existing caller", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-930");
    const started = startTask(handle, { taskId: "T-930", actor: "worker", now: () => new Date("2026-10-16T09:00:00.000Z"), status: "running" });
    assert.ok(started.ok, JSON.stringify(started));
    if (!started.ok) return;

    const result = recordRunEvent(
      handle,
      runEvent(started.dispatch.dispatchId, started.dispatch.attempt, 0, "2026-10-16T09:05:00.000Z"),
      "worker",
      started.dispatch.dispatchId
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(!("renewal" in result), `no {renew} option was passed, so no renewal key must be present: ${JSON.stringify(result)}`);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});
