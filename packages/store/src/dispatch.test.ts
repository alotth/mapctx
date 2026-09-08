import assert from "node:assert/strict"
import test from "node:test"
import { getDispatchAttempt, getRunEvent, getRunReceipt, listDispatchAttempts, listRunEvents, listRunReceipts, listCostEvents, listEstimateSnapshots, listUsageEvents } from "./projections"
import { recordCostEvent, recordDispatchAttempt, recordEstimateSnapshot, recordRunEvent, recordRunReceipt } from "./dispatch"
import { claimTask, releaseClaim, renewClaim } from "./claims"
import { repairStore } from "./repair"
import { StoreHandle } from "./store-handle"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"
import { buildExport } from "./export"
import { getTask } from "./projections"
import { ENTITY_FIXTURES } from "@mapctx/protocol"

const DISPATCH_ID = "9b2e4d71-6c18-4a0f-b3d5-11aa22bb33cc"

function seedTask(handle: StoreHandle): void {
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
        taskId: "T-001",
        positionKey: 0,
        title: "x",
        planningState: "in-progress",
        executionState: "claimed",
        tags: [],
        domains: [],
        externalLinks: [],
        assignees: []
      }
    }
  });
}

function receipt(outcome: "completed" | "failed" = "completed") {
  return {
    schemaVersion: 1,
    dispatchId: DISPATCH_ID,
    attempt: 1,
    outcome,
    startedAt: "2026-08-16T19:54:07.171Z",
    endedAt: "2026-08-16T19:55:07.171Z",
    changedFiles: ["tasks/T-001.md"],
    usageEvents: [{
      usageEventId: "6b6d4a41-bff3-4c12-94c1-b84da1d8a6e3",
      dispatchId: DISPATCH_ID,
      provider: "test",
      model: "model",
      inputTokens: 10,
      cacheTokens: 2,
      outputTokens: 3,
      source: "manual" as const,
      coverage: "full" as const
    }],
    evidence: [],
    failure: outcome === "failed" ? { category: "executor-error" as const, message: "boom", retryable: true } : null
  };
}

function seedDispatch(handle: StoreHandle): void {
  seedTask(handle);
  const result = recordDispatchAttempt(handle, {
    dispatchId: DISPATCH_ID,
    taskId: "T-001",
    executorKind: "test",
    attempt: 1,
    contextHash: "hash",
    status: "claimed",
    actor: "test"
  });
  assert.equal(result.ok, true);
}

function runEvent(sequence: number, timestamp: string, type: "started" | "progress" | "completed" = "progress") {
  return {
    schemaVersion: 1,
    dispatchId: DISPATCH_ID,
    attempt: 1,
    sequence,
    type,
    timestamp,
    payload: { sequence }
  } as const;
}

test("dispatch attempt and receipt persist losslessly and query by task", () => {
  const dir = mkTmpDir("mapctx-store-dispatch-roundtrip-");
  try {
    const handle = StoreHandle.open(dir);
    seedDispatch(handle);
    const result = recordRunReceipt(handle, receipt(), "test");
    assert.equal(result.ok, true);
    assert.deepEqual(getDispatchAttempt(handle.db, DISPATCH_ID, 1)?.status, "completed");
    assert.equal((handle.db.prepare("SELECT execution_state, planning_state FROM task_projection WHERE task_id = ?").get("T-001") as { execution_state: string; planning_state: string }).execution_state, "completed");
    assert.equal((handle.db.prepare("SELECT execution_state, planning_state FROM task_projection WHERE task_id = ?").get("T-001") as { execution_state: string; planning_state: string }).planning_state, "review");
    assert.deepEqual(getRunReceipt(handle.db, DISPATCH_ID, 1), receipt());
    assert.deepEqual(listRunReceipts(handle.db, undefined, "T-001"), [receipt()]);
    assert.deepEqual(listDispatchAttempts(handle.db, undefined, "T-001").map(d => d.attempt), [1]);
    assert.deepEqual((handle.db.prepare("SELECT usage_event_id, input_tokens, output_tokens FROM usage_event_projection").all() as unknown[]).length, 1);
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("schema-valid run events persist append-only, round-trip, order, and deduplicate by sequence", () => {
  const dir = mkTmpDir("mapctx-store-run-events-");
  try {
    const handle = StoreHandle.open(dir);
    seedDispatch(handle);
    const late = runEvent(2, "2026-08-16T19:55:00.000Z");
    const early = runEvent(1, "2026-08-16T19:54:10.000Z");
    assert.deepEqual(recordRunEvent(handle, late, "test"), { ok: true, event: late });
    assert.deepEqual(recordRunEvent(handle, early, "test"), { ok: true, event: early });
    assert.deepEqual(listRunEvents(handle.db, DISPATCH_ID, 1), [early, late]);
    assert.deepEqual(getRunEvent(handle.db, DISPATCH_ID, 1, 1), early);
    assert.deepEqual(recordRunEvent(handle, early, "test"), { ok: false, reason: "duplicate-run-event" });
    assert.deepEqual(recordRunEvent(handle, { ...early, type: "heartbeat" }, "test"), { ok: false, reason: "conflicting-run-event" });
    assert.equal((handle.listEvents().filter(event => event.eventType === "run.event-recorded")).length, 2);
    handle.close();

    const reopened = StoreHandle.open(dir);
    assert.deepEqual(listRunEvents(reopened.db, DISPATCH_ID, 1), [early, late]);
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

test("usage, cost, and immutable estimate projections survive event replay", () => {
  const dir = mkTmpDir("mapctx-store-forecast-projections-");
  try {
    const handle = StoreHandle.open(dir);
    seedDispatch(handle);
    assert.equal(recordRunReceipt(handle, receipt(), "test").ok, true);
    assert.deepEqual(listUsageEvents(handle.db, undefined, "T-001").map(event => event.inputTokens), [10]);
    assert.equal(recordCostEvent(handle, ENTITY_FIXTURES.CostEvent).ok, true);
    assert.equal(listCostEvents(handle.db, undefined, "T-001").length, 1);
    assert.equal(recordEstimateSnapshot(handle, ENTITY_FIXTURES.EstimateSnapshot).ok, true);
    assert.equal(listEstimateSnapshots(handle.db, "T-048").length, 1);
    assert.deepEqual(recordEstimateSnapshot(handle, ENTITY_FIXTURES.EstimateSnapshot), { ok: false, reason: "duplicate-estimate" });
    handle.close();

    const reopened = StoreHandle.open(dir);
    assert.equal(listUsageEvents(reopened.db, undefined, "T-001").length, 1);
    assert.equal(listCostEvents(reopened.db, DISPATCH_ID).length, 1);
    assert.equal(listEstimateSnapshots(reopened.db, "T-048").length, 1);
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

test("receipt write uses evaluateRunReceipt for duplicate, stale, unknown and mismatch", () => {
  const dir = mkTmpDir("mapctx-store-dispatch-idempotency-");
  try {
    const handle = StoreHandle.open(dir);
    seedDispatch(handle);
    assert.equal(recordRunReceipt(handle, receipt(), "test").ok, true);
    const duplicate = recordRunReceipt(handle, receipt(), "test");
    assert.deepEqual(duplicate, { ok: false, reason: "duplicate-receipt" });

    const unknown = recordRunReceipt(handle, { ...receipt(), attempt: 2 }, "test");
    assert.deepEqual(unknown, { ok: false, reason: "unknown-attempt" });
    const mismatch = recordRunReceipt(handle, receipt(), "test", "00000000-0000-4000-8000-000000000000");
    assert.deepEqual(mismatch, { ok: false, reason: "dispatch-mismatch" });
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("older attempt-1 receipt rejected as stale after expiry, legal reclaim, and attempt 2", () => {
  const dir = mkTmpDir("mapctx-store-dispatch-stale-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle);
    const now = () => new Date("2026-08-16T19:54:00.000Z");
    const later = () => new Date("2026-08-16T20:54:00.000Z");
    const claim = claimTask(handle, { taskId: "T-001", actor: "test", now });
    assert.ok(claim.ok);
    if (!claim.ok) return;
    assert.ok(recordDispatchAttempt(handle, { dispatchId: DISPATCH_ID, taskId: "T-001", executorKind: "test", attempt: 1, contextHash: "hash", status: "running" }).ok);
    assert.deepEqual(renewClaim(handle, { taskId: "T-001", claimId: claim.claim.claimId, leaseToken: claim.claim.leaseToken, actor: "test", now: later }), { ok: false, reason: "expired" });
    const reclaim = claimTask(handle, { taskId: "T-001", actor: "other", now: later });
    assert.ok(reclaim.ok);
    if (!reclaim.ok) return;
    assert.ok(recordDispatchAttempt(handle, { dispatchId: DISPATCH_ID, taskId: "T-001", executorKind: "test", attempt: 2, contextHash: "hash-2", status: "running" }).ok);
    assert.deepEqual(recordRunReceipt(handle, receipt(), "test"), { ok: false, reason: "stale-attempt" });
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("retryable failed receipt re-opens through legal admission: release, reclaim, attempt 2 succeeds", () => {
  const dir = mkTmpDir("mapctx-store-failed-retry-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle);
    const executionState = () => (handle.db.prepare("SELECT execution_state FROM task_projection WHERE task_id = ?").get("T-001") as { execution_state: string }).execution_state;
    const claim1 = claimTask(handle, { taskId: "T-001", actor: "test" });
    assert.ok(claim1.ok);
    if (!claim1.ok) return;
    assert.ok(recordDispatchAttempt(handle, { dispatchId: DISPATCH_ID, taskId: "T-001", executorKind: "test", attempt: 1, contextHash: "hash", status: "running" }).ok);
    assert.ok(recordRunReceipt(handle, receipt("failed"), "test").ok);
    assert.equal(executionState(), "failed");
    // R11 boundary intact: a lease release never resets executor state...
    assert.ok(releaseClaim(handle, { taskId: "T-001", claimId: claim1.claim.claimId, leaseToken: claim1.claim.leaseToken, actor: "test" }).ok);
    assert.equal(executionState(), "failed");
    // ...but reclaim is new-attempt admission: failed -> unclaimed -> claimed
    const claim2 = claimTask(handle, { taskId: "T-001", actor: "other" });
    assert.ok(claim2.ok);
    if (!claim2.ok) return;
    assert.equal(executionState(), "claimed");
    assert.ok(recordDispatchAttempt(handle, { dispatchId: DISPATCH_ID, taskId: "T-001", executorKind: "test", attempt: 2, contextHash: "hash-2", status: "running" }).ok);
    assert.equal(executionState(), "running");
    // the late attempt-1 receipt stays rejected: attempt 2 has been dispatched,
    // so attempt 1 is stale no matter that it already carried a failed receipt
    assert.deepEqual(recordRunReceipt(handle, receipt("failed"), "test"), { ok: false, reason: "stale-attempt" });
    // and attempt 2 completes through the legal flow (claim carried ready -> in-progress);
    // its usage gets its own identity, the way a real second attempt would
    const base = receipt();
    const attempt2 = {
      ...base,
      attempt: 2,
      startedAt: "2026-08-16T20:54:10.000Z",
      endedAt: "2026-08-16T20:55:10.000Z",
      usageEvents: [{ ...base.usageEvents[0], usageEventId: "0e5c2f61-8d47-4f3a-b2c9-6a1d33cc90e4" }]
    };
    assert.ok(recordRunReceipt(handle, attempt2, "test").ok);
    assert.equal(executionState(), "completed");
    handle.close();
    // the admission reset is projection logic on journaled events, so a full
    // replay (repair rebuilds every projection from the journal) reproduces it
    assert.equal(repairStore(dir).status, "ok");
    const replayed = StoreHandle.open(dir);
    assert.equal((replayed.db.prepare("SELECT execution_state FROM task_projection WHERE task_id = ?").get("T-001") as { execution_state: string }).execution_state, "completed");
    replayed.close();
  } finally {
    cleanupDir(dir);
  }
});

test("dispatch admission alone re-opens a failed execution via the journaled retry-admission patch", () => {
  const dir = mkTmpDir("mapctx-store-failed-dispatch-admission-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle);
    const executionState = () => (handle.db.prepare("SELECT execution_state FROM task_projection WHERE task_id = ?").get("T-001") as { execution_state: string }).execution_state;
    // seed a failed state the way a prior full lifecycle would leave it
    assert.ok(recordDispatchAttempt(handle, { dispatchId: DISPATCH_ID, taskId: "T-001", executorKind: "test", attempt: 1, contextHash: "hash", status: "running" }).ok);
    assert.ok(recordRunReceipt(handle, receipt("failed"), "test").ok);
    assert.equal(executionState(), "failed");
    // a NEW dispatchId (fresh attempt identity) admits the task out of failed
    const newDispatchId = "4c1f7a2e-9b34-4c55-a0d1-9f2e88aa77b1";
    const result = recordDispatchAttempt(handle, { dispatchId: newDispatchId, taskId: "T-001", executorKind: "test", attempt: 1, contextHash: "hash-n", status: "claimed" });
    assert.ok(result.ok);
    assert.equal(executionState(), "claimed");
    const admission = handle.listEvents().filter(e => e.eventType === "task.patched" && (e.payload.source as string) === "retry-admission");
    assert.equal(admission.length, 1);
    assert.deepEqual((admission[0].payload.patch as { executionState: string }), { executionState: "unclaimed" });
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("receipt is immediately visible from another StoreHandle", () => {
  const dir = mkTmpDir("mapctx-store-dispatch-cross-worktree-");
  try {
    const a = StoreHandle.open(dir);
    seedDispatch(a);
    assert.equal(recordRunReceipt(a, receipt(), "test").ok, true);
    const b = StoreHandle.open(dir);
    assert.deepEqual(listRunReceipts(b.db, DISPATCH_ID), [receipt()]);
    b.close();
    a.close();
  } finally {
    cleanupDir(dir);
  }
});

for (const action of ["release", "expire", "reclaim"] as const) {
  test(`R11 ${action} preserves running/completed execution and receipt admission`, () => {
    const dir = mkTmpDir("mapctx-lease-execution-");
    const handle = StoreHandle.open(dir);
    const { claimTask, releaseClaim, renewClaim } = require("./claims") as typeof import("./claims");
    const { getTask } = require("./projections") as typeof import("./projections");
    const { moveTask } = require("./tasks") as typeof import("./tasks");
    try {
      seedTask(handle);
      const now = () => new Date("2026-08-16T19:54:00.000Z");
      const later = () => new Date("2026-08-16T20:54:00.000Z");
      const claim = claimTask(handle, { taskId: "T-001", actor: "test", now });
      assert.ok(claim.ok);
      if (!claim.ok) return;
      assert.ok(recordDispatchAttempt(handle, { dispatchId: DISPATCH_ID, taskId: "T-001", executorKind: "test", attempt: 1, contextHash: "hash", status: "running" }).ok);
      const lease = { taskId: "T-001", claimId: claim.claim.claimId, leaseToken: claim.claim.leaseToken, actor: "test", now: later };
      if (action === "release") assert.ok(releaseClaim(handle, lease).ok);
      else if (action === "expire") assert.equal(renewClaim(handle, lease).ok, false);
      else assert.ok(claimTask(handle, { taskId: "T-001", actor: "other", now: later }).ok);
      assert.equal(getTask(handle.db, "T-001")?.executionState, "running");
      assert.ok(recordRunReceipt(handle, receipt(), "test").ok);
      const next = action === "reclaim" ? undefined : claimTask(handle, { taskId: "T-001", actor: "test", now: later });
      if (next) assert.ok(next.ok);
      assert.equal(getTask(handle.db, "T-001")?.executionState, "completed");
      assert.ok(moveTask(handle, { taskId: "T-001", to: "done", actor: "test" }).ok);
      assert.equal(getTask(handle.db, "T-001")?.executionState, "completed");
      assert.deepEqual(claimTask(handle, { taskId: "T-001", actor: "test" }), { ok: false, reason: "terminal-state" });
      const count = handle.listEvents().length;
      assert.throws(() => recordDispatchAttempt(handle, { dispatchId: DISPATCH_ID, taskId: "T-001", executorKind: "test", attempt: 2, contextHash: "hash", status: "claimed" }), /terminal task/);
      assert.equal(handle.listEvents().length, count);
    } finally { handle.close(); cleanupDir(dir); }
  });
}

// R9: an accepted blocked receipt must not make the store unexportable.
test("R9: blocked receipt keeps dispatch/execution blocked and planning exportable", () => {
  const root = mkTmpDir("mapctx-dispatch-r9-");
  const handle = StoreHandle.open(root);
  try {
    seedDispatch(handle);
    const blocked = receipt("completed");
    const blockedReceipt = { ...blocked, outcome: "blocked" as const, changedFiles: [], usageEvents: [] };
    const result = recordRunReceipt(handle, blockedReceipt, "test", DISPATCH_ID);
    assert.equal(result.ok, true, `blocked receipt rejected: ${JSON.stringify(result)}`);

    const task = getTask(handle.db, "T-001");
    assert.equal(task?.executionState, "blocked", "execution records the blocked run");
    assert.equal(task?.planningState, "in-progress", "planning stays exportable");

    const exported = buildExport(handle.db, { tasksRoot: root });
    assert.ok(exported.tasksMd.content.includes("- status: doing"), "board round-trips the exportable state (doing = in-progress)");
    assert.ok(!exported.tasksMd.content.includes("- status: blocked"));

    // R9 review P2#3: the default retry path must not wedge. A new attempt
    // (same dispatch, attempt 2) journals the blocked -> unclaimed reset and
    // enters claimed, exactly like a failed run.
    const retry = recordDispatchAttempt(handle, {
      dispatchId: DISPATCH_ID,
      taskId: "T-001",
      executorKind: "test",
      attempt: 2,
      contextHash: "hash",
      status: "claimed"
    }, "test");
    assert.equal(retry.ok, true, `blocked run must be retryable through default admission: ${JSON.stringify(retry)}`);
    assert.equal(getTask(handle.db, "T-001")?.executionState, "claimed", "retry admission re-opens the blocked execution");
  } finally {
    handle.close();
    cleanupDir(root);
  }
});
