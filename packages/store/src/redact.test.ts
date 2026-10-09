import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import * as fs from "fs"
import * as path from "path"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { canonicalJson, runReceiptSchema, type EventLogEntry } from "@mapctx/protocol"
import { commitNodeAttestation, draftNodeAttestation, loadNodeAttestations } from "./attestation"
import { claimTask } from "./claims"
import { recordDispatchAttempt } from "./dispatch"
import { journalEntryPath, payloadSha256, readJournalEntry } from "./journal"
import { getAcceptance, getRunReceipt, listHistoryEvidence, listRedactions } from "./projections"
import {
  listRedactionCandidates, reconcileRedactionsFromLedger, redactEvidence, REDACTED_SENTINEL,
  verifyRedactions, verifyRedactionsFromLedger, type RedactionCommitResult, type RedactionTarget
} from "./redact"
import { repairStore } from "./repair"
import { StoreHandle } from "./store-handle"
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
  assert.deepEqual(candidates[0].redactableFieldPaths, ["receipt.evidence.0.promotedPath", "receipt.evidence.0.uri"]);
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

  const ro = f.open(true);
  ro.db.prepare("SELECT COUNT(*) FROM event_log").get();
  assert.equal(ro.maintenanceNeeded(), null);
  assert.deepEqual(ro.maintenanceAdvisory(), [], "a redacted DB-only row holding the final state verifies cleanly");
  f.close();

  const options = { reason: "lost machine; rows are DB-only", approvedBy: "reviewer" };
  const draft = draftNodeAttestation(f.dir, node, options);
  commitNodeAttestation(f.dir, node, draft.contentSha256, options);
  assert.ok(loadNodeAttestations(f.dir).has(node));

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
