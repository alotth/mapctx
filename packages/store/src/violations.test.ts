import assert from "node:assert/strict";
import test from "node:test";
import { recordClaimViolations } from "./violations";
import { recordDispatchAttempt, recordRunReceipt } from "./dispatch";
import { listClaimViolations } from "./projections";
import { StoreHandle } from "./store-handle";
import { cleanupDir, mkTmpDir } from "./__test-helpers__";

const uuid = (n: string) => `00000000-0000-5000-8000-00000000000${n}`;
function seed(handle: StoreHandle, taskId: string): void {
  handle.appendEvent({ eventType: "project.initialized", actor: "test", payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" } });
  handle.appendEvent({ eventType: "task.upserted", actor: "test", payload: { task: { taskId, positionKey: Number(taskId.slice(-1)), title: taskId, planningState: "in-progress", executionState: "unclaimed", tags: [], domains: [], externalLinks: [], assignees: [] } } });
}
function dispatchAndReceipt(handle: StoreHandle, taskId: string, dispatchId: string, changedFiles: string[], outcome: "completed" | "failed" = "completed"): void {
  assert.equal(recordDispatchAttempt(handle, { dispatchId, taskId, executorKind: "test", attempt: 1, contextHash: "h", status: "claimed", actor: "test" }).ok, true);
  assert.equal(recordRunReceipt(handle, { schemaVersion: 1, dispatchId, attempt: 1, outcome, startedAt: "2026-08-17T10:00:00.000Z", endedAt: "2026-08-17T10:01:00.000Z", changedFiles, usageEvents: [], evidence: [], failure: outcome === "failed" ? { category: "executor-error", message: "x", retryable: true } : null }, "test").ok, true);
}

test("wave violation persists, queries, survives reopen, and is idempotent", () => {
  const dir = mkTmpDir("mapctx-store-violations-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle, "T-001"); seed(handle, "T-002");
    dispatchAndReceipt(handle, "T-001", uuid("1"), ["src/shared.ts"]);
    dispatchAndReceipt(handle, "T-002", uuid("2"), ["src/shared.ts"]);
    const plan = { waves: [{ waveId: uuid("3"), dispatches: [{ waveId: uuid("3"), dispatchId: uuid("1"), attempt: 1, taskId: "T-001" }, { waveId: uuid("3"), dispatchId: uuid("2"), attempt: 1, taskId: "T-002" }] }], claims: [], detectedAt: "2026-08-17T10:02:00.000Z" };
    assert.equal(recordClaimViolations(handle, plan).length, 1);
    assert.equal(recordClaimViolations(handle, plan).length, 0);
    assert.equal(listClaimViolations(handle.db, { kind: "collision", pathPattern: "src/**" }).length, 1);
    handle.close();
    const reopened = StoreHandle.open(dir);
    assert.equal(listClaimViolations(reopened.db, { taskId: "T-001" }).length, 1);
    reopened.close();
  } finally { cleanupDir(dir); }
});

test("incomplete or failed wave emits nothing", () => {
  const dir = mkTmpDir("mapctx-store-violations-gate-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle, "T-001"); seed(handle, "T-002");
    dispatchAndReceipt(handle, "T-001", uuid("1"), ["src/shared.ts"]);
    assert.deepEqual(recordClaimViolations(handle, { waves: [{ waveId: uuid("3"), dispatches: [{ waveId: uuid("3"), dispatchId: uuid("1"), attempt: 1, taskId: "T-001" }, { waveId: uuid("3"), dispatchId: uuid("2"), attempt: 1, taskId: "T-002" }] }, { waveId: uuid("4"), dispatches: [] }], claims: [] }), []);
    assert.equal(listClaimViolations(handle.db).length, 0);
    handle.close();
  } finally { cleanupDir(dir); }
});

test("failed terminal receipt also suppresses the whole wave", () => {
  const dir = mkTmpDir("mapctx-store-violations-failed-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle, "T-001"); seed(handle, "T-002");
    dispatchAndReceipt(handle, "T-001", uuid("1"), ["src/shared.ts"]);
    dispatchAndReceipt(handle, "T-002", uuid("2"), ["src/shared.ts"], "failed");
    const emitted = recordClaimViolations(handle, {
      waves: [{ waveId: uuid("3"), dispatches: [
        { waveId: uuid("3"), dispatchId: uuid("1"), attempt: 1, taskId: "T-001" },
        { waveId: uuid("3"), dispatchId: uuid("2"), attempt: 1, taskId: "T-002" }
      ]}], claims: []
    });
    assert.deepEqual(emitted, []);
    assert.equal(listClaimViolations(handle.db).length, 0);
    handle.close();
  } finally { cleanupDir(dir); }
});
