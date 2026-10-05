import assert from "node:assert/strict"
import test from "node:test"
import { startTask } from "./start"
import { claimTask, releaseClaim } from "./claims"
import { recordRunReceipt } from "./dispatch"
import { getActiveClaimForTask, getTask, listDispatchAttempts } from "./projections"
import { StoreHandle } from "./store-handle"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

function seed(handle: StoreHandle, taskId = "T-001", planningState = "backlog", workload: string | null = "Normal"): void {
  handle.appendEvent({ eventType: "task.upserted", actor: "test", payload: {
    task: { taskId, positionKey: 0, title: taskId, planningState, executionState: "unclaimed",
      workload, tags: [], domains: [], externalLinks: [], assignees: [] },
    detail: { taskId, role: "implementation", impact: "medium", estimatedEffort: "1d",
      prerequisites: [], blocking: [], filesAffected: [], testsRequired: [], summary: "start" }
  } });
}

test("start persists claim, planning hops and dispatch together; competing start loses", () => {
  const dir = mkTmpDir("mapctx-start-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    const result = startTask(handle, { taskId: "T-001", actor: "test", holder: { provider: "traycer" }, status: "running" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(getTask(handle.db, "T-001")?.planningState, "in-progress");
    assert.equal(getTask(handle.db, "T-001")?.executionState, "running");
    assert.equal(result.dispatch.workloadAtDispatch, "Normal");
    assert.equal(result.dispatch.attempt, 1);
    assert.equal(getActiveClaimForTask(handle.db, "T-001")?.claimId, result.claim.claimId);
    const before = handle.listEvents().length;
    const other = StoreHandle.open(dir);
    assert.equal(startTask(other, { taskId: "T-001", actor: "other" }).ok, false);
    assert.equal(handle.listEvents().length, before);
    assert.equal(listDispatchAttempts(handle.db).length, 1);
    other.close(); handle.close();
  } finally { cleanupDir(dir); }
});

test("dispatch failure rolls back claim, expiry and planning events, including durable journal", () => {
  const dir = mkTmpDir("mapctx-start-rollback-");
  try {
    let handle = StoreHandle.open(dir);
    seed(handle);
    seed(handle, "T-002");
    const expired = claimTask(handle, { taskId: "T-001", actor: "old", now: () => new Date("2026-01-01T00:00:00Z") });
    assert.equal(expired.ok, true);
    const before = handle.listEvents();
    // Runtime-invalid admission fails after claim acquisition/expiry.
    assert.throws(() => startTask(handle, { taskId: "T-001", actor: "test", status: "invalid" as never }), /dispatch admission status/i);
    assert.throws(() => startTask(handle, { taskId: "T-002", actor: "test", status: "invalid" as never }), /dispatch admission status/i);
    assert.equal(getTask(handle.db, "T-002")?.planningState, "backlog");
    assert.deepEqual(handle.listEvents(), before);
    assert.equal(listDispatchAttempts(handle.db).length, 0);
    handle.close(); handle = StoreHandle.open(dir);
    assert.deepEqual(handle.listEvents(), before);
    assert.equal(getActiveClaimForTask(handle.db, "T-001")?.claimId, expired.ok ? expired.claim.claimId : undefined);
    handle.close();
  } finally { cleanupDir(dir); }
});

test("start retry keeps completed receipt and rejects unknown or other-task dispatch before claiming", () => {
  const dir = mkTmpDir("mapctx-start-retry-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle); seed(handle, "T-002");
    const first = startTask(handle, { taskId: "T-001", actor: "test" });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(recordRunReceipt(handle, { schemaVersion: 1, dispatchId: first.dispatch.dispatchId,
      attempt: 1, outcome: "completed", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:00Z",
      changedFiles: [], evidence: [], usageEvents: [], failure: null }, "test").ok, true);
    releaseClaim(handle, { taskId: "T-001", actor: "test", claimId: first.claim.claimId, leaseToken: first.claim.leaseToken });
    const before = handle.listEvents().length;
    assert.throws(() => startTask(handle, { taskId: "T-002", actor: "test", dispatchId: first.dispatch.dispatchId }), /another task/);
    assert.throws(() => startTask(handle, { taskId: "T-002", actor: "test", dispatchId: "unknown" }), /Unknown dispatch/);
    assert.equal(handle.listEvents().length, before);
    const retry = startTask(handle, { taskId: "T-001", actor: "test", dispatchId: first.dispatch.dispatchId, status: "running" });
    assert.equal(retry.ok, true);
    if (retry.ok) assert.equal(retry.dispatch.attempt, 2);
    assert.deepEqual(listDispatchAttempts(handle.db, first.dispatch.dispatchId).map(d => d.status), ["completed", "running"]);
    assert.equal(getTask(handle.db, "T-001")?.planningState, "review", "start does not silently approve or reopen review");
    handle.close();
  } finally { cleanupDir(dir); }
});

test("start rejects terminal, unknown and incomplete planning without events", () => {
  const dir = mkTmpDir("mapctx-start-gates-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle, "T-001", "done"); seed(handle, "T-002", "backlog", null);
    seed(handle, "T-004", "cancelled"); seed(handle, "T-005", "archived");
    const before = handle.listEvents().length;
    for (const [taskId, reason] of [["T-001", "terminal-state"], ["T-002", "missing-workload-or-estimate"], ["T-003", "unknown-task"], ["T-004", "terminal-state"], ["T-005", "terminal-state"]]) {
      const result = startTask(handle, { taskId, actor: "test" });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, reason);
    }
    assert.equal(handle.listEvents().length, before);
    handle.close();
  } finally { cleanupDir(dir); }
});
