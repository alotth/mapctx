import assert from "node:assert/strict";
import test from "node:test";
import {
  DispatchAttemptHistory,
  emptyDispatchAttemptHistory,
  evaluateRunReceipt,
  latestAttemptNumber,
  recordAcceptedReceipt,
  recordAttempt
} from "./attempt-lifecycle";
import { ENVELOPE_SCHEMAS } from "./envelopes";
import { ENVELOPE_FIXTURES } from "./fixtures";
import {
  DISPATCH_TRANSITIONS,
  assertTransition,
  canTransitionDispatch,
  illegalDispatchTransitions,
  transitionDispatch
} from "./state-machines";

const DISPATCH_ID = "9b2e4d71-6c18-4a0f-b3d5-11aa22bb33cc";
const OTHER_DISPATCH_ID = "00000000-0000-4000-8000-000000000000";

test("dispatch attempt state machine: legal transitions and terminal states have none", () => {
  assert.equal(canTransitionDispatch("claimed", "running"), true);
  assert.equal(canTransitionDispatch("running", "completed"), true);
  assert.equal(canTransitionDispatch("running", "blocked"), true);
  assert.equal(canTransitionDispatch("blocked", "running"), true);
  assert.equal(canTransitionDispatch("completed", "running"), false);
  assert.equal(canTransitionDispatch("failed", "running"), false);
  assert.equal(canTransitionDispatch("cancelled", "claimed"), false);
  assert.equal(canTransitionDispatch("expired", "claimed"), false);

  for (const terminal of ["completed", "failed", "cancelled", "expired"] as const) {
    assert.deepEqual(DISPATCH_TRANSITIONS[terminal], []);
  }

  assert.throws(() => assertTransition("dispatch", "completed", "running"), /Illegal dispatch transition/);
  assert.equal(transitionDispatch("claimed", "running").ok, true);

  const illegal = illegalDispatchTransitions();
  assert.ok(illegal.length > 0);
  for (const { from, to } of illegal) {
    assert.equal(canTransitionDispatch(from, to), false);
  }
});

test("evaluateRunReceipt accepts the receipt for the current (latest) attempt", () => {
  let history = emptyDispatchAttemptHistory(DISPATCH_ID);
  history = recordAttempt(history, { attempt: 1, status: "running" });

  const decision = evaluateRunReceipt(history, { dispatchId: DISPATCH_ID, attempt: 1 });
  assert.deepEqual(decision, { accepted: true });
});

test("evaluateRunReceipt rejects a late receipt from an obsolete attempt", () => {
  let history = emptyDispatchAttemptHistory(DISPATCH_ID);
  history = recordAttempt(history, { attempt: 1, status: "failed" });
  history = recordAttempt(history, { attempt: 2, status: "running" });

  // Attempt 1's receipt shows up after attempt 2 was already dispatched.
  const decision = evaluateRunReceipt(history, { dispatchId: DISPATCH_ID, attempt: 1 });
  assert.deepEqual(decision, { accepted: false, reason: "stale-attempt" });

  // Attempt 2, the current attempt, is still accepted.
  assert.deepEqual(evaluateRunReceipt(history, { dispatchId: DISPATCH_ID, attempt: 2 }), { accepted: true });
});

test("evaluateRunReceipt rejects a duplicate receipt for an already-accepted attempt", () => {
  let history = emptyDispatchAttemptHistory(DISPATCH_ID);
  history = recordAttempt(history, { attempt: 1, status: "completed" });
  history = recordAcceptedReceipt(history, 1);

  const decision = evaluateRunReceipt(history, { dispatchId: DISPATCH_ID, attempt: 1 });
  assert.deepEqual(decision, { accepted: false, reason: "duplicate-receipt" });
});

test("evaluateRunReceipt rejects receipts for an unknown attempt or the wrong dispatch", () => {
  let history = emptyDispatchAttemptHistory(DISPATCH_ID);
  history = recordAttempt(history, { attempt: 1, status: "running" });

  assert.deepEqual(evaluateRunReceipt(history, { dispatchId: DISPATCH_ID, attempt: 2 }), {
    accepted: false,
    reason: "unknown-attempt"
  });
  assert.deepEqual(evaluateRunReceipt(history, { dispatchId: OTHER_DISPATCH_ID, attempt: 1 }), {
    accepted: false,
    reason: "dispatch-mismatch"
  });
});

test("recordAttempt is idempotent per attempt number and keeps history sorted", () => {
  let history: DispatchAttemptHistory = emptyDispatchAttemptHistory(DISPATCH_ID);
  history = recordAttempt(history, { attempt: 2, status: "running" });
  history = recordAttempt(history, { attempt: 1, status: "failed" });
  history = recordAttempt(history, { attempt: 2, status: "completed" });

  assert.deepEqual(
    history.attempts.map((a) => a.attempt),
    [1, 2]
  );
  assert.equal(history.attempts.find((a) => a.attempt === 2)?.status, "completed");
  assert.equal(latestAttemptNumber(history), 2);
  assert.equal(latestAttemptNumber(emptyDispatchAttemptHistory(DISPATCH_ID)), null);
});

test("RunReceipt requires failure detail exactly when outcome is failed", () => {
  const base = ENVELOPE_FIXTURES.RunReceipt;
  assert.equal(base.outcome, "completed");
  assert.equal(base.failure, null);
  assert.equal(ENVELOPE_SCHEMAS.RunReceipt.safeParse(base).success, true);

  const failedWithoutDetail = { ...base, outcome: "failed" as const, failure: null };
  assert.equal(ENVELOPE_SCHEMAS.RunReceipt.safeParse(failedWithoutDetail).success, false);

  const failedWithDetail = {
    ...base,
    outcome: "failed" as const,
    failure: { category: "executor-error" as const, message: "worktree merge conflict", retryable: true }
  };
  assert.equal(ENVELOPE_SCHEMAS.RunReceipt.safeParse(failedWithDetail).success, true);

  const completedWithDetail = {
    ...base,
    failure: { category: "unknown" as const, message: "should not be here", retryable: false }
  };
  assert.equal(ENVELOPE_SCHEMAS.RunReceipt.safeParse(completedWithDetail).success, false);
});
