import * as fs from "fs"
import * as path from "path"
import type { EventLogEntry } from "@mapctx/protocol"
import { checkIntegrity, openDatabase, writeMetaValue } from "./db"
import { applyEventToProjections } from "./events"
import { readStoreMetaFile } from "./identity"
import { acquireMaintenanceLock, assertNotUnderMaintenance } from "./maintenance"
import { listJournalNodeIds, listJournalSequences, readJournalEntry } from "./journal"
import { attestedEntries, loadNodeAttestations, verifyAttestationAgainstDb, type NodeAttestation } from "./attestation"
import { insertEventLogRow, StoreHandle } from "./store-handle"

export type RepairGap = {
  nodeId: string;
  sequence: number;
  reason: string;
};

export type RepairResult =
  | { status: "ok"; dbWasCorrupt: boolean; eventsReplayed: number }
  | { status: "gap"; dbWasCorrupt: boolean; gaps: RepairGap[] };

/**
 * Rebuilds mapctx.db by validating the independent journal (per-event hash,
 * contiguous (nodeId, sequence) ranges starting at 1) and reprojecting every
 * validated event into a fresh temporary database, swapped into place only
 * on full success. A gap -- missing file, unreadable file, or hash mismatch
 * -- aborts without touching the existing (possibly still-serviceable)
 * mapctx.db, and is reported by exact (nodeId, sequence), never skipped.
 */
/**
 * Per-node max(sequence) from the existing mapctx.db, but only when the
 * database file exists and passes its integrity check -- a corrupt
 * database's rows prove nothing. Any error reading it simply yields no
 * floor; the watermark and the journal then stand alone, as before.
 */
export function intactDatabaseFloor(dbPath: string, dbWasCorrupt: boolean): Record<string, number> {
  if (dbWasCorrupt || !fs.existsSync(dbPath)) return {};
  let db;
  try {
    db = openDatabase(dbPath);
  } catch {
    return {};
  }
  try {
    const rows = db.prepare(
      "SELECT node_id, MAX(sequence) AS max_sequence FROM event_log GROUP BY node_id"
    ).all() as Array<{ node_id: string; max_sequence: number }>;
    return Object.fromEntries(rows.map(row => [row.node_id, row.max_sequence]));
  } catch {
    return {};
  } finally {
    db.close();
  }
}

export function repairStore(storeDir: string): RepairResult {
  assertNotUnderMaintenance(storeDir);
  const maintenanceLock = acquireMaintenanceLock(storeDir);
  try {
    return repairStoreUnderLock(storeDir);
  } finally {
    maintenanceLock.release();
  }
}

function repairStoreUnderLock(storeDir: string): RepairResult {
  const dbPath = StoreHandle.dbPathFor(storeDir);
  const dbWasCorrupt = fs.existsSync(dbPath) ? !checkIntegrity(dbPath) : false;

  // T-119: an attestation file pins DB-only nodes' complete row sets outside
  // the database. A file that exists but cannot be parsed or fails structural
  // validation throws here: repair never proceeds as if a known attestation
  // were absent, because journal-only or DB-only rebuilds would then drop the
  // pinned rows without the named-gap refusal contract noticing.
  const attestations = loadNodeAttestations(storeDir);

  // The watermark (persisted outside mapctx.db, bumped after every commit)
  // is the independent cross-check for "how far should this node's journal
  // go" -- directory listing alone cannot tell a fully-deleted trailing
  // file (or an entirely deleted events/<nodeId>/ directory) apart from
  // "nothing was ever written there". A watermark can legitimately lag the
  // committed state (crash between COMMIT and the bump, or a degraded
  // metadata write), so when mapctx.db itself is intact its indexed max
  // sequence per node raises the floor; only when the database is unusable
  // is the watermark the sole witness.
  const watermarks = readStoreMetaFile(storeDir)?.sequenceWatermarks ?? {};
  const dbFloor = intactDatabaseFloor(dbPath, dbWasCorrupt);
  // T-118 review P1: nodes indexed in an intact database but absent from the
  // journal directory AND the watermarks are the silent-loss case -- without
  // them in the union, repair would rebuild journal-only and quietly discard
  // that indexed history (ADR 0003's named-gap / never-silently-skip
  // contract). Their first missing sequence then fails repair closed via the
  // existing gap path, before any temp DB is built or swapped. A corrupt
  // database still contributes nothing: its rows prove nothing, so
  // dbWasCorrupt yields an empty floor and journal-only remains the only
  // honest rebuild.
  // T-119: attested nodes join the union as their own independent source --
  // including when a corrupt database contributes no floor, because the
  // attestation (verified content, approved hash) stands outside the DB.
  const nodeIds = Array.from(new Set([
    ...listJournalNodeIds(storeDir),
    ...Object.keys(watermarks),
    ...Object.keys(dbFloor),
    ...attestations.keys()
  ])).sort();
  const gaps: RepairGap[] = [];
  const validatedByNode = new Map<string, ValidatedEntry[]>();

  for (const nodeId of nodeIds) {
    const attestation = attestations.get(nodeId);
    if (attestation) {
      validateAttestedNode(storeDir, nodeId, attestation, watermarks, dbFloor, dbWasCorrupt, gaps, validatedByNode);
      continue;
    }

    const sequences = listJournalSequences(storeDir, nodeId);
    const onDiskMax = sequences.length > 0 ? sequences[sequences.length - 1] : 0;
    const maxSequence = Math.max(onDiskMax, watermarks[nodeId] ?? 0, dbFloor[nodeId] ?? 0);
    const validated: ValidatedEntry[] = [];

    for (let sequence = 1; sequence <= maxSequence; sequence++) {
      const result = readJournalEntry(storeDir, nodeId, sequence);
      if (result.status === "ok") {
        validated.push({ entry: result.entry });
        continue;
      }
      gaps.push({
        nodeId,
        sequence,
        reason: result.status === "missing" ? "missing journal file" : result.reason
      });
      break; // do not guess past a gap; sequences after it are unreachable in order
    }

    validatedByNode.set(nodeId, validated);
  }

  if (gaps.length > 0) {
    return { status: "gap", dbWasCorrupt, gaps };
  }

  const allEntries = ([] as ValidatedEntry[])
    .concat(...validatedByNode.values())
    .sort((a, b) => a.entry.logicalClock - b.entry.logicalClock || a.entry.nodeId.localeCompare(b.entry.nodeId) || a.entry.sequence - b.entry.sequence);

  const tempDbPath = path.join(storeDir, `mapctx.db.rebuild-${process.pid}-${Date.now()}`);
  const tempDb = openDatabase(tempDbPath);
  try {
    const meta = readStoreMetaFile(storeDir);
    tempDb.exec("BEGIN IMMEDIATE");
    try {
      if (meta) {
        writeMetaValue(tempDb, "node_id", meta.nodeId);
        writeMetaValue(tempDb, "incarnation_id", meta.incarnationId);
      }
      let logicalClock = 0;
      for (const { entry, overrides } of allEntries) {
        insertEventLogRow(tempDb, entry, overrides);
        applyEventToProjections(tempDb, entry);
        logicalClock = Math.max(logicalClock, entry.logicalClock);
      }
      writeMetaValue(tempDb, "logical_clock", logicalClock);
      tempDb.exec("COMMIT");
    } catch (error) {
      tempDb.exec("ROLLBACK");
      throw error;
    }
    tempDb.exec("PRAGMA wal_checkpoint(FULL)");
  } finally {
    tempDb.close();
  }

  // R12 review P2#1: before the swap, quiesce the working database. A
  // crash-dirty -wal paired with the surviving -shm would be recovered
  // against the replacement main DB on the next open, checkpointing frames
  // from the replaced generation into it -- silent corruption of exactly the
  // artifact repair restores. Checkpoint TRUNCATE first (data lands in the
  // main file, so the store stays serviceable if this process dies here),
  // then remove the WAL set while the maintenance lock still excludes
  // writers. The replacement is wal-less after its FULL checkpoint, so once
  // the rename lands there is no stale WAL to recover.
  if (!dbWasCorrupt) {
    try {
      const current = openDatabase(dbPath);
      try {
        current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        current.close();
      }
    } catch {
      /* the main DB may be unreadable; the rename below still replaces it */
    }
  }
  for (const suffix of ["-wal", "-shm"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }

  // R12: replace without first deleting the working database. rename over an
  // existing file is atomic on the same filesystem, and the temp DB is built
  // inside the store directory precisely for that guarantee (the old code
  // unlinked the target before renaming, so an interruption after the unlink
  // left the prior serviceable database gone). The WAL set was quiesced
  // above, so the swap cannot pair the new main file with stale WAL frames.
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${dbPath}${suffix}`;
    const source = `${tempDbPath}${suffix}`;
    if (fs.existsSync(source)) {
      fs.renameSync(source, target);
    } else if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
    }
  }
  // The temp replacement lives inside the store directory and every suffix
  // was renamed into place above; any leftover temp file (a failed suffix
  // rename) must still be cleaned individually -- never the store directory
  // itself.
  fs.rmSync(tempDbPath, { force: true });
  for (const suffix of ["-wal", "-shm"]) {
    fs.rmSync(`${tempDbPath}${suffix}`, { force: true });
  }

  return { status: "ok", dbWasCorrupt, eventsReplayed: allEntries.length };
}

/** One replayed event plus (for attested DB-only rows) its byte-preserving overrides. */
type ValidatedEntry = {
  entry: EventLogEntry;
  overrides?: { journalPath?: string; payloadJson?: string; causationJson?: string };
};

/**
 * T-119: validates one attested DB-only node and registers its pinned rows as
 * the node's validated event stream. The absent prefix (1 .. first attested
 * sequence - 1) is a DECLARED fact of the attestation, not a gap; everything
 * beyond the pinned rows would be new, unreviewed history and still fails
 * closed via the named-gap path.
 *
 * Verification against the database depends on the database's own state:
 * - intact database: its rows must equal the attestation exactly. Drift,
 *   loss (including the node having NO rows at all), or additions are
 *   refused -- an intact database losing attested rows is precisely the
 *   anomaly class repair must surface, never silently heal.
 * - corrupt or missing database: its rows prove nothing; the attestation is
 *   the sole source and the rebuild restores the pinned rows from it (the
 *   same independent-loss guarantee the journal carries). The watermark
 *   remains an independent witness even here: a watermark beyond the last
 *   attested sequence means the store once believed more history existed,
 *   and repair refuses rather than discarding that testimony.
 */
function validateAttestedNode(
  storeDir: string,
  nodeId: string,
  attestation: NodeAttestation,
  watermarks: Record<string, number>,
  dbFloor: Record<string, number>,
  dbWasCorrupt: boolean,
  gaps: RepairGap[],
  validatedByNode: Map<string, ValidatedEntry[]>
): void {
  const journalSequences = listJournalSequences(storeDir, nodeId);
  if (journalSequences.length > 0) {
    gaps.push({ nodeId, sequence: journalSequences[0], reason: "attested DB-only node has unexpected journal data" });
    return;
  }

  const lastAttested = attestation.rows[attestation.rows.length - 1].sequence;
  // The approval witness (store-meta.json watermark published at commit) is
  // REQUIRED, never optional: it is the independent testimony that survives
  // the attestation file being lost, and it keeps a file-only approval from
  // silently downgrading to no testimony. Equal = consistent testimony;
  // absent = refuse pending same-pin re-confirmation from an intact DB;
  // divergent = refuse pending separate adjudication, never overwrite it.
  if (watermarks[nodeId] !== lastAttested) {
    gaps.push({
      nodeId,
      sequence: attestation.rows[0].sequence,
      reason: watermarks[nodeId] === undefined
        ? `attested node lacks its approval witness watermark (expected ${lastAttested}); explicit re-approval required`
        : `attestation witness watermark (${watermarks[nodeId]}) diverges from the attested max sequence (${lastAttested}); refusing to overwrite testimony; separate reviewed recovery is required`
    });
    return;
  }

  const dbExists = fs.existsSync(StoreHandle.dbPathFor(storeDir));
  if (dbExists && !dbWasCorrupt) {
    if (dbFloor[nodeId] === undefined) {
      gaps.push({
        nodeId,
        sequence: attestation.rows[0].sequence,
        reason: `attested node has no rows in the intact database; attestation pins ${attestation.rows.length}`
      });
      return;
    }
    const mismatch = verifyAttestationAgainstDb(storeDir, attestation);
    if (mismatch) {
      gaps.push({ nodeId, sequence: attestation.rows[0].sequence, reason: mismatch });
      return;
    }
  }

  validatedByNode.set(
    nodeId,
    attestedEntries(attestation).map(({ journalPath, payloadJson, causationJson, ...entry }) => ({
      entry,
      overrides: { journalPath, payloadJson, causationJson }
    }))
  );
}
