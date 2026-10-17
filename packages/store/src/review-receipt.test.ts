import assert from "node:assert/strict"
import test from "node:test"
import { recordDispatchAttempt, recordRunReceipt } from "./dispatch"
import { getTask, listDispatchAttempts, listNonImplementAttemptKeys } from "./projections"
import { repairStore } from "./repair"
import { StoreHandle } from "./store-handle"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

/**
 * T-145 (C6 / §3): a review receipt records the review and nothing else. It
 * advances its OWN dispatch attempt's status and lands its own receipt row;
 * it must never move the task's `executionState` or `planningState`, which
 * describe the implement run alone. All three receipt admission points
 * (`dispatch.ts`'s command path, `events.ts`'s raw-append gate,
 * `projections.ts`'s applier) branch on the dispatch's lane, and this file
 * is the delta on top of 76ec8d4 that pins each branch independently.
 */

const IMPLEMENT_DISPATCH = "10000000-0000-4000-8000-000000000001";
const REVIEW_DISPATCH = "20000000-0000-4000-8000-000000000002";

function seedTask(handle: StoreHandle, taskId: string, planningState: string, executionState = "unclaimed"): void {
  handle.appendEvent({
    eventType: "project.initialized",
    actor: "test",
    payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" }
  });
  handle.appendEvent({
    eventType: "task.upserted",
    actor: "test",
    payload: {
      task: {
        taskId, positionKey: 0, title: "x", planningState, executionState,
        tags: [], domains: [], externalLinks: [], assignees: []
      }
    }
  });
}

function dispatch(dispatchId: string, taskId: string, kind: "implement" | "review", attempt = 1) {
  return { dispatchId, taskId, executorKind: "test", attempt, contextHash: "hash", status: "claimed" as const, kind, actor: "test" };
}

function receiptFor(dispatchId: string, outcome: "completed" | "failed", startedAt: string, endedAt: string, attempt = 1) {
  return {
    schemaVersion: 1 as const,
    dispatchId,
    attempt,
    outcome,
    startedAt,
    endedAt,
    changedFiles: ["README.md"],
    usageEvents: [],
    evidence: [],
    failure: outcome === "failed" ? { message: "boom", category: "unknown" as const, retryable: false } : null
  };
}

// ---------------------------------------------------------------------------
// A. The four measured orders: a review receipt never drives planning or
//    execution, in either order, and never revives a failed implementation.
// ---------------------------------------------------------------------------

test("review-then-implement: the review receipt leaves planning/execution byte-identical; the implement receipt afterward advances both as usual", () => {
  const dir = mkTmpDir("mapctx-review-receipt-order-1-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-100", "in-progress", "claimed");
    assert.equal(recordDispatchAttempt(handle, dispatch(IMPLEMENT_DISPATCH, "T-100", "implement")).ok, true);
    assert.equal(recordDispatchAttempt(handle, dispatch(REVIEW_DISPATCH, "T-100", "review")).ok, true);

    const planningBefore = getTask(handle.db, "T-100")!.planningState;
    const executionBefore = getTask(handle.db, "T-100")!.executionState;
    assert.equal(planningBefore, "in-progress");
    assert.equal(executionBefore, "claimed");

    const reviewReceipt = recordRunReceipt(handle, receiptFor(REVIEW_DISPATCH, "completed", "2026-10-17T09:00:00.000Z", "2026-10-17T09:10:00.000Z"), "reviewer");
    assert.equal(reviewReceipt.ok, true, JSON.stringify(reviewReceipt));
    // Read from the PROJECTION, not the returned object: `recordRunReceipt`
    // builds its `dispatch.status` as `{...dispatch, status: value.outcome}`
    // in the return statement itself, so asserting against the returned
    // value can never fail regardless of what the applier actually wrote to
    // dispatch_projection -- it would pass even if the write were suppressed
    // entirely. Reading the row back from storage is the only way this
    // assertion has an oracle.
    const reviewAttemptRow = listDispatchAttempts(handle.db, REVIEW_DISPATCH)[0];
    assert.equal(reviewAttemptRow?.status, "completed", "the review dispatch's OWN attempt still advances, in the PROJECTION");

    assert.equal(getTask(handle.db, "T-100")!.planningState, planningBefore, "planning must be byte-identical after the review receipt");
    assert.equal(getTask(handle.db, "T-100")!.executionState, executionBefore, "execution must be byte-identical after the review receipt");

    const implementReceipt = recordRunReceipt(handle, receiptFor(IMPLEMENT_DISPATCH, "completed", "2026-10-17T08:00:00.000Z", "2026-10-17T09:30:00.000Z"), "worker");
    assert.equal(implementReceipt.ok, true, JSON.stringify(implementReceipt));
    assert.equal(getTask(handle.db, "T-100")!.planningState, "review", "the implement receipt still drives planning as before");
    assert.equal(getTask(handle.db, "T-100")!.executionState, "completed");

    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("implement-then-review: the implement receipt moves planning to review; the review receipt afterward leaves it there, byte-identical", () => {
  const dir = mkTmpDir("mapctx-review-receipt-order-2-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-101", "in-progress", "claimed");
    assert.equal(recordDispatchAttempt(handle, dispatch(IMPLEMENT_DISPATCH, "T-101", "implement")).ok, true);
    assert.equal(recordDispatchAttempt(handle, dispatch(REVIEW_DISPATCH, "T-101", "review")).ok, true);

    const implementReceipt = recordRunReceipt(handle, receiptFor(IMPLEMENT_DISPATCH, "completed", "2026-10-17T08:00:00.000Z", "2026-10-17T09:00:00.000Z"), "worker");
    assert.equal(implementReceipt.ok, true, JSON.stringify(implementReceipt));
    assert.equal(getTask(handle.db, "T-101")!.planningState, "review");
    assert.equal(getTask(handle.db, "T-101")!.executionState, "completed");

    const reviewReceipt = recordRunReceipt(handle, receiptFor(REVIEW_DISPATCH, "completed", "2026-10-17T09:05:00.000Z", "2026-10-17T09:15:00.000Z"), "reviewer");
    assert.equal(reviewReceipt.ok, true, JSON.stringify(reviewReceipt));

    assert.equal(getTask(handle.db, "T-101")!.planningState, "review", "stays review, untouched by the review receipt");
    assert.equal(getTask(handle.db, "T-101")!.executionState, "completed", "stays completed, untouched by the review receipt");

    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("a failed implementation with a review open: the review receipt afterward does not revive ready/failed", () => {
  const dir = mkTmpDir("mapctx-review-receipt-order-3-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-102", "in-progress", "claimed");
    assert.equal(recordDispatchAttempt(handle, dispatch(IMPLEMENT_DISPATCH, "T-102", "implement")).ok, true);
    assert.equal(recordDispatchAttempt(handle, dispatch(REVIEW_DISPATCH, "T-102", "review")).ok, true);

    const failedReceipt = recordRunReceipt(handle, receiptFor(IMPLEMENT_DISPATCH, "failed", "2026-10-17T08:00:00.000Z", "2026-10-17T08:30:00.000Z"), "worker");
    assert.equal(failedReceipt.ok, true, JSON.stringify(failedReceipt));
    assert.equal(getTask(handle.db, "T-102")!.planningState, "ready");
    assert.equal(getTask(handle.db, "T-102")!.executionState, "failed");

    const reviewReceipt = recordRunReceipt(handle, receiptFor(REVIEW_DISPATCH, "completed", "2026-10-17T08:35:00.000Z", "2026-10-17T08:45:00.000Z"), "reviewer");
    assert.equal(reviewReceipt.ok, true, JSON.stringify(reviewReceipt));

    assert.equal(getTask(handle.db, "T-102")!.planningState, "ready", "a completed REVIEW receipt must not revive a failed implementation's planning state");
    assert.equal(getTask(handle.db, "T-102")!.executionState, "failed", "nor its execution state");

    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("a review receipt on a backlog task is accepted and moves nothing; the contrasting implement receipt on the same task is refused with task-not-in-progress", () => {
  const dir = mkTmpDir("mapctx-review-receipt-order-4-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-103", "backlog");
    assert.equal(recordDispatchAttempt(handle, dispatch(REVIEW_DISPATCH, "T-103", "review")).ok, true);

    const reviewReceipt = recordRunReceipt(handle, receiptFor(REVIEW_DISPATCH, "completed", "2026-10-17T09:00:00.000Z", "2026-10-17T09:10:00.000Z"), "reviewer");
    assert.equal(reviewReceipt.ok, true, "a review receipt has nothing for a backlog planning state to be wrong FOR");
    assert.equal(getTask(handle.db, "T-103")!.planningState, "backlog", "moves nothing");
    assert.equal(getTask(handle.db, "T-103")!.executionState, "unclaimed", "moves nothing");

    // Contrast: the implement path DOES care, and refuses the same shape of
    // request on the same backlog task -- this is what gives the review
    // branch's silent acceptance above its meaning.
    assert.equal(recordDispatchAttempt(handle, dispatch(IMPLEMENT_DISPATCH, "T-103", "implement")).ok, true);
    const implementReceipt = recordRunReceipt(handle, receiptFor(IMPLEMENT_DISPATCH, "completed", "2026-10-17T09:00:00.000Z", "2026-10-17T09:10:00.000Z"), "worker");
    assert.equal(implementReceipt.ok, false, JSON.stringify(implementReceipt));
    if (!implementReceipt.ok) assert.equal(implementReceipt.reason, "task-not-in-progress");

    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// A (raw path): the SAME guarantee at the raw new-event admission gate
// (`assertNewEventAdmission` in events.ts), which `recordRunReceipt`'s
// command-level checks never reach.
// ---------------------------------------------------------------------------

test("a raw run.receipt-recorded event for a REVIEW dispatch is admitted on a backlog task, where the equivalent IMPLEMENT event would throw", () => {
  const dir = mkTmpDir("mapctx-review-receipt-raw-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-104", "backlog");
    assert.equal(recordDispatchAttempt(handle, dispatch(REVIEW_DISPATCH, "T-104", "review")).ok, true);
    assert.equal(recordDispatchAttempt(handle, dispatch(IMPLEMENT_DISPATCH, "T-104", "implement")).ok, true);

    assert.doesNotThrow(() => handle.appendEvent({
      eventType: "run.receipt-recorded",
      actor: "reviewer",
      payload: { receipt: receiptFor(REVIEW_DISPATCH, "completed", "2026-10-17T09:00:00.000Z", "2026-10-17T09:10:00.000Z") }
    }), "a raw review receipt must be admitted regardless of planning state");
    assert.equal(getTask(handle.db, "T-104")!.planningState, "backlog");

    assert.throws(() => handle.appendEvent({
      eventType: "run.receipt-recorded",
      actor: "worker",
      payload: { receipt: receiptFor(IMPLEMENT_DISPATCH, "completed", "2026-10-17T09:00:00.000Z", "2026-10-17T09:10:00.000Z") }
    }), "the equivalent raw IMPLEMENT event on the same backlog task must be refused by the same admission gate");

    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// D (critério 3): legacy journal (pre-kind events) replays as implement, and
// `listNonImplementAttemptKeys` reports no lane exclusion for it.
// ---------------------------------------------------------------------------

test("replay of a legacy (kind-absent) dispatch and its receipt reproduces implement lane calibration eligibility, before and after repairStore", () => {
  const dir = mkTmpDir("mapctx-review-receipt-legacy-replay-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-105", "in-progress", "claimed");
    const legacyDispatchId = "30000000-0000-4000-8000-000000000003";
    // Shaped exactly like a dispatch recorded before T-144: no `kind` at all.
    handle.appendEvent({
      eventType: "dispatch.attempted",
      actor: "worker",
      payload: {
        dispatch: { dispatchId: legacyDispatchId, taskId: "T-105", executorKind: "cli", attempt: 1, contextHash: "legacy-hash", status: "claimed" }
      }
    });
    assert.equal(recordRunReceipt(handle, receiptFor(legacyDispatchId, "completed", "2026-10-17T08:00:00.000Z", "2026-10-17T08:30:00.000Z"), "worker").ok, true);

    const keysBefore = listNonImplementAttemptKeys(handle.db);
    assert.ok(!keysBefore.has(`${legacyDispatchId}/1`), "a legacy, kind-absent attempt must NOT be excluded from calibration");
    assert.equal(getTask(handle.db, "T-105")!.planningState, "review", "a legacy receipt still drives planning, exactly as before T-144/T-145 existed");

    handle.close();
    assert.equal(repairStore(dir).status, "ok");
    const replayed = StoreHandle.open(dir);
    try {
      const keysAfter = listNonImplementAttemptKeys(replayed.db);
      assert.ok(!keysAfter.has(`${legacyDispatchId}/1`), "replay must reproduce the same (non-)exclusion");
      assert.equal(getTask(replayed.db, "T-105")!.planningState, "review");
    } finally {
      replayed.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
