import * as path from "path"
import { DatabaseSync } from "node:sqlite"
import type { EventLogEntry } from "@mapctx/protocol"
import { checkIntegrity, clearProjections, openDatabase, openDatabaseReadOnly, readMetaValue, schemaMaintenanceNeeded, writeMetaValue } from "./db"
import { applyEventToProjections } from "./events"
import { bumpSequenceWatermark, createStoreMeta, readSequenceWatermark, readStoreMetaFile, withStoreMetaLock, writeStoreMetaFile, type StoreMeta } from "./identity"
import { listJournalSequences, payloadSha256, readJournalEntry, writeJournalBatchSync, abortJournalBatchSync, type JournalPublicationError } from "./journal"
import { assertNotUnderMaintenance } from "./maintenance"

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
    // R12: repair swaps the database file; opening while a live process holds
    // the maintenance lock would interleave with the replacement.
    assertNotUnderMaintenance(storeDir);
    let meta = readStoreMetaFile(storeDir);
    if (!meta) {
      // Two concurrent first-opens must not each mint a nodeId: creation is
      // also read-check-write on store-meta.json, so it runs under the same
      // cross-process lock as the watermark, with a double-check inside.
      meta = withStoreMetaLock(storeDir, () => readStoreMetaFile(storeDir) ?? (() => {
        const created = createStoreMeta();
        writeStoreMetaFile(storeDir, created);
        return created;
      })());
    }
    const db = openDatabase(StoreHandle.dbPathFor(storeDir));
    writeMetaValue(db, "node_id", meta.nodeId);
    writeMetaValue(db, "incarnation_id", meta.incarnationId);
    const handle = new StoreHandle(storeDir, meta, db);
    try {
      handle.reindexPendingJournal();
      handle.reconcileSequenceWatermark();
      return handle;
    } catch (error) { db.close(); throw error; }
  }

  /**
   * Read-only open (R14): a diagnostic open that cannot mutate the store.
   * No migrations, no identity metadata writes, no journal replay, no
   * watermark reconciliation. Pending maintenance is surfaced explicitly
   * through maintenanceNeeded() instead of being silently applied -- a query
   * against a store that needs maintenance must say so, never mutate.
   */
  static openReadOnly(storeDir: string): StoreHandle {
    assertNotUnderMaintenance(storeDir);
    const meta = readStoreMetaFile(storeDir);
    if (!meta) {
      throw new Error(`Cannot open read-only: store not materialized at ${storeDir}. Run "mapctx store init" first.`);
    }
    const db = openDatabaseReadOnly(StoreHandle.dbPathFor(storeDir));
    return new StoreHandle(storeDir, meta, db);
  }

  /**
   * R14 read-only maintenance report: null when queries are safe, or a
   * named condition (schema maintenance, pending journal) a query should
   * surface instead of healing. Only meaningful on a read-only handle; the
   * writable open heals these itself.
   */
  maintenanceNeeded(): string | null {
    const schema = schemaMaintenanceNeeded(this.db);
    if (schema) return schema;
    let lastIndexed = 0;
    try {
      lastIndexed = this.lastIndexedSequence(this.nodeId);
    } catch {
      return "event_log unreadable (run repair)";
    }
    const pending = listJournalSequences(this.storeDir, this.nodeId).filter(seq => seq > lastIndexed);
    if (pending.length > 0) {
      return `journal holds ${pending.length} unindexed entr${pending.length === 1 ? "y" : "ies"} (run "mapctx store repair" to materialize)`;
    }
    return null;
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.reindexPendingJournalUnderLock();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private reindexPendingJournalUnderLock(): void {
    const lastIndexed = this.lastIndexedSequence(this.nodeId);
    const pending = listJournalSequences(this.storeDir, this.nodeId).filter(seq => seq > lastIndexed);
    let expected = lastIndexed + 1;
    let logicalClock = this.currentLogicalClock();
    for (const sequence of pending) {
      if (sequence !== expected++) throw new Error(`Journal gap: expected sequence ${expected - 1}, got ${sequence}`);
      const result = readJournalEntry(this.storeDir, this.nodeId, sequence);
      if (result.status !== "ok") {
        throw new Error(`Cannot reindex journal entry (${this.nodeId}, ${sequence}): ${result.status === "missing" ? "missing" : result.reason}`);
      }
      this.insertEventLogRow(result.entry);
      applyEventToProjections(this.db, result.entry);
      logicalClock = Math.max(logicalClock, result.entry.logicalClock);
    }
    writeMetaValue(this.db, "logical_clock", logicalClock);
  }

  private insertEventLogRow(entry: EventLogEntry): void {
    insertEventLogRow(this.db, entry);
  }

  /**
   * The watermark is bumped after COMMIT, so a crash (or a degraded metadata
   * write) can leave it behind the sequences mapctx.db actually holds. On
   * open the intact database is the floor of truth: re-persist the watermark
   * from it and clear the stale marker. This is also what makes a degraded
   * watermark recoverable instead of a permanent repair-contract hole.
   */
  private reconcileSequenceWatermark(): void {
    const dbMax = this.lastIndexedSequence(this.nodeId);
    if (dbMax > readSequenceWatermark(this.storeDir, this.nodeId)) {
      try { bumpSequenceWatermark(this.storeDir, this.nodeId, dbMax); }
      catch (error) {
        process.emitWarning(`Sequence watermark lags committed sequences (${dbMax}); update failed: ${String(error)}`);
        return;
      }
    }
    if (readMetaValue<string>(this.db, "watermark_stale") !== undefined) {
      this.db.prepare("DELETE FROM store_meta WHERE key = ?").run("watermark_stale");
    }
  }

  /**
   * Appends one event: reindexes any pending journal entries, allocates the
   * next (nodeId, sequence), validates/indexes its projection, then fsyncs
   * the journal before committing the SQLite transaction. The BEGIN IMMEDIATE write
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
    // R12: a write that started before repair acquired its lock, or against a
    // handle already open across the swap, must refuse rather than append
    // into a database inode repair is about to replace.
    assertNotUnderMaintenance(this.storeDir);
    const staged: EventLogEntry[] = [];
    let published: string | undefined;
    let appendFailure: unknown;
    let committed = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.reindexPendingJournalUnderLock();
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

        try {
          this.insertEventLogRow(entry);
          applyEventToProjections(this.db, entry);
          writeMetaValue(this.db, "logical_clock", logicalClock);
          staged.push(structuredClone(entry));
        } catch (error) { appendFailure = error; throw error; }
        return entry;
      };

      const result = fn(append);
      if (appendFailure) throw appendFailure;
      published = writeJournalBatchSync(this.storeDir, staged);
      this.db.exec("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      // A publication failure thrown by the journal writer carries the path
      // it had already made visible, so cleanup stays possible even though
      // `published` was never assigned (see writeJournalBatchSync). The
      // abort is idempotent: it removes the path (if still present) and
      // fsyncs the parent so a rejected transaction never replays.
      const leakedPath = published ?? (error as JournalPublicationError)?.publishedPath;
      let abortFailure: unknown;
      try { abortJournalBatchSync(leakedPath); } catch (abortError) { abortFailure = abortError; }
      try { this.db.exec("ROLLBACK"); } catch { /* the failed transaction is discarded either way */ }
      if (abortFailure) {
        throw new Error(`INDETERMINATE transaction outcome at ${this.storeDir}: the mutation was rejected (${String(error)}) but durable journal cleanup failed (${String(abortFailure)}); inspect ${path.join(this.storeDir, "events")} before retrying.`);
      }
      throw error;
    } finally {
      // Commit is already durable. A metadata failure must not turn accepted
      // work into an apparent rejected mutation that a caller might retry --
      // but a watermark left behind the committed sequences cannot silently
      // keep repair's independent-loss guarantee, so the store records an
      // explicit stale marker (cleared by the next open's reconciliation)
      // instead of a warning alone.
      if (committed) {
        try { bumpSequenceWatermark(this.storeDir, this.nodeId, this.lastIndexedSequence(this.nodeId)); }
        catch (error) {
          process.emitWarning(`Journal committed; watermark update failed: ${String(error)}`);
          try { writeMetaValue(this.db, "watermark_stale", this.nodeId); }
          catch { /* even the degraded marker could not be recorded */ }
        }
      }
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
