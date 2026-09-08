import assert from "node:assert/strict";
import test from "node:test";
import { detectClaimViolations, type TaskReceipt } from "./violations";

const uuid = (n: string) => `00000000-0000-5000-8000-00000000000${n}`;
const receipt = (dispatchId: string, changedFiles: string[], outcome: "completed" | "failed" = "completed") => ({
  schemaVersion: 1, dispatchId, attempt: 1, outcome,
  startedAt: "2026-08-17T10:00:00.000Z", endedAt: "2026-08-17T10:01:00.000Z",
  changedFiles, usageEvents: [], evidence: [], failure: outcome === "failed" ? { category: "executor-error" as const, message: "x", retryable: true } : null
});

test("collision emitted only after successful terminal receipts and uncovered overlap", () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/shared.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["src/shared.ts"]) }
  ];
  const result = detectClaimViolations({
    waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }], receipts, claims: [], detectedAt: "2026-08-17T10:02:00.000Z"
  });
  assert.deepEqual(result.map(item => [item.kind, item.path, item.taskAId, item.taskBId]), [["collision", "src/shared.ts", "T-001", "T-002"]]);
  assert.deepEqual(detectClaimViolations({ waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }], receipts: receipts.slice(0, 1) }), []);
  assert.deepEqual(detectClaimViolations({ waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }], receipts: receipts.map(item => ({ ...item, receipt: receipt(item.receipt.dispatchId, item.receipt.changedFiles, "failed") })) }), []);
});

test("overbroad uses serialized explanation and actual receipts", () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["docs/b.md"]) }
  ];
  const result = detectClaimViolations({
    waves: [
      { waveId: uuid("3"), taskIds: ["T-001"] },
      { waveId: uuid("4"), taskIds: ["T-002"] }
    ], receipts,
    serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: ["src/**"] }],
    detectedAt: "2026-08-17T10:02:00.000Z"
  });
  assert.deepEqual(result.map(item => [item.kind, item.waveId, item.path]), [["overbroad", uuid("3"), "src/**"]]);
});
