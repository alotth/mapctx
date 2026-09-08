import * as fs from "fs"
import * as path from "path"
import type { EventLogEntry } from "@mapctx/protocol"
import { checkIntegrity, openDatabase, writeMetaValue } from "./db"
import { applyEventToProjections } from "./events"
import { readStoreMetaFile } from "./identity"
import { acquireMaintenanceLock, assertNotUnderMaintenance } from "./maintenance"
import { listJournalNodeIds, listJournalSequences, readJournalEntry } from "./journal"
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
function intactDatabaseFloor(dbPath: string, dbWasCorrupt: boolean): Record<string, number> {
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
  const nodeIds = Array.from(new Set([...listJournalNodeIds(storeDir), ...Object.keys(watermarks)])).sort();
  const gaps: RepairGap[] = [];
  const validatedByNode = new Map<string, EventLogEntry[]>();

  for (const nodeId of nodeIds) {
    const sequences = listJournalSequences(storeDir, nodeId);
    const onDiskMax = sequences.length > 0 ? sequences[sequences.length - 1] : 0;
    const maxSequence = Math.max(onDiskMax, watermarks[nodeId] ?? 0, dbFloor[nodeId] ?? 0);
    const validated: EventLogEntry[] = [];

    for (let sequence = 1; sequence <= maxSequence; sequence++) {
      const result = readJournalEntry(storeDir, nodeId, sequence);
      if (result.status === "ok") {
        validated.push(result.entry);
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

  const allEntries = ([] as EventLogEntry[])
    .concat(...validatedByNode.values())
    .sort((a, b) => a.logicalClock - b.logicalClock || a.nodeId.localeCompare(b.nodeId) || a.sequence - b.sequence);

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
      for (const entry of allEntries) {
        insertEventLogRow(tempDb, entry);
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

  // R12: replace without first deleting the working database. rename over an
  // existing file is atomic on the same filesystem, and the temp DB is built
  // inside the store directory precisely for that guarantee (the old code
  // unlinked the target before renaming, so an interruption after the unlink
  // left the prior serviceable database gone). The temp DB was checkpointed
  // and closed, so the old -wal/-shm files belong to the replaced inode and
  // are removed; a suffix rename happens only when the replacement has one.
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
