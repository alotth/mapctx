import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { canonicalJson } from "@mapctx/protocol"
import type { EventLogEntry } from "@mapctx/protocol"

export const JOURNAL_DIR_NAME = "events"

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
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const content = canonicalJson(entry)

  const fd = fs.openSync(tmpPath, "w")
  try {
    fs.writeSync(fd, content, null, "utf8")
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, finalPath)

  try {
    const dirFd = fs.openSync(dir, "r")
    try {
      fs.fsyncSync(dirFd)
    } finally {
      fs.closeSync(dirFd)
    }
  } catch {
    // Some platforms/filesystems reject fsync on a directory fd; the rename
    // itself is already durable on those, so this is best-effort only.
  }

  return finalPath
}

export type JournalReadResult =
  | { status: "ok"; entry: EventLogEntry }
  | { status: "missing"; sequence: number }
  | { status: "corrupt"; sequence: number; reason: string }

export function readJournalEntry(storeDir: string, nodeId: string, sequence: number): JournalReadResult {
  const filePath = journalEntryPath(storeDir, nodeId, sequence)
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
  return fs.readdirSync(dir)
    .filter(name => /^\d+\.json$/.test(name))
    .map(name => Number(name.slice(0, -".json".length)))
    .sort((a, b) => a - b)
}

export function listJournalNodeIds(storeDir: string): string[] {
  const root = path.join(storeDir, JOURNAL_DIR_NAME)
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root).filter(name => fs.statSync(path.join(root, name)).isDirectory())
}
