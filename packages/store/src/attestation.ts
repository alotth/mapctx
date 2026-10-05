import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { DatabaseSync } from "node:sqlite"
import { canonicalJson } from "@mapctx/protocol"
import type { EventLogEntry } from "@mapctx/protocol"
import { payloadSha256, listJournalSequences } from "./journal"
import { checkIntegrity } from "./db"
import { acquireMaintenanceLock } from "./maintenance"
import { readStoreMetaFile, withStoreMetaLock, writeStoreMetaFile } from "./identity"

/**
 * T-119: attestation for DB-only historical nodes.
 *
 * A node whose event rows exist only inside mapctx.db (journal_path "") cannot
 * be rebuilt from the journal, and repair must keep refusing while the missing
 * prefix is an open question. An attestation is the reviewable instrument that
 * closes that question for one specific node: it pins the node's COMPLETE row
 * set (every event_log column, byte-exact) as an independent durable copy
 * outside the database, records who approved it and why, and lets repair
 * treat the node's absent prefix (1 .. minSequence-1) as a DECLARED fact
 * instead of undiscovered loss.
 *
 * What an attestation attests:
 * - the exact rows listed (hash-pinned; any drift between the attestation and
 *   the database fails repair closed),
 * - that sequences before the first attested row are knowingly absent from
 *   this store's history, not silently dropped.
 *
 * What it does NOT attest:
 * - that no matching events ever happened elsewhere (e.g. on another writer),
 * - anything about rows after the last attested sequence (they would be new,
 *   unexpected data, and repair still refuses them).
 *
 * Without an attestation (or with a malformed one) repair behaves exactly as
 * T-118 left it: named-gap refusal, database untouched.
 */

export const ATTESTATION_FILE = "node-attestations.json"
export const ATTESTATION_SCHEMA_VERSION = 1

/** One event_log row, raw DB column values, byte-exact. */
export type AttestedRow = {
  node_id: string
  sequence: number
  logical_clock: number
  event_type: string
  schema_version: number
  occurred_at: string
  actor: string
  causation_json: string
  payload_json: string
  payload_sha256: string
  journal_path: string
}

export type NodeAttestation = {
  schemaVersion: number
  nodeId: string
  rows: AttestedRow[]
  reason: string
  evidence: Record<string, string>
  /** SHA-256 of canonicalJson over the reviewed content fields; verified on every load. */
  contentSha256: string
  attestedAt: string
  approvedBy: string
}

/**
 * The reviewed, hash-pinned subset. Commit-time metadata (attestedAt,
 * approvedBy) is intentionally outside: the draft a reviewer inspects and the
 * approved write may land at different instants without invalidating the
 * token.
 */
export type AttestationContent = Pick<NodeAttestation, "schemaVersion" | "nodeId" | "rows" | "reason" | "evidence">

export type AttestationFile = { attestations: NodeAttestation[] }

export type AttestationDraft = {
  attestation: NodeAttestation
  /** SHA-256 of canonicalJson(content) -- the review/approval token. */
  contentSha256: string
}

export function attestationFilePath(storeDir: string): string {
  return path.join(storeDir, ATTESTATION_FILE)
}

/**
 * Reads and structurally validates the attestation file. Returns an empty map
 * when the file does not exist. A file that exists but cannot be parsed or
 * fails structural validation THROWS: repair must never silently proceed as
 * if a known attestation did not exist.
 */
export function loadNodeAttestations(storeDir: string): Map<string, NodeAttestation> {
  const filePath = attestationFilePath(storeDir)
  if (!fs.existsSync(filePath)) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Malformed attestation file ${filePath}: ${(error as Error).message}. Run "mapctx store attest-orphan" to inspect; repair refuses to run while it is unreadable.`);
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as AttestationFile).attestations)) {
    throw new Error(`Malformed attestation file ${filePath}: expected {"attestations":[...]}`);
  }
  const map = new Map<string, NodeAttestation>();
  for (const attestation of (parsed as AttestationFile).attestations) {
    validateAttestation(attestation, filePath, { requireToken: true });
    if (map.has(attestation.nodeId)) throw new Error(`Duplicate attestation for node ${attestation.nodeId} in ${filePath}`);
    map.set(attestation.nodeId, attestation);
  }
  return map;
}

/**
 * Content hash of the reviewed subset: canonical JSON over schemaVersion,
 * nodeId, rows, reason and evidence. Any change to the pinned rows or the
 * stated justification changes the token. Commit-time metadata is excluded
 * so the reviewed token stays valid across the draft -> approve gap.
 */
export function attestationContentSha256(content: AttestationContent): string {
  return crypto.createHash("sha256").update(canonicalJson({
    schemaVersion: content.schemaVersion,
    nodeId: content.nodeId,
    rows: content.rows,
    reason: content.reason,
    evidence: content.evidence
  }), "utf8").digest("hex");
}

/**
 * Verifies one row's payload hash. Rows written by the current writer hash
 * canonicalJson(payload); the two known T-119 DB-only rows hash
 * compatibly with a compact JSON.stringify serialization instead. Hash-scheme
 * compatibility constrains only how the pinned payload bytes serialize: it
 * does not identify the writing process, authenticate the recorded
 * occurred_at, or prove anything about events beyond the pinned rows. An
 * attestation may only pin rows verifiable under EITHER documented scheme --
 * the scheme is re-derived from the bytes at every verification, never
 * trusted from the file.
 */
export function verifyRowPayloadHash(row: { payload_json: string; payload_sha256: string }): { ok: true; scheme: "canonical" | "compact-legacy" } {
  const payload = JSON.parse(row.payload_json) as unknown;
  if (payloadSha256(payload) === row.payload_sha256) return { ok: true, scheme: "canonical" };
  const compact = crypto.createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  if (compact === row.payload_sha256) return { ok: true, scheme: "compact-legacy" };
  throw new Error(`payload hash mismatch under every documented scheme (canonical ${payloadSha256(payload)}, compact ${compact}, stored ${row.payload_sha256})`);
}

/**
 * Builds the draft attestation for one DB-only node from the CURRENT database
 * content. Reads the database read-only and writes nothing. Refuses when the
 * node has journal files, a divergent watermark, or invalid rows. An
 * existing attestation permits another read-only draft; commit enforces
 * the same reviewed content pin before re-confirming its missing witness.
 */
export function draftNodeAttestation(storeDir: string, nodeId: string, options: {
  reason: string;
  evidence?: Record<string, string>;
  approvedBy: string;
  now?: () => Date;
}): AttestationDraft {
  const dbPath = path.join(storeDir, "mapctx.db");
  if (!fs.existsSync(dbPath)) throw new Error(`No database at ${dbPath}; nothing to attest.`);
  if (listJournalSequences(storeDir, nodeId).length > 0) {
    throw new Error(`Node ${nodeId} has journal files; it is not DB-only. Attestations only cover nodes whose rows exist solely in mapctx.db.`);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows: AttestedRow[];
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") throw new Error(`Database integrity check failed: ${integrity.integrity_check}`);
    const raw = db.prepare("SELECT * FROM event_log WHERE node_id = ? ORDER BY sequence ASC").all(nodeId) as unknown as AttestedRow[];
    rows = raw;
  } finally {
    db.close();
  }
  if (rows.length === 0) throw new Error(`Node ${nodeId} has no rows in event_log; nothing to attest.`);

  let expectedSequence = rows[0].sequence;
  for (const row of rows) {
    if (row.node_id !== nodeId) throw new Error(`Row for wrong node ${row.node_id} returned for ${nodeId}`);
    if (row.sequence !== expectedSequence++) throw new Error(`Noncontiguous attested rows for node ${nodeId} at sequence ${row.sequence}`);
    if (row.journal_path !== "") throw new Error(`Row ${nodeId}/${row.sequence} has journal_path "${row.journal_path}"; only journal-less rows (journal_path "") can be attested as DB-only.`);
    verifyRowPayloadHash(row);
  }

  // A watermark for this node is the approval witness this module itself
  // publishes (and then requires at repair time). It may pre-exist only as
  // this exact testimony -- a previous approval attempt that crashed between
  // witness and file -- never as an unrelated value. The watermark witnesses
  // the store's belief about history; it never authorizes the absent prefix
  // on its own: only the reviewed attestation does that.
  const existingWitness = readStoreMetaFile(storeDir)?.sequenceWatermarks?.[nodeId];
  const lastAttested = rows[rows.length - 1].sequence;
  if (existingWitness !== undefined && existingWitness !== lastAttested) {
    throw new Error(`Node ${nodeId} has sequence watermark ${existingWitness}, which diverges from the rows being attested (max ${lastAttested}); refusing to attest over unexplained testimony.`);
  }

  const attestation: NodeAttestation = {
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    nodeId,
    rows,
    reason: options.reason,
    evidence: options.evidence ?? {},
    contentSha256: "",
    attestedAt: (options.now ?? (() => new Date))().toISOString(),
    approvedBy: options.approvedBy
  };
  // Full structural validation on the fully formed draft: an invalid draft
  // must fail HERE, before any token exists, never only when the persisted
  // file is next loaded.
  validateAttestation(attestation, "draft", { requireToken: false });
  attestation.contentSha256 = attestationContentSha256(attestation);
  return {
    attestation,
    contentSha256: attestation.contentSha256
  };
}

/**
 * Approves and durably writes one attestation with its independent witness.
 * Order and durability contract:
 *
 * 1. the draft is recomputed under the maintenance lock and the approval
 *    token must match it exactly (what was reviewed is what gets written);
 * 2. the WITNESS is published first: sequenceWatermarks[nodeId] in
 *    store-meta.json (merge-preserving every other field and node), written
 *    atomically with fsync file + rename + fsync directory under the store
 *    metadata lock. A crash after this step but before the file leaves a
 *    witness without attestation: repair then refuses with a named gap, and
 *    an intact database allows re-approval of the same rows -- never a
 *    silent rebuild;
 * 3. the attestation FILE is published second, equally durable;
 * 4. success is reported only after both are durable. Any failure never
 *    removes an existing witness, never removes rows, and never leaves a
 *    half-written file (tmp+rename everywhere).
 */
export function commitNodeAttestation(storeDir: string, nodeId: string, approveHash: string, options: {
  reason: string;
  evidence?: Record<string, string>;
  approvedBy: string;
  now?: () => Date;
  /** Test-only crash injection: throws after the witness, before the file. */
  failAfterWitness?: boolean;
}): { attestation: NodeAttestation; contentSha256: string; filePath: string } {
  if (!/^[a-f0-9]{64}$/.test(approveHash)) throw new Error("--approve-hash must be a 64-char lowercase hex sha256.");
  const lock = acquireMaintenanceLock(storeDir);
  try {
    const draft = draftNodeAttestation(storeDir, nodeId, options);
    if (draft.contentSha256 !== approveHash) {
      throw new Error(`Approval hash mismatch: reviewed token was ${approveHash}, current draft hashes to ${draft.contentSha256}. Re-review the draft; the store changed since it was produced.`);
    }
    const existing = loadNodeAttestations(storeDir);
    const prior = existing.get(nodeId);
    const lastAttested = draft.attestation.rows[draft.attestation.rows.length - 1].sequence;
    if (prior) {
      // Re-confirmation of an existing approval. Allowed ONLY when the
      // reviewed content is byte-identical (same pin over node/rows/reason/
      // evidence, validated against an intact database by the draft above):
      // this is the executable remedy for a missing witness. A divergent
      // witness is refused by draft and publication. The
      // original attestation object is conserved verbatim (attestedAt,
      // approvedBy, every field) -- never silently replaced. Anything else
      // refuses with ZERO writes: file, metadata, and rows all untouched.
      if (prior.contentSha256 !== draft.contentSha256) {
        throw new Error(`Node ${nodeId} is already attested with different reviewed content (existing pin ${prior.contentSha256}, redraft pins ${draft.contentSha256}); refusing to alter an existing approval. Nothing was written.`);
      }
      publishAttestationWitness(storeDir, nodeId, lastAttested);
      if (options.failAfterWitness) {
        throw new Error(`Simulated crash after witness re-confirmation for ${nodeId}.`);
      }
      return { attestation: prior, contentSha256: prior.contentSha256, filePath: attestationFilePath(storeDir) };
    }

    publishAttestationWitness(storeDir, nodeId, lastAttested);
    if (options.failAfterWitness) {
      throw new Error(`Simulated crash after witness publication for ${nodeId}; attestation file not written.`);
    }
    existing.set(nodeId, draft.attestation);
    const filePath = attestationFilePath(storeDir);
    const content = `${JSON.stringify({ attestations: [...existing.values()] }, null, 2)}\n`;
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeSync(fd, content, null, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
    // Same durability bar as the journal writer: the rename must survive a
    // crash before the caller is told the attestation exists.
    const dirFd = fs.openSync(path.dirname(filePath), "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    return { attestation: draft.attestation, contentSha256: draft.contentSha256, filePath };
  } finally {
    lock.release();
  }
}

/**
 * Publishes (or idempotently re-confirms) the independent witness for one
 * attested node: sequenceWatermarks[nodeId] = lastAttested in store-meta.json.
 * Durable (tmp + fsync + rename + fsync directory) under the store metadata
 * lock, merge-preserving identity, incarnation, createdAt and every other
 * node's watermark. An existing equal value is reused as-is (idempotent
 * retry); a divergent value refuses -- the witness must never be erased or
 * overwritten with something the reviewed rows do not state.
 */
export function publishAttestationWitness(storeDir: string, nodeId: string, lastAttested: number): void {
  withStoreMetaLock(storeDir, () => {
    const meta = readStoreMetaFile(storeDir);
    if (!meta) throw new Error(`Cannot publish attestation witness: no store-meta.json at ${storeDir}.`);
    const existing = meta.sequenceWatermarks[nodeId];
    if (existing === lastAttested) return;
    if (existing !== undefined) {
      throw new Error(`Witness conflict for node ${nodeId}: store-meta.json watermarks sequence ${existing}, attestation pins max ${lastAttested}. Refusing to overwrite testimony.`);
    }
    writeStoreMetaFile(storeDir, {
      ...meta,
      sequenceWatermarks: { ...meta.sequenceWatermarks, [nodeId]: lastAttested }
    });
  });
}

/**
 * Verifies an attestation against the current database: the node's rows must
 * equal the attested rows field-for-field (no drift, no loss, no additions).
 * Returns null when they match, or the first mismatch description.
 */
export function verifyAttestationAgainstDb(storeDir: string, attestation: NodeAttestation): string | null {
  const dbPath = path.join(storeDir, "mapctx.db");
  if (!checkIntegrity(dbPath)) return null; // corrupt DB contributes no floor; caller decides
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const raw = db.prepare("SELECT * FROM event_log WHERE node_id = ? ORDER BY sequence ASC").all(attestation.nodeId) as unknown as AttestedRow[];
    if (raw.length !== attestation.rows.length) {
      return `node ${attestation.nodeId}: database holds ${raw.length} row(s), attestation pins ${attestation.rows.length}`;
    }
    for (let i = 0; i < raw.length; i++) {
      const actual = raw[i];
      const expected = attestation.rows[i];
      for (const key of Object.keys(expected) as Array<keyof AttestedRow>) {
        if (actual[key] !== expected[key]) {
          return `node ${attestation.nodeId} sequence ${expected.sequence}: column ${key} drifted from the attested value`;
        }
      }
    }
    return null;
  } finally {
    db.close();
  }
}

/**
 * Rebuilds the attested rows as replayable journal-equivalent entries. The
 * payload and its hash are re-verified here so a corrupted attestation file
 * can never inject content its own hash contradicts. `journalPath` keeps the
 * original rows' journal_path ("" for DB-only nodes) so the rebuilt
 * database preserves the originals byte-exactly.
 */
export function attestedEntries(attestation: NodeAttestation): Array<EventLogEntry & { journalPath: string; payloadJson: string; causationJson: string }> {
  return attestation.rows.map(row => {
    verifyRowPayloadHash(row);
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    return {
      nodeId: row.node_id,
      sequence: row.sequence,
      logicalClock: row.logical_clock,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      occurredAt: row.occurred_at,
      actor: row.actor,
      causation: JSON.parse(row.causation_json) as EventLogEntry["causation"],
      payload,
      payloadSha256: row.payload_sha256,
      journalPath: row.journal_path,
      payloadJson: row.payload_json,
      causationJson: row.causation_json
    };
  });
}

/**
 * THE structural validation for one attestation object, shared by all three
 * entry points: draft (validates the fully formed object before any token
 * exists), commit (validates the fresh draft before publishing witness or
 * file), and load (validates the persisted file, token included). Anything
 * invalid fails here -- never only after persistence.
 */
export function validateAttestation(attestation: unknown, filePath: string, options: { requireToken: boolean }): void {
  const a = attestation as Partial<NodeAttestation>;
  function fail(why: string): never { throw new Error(`Malformed attestation in ${filePath}: ${why}`); }
  if (a.schemaVersion !== ATTESTATION_SCHEMA_VERSION) fail(`unsupported schemaVersion ${String(a.schemaVersion)}`);
  if (typeof a.nodeId !== "string" || a.nodeId.length === 0) fail("missing nodeId");
  const rows = a.rows;
  if (!Array.isArray(rows) || rows.length === 0) fail(`no rows for node ${a.nodeId}`);
  let expectedSequence = rows[0].sequence;
  for (const row of rows) {
    const r = row as Partial<AttestedRow>;
    if (typeof r.node_id !== "string" || r.node_id !== a.nodeId) fail(`row node mismatch in node ${a.nodeId}`);
    if (typeof r.sequence !== "number" || !Number.isInteger(r.sequence) || r.sequence < 1 || r.sequence !== expectedSequence++) fail(`noncontiguous or invalid sequence in node ${a.nodeId} at ${String(r.sequence)}`);
    if (typeof r.logical_clock !== "number" || !Number.isInteger(r.logical_clock) || r.logical_clock < 1) fail(`row ${a.nodeId}/${r.sequence} has invalid logical_clock`);
    if (typeof r.event_type !== "string" || r.event_type.length === 0) fail(`row ${a.nodeId}/${r.sequence} has invalid event_type`);
    if (typeof r.schema_version !== "number" || !Number.isInteger(r.schema_version) || r.schema_version < 1) fail(`row ${a.nodeId}/${r.sequence} has invalid schema_version`);
    if (typeof r.occurred_at !== "string" || r.occurred_at.length === 0) fail(`row ${a.nodeId}/${r.sequence} has invalid occurred_at`);
    if (typeof r.actor !== "string" || r.actor.length === 0) fail(`row ${a.nodeId}/${r.sequence} has invalid actor`);
    if (typeof r.causation_json !== "string") fail(`row ${a.nodeId}/${r.sequence} has invalid causation_json`);
    let causation: unknown;
    try { causation = JSON.parse(r.causation_json); } catch { fail(`row ${a.nodeId}/${r.sequence} causation_json is not valid JSON`); }
    if (!Array.isArray(causation)) fail(`row ${a.nodeId}/${r.sequence} causation_json is not an array`);
    if (r.journal_path !== "") fail(`attested row ${a.nodeId}/${r.sequence} is not journal-less`);
    if (typeof r.payload_json !== "string" || typeof r.payload_sha256 !== "string") fail(`row ${a.nodeId}/${r.sequence} missing payload fields`);
    let payloadHashOk = false;
    try { verifyRowPayloadHash({ payload_json: r.payload_json, payload_sha256: r.payload_sha256 }); payloadHashOk = true; } catch { payloadHashOk = false; }
    if (!payloadHashOk) fail(`row ${a.nodeId}/${r.sequence} payload hash mismatch inside the attestation file`);
  }
  if (typeof a.reason !== "string" || a.reason.trim().length === 0) fail(`missing or blank reason for node ${a.nodeId}`);
  if (typeof a.attestedAt !== "string") fail(`missing attestedAt for node ${a.nodeId}`);
  if (typeof a.approvedBy !== "string" || a.approvedBy.length === 0) fail(`missing approvedBy for node ${a.nodeId}`);
  if (typeof a.evidence !== "object" || a.evidence === null || Array.isArray(a.evidence)) fail(`evidence must be an object for node ${a.nodeId}`);
  if (!options.requireToken) return;
  // The pinned approval token must match the reviewed content exactly: a
  // post-approval edit of rows, reason or evidence cannot pass load-time
  // validation even when the edited rows are internally hash-consistent.
  if (typeof a.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.contentSha256)) fail(`missing or invalid contentSha256 for node ${a.nodeId}`);
  const recomputed = attestationContentSha256({
    schemaVersion: a.schemaVersion,
    nodeId: a.nodeId,
    rows,
    reason: a.reason,
    evidence: a.evidence
  });
  if (recomputed !== a.contentSha256) fail(`contentSha256 mismatch for node ${a.nodeId} (file carries ${a.contentSha256}, content hashes to ${recomputed})`);
}
