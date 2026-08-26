import assert from "node:assert/strict"
import test from "node:test"
import { getDispatchAttempt, getRunEvent, getRunReceipt, listDispatchAttempts, listRunEvents, listRunReceipts, listCostEvents, listEstimateSnapshots, listUsageEvents } from "./projections"
import { recordCostEvent, recordDispatchAttempt, recordEstimateSnapshot, recordRunEvent, recordRunReceipt } from "./dispatch"
import { StoreHandle } from "./store-handle"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"
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

test("older receipt rejected after newer attempt is dispatched", () => {
  const dir = mkTmpDir("mapctx-store-dispatch-stale-");
  try {
    const handle = StoreHandle.open(dir);
    seedDispatch(handle);
    const failed = recordRunReceipt(handle, receipt("failed"), "test");
    assert.equal(failed.ok, true);
    handle.appendEvent({
      eventType: "task.patched",
      actor: "test",
      payload: { taskId: "T-001", patch: { executionState: "unclaimed" }, source: "test" }
    });
    const retry = recordDispatchAttempt(handle, {
      dispatchId: DISPATCH_ID,
      taskId: "T-001",
      executorKind: "test",
      attempt: 2,
      contextHash: "hash-2",
      status: "claimed",
      actor: "test"
    });
    assert.equal(retry.ok, true);
    const late = recordRunReceipt(handle, receipt("failed"), "test");
    assert.deepEqual(late, { ok: false, reason: "stale-attempt" });
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
