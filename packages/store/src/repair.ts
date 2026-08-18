import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { EventLogEntry } from "@mapctx/protocol"
import { checkIntegrity, openDatabase, writeMetaValue } from "./db"
import { applyEventToProjections } from "./events"
import { readStoreMetaFile } from "./identity"
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
export function repairStore(storeDir: string): RepairResult {
  const dbPath = StoreHandle.dbPathFor(storeDir);
  const dbWasCorrupt = fs.existsSync(dbPath) ? !checkIntegrity(dbPath) : false;

  // The watermark (persisted outside mapctx.db, bumped after every commit)
  // is the independent cross-check for "how far should this node's journal
  // go" -- directory listing alone cannot tell a fully-deleted trailing
  // file (or an entirely deleted events/<nodeId>/ directory) apart from
  // "nothing was ever written there".
  const watermarks = readStoreMetaFile(storeDir)?.sequenceWatermarks ?? {};
  const nodeIds = Array.from(new Set([...listJournalNodeIds(storeDir), ...Object.keys(watermarks)])).sort();
  const gaps: RepairGap[] = [];
  const validatedByNode = new Map<string, EventLogEntry[]>();

  for (const nodeId of nodeIds) {
    const sequences = listJournalSequences(storeDir, nodeId);
    const onDiskMax = sequences.length > 0 ? sequences[sequences.length - 1] : 0;
    const maxSequence = Math.max(onDiskMax, watermarks[nodeId] ?? 0);
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

  const tempDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-repair-")), "mapctx.db");
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

  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${dbPath}${suffix}`;
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    const source = `${tempDbPath}${suffix}`;
    if (fs.existsSync(source)) fs.renameSync(source, target);
  }
  fs.rmSync(path.dirname(tempDbPath), { recursive: true, force: true });

  return { status: "ok", dbWasCorrupt, eventsReplayed: allEntries.length };
}
