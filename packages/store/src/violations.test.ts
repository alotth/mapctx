import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "fs";
import * as path from "path";
import { detectClaimViolationsWithCoverage, recordClaimViolations } from "./violations";
import { recordDispatchAttempt, recordRunReceipt } from "./dispatch";
import { normalizePath } from "./paths";
import { listClaimViolations } from "./projections";
import { redactEvidence, REDACTED_SENTINEL, type RedactionTarget } from "./redact";
import { repairStore } from "./repair";
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

    const result = detectClaimViolationsWithCoverage(handle, wavePlan());
    assert.deepEqual(result.violations, [], "a sentinel must never be treated as overlapping another sentinel");
    assert.equal(handle.db.prepare("SELECT COUNT(*) c FROM event_log WHERE event_type = 'claim-violation.detected'").get()!.c, 0);
    // Review MÉDIA-2: not merely "no sentinel row" -- nothing at all should
    // have been journaled or projected for a disjoint-but-redacted pair.
    assert.equal(listClaimViolations(handle.db).length, 0, JSON.stringify(listClaimViolations(handle.db)));
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
    const found = detectClaimViolationsWithCoverage(control, wavePlan());
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
    const result = detectClaimViolationsWithCoverage(treated, wavePlan());
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
    const result = detectClaimViolationsWithCoverage(element, wavePlan());
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
    const result = detectClaimViolationsWithCoverage(control, plan(uuid("3"), uuid("1"), uuid("2")));
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
    const result = detectClaimViolationsWithCoverage(treated, plan(uuid("3"), uuid("1"), uuid("2")));
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

// T-133 AC2, non-suppression direction: the serializedPairs route's other
// control. The treatment tests above show redaction suppressing a would-be
// "overbroad" claim; this is the baseline that it is still emitted when
// nothing is redacted and the two tasks genuinely never conflicted -- the
// guards must not swallow a legitimate claim along with the fabricated one.
test("serializedPairs: a legitimate overbroad claim (both receipts intact, genuinely disjoint) is still emitted", () => {
  const dir = mkTmpDir("mapctx-store-violations-overbroad-legit-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle, "T-001"); seed(handle, "T-002");
    dispatchAndReceipt(handle, "T-001", uuid("1"), ["src/a.ts"]);
    dispatchAndReceipt(handle, "T-002", uuid("2"), ["docs/b.md"]);
    const plan = {
      waves: [{ waveId: uuid("3"), dispatches: [
        { waveId: uuid("3"), dispatchId: uuid("1"), attempt: 1, taskId: "T-001" },
        { waveId: uuid("3"), dispatchId: uuid("2"), attempt: 1, taskId: "T-002" }
      ] }],
      claims: [],
      serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: ["src/a.ts"] }],
      detectedAt: "2026-08-17T10:02:00.000Z"
    };
    const result = detectClaimViolationsWithCoverage(handle, plan);
    assert.deepEqual(result.violations.map(v => v.kind), ["overbroad"], "G2/G3 must not suppress a legitimate claim when nothing is redacted");
    assert.equal(result.violations[0].path, "src/a.ts");
    assert.deepEqual(result.incompleteDetection, []);
    handle.close();
  } finally { cleanupDir(dir); }
});

// ---- T-133 AC1: the two packages' detectors must call the SAME path
// primitives, not two copies that happen to agree today. @mapctx/store does
// not re-publish the shared primitives under their own names (only
// REDACTED_SENTINEL and, internally, normalizePath via ./paths), so identity
// is checked at the two seams that ARE published or directly reachable: the
// store's internal ./paths re-export, and the planner's published
// pathsOverlap. Both must be @mapctx/protocol's exact function. ----

test("AC1: the store's internal normalizePath and the planner's published pathsOverlap are @mapctx/protocol's own functions, by reference", () => {
  const protocolModule = require("@mapctx/protocol") as Record<string, unknown>;
  const storePaths = require("./paths") as Record<string, unknown>;
  const plannerIndex = require("../../planner/dist/index") as Record<string, unknown>;
  assert.equal(storePaths.normalizePath, protocolModule.normalizePath, "store/src/paths.ts must re-export, not re-implement");
  assert.equal(plannerIndex.pathsOverlap, protocolModule.pathsOverlap, "planner/src/violations.ts must re-export, not re-implement");
  // @mapctx/store publishes REDACTED_SENTINEL directly (via redact.ts).
  const storeIndex = require("./index") as Record<string, unknown>;
  assert.equal(storeIndex.REDACTED_SENTINEL, protocolModule.REDACTED_SENTINEL);
});

function bytesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current)) {
      const absolute = path.join(current, name);
      if (fs.statSync(absolute).isDirectory()) walk(absolute);
      else if (fs.readFileSync(absolute).includes(needle)) hits.push(path.relative(dir, absolute));
    }
  };
  walk(dir);
  return hits;
}

// ---- T-131 attempt 3, review ALTO-3: the advisory must point at the copy
// that actually holds the secret, however the path was WRITTEN. Detection
// stores every violation path through normalizePath; redactionAdvisories
// used to compare against the receipt's RAW string, so a non-canonical form
// (./x, a\b, a//b, a trailing slash) matched nothing and the advisory named
// only the innocent neighbour -- worse than no advisory, because the
// operator follows it and the secret survives with no warning left. ----

const ALTO3_SECRET = "src/acme-bank-prod/shift-998877.ts";
for (const [label, written] of [
  ["leading ./", `./${ALTO3_SECRET}`],
  ["double slash", ALTO3_SECRET.replace("/", "//")],
  ["backslashes", ALTO3_SECRET.replaceAll("/", "\\")],
  ["trailing slash dir", "src/acme-bank-prod/"],
  ["already canonical", ALTO3_SECRET]
] as const) {
  test(`ALTO-3 [${label}]: the advisory names the event holding the secret, not just the innocent neighbour`, () => {
    const dir = mkTmpDir(`mapctx-store-violations-alto3-${label.replace(/[^a-z0-9]+/gi, "-")}-`);
    try {
      const handle = StoreHandle.open(dir);
      seed(handle, "T-001"); seed(handle, "T-002");
      dispatchAndReceipt(handle, "T-001", uuid("1"), ["src/common.ts", written]);
      dispatchAndReceipt(handle, "T-002", uuid("2"), ["src/common.ts", written]);
      const detected = recordClaimViolations(handle, wavePlan());
      const secretNorm = normalizePath(written);
      const secretViolation = detected.find(v => v.path === secretNorm);
      assert.ok(secretViolation, `expected a violation on ${secretNorm}; got ${JSON.stringify(detected.map(v => v.path))}`);

      const dry = redactEvidence(handle, { target: receiptTarget(handle, uuid("1")), fieldPath: "receipt.changedFiles", reason: "LGPD", actor: "dpo", commit: false });
      assert.ok(dry.ok);
      assert.ok(dry.mode === "dry-run");
      const reported = new Set(dry.derivedCopies.map(copy => `${copy.nodeId}/${copy.sequence}`));
      const rows = handle.db.prepare("SELECT node_id, sequence, payload_json FROM event_log WHERE event_type = 'claim-violation.detected'")
        .all() as Array<{ node_id: string; sequence: number; payload_json: string }>;
      const secretRow = rows.find(row => (JSON.parse(row.payload_json) as { violation: { path: string } }).violation.path === secretNorm);
      assert.ok(secretRow, "the secret-holding violation event must exist in event_log");
      assert.ok(reported.has(`${secretRow!.node_id}/${secretRow!.sequence}`),
        `advisory reported ${[...reported].join(",")}, but the secret is at ${secretRow!.node_id}/${secretRow!.sequence}`);
      assert.ok(!JSON.stringify(dry).includes("acme-bank"), "the advisory must never echo the secret");

      // Follow the advisory to the letter: redact both receipts, then every
      // derived copy it named. Nothing should be left over.
      redactField(handle, receiptTarget(handle, uuid("1")), "receipt.changedFiles");
      redactField(handle, receiptTarget(handle, uuid("2")), "receipt.changedFiles");
      for (const copy of dry.derivedCopies) redactField(handle, { nodeId: copy.nodeId, sequence: copy.sequence }, "violation.path");
      assert.deepEqual(bytesContaining(dir, "acme-bank"), [], "following the advisory must leave zero plaintext");
      handle.close();
      assert.equal(repairStore(dir).status, "ok");
    } finally { cleanupDir(dir); }
  });
}

// ---- T-131 attempt 3, review MÉDIA-1: redacting the derived copy
// (violation.path) must not be silently undone by the next detection run,
// and must warn about the source receipts that still hold the real path. ----

test("MÉDIA-1: redacting violation.path warns about its source receipts and survives re-detection", () => {
  const dir = mkTmpDir("mapctx-store-violations-media1-");
  try {
    const SECRET = "src/acme-bank-prod/shift-998877.ts";
    const handle = StoreHandle.open(dir);
    seed(handle, "T-001"); seed(handle, "T-002");
    dispatchAndReceipt(handle, "T-001", uuid("1"), [SECRET]);
    dispatchAndReceipt(handle, "T-002", uuid("2"), [SECRET]);
    recordClaimViolations(handle, wavePlan());
    const vrow = handle.db.prepare("SELECT node_id, sequence FROM event_log WHERE event_type = 'claim-violation.detected'").get() as { node_id: string; sequence: number };
    const vtarget: RedactionTarget = { nodeId: vrow.node_id, sequence: vrow.sequence };

    const dry = redactEvidence(handle, { target: vtarget, fieldPath: "violation.path", reason: "LGPD", actor: "dpo", commit: false });
    assert.ok(dry.ok);
    assert.ok(dry.mode === "dry-run");
    assert.ok(dry.advisories.some(a => /DERIVED from 2 receipt\(s\) that still hold it/.test(a) && /--field receipt\.changedFiles/.test(a)), JSON.stringify(dry.advisories));
    // Review ALTO-4: the unconditional "will NOT re-create" promise was only
    // true for an identical detectedAt; the wording now names what the
    // lookup actually guarantees, including the fresh-timestamp default.
    assert.ok(dry.advisories.some(a => /will not re-create this violation/.test(a) && /fresh timestamp/.test(a)), JSON.stringify(dry.advisories));
    assert.ok(!JSON.stringify(dry).includes("acme-bank"));

    redactField(handle, vtarget, "violation.path");
    const before = listClaimViolations(handle.db).map(v => v.path);
    const redetected = recordClaimViolations(handle, wavePlan());
    const after = listClaimViolations(handle.db).map(v => v.path);
    assert.deepEqual(redetected, [], "re-detection must not emit a fresh event carrying the real path");
    assert.equal(after.length, 1, JSON.stringify({ before, after }));
    assert.equal(after[0], REDACTED_SENTINEL);
    assert.equal(handle.db.prepare("SELECT COUNT(*) c FROM event_log WHERE event_type = 'claim-violation.detected'").get()!.c, 1);
    handle.close();
  } finally { cleanupDir(dir); }
});

// ---- T-131 attempt 3, review MÉDIA-3: the store must not export a function
// name that @mapctx/planner also exports with a different identity -- two
// packages publishing one name at two safety levels is how a future caller
// lands on the unguarded one by accident. ----

test("MÉDIA-3: no exported function name is shared between @mapctx/store and @mapctx/planner with a different identity", () => {
  // Relative requires into each package's own dist, avoiding a new runtime
  // dependency edge between the two packages' source.
  const storeIndex = require("./index") as Record<string, unknown>;
  const plannerIndex = require("../../planner/dist/index") as Record<string, unknown>;
  assert.ok(!("detectClaimViolations" in storeIndex), "the store must no longer publish the name the planner owns");
  assert.equal(typeof plannerIndex.detectClaimViolations, "function", "the planner keeps its own name");
  assert.equal(typeof storeIndex.detectClaimViolationsWithCoverage, "function");
  for (const name of ["recordClaimViolations", "detectAndPersistClaimViolations", "emitWaveClaimViolations"]) {
    assert.equal(typeof storeIndex[name], "function", `${name} must remain published`);
  }
  assert.equal(storeIndex.detectAndPersistClaimViolations, storeIndex.recordClaimViolations);
  assert.equal(storeIndex.emitWaveClaimViolations, storeIndex.recordClaimViolations);

  const storeNames = Object.keys(storeIndex);
  const plannerNames = Object.keys(plannerIndex);
  const shared = storeNames.filter(name => plannerNames.includes(name) && typeof storeIndex[name] === "function");
  const mismatched = shared.filter(name => storeIndex[name] !== plannerIndex[name]);
  assert.deepEqual(mismatched, [], `these function names are exported by both packages with different identities: ${JSON.stringify(mismatched)}`);

  // T-133 strengthening: the shared primitives now come from @mapctx/protocol
  // specifically, not merely from "whatever the two packages happen to
  // agree on" -- so the comparison above could in principle pass with two
  // fresh twin re-implementations that are merely identical BY VALUE at
  // different reference. Nail the actual primitive to its source.
  const protocolModule = require("@mapctx/protocol") as Record<string, unknown>;
  assert.equal(plannerIndex.pathsOverlap, protocolModule.pathsOverlap, "planner's pathsOverlap must be protocol's, not a re-implementation");
  assert.equal(typeof protocolModule.pathsOverlap, "function");
});

// ---- T-131 attempt 4, review ALTO-4 (self-found): switching semanticExists
// to the violation id in attempt 3 fixed MÉDIA-1 but broke idempotence,
// because makeViolation hashes `detectedAt` into the id and `detectedAt`
// defaults to `new Date()`. semanticExists now recognises an already-recorded
// violation under three identities: the id, the semantic tuple
// (waveId/kind/taskAId/taskBId/path), and the id recomputed against the
// STORED row's own detectedAt -- the third clause is what covers the
// COMBINED case (redacted AND re-detected with a fresh timestamp) that the
// first two miss individually. ----

function violationIdForTest(fields: { waveId: string; kind: string; taskAId: string; taskBId: string; path: string; detectedAt: string; source: string }): string {
  // Reproduces violationIdFor's exact key order and seed format, independent
  // of the source, so a future key reorder (which would orphan every row
  // already recorded) is caught by comparison rather than by sharing code.
  const ordered = {
    waveId: fields.waveId, kind: fields.kind, taskAId: fields.taskAId, taskBId: fields.taskBId,
    path: fields.path, detectedAt: fields.detectedAt, source: fields.source
  };
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const hex = createHash("sha256").update(`mapctx:claim-violation:${JSON.stringify(ordered)}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [hex.slice(0, 8).join(""), hex.slice(8, 12).join(""), hex.slice(12, 16).join(""), hex.slice(16, 20).join(""), hex.slice(20).join("")].join("-");
}

function violationTarget(handle: StoreHandle): RedactionTarget {
  const row = handle.db.prepare("SELECT node_id, sequence FROM event_log WHERE event_type = 'claim-violation.detected'").get() as { node_id: string; sequence: number };
  return { nodeId: row.node_id, sequence: row.sequence };
}

// (f) id stability: the formula must match byte for byte, or a future key
// reorder in violationIdFor silently orphans every row already recorded.
test("(f) violation id derivation matches the documented key order byte for byte", () => {
  const dir = mkTmpDir("mapctx-store-violations-alto4-idstable-");
  try {
    const SECRET = "src/acme-bank-prod/shift-998877.ts";
    const handle = StoreHandle.open(dir);
    seed(handle, "T-001"); seed(handle, "T-002");
    dispatchAndReceipt(handle, "T-001", uuid("1"), [SECRET]);
    dispatchAndReceipt(handle, "T-002", uuid("2"), [SECRET]);
    const detectedAt = "2026-10-10T07:02:00.000Z";
    const emitted = recordClaimViolations(handle, { ...wavePlan(), detectedAt });
    assert.equal(emitted.length, 1);
    const expected = violationIdForTest({ waveId: uuid("3"), kind: "collision", taskAId: "T-001", taskBId: "T-002", path: SECRET, detectedAt, source: "derived-from-receipts" });
    assert.equal(emitted[0].id, expected, `emitted ${emitted[0].id} vs recomputed ${expected}`);
    handle.close();
  } finally { cleanupDir(dir); }
});

// (a) ALTO-4 repro 1: idempotence on the DEFAULT path, where detectedAt is
// left out and therefore differs between runs -- this is the case the
// original id-only fix broke.
test("(a) recordClaimViolations is idempotent across two calls with no detectedAt (default = fresh timestamp each time)", () => {
  const dir = mkTmpDir("mapctx-store-violations-alto4-idempotent-");
  try {
    const SECRET = "src/acme-bank-prod/shift-998877.ts";
    const handle = StoreHandle.open(dir);
    seed(handle, "T-001"); seed(handle, "T-002");
    dispatchAndReceipt(handle, "T-001", uuid("1"), [SECRET]);
    dispatchAndReceipt(handle, "T-002", uuid("2"), [SECRET]);
    const { detectedAt, ...planWithoutDetectedAt } = wavePlan();
    void detectedAt;
    const run1 = recordClaimViolations(handle, planWithoutDetectedAt);
    const run2 = recordClaimViolations(handle, planWithoutDetectedAt);
    assert.equal(run1.length, 1);
    assert.equal(run2.length, 0, "a second call with a fresh default timestamp must not duplicate the first");
    assert.equal(handle.db.prepare("SELECT COUNT(*) c FROM event_log WHERE event_type = 'claim-violation.detected'").get()!.c, 1);
    assert.equal(listClaimViolations(handle.db).length, 1);
    handle.close();
  } finally { cleanupDir(dir); }
});

// (b) + (c) ALTO-4 repro 2: MÉDIA-1 under same / different / default
// (fresh, i.e. the COMBINED redacted-plus-fresh-timestamp case) detectedAt.
for (const [label, first, second] of [
  ["same detectedAt", "2026-10-10T07:02:00.000Z", "2026-10-10T07:02:00.000Z"],
  ["different detectedAt", "2026-10-10T07:02:00.000Z", "2026-10-10T09:30:00.000Z"],
  ["(c) the COMBINED case: redacted AND re-detected with a fresh default timestamp", "2026-10-10T07:02:00.000Z", undefined]
] as const) {
  test(`(b) MÉDIA-1 holds with ${label}`, () => {
    const dir = mkTmpDir(`mapctx-store-violations-alto4-media1-${label.replace(/[^a-z0-9]+/gi, "-")}-`);
    try {
      const SECRET = "src/acme-bank-prod/shift-998877.ts";
      const handle = StoreHandle.open(dir);
      seed(handle, "T-001"); seed(handle, "T-002");
      dispatchAndReceipt(handle, "T-001", uuid("1"), [SECRET]);
      dispatchAndReceipt(handle, "T-002", uuid("2"), [SECRET]);
      recordClaimViolations(handle, { ...wavePlan(), detectedAt: first });
      redactField(handle, violationTarget(handle), "violation.path");
      const before = bytesContaining(dir, "acme-bank").length;
      const secondPlan = second === undefined
        ? (() => { const { detectedAt, ...rest } = wavePlan(); void detectedAt; return rest; })()
        : { ...wavePlan(), detectedAt: second };
      const redetected = recordClaimViolations(handle, secondPlan);
      const rows = listClaimViolations(handle.db).map(v => v.path);
      assert.deepEqual(redetected, [], `re-detection must emit nothing; got ${JSON.stringify(redetected.map(v => v.path))}`);
      assert.equal(rows.length, 1, JSON.stringify(rows));
      assert.equal(rows[0], REDACTED_SENTINEL);
      assert.equal(bytesContaining(dir, "acme-bank").length, before, "plaintext must not come back");
      handle.close();
    } finally { cleanupDir(dir); }
  });
}

// (e) non-suppression, block C: a DIFFERENT path between the same pair must
// still be recorded even after the OTHER violation on that pair is redacted
// -- the sentinel-path row and the innocent-path row must coexist, with no
// duplicate, and no row anywhere carries the secret back.
test("(e-1) a different path between the same pair coexists with a redacted sibling, no duplicate, no secret resurfacing", () => {
  const dir = mkTmpDir("mapctx-store-violations-alto4-coexist-");
  try {
    const SECRET = "src/acme-bank-prod/shift-998877.ts";
    const handle = StoreHandle.open(dir);
    seed(handle, "T-001"); seed(handle, "T-002");
    dispatchAndReceipt(handle, "T-001", uuid("1"), [SECRET, "src/other.ts"]);
    dispatchAndReceipt(handle, "T-002", uuid("2"), [SECRET, "src/other.ts"]);
    recordClaimViolations(handle, { ...wavePlan(), detectedAt: "2026-10-10T07:02:00.000Z" });
    assert.equal(listClaimViolations(handle.db).length, 2);

    const rows = handle.db.prepare("SELECT node_id, sequence, payload_json FROM event_log WHERE event_type = 'claim-violation.detected'")
      .all() as Array<{ node_id: string; sequence: number; payload_json: string }>;
    const secretRow = rows.find(row => (JSON.parse(row.payload_json) as { violation: { path: string } }).violation.path === SECRET);
    assert.ok(secretRow);
    redactField(handle, { nodeId: secretRow!.node_id, sequence: secretRow!.sequence }, "violation.path");

    const after = recordClaimViolations(handle, { ...wavePlan(), detectedAt: "2026-10-10T08:00:00.000Z" });
    assert.deepEqual(after, [], "the innocent violation is already recorded; a fresh run must add nothing");
    const paths = listClaimViolations(handle.db).map(v => v.path).sort();
    assert.equal(paths.length, 2, JSON.stringify(paths));
    assert.ok(paths.includes("src/other.ts"));
    assert.ok(paths.includes(REDACTED_SENTINEL));
    assert.ok(listClaimViolations(handle.db).every(v => v.path !== SECRET), "no violation row must carry the secret back");
    handle.close();
  } finally { cleanupDir(dir); }
});

// (e) non-suppression, block D: a genuinely NEW collision between the same
// pair of tasks (a later wave, a different shared file) must still be
// recorded. If semanticExists over-matched on the pair alone, this would be
// incorrectly suppressed -- that is exactly the false negative the fix must
// not introduce.
test("(e-2) a genuinely new collision between the same pair of tasks is still recorded, not suppressed", () => {
  const dir = mkTmpDir("mapctx-store-violations-alto4-newcollision-");
  try {
    const SECRET = "src/acme-bank-prod/shift-998877.ts";
    const handle = StoreHandle.open(dir);
    seed(handle, "T-001"); seed(handle, "T-002");
    dispatchAndReceipt(handle, "T-001", uuid("1"), [SECRET]);
    dispatchAndReceipt(handle, "T-002", uuid("2"), [SECRET]);
    recordClaimViolations(handle, { ...wavePlan(), detectedAt: "2026-10-10T07:02:00.000Z" });
    redactField(handle, violationTarget(handle), "violation.path");

    dispatchAndReceipt(handle, "T-001", uuid("4"), ["src/brand-new.ts"]);
    dispatchAndReceipt(handle, "T-002", uuid("5"), ["src/brand-new.ts"]);
    const fresh = recordClaimViolations(handle, {
      waves: [{ waveId: uuid("3"), dispatches: [
        { waveId: uuid("3"), dispatchId: uuid("4"), attempt: 1, taskId: "T-001" },
        { waveId: uuid("3"), dispatchId: uuid("5"), attempt: 1, taskId: "T-002" }
      ] }], claims: [], detectedAt: "2026-10-10T10:00:00.000Z"
    });
    assert.equal(fresh.length, 1, JSON.stringify(fresh.map(v => v.path)));
    assert.equal(fresh[0].path, "src/brand-new.ts");
    handle.close();
  } finally { cleanupDir(dir); }
});

// (d) the reverse advisory must state only what the lookup actually
// guarantees -- not the unconditional (and wrong) ALTO-3-style promise.
test("(d) the reverse advisory names all three identities and the fresh-timestamp case, drops the old unconditional promise", () => {
  const dir = mkTmpDir("mapctx-store-violations-alto4-advisory-");
  try {
    const SECRET = "src/acme-bank-prod/shift-998877.ts";
    const handle = StoreHandle.open(dir);
    seed(handle, "T-001"); seed(handle, "T-002");
    dispatchAndReceipt(handle, "T-001", uuid("1"), [SECRET]);
    dispatchAndReceipt(handle, "T-002", uuid("2"), [SECRET]);
    recordClaimViolations(handle, { ...wavePlan(), detectedAt: "2026-10-10T07:02:00.000Z" });
    const dry = redactEvidence(handle, { target: violationTarget(handle), fieldPath: "violation.path", reason: "LGPD", actor: "dpo", commit: false });
    assert.ok(dry.ok);
    assert.ok(dry.mode === "dry-run");
    const promise = dry.advisories.find(a => /later detection run/.test(a));
    assert.ok(promise, JSON.stringify(dry.advisories));
    assert.ok(!/unchanged by redaction, so the redacted row keeps satisfying it/.test(promise!), promise);
    assert.match(promise!, /recomputed against this row's own detectedAt/);
    assert.match(promise!, /fresh timestamp/);
    assert.ok(!JSON.stringify(dry).includes("acme-bank"));
    handle.close();
  } finally { cleanupDir(dir); }
});
