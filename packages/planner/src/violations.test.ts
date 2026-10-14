import assert from "node:assert/strict";
import test from "node:test";
import { REDACTED_SENTINEL } from "@mapctx/protocol";
import {
  deriveClaimViolations, detectClaimViolations, detectViolations, detectWaveClaimViolations,
  pathsOverlap, type TaskReceipt
} from "./violations";

const uuid = (n: string) => `00000000-0000-5000-8000-00000000000${n}`;
const receipt = (dispatchId: string, changedFiles: string[], outcome: "completed" | "failed" = "completed") => ({
  schemaVersion: 1, dispatchId, attempt: 1, outcome,
  startedAt: "2026-08-17T10:00:00.000Z", endedAt: "2026-08-17T10:01:00.000Z",
  changedFiles, usageEvents: [], evidence: [], failure: outcome === "failed" ? { category: "executor-error" as const, message: "x", retryable: true } : null
});

/** Captures process "warning" events emitted while `fn` runs. */
async function captureWarnings(fn: () => void): Promise<string[]> {
  const warnings: string[] = [];
  const onWarning = (w: Error) => warnings.push(String(w.message));
  process.on("warning", onWarning);
  fn();
  await new Promise(resolve => setImmediate(resolve));
  process.off("warning", onWarning);
  return warnings;
}

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

// Control for the fabrication tests below: when both receipts are intact and
// genuinely disjoint, the overbroad claim ("serializing these was
// unnecessary") IS the correct, legitimate output and must still be emitted.
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

// ---- T-133 AC1/AC4: the planner publishes the shared G1 primitive under its
// own historical name, and it must be the exact @mapctx/protocol function,
// not a local twin that happens to behave the same today. ----

test("AC1/AC4: planner's published pathsOverlap is @mapctx/protocol's pathsOverlap by reference", () => {
  const protocolModule = require("@mapctx/protocol") as Record<string, unknown>;
  assert.equal(pathsOverlap, protocolModule.pathsOverlap);
  assert.equal(typeof pathsOverlap, "function");
});

test("AC4: detectClaimViolations and its three aliases share one identity, arity 1, array return", () => {
  for (const fn of [detectClaimViolations, deriveClaimViolations, detectViolations, detectWaveClaimViolations]) {
    assert.equal(typeof fn, "function");
    assert.equal(fn.length, 1, "published arity must stay 1");
  }
  assert.equal(deriveClaimViolations, detectClaimViolations);
  assert.equal(detectViolations, detectClaimViolations);
  assert.equal(detectWaveClaimViolations, detectClaimViolations);
  assert.ok(Array.isArray(detectClaimViolations({ receipts: [] })), "must return an array even for empty input");
});

// ---- T-133 AC2, non-fabrication direction: a redacted path must never
// manufacture an audit fact the planner didn't actually observe. Mirrors
// the store's ALTO-2a/serializedPairs tests, now exercised through the
// planner's own `detectClaimViolations`. ----

test("AC2 non-fabrication: two receipts redacted to disjoint (now-sentinel) paths never fabricate a collision", async () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), [REDACTED_SENTINEL]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), [REDACTED_SENTINEL]) }
  ];
  const warnings = await captureWarnings(() => {
    const result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }], receipts, claims: [], detectedAt: "2026-08-17T10:02:00.000Z"
    });
    assert.deepEqual(result, [], "a sentinel must never be treated as overlapping another sentinel");
  });
  assert.ok(warnings.some(w => /INCOMPLETE/.test(w) && /cannot tell/.test(w)), JSON.stringify(warnings));
});

test("AC2 non-fabrication: a real collision redacted on one side must not fabricate an 'overbroad' (did-not-conflict) violation", async () => {
  const SHARED_PATH = "src/acme-prod/secret.ts";
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), [REDACTED_SENTINEL]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), [SHARED_PATH]) }
  ];
  const input = {
    waves: [{ waveId: uuid("3"), taskIds: ["T-001"] }, { waveId: uuid("4"), taskIds: ["T-002"] }],
    receipts,
    serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: [SHARED_PATH] }],
    detectedAt: "2026-08-17T10:02:00.000Z"
  };
  const warnings = await captureWarnings(() => {
    const result = detectClaimViolations(input);
    assert.deepEqual(result.filter(item => item.kind === "overbroad"), [],
      "redacting one side must never produce a permanent claim that two possibly-colliding tasks did not conflict");
  });
  assert.ok(warnings.some(w => /INCOMPLETE/.test(w) && w.includes("T-001")), JSON.stringify(warnings));
  assert.ok(!warnings.join("|").includes(SHARED_PATH.split("/").pop()!), "the warning must never echo the untouched sibling's path content");
});

test("AC2 non-fabrication: a sentinel path supplied directly in serializedPairs.paths is filtered, never emitted", () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["docs/b.md"]) }
  ];
  const result = detectClaimViolations({
    waves: [{ waveId: uuid("3"), taskIds: ["T-001"] }, { waveId: uuid("4"), taskIds: ["T-002"] }],
    receipts,
    serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: [REDACTED_SENTINEL, "src/**"] }],
    detectedAt: "2026-08-17T10:02:00.000Z"
  });
  assert.deepEqual(result.map(item => item.path), ["src/**"], "the sentinel element must be dropped, the real path kept");
  assert.ok(!result.some(item => item.path === REDACTED_SENTINEL));
});

// ---- T-133 AC2, non-suppression direction: a real audit fact on paths that
// were NOT redacted must still be reported, even when another element of the
// same list (a sibling file, or the other side of a pair) is redacted or when
// no redaction is involved at all. ----

test("AC2 non-suppression: a real collision on an unredacted path survives even when a sibling element of the same list is redacted", () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), [REDACTED_SENTINEL, "src/shared.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["src/shared.ts"]) }
  ];
  const result = detectClaimViolations({
    waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }], receipts, claims: [], detectedAt: "2026-08-17T10:02:00.000Z"
  });
  assert.deepEqual(result.map(item => [item.kind, item.path]), [["collision", "src/shared.ts"]],
    "the redacted sibling element must not suppress the real collision on the untouched path");
});

test("AC2 non-suppression: a legitimate overbroad claim (both receipts intact, genuinely disjoint) is still emitted, not swallowed by the redaction guards", () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["docs/b.md"]) }
  ];
  const result = detectClaimViolations({
    waves: [{ waveId: uuid("3"), taskIds: ["T-001"] }, { waveId: uuid("4"), taskIds: ["T-002"] }],
    receipts,
    serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: ["src/a.ts"] }],
    detectedAt: "2026-08-17T10:02:00.000Z"
  });
  assert.deepEqual(result.map(item => item.kind), ["overbroad"], "G2/G3 must not fire when nothing is redacted");
});
