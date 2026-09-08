import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { canonicalJson } from "@mapctx/protocol"
import type { EventLogEntry } from "@mapctx/protocol"

export const JOURNAL_DIR_NAME = "events"

/**
 * A publication failure whose published path is attached so the caller's
 * durable abort can still remove what the failed write made visible --
 * writeJournalBatchSync throws before it can return the path itself.
 */
export type JournalPublicationError = Error & { publishedPath?: string }

/** Unlink/rmdir only unlinks the directory entry; until the parent
 *  directory is fsynced, a crash can resurrect the file and turn a rejected
 *  mutation into a replayed one. Every failed-publication cleanup goes
 *  through here. If the removal itself cannot be made durable, the outcome
 *  is indeterminate and must surface as fail-stop, never as an ordinary
 *  rejection a caller would safely retry. */
export function abortJournalBatchSync(published: string | undefined): void {
  if (!published) return;
  fs.rmSync(published, { recursive: true, force: true });
  syncDirectory(path.dirname(published));
}

export function journalDirFor(storeDir: string, nodeId: string): string {
  return path.join(storeDir, JOURNAL_DIR_NAME, nodeId)
}

export function journalEntryPath(storeDir: string, nodeId: string, sequence: number): string {
  return path.join(journalDirFor(storeDir, nodeId), `${sequence}.json`)
}

export function payloadSha256(payload: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex")
}

/**
 * Writes one journal entry via write-temp -> fsync -> rename, then fsyncs the
 * containing directory. This must complete (and be durable) before the
 * caller's SQLite index/projection transaction commits, so a crash between
 * the two never leaves an indexed event without a recoverable journal file.
 */
export function writeJournalEntrySync(storeDir: string, entry: EventLogEntry): string {
  const dir = journalDirFor(storeDir, entry.nodeId)
  fs.mkdirSync(dir, { recursive: true })
  const finalPath = journalEntryPath(storeDir, entry.nodeId, entry.sequence)
  if (fs.existsSync(committedEntryPath(storeDir, entry.nodeId, entry.sequence))) throw new Error(`EEXIST: journal identity ${entry.sequence}`)
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const content = canonicalJson(entry)

  const fd = fs.openSync(tmpPath, "w")
  try {
    fs.writeSync(fd, content, null, "utf8")
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.linkSync(tmpPath, finalPath); // Exclusive publication: never replace an identity.
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }

  try {
    syncDirectory(dir);
  } catch (error) {
    // The entry was published but never made durable. Remove it and fsync
    // the removal so the rejected transaction leaves nothing replayable;
    // carry the path so the caller's abort stays possible.
    fs.rmSync(finalPath, { force: true });
    const published: JournalPublicationError = Object.assign(
      new Error(`Journal publication fsync failed for ${finalPath}: ${(error as Error).message}`),
      { publishedPath: finalPath }
    );
    try {
      syncDirectory(dir);
    } catch (cleanupError) {
      throw Object.assign(
        new Error(`INDETERMINATE journal state at ${finalPath}: publication fsync failed (${(error as Error).message}) and durable cleanup failed (${(cleanupError as Error).message}); stop and inspect the store before retrying.`),
        { publishedPath: finalPath }
      );
    }
    throw published;
  }

  return finalPath
}

export type JournalReadResult =
  | { status: "ok"; entry: EventLogEntry }
  | { status: "missing"; sequence: number }
  | { status: "corrupt"; sequence: number; reason: string }

export function readJournalEntry(storeDir: string, nodeId: string, sequence: number): JournalReadResult {
  const filePath = committedEntryPath(storeDir, nodeId, sequence)
  if (!fs.existsSync(filePath)) {
    return { status: "missing", sequence }
  }
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf8")
  } catch (error) {
    return { status: "corrupt", sequence, reason: `unreadable: ${(error as Error).message}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { status: "corrupt", sequence, reason: `invalid JSON: ${(error as Error).message}` }
  }
  const entry = parsed as EventLogEntry
  if (entry.nodeId !== nodeId || entry.sequence !== sequence) {
    return { status: "corrupt", sequence, reason: "identity mismatch between filename and payload" }
  }
  const expectedHash = payloadSha256(entry.payload)
  if (expectedHash !== entry.payloadSha256) {
    return { status: "corrupt", sequence, reason: "payload hash mismatch" }
  }
  return { status: "ok", entry }
}

/**
 * Lists every sequence number physically present under events/<nodeId>/,
 * sorted numerically. Does not validate content -- callers that need
 * validated entries should call readJournalEntry per sequence.
 */
export function listJournalSequences(storeDir: string, nodeId: string): number[] {
  const dir = journalDirFor(storeDir, nodeId)
  if (!fs.existsSync(dir)) return []
  const sequences: number[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (/^\d+\.json$/.test(name)) sequences.push(Number(name.slice(0, -5)));
    const batch = /^batch-(\d+)-(\d+)$/.exec(name);
    if (batch) {
      for (let seq = Number(batch[1]); seq <= Number(batch[2]); seq++) sequences.push(seq);
    }
  }
  if (new Set(sequences).size !== sequences.length) throw new Error("Duplicate journal identity");
  return sequences.sort((a, b) => a - b);
}

export function listJournalNodeIds(storeDir: string): string[] {
  const root = path.join(storeDir, JOURNAL_DIR_NAME)
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root).filter(name => fs.statSync(path.join(root, name)).isDirectory())
}

// Multi-event batches are staged in an invisible directory. One rename makes
// every entry visible together. Legacy single files remain readable/reparable.
function committedEntryPath(storeDir: string, nodeId: string, sequence: number): string {
  const dir = journalDirFor(storeDir, nodeId);
  const candidates = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => {
    const match = /^batch-(\d+)-(\d+)$/.exec(name);
    return match && sequence >= Number(match[1]) && sequence <= Number(match[2]);
  }).map(name => path.join(dir, name, `${sequence}.json`)) : [];
  const legacy = journalEntryPath(storeDir, nodeId, sequence);
  if (fs.existsSync(legacy)) candidates.push(legacy);
  if (candidates.length > 1) throw new Error(`Duplicate journal identity: ${nodeId}/${sequence}`);
  return candidates[0] ?? legacy;
}

function syncDirectory(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Caller holds the SQLite writer lock through publication and commit/abort. */
export function writeJournalBatchSync(storeDir: string, entries: EventLogEntry[]): string | undefined {
  if (!entries.length) return undefined;
  const first = entries[0];
  const dir = journalDirFor(storeDir, first.nodeId);
  fs.mkdirSync(dir, { recursive: true });
  const existing = new Set(listJournalSequences(storeDir, first.nodeId));
  entries.forEach((entry, index) => {
    if (entry.nodeId !== first.nodeId || entry.sequence !== first.sequence + index) throw new Error("Noncontiguous journal batch");
    if (existing.has(entry.sequence)) throw new Error(`Journal identity already exists: ${entry.sequence}`);
  });
  if (entries.length === 1) return writeJournalEntrySync(storeDir, first);
  const staged = fs.mkdtempSync(path.join(dir, ".staged-"));
  const published = path.join(dir, `batch-${first.sequence}-${entries[entries.length - 1].sequence}`);
  try {
    for (const entry of entries) {
      const fd = fs.openSync(path.join(staged, `${entry.sequence}.json`), "wx");
      try { fs.writeFileSync(fd, canonicalJson(entry)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    syncDirectory(staged);
    fs.renameSync(staged, published);
    try {
      syncDirectory(dir);
    } catch (error) {
      // Same durable-abort contract as the single-entry path: remove the
      // published batch, fsync the parent, and surface INDETERMINATE only
      // when even the cleanup cannot be made durable.
      fs.rmSync(published, { recursive: true, force: true });
      const publicationError: JournalPublicationError = Object.assign(
        new Error(`Journal batch publication fsync failed for ${published}: ${(error as Error).message}`),
        { publishedPath: published }
      );
      try {
        syncDirectory(dir);
      } catch (cleanupError) {
        throw Object.assign(
          new Error(`INDETERMINATE journal state at ${published}: publication fsync failed (${(error as Error).message}) and durable cleanup failed (${(cleanupError as Error).message}); stop and inspect the store before retrying.`),
          { publishedPath: published }
        );
      }
      throw publicationError;
    }
    return published;
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}
