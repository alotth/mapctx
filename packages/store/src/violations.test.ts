import assert from "node:assert/strict";
import test from "node:test";
import { detectClaimViolations, recordClaimViolations } from "./violations";
import { recordDispatchAttempt, recordRunReceipt } from "./dispatch";
import { listClaimViolations } from "./projections";
import { redactEvidence, REDACTED_SENTINEL, type RedactionTarget } from "./redact";
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
function wavePlan() {
  return { waves: [{ waveId: uuid("3"), dispatches: [
    { waveId: uuid("3"), dispatchId: uuid("1"), attempt: 1, taskId: "T-001" },
    { waveId: uuid("3"), dispatchId: uuid("2"), attempt: 1, taskId: "T-002" }
  ] }], claims: [], detectedAt: "2026-08-17T10:02:00.000Z" };
}
function receiptTarget(handle: StoreHandle, dispatchId: string): RedactionTarget {
  const row = handle.db.prepare("SELECT node_id, sequence FROM event_log WHERE event_type = 'run.receipt-recorded' AND payload_json LIKE ? ORDER BY sequence")
    .get(`%${dispatchId}%`) as { node_id: string; sequence: number };
  return { nodeId: row.node_id, sequence: row.sequence };
}
function redactField(handle: StoreHandle, target: RedactionTarget, fieldPath: string) {
  const result = redactEvidence(handle, { target, fieldPath, reason: "T-131 attempt 2 fixture", actor: "dpo", commit: true });
  assert.ok(result.ok, JSON.stringify(result));
  return result;
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

// ---- T-131 review ALTO-2: redaction must never fabricate a collision, and
// a collision lost to redaction must be DECLARED, not silently returned as
// "no violations". ----

test("ALTO-2a: two receipts redacted to disjoint (now-sentinel) paths never fabricate a collision", () => {
  const dir = mkTmpDir("mapctx-store-violations-alto2a-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle, "T-001"); seed(handle, "T-002");
    dispatchAndReceipt(handle, "T-001", uuid("1"), ["src/alpha.ts"]);
    dispatchAndReceipt(handle, "T-002", uuid("2"), ["src/beta.ts"]);
    redactField(handle, receiptTarget(handle, uuid("1")), "receipt.changedFiles");
    redactField(handle, receiptTarget(handle, uuid("2")), "receipt.changedFiles");

    const result = detectClaimViolations(handle, wavePlan());
    assert.deepEqual(result.violations, [], "a sentinel must never be treated as overlapping another sentinel");
    assert.equal(handle.db.prepare("SELECT COUNT(*) c FROM event_log WHERE event_type = 'claim-violation.detected'").get()!.c, 0);
    assert.ok(listClaimViolations(handle.db).every(v => v.path !== REDACTED_SENTINEL));
    assert.equal(result.incompleteDetection.length, 2, JSON.stringify(result.incompleteDetection));
    for (const incomplete of result.incompleteDetection) {
      assert.equal(incomplete.redactedPaths, 1);
      assert.equal(incomplete.totalPaths, 1);
    }
    handle.close();
  } finally { cleanupDir(dir); }
});

test("ALTO-2b: a real collision lost to whole-root redaction is reported as incomplete, never as a clean bill of health", async () => {
  // Control: the collision is found and detection reports nothing incomplete.
  const controlDir = mkTmpDir("mapctx-store-violations-alto2b-control-");
  try {
    const control = StoreHandle.open(controlDir);
    seed(control, "T-001"); seed(control, "T-002");
    dispatchAndReceipt(control, "T-001", uuid("1"), ["src/secret-path.ts", "src/shared.ts"]);
    dispatchAndReceipt(control, "T-002", uuid("2"), ["src/shared.ts"]);
    const found = detectClaimViolations(control, wavePlan());
    assert.equal(found.violations.length, 1);
    assert.equal(found.violations[0].path, "src/shared.ts");
    assert.deepEqual(found.incompleteDetection, []);
    control.close();
  } finally { cleanupDir(controlDir); }

  // Treatment: redact the whole receipt root before detection runs. The real
  // collision on the unredacted sibling is now unfindable -- inherent, since
  // the paths are actually gone -- but that loss must be DECLARED.
  const treatedDir = mkTmpDir("mapctx-store-violations-alto2b-treated-");
  try {
    const treated = StoreHandle.open(treatedDir);
    seed(treated, "T-001"); seed(treated, "T-002");
    dispatchAndReceipt(treated, "T-001", uuid("1"), ["src/secret-path.ts", "src/shared.ts"]);
    dispatchAndReceipt(treated, "T-002", uuid("2"), ["src/shared.ts"]);
    redactField(treated, receiptTarget(treated, uuid("1")), "receipt.changedFiles");
    const result = detectClaimViolations(treated, wavePlan());
    assert.deepEqual(result.violations, [], "the collision cannot be seen any more -- that part is inherent");
    assert.equal(result.incompleteDetection.length, 1, JSON.stringify(result.incompleteDetection));
    assert.equal(result.incompleteDetection[0].taskId, "T-001");
    assert.equal(result.incompleteDetection[0].redactedPaths, 2);
    assert.equal(result.incompleteDetection[0].totalPaths, 2);

    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(String(w.message));
    process.on("warning", onWarning);
    recordClaimViolations(treated, wavePlan());
    await new Promise(resolve => setImmediate(resolve));
    process.off("warning", onWarning);
    assert.ok(warnings.some(w => /INCOMPLETE/.test(w) && /cannot tell/.test(w)), JSON.stringify(warnings));
    assert.ok(!warnings.join("|").includes("secret-path"), "the process warning must never echo a redacted path");
    treated.close();
  } finally { cleanupDir(treatedDir); }

  // Element-level redaction keeps the untouched sibling comparable: the real
  // collision survives, and the partial blindness is still declared.
  const elementDir = mkTmpDir("mapctx-store-violations-alto2b-element-");
  try {
    const element = StoreHandle.open(elementDir);
    seed(element, "T-001"); seed(element, "T-002");
    dispatchAndReceipt(element, "T-001", uuid("1"), ["src/secret-path.ts", "src/shared.ts"]);
    dispatchAndReceipt(element, "T-002", uuid("2"), ["src/shared.ts"]);
    redactField(element, receiptTarget(element, uuid("1")), "receipt.changedFiles.0");
    const result = detectClaimViolations(element, wavePlan());
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].path, "src/shared.ts");
    assert.equal(result.incompleteDetection.length, 1);
    assert.equal(result.incompleteDetection[0].redactedPaths, 1);
    assert.equal(result.incompleteDetection[0].totalPaths, 2);
    element.close();
  } finally { cleanupDir(elementDir); }
});

// ---- T-131 attempt 3 (self-found, 1ddfb7b): the `serializedPairs` route
// INVERTS the ALTO-2a class. An "overbroad" violation asserts the two tasks
// did NOT actually conflict (serializing them was unnecessary); that claim
// rests on actually seeing both receipts' files, so it cannot be established
// from a redacted receipt. Before `pathsOverlap` made the sentinel
// incomparable, a redacted pair's shared sentinel accidentally "intersected"
// and suppressed the overbroad violation; making it incomparable turned that
// accident into a fabrication -- two tasks that genuinely collided got a
// permanent journaled claim that they did not, carrying the REAL path (not
// even sentinel-filtered, since it comes from the plan's declared paths). ----

test("serializedPairs: a real collision redacted on one side must not fabricate an 'overbroad' (did-not-conflict) violation", () => {
  const SHARED_PATH = "src/acme-prod/secret.ts";
  const plan = (waveId: string, a: string, b: string) => ({
    waves: [{ waveId, dispatches: [
      { waveId, dispatchId: a, attempt: 1, taskId: "T-001" },
      { waveId, dispatchId: b, attempt: 1, taskId: "T-002" }
    ] }],
    claims: [],
    serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: [SHARED_PATH] }],
    detectedAt: "2026-08-17T10:02:00.000Z"
  });

  // Control: no redaction, the two tasks really did collide on SHARED_PATH.
  // The wave-collision loop correctly reports the real collision; the
  // serializedPairs route correctly suppresses the "overbroad" claim because
  // actualIntersection sees the real overlap.
  const controlDir = mkTmpDir("mapctx-store-violations-overbroad-control-");
  try {
    const control = StoreHandle.open(controlDir);
    seed(control, "T-001"); seed(control, "T-002");
    dispatchAndReceipt(control, "T-001", uuid("1"), [SHARED_PATH]);
    dispatchAndReceipt(control, "T-002", uuid("2"), [SHARED_PATH]);
    const result = detectClaimViolations(control, plan(uuid("3"), uuid("1"), uuid("2")));
    assert.equal(result.violations.length, 1, JSON.stringify(result.violations));
    assert.equal(result.violations[0].kind, "collision");
    assert.equal(result.violations[0].path, SHARED_PATH);
    assert.ok(!result.violations.some(v => v.kind === "overbroad"), "the real collision correctly suppresses the overbroad claim");
    assert.deepEqual(result.incompleteDetection, []);
    control.close();
  } finally { cleanupDir(controlDir); }

  // Treatment: redact T-001's receipt.changedFiles BEFORE detection runs.
  // Non-intersection can no longer be established, so the pair must be
  // skipped -- never emitted as "overbroad" -- and the blindness must be
  // declared via incompleteDetection instead.
  const treatedDir = mkTmpDir("mapctx-store-violations-overbroad-treated-");
  try {
    const treated = StoreHandle.open(treatedDir);
    seed(treated, "T-001"); seed(treated, "T-002");
    dispatchAndReceipt(treated, "T-001", uuid("1"), [SHARED_PATH]);
    dispatchAndReceipt(treated, "T-002", uuid("2"), [SHARED_PATH]);
    redactField(treated, receiptTarget(treated, uuid("1")), "receipt.changedFiles");
    const result = detectClaimViolations(treated, plan(uuid("3"), uuid("1"), uuid("2")));
    assert.deepEqual(result.violations.filter(v => v.kind === "overbroad"), [],
      "redacting one side must never produce a permanent claim that two colliding tasks did not conflict");
    assert.equal(
      treated.db.prepare("SELECT COUNT(*) c FROM event_log WHERE event_type = 'claim-violation.detected'").get()!.c, 0,
      "nothing fabricated must reach the journal"
    );
    assert.equal(result.incompleteDetection.length, 1, JSON.stringify(result.incompleteDetection));
    assert.equal(result.incompleteDetection[0].taskId, "T-001");
    assert.equal(result.incompleteDetection[0].redactedPaths, 1);
    assert.equal(result.incompleteDetection[0].totalPaths, 1);
    treated.close();
  } finally { cleanupDir(treatedDir); }
});
