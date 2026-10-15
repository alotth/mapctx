import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { DatabaseSync } from "node:sqlite"
import { getMapctxHome } from "@mapctx/core/workspace"
import { checkIntegrity, openDatabaseReadOnly, readMetaValue, setPreMigrationSnapshot } from "./db"
import { JOURNAL_DIR_NAME, listJournalNodeIds, listJournalSequences } from "./journal"
import { acquireMaintenanceLock, assertNotUnderMaintenance, MAINTENANCE_LOCK_FILENAME } from "./maintenance"
import { MIGRATIONS } from "./schema"
import { verifyRedactionsFromLedger } from "./redact"

/**
 * T-138: the store's own backup/restore.
 *
 * Until now the only recovery path was `mapctx store init`, which rebuilds
 * from the last TASKS.md checkpoint and throws away every event older than
 * it. That is a floor, not a backup: it loses claims, dispatches, receipts,
 * cost data and the whole audit trail. It is also the thing standing between
 * this project and turning Git snapshots off (roadmap M1 / ADR 0005).
 *
 * ---------------------------------------------------------------------------
 * Why the copy ORDER is the whole correctness argument
 * ---------------------------------------------------------------------------
 * A store is two durable halves: `mapctx.db` (SQLite, WAL mode) and the
 * append-only journal under `events/<nodeId>/<sequence>.json`. Writes are
 * JOURNAL-FIRST: `writeJournalEntrySync` fsyncs the entry before the SQLite
 * commit, so at every instant
 *
 *     journal ⊇ event_log
 *
 * and `StoreHandle.open` heals the difference by replaying journal entries
 * that the database has not indexed yet (`reindexPendingJournal`).
 *
 * That asymmetry decides the order. A backup is restorable when its journal
 * is a SUPERSET of its database -- the extra entries simply replay. It is
 * unrecoverable the other way round: a row in `event_log` whose journal file
 * is absent is a GAP, and `store repair` refuses a gap rather than inventing
 * the missing payload.
 *
 * So: snapshot the DATABASE FIRST, then copy the journal. Anything a
 * concurrent writer appends in between lands in the journal half, ahead of
 * the database snapshot, and replays on restore. Copying the journal first
 * would let the database snapshot contain events whose journal files were
 * written after the journal copy -- a backup that looks fine and cannot be
 * restored. `backup.test.ts` pins this with a writer running during the
 * backup, and flipping the order is one of the mutations.
 *
 * This is also why a backup does NOT take the maintenance lock. That lock
 * exists to exclude openers while `repair` swaps the database inode, and
 * holding it would make every reader in every worktree fail for the duration
 * of a copy. `VACUUM INTO` already gives a transactionally consistent copy
 * from a read snapshot without blocking writers, and the ordering argument
 * above covers the journal. Restore is the opposite case and does take the
 * lock: it replaces the store.
 *
 * ---------------------------------------------------------------------------
 * Interaction with T-126 redaction -- read this before trusting a backup
 * ---------------------------------------------------------------------------
 * `mapctx redact` destroys a value in the live journal, database and
 * projections. It cannot reach into a backup taken BEFORE it: that archive
 * still holds the plaintext. A backup is therefore a copy of the store's
 * privacy state at that moment, and an old one can resurrect a redacted
 * secret if restored. `redact --commit` warns when backups exist, and
 * `manifest.redactionCount` records how many redactions the store had
 * applied when the backup was taken, so an operator can tell an archive that
 * predates a redaction from one that follows it.
 */

export const BACKUP_MANIFEST_FILENAME = "manifest.json"
export const BACKUP_MANIFEST_SCHEMA_VERSION = 1

/** Highest schema version this binary knows how to run. */
export function currentSchemaVersion(): number {
  return MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0)
}

/**
 * Why a file is in the archive.
 * - `canonical`: losing it loses facts (the database, the journal, identity,
 *   attestations). Restore verifies every one of these and refuses on
 *   mismatch.
 * - `derived`: a cache that any later command can rebuild. Restored when
 *   present and verified like the rest, but its absence is not an error.
 */
export type BackupFileRole = "canonical" | "derived"

export type BackupFileEntry = {
  /** Path relative to the backup directory, always POSIX-separated. */
  path: string
  role: BackupFileRole
  bytes: number
  sha256: string
}

export type BackupManifest = {
  manifestVersion: number
  /**
   * Schema version of the BINARY that wrote the backup (its newest known
   * migration); restore refuses a NEWER one. This is not the archived store's
   * schema: a pre-migration snapshot is written by a binary one migration
   * ahead of the database it holds -- read `storeSchemaVersion` for that.
   */
  schemaVersion: number
  /**
   * Schema version of the archived database itself (MAX(version) of its
   * schema_migrations). On a pre-migration snapshot this is the version BEFORE
   * the pending migration. Absent in manifests written before it existed.
   */
  storeSchemaVersion?: number
  projectId: string | null
  nodeId: string | null
  incarnationId: string | null
  createdAt: string
  /** `operator` for an explicit `store backup`, otherwise what triggered it. */
  reason: BackupReason
  /** Rows in event_log at snapshot time -- cross-checked after restore. */
  eventCount: number
  /** Journal entries copied, per node id. */
  journalCounts: Record<string, number>
  /** Redactions applied at backup time (see the T-126 note above). */
  redactionCount: number
  files: BackupFileEntry[]
}

export type BackupReason = "operator" | "pre-migration" | "pre-repair"

/** Auto-snapshots are prunable; an operator backup never is. */
const AUTO_REASONS: ReadonlySet<BackupReason> = new Set<BackupReason>(["pre-migration", "pre-repair"])

export const DEFAULT_AUTO_BACKUP_RETENTION = 5

export function backupsRootFor(projectId: string): string {
  return path.join(getMapctxHome(), "backups", projectId)
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

function toPosix(relPath: string): string {
  return relPath.split(path.sep).join("/")
}

/**
 * Files that are never part of a backup:
 * - the WAL/SHM sidecars: `VACUUM INTO` folds the WAL into the copy, and a
 *   stale sidecar next to a restored database is actively dangerous;
 * - the maintenance lock: a restored lock would brick the new store;
 * - `mapctx.db.rebuild-*`: abandoned temp files from interrupted repairs
 *   (there are real ones in live stores today).
 */
function isExcludedStoreFile(name: string): boolean {
  return name.endsWith("-wal")
    || name.endsWith("-shm")
    || name === MAINTENANCE_LOCK_FILENAME
    || name.startsWith("mapctx.db.rebuild-")
    || name === BACKUP_MANIFEST_FILENAME
}

const DERIVED_FILENAMES: ReadonlySet<string> = new Set(["history-dates.json"])

export type CreateBackupOptions = {
  storeDir: string
  /** Target directory; created fresh. Defaults under ~/.mapctx/backups. */
  outDir?: string
  projectId?: string | null
  reason?: BackupReason
  now?: () => Date
  /**
   * Pre-opened database to snapshot through. The migration hook passes the
   * handle it already holds, so a pre-migration snapshot never re-opens (and
   * never re-enters the migration runner).
   */
  db?: DatabaseSync
  /**
   * Set only by `repair`, which holds the maintenance lock and snapshots
   * inside it. Every other caller must be refused under an active lock.
   */
  underMaintenanceLock?: boolean
}

export type CreateBackupResult = {
  backupDir: string
  manifest: BackupManifest
  /** Auto-snapshot directories pruned by retention. */
  pruned: string[]
}

function readCountSafely(db: DatabaseSync, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { n?: unknown } | undefined
    return typeof row?.n === "number" ? row.n : 0
  } catch {
    // A store whose schema predates a table still backs up; the count is
    // metadata, not a precondition.
    return 0
  }
}

/**
 * Snapshots the store into a new directory and writes a verifiable manifest.
 * Writers are not blocked (see the header). Returns the manifest it wrote.
 */
export function createBackup(options: CreateBackupOptions): CreateBackupResult {
  const now = options.now ?? (() => new Date())
  const storeDir = path.resolve(options.storeDir)
  const dbPath = path.join(storeDir, "mapctx.db")
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Cannot back up: no store at ${storeDir} (expected ${dbPath}). Run "mapctx store init" first.`)
  }
  // A backup must not run while SOMEONE ELSE is swapping the database inode:
  // the copy would straddle the swap. `repair` is the one legitimate caller
  // that already holds the lock and snapshots inside it, so it opts out of
  // this check rather than deadlocking against itself.
  if (!options.underMaintenanceLock) assertNotUnderMaintenance(storeDir)

  const reason: BackupReason = options.reason ?? "operator"
  const stamp = now().toISOString().replace(/[:.]/g, "-")
  const projectId = options.projectId ?? null
  const backupDir = options.outDir
    ? path.resolve(options.outDir)
    : path.join(backupsRootFor(projectId ?? "unknown-project"), `${reason}-${stamp}`)
  if (fs.existsSync(backupDir) && fs.readdirSync(backupDir).length > 0) {
    throw new Error(`Cannot back up: ${backupDir} already exists and is not empty.`)
  }
  // Build in a sibling temp directory and rename, so an interrupted backup
  // never leaves a half-written archive that looks complete.
  const stagingDir = `${backupDir}.partial-${process.pid}`
  fs.rmSync(stagingDir, { recursive: true, force: true })
  fs.mkdirSync(stagingDir, { recursive: true })

  try {
    const ownDb = options.db === undefined
    const db = options.db ?? openDatabaseReadOnly(dbPath)
    const target = path.join(stagingDir, "mapctx.db")
    try {
      // ---- STEP 1: the database, FIRST (see the ordering argument above).
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
    } finally {
      if (ownDb) db.close()
    }

    // The counts describe the SNAPSHOT, so they are read from the copy -- not
    // from the live database, which a concurrent writer has already moved on
    // from by now. Reading them from the live handle made `eventCount`
    // describe a state the archive does not contain, and in turn made
    // `replayedJournalEntries` report 0 while entries really did replay.
    let eventCount = 0
    let redactionCount = 0
    let storeSchemaVersion = 0
    let nodeId: string | null = null
    let incarnationId: string | null = null
    const snapshot = openDatabaseReadOnly(target)
    try {
      eventCount = readCountSafely(snapshot, "SELECT count(*) AS n FROM event_log")
      redactionCount = readCountSafely(snapshot, "SELECT count(*) AS n FROM redaction_projection")
      storeSchemaVersion = readCountSafely(snapshot, "SELECT max(version) AS n FROM schema_migrations")
      nodeId = readMetaValue<string>(snapshot, "node_id") ?? null
      incarnationId = readMetaValue<string>(snapshot, "incarnation_id") ?? null
    } finally {
      snapshot.close()
    }

    // ---- STEP 2: the journal, SECOND. Entries a writer appended during
    // step 1 are copied here and replay on restore.
    //
    // The tree is copied RECURSIVELY rather than rebuilt from sequence
    // numbers. The first version reconstructed `events/<node>/<seq>.json` for
    // each sequence `listJournalSequences` reported -- but that function
    // enumerates TWO layouts: flat `<seq>.json` files and `batch-<lo>-<hi>/`
    // directories whose sequences it expands. A multi-event transaction
    // (`runInWriteTransaction` with more than one append, which is what claim,
    // violations and import all do) stages its entries in a batch directory
    // so one rename makes them visible together. Every such entry was an
    // ENOENT: `store backup` threw on the operator's own store, and
    // `autoSnapshot` -- non-fatal by design -- swallowed it, so migration and
    // repair proceeded with NO rollback point. Review ALTO-1.
    //
    // Copying the directory as it is preserves whatever layout the journal
    // uses, now and later, and `walkFiles` hashes everything staged, so
    // verify and restore need no knowledge of the layout at all.
    const journalRoot = path.join(storeDir, JOURNAL_DIR_NAME)
    if (fs.existsSync(journalRoot)) {
      fs.cpSync(journalRoot, path.join(stagingDir, JOURNAL_DIR_NAME), { recursive: true })
    }
    // Counts still come from the journal module, which understands both
    // layouts; they describe entries, not files.
    const journalCounts: Record<string, number> = {}
    for (const node of listJournalNodeIds(storeDir)) {
      journalCounts[node] = listJournalSequences(storeDir, node).length
    }

    // ---- STEP 2b: the redaction-skew gate (review ALTO-2).
    //
    // The copy-order argument covers a writer that APPENDS. It does not cover
    // `mapctx redact`, which REWRITES an already-published entry: it commits
    // the redaction event, UPDATEs event_log, scrubs the projections, and
    // only then rewrites the journal entry. If that lands between STEP 1 and
    // STEP 2, the archive ends up with a PRE-redaction database and a
    // POST-redaction journal.
    //
    // The result verified, restored, reported `maintenanceNeeded: null`, and
    // served the plaintext again -- while its restored ledger claimed the
    // redaction had been applied. Worse, `manifest.redactionCount` read 0, so
    // the very field the design offers for telling a pre-redaction archive
    // from a post-redaction one pointed the wrong way.
    //
    // Running T-126's `verifyRedactionsFromLedger` over the archive does NOT
    // catch this particular window on its own: the archive's ledger comes
    // from the pre-redaction database, so there is nothing in it to check.
    // The detection that works is comparing the live store's redaction count
    // against the snapshot's AFTER the journal copy. The verifier runs too,
    // for the general class of ledger/journal divergence.
    const liveRedactionCount = (() => {
      const live = openDatabaseReadOnly(dbPath)
      try {
        return readCountSafely(live, "SELECT count(*) AS n FROM redaction_projection")
      } finally {
        live.close()
      }
    })()
    if (liveRedactionCount !== redactionCount) {
      throw new Error(
        `Refusing to write this backup: a redaction was applied while it was being taken`
        + ` (the store had ${redactionCount} redaction(s) when the database was snapshotted and ${liveRedactionCount} after the journal was copied).`
        + ` The archive's database would predate the redaction while its journal follows it, which restores as a store that serves the destroyed value`
        + ` while claiming the redaction was applied. Nothing was written; re-run the backup.`
      )
    }
    const archiveDb = openDatabaseReadOnly(path.join(stagingDir, "mapctx.db"))
    let archiveRedactionProblem: string | null = null
    try {
      const verified = verifyRedactionsFromLedger(stagingDir, archiveDb)
      if (verified.problems.length > 0) {
        const first = verified.problems[0]
        archiveRedactionProblem = `${first.nodeId}/${first.sequence} (${first.reason})`
      }
    } finally {
      archiveDb.close()
    }
    if (archiveRedactionProblem) {
      throw new Error(
        `Refusing to write this backup: its journal and redaction ledger disagree at ${archiveRedactionProblem}.`
        + ` Nothing was written.`
      )
    }

    // ---- STEP 3: the loose files beside the database.
    for (const entry of fs.readdirSync(storeDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === "mapctx.db" || isExcludedStoreFile(entry.name)) continue
      fs.copyFileSync(path.join(storeDir, entry.name), path.join(stagingDir, entry.name))
    }

    const files: BackupFileEntry[] = []
    for (const relPath of walkFiles(stagingDir)) {
      const absolute = path.join(stagingDir, relPath)
      files.push({
        path: toPosix(relPath),
        role: DERIVED_FILENAMES.has(path.basename(relPath)) ? "derived" : "canonical",
        bytes: fs.statSync(absolute).size,
        sha256: sha256File(absolute)
      })
    }
    files.sort((a, b) => a.path.localeCompare(b.path))

    const manifest: BackupManifest = {
      manifestVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
      schemaVersion: currentSchemaVersion(),
      storeSchemaVersion,
      projectId,
      nodeId,
      incarnationId,
      createdAt: now().toISOString(),
      reason,
      eventCount,
      journalCounts,
      redactionCount,
      files
    }
    fs.writeFileSync(path.join(stagingDir, BACKUP_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

    fs.mkdirSync(path.dirname(backupDir), { recursive: true })
    fs.rmSync(backupDir, { recursive: true, force: true })
    fs.renameSync(stagingDir, backupDir)

    const pruned = AUTO_REASONS.has(reason) && !options.outDir && projectId
      ? pruneAutoBackups(projectId, DEFAULT_AUTO_BACKUP_RETENTION)
      : []
    return { backupDir, manifest, pruned }
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true })
    throw error
  }
}

function walkFiles(root: string, prefix = ""): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relPath = path.join(prefix, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(root, relPath))
    else if (entry.isFile() && entry.name !== BACKUP_MANIFEST_FILENAME) out.push(relPath)
  }
  return out
}

/**
 * Retention for AUTO snapshots only. An operator backup is never pruned: the
 * one thing worse than no backup is a backup policy that deletes the archive
 * somebody made on purpose.
 */
export function pruneAutoBackups(projectId: string, keep: number): string[] {
  const root = backupsRootFor(projectId)
  if (!fs.existsSync(root)) return []
  const candidates: Array<{ dir: string; createdAt: string }> = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const manifest = tryReadManifest(dir)
    if (!manifest || !AUTO_REASONS.has(manifest.reason)) continue
    candidates.push({ dir, createdAt: manifest.createdAt })
  }
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const doomed = candidates.slice(Math.max(0, keep))
  for (const victim of doomed) fs.rmSync(victim.dir, { recursive: true, force: true })
  return doomed.map(victim => victim.dir)
}

function tryReadManifest(backupDir: string): BackupManifest | null {
  try {
    return parseManifest(fs.readFileSync(path.join(backupDir, BACKUP_MANIFEST_FILENAME), "utf8"))
  } catch {
    return null
  }
}

export function parseManifest(content: string): BackupManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(`Backup manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Backup manifest must be a JSON object.")
  }
  const manifest = parsed as Partial<BackupManifest>
  if (manifest.manifestVersion !== BACKUP_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported backup manifestVersion ${String(manifest.manifestVersion)}; this binary reads ${BACKUP_MANIFEST_SCHEMA_VERSION}.`)
  }
  if (typeof manifest.schemaVersion !== "number") throw new Error("Backup manifest is missing schemaVersion.")
  if (typeof manifest.eventCount !== "number") throw new Error("Backup manifest is missing eventCount.")
  if (!Array.isArray(manifest.files)) throw new Error("Backup manifest is missing the files array.")
  for (const [index, file] of manifest.files.entries()) {
    if (!file || typeof file !== "object") throw new Error(`Backup manifest files[${index}] is not an object.`)
    const entry = file as Partial<BackupFileEntry>
    if (typeof entry.path !== "string" || entry.path === "") throw new Error(`Backup manifest files[${index}] has no path.`)
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`Backup manifest files[${index}] (${entry.path}) has no valid sha256.`)
    }
    // Lexical confinement: a manifest is operator-supplied input, and a
    // restore writes every path it names. An absolute path or one escaping
    // the archive would write outside the target store.
    // Split on BOTH separators (review BAIXA-1). The module documents these
    // paths as POSIX-separated, and on POSIX a backslash is just a filename
    // character -- but `path.join` on Windows treats it as a separator, so
    // `..\..\evil` would have escaped the target there. The defence has to
    // hold on both, and a backslash in a path this writer produced is itself
    // a signal the manifest was not written by us.
    if (path.isAbsolute(entry.path) || entry.path.includes("\\") || entry.path.split(/[\\/]/).includes("..")) {
      throw new Error(`Backup manifest files[${index}] has an unsafe path: ${entry.path}`)
    }
  }
  return manifest as BackupManifest
}

export type VerifyBackupResult = {
  ok: boolean
  backupDir: string
  manifest: BackupManifest
  /** Per-file problems: missing, size or hash mismatch. */
  problems: Array<{ path: string; reason: string }>
  /** Files present in the archive that the manifest does not list. */
  unlisted: string[]
}

/**
 * Checks an archive against its own manifest. Every listed file must exist
 * and hash exactly; an unlisted file is reported too, because a restore
 * would ignore it and the operator should know the archive is not what it
 * claims to be.
 */
export function verifyBackup(backupDir: string): VerifyBackupResult {
  const resolved = path.resolve(backupDir)
  const manifestPath = path.join(resolved, BACKUP_MANIFEST_FILENAME)
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Not a backup: ${manifestPath} does not exist.`)
  }
  const manifest = parseManifest(fs.readFileSync(manifestPath, "utf8"))
  const problems: Array<{ path: string; reason: string }> = []
  for (const file of manifest.files) {
    const absolute = path.join(resolved, file.path)
    if (!fs.existsSync(absolute)) {
      problems.push({ path: file.path, reason: "missing from the archive" })
      continue
    }
    const bytes = fs.statSync(absolute).size
    if (bytes !== file.bytes) {
      problems.push({ path: file.path, reason: `size is ${bytes}, manifest says ${file.bytes}` })
      continue
    }
    const actual = sha256File(absolute)
    if (actual !== file.sha256) {
      problems.push({ path: file.path, reason: `sha256 is ${actual}, manifest says ${file.sha256}` })
    }
  }
  const listed = new Set(manifest.files.map(file => file.path))
  const unlisted = walkFiles(resolved).map(toPosix).filter(relPath => !listed.has(relPath))
  return { ok: problems.length === 0, backupDir: resolved, manifest, problems, unlisted }
}

export type RestoreBackupOptions = {
  backupDir: string
  storeDir: string
  /** Required to overwrite a store that is already materialized. */
  force?: boolean
}

export type RestoreBackupResult = {
  ok: true
  backupDir: string
  storeDir: string
  manifest: BackupManifest
  /** Events in the restored database after the journal replay. */
  eventCount: number
  /** Journal entries that the restored database had not indexed yet. */
  replayedJournalEntries: number
  /** Where a pre-existing store was moved, when --force replaced one. */
  replacedStoreMovedTo: string | null
}

/**
 * Restores an archive over a store directory. Takes the maintenance lock --
 * this replaces the database, so it must exclude openers exactly as repair
 * does -- verifies the archive first, and verifies the journal afterwards.
 */
export function restoreBackup(options: RestoreBackupOptions): RestoreBackupResult {
  const backupDir = path.resolve(options.backupDir)
  const storeDir = path.resolve(options.storeDir)
  const verification = verifyBackup(backupDir)
  if (!verification.ok) {
    const detail = verification.problems.map(problem => `  - ${problem.path}: ${problem.reason}`).join("\n")
    throw new Error(`Refusing to restore: the backup does not match its manifest.\n${detail}`)
  }
  const binarySchema = currentSchemaVersion()
  if (verification.manifest.schemaVersion > binarySchema) {
    throw new Error(
      `Refusing to restore: the backup is schema version ${verification.manifest.schemaVersion} and this binary only knows ${binarySchema}.`
      + ` Restoring it would leave a store this build cannot migrate. Upgrade mapctx first.`
    )
  }
  const alreadyMaterialized = fs.existsSync(path.join(storeDir, "mapctx.db"))
  if (alreadyMaterialized && !options.force) {
    throw new Error(
      `Refusing to restore over an existing store at ${storeDir}.`
      + ` Re-run with --force to replace it; the current store is moved aside, not deleted.`
    )
  }

  fs.mkdirSync(path.dirname(storeDir), { recursive: true })
  const lock = acquireMaintenanceLock(storeDir)
  let replacedStoreMovedTo: string | null = null
  try {
    // Stage the whole restored tree next to the target, then swap. A failure
    // part-way must not leave a store that is half old and half new.
    const stagingDir = `${storeDir}.restoring-${process.pid}`
    fs.rmSync(stagingDir, { recursive: true, force: true })
    fs.mkdirSync(stagingDir, { recursive: true })
    try {
      for (const file of verification.manifest.files) {
        const destination = path.join(stagingDir, file.path)
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.copyFileSync(path.join(backupDir, file.path), destination)
      }
      if (!checkIntegrity(path.join(stagingDir, "mapctx.db"))) {
        throw new Error("Refusing to restore: the backup's database fails PRAGMA integrity_check.")
      }
      if (alreadyMaterialized) {
        replacedStoreMovedTo = `${storeDir}.replaced-${Date.now()}`
        fs.renameSync(storeDir, replacedStoreMovedTo)
      } else {
        fs.rmSync(storeDir, { recursive: true, force: true })
      }
      fs.renameSync(stagingDir, storeDir)
    } catch (error) {
      fs.rmSync(stagingDir, { recursive: true, force: true })
      throw error
    }
  } finally {
    lock.release()
  }

  // Journal verification AFTER the restore, which is also what replays any
  // entry the snapshot's database had not indexed (the ordering guarantee in
  // the header is what makes this a replay rather than a gap).
  const { StoreHandle } = require("./store-handle") as typeof import("./store-handle")
  let eventCount = 0
  try {
    const handle = StoreHandle.open(storeDir) as import("./store-handle").StoreHandle
    try {
      eventCount = readCountSafely(handle.db, "SELECT count(*) AS n FROM event_log")
      const pending = handle.maintenanceNeeded()
      if (pending) {
        throw new Error(`Restored store still reports maintenance needed: ${pending}`)
      }
    } finally {
      handle.close()
    }
  } catch (error) {
    // The files are already in place: the archive verified, its database
    // passed integrity_check, and the swap happened. Rolling back here would
    // discard the restore the operator asked for and could fail in turn, so
    // the honest outcome is a refusal that says exactly what state the
    // filesystem is in -- including where the previous store went, which is
    // otherwise unrecoverable knowledge.
    const whereOld = replacedStoreMovedTo
      ? ` The store that was there is at ${replacedStoreMovedTo}.`
      : ""
    throw new Error(
      `The backup was restored to ${storeDir} but the store could not be opened afterwards: `
      + `${error instanceof Error ? error.message : String(error)}.`
      + ` The restored files are in place and were verified against the manifest; this is an open/replay failure, not a corrupt archive.`
      + `${whereOld}`
    )
  }
  const replayedJournalEntries = Math.max(0, eventCount - verification.manifest.eventCount)
  return {
    ok: true,
    backupDir,
    storeDir,
    manifest: verification.manifest,
    eventCount,
    replayedJournalEntries,
    replacedStoreMovedTo
  }
}

export type BackupListEntry = {
  backupDir: string
  manifest: BackupManifest | null
  /** Set when the manifest could not be read, so a listing never throws. */
  unreadable: string | null
}

export function listBackups(projectId: string): BackupListEntry[] {
  const root = backupsRootFor(projectId)
  if (!fs.existsSync(root)) return []
  const out: BackupListEntry[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const backupDir = path.join(root, entry.name)
    try {
      out.push({ backupDir, manifest: parseManifest(fs.readFileSync(path.join(backupDir, BACKUP_MANIFEST_FILENAME), "utf8")), unreadable: null })
    } catch (error) {
      out.push({ backupDir, manifest: null, unreadable: error instanceof Error ? error.message : String(error) })
    }
  }
  out.sort((a, b) => (b.manifest?.createdAt ?? "").localeCompare(a.manifest?.createdAt ?? ""))
  return out
}

/** True when the project has at least one archive -- used by the redact warning. */
export function hasBackups(projectId: string): boolean {
  return listBackups(projectId).length > 0
}

/**
 * Best-effort auto-snapshot taken before a destructive maintenance step.
 *
 * Deliberately non-fatal: a store that cannot be backed up (no space, a
 * read-only backups directory) must still be repairable, because refusing to
 * repair leaves the operator with a broken store and no way forward. The
 * caller reports what happened instead.
 */
export function autoSnapshot(
  storeDir: string,
  reason: Exclude<BackupReason, "operator">,
  options: { projectId?: string | null; db?: DatabaseSync; retention?: number; underMaintenanceLock?: boolean } = {}
): { ok: true; backupDir: string; pruned: string[] } | { ok: false; skipped: string } {
  const projectId = options.projectId ?? inferProjectIdFromStoreDir(storeDir)
  if (!projectId) return { ok: false, skipped: "could not determine the projectId for the backups directory" }
  try {
    const result = createBackup({ storeDir, projectId, reason, db: options.db, underMaintenanceLock: options.underMaintenanceLock })
    const pruned = options.retention === undefined
      ? result.pruned
      : pruneAutoBackups(projectId, options.retention)
    return { ok: true, backupDir: result.backupDir, pruned }
  } catch (error) {
    return { ok: false, skipped: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The store directory is `<home>/projects/<projectId>`, so its basename is
 * the projectId. Returns null for a directory that does not follow that
 * layout (a test fixture pointing somewhere else), which the caller treats
 * as "no auto-snapshot" rather than an error.
 */
export function inferProjectIdFromStoreDir(storeDir: string): string | null {
  const resolved = path.resolve(storeDir)
  if (path.basename(path.dirname(resolved)) !== "projects") return null
  const candidate = path.basename(resolved)
  return candidate === "" ? null : candidate
}

/** Temp directory helper shared by the git-checkpoint recovery path. */
export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * Where a pre-migration snapshot reports itself. `openDatabase` is deep
 * inside every store open and has no reporting channel of its own, so the
 * outcome is recorded here and the CLI drains it after the open.
 */
const pendingSnapshotNotices: string[] = []

export function drainSnapshotNotices(): string[] {
  return pendingSnapshotNotices.splice(0, pendingSnapshotNotices.length)
}

/**
 * Queues a notice from a maintenance path that has no reporting channel of
 * its own. `repair` uses this instead of adding fields to `RepairResult`,
 * whose exact shape the P1 integrity suite asserts on.
 */
export function pushSnapshotNotice(notice: string): void {
  pendingSnapshotNotices.push(notice)
}

/**
 * Installs the pre-migration snapshot into the database layer. Done at
 * module load so any process that touches `@mapctx/store` gets the
 * protection, without db.ts importing this module (it is the other way
 * round). Importing the package is what arms it; a build that never loads
 * backup.ts migrates exactly as it did before T-138.
 */
setPreMigrationSnapshot((dbPath, db, pendingVersions) => {
  const storeDir = path.dirname(dbPath)
  const result = autoSnapshot(storeDir, "pre-migration", { db })
  if (result.ok) {
    pendingSnapshotNotices.push(
      `pre-migration snapshot of schema before migration(s) ${pendingVersions.join(", ")}: ${result.backupDir}`
      + (result.pruned.length > 0 ? ` (pruned ${result.pruned.length} older auto-snapshot(s))` : "")
    )
  } else {
    // Non-fatal by design: refusing to migrate because the snapshot failed
    // would leave a store that no command can open.
    pendingSnapshotNotices.push(`pre-migration snapshot SKIPPED (${result.skipped}); migration proceeded`)
  }
})
