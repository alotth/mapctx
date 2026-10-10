import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import * as fs from "fs"
import * as path from "path"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { canonicalJson, claimViolationSchema, runEventSchema, runReceiptSchema, type EventLogEntry, type RunEvent } from "@mapctx/protocol"
import { commitNodeAttestation, draftNodeAttestation, loadNodeAttestations } from "./attestation"
import { claimTask } from "./claims"
import { recordDispatchAttempt, recordRunEvent, recordRunReceipt } from "./dispatch"
import { journalEntryPath, payloadSha256, readJournalEntry } from "./journal"
import { getAcceptance, getRunEvent, getRunReceipt, listClaimViolations, listHistoryEvidence, listRedactions } from "./projections"
import {
  isRedactableFieldPath, listRedactionCandidates, reconcileRedactionsFromLedger, redactEvidence, REDACTED_SENTINEL,
  REDACTABLE_ROOTS, verifyRedactions, verifyRedactionsFromLedger, type RedactionCommitResult, type RedactionTarget
} from "./redact"
import { repairStore } from "./repair"
import { StoreHandle } from "./store-handle"
import { recordClaimViolations } from "./violations"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

const SECRET = "cust-ctx-9f31a778421-production"
const OTHER_SECRET = "shift-998877-confidential"
const AT = "2026-10-09T10:00:00.000Z"
const DISPATCH_ID = "11111111-1111-4111-8111-111111111111"

function fixture(t: TestContext) {
  const dir = mkTmpDir("mapctx-redact-test-");
  let handle: StoreHandle | undefined = StoreHandle.open(dir);
  const close = () => { handle?.close(); handle = undefined; };
  t.after(() => { close(); cleanupDir(dir); });
  return {
    dir,
    get handle() { assert.ok(handle); return handle; },
    close,
    open(readOnly = false) {
      close();
      handle = readOnly ? StoreHandle.openReadOnly(dir) : StoreHandle.open(dir);
      // node:sqlite lazily creates empty WAL/SHM read-coordination files on
      // the first query. Initialize them before byte-immutability snapshots.
      if (readOnly) handle.db.prepare("SELECT COUNT(*) FROM event_log").get();
      return handle;
    }
  };
}

function seed(handle: StoreHandle): void {
  handle.appendEvent({
    eventType: "project.initialized", actor: "test",
    payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "store" }
  });
  handle.appendEvent({
    eventType: "task.upserted", actor: "test",
    payload: { task: {
      taskId: "T-001", positionKey: 1, title: "task", planningState: "backlog", executionState: "unclaimed",
      workload: "Normal", tags: [], domains: [], externalLinks: [], assignees: []
    }, detail: {
      taskId: "T-001", role: "implementation", impact: "low", estimatedEffort: "1d",
      prerequisites: [], blocking: [], filesAffected: [], testsRequired: [], summary: "fixture"
    } }
  });
  handle.appendEvent({
    eventType: "acceptance.revised", actor: "test",
    payload: { taskId: "T-001", revision: 1, condition: "criteria", criteria: [
      { criterionId: "c1", revision: 1, position: 0, text: "works", state: "pending", source: "authored" }
    ] }
  });
}

function approve(handle: StoreHandle, evidence: Record<string, string> = { shift: SECRET }): EventLogEntry {
  return handle.appendEvent({
    eventType: "acceptance.approved", actor: "approver",
    payload: { taskId: "T-001", revision: 1, criterionId: "c1", evidence, approvedAt: AT }
  });
}

function commit(handle: StoreHandle, target: RedactionTarget, fieldPath = "evidence.shift", reason = "LGPD: remove production identifier"): RedactionCommitResult {
  const result = redactEvidence(handle, { target, fieldPath, reason, actor: "dpo", commit: true, now: () => new Date(AT) });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.mode, "commit");
  assert.ok(result.mode === "commit");
  assert.equal(result.reclaimed, true, result.reclaimWarning);
  assert.ok(!JSON.stringify(result).includes(SECRET), "commit result must not echo the secret");
  return result;
}

function journal(dir: string, target: RedactionTarget): EventLogEntry {
  const read = readJournalEntry(dir, target.nodeId, target.sequence);
  assert.equal(read.status, "ok");
  assert.ok(read.status === "ok");
  return read.entry;
}

/** Byte-search every file, including SQLite, WAL, SHM and all journal nodes. */
function files(dir: string): Record<string, Buffer> {
  const result: Record<string, Buffer> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else result[path.relative(dir, absolute)] = fs.readFileSync(absolute);
    }
  };
  walk(dir);
  return result;
}

function assertAbsent(dir: string, secret = SECRET): void {
  const hits = Object.entries(files(dir)).filter(([, bytes]) => bytes.includes(Buffer.from(secret))).map(([name]) => name);
  assert.deepEqual(hits, [], "plaintext survived in store files");
}

function assertPresent(dir: string, secret: string): void {
  const hits = Object.entries(files(dir)).filter(([, bytes]) => bytes.includes(Buffer.from(secret))).map(([name]) => name);
  assert.ok(hits.length > 0, "expected the plaintext to still be present at this point");
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(Object.entries(files(dir)).map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")]));
}

function assertApprovalScrubbed(handle: StoreHandle, evidence: Record<string, string>): void {
  const criterion = getAcceptance(handle.db, "T-001")!.criteria[0];
  assert.equal(criterion.state, "approved", "redaction must preserve the approval fact");
  assert.equal(criterion.approvedBy, "approver");
  assert.equal(criterion.approvedAt, AT);
  assert.deepEqual(criterion.evidence, evidence);
  const row = handle.db.prepare("SELECT evidence_json FROM acceptance_criterion_projection WHERE criterion_id = ?").get("c1") as { evidence_json: string };
  assert.equal(canonicalJson(JSON.parse(row.evidence_json)), canonicalJson(evidence));
}

function assertRepairGap(dir: string, target: RedactionTarget, reason: RegExp): void {
  const before = createHash("sha256").update(fs.readFileSync(StoreHandle.dbPathFor(dir))).digest("hex");
  const result = repairStore(dir);
  assert.equal(result.status, "gap", JSON.stringify(result));
  assert.ok(result.status === "gap");
  assert.ok(result.gaps.some(gap => gap.nodeId === target.nodeId && gap.sequence === target.sequence && reason.test(gap.reason)), JSON.stringify(result.gaps));
  assert.equal(createHash("sha256").update(fs.readFileSync(StoreHandle.dbPathFor(dir))).digest("hex"), before, "refusal must leave database untouched");
}

test("redaction destroys journal, indexed and projection plaintext but preserves approval and audit facts through repair", t => {
  const f = fixture(t);
  seed(f.handle);
  // Intentionally non-alphabetic insertion order: projections use JSON.stringify,
  // journal uses canonicalJson. The scrub must compare values canonically.
  const target = approve(f.handle, { shift: SECRET, customer: OTHER_SECRET });
  const originalSha = payloadSha256(target.payload);
  assert.ok(fs.readFileSync(journalEntryPath(f.dir, target.nodeId, target.sequence)).includes(SECRET));
  const result = commit(f.handle, target, "evidence");
  const entry = journal(f.dir, target);
  const expected = { shift: REDACTED_SENTINEL, customer: REDACTED_SENTINEL };
  assert.deepEqual(entry.payload.evidence, expected);
  assert.equal(entry.payload.criterionId, "c1");
  assert.equal(entry.payloadSha256, payloadSha256(entry.payload));
  assert.equal(entry.redactions!.length, 1);
  assert.equal("redactions" in entry.payload, false, "markers belong outside payload");
  const audit = journal(f.dir, result.redactionEvent);
  assert.equal(audit.eventType, "evidence.redacted");
  assert.equal(audit.actor, "dpo");
  assert.deepEqual(audit.causation, [{ nodeId: target.nodeId, sequence: target.sequence }]);
  assert.equal(audit.payload.priorPayloadSha256, originalSha);
  assert.equal(audit.payload.redactedPayloadSha256, entry.payloadSha256);
  assert.equal(audit.payload.reason, "LGPD: remove production identifier");
  assert.deepEqual(entry.redactions![0], {
    fieldPaths: ["evidence.customer", "evidence.shift"], reason: audit.payload.reason, actor: "dpo", redactedAt: AT,
    priorPayloadSha256: originalSha, redactedPayloadSha256: entry.payloadSha256, redactionEvent: result.redactionEvent
  });
  const indexed = f.handle.db.prepare("SELECT payload_json, payload_sha256 FROM event_log WHERE node_id = ? AND sequence = ?")
    .get(target.nodeId, target.sequence) as { payload_json: string; payload_sha256: string };
  assert.equal(canonicalJson(JSON.parse(indexed.payload_json)), canonicalJson(entry.payload));
  assert.equal(indexed.payload_sha256, entry.payloadSha256);
  assertApprovalScrubbed(f.handle, expected);
  const ledger = listRedactions(f.handle.db);
  assert.deepEqual(ledger, [{
    eventNode: result.redactionEvent.nodeId, eventSequence: result.redactionEvent.sequence, logicalClock: audit.logicalClock,
    targetNode: target.nodeId, targetSequence: target.sequence, fieldPaths: result.plan.fieldPaths,
    requestedFieldPath: "evidence", priorPayloadSha256: originalSha, redactedPayloadSha256: entry.payloadSha256,
    reason: "LGPD: remove production identifier", actor: "dpo", redactedAt: AT
  }]);
  assertAbsent(f.dir);
  assertAbsent(f.dir, OTHER_SECRET);
  f.close();
  const repaired = repairStore(f.dir);
  assert.equal(repaired.status, "ok", JSON.stringify(repaired));
  assert.ok(repaired.status === "ok");
  assert.equal(repaired.eventsReplayed, 5);
  f.open();
  assertApprovalScrubbed(f.handle, expected);
  assert.deepEqual(listRedactions(f.handle.db), ledger);
  assert.equal(f.handle.maintenanceNeeded(), null);
  assertAbsent(f.dir);
  assertAbsent(f.dir, OTHER_SECRET);
});

test("candidate discovery reports only paths; read-only dry-run changes no store bytes or facts and masks previews", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  f.open(true);
  const before = snapshot(f.dir);
  const candidates = listRedactionCandidates(f.handle.db, { taskId: "T-001" });
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].redactableFieldPaths, ["evidence.shift"]);
  assert.deepEqual(candidates[0].redactedFieldPaths, []);
  assert.equal(candidates[0].subject, "T-001");
  assert.deepEqual(listRedactionCandidates(f.handle.db, { taskId: "T-999" }), []);
  // Even the distinctive prefix must not appear: discovery carries no preview.
  assert.ok(!JSON.stringify(candidates).includes("cust-ctx"));
  assert.ok(!JSON.stringify(candidates).includes("9f31a778421"));
  const result = redactEvidence(f.handle, { target, fieldPath: "evidence", reason: "LGPD", actor: "dpo", commit: false });
  assert.ok(result.ok);
  assert.equal(result.mode, "dry-run");
  assert.deepEqual(result.plan.previews, [{ fieldPath: "evidence.shift", preview: "cu…", length: SECRET.length }]);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.equal(result.plan.priorPayloadSha256, target.payloadSha256);
  assert.notEqual(result.plan.redactedPayloadSha256, target.payloadSha256);
  assert.deepEqual(listRedactions(f.handle.db), []);
  assert.equal(f.handle.db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'evidence.redacted'").get()!.n, 0);
  assert.deepEqual(getAcceptance(f.handle.db, "T-001")!.criteria[0].evidence, { shift: SECRET });
  assert.deepEqual(snapshot(f.dir), before, "dry-run must change no file, journal, database or sidecar");
});

for (const heal of ["writable open", "repair"] as const) {
  test(`committed redaction with plaintext journal: read-only surfaces without writing; ${heal} heals forward`, t => {
    const f = fixture(t);
    seed(f.handle);
    const target = approve(f.handle);
    const targetPath = journalEntryPath(f.dir, target.nodeId, target.sequence);
    const plaintext = fs.readFileSync(targetPath);
    commit(f.handle, target);
    f.close();
    // Crash between transaction commit and target-file rename.
    fs.writeFileSync(targetPath, plaintext);
    const plaintextFiles = Object.entries(files(f.dir)).filter(([, bytes]) => bytes.includes(SECRET)).map(([filename]) => filename);
    assert.deepEqual(plaintextFiles, [path.relative(f.dir, targetPath)], "only the target journal should lag the committed transaction");
    f.open(true);
    const before = snapshot(f.dir);
    const verification = verifyRedactionsFromLedger(f.dir, f.handle.db);
    assert.deepEqual(verification.problems, []);
    assert.equal(verification.pending.length, 1);
    assert.match(f.handle.maintenanceNeeded()!, /1 committed redaction\(s\) are not yet applied/);
    assert.deepEqual(snapshot(f.dir), before, "diagnostic must not heal or modify store");
    assert.deepEqual(fs.readFileSync(targetPath), plaintext);
    f.close();
    if (heal === "repair") {
      const repaired = repairStore(f.dir);
      assert.equal(repaired.status, "ok", JSON.stringify(repaired));
      assert.ok(repaired.status === "ok");
      assert.equal(repaired.eventsReplayed, 5);
      // Check before any writable open: repair must heal independently.
      assert.deepEqual(journal(f.dir, target).payload.evidence, { shift: REDACTED_SENTINEL });
      assert.equal(journal(f.dir, target).redactions!.length, 1);
      assertAbsent(f.dir);
      f.open(true);
      assertApprovalScrubbed(f.handle, { shift: REDACTED_SENTINEL });
      assert.equal(f.handle.maintenanceNeeded(), null);
      f.close();
    }
    f.open();
    assert.deepEqual(journal(f.dir, target).payload.evidence, { shift: REDACTED_SENTINEL });
    assert.equal(journal(f.dir, target).redactions!.length, 1);
    assertApprovalScrubbed(f.handle, { shift: REDACTED_SENTINEL });
    assert.equal(f.handle.maintenanceNeeded(), null);
    assert.equal(listRedactions(f.handle.db).length, 1);
    assertAbsent(f.dir);
    // Repeated opens must neither append a second audit event nor resurrect content.
    f.open();
    assert.equal(listRedactions(f.handle.db).length, 1);
    assertAbsent(f.dir);
  });
}

test("repair refuses forged redactions marker without evidence.redacted event", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  const entry = journal(f.dir, target);
  f.close();
  entry.payload.evidence = { shift: REDACTED_SENTINEL };
  entry.payloadSha256 = payloadSha256(entry.payload);
  entry.redactions = [{
    fieldPaths: ["evidence.shift"], reason: "forged", actor: "attacker", redactedAt: AT,
    priorPayloadSha256: target.payloadSha256, redactedPayloadSha256: entry.payloadSha256,
    redactionEvent: { nodeId: target.nodeId, sequence: 99 }
  }];
  fs.writeFileSync(journalEntryPath(f.dir, target.nodeId, target.sequence), canonicalJson(entry));
  assertRepairGap(f.dir, target, /no evidence\.redacted event exists/);
});

test("repair refuses raw payload edit with stale hash", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  const entry = journal(f.dir, target);
  f.close();
  entry.payload.evidence = { shift: "forged" };
  fs.writeFileSync(journalEntryPath(f.dir, target.nodeId, target.sequence), canonicalJson(entry));
  assertRepairGap(f.dir, target, /payload hash mismatch/);
});

test("repair refuses self-consistent edit of already-redacted entry; opening the store refuses the same way", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  commit(f.handle, target);
  const entry = journal(f.dir, target);
  f.close();
  entry.payload.criterionId = "c-FORGED";
  entry.payloadSha256 = payloadSha256(entry.payload);
  fs.writeFileSync(journalEntryPath(f.dir, target.nodeId, target.sequence), canonicalJson(entry));
  let threw = "";
  try { StoreHandle.open(f.dir).close(); } catch (error) { threw = (error as Error).message; }
  assert.match(threw, /redaction verification failed/);
  assertRepairGap(f.dir, target, /matches neither the pre-redaction payload/);
});

test("repair refuses matching audit event when target marker is missing or altered", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  commit(f.handle, target);
  const entry = journal(f.dir, target);
  f.close();
  const targetPath = journalEntryPath(f.dir, target.nodeId, target.sequence);
  fs.writeFileSync(targetPath, canonicalJson({ ...entry, redactions: undefined }));
  assertRepairGap(f.dir, target, /do not match the 1 applied redaction event/);
  entry.redactions![0].actor = "forged-actor";
  fs.writeFileSync(targetPath, canonicalJson(entry));
  assertRepairGap(f.dir, target, /do not match the 1 applied redaction event/);
});

test("two sequential redactions extend continuous chain, preserve unselected values and survive repair", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle, { shift: SECRET, other: OTHER_SECRET });
  const first = commit(f.handle, target);
  assertApprovalScrubbed(f.handle, { shift: REDACTED_SENTINEL, other: OTHER_SECRET });
  const second = commit(f.handle, target, "evidence.other", "second removal");
  const entry = journal(f.dir, target);
  assert.equal(entry.redactions!.length, 2);
  assert.equal(first.plan.priorPayloadSha256, target.payloadSha256);
  assert.equal(second.plan.priorPayloadSha256, first.plan.redactedPayloadSha256);
  assert.equal(entry.redactions![1].priorPayloadSha256, entry.redactions![0].redactedPayloadSha256);
  assert.equal(entry.payloadSha256, second.plan.redactedPayloadSha256);
  const candidates = listRedactionCandidates(f.handle.db);
  assert.deepEqual(candidates[0].redactableFieldPaths, []);
  assert.deepEqual(candidates[0].redactedFieldPaths, ["evidence.other", "evidence.shift"]);
  f.close();
  assert.equal(repairStore(f.dir).status, "ok");
  f.open();
  const ledger = listRedactions(f.handle.db);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[1].priorPayloadSha256, ledger[0].redactedPayloadSha256);
  assertApprovalScrubbed(f.handle, { shift: REDACTED_SENTINEL, other: REDACTED_SENTINEL });
  assertAbsent(f.dir);
  assertAbsent(f.dir, OTHER_SECRET);
});

test("repair refuses broken chain even when tampered audit event has recomputed payload hash", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle, { shift: SECRET, other: OTHER_SECRET });
  commit(f.handle, target);
  const second = commit(f.handle, target, "evidence.other");
  const audit = journal(f.dir, second.redactionEvent);
  f.close();
  audit.payload.priorPayloadSha256 = "0".repeat(64);
  audit.payloadSha256 = payloadSha256(audit.payload);
  fs.writeFileSync(journalEntryPath(f.dir, audit.nodeId, audit.sequence), canonicalJson(audit));
  assertRepairGap(f.dir, target, /broken redaction chain/);
});

test("named refusals for already redacted, structural, audit-event and unexplained requests write nothing", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  const result = commit(f.handle, target);
  const before = snapshot(f.dir);
  const cases = [
    // Review BAIXA-2: holding the sentinel is not proof an audit record
    // explains it, so the message points at `redact list` instead of
    // asserting "already redacted" outright.
    { target, fieldPath: "evidence.shift", reason: "again", expected: "nothing-to-redact", message: /already holds the redaction sentinel/ },
    { target, fieldPath: "criterionId", reason: "x", expected: "not-redactable", message: /Structural facts/ },
    { target: result.redactionEvent, fieldPath: "reason", reason: "x", expected: "not-redactable", message: /audit record itself/ },
    { target, fieldPath: "evidence", reason: "  ", expected: "invalid-request", message: /requires --reason/ }
  ];
  for (const request of cases) {
    const refused = redactEvidence(f.handle, { ...request, actor: "dpo", commit: true });
    assert.equal(refused.ok, false);
    assert.ok(!refused.ok);
    assert.equal(refused.reason, request.expected);
    assert.match(refused.message, request.message);
  }
  assert.deepEqual(listRedactions(f.handle.db).length, 1);
  assert.deepEqual(snapshot(f.dir), before);
});

test("attested node refuses redaction by name without invalidating byte-pinned evidence", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  // Model DB-only legacy rows with recovered journal copies available. The
  // attestation remains real and validated, not a mocked loadNodeAttestations.
  f.handle.db.prepare("UPDATE event_log SET journal_path = '' WHERE node_id = ?").run(target.nodeId);
  f.close();
  const nodeDir = path.join(f.dir, "events", target.nodeId);
  const recoveredJournal = files(nodeDir);
  fs.rmSync(nodeDir, { recursive: true });
  const options = { reason: "reviewed legacy node", evidence: { doc: "docs/review.md" }, approvedBy: "reviewer" };
  const draft = draftNodeAttestation(f.dir, target.nodeId, options);
  commitNodeAttestation(f.dir, target.nodeId, draft.contentSha256, options);
  assert.ok(loadNodeAttestations(f.dir).has(target.nodeId));
  fs.mkdirSync(nodeDir, { recursive: true });
  for (const [filename, bytes] of Object.entries(recoveredJournal)) fs.writeFileSync(path.join(nodeDir, filename), bytes);
  f.open(true);
  const before = snapshot(f.dir);
  const result = redactEvidence(f.handle, { target, fieldPath: "evidence.shift", reason: "LGPD", actor: "dpo", commit: true });
  assert.ok(!result.ok);
  assert.equal(result.reason, "attested-node");
  assert.match(result.message, /Re-attest the node/);
  assert.deepEqual(listRedactions(f.handle.db), []);
  assert.deepEqual(snapshot(f.dir), before);
});

test("receipt redaction scrubs only uri/promotedPath, preserves ArtifactRef structure and both receipt projections", t => {
  const f = fixture(t);
  seed(f.handle);
  assert.ok(claimTask(f.handle, { taskId: "T-001", actor: "test" }).ok);
  assert.ok(recordDispatchAttempt(f.handle, {
    dispatchId: DISPATCH_ID, taskId: "T-001", executorKind: "test", attempt: 1, contextHash: "hash", status: "claimed"
  }, "test").ok);
  const artifact = {
    artifactId: "22222222-2222-4222-8222-222222222222", ownerKind: "task", ownerId: "T-001",
    uri: `https://example.invalid/${SECRET}`, kind: "review", version: "1", contentHash: "content-hash",
    promotedPath: `docs/${OTHER_SECRET}.md`
  };
  const receipt = { schemaVersion: 1, dispatchId: DISPATCH_ID, attempt: 1, outcome: "completed",
    startedAt: AT, endedAt: "2026-10-09T10:05:00.000Z", changedFiles: ["src/x.ts"], usageEvents: [], evidence: [artifact], failure: null };
  const target = f.handle.appendEvent({ eventType: "run.receipt-recorded", actor: "test", payload: { receipt } });
  const candidates = listRedactionCandidates(f.handle.db);
  // T-131 widened receipt.changedFiles to redactable too, so the fixture's
  // changedFiles entry now shows up alongside the ArtifactRef leaves.
  assert.deepEqual(candidates[0].redactableFieldPaths, ["receipt.evidence.0.promotedPath", "receipt.evidence.0.uri", "receipt.changedFiles.0"]);
  const refused = redactEvidence(f.handle, { target, fieldPath: "receipt.evidence.0.artifactId", reason: "x", actor: "dpo", commit: true });
  assert.ok(!refused.ok);
  assert.equal(refused.reason, "not-redactable");
  commit(f.handle, target, "receipt.evidence");
  const expected = { ...receipt, evidence: [{ ...artifact, uri: REDACTED_SENTINEL, promotedPath: REDACTED_SENTINEL }] };
  assert.deepEqual(journal(f.dir, target).payload.receipt, expected);
  assert.ok(runReceiptSchema.safeParse(expected).success, "redacted receipt remains schema-valid");
  const projected = f.handle.db.prepare("SELECT evidence_json, receipt_json FROM run_receipt_projection WHERE dispatch_id = ? AND attempt = 1")
    .get(DISPATCH_ID) as { evidence_json: string; receipt_json: string };
  assert.equal(canonicalJson(JSON.parse(projected.evidence_json)), canonicalJson(expected.evidence));
  assert.equal(canonicalJson(JSON.parse(projected.receipt_json)), canonicalJson(expected));
  assertAbsent(f.dir);
  assertAbsent(f.dir, OTHER_SECRET);
  f.close();
  assert.equal(repairStore(f.dir).status, "ok");
  f.open();
  assert.deepEqual(getRunReceipt(f.handle.db, DISPATCH_ID, 1)!.evidence, expected.evidence);
  assertAbsent(f.dir);
});

test("history redaction scrubs repoRoot/repoOrigin while preserving ids, hashes, signals and lifecycle", t => {
  const f = fixture(t);
  seed(f.handle);
  const evidence = {
    evidenceId: "ev1", taskId: "T-001", harness: "codex", sessionId: "session1", tier: "measured", confidence: "high",
    repoRoot: `/repo/${SECRET}`, repoOrigin: `https://example.invalid/${OTHER_SECRET}`, signals: ["toolcall", "file-edit"],
    spanStart: AT, spanEnd: "2026-10-09T10:05:00.000Z", activeMs: 300000, sourceHash: "a".repeat(16), recordedAt: AT
  };
  const target = f.handle.appendEvent({ eventType: "history.evidence-recorded", actor: "test", payload: { evidence } });
  const beforeTask = f.handle.db.prepare("SELECT * FROM task_projection WHERE task_id = 'T-001'").get();
  for (const fieldPath of ["evidence", "evidence.signals", "evidence.evidenceId", "evidence.sourceHash"]) {
    const result = redactEvidence(f.handle, { target, fieldPath, reason: "x", actor: "dpo", commit: true });
    assert.ok(!result.ok);
    assert.equal(result.reason, "not-redactable");
  }
  commit(f.handle, target, "evidence.repoRoot");
  commit(f.handle, target, "evidence.repoOrigin");
  assert.deepEqual(journal(f.dir, target).payload.evidence, { ...evidence, repoRoot: REDACTED_SENTINEL, repoOrigin: REDACTED_SENTINEL });
  const row = listHistoryEvidence(f.handle.db, "T-001")[0];
  assert.equal(row.repoRoot, REDACTED_SENTINEL);
  assert.equal(row.repoOrigin, REDACTED_SENTINEL);
  assert.deepEqual(row.signals, evidence.signals);
  assert.equal(row.sourceHash, evidence.sourceHash);
  assert.equal(row.status, "active");
  assert.deepEqual(f.handle.db.prepare("SELECT * FROM task_projection WHERE task_id = 'T-001'").get(), beforeTask);
  assertAbsent(f.dir);
  assertAbsent(f.dir, OTHER_SECRET);
  f.close();
  assert.equal(repairStore(f.dir).status, "ok");
  f.open();
  assert.equal(listHistoryEvidence(f.handle.db, "T-001")[0].repoRoot, REDACTED_SENTINEL);
  assertAbsent(f.dir);
  assertAbsent(f.dir, OTHER_SECRET);
});

test("redacting an older approval preserves newer approval evidence", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  f.handle.appendEvent({ eventType: "acceptance.unapproved", actor: "approver", payload: { taskId: "T-001", revision: 1, criterionId: "c1" } });
  approve(f.handle, { shift: "replacement-evidence" });
  commit(f.handle, target);
  assertApprovalScrubbed(f.handle, { shift: "replacement-evidence" });
  assertAbsent(f.dir);
  f.close();
  assert.equal(repairStore(f.dir).status, "ok");
  f.open();
  assertApprovalScrubbed(f.handle, { shift: "replacement-evidence" });
  assertAbsent(f.dir);
});

// ---- review ALTA-1: a redacted target's journal FILE disappearing (lost
// machine, fresh clone) must be an advisory, never a refusal that bricks the
// store. ----

test("losing a redacted target's journal file surfaces as a maintenanceAdvisory; reads, writable open and repair all stay reachable", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  commit(f.handle, target);
  f.close();
  fs.rmSync(journalEntryPath(f.dir, target.nodeId, target.sequence));

  const ro = f.open(true);
  ro.db.prepare("SELECT COUNT(*) FROM event_log").get();
  assert.equal(ro.maintenanceNeeded(), null, "an unresolved advisory must not refuse reads");
  const advisory = ro.maintenanceAdvisory();
  assert.equal(advisory.length, 1);
  assert.match(advisory[0], /cannot be read/);
  assert.match(advisory[0], /store repair/);
  assert.match(advisory[0], /attest-orphan/);
  assert.ok(!advisory.join("|").includes(SECRET), "advisory must never echo the secret");
  f.close();

  // Writable open must also succeed now (was: threw, store bricked).
  let openOk = true, openError = "";
  try { f.open(); } catch (error) { openOk = false; openError = (error as Error).message; }
  assert.ok(openOk, openError);
  f.close();

  const repaired = repairStore(f.dir);
  assert.equal(repaired.status, "gap", JSON.stringify(repaired));
  assert.ok(repaired.status === "gap");
  assert.ok(repaired.gaps.some(gap => gap.nodeId === target.nodeId && gap.sequence === target.sequence));
  assertAbsent(f.dir);
});

// ---- review ALTA-1: attestation is the executable recovery route from
// "redacted target, journal gone" to a healthy store, and refuses the
// symmetric case where the pinned bytes would contradict the ledger. ----

// Review MEDIA-4: a row that merely self-declares journal_path="" must NOT
// buy the lenient db-only branch's silence -- that requires BOTH halves of
// the T-119 claim, the column AND a reviewed attestation. Before attesting,
// the unattested state is an advisory (not a problem, not silence); after
// attesting, it is genuinely silent and repairable.
test("attesting a redacted DB-only node (journal gone) is accepted and lets repair reach a healthy store", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  commit(f.handle, target);
  const node = target.nodeId;
  f.close();

  // Simulate the T-119 condition this node's rows now live only in mapctx.db.
  fs.rmSync(path.join(f.dir, "events", node), { recursive: true, force: true });
  const db = new DatabaseSync(StoreHandle.dbPathFor(f.dir));
  db.exec(`UPDATE event_log SET journal_path = '' WHERE node_id = '${node}'`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  // Before attesting: journal_path="" alone is not the T-119 claim. This must
  // surface as an advisory, never pass silently (MEDIA-4), and never refuse
  // reads or writes (ALTA-1 behaviour preserved).
  const unattestedRo = f.open(true);
  unattestedRo.db.prepare("SELECT COUNT(*) FROM event_log").get();
  assert.equal(unattestedRo.maintenanceNeeded(), null);
  const unattestedAdvisory = unattestedRo.maintenanceAdvisory();
  assert.equal(unattestedAdvisory.length, 1);
  assert.match(unattestedAdvisory[0], /no reviewed attestation covers this node/);
  assert.ok(!unattestedAdvisory.join("|").includes(SECRET));
  f.close();
  let unattestedOpenOk = true, unattestedOpenError = "";
  try { f.open(); } catch (error) { unattestedOpenOk = false; unattestedOpenError = (error as Error).message; }
  assert.ok(unattestedOpenOk, unattestedOpenError);
  f.close();
  assert.equal(repairStore(f.dir).status, "gap", "repair still refuses an unattested self-declared DB-only row");

  const options = { reason: "lost machine; rows are DB-only", approvedBy: "reviewer" };
  const draft = draftNodeAttestation(f.dir, node, options);
  commitNodeAttestation(f.dir, node, draft.contentSha256, options);
  assert.ok(loadNodeAttestations(f.dir).has(node));

  // After attesting: the genuinely attested node verifies silently.
  const ro = f.open(true);
  ro.db.prepare("SELECT COUNT(*) FROM event_log").get();
  assert.equal(ro.maintenanceNeeded(), null);
  assert.deepEqual(ro.maintenanceAdvisory(), [], "a redacted, genuinely attested DB-only row verifies cleanly");
  f.close();

  const repaired = repairStore(f.dir);
  assert.equal(repaired.status, "ok", JSON.stringify(repaired).slice(0, 400));

  f.open();
  f.close();
  assertAbsent(f.dir);
});

test("attesting a node that still holds the pre-redaction payload is refused by name and does not echo the secret", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  const result = commit(f.handle, target);
  f.close();

  fs.rmSync(path.join(f.dir, "events", target.nodeId), { recursive: true, force: true });
  const db = new DatabaseSync(StoreHandle.dbPathFor(f.dir));
  db.exec(`UPDATE event_log SET journal_path = '' WHERE node_id = '${target.nodeId}'`);
  // Put the pre-redaction payload back into the row an attestation would pin:
  // the attestation must refuse rather than preserve destroyed content.
  const original = { taskId: "T-001", revision: 1, criterionId: "c1", evidence: { shift: SECRET }, approvedAt: AT };
  db.prepare("UPDATE event_log SET payload_json = ?, payload_sha256 = ? WHERE node_id = ? AND sequence = ?")
    .run(JSON.stringify(original), result.plan.priorPayloadSha256, target.nodeId, target.sequence);
  db.close();

  let refused = "";
  try { draftNodeAttestation(f.dir, target.nodeId, { reason: "x", approvedBy: "r" }); } catch (error) { refused = (error as Error).message; }
  assert.match(refused, /recorded redaction/);
  assert.match(refused, /store repair/);
  assert.ok(!refused.includes(SECRET));
});

// ---- review MEDIA-2: a target's redactions are ordered by logicalClock
// (causal order), never by the random node-id of the redaction events
// themselves. ----

test("multi-node redaction chain in causal (logicalClock) order verifies even when node ids sort the other way", () => {
  const S0 = "a".repeat(64), S1 = "b".repeat(64), S2 = "c".repeat(64);
  const targetEntry: EventLogEntry = {
    nodeId: "t", sequence: 4, logicalClock: 1, eventType: "acceptance.approved", schemaVersion: 1,
    occurredAt: AT, actor: "approver", causation: [], payload: { x: 1 }, payloadSha256: S2,
    redactions: [
      { fieldPaths: ["evidence.a"], reason: "r1", actor: "op", redactedAt: AT, priorPayloadSha256: S0, redactedPayloadSha256: S1,
        redactionEvent: { nodeId: "ffffffff-0000-4000-8000-000000000001", sequence: 1 } },
      { fieldPaths: ["evidence.b"], reason: "r2", actor: "op", redactedAt: AT, priorPayloadSha256: S1, redactedPayloadSha256: S2,
        redactionEvent: { nodeId: "00000000-0000-4000-8000-000000000002", sequence: 1 } }
    ]
  };
  const mkLink = (nodeId: string, logicalClock: number, requestedFieldPath: string, fieldPaths: string[], prior: string, redacted: string, reason: string): EventLogEntry => {
    const payload = { target: { nodeId: "t", sequence: 4 }, targetEventType: "acceptance.approved", requestedFieldPath, fieldPaths, priorPayloadSha256: prior, redactedPayloadSha256: redacted, reason, redactedAt: AT };
    return { nodeId, sequence: 1, logicalClock, eventType: "evidence.redacted", schemaVersion: 1, occurredAt: AT, actor: "op", causation: [], payload, payloadSha256: payloadSha256(payload) };
  };
  // Second link's node id sorts BEFORE the first link's, even though it is
  // causally later: ordering by nodeId would call this chain broken.
  const link1 = mkLink("ffffffff-0000-4000-8000-000000000001", 10, "evidence.a", ["evidence.a"], S0, S1, "r1");
  const link2 = mkLink("00000000-0000-4000-8000-000000000002", 20, "evidence.b", ["evidence.b"], S1, S2, "r2");
  const verified = verifyRedactions([targetEntry, link1, link2]);
  assert.deepEqual(verified.problems, [], JSON.stringify(verified.problems));
  assert.deepEqual(verified.unresolved, []);
});

// ---- review BAIXA-2: a string leaf that merely holds the sentinel with no
// audit record covering it is "unexplained", never reported as an audited
// redaction. ----

test("a sentinel value with no covering redaction event is unexplained, not reported as redacted", t => {
  const f = fixture(t);
  seed(f.handle);
  approve(f.handle, { shift: REDACTED_SENTINEL });
  const candidates = listRedactionCandidates(f.handle.db);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].unexplainedFieldPaths, ["evidence.shift"]);
  assert.deepEqual(candidates[0].redactedFieldPaths, []);
  assert.deepEqual(candidates[0].redactableFieldPaths, []);
  assert.ok(!JSON.stringify(candidates).includes(SECRET));
});

// ---- review BAIXA-3: completing a redaction that was pending from the
// crash window (event committed, journal file not yet rewritten) must
// reclaim database pages too, not only the live commit path. ----

test("reconciling a pending redaction from the ledger reclaims database pages, matching the live commit path", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  const targetPath = journalEntryPath(f.dir, target.nodeId, target.sequence);
  const plaintext = fs.readFileSync(targetPath);
  commit(f.handle, target);
  // Crash between the transaction commit and the target-file rename.
  fs.writeFileSync(targetPath, plaintext);
  assert.ok(fs.readFileSync(targetPath).includes(SECRET));

  const reconciled = reconcileRedactionsFromLedger(f.dir, f.handle.db);
  assert.deepEqual(reconciled.problems, []);
  assert.equal(reconciled.rewritten, 1);
  assert.equal(reconciled.reclaimed, true, reconciled.reclaimWarning);
  assert.deepEqual(journal(f.dir, target).payload.evidence, { shift: REDACTED_SENTINEL });
  assertAbsent(f.dir);
});

// ---- review MEDIA-6(a): a redaction target whose journal file is CORRUPT
// (exists, but does not parse) must never be adjudicated as absent -- a file
// that disagrees with itself is tampering/damage, exactly like the existing
// corrupt-payload-hash cases, and must fail closed the same way. ----

test("a corrupt redacted target journal file is a problem, never an absence; opening the store still fails closed", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  commit(f.handle, target);
  f.close();
  const targetPath = journalEntryPath(f.dir, target.nodeId, target.sequence);
  fs.writeFileSync(targetPath, fs.readFileSync(targetPath, "utf8").slice(0, 40)); // truncate -> invalid JSON

  const db = new DatabaseSync(StoreHandle.dbPathFor(f.dir));
  const verified = verifyRedactionsFromLedger(f.dir, db);
  db.close();
  assert.equal(verified.problems.length, 1, JSON.stringify(verified));
  assert.equal(verified.unresolved.length, 0, JSON.stringify(verified));
  assert.match(verified.problems[0].reason, /is corrupt/);

  let threw = "";
  try { StoreHandle.open(f.dir).close(); } catch (error) { threw = (error as Error).message; }
  assert.match(threw, /redaction verification failed/);
});

// ---- review MEDIA-6(b): the db-only branch's position gate must still
// refuse a row rolled back to its PRE-redaction payload even when that
// payload's own hash is internally consistent (so MEDIA-5's self-consistency
// check alone would pass it) -- the ledger says this row should be redacted,
// and it is not. ----

test("an attested DB-only row rolled back to its pre-redaction payload is refused by the position gate", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  const result = commit(f.handle, target);
  f.close();

  fs.rmSync(path.join(f.dir, "events", target.nodeId), { recursive: true, force: true });
  const db = new DatabaseSync(StoreHandle.dbPathFor(f.dir));
  db.exec(`UPDATE event_log SET journal_path = '' WHERE node_id = '${target.nodeId}'`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const options = { reason: "db-only", approvedBy: "reviewer" };
  const draft = draftNodeAttestation(f.dir, target.nodeId, options);
  commitNodeAttestation(f.dir, target.nodeId, draft.contentSha256, options);

  // Roll the row back to the PRE-redaction payload, with its own (internally
  // consistent) hash: MEDIA-5's self-consistency check alone would accept
  // this row, so the ledger-position gate has to be what refuses it.
  const original = { taskId: "T-001", revision: 1, criterionId: "c1", evidence: { shift: SECRET }, approvedAt: AT };
  const db2 = new DatabaseSync(StoreHandle.dbPathFor(f.dir));
  db2.prepare("UPDATE event_log SET payload_json = ?, payload_sha256 = ? WHERE node_id = ? AND sequence = ?")
    .run(JSON.stringify(original), result.plan.priorPayloadSha256, target.nodeId, target.sequence);
  db2.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db2.close();

  const db3 = new DatabaseSync(StoreHandle.dbPathFor(f.dir));
  const verified = verifyRedactionsFromLedger(f.dir, db3);
  db3.close();
  assert.equal(verified.problems.length, 1, JSON.stringify(verified).slice(0, 300));
  assert.match(verified.problems[0].reason, /pinned payload still carries content/);
  assert.ok(!JSON.stringify(verified).includes(SECRET));
});

// ---- review MEDIA-5: the indexed (DB-only) provenance gets the same
// self-consistency guarantee readJournalEntry already gives a journal file.
// A row whose payload_json does not hash to its own payload_sha256 is a
// CONTRADICTION, never an absence, and is pushed onto `problems`. ----

test("a DB-only row whose payload_json does not hash to its own payload_sha256 contradicts itself and fails closed", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  commit(f.handle, target);
  f.close();

  fs.rmSync(path.join(f.dir, "events", target.nodeId), { recursive: true, force: true });
  const options = { reason: "db-only", approvedBy: "reviewer" };
  const db = new DatabaseSync(StoreHandle.dbPathFor(f.dir));
  db.exec(`UPDATE event_log SET journal_path = '' WHERE node_id = '${target.nodeId}'`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const draft = draftNodeAttestation(f.dir, target.nodeId, options);
  commitNodeAttestation(f.dir, target.nodeId, draft.contentSha256, options);

  // Forge the row's bytes, keeping payload_sha256 at the previously recorded
  // (correct, redacted) hash: the stored hash no longer describes the stored
  // JSON, which is exactly the self-inconsistency readJournalEntry already
  // catches for journal files.
  const db2 = new DatabaseSync(StoreHandle.dbPathFor(f.dir));
  db2.prepare("UPDATE event_log SET payload_json = ? WHERE node_id = ? AND sequence = ?")
    .run(JSON.stringify({ taskId: "T-001", revision: 1, criterionId: "c1", evidence: { shift: "forged-content" }, approvedAt: AT }), target.nodeId, target.sequence);
  db2.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db2.close();

  const db3 = new DatabaseSync(StoreHandle.dbPathFor(f.dir));
  const verified = verifyRedactionsFromLedger(f.dir, db3);
  const needed = (() => {
    try { const h = StoreHandle.openReadOnly(f.dir); h.db.prepare("SELECT COUNT(*) FROM event_log").get(); const n = h.maintenanceNeeded(); h.close(); return n; }
    catch (error) { return (error as Error).message; }
  })();
  db3.close();
  assert.equal(verified.problems.length, 1, JSON.stringify(verified));
  assert.equal(verified.unresolved.length, 0, JSON.stringify(verified));
  assert.match(verified.problems[0].reason, /contradicts itself/);
  assert.match(String(needed), /redaction verification failed/);

  let threw = "";
  try { StoreHandle.open(f.dir).close(); } catch (error) { threw = (error as Error).message; }
  assert.match(threw, /redaction verification failed/);
  assert.equal(repairStore(f.dir).status, "gap");
});

// ---- T-131: receipt.failure.message, receipt.changedFiles and run event
// payloads are the three free-text sinks the T-126 review left out of scope.
// ----

function withDispatch(handle: StoreHandle): void {
  seed(handle);
  assert.ok(claimTask(handle, { taskId: "T-001", actor: "test" }).ok);
  assert.ok(recordDispatchAttempt(handle, {
    dispatchId: DISPATCH_ID, taskId: "T-001", executorKind: "test", attempt: 1, contextHash: "hash", status: "claimed"
  }, "test").ok);
}

test("receipt.failure.message and individual changedFiles elements are redactable; category/retryable/outcome are not", t => {
  const f = fixture(t);
  withDispatch(f.handle);
  const receipt = {
    schemaVersion: 1, dispatchId: DISPATCH_ID, attempt: 1, outcome: "failed", startedAt: AT, endedAt: "2026-10-09T10:05:00.000Z",
    changedFiles: ["src/ok.ts", `clients/${OTHER_SECRET}/report.md`], usageEvents: [], evidence: [],
    failure: { category: "executor-error", message: `boom while handling ${SECRET}`, retryable: true }
  };
  const target = f.handle.appendEvent({ eventType: "run.receipt-recorded", actor: "test", payload: { receipt } });

  // Order is grouped by REDACTABLE_ROOTS declaration order, leaves sorted
  // within each root -- deterministic, not alphabetical across roots.
  const candidates = listRedactionCandidates(f.handle.db);
  assert.deepEqual(candidates[0].redactableFieldPaths, ["receipt.failure.message", "receipt.changedFiles.0", "receipt.changedFiles.1"]);
  assert.ok(!JSON.stringify(candidates).includes(SECRET) && !JSON.stringify(candidates).includes(OTHER_SECRET));

  const refusedEnum = redactEvidence(f.handle, { target, fieldPath: "receipt.failure.category", reason: "x", actor: "dpo", commit: true });
  assert.ok(!refusedEnum.ok);
  assert.equal(refusedEnum.reason, "not-redactable");
  // retryable is a boolean, not a string leaf at all, so the refusal is
  // "nothing-to-redact" (no string content), not "not-redactable" -- the
  // leaf allowlist is never even consulted for a non-string value.
  const refusedBool = redactEvidence(f.handle, { target, fieldPath: "receipt.failure.retryable", reason: "x", actor: "dpo", commit: true });
  assert.ok(!refusedBool.ok);
  assert.equal(refusedBool.reason, "nothing-to-redact");
  const refusedOutcome = redactEvidence(f.handle, { target, fieldPath: "receipt.outcome", reason: "x", actor: "dpo", commit: true });
  assert.ok(!refusedOutcome.ok);
  assert.equal(refusedOutcome.reason, "not-redactable");

  const r1 = commit(f.handle, target, "receipt.failure");
  assert.deepEqual(r1.plan.fieldPaths, ["receipt.failure.message"]);
  const r2 = commit(f.handle, target, "receipt.changedFiles.1", "second removal");
  assert.deepEqual(r2.plan.fieldPaths, ["receipt.changedFiles.1"]);

  const expected = {
    ...receipt,
    changedFiles: ["src/ok.ts", REDACTED_SENTINEL],
    failure: { category: "executor-error", message: REDACTED_SENTINEL, retryable: true }
  };
  const entry = journal(f.dir, target);
  assert.deepEqual(entry.payload.receipt, expected);
  assert.ok(runReceiptSchema.safeParse(expected).success, "a redacted receipt remains schema-valid");
  // The untouched sibling element survives verbatim.
  assert.equal(entry.payload.receipt.changedFiles[0], "src/ok.ts");

  const row = f.handle.db.prepare(
    "SELECT changed_files_json, failure_json, receipt_json FROM run_receipt_projection WHERE dispatch_id = ? AND attempt = 1"
  ).get(DISPATCH_ID) as { changed_files_json: string; failure_json: string; receipt_json: string };
  assert.equal(canonicalJson(JSON.parse(row.changed_files_json)), canonicalJson(expected.changedFiles));
  assert.equal(canonicalJson(JSON.parse(row.failure_json)), canonicalJson(expected.failure));
  assert.equal(canonicalJson(JSON.parse(row.receipt_json)), canonicalJson(expected));

  assertAbsent(f.dir);
  assertAbsent(f.dir, OTHER_SECRET);
  f.close();
  assert.equal(repairStore(f.dir).status, "ok");
  f.open();
  assert.deepEqual(getRunReceipt(f.handle.db, DISPATCH_ID, 1)!.changedFiles, expected.changedFiles);
  assert.deepEqual(getRunReceipt(f.handle.db, DISPATCH_ID, 1)!.failure, expected.failure);
  assertAbsent(f.dir);
  assertAbsent(f.dir, OTHER_SECRET);
});

test("receipt.failure_json must be scrubbed too, not only receipt_json -- a self-consistent edit of a redacted failure still refuses open and repair", t => {
  const f = fixture(t);
  withDispatch(f.handle);
  const receipt = {
    schemaVersion: 1, dispatchId: DISPATCH_ID, attempt: 1, outcome: "failed", startedAt: AT, endedAt: "2026-10-09T10:05:00.000Z",
    changedFiles: ["a.ts"], usageEvents: [], evidence: [],
    failure: { category: "timeout", message: SECRET, retryable: false }
  };
  const target = f.handle.appendEvent({ eventType: "run.receipt-recorded", actor: "test", payload: { receipt } });
  commit(f.handle, target, "receipt.failure");
  // The column-level scrub (failure_json) is what A9/A10 of the probe checks
  // directly; here the end-to-end guarantee is that no projection column, not
  // just the journal, ever holds the plaintext.
  const row = f.handle.db.prepare("SELECT failure_json FROM run_receipt_projection WHERE dispatch_id = ? AND attempt = 1").get(DISPATCH_ID) as { failure_json: string };
  assert.ok(!row.failure_json.includes(SECRET));
  f.close();

  const p = journalEntryPath(f.dir, target.nodeId, target.sequence);
  const entry = JSON.parse(fs.readFileSync(p, "utf8"));
  entry.payload.receipt.failure.message = "rewritten-after-the-fact";
  entry.payloadSha256 = payloadSha256(entry.payload);
  fs.writeFileSync(p, JSON.stringify(entry));
  let threw = "";
  try { StoreHandle.open(f.dir).close(); } catch (error) { threw = (error as Error).message; }
  assert.match(threw, /redaction verification failed/);
  assert.equal(repairStore(f.dir).status, "gap");
});

test("a run event's open payload is redactable leaf-by-leaf; dispatchId/attempt/sequence/type/timestamp are not", t => {
  const f = fixture(t);
  withDispatch(f.handle);
  const event: RunEvent = {
    schemaVersion: 1, dispatchId: DISPATCH_ID, attempt: 1, sequence: 0, type: "progress", timestamp: AT,
    payload: { note: `retrying for ${SECRET}`, nested: { detail: OTHER_SECRET }, count: 3 }
  };
  const written = recordRunEvent(f.handle, event, "test");
  assert.ok(written.ok, JSON.stringify(written));
  const seq = (f.handle.db.prepare("SELECT MAX(sequence) m FROM event_log").get() as { m: number }).m;
  const target: RedactionTarget = { nodeId: f.handle.nodeId, sequence: seq };

  const candidates = listRedactionCandidates(f.handle.db).filter(c => c.eventType === "run.event-recorded");
  assert.deepEqual(candidates[0].redactableFieldPaths, ["event.payload.nested.detail", "event.payload.note"]);
  assert.equal(candidates[0].subject, DISPATCH_ID);
  assert.ok(!JSON.stringify(candidates).includes(SECRET) && !JSON.stringify(candidates).includes(OTHER_SECRET));

  for (const fieldPath of ["event.dispatchId", "event.attempt", "event.sequence", "event.type", "event.timestamp"]) {
    const refused = redactEvidence(f.handle, { target, fieldPath, reason: "x", actor: "dpo", commit: true });
    assert.ok(!refused.ok, fieldPath);
    assert.equal(refused.reason, "not-redactable", fieldPath);
  }

  const r = commit(f.handle, target, "event.payload");
  assert.deepEqual(r.plan.fieldPaths, ["event.payload.nested.detail", "event.payload.note"]);

  const expectedEvent = { ...event, payload: { note: REDACTED_SENTINEL, nested: { detail: REDACTED_SENTINEL }, count: 3 } };
  assert.deepEqual(journal(f.dir, target).payload.event, expectedEvent);
  assert.ok(runEventSchema.safeParse(expectedEvent).success, "a redacted run event remains schema-valid");

  const row = f.handle.db.prepare(
    "SELECT payload_json, event_json FROM run_event_projection WHERE dispatch_id = ? AND attempt = 1 AND sequence = 0"
  ).get(DISPATCH_ID) as { payload_json: string; event_json: string };
  assert.equal(canonicalJson(JSON.parse(row.payload_json)), canonicalJson(expectedEvent.payload));
  assert.equal(canonicalJson(JSON.parse(row.event_json)), canonicalJson(expectedEvent));
  assert.equal((JSON.parse(row.payload_json) as { count: number }).count, 3, "a non-string payload member survives untouched");

  assertAbsent(f.dir);
  assertAbsent(f.dir, OTHER_SECRET);
  f.close();
  assert.equal(repairStore(f.dir).status, "ok");
  f.open();
  assert.deepEqual(getRunEvent(f.handle.db, DISPATCH_ID, 1, 0)!.payload, expectedEvent.payload);
  assert.equal(verifyRedactionsFromLedger(f.dir, f.handle.db).problems.length, 0);
  assertAbsent(f.dir);
  assertAbsent(f.dir, OTHER_SECRET);
});

// MÉDIA-1 (carried forward): isRedactableFieldPath must agree, leaf by leaf,
// with what redactEvidence actually accepts -- otherwise the lint can promise
// a cure on a structural neighbour again, exactly the T-126 bug this closes.
test("isRedactableFieldPath agrees leaf-by-leaf with redactEvidence for every T-131 root", () => {
  assert.ok(isRedactableFieldPath("run.receipt-recorded", "receipt.failure.message"));
  assert.ok(!isRedactableFieldPath("run.receipt-recorded", "receipt.failure.category"));
  assert.ok(!isRedactableFieldPath("run.receipt-recorded", "receipt.failure.retryable"));
  assert.ok(isRedactableFieldPath("run.receipt-recorded", "receipt.changedFiles.0"));
  assert.ok(isRedactableFieldPath("run.event-recorded", "event.payload.note"));
  assert.ok(!isRedactableFieldPath("run.event-recorded", "event.dispatchId"));
  assert.ok(!isRedactableFieldPath("run.event-recorded", "event.timestamp"));
  // ArtifactRef rules from T-126 are unchanged by the T-131 reshaping of
  // REDACTABLE_LEAVES into a per-root map.
  assert.ok(isRedactableFieldPath("run.receipt-recorded", "receipt.evidence.0.uri"));
  assert.ok(!isRedactableFieldPath("run.receipt-recorded", "receipt.evidence.0.artifactId"));
  assert.ok(!isRedactableFieldPath("run.receipt-recorded", "receipt.outcome"));
  assert.ok(!isRedactableFieldPath("acceptance.approved", "criterionId"));
});

// ---- review BAIXA-7: an attestation file that cannot be PARSED is a
// different condition from "no attestation covers this node", and the
// advisory must name the read failure, not misdirect the operator. ----

test("a malformed attestation file surfaces as a named read failure in the advisory, never as a missing attestation", t => {
  const f = fixture(t);
  seed(f.handle);
  const target = approve(f.handle);
  commit(f.handle, target);
  const node = target.nodeId;
  f.close();

  fs.rmSync(path.join(f.dir, "events", node), { recursive: true, force: true });
  const db = new DatabaseSync(StoreHandle.dbPathFor(f.dir));
  db.exec(`UPDATE event_log SET journal_path = '' WHERE node_id = '${node}'`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  fs.writeFileSync(path.join(f.dir, "node-attestations.json"), "{ this is not json");

  const ro = f.open(true);
  ro.db.prepare("SELECT COUNT(*) FROM event_log").get();
  const advisory = ro.maintenanceAdvisory();
  assert.equal(advisory.length, 1, JSON.stringify(advisory));
  assert.match(advisory[0], /attestation file could not be read/);
  assert.ok(!/no reviewed attestation covers this node/.test(advisory[0]), advisory[0]);
  assert.equal(ro.maintenanceNeeded(), null, "an unreadable attestation file must not brick the open");
  assert.ok(!advisory.join("|").includes(SECRET));
  f.close();
});

// ---- T-131 attempt 2 (review ALTO-1): receipt.changedFiles has a CONSUMER
// the T-131 design did not consider -- T-061 claim-violation detection
// derives a third copy of the path into claim-violation.detected. Redacting
// the receipts must not leave that copy behind, and must tell the operator
// about it both on dry-run and on commit. ----

function seedTwoTasks(handle: StoreHandle): void {
  handle.appendEvent({
    eventType: "project.initialized", actor: "test",
    payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" }
  });
  for (const taskId of ["T-001", "T-002"]) {
    handle.appendEvent({
      eventType: "task.upserted", actor: "test",
      payload: { task: {
        taskId, positionKey: Number(taskId.slice(-1)), title: taskId, planningState: "in-progress", executionState: "unclaimed",
        tags: [], domains: [], externalLinks: [], assignees: []
      } }
    });
  }
}

function dispatchAndReceipt(handle: StoreHandle, taskId: string, dispatchId: string, changedFiles: string[]): void {
  assert.ok(recordDispatchAttempt(handle, { dispatchId, taskId, executorKind: "test", attempt: 1, contextHash: "h", status: "claimed", actor: "test" }).ok);
  assert.ok(recordRunReceipt(handle, {
    schemaVersion: 1, dispatchId, attempt: 1, outcome: "completed", startedAt: AT, endedAt: "2026-10-10T06:01:00.000Z",
    changedFiles, usageEvents: [], evidence: [], failure: null
  }, "test").ok);
}

function violationWavePlan(waveId: string, dispatchA: string, dispatchB: string): {
  waves: { waveId: string; dispatches: { waveId: string; dispatchId: string; attempt: number; taskId: string }[] }[];
  claims: never[]; detectedAt: string;
} {
  return {
    waves: [{ waveId, dispatches: [
      { waveId, dispatchId: dispatchA, attempt: 1, taskId: "T-001" },
      { waveId, dispatchId: dispatchB, attempt: 1, taskId: "T-002" }
    ] }],
    claims: [], detectedAt: AT
  };
}

function receiptTarget(handle: StoreHandle, dispatchId: string): RedactionTarget {
  const row = handle.db.prepare("SELECT node_id, sequence FROM event_log WHERE event_type = 'run.receipt-recorded' AND payload_json LIKE ? ORDER BY sequence")
    .get(`%${dispatchId}%`) as { node_id: string; sequence: number };
  return { nodeId: row.node_id, sequence: row.sequence };
}

test("ALTO-1: redacting both receipts' changedFiles does not reach the derived claim-violation.detected copy; the advisory finishes the job", t => {
  const f = fixture(t);
  seedTwoTasks(f.handle);
  const dispatchA = "11111111-0000-5000-8000-000000000001";
  const dispatchB = "11111111-0000-5000-8000-000000000002";
  const waveId = "11111111-0000-5000-8000-000000000003";
  const SECRET_PATH = "src/acme-bank-prod/shift-998877.ts";
  dispatchAndReceipt(f.handle, "T-001", dispatchA, ["src/common.ts", SECRET_PATH]);
  dispatchAndReceipt(f.handle, "T-002", dispatchB, ["src/common.ts", SECRET_PATH]);
  const detected = recordClaimViolations(f.handle, violationWavePlan(waveId, dispatchA, dispatchB));
  assert.equal(detected.length, 2, JSON.stringify(detected.map(v => v.path)));
  assert.ok(detected.some(v => v.path === SECRET_PATH));

  const t1 = receiptTarget(f.handle, dispatchA);
  const dry = redactEvidence(f.handle, { target: t1, fieldPath: "receipt.changedFiles", reason: "LGPD T-131", actor: "dpo", commit: false });
  assert.ok(dry.ok);
  assert.ok(dry.mode === "dry-run");
  // Both of T-001's paths collided, so detection wrote TWO derived copies;
  // redacting the whole root destroys both sources, so both are reported.
  assert.equal(dry.derivedCopies.length, 2, JSON.stringify(dry.derivedCopies));
  assert.ok(dry.derivedCopies.every(c => c.eventType === "claim-violation.detected" && c.fieldPath === "violation.path"));
  assert.ok(dry.advisories.some(a => /claim-violation\.detected event\(s\) hold a DERIVED copy/.test(a) && /--field violation\.path/.test(a)), JSON.stringify(dry.advisories));
  assert.ok(dry.advisories.some(a => /INCOMPLETE/.test(a) && /T-061/.test(a)), JSON.stringify(dry.advisories));
  assert.ok(!JSON.stringify(dry).includes(SECRET_PATH) && !JSON.stringify(dry).includes("acme-bank"), "the advisory must never echo the path");

  const r1 = redactEvidence(f.handle, { target: t1, fieldPath: "receipt.changedFiles", reason: "LGPD T-131", actor: "dpo", commit: true });
  const r2 = redactEvidence(f.handle, { target: receiptTarget(f.handle, dispatchB), fieldPath: "receipt.changedFiles", reason: "LGPD T-131", actor: "dpo", commit: true });
  assert.ok(r1.ok && r2.ok);
  assert.ok(r1.ok && r1.mode === "commit");
  assert.ok(r1.derivedCopies.length === 2 && r1.advisories.length >= 2, JSON.stringify(r1.advisories));
  // Before the derived redaction, the plaintext genuinely is still there --
  // this is the bug the review found: the receipts report success while a
  // third copy of the path survives.
  assertPresent(f.dir, SECRET_PATH);

  const offered = listRedactionCandidates(f.handle.db).filter(c => c.eventType === "claim-violation.detected");
  assert.equal(offered.length, 2, JSON.stringify(offered));
  assert.ok(offered.every(c => c.redactableFieldPaths.includes("violation.path")));
  assert.ok(!JSON.stringify(offered).includes(SECRET_PATH));
  assert.ok(listRedactionCandidates(f.handle.db, { taskId: "T-002" }).some(c => c.eventType === "claim-violation.detected"), "--task must find a violation under EITHER party");

  // Finish the job the advisory described: every derived copy, not just the
  // one that happened to be listed first.
  assert.ok(r1.ok && r1.mode === "commit");
  const applied = r1.derivedCopies.map(derived =>
    redactEvidence(f.handle, { target: { nodeId: derived.nodeId, sequence: derived.sequence }, fieldPath: "violation.path", reason: "LGPD T-131", actor: "dpo", commit: true }));
  assert.ok(applied.every(result => result.ok === true), JSON.stringify(applied.map(result => result.ok ? "ok" : result.reason)));
  assertAbsent(f.dir, SECRET_PATH);
  assert.equal(f.handle.db.prepare("SELECT COUNT(*) c FROM claim_violation_projection WHERE path = ?").get(SECRET_PATH)!.c, 0);

  // Redacting the whole root destroyed BOTH source paths on each receipt, so
  // both derived rows are sentinel now. The rows still exist with their
  // structure intact and each still parses as a ClaimViolation.
  const rows = listClaimViolations(f.handle.db);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.path, REDACTED_SENTINEL);
    assert.equal(row.kind, "collision");
    assert.equal(row.taskAId, "T-001");
    assert.equal(row.taskBId, "T-002");
    assert.ok(claimViolationSchema.safeParse(row).success, JSON.stringify(row));
  }
  f.close();
  assert.equal(repairStore(f.dir).status, "ok");
  f.open();
  assertAbsent(f.dir, SECRET_PATH);
  f.close();
});

// ---- T-131 attempt 2: post-redaction schema guard. The allowlists were
// structural with no runtime anchor; a future root that would break its own
// schema must be refused at commit time, not merely by convention. ----

test("a redaction that would leave its payload invalid against its own published schema is refused, named, and applies nothing", t => {
  const f = fixture(t);
  seedTwoTasks(f.handle);
  const dispatchA = "22222222-0000-5000-8000-000000000001";
  dispatchAndReceipt(f.handle, "T-001", dispatchA, ["src/x.ts"]);
  const target = receiptTarget(f.handle, dispatchA);

  // A synthetic future root whose redaction WOULD break the receipt schema:
  // runOutcomeSchema is a closed enum, so sentinel-ing it invalidates the
  // RunReceipt. Restored in `finally` regardless of outcome.
  const roots = REDACTABLE_ROOTS["run.receipt-recorded"] as unknown as string[];
  roots.push("receipt.outcome");
  try {
    const result = redactEvidence(f.handle, { target, fieldPath: "receipt.outcome", reason: "x", actor: "dpo", commit: true });
    assert.ok(!result.ok);
    assert.equal(result.reason, "schema-invalid");
    assert.match(result.message, /invalid against its own schema/);
    assert.equal(f.handle.db.prepare("SELECT COUNT(*) c FROM event_log WHERE event_type = 'evidence.redacted'").get()!.c, 0);
  } finally {
    roots.pop();
  }

  // The legitimate roots still commit after the guard refuses the synthetic one.
  const legit = redactEvidence(f.handle, { target, fieldPath: "receipt.changedFiles", reason: "x", actor: "dpo", commit: true });
  assert.ok(legit.ok);
  assert.ok(legit.mode === "commit");
});
