import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as path from "path"
import { repairStore } from "./repair"
import {
  attestationContentSha256,
  attestationFilePath,
  commitNodeAttestation,
  draftNodeAttestation,
  loadNodeAttestations,
  verifyAttestationAgainstDb,
  verifyRowPayloadHash
} from "./attestation"
import { StoreHandle } from "./store-handle"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

/**
 * T-119 fixtures: a store with one DB-only node. The row mirrors the real
 * orphan shape (task.patched with journal_path "" and a compact-JSON payload
 * hash from the historical writer), inserted directly into event_log because
 * that is exactly what the anomalous writer did.
 */
const ORPHAN_NODE = "23224427-9da8-458b-ab90-18ebadbb8613"

function seed(handle: StoreHandle): void {
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
        positionKey: 1,
        title: "task 1",
        planningState: "backlog",
        executionState: "unclaimed",
        tags: [],
        domains: [],
        externalLinks: [],
        assignees: []
      }
    }
  });
}

function insertOrphanRow(dir: string, rowOverrides?: Partial<Record<string, unknown>>): void {
  const { openDatabase } = require("./db") as typeof import("./db");
  const payload = { taskId: "T-001", patch: { planningState: "in-progress", updatedOn: "2026-09-27" }, source: "reopen" };
  const payloadJson = JSON.stringify(payload);
  const compactHash = require("crypto").createHash("sha256").update(payloadJson, "utf8").digest("hex");
  const row = {
    node_id: ORPHAN_NODE,
    sequence: 3,
    logical_clock: 3,
    event_type: "task.patched",
    schema_version: 1,
    occurred_at: "2026-09-27T18:51:48.242Z",
    actor: "traycer",
    causation_json: "[]",
    payload_json: payloadJson,
    payload_sha256: compactHash,
    journal_path: "",
    ...rowOverrides
  };
  const db = openDatabase(StoreHandle.dbPathFor(dir));
  try {
    db.prepare(`
      INSERT INTO event_log (node_id, sequence, logical_clock, event_type, schema_version, occurred_at,
        actor, causation_json, payload_json, payload_sha256, journal_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(row.node_id),
      Number(row.sequence),
      Number(row.logical_clock),
      String(row.event_type),
      Number(row.schema_version),
      String(row.occurred_at),
      String(row.actor),
      String(row.causation_json),
      String(row.payload_json),
      String(row.payload_sha256),
      String(row.journal_path)
    );
  } finally {
    db.close();
  }
}

const REASON = "test: DB-only node with compact-legacy payload hash, reviewed evidence";

function draftOptions() {
  return { reason: REASON, evidence: { doc: "docs/reviews/test.md" }, approvedBy: "reviewer" };
}

test("attestation draft refuses nodes that are not DB-only", () => {
  const dir = mkTmpDir("mapctx-attest-not-dbonly-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    const mainNode = handle.nodeId;
    handle.close();
    assert.throws(() => draftNodeAttestation(dir, mainNode, draftOptions()), /not DB-only/);
    assert.throws(() => draftNodeAttestation(dir, "00000000-0000-4000-8000-000000000000", draftOptions()), /no rows in event_log/);
  } finally {
    cleanupDir(dir);
  }
});

test("attestation draft verifies payload hashes under both documented schemes and pins exact bytes", () => {
  const dir = mkTmpDir("mapctx-attest-draft-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);

    const draft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    assert.equal(draft.attestation.nodeId, ORPHAN_NODE);
    assert.equal(draft.attestation.rows.length, 1);
    assert.equal(draft.attestation.rows[0].journal_path, "");
    assert.equal(draft.attestation.rows[0].sequence, 3);
    // content hash covers rows+reason+evidence, not commit-time metadata
    const draft2 = draftNodeAttestation(dir, ORPHAN_NODE, { ...draftOptions(), now: () => new Date(Date.now() + 60000) });
    assert.equal(draft.contentSha256, draft2.contentSha256);
    // different reason -> different token
    const draft3 = draftNodeAttestation(dir, ORPHAN_NODE, { ...draftOptions(), reason: REASON + "x" });
    assert.notEqual(draft.contentSha256, draft3.contentSha256);
  } finally {
    cleanupDir(dir);
  }
});

test("attestation commit requires the exact reviewed token and is duplicate-safe", () => {
  const dir = mkTmpDir("mapctx-attest-commit-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);
    const draft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());

    assert.throws(
      () => commitNodeAttestation(dir, ORPHAN_NODE, "0".repeat(64), draftOptions()),
      /Approval hash mismatch/
    );
    assert.equal(fs.existsSync(attestationFilePath(dir)), false);

    const result = commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions());
    assert.equal(result.attestation.nodeId, ORPHAN_NODE);
    assert.equal(result.contentSha256, draft.contentSha256);

    // same-pin duplicate is now an idempotent re-confirmation (conserves metadata)
    const again = commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions());
    assert.equal(again.attestation.attestedAt, result.attestation.attestedAt);
    // divergent-content duplicate still refuses (matching token, different content)
    const amended = draftNodeAttestation(dir, ORPHAN_NODE, { ...draftOptions(), reason: draftOptions().reason + " v2" });
    assert.throws(
      () => commitNodeAttestation(dir, ORPHAN_NODE, amended.contentSha256, { ...draftOptions(), reason: draftOptions().reason + " v2" }),
      /different reviewed content/
    );
    const loaded = loadNodeAttestations(dir);
    assert.equal(loaded.size, 1);
  } finally {
    cleanupDir(dir);
  }
});

test("malformed attestation files are a loud failure, never silently ignored", () => {
  const dir = mkTmpDir("mapctx-attest-malformed-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);
    fs.writeFileSync(attestationFilePath(dir), "{not json");
    assert.throws(() => loadNodeAttestations(dir), /Malformed attestation/);
    assert.throws(() => repairStore(dir), /Malformed attestation/);

    // structurally valid JSON but internally inconsistent content:
    // (a) hash-consistent rows + stale approval token -> refused at load
    const payloadJson = "{}";
    const payloadHash = require("crypto").createHash("sha256").update(payloadJson, "utf8").digest("hex");
    const fixture = (contentSha256: string) => ({
      attestations: [{
        schemaVersion: 1,
        nodeId: ORPHAN_NODE,
        rows: [{ node_id: ORPHAN_NODE, sequence: 3, logical_clock: 3, event_type: "task.patched", schema_version: 1, occurred_at: "2026-09-27T18:51:48.242Z", actor: "y", causation_json: "[]", payload_json: payloadJson, payload_sha256: payloadHash, journal_path: "" }],
        reason: "r",
        evidence: {},
        contentSha256,
        attestedAt: "now",
        approvedBy: "a"
      }]
    });
    fs.writeFileSync(attestationFilePath(dir), JSON.stringify(fixture("0".repeat(64))));
    assert.throws(() => loadNodeAttestations(dir), /contentSha256 mismatch/);
    // (b) recomputed token over tampered rows -> per-row payload hash check catches it
    const tampered = fixture(attestationContentSha256(fixture("x").attestations[0]));
    (tampered.attestations[0].rows[0] as { payload_json: string }).payload_json = '{"tampered":true}';
    fs.writeFileSync(attestationFilePath(dir), JSON.stringify(tampered));
    assert.throws(() => loadNodeAttestations(dir), /payload hash mismatch/);
  } finally {
    cleanupDir(dir);
  }
});

test("verifyRowPayloadHash accepts canonical and compact-legacy schemes only", () => {
  const payload = { taskId: "T-001", patch: { planningState: "in-progress", updatedOn: "2026-09-27" }, source: "reopen" };
  const compact = require("crypto").createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  assert.equal(verifyRowPayloadHash({ payload_json: JSON.stringify(payload), payload_sha256: compact }).scheme, "compact-legacy");
  // canonical round-trip through the store's own writer
  const dir = mkTmpDir("mapctx-attest-scheme-");
  try {
    const h = StoreHandle.open(dir);
    h.appendEvent({
      eventType: "project.initialized",
      actor: "t",
      payload: { projectId: "p-scheme", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" }
    });
    h.close();
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(StoreHandle.dbPathFor(dir), { readOnly: true });
    const row = db.prepare("SELECT payload_json, payload_sha256 FROM event_log WHERE sequence = 1").get() as { payload_json: string; payload_sha256: string };
    db.close();
    assert.equal(verifyRowPayloadHash(row).scheme, "canonical");
  } finally {
    cleanupDir(dir);
  }
  assert.throws(() => verifyRowPayloadHash({ payload_json: "{}", payload_sha256: "0".repeat(64) }), /every documented scheme/);
});

test("repair refuses a DB-only node without an attestation and leaves the database untouched", () => {
  const dir = mkTmpDir("mapctx-attest-repair-gap-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);
    const before = fs.readFileSync(StoreHandle.dbPathFor(dir));
    const result = repairStore(dir);
    assert.equal(result.status, "gap");
    if (result.status === "gap") {
      assert.deepEqual(result.gaps.map(g => [g.nodeId, g.sequence, g.reason]), [[ORPHAN_NODE, 1, "missing journal file"]]);
    }
    assert.deepEqual(fs.readFileSync(StoreHandle.dbPathFor(dir)), before);
  } finally {
    cleanupDir(dir);
  }
});

test("repair replays attested DB-only rows byte-exactly and treats the absent prefix as declared", () => {
  const dir = mkTmpDir("mapctx-attest-repair-ok-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);
    const draft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions());
    const orphanBefore = readOrphanRows(dir);

    const result = repairStore(dir);
    assert.equal(result.status, "ok");
    if (result.status === "ok") assert.equal(result.eventsReplayed, 3);

    const orphanAfter = readOrphanRows(dir);
    assert.deepEqual(orphanAfter, orphanBefore); // byte-identical rows, incl. journal_path ""
    const reopened = StoreHandle.open(dir);
    // the attested task.patched projected: T-001 moved to in-progress
    const task = reopened.db.prepare("SELECT planning_state FROM task_projection WHERE task_id = 'T-001'").get() as { planning_state: string };
    reopened.close();
    assert.equal(task.planning_state, "in-progress");

    // deterministic: a second repair is ok and keeps the rows byte-identical
    const result2 = repairStore(dir);
    assert.equal(result2.status, "ok");
    assert.deepEqual(readOrphanRows(dir), orphanBefore);
  } finally {
    cleanupDir(dir);
  }
});

test("repair fails closed when an intact database drifts from, loses, or gains attested rows", () => {
  const dir = mkTmpDir("mapctx-attest-repair-drift-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);
    const draft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions());

    // drift: mutate the attested row's occurred_at in place
    {
      const { openDatabase } = require("./db") as typeof import("./db");
      const db = openDatabase(StoreHandle.dbPathFor(dir));
      try { db.prepare("UPDATE event_log SET occurred_at = ? WHERE node_id = ?").run("2026-09-27T18:51:48.999Z", ORPHAN_NODE); } finally { db.close(); }
    }
    const drifted = repairStore(dir);
    assert.equal(drifted.status, "gap");
    if (drifted.status === "gap") assert.match(drifted.gaps[0].reason, /drifted from the attested value/);

    // loss: zero rows for the attested node in an intact database
    {
      const { openDatabase } = require("./db") as typeof import("./db");
      const db = openDatabase(StoreHandle.dbPathFor(dir));
      try { db.prepare("DELETE FROM event_log WHERE node_id = ?").run(ORPHAN_NODE); } finally { db.close(); }
    }
    const lost = repairStore(dir);
    assert.equal(lost.status, "gap");
    if (lost.status === "gap") assert.match(lost.gaps[0].reason, /no rows in the intact database/);

    // additions beyond the attestation
    insertOrphanRow(dir); // re-insert original
    insertOrphanRow(dir, { sequence: 4, logical_clock: 4, occurred_at: "2026-09-27T19:00:00.000Z" });
    const added = repairStore(dir);
    assert.equal(added.status, "gap");
    if (added.status === "gap") assert.match(added.gaps[0].reason, /database holds 2 row\(s\), attestation pins 1/);
  } finally {
    cleanupDir(dir);
  }
});

test("repair refuses unexpected journal data on an attested DB-only node", () => {
  const dir = mkTmpDir("mapctx-attest-repair-journal-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);
    const draft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions());
    fs.mkdirSync(path.join(dir, "events", ORPHAN_NODE), { recursive: true });
    fs.writeFileSync(path.join(dir, "events", ORPHAN_NODE, "1.json"), "{}");
    const result = repairStore(dir);
    assert.equal(result.status, "gap");
    if (result.status === "gap") assert.match(result.gaps[0].reason, /unexpected journal data/);
  } finally {
    cleanupDir(dir);
  }
});

test("repair restores attested rows from the attestation alone when the database is corrupt", () => {
  const dir = mkTmpDir("mapctx-attest-repair-corrupt-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);
    const draft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions());
    const orphanBefore = readOrphanRows(dir);

    fs.writeFileSync(StoreHandle.dbPathFor(dir), "NOT A SQLITE FILE");
    const result = repairStore(dir);
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.dbWasCorrupt, true);
      assert.equal(result.eventsReplayed, 3);
    }
    assert.deepEqual(readOrphanRows(dir), orphanBefore);
    assert.equal(verifyAttestationAgainstDb(dir, draft.attestation), null);
  } finally {
    cleanupDir(dir);
  }
});

test("an unattested new DB-only node still fails repair closed after another node is attested", () => {
  const dir = mkTmpDir("mapctx-attest-repair-neworphan-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);
    const draft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions());
    insertOrphanRow(dir, { node_id: "99999999-1111-4222-8333-444444444444", sequence: 9, logical_clock: 9, occurred_at: "2026-10-01T00:00:00.000Z" });
    const result = repairStore(dir);
    assert.equal(result.status, "gap");
    if (result.status === "gap") {
      assert.ok(result.gaps.some(g => g.nodeId === "99999999-1111-4222-8333-444444444444" && g.reason === "missing journal file"));
    }
  } finally {
    cleanupDir(dir);
  }
});

function readOrphanRows(dir: string): unknown {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(StoreHandle.dbPathFor(dir), { readOnly: true });
  try {
    return db.prepare("SELECT * FROM event_log WHERE node_id = ? ORDER BY sequence").all(ORPHAN_NODE);
  } finally {
    db.close();
  }
}

test("approval publishes an independent witness and refuses to run without it", () => {
  const dir = mkTmpDir("mapctx-attest-witness-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);
    const draft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions());
    // witness == last attested sequence, other meta fields preserved
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "store-meta.json"), "utf8"));
    assert.equal(meta.sequenceWatermarks[ORPHAN_NODE], 3);
    assert.ok(meta.nodeId && meta.incarnationId && meta.createdAt);

    // file loss + corrupt DB -> named gap via the witness, never silent loss
    fs.rmSync(attestationFilePath(dir));
    fs.writeFileSync(StoreHandle.dbPathFor(dir), "NOT A SQLITE FILE");
    const corrupt = repairStore(dir);
    assert.equal(corrupt.status, "gap");
    if (corrupt.status === "gap") {
      assert.ok(corrupt.gaps.some(g => g.nodeId === ORPHAN_NODE && g.reason === "missing journal file"));
    }

    // file loss + missing DB -> same
    fs.rmSync(StoreHandle.dbPathFor(dir), { force: true });
    const missing = repairStore(dir);
    assert.equal(missing.status, "gap");

    // file loss + intact DB -> gap at sequence 1 (plain-node path)
    // restore a readable DB with the orphan rows first
    const restored = repairStore(dir); // journal-only is impossible: witness node in union -> gap
    assert.equal(restored.status, "gap");

    // witness without a file is recoverable by explicit re-approval on intact DB
    const { openDatabase } = require("./db") as typeof import("./db");
    const db = openDatabase(StoreHandle.dbPathFor(dir));
    try { db.close(); } catch { /* already gone */ }
    const handle2 = StoreHandle.open(dir);
    handle2.close();
    insertOrphanRow(dir);
    const draft2 = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions()); // watermark == max seq: allowed as re-approval
    const result2 = commitNodeAttestation(dir, ORPHAN_NODE, draft2.contentSha256, draftOptions());
    assert.equal(result2.attestation.nodeId, ORPHAN_NODE);
    const result3 = repairStore(dir);
    assert.equal(result3.status, "ok");
    if (result3.status === "ok") assert.equal(result3.eventsReplayed, 3);
  } finally {
    cleanupDir(dir);
  }
});

test("partial attestation file damage still yields named gaps via the witness", () => {
  const dir = mkTmpDir("mapctx-attest-partial-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);
    insertOrphanRow(dir, { node_id: "88888888-2222-4333-8444-555555555555", sequence: 4, logical_clock: 4, occurred_at: "2026-09-27T18:52:03.557Z" });
    for (const node of [ORPHAN_NODE, "88888888-2222-4333-8444-555555555555"]) {
      const d = draftNodeAttestation(dir, node, draftOptions());
      commitNodeAttestation(dir, node, d.contentSha256, draftOptions());
    }
    // remove one node from the file: its witness still forces a named gap
    const filePath = attestationFilePath(dir);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    parsed.attestations = parsed.attestations.filter((a: { nodeId: string }) => a.nodeId === ORPHAN_NODE);
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2));
    const partial = repairStore(dir);
    assert.equal(partial.status, "gap");
    if (partial.status === "gap") {
      assert.ok(partial.gaps.some(g => g.nodeId === "88888888-2222-4333-8444-555555555555" && g.reason === "missing journal file"));
    }

    // empty the list entirely: both witnesses remain -> both gap
    fs.writeFileSync(filePath, JSON.stringify({ attestations: [] }, null, 2));
    const emptied = repairStore(dir);
    assert.equal(emptied.status, "gap");
    if (emptied.status === "gap") assert.equal(emptied.gaps.length, 2);
  } finally {
    cleanupDir(dir);
  }
});

test("crash after witness publishes no file; witness survives; repair refuses; re-approval is idempotent", () => {
  const dir = mkTmpDir("mapctx-attest-crash-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);
    const draft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    assert.throws(
      () => commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, { ...draftOptions(), failAfterWitness: true }),
      /Simulated crash after witness/
    );
    // witness durable, file absent
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "store-meta.json"), "utf8"));
    assert.equal(meta.sequenceWatermarks[ORPHAN_NODE], 3);
    assert.equal(fs.existsSync(attestationFilePath(dir)), false);
    const refused = repairStore(dir);
    assert.equal(refused.status, "gap");

    // idempotent re-approval: witness reused (not duplicated/overwritten), then file lands
    const draft2 = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    assert.equal(draft2.contentSha256, draft.contentSha256);
    const ok = commitNodeAttestation(dir, ORPHAN_NODE, draft2.contentSha256, draftOptions());
    assert.equal(ok.attestation.nodeId, ORPHAN_NODE);
    const meta2 = JSON.parse(fs.readFileSync(path.join(dir, "store-meta.json"), "utf8"));
    assert.equal(meta2.sequenceWatermarks[ORPHAN_NODE], 3);
    assert.equal(repairStore(dir).status, "ok");
  } finally {
    cleanupDir(dir);
  }
});

test("divergent watermark refuses both draft and repair; repair demands the witness for attested nodes", () => {
  const dir = mkTmpDir("mapctx-attest-divergent-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);
    const draft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions());
    // corrupt the witness to a divergent value
    const metaPath = path.join(dir, "store-meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.sequenceWatermarks[ORPHAN_NODE] = 999;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    const divergent = repairStore(dir);
    assert.equal(divergent.status, "gap");
    if (divergent.status === "gap") assert.match(divergent.gaps[0].reason, /witness.*diverges|diverges from the attested max/);

    // no permissive back-compat: a file without any witness is refused too
    const meta2 = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    delete meta2.sequenceWatermarks[ORPHAN_NODE];
    fs.writeFileSync(metaPath, JSON.stringify(meta2, null, 2));
    const unwitnessed = repairStore(dir);
    assert.equal(unwitnessed.status, "gap");
    if (unwitnessed.status === "gap") assert.match(unwitnessed.gaps[0].reason, /lacks its approval witness/);

    // and a divergent watermark blocks a fresh draft over the same rows
    const meta3 = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta3.sequenceWatermarks[ORPHAN_NODE] = 500;
    fs.writeFileSync(metaPath, JSON.stringify(meta3, null, 2));
    assert.throws(() => draftNodeAttestation(dir, ORPHAN_NODE, draftOptions()), /watermark 500.*diverges|diverges from the rows being attested/);
  } finally {
    cleanupDir(dir);
  }
});

test("raw causation bytes survive replay across repeated repairs (all 11 columns)", () => {
  const dir = mkTmpDir("mapctx-attest-causation-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir, { causation_json: "[ ]" });
    const before = readOrphanRows(dir);
    const draft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions());

    assert.equal(repairStore(dir).status, "ok");
    assert.deepEqual(readOrphanRows(dir), before);
    assert.equal(repairStore(dir).status, "ok");
    assert.deepEqual(readOrphanRows(dir), before);
  } finally {
    cleanupDir(dir);
  }
});

test("invalid drafts fail validation before any token, witness, or file exists", () => {
  const dir = mkTmpDir("mapctx-attest-invalid-draft-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    // malformed causation row
    insertOrphanRow(dir, { causation_json: "not json" });
    assert.throws(() => draftNodeAttestation(dir, ORPHAN_NODE, draftOptions()), /causation_json/);
    // blank reason (restore valid causation on the existing row)
    {
      const { openDatabase } = require("./db") as typeof import("./db");
      const db = openDatabase(StoreHandle.dbPathFor(dir));
      try { db.prepare("UPDATE event_log SET causation_json = ? WHERE node_id = ?").run("[]", ORPHAN_NODE); } finally { db.close(); }
    }
    assert.throws(() => draftNodeAttestation(dir, ORPHAN_NODE, { ...draftOptions(), reason: "   " }), /blank reason/);
    // nothing published
    assert.equal(fs.existsSync(attestationFilePath(dir)), false);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "store-meta.json"), "utf8"));
    assert.equal(meta.sequenceWatermarks[ORPHAN_NODE], undefined);

    // an existing valid approval remains readable after failed drafts
    const draft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions());
    assert.equal(loadNodeAttestations(dir).size, 1);
  } finally {
    cleanupDir(dir);
  }
});

test("re-confirmation restores a missing witness via the normal commands, conserving original approval metadata", () => {
  const dir = mkTmpDir("mapctx-attest-reconfirm-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);
    const draft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    const first = commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions());
    const originalFileBytes = fs.readFileSync(attestationFilePath(dir));

    // witness stripped, file intact: repair refuses naming the executable remedy
    const metaPath = path.join(dir, "store-meta.json");
    const stripWitness = () => {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      delete meta.sequenceWatermarks[ORPHAN_NODE];
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    };
    stripWitness();
    const refused = repairStore(dir);
    assert.equal(refused.status, "gap");
    if (refused.status === "gap") assert.match(refused.gaps[0].reason, /lacks its approval witness.*re-approval/);

    // the normal draft (read-only, no early refusal) + same-pin commit restores it
    const redraft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    assert.equal(redraft.contentSha256, draft.contentSha256);
    const again = commitNodeAttestation(dir, ORPHAN_NODE, redraft.contentSha256, draftOptions());
    // original approval object conserved verbatim
    assert.equal(again.attestation.attestedAt, first.attestation.attestedAt);
    assert.equal(again.attestation.approvedBy, first.attestation.approvedBy);
    assert.equal(again.contentSha256, first.contentSha256);
    assert.deepEqual(fs.readFileSync(attestationFilePath(dir)), originalFileBytes);
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    assert.equal(meta.sequenceWatermarks[ORPHAN_NODE], 3);
    assert.equal(repairStore(dir).status, "ok");

    // repeat stays stable
    const third = commitNodeAttestation(dir, ORPHAN_NODE, redraft.contentSha256, draftOptions());
    assert.equal(third.attestation.attestedAt, first.attestation.attestedAt);
    assert.equal(repairStore(dir).status, "ok");
  } finally {
    cleanupDir(dir);
  }
});

test("re-confirmation refuses divergent content and divergent witness with zero writes", () => {
  const dir = mkTmpDir("mapctx-attest-reconfirm-refuse-");
  try {
    const handle = StoreHandle.open(dir);
    seed(handle);
    handle.close();
    insertOrphanRow(dir);
    const draft = draftNodeAttestation(dir, ORPHAN_NODE, draftOptions());
    commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions());
    const snapshot = () => ({
      file: fs.readFileSync(attestationFilePath(dir)).toString(),
      meta: fs.readFileSync(path.join(dir, "store-meta.json")).toString()
    });
    const before = snapshot();

    // different reviewed content: refuse, zero writes
    const divergent = draftNodeAttestation(dir, ORPHAN_NODE, { ...draftOptions(), reason: draftOptions().reason + " amended" });
    assert.notEqual(divergent.contentSha256, draft.contentSha256);
    assert.throws(
      () => commitNodeAttestation(dir, ORPHAN_NODE, divergent.contentSha256, { ...draftOptions(), reason: draftOptions().reason + " amended" }),
      /different reviewed content.*Nothing was written/
    );
    assert.equal(snapshot().file, before.file);
    assert.equal(snapshot().meta, before.meta);

    // greater watermark: refuse without overwriting testimony
    const metaPath = path.join(dir, "store-meta.json");
    const bump = (v: number) => {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      meta.sequenceWatermarks[ORPHAN_NODE] = v;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    };
    bump(999);
    const beforeGreater = snapshot();
    // the DRAFT gate refuses first (also zero writes); commit's witness gate backs it up
    assert.throws(
      () => draftNodeAttestation(dir, ORPHAN_NODE, draftOptions()),
      /watermark 999, which diverges/
    );
    assert.throws(
      () => commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions()),
      /diverges/
    );
    assert.equal(snapshot().meta, beforeGreater.meta);
    assert.equal(snapshot().file, beforeGreater.file);

    // lesser watermark: same refusal semantics (divergent, never lowered)
    bump(2);
    const beforeLesser = snapshot();
    assert.throws(
      () => commitNodeAttestation(dir, ORPHAN_NODE, draft.contentSha256, draftOptions()),
      /diverges/
    );
    assert.equal(snapshot().meta, beforeLesser.meta);

    // wrong pin (token from a different draft) with intact everything: refuse, zero writes
    bump(3);
    const wrongToken = "f".repeat(64);
    assert.throws(
      () => commitNodeAttestation(dir, ORPHAN_NODE, wrongToken, draftOptions()),
      /Approval hash mismatch/
    );
    assert.equal(snapshot().file, before.file);
  } finally {
    cleanupDir(dir);
  }
});
