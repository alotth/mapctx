import * as path from "path"
import { DatabaseSync } from "node:sqlite"
import type { EventLogEntry } from "@mapctx/protocol"
import { checkIntegrity, clearProjections, openDatabase, readMetaValue, writeMetaValue } from "./db"
import { applyEventToProjections } from "./events"
import { bumpSequenceWatermark, createStoreMeta, readStoreMetaFile, writeStoreMetaFile, type StoreMeta } from "./identity"
import { listJournalSequences, payloadSha256, readJournalEntry, writeJournalEntrySync } from "./journal"

export type AppendEventInput = {
  eventType: string;
  schemaVersion?: number;
  actor: string;
  causation?: EventLogEntry["causation"];
  occurredAt?: string;
  payload: Record<string, unknown>;
};

export type JournalGap = {
  nodeId: string;
  sequence: number;
  reason: string;
};

const DB_FILENAME = "mapctx.db";

export class StoreHandle {
  readonly storeDir: string;
  readonly nodeId: string;
  readonly incarnationId: string;
  readonly db: DatabaseSync;

  private constructor(storeDir: string, meta: StoreMeta, db: DatabaseSync) {
    this.storeDir = storeDir;
    this.nodeId = meta.nodeId;
    this.incarnationId = meta.incarnationId;
    this.db = db;
  }

  static dbPathFor(storeDir: string): string {
    return path.join(storeDir, DB_FILENAME);
  }

  /**
   * Opens (materializing on first use) the store at storeDir. Always
   * reindexes any journal entries that are on disk but not yet reflected in
   * event_log before returning, so a crash between journal fsync and SQLite
   * commit is transparently healed.
   */
  static open(storeDir: string): StoreHandle {
    let meta = readStoreMetaFile(storeDir);
    if (!meta) {
      meta = createStoreMeta();
      writeStoreMetaFile(storeDir, meta);
    }
    const db = openDatabase(StoreHandle.dbPathFor(storeDir));
    writeMetaValue(db, "node_id", meta.nodeId);
    writeMetaValue(db, "incarnation_id", meta.incarnationId);
    const handle = new StoreHandle(storeDir, meta, db);
    handle.reindexPendingJournal();
    return handle;
  }

  close(): void {
    this.db.close();
  }

  private lastIndexedSequence(nodeId: string): number {
    const row = this.db.prepare(
      "SELECT MAX(sequence) as max_sequence FROM event_log WHERE node_id = ?"
    ).get(nodeId) as { max_sequence: number | null };
    return row?.max_sequence ?? 0;
  }

  private currentLogicalClock(): number {
    return readMetaValue<number>(this.db, "logical_clock") ?? 0;
  }

  /**
   * Replays journal entries present on disk but missing from event_log
   * (the durable-but-uncommitted window between fsync and SQLite COMMIT).
   * Runs inside its own write transaction so it composes safely with a
   * concurrent appendEvent from another process (SQLite serializes both).
   */
  reindexPendingJournal(): void {
    const lastIndexed = this.lastIndexedSequence(this.nodeId);
    const onDisk = listJournalSequences(this.storeDir, this.nodeId);
    const pending = onDisk.filter(seq => seq > lastIndexed);
    if (pending.length === 0) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      let logicalClock = this.currentLogicalClock();
      for (const sequence of pending) {
        const result = readJournalEntry(this.storeDir, this.nodeId, sequence);
        if (result.status !== "ok") {
          throw new Error(
            `Cannot reindex journal entry (${this.nodeId}, ${sequence}): ${result.status === "missing" ? "missing" : result.reason}`
          );
        }
        this.insertEventLogRow(result.entry);
        applyEventToProjections(this.db, result.entry);
        logicalClock = Math.max(logicalClock, result.entry.logicalClock);
      }
      writeMetaValue(this.db, "logical_clock", logicalClock);
      this.db.exec("COMMIT");
      bumpSequenceWatermark(this.storeDir, this.nodeId, pending[pending.length - 1]);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertEventLogRow(entry: EventLogEntry): void {
    insertEventLogRow(this.db, entry);
  }

  /**
   * Appends one event: reindexes any pending journal entries, allocates the
   * next (nodeId, sequence), fsyncs the journal file, then indexes and
   * projects it in the same SQLite transaction. The BEGIN IMMEDIATE write
   * lock (busy_timeout-bounded) is what serializes concurrent worktrees --
   * a second writer blocks or gets SQLITE_BUSY, never a second winner.
   */
  appendEvent(input: AppendEventInput): EventLogEntry {
    return this.runInWriteTransaction(append => append(input));
  }

  /**
   * Runs fn under one BEGIN IMMEDIATE transaction, after first reindexing
   * any pending journal entries. fn receives an `append` callback that can
   * be invoked any number of times to append events atomically alongside
   * whatever reads fn does against `this.db` -- the primitive claim/renew/
   * release build on, since those need a read-then-decide-then-write that
   * cannot tolerate another writer interleaving between the read and the
   * write (see claims.ts).
   */
  runInWriteTransaction<T>(fn: (append: (input: AppendEventInput) => EventLogEntry) => T): T {
    this.reindexPendingJournal();

    let maxSequenceWritten = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const append = (input: AppendEventInput): EventLogEntry => {
        const sequence = this.lastIndexedSequence(this.nodeId) + 1;
        const logicalClock = this.currentLogicalClock() + 1;
        const entry: EventLogEntry = {
          nodeId: this.nodeId,
          sequence,
          logicalClock,
          eventType: input.eventType,
          schemaVersion: input.schemaVersion ?? 1,
          occurredAt: input.occurredAt ?? new Date().toISOString(),
          actor: input.actor,
          causation: input.causation ?? [],
          payload: input.payload,
          payloadSha256: payloadSha256(input.payload)
        };

        writeJournalEntrySync(this.storeDir, entry);
        this.insertEventLogRow(entry);
        applyEventToProjections(this.db, entry);
        writeMetaValue(this.db, "logical_clock", logicalClock);
        maxSequenceWritten = Math.max(maxSequenceWritten, sequence);
        return entry;
      };

      const result = fn(append);
      this.db.exec("COMMIT");
      if (maxSequenceWritten > 0) {
        bumpSequenceWatermark(this.storeDir, this.nodeId, maxSequenceWritten);
      }
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listEvents(): EventLogEntry[] {
    const rows = this.db.prepare(
      "SELECT * FROM event_log ORDER BY logical_clock ASC, node_id ASC, sequence ASC"
    ).all() as Record<string, unknown>[];
    return rows.map(rowToEventLogEntry);
  }
}

function rowToEventLogEntry(row: Record<string, unknown>): EventLogEntry {
  return {
    nodeId: row.node_id as string,
    sequence: row.sequence as number,
    logicalClock: row.logical_clock as number,
    eventType: row.event_type as string,
    schemaVersion: row.schema_version as number,
    occurredAt: row.occurred_at as string,
    actor: row.actor as string,
    causation: JSON.parse(row.causation_json as string),
    payload: JSON.parse(row.payload_json as string),
    payloadSha256: row.payload_sha256 as string
  };
}

export function storeDbIntegrityOk(storeDir: string): boolean {
  return checkIntegrity(StoreHandle.dbPathFor(storeDir));
}

export function resetProjectionsForRebuild(db: DatabaseSync): void {
  clearProjections(db);
}

export function insertEventLogRow(db: DatabaseSync, entry: EventLogEntry): void {
  db.prepare(`
    INSERT INTO event_log (
      node_id, sequence, logical_clock, event_type, schema_version, occurred_at,
      actor, causation_json, payload_json, payload_sha256, journal_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.nodeId,
    entry.sequence,
    entry.logicalClock,
    entry.eventType,
    entry.schemaVersion,
    entry.occurredAt,
    entry.actor,
    JSON.stringify(entry.causation),
    JSON.stringify(entry.payload),
    entry.payloadSha256,
    path.join("events", entry.nodeId, `${entry.sequence}.json`)
  );
}
