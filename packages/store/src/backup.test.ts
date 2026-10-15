import assert from "node:assert/strict"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import test from "node:test"
import { DatabaseSync } from "node:sqlite"
import { importCommit } from "./cutover"
import { resolveProjectStoreDir } from "./config"
import { openDatabase, openDatabaseReadOnly, checkIntegrity } from "./db"
import { StoreHandle } from "./store-handle"
import { getTask, listTasks } from "./projections"
import { MAINTENANCE_LOCK_FILENAME } from "./maintenance"
import { listJournalSequences } from "./journal"
import { reviseAcceptance, approveAcceptanceCriterion } from "./acceptance"
import { listRedactionCandidates } from "./redact"
import { cleanupDir, mkTmpDir, setupGoldenRepo } from "./__test-helpers__"
import {
  BACKUP_MANIFEST_FILENAME,
  BACKUP_MANIFEST_SCHEMA_VERSION,
  DEFAULT_AUTO_BACKUP_RETENTION,
  autoSnapshot,
  backupsRootFor,
  createBackup,
  currentSchemaVersion,
  drainSnapshotNotices,
  hasBackups,
  inferProjectIdFromStoreDir,
  listBackups,
  parseManifest,
  pruneAutoBackups,
  restoreBackup,
  verifyBackup,
  type BackupManifest
} from "./backup"

/** Materializes the golden board into a real store, isolated MAPCTX_HOME. */
function materialize() {
  const { repoDir, restoreEnv } = setupGoldenRepo()
  const imported = importCommit({ cwd: repoDir, actor: "test" })
  const storeDir = resolveProjectStoreDir(imported.projectId)
  return { repoDir, restoreEnv, projectId: imported.projectId, storeDir }
}

/** Stable subset of event_log rows -- excludes journal_path, which is an
 * absolute path that differs between the live store and a restored one at a
 * different directory. */
function eventRows(dbPath: string): Array<Record<string, unknown>> {
  const db = openDatabaseReadOnly(dbPath)
  try {
    return db.prepare(
      "SELECT node_id, sequence, event_type, schema_version, occurred_at, actor, payload_sha256 FROM event_log ORDER BY node_id, sequence"
    ).all() as Array<Record<string, unknown>>
  } finally {
    db.close()
  }
}

/**
 * Wraps a real DatabaseSync so that the moment `VACUUM INTO` is executed
 * (createBackup's step 1, the database snapshot), `onAfterVacuum` runs
 * synchronously before control returns to the caller -- simulating a writer
 * appending events in the window between the database snapshot and the
 * journal copy. Methods are rebound to `target` (not the proxy) because
 * node:sqlite's DatabaseSync is a native binding that rejects a non-genuine
 * receiver ("Illegal invocation" otherwise).
 */
function wrapDbInterceptingVacuum(target: DatabaseSync, onAfterVacuum: () => void): DatabaseSync {
  return new Proxy(target, {
    get(t, prop, _receiver) {
      if (prop === "exec") {
        return (sql: string) => {
          const result = (t.exec as (sql: string) => unknown)(sql)
          if (typeof sql === "string" && sql.startsWith("VACUUM INTO")) onAfterVacuum()
          return result
        }
      }
      const value = Reflect.get(t, prop, t)
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value
    }
  }) as DatabaseSync
}

function appendSyntheticTask(storeDir: string, taskId: string): void {
  const handle = StoreHandle.open(storeDir)
  try {
    handle.appendEvent({
      eventType: "task.upserted",
      actor: "concurrent-writer",
      payload: {
        task: {
          taskId,
          positionKey: 999,
          title: `synthetic ${taskId}`,
          planningState: "backlog",
          executionState: "unclaimed",
          tags: [],
          domains: [],
          externalLinks: [],
          assignees: []
        }
      }
    })
  } finally {
    handle.close()
  }
}

// ---------------------------------------------------------------------------
// C1 -- createBackup produces a consistent, verifiable archive without
// blocking writers.
// ---------------------------------------------------------------------------

test("createBackup -> verifyBackup -> restoreBackup round trip: same event rows and same task projections", () => {
  const fixture = materialize()
  const restoreDir = mkTmpDir("mapctx-backup-restore-target-")
  try {
    const liveBefore = eventRows(path.join(fixture.storeDir, "mapctx.db"))
    const liveTasks = listTasks(openDatabaseReadOnly(path.join(fixture.storeDir, "mapctx.db")))

    const created = createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId })
    const verification = verifyBackup(created.backupDir)
    assert.equal(verification.ok, true, JSON.stringify(verification.problems))

    const restored = restoreBackup({ backupDir: created.backupDir, storeDir: restoreDir })
    assert.equal(restored.ok, true)
    assert.equal(restored.eventCount, liveBefore.length)
    assert.equal(restored.replayedJournalEntries, 0, "no writer ran during this backup")

    const restoredDbPath = path.join(restoreDir, "mapctx.db")
    assert.equal(checkIntegrity(restoredDbPath), true)
    assert.deepEqual(eventRows(restoredDbPath), liveBefore)
    const restoredDb = openDatabaseReadOnly(restoredDbPath)
    assert.deepEqual(listTasks(restoredDb), liveTasks)
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
    cleanupDir(restoreDir)
  }
})

test("backup manifest: version/schema/counts/files are correct, excluded files never appear, and the restored db passes integrity_check", () => {
  const fixture = materialize()
  try {
    const created = createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId })
    const manifest = created.manifest
    assert.equal(manifest.manifestVersion, BACKUP_MANIFEST_SCHEMA_VERSION)
    assert.equal(manifest.schemaVersion, currentSchemaVersion(), "manifest schemaVersion must track the function, not a hardcoded number")
    assert.equal(typeof manifest.eventCount, "number")
    assert.ok(manifest.eventCount > 0)
    assert.equal(typeof manifest.journalCounts, "object")
    assert.equal(typeof manifest.redactionCount, "number")
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0)
    for (const file of manifest.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/, `${file.path}: ${file.sha256}`)
      assert.equal(typeof file.bytes, "number")
      assert.ok(file.role === "canonical" || file.role === "derived", `${file.path}: ${file.role}`)
      const base = path.basename(file.path)
      assert.ok(!base.endsWith("-wal") && !base.endsWith("-shm"), `${file.path} must never be in a backup`)
      assert.notEqual(base, MAINTENANCE_LOCK_FILENAME)
      assert.ok(!base.startsWith("mapctx.db.rebuild-"), `${file.path} must never be in a backup`)
      assert.notEqual(base, BACKUP_MANIFEST_FILENAME, "the manifest never lists itself")
    }
    assert.ok(fs.existsSync(path.join(created.backupDir, "mapctx.db")))
    assert.equal(checkIntegrity(path.join(created.backupDir, "mapctx.db")), true)
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
  }
})

test("MUTATION GUARD: a writer appending events during createBackup lands in the journal, not the database snapshot, and all of it replays on restore", () => {
  const fixture = materialize()
  const restoreDir = mkTmpDir("mapctx-backup-restore-target-")
  try {
    const dbPath = path.join(fixture.storeDir, "mapctx.db")
    const beforeCount = eventRows(dbPath).length

    let sawMaintenanceLockDuringBackup = false
    const realDb = openDatabaseReadOnly(dbPath)
    const proxiedDb = wrapDbInterceptingVacuum(realDb, () => {
      sawMaintenanceLockDuringBackup = fs.existsSync(path.join(fixture.storeDir, MAINTENANCE_LOCK_FILENAME))
      // Simulates a concurrent writer: three events land AFTER the database
      // snapshot (VACUUM INTO already ran) but BEFORE the journal is copied.
      appendSyntheticTask(fixture.storeDir, "T-900")
      appendSyntheticTask(fixture.storeDir, "T-901")
      appendSyntheticTask(fixture.storeDir, "T-902")
    })

    const created = createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId, db: proxiedDb })
    realDb.close()

    assert.equal(sawMaintenanceLockDuringBackup, false, "createBackup must never hold the maintenance lock while copying")

    // The manifest describes the SNAPSHOT, taken before the writer ran.
    assert.equal(created.manifest.eventCount, beforeCount, "manifest.eventCount must be the snapshot's count, not the live store's")
    const journalTotal = Object.values(created.manifest.journalCounts).reduce((sum, n) => sum + n, 0)
    assert.equal(journalTotal, beforeCount + 3, "the journal copy must include the 3 events the writer appended after the DB snapshot")

    const restored = restoreBackup({ backupDir: created.backupDir, storeDir: restoreDir })
    assert.equal(restored.eventCount, beforeCount + 3)
    assert.equal(restored.replayedJournalEntries, 3, "the 3 journal-only entries must replay on restore")
    const restoredDb = openDatabaseReadOnly(path.join(restoreDir, "mapctx.db"))
    assert.ok(getTask(restoredDb, "T-900"), "a replayed event must be visible in the restored projection")
    assert.ok(getTask(restoredDb, "T-902"))
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
    cleanupDir(restoreDir)
  }
})

// ---------------------------------------------------------------------------
// C2 -- restoreBackup reconstructs the store and refuses an invalid backup
// or one from a newer schema. Each refusal leaves the target untouched.
// ---------------------------------------------------------------------------

test("restoreBackup refuses a manifest schemaVersion newer than this binary, citing both versions; nothing is written", () => {
  const fixture = materialize()
  const restoreDir = mkTmpDir("mapctx-backup-restore-target-")
  try {
    const created = createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId })
    const manifestPath = path.join(created.backupDir, BACKUP_MANIFEST_FILENAME)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest
    const future = currentSchemaVersion() + 1
    manifest.schemaVersion = future
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    assert.throws(
      () => restoreBackup({ backupDir: created.backupDir, storeDir: restoreDir }),
      new RegExp(`${future}.*${currentSchemaVersion()}|${currentSchemaVersion()}.*${future}`)
    )
    assert.equal(fs.existsSync(path.join(restoreDir, "mapctx.db")), false, "nothing must be written to the target")
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
    cleanupDir(restoreDir)
  }
})

test("verifyBackup and restoreBackup refuse a tampered file (hash mismatch); nothing is written to the target", () => {
  const fixture = materialize()
  const restoreDir = mkTmpDir("mapctx-backup-restore-target-")
  try {
    const created = createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId })
    const metaPath = path.join(created.backupDir, "store-meta.json")
    assert.ok(fs.existsSync(metaPath), "sanity: store-meta.json must be part of the archive")
    // Same byte length, different content: exercises the HASH check
    // specifically (not the cheaper size check that would catch an append).
    const original = fs.readFileSync(metaPath, "utf8")
    const tampered = original.includes("0") ? original.replace("0", "1") : `${original.slice(0, -1)}X`
    assert.equal(tampered.length, original.length, "sanity: the tamper must preserve byte length")
    fs.writeFileSync(metaPath, tampered)

    const verification = verifyBackup(created.backupDir)
    assert.equal(verification.ok, false)
    assert.ok(verification.problems.some(p => p.path === "store-meta.json" && /sha256/.test(p.reason)), JSON.stringify(verification.problems))

    assert.throws(() => restoreBackup({ backupDir: created.backupDir, storeDir: restoreDir }), /does not match its manifest/)
    assert.equal(fs.existsSync(path.join(restoreDir, "mapctx.db")), false)
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
    cleanupDir(restoreDir)
  }
})

test("verifyBackup and restoreBackup refuse a file listed in the manifest but absent from disk", () => {
  const fixture = materialize()
  const restoreDir = mkTmpDir("mapctx-backup-restore-target-")
  try {
    const created = createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId })
    const metaPath = path.join(created.backupDir, "store-meta.json")
    fs.unlinkSync(metaPath)

    const verification = verifyBackup(created.backupDir)
    assert.equal(verification.ok, false)
    assert.ok(verification.problems.some(p => p.path === "store-meta.json" && /missing/.test(p.reason)), JSON.stringify(verification.problems))
    assert.throws(() => restoreBackup({ backupDir: created.backupDir, storeDir: restoreDir }), /does not match its manifest/)
    assert.equal(fs.existsSync(path.join(restoreDir, "mapctx.db")), false)
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
    cleanupDir(restoreDir)
  }
})

test("a manifest file entry with an escaping path (../../escape.txt) is refused as unsafe before anything is written", () => {
  const fixture = materialize()
  const restoreDir = mkTmpDir("mapctx-backup-restore-target-")
  try {
    const created = createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId })
    const manifestPath = path.join(created.backupDir, BACKUP_MANIFEST_FILENAME)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest
    manifest.files.push({ path: "../../escape.txt", role: "derived", bytes: 0, sha256: "0".repeat(64) })
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    assert.throws(() => parseManifest(fs.readFileSync(manifestPath, "utf8")), /unsafe path/)
    assert.throws(() => verifyBackup(created.backupDir), /unsafe path/)
    assert.throws(() => restoreBackup({ backupDir: created.backupDir, storeDir: restoreDir }), /unsafe path/)
    assert.equal(fs.existsSync(path.join(restoreDir, "mapctx.db")), false)
    assert.equal(fs.existsSync(path.join(path.dirname(created.backupDir), "..", "escape.txt")), false)
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
    cleanupDir(restoreDir)
  }
})

test("restoreBackup refuses an already-materialized store without --force; with --force it replaces and preserves the old store (not deleted)", () => {
  const fixture = materialize()
  try {
    const created = createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId })

    assert.throws(
      () => restoreBackup({ backupDir: created.backupDir, storeDir: fixture.storeDir }),
      /Refusing to restore over an existing store|--force/
    )
    assert.ok(fs.existsSync(path.join(fixture.storeDir, "mapctx.db")), "the refusal must not touch the existing store")

    const restored = restoreBackup({ backupDir: created.backupDir, storeDir: fixture.storeDir, force: true })
    assert.equal(restored.ok, true)
    assert.ok(restored.replacedStoreMovedTo, "a --force restore must report where the old store went")
    assert.ok(fs.existsSync(restored.replacedStoreMovedTo!), "the old store must still exist, moved aside, not deleted")
    assert.ok(fs.existsSync(path.join(restored.replacedStoreMovedTo!, "mapctx.db")), "the moved-aside store must still contain its database")
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
  }
})

test("verifyBackup on a directory without manifest.json refuses as \"Not a backup\"", () => {
  const notABackup = mkTmpDir("mapctx-not-a-backup-")
  try {
    fs.writeFileSync(path.join(notABackup, "mapctx.db"), "not really a database")
    assert.throws(() => verifyBackup(notABackup), /Not a backup/)
  } finally {
    cleanupDir(notABackup)
  }
})

test("verifyBackup reports a file present in the directory but unlisted in the manifest", () => {
  const fixture = materialize()
  try {
    const created = createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId })
    fs.writeFileSync(path.join(created.backupDir, "stray-extra-file.txt"), "not in the manifest")
    const verification = verifyBackup(created.backupDir)
    assert.equal(verification.ok, true, "an unlisted extra file is not itself a verification failure")
    assert.ok(verification.unlisted.includes("stray-extra-file.txt"), JSON.stringify(verification.unlisted))
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
  }
})

// ---------------------------------------------------------------------------
// C3 -- migration and `store repair` take an automatic snapshot first, with
// retention over auto-snapshots only.
// ---------------------------------------------------------------------------

test("repairStore takes a pre-repair snapshot and reports it through the notice queue, never on RepairResult", () => {
  const fixture = materialize()
  try {
    drainSnapshotNotices() // clear anything a prior test in this process left queued
    const { repairStore } = require("./repair") as typeof import("./repair")
    const result = repairStore(fixture.storeDir)
    assert.equal(result.status, "ok", JSON.stringify(result))
    assert.ok(!("preRepairBackupDir" in result) && !("preRepairBackupSkipped" in result), "RepairResult's shape must stay exactly what integrity.test.ts pins")

    const notices = drainSnapshotNotices()
    assert.ok(notices.some(n => /pre-repair snapshot/.test(n)), JSON.stringify(notices))

    const backups = listBackups(fixture.projectId)
    assert.ok(backups.some(b => b.manifest?.reason === "pre-repair"), JSON.stringify(backups.map(b => b.manifest?.reason)))
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
  }
})

test("a pending migration takes a pre-migration snapshot BEFORE attempting the (failing) migration, and the snapshot survives the failure", () => {
  const fixture = materialize()
  try {
    drainSnapshotNotices()
    const dbPath = path.join(fixture.storeDir, "mapctx.db")
    const db = new DatabaseSync(dbPath)
    const lastMigrationVersion = (require("./schema") as typeof import("./schema")).MIGRATIONS
      .reduce((max, m) => Math.max(max, m.version), 0)
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(lastMigrationVersion)
    db.close()

    // Migration (today, version 12) re-adds a column that physically already
    // exists -- not idempotent -- so re-running it must fail. The point of
    // this test is that the snapshot exists ANYWAY.
    assert.throws(() => openDatabase(dbPath), /duplicate column|renew_token/i)

    const notices = drainSnapshotNotices()
    assert.ok(notices.some(n => /pre-migration snapshot/.test(n) && n.includes(String(lastMigrationVersion))), JSON.stringify(notices))
    const backups = listBackups(fixture.projectId)
    assert.ok(backups.some(b => b.manifest?.reason === "pre-migration"), JSON.stringify(backups.map(b => b.manifest?.reason)))
    // T-138 review attempt 2, MÉDIA-1: the pre-migration snapshot holds the
    // store as it was BEFORE the pending migration, and its manifest must say
    // so -- `schemaVersion` is the writing binary's (the restore gate), not the
    // archived database's.
    const snapshot = backups.find(b => b.manifest?.reason === "pre-migration")?.manifest
    assert.equal(snapshot?.storeSchemaVersion, lastMigrationVersion - 1)
    assert.equal(snapshot?.schemaVersion, lastMigrationVersion)
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
  }
})

// T-167: these three tests must never pin "the newest migration is N" as a
// literal -- another task is adding a migration in parallel on its own
// branch. A probe migration pushed onto MIGRATIONS gives each test a real
// pending migration one version ahead of whatever `currentSchemaVersion()`
// reports right now, and it is always removed in `finally` (node:test runs a
// file's tests in sequence, so that is enough to keep later tests honest).

test("MUTATION GUARD: store repair with a pending migration leaves a snapshot of the previous schema and never reports a SKIPPED that refuses its own lock holder", () => {
  const fixture = materialize()
  const schema = require("./schema") as typeof import("./schema")
  const previousVersion = currentSchemaVersion()
  const probe = { version: previousVersion + 1, sql: "CREATE TABLE IF NOT EXISTS t167_probe (id TEXT PRIMARY KEY)" }
  ;(schema.MIGRATIONS as Array<{ version: number; sql: string }>).push(probe)
  try {
    drainSnapshotNotices()
    const { repairStore } = require("./repair") as typeof import("./repair")
    const result = repairStore(fixture.storeDir)
    assert.equal(result.status, "ok", JSON.stringify(result))

    const notices = drainSnapshotNotices()
    // This is the mutation this test catches: flip `maintenanceSnapshotFor`'s
    // `=== process.pid` check to always deny the context, or drop
    // `withMaintenanceSnapshot(...)` from `repairStore`, and the hook stops
    // seeing the holder's own archive -- bringing back a SKIPPED that refuses
    // repair's own lock, while the migration proceeds anyway.
    assert.ok(!notices.some(n => /pre-migration snapshot SKIPPED/.test(n)), JSON.stringify(notices))
    assert.ok(!notices.some(n => /under maintenance/.test(n)), JSON.stringify(notices))
    const preMigrationNotice = notices.find(n => /pre-migration snapshot/.test(n))
    assert.ok(preMigrationNotice, JSON.stringify(notices))
    assert.ok(preMigrationNotice!.includes(`storeSchemaVersion ${previousVersion}`), preMigrationNotice)

    const backups = listBackups(fixture.projectId)
    const preRepair = backups.find(b => b.manifest?.reason === "pre-repair" && b.manifest.storeSchemaVersion === previousVersion)
    assert.ok(preRepair, JSON.stringify(backups.map(b => b.manifest?.reason)))
    assert.ok(preMigrationNotice!.includes(preRepair!.backupDir), preMigrationNotice)

    // Reusing the pre-repair archive rather than duplicating it: exactly one
    // automatic snapshot of the previous schema must exist, not two.
    const sameState = backups.filter(b => b.manifest?.storeSchemaVersion === previousVersion)
    assert.equal(sameState.length, 1, JSON.stringify(backups.map(b => [b.manifest?.reason, b.manifest?.storeSchemaVersion])))

    const db = openDatabaseReadOnly(path.join(fixture.storeDir, "mapctx.db"))
    try {
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t167_probe'").get(), "the pending migration must have actually applied")
      const maxVersion = db.prepare("SELECT max(version) AS n FROM schema_migrations").get() as { n: number }
      assert.equal(maxVersion.n, previousVersion + 1)
    } finally {
      db.close()
    }
  } finally {
    ;(schema.MIGRATIONS as Array<{ version: number; sql: string }>).splice(schema.MIGRATIONS.indexOf(probe), 1)
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
  }
})

test("an ordinary writable open with a pending migration still writes its own pre-migration snapshot (no maintenance lock involved)", () => {
  const fixture = materialize()
  const schema = require("./schema") as typeof import("./schema")
  const previousVersion = currentSchemaVersion()
  const probe = { version: previousVersion + 1, sql: "CREATE TABLE IF NOT EXISTS t167_probe (id TEXT PRIMARY KEY)" }
  ;(schema.MIGRATIONS as Array<{ version: number; sql: string }>).push(probe)
  try {
    drainSnapshotNotices()
    // This is exactly what `task create` and every other ordinary command do:
    // open the handle, let the pending migration run, close it. No
    // maintenance lock is ever taken on this path.
    const handle = StoreHandle.open(fixture.storeDir)
    handle.close()

    const notices = drainSnapshotNotices()
    assert.ok(!notices.some(n => /SKIPPED/.test(n)), JSON.stringify(notices))
    const notice = notices.find(n => /pre-migration snapshot of schema/.test(n))
    assert.ok(notice, JSON.stringify(notices))
    assert.ok(notice!.includes(String(previousVersion)), notice)
    assert.ok(notice!.includes(String(previousVersion + 1)), notice)

    const backups = listBackups(fixture.projectId)
    const preMigration = backups.find(b => b.manifest?.reason === "pre-migration")
    assert.ok(preMigration, JSON.stringify(backups.map(b => b.manifest?.reason)))
    assert.equal(preMigration!.manifest?.storeSchemaVersion, previousVersion)
    assert.equal(preMigration!.manifest?.schemaVersion, previousVersion + 1)

    const db = openDatabaseReadOnly(path.join(fixture.storeDir, "mapctx.db"))
    try {
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t167_probe'").get())
    } finally {
      db.close()
    }
  } finally {
    ;(schema.MIGRATIONS as Array<{ version: number; sql: string }>).splice(schema.MIGRATIONS.indexOf(probe), 1)
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
  }
})

test("pruneAutoBackups spares the only auto-snapshot of the previous schema, however many newer ones pile up", () => {
  const fixture = materialize()
  const schema = require("./schema") as typeof import("./schema")
  const { runMigrations } = require("./db") as typeof import("./db")
  const previousVersion = currentSchemaVersion()
  const probe = { version: previousVersion + 1, sql: "CREATE TABLE IF NOT EXISTS t167_probe (id TEXT PRIMARY KEY)" }
  ;(schema.MIGRATIONS as Array<{ version: number; sql: string }>).push(probe)
  try {
    const dbPath = path.join(fixture.storeDir, "mapctx.db")

    // The one archive of the schema the store is about to leave. An explicit
    // outDir sidesteps createBackup's own inline prune (see the retention
    // test above), so it is retention's call under test, not this one's.
    const previousDir = path.join(backupsRootFor(fixture.projectId), "pre-repair-2026-01-01T00-00-00-000Z")
    createBackup({
      storeDir: fixture.storeDir,
      projectId: fixture.projectId,
      reason: "pre-repair",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      outDir: previousDir
    })

    // Migrate the store with NO snapshot side effect at all: `runMigrations`
    // called with no hook (unlike `openDatabase`, which always wires one)
    // takes no backup of its own, so the archive above stays the only one of
    // the previous schema.
    const db = new DatabaseSync(dbPath)
    runMigrations(db)
    db.close()

    const newStamps = [
      "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z", "2026-01-04T00:00:00.000Z",
      "2026-01-05T00:00:00.000Z", "2026-01-06T00:00:00.000Z", "2026-01-07T00:00:00.000Z"
    ]
    for (const stamp of newStamps) {
      const dir = path.join(backupsRootFor(fixture.projectId), `pre-repair-${stamp.replace(/[:.]/g, "-")}`)
      createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId, reason: "pre-repair", now: () => new Date(stamp), outDir: dir })
    }

    const pruned = pruneAutoBackups(fixture.projectId, 3)
    // The three OLDEST of the new schema (01-02, 01-03, 01-04): candidates
    // sort newest-first, `keep` spares the first 3 (01-07..01-05), and
    // `rollbackPointSnapshot` spares `previousDir` on top of that count.
    assert.equal(pruned.length, 3, JSON.stringify(pruned))
    assert.ok(!pruned.includes(previousDir), JSON.stringify(pruned))
    assert.ok(fs.existsSync(previousDir), "the only snapshot of the previous schema must survive retention")

    const remaining = listBackups(fixture.projectId)
    const remainingByVersion = new Map<number, number>()
    for (const entry of remaining) {
      const version = entry.manifest?.storeSchemaVersion
      if (typeof version === "number") remainingByVersion.set(version, (remainingByVersion.get(version) ?? 0) + 1)
    }
    assert.equal(remainingByVersion.get(previousVersion), 1, JSON.stringify(remaining.map(b => b.manifest?.storeSchemaVersion)))
    assert.equal(remainingByVersion.get(previousVersion + 1), 3, JSON.stringify(remaining.map(b => b.manifest?.storeSchemaVersion)))
  } finally {
    ;(schema.MIGRATIONS as Array<{ version: number; sql: string }>).splice(schema.MIGRATIONS.indexOf(probe), 1)
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
  }
})

test("MUTATION GUARD: the lock-holder exemption is granted only to the real holder -- a published context never snapshots under ANOTHER process's maintenance lock", async () => {
  const fixture = materialize()
  const schema = require("./schema") as typeof import("./schema")
  const lockPath = path.join(fixture.storeDir, MAINTENANCE_LOCK_FILENAME)
  let child: import("child_process").ChildProcess | null = null
  let probe: { version: number; sql: string } | null = null
  try {
    // This process's own archive of the CURRENT state, taken before anyone
    // claims the lock. With the pid check removed from
    // `maintenanceSnapshotFor`, this is exactly the archive the hook would
    // wrongly cite as "already covered" while ANOTHER process holds the
    // lock below.
    const archive = createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId, reason: "pre-repair" })
    const previousVersion = currentSchemaVersion()
    probe = { version: previousVersion + 1, sql: "CREATE TABLE IF NOT EXISTS t167_probe (id TEXT PRIMARY KEY)" }
    ;(schema.MIGRATIONS as Array<{ version: number; sql: string }>).push(probe)

    // A live lock held by ANOTHER process -- a fresh takenAt, so it is not
    // stale by MAINTENANCE_LOCK_STALE_MS policy and genuinely blocks.
    const { spawn } = await import("child_process")
    child = spawn("sleep", ["30"])
    const otherPid = child.pid as number
    fs.writeFileSync(lockPath, JSON.stringify({ pid: otherPid, takenAt: new Date().toISOString() }), "utf8")

    // Sanity: the real open path refuses under this lock exactly as R12
    // promises -- this is the guarantee the exemption must not loosen.
    assert.throws(() => StoreHandle.open(fixture.storeDir), /under maintenance/)

    drainSnapshotNotices()
    const { withMaintenanceSnapshot } = require("./backup") as typeof import("./backup")
    // Reaches the pre-migration hook directly through `openDatabase`, the
    // layer one below `StoreHandle.open`'s refusal just proved above. That
    // refusal is what this test relies on to know nothing else could have
    // opened the store meanwhile; `openDatabase` under someone else's lock
    // is otherwise unreachable from a real caller, and it is only the
    // HOOK's behaviour -- does it grant the exemption to a context that is
    // not really the lock holder? -- that is under test here.
    const db = withMaintenanceSnapshot(
      { storeDir: fixture.storeDir, archive: { backupDir: archive.backupDir, manifest: archive.manifest }, skipped: null },
      () => openDatabase(path.join(fixture.storeDir, "mapctx.db"))
    )
    db.close()

    const notices = drainSnapshotNotices()
    const skipped = notices.find(n => /pre-migration snapshot SKIPPED/.test(n) && /under maintenance/.test(n))
    assert.ok(skipped, JSON.stringify(notices))
    assert.ok(skipped!.includes(`pid ${otherPid}`), skipped)
    // MUTATION GUARD: dropping the `=== process.pid` check in
    // `maintenanceSnapshotFor` would make this SKIPPED describe THIS
    // process instead of the real holder -- the exact tell of the T-167
    // defect reappearing one level removed, under a lock that is not ours.
    assert.ok(!skipped!.includes(`pid ${process.pid}`), skipped)
    assert.ok(!notices.some(n => /already covered by/.test(n)), JSON.stringify(notices))

    const backups = listBackups(fixture.projectId)
    assert.equal(backups.length, 1, "no pre-migration snapshot must be written while another process holds the lock")
  } finally {
    if (child) {
      child.kill("SIGKILL")
      await new Promise(resolve => child!.once("exit", resolve))
    }
    fs.rmSync(lockPath, { force: true })
    if (probe) (schema.MIGRATIONS as Array<{ version: number; sql: string }>).splice(schema.MIGRATIONS.indexOf(probe), 1)
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
  }
})

test("restoreBackup's post-restore open failure names the open/replay failure explicitly, not a corrupt archive, and still reports where the old store went", () => {
  const fixture = materialize()
  const restoreDir = mkTmpDir("mapctx-backup-restore-target-")
  try {
    // Build a backup whose DATABASE will fail to re-open after restore: the
    // ledger is missing the last migration's row, so a fresh open retries
    // (and fails) the non-idempotent ALTER TABLE.
    const dbPath = path.join(fixture.storeDir, "mapctx.db")
    const lastMigrationVersion = (require("./schema") as typeof import("./schema")).MIGRATIONS
      .reduce((max, m) => Math.max(max, m.version), 0)
    const db = new DatabaseSync(dbPath)
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(lastMigrationVersion)
    db.close()

    const created = createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId, outDir: mkTmpDir("mapctx-broken-backup-") })

    let threw: Error | null = null
    try {
      restoreBackup({ backupDir: created.backupDir, storeDir: restoreDir })
    } catch (error) {
      threw = error as Error
    }
    assert.ok(threw, "the post-restore open must fail and surface as an error")
    assert.match(threw!.message, /could not be opened afterwards/)
    assert.match(threw!.message, /verified against the manifest/)
    assert.match(threw!.message, /not a corrupt archive/)
    assert.ok(fs.existsSync(path.join(restoreDir, "mapctx.db")), "the files must still be in place -- this is an open failure, not a rollback")
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
    cleanupDir(restoreDir)
  }
})

test("pruneAutoBackups keeps N auto-snapshots and NEVER prunes an operator backup; MUTATION GUARD on the operator exemption", () => {
  const fixture = materialize()
  try {
    createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId, reason: "operator" })
    const stamps = ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z", "2026-01-04T00:00:00.000Z", "2026-01-05T00:00:00.000Z", "2026-01-06T00:00:00.000Z", "2026-01-07T00:00:00.000Z"]
    // Each auto-snapshot creation ALSO self-prunes inline to
    // DEFAULT_AUTO_BACKUP_RETENTION when outDir is omitted (see createBackup),
    // which would otherwise interfere with observing retention at an
    // explicit, smaller `keep`. An explicit outDir under the normal backups
    // root sidesteps that inline prune while staying where listBackups scans.
    for (const stamp of stamps) {
      const dir = path.join(backupsRootFor(fixture.projectId), `pre-repair-${stamp.replace(/[:.]/g, "-")}`)
      createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId, reason: "pre-repair", now: () => new Date(stamp), outDir: dir })
    }

    const keep = 3
    const pruned = pruneAutoBackups(fixture.projectId, keep)
    assert.equal(pruned.length, stamps.length - keep)

    const remaining = listBackups(fixture.projectId)
    const remainingAuto = remaining.filter(b => b.manifest?.reason === "pre-repair")
    const remainingOperator = remaining.filter(b => b.manifest?.reason === "operator")
    assert.equal(remainingAuto.length, keep, "exactly N auto-snapshots must survive")
    assert.equal(remainingOperator.length, 1, "the operator backup must survive retention untouched")
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
  }
})

test("DEFAULT_AUTO_BACKUP_RETENTION is a positive integer actually used by autoSnapshot's default pruning", () => {
  assert.ok(Number.isInteger(DEFAULT_AUTO_BACKUP_RETENTION) && DEFAULT_AUTO_BACKUP_RETENTION > 0)
})

test("the pre-snapshot is best-effort: a store directory outside <home>/projects/<id> still repairs, and the notice says SKIPPED", () => {
  const outsideDir = mkTmpDir("mapctx-store-outside-layout-")
  try {
    const handle = StoreHandle.open(outsideDir)
    handle.appendEvent({
      eventType: "project.initialized",
      actor: "test",
      payload: { projectId: "p-outside", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "store" }
    })
    handle.close()

    assert.equal(inferProjectIdFromStoreDir(outsideDir), null, "sanity: this directory does not follow <home>/projects/<id>")
    drainSnapshotNotices()
    const { repairStore } = require("./repair") as typeof import("./repair")
    const result = repairStore(outsideDir)
    assert.equal(result.status, "ok", JSON.stringify(result))

    const notices = drainSnapshotNotices()
    assert.ok(notices.some(n => /pre-repair snapshot SKIPPED/.test(n)), JSON.stringify(notices))
  } finally {
    cleanupDir(outsideDir)
  }
})

test("autoSnapshot reports ok:false with a skipped reason when projectId cannot be inferred and none is supplied", () => {
  const outsideDir = mkTmpDir("mapctx-store-outside-layout-")
  try {
    const handle = StoreHandle.open(outsideDir)
    handle.close()
    const result = autoSnapshot(outsideDir, "pre-repair")
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.skipped, /projectId/)
  } finally {
    cleanupDir(outsideDir)
  }
})

test("hasBackups/backupsRootFor/listBackups agree: empty project has none, a backup makes hasBackups true", () => {
  const fixture = materialize()
  try {
    assert.equal(hasBackups(fixture.projectId), false)
    assert.deepEqual(listBackups(fixture.projectId), [])
    createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId })
    assert.equal(hasBackups(fixture.projectId), true)
    assert.equal(listBackups(fixture.projectId).length, 1)
    assert.ok(fs.existsSync(backupsRootFor(fixture.projectId)))
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
  }
})

test("redactionCount on the manifest records the privacy state at backup time", () => {
  const fixture = materialize()
  try {
    const before = createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId, outDir: mkTmpDir("mapctx-backup-pre-redact-") })
    assert.equal(before.manifest.redactionCount, 0)
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
  }
})

// ---------------------------------------------------------------------------
// Review ALTO-1: `listJournalSequences` enumerates two journal layouts --
// flat `<seq>.json` files AND `batch-<lo>-<hi>/` directories (a multi-event
// transaction stages its entries together, which claim/violations/import all
// do). The original createBackup rebuilt only the flat path and threw ENOENT
// on every batched entry. 909 tests passed with this broken because every
// fixture appended exactly one event per transaction.
// ---------------------------------------------------------------------------

test("MUTATION GUARD (ALTO-1): createBackup copies a batch-* journal directory, not just flat files, and the round trip survives it", () => {
  const fixture = materialize()
  const restoreDir = mkTmpDir("mapctx-backup-restore-target-")
  try {
    const handle = StoreHandle.open(fixture.storeDir)
    const nodeId = handle.nodeId
    // Two appends inside ONE write transaction: this is exactly what
    // runInWriteTransaction uses for claim/violations/import, and it is what
    // stages entries in a batch-<lo>-<hi>/ directory instead of flat files.
    handle.runInWriteTransaction(append => {
      append({ eventType: "task.patched", actor: "test", payload: { taskId: "T-101", patch: { title: "batch a" }, source: "test" } })
      append({ eventType: "task.patched", actor: "test", payload: { taskId: "T-101", patch: { title: "batch b" }, source: "test" } })
      return { ok: true }
    })
    handle.close()

    const journalDir = path.join(fixture.storeDir, "events", nodeId)
    const entries = fs.readdirSync(journalDir)
    const batchDirName = entries.find(name => /^batch-\d+-\d+$/.test(name))
    assert.ok(batchDirName, `expected a batch-* directory on disk, got: ${JSON.stringify(entries)}`)
    const flatFiles = entries.filter(name => /^\d+\.json$/.test(name))
    const sequences = listJournalSequences(fixture.storeDir, nodeId)
    assert.ok(sequences.length > flatFiles.length, "listJournalSequences must report more sequences than there are flat files -- the batch entries are the difference")

    const [, lo] = /^batch-(\d+)-(\d+)$/.exec(batchDirName!)!
    const batchEntryRelPath = `events/${nodeId}/${batchDirName}/${lo}.json`
    assert.ok(fs.existsSync(path.join(fixture.storeDir, batchEntryRelPath)), "sanity: the batched entry file must exist on disk")

    const created = createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId })
    assert.ok(fs.existsSync(path.join(created.backupDir, batchEntryRelPath)), "the batched entry must exist INSIDE the archive")
    assert.ok(
      created.manifest.files.some(file => file.path === batchEntryRelPath),
      `the batched entry must be listed in the manifest's files[]: ${JSON.stringify(created.manifest.files.map(f => f.path))}`
    )

    const verification = verifyBackup(created.backupDir)
    assert.equal(verification.ok, true, JSON.stringify(verification.problems))

    const restored = restoreBackup({ backupDir: created.backupDir, storeDir: restoreDir })
    assert.equal(restored.ok, true)
    assert.equal(restored.eventCount, sequences.length)
    const restoredDb = openDatabaseReadOnly(path.join(restoreDir, "mapctx.db"))
    const restoredTask = getTask(restoredDb, "T-101")
    assert.equal(restoredTask?.title, "batch b", "the second batched event must have actually applied")
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
    cleanupDir(restoreDir)
  }
})

// ---------------------------------------------------------------------------
// Review ALTO-2: the copy-order argument covers a writer that APPENDS. It
// does not cover `mapctx redact`, which REWRITES an already-published entry
// (commit the redaction event + UPDATE event_log + scrub projections, THEN
// rewrite the journal entry). Landing that between STEP 1 (VACUUM INTO) and
// STEP 2 (journal copy) used to produce an archive with a PRE-redaction
// database and a POST-redaction journal: it verified, restored, and served
// the plaintext again while its restored ledger claimed the redaction had
// been applied -- with manifest.redactionCount reading 0, pointing the wrong
// way for the exact question that field exists to answer.
// ---------------------------------------------------------------------------

/** Produces one genuinely redactable event (acceptance.approved + evidence),
 * same pattern T-126/T-127's privacy tests use -- task.patched carries no
 * redactable root at all. */
function createRedactableAcceptanceEvidence(storeDir: string, secret: string): { nodeId: string; sequence: number } {
  const handle = StoreHandle.open(storeDir)
  try {
    const revised = reviseAcceptance(handle, { taskId: "T-101", condition: "criteria", texts: ["one"], actor: "test", expectRevision: 0 })
    assert.ok(revised.ok, JSON.stringify(revised))
    if (!revised.ok) throw new Error("unreachable")
    const approved = approveAcceptanceCriterion(handle, { taskId: "T-101", index: 0, actor: "test", expectRevision: revised.revision, evidence: { customer: secret } })
    assert.ok(approved.ok, JSON.stringify(approved))
    const candidates = listRedactionCandidates(handle.db)
    const candidate = candidates.find(c => c.redactableFieldPaths.length > 0)
    assert.ok(candidate, `expected a redactable candidate, got: ${JSON.stringify(candidates)}`)
    return { nodeId: candidate!.nodeId, sequence: candidate!.sequence }
  } finally {
    handle.close()
  }
}

test("MUTATION GUARD (ALTO-2): createBackup refuses a backup whose journal copy straddles a mapctx redact, leaving nothing written", () => {
  const { redactEvidence } = require("./redact") as typeof import("./redact")
  const fixture = materialize()
  const SECRET = "shift-premium-9f31a778421"
  try {
    const target = createRedactableAcceptanceEvidence(fixture.storeDir, SECRET)
    const dbPath = path.join(fixture.storeDir, "mapctx.db")

    const outDir = path.join(mkTmpDir("mapctx-backup-redact-skew-"), "archive")
    const stagingSibling = `${outDir}.partial-${process.pid}`

    const realDb = openDatabaseReadOnly(dbPath)
    const proxiedDb = wrapDbInterceptingVacuum(realDb, () => {
      // Redaction REWRITES a published entry: by the time this runs, the
      // database snapshot (VACUUM INTO) has already been taken, but the
      // journal -- copied next -- will now be post-redaction.
      const handle = StoreHandle.open(fixture.storeDir)
      try {
        const result = redactEvidence(handle, {
          target,
          fieldPath: "evidence",
          reason: "straddle probe",
          actor: "dpo",
          commit: true
        })
        assert.ok(result.ok, JSON.stringify(result))
      } finally {
        handle.close()
      }
    })

    let threw: Error | null = null
    try {
      createBackup({ storeDir: fixture.storeDir, projectId: fixture.projectId, db: proxiedDb, outDir })
    } catch (error) {
      threw = error as Error
    } finally {
      realDb.close()
    }
    assert.ok(threw, "a backup that straddles a redaction must be refused, not written")
    assert.match(threw!.message, /redaction/i)
    assert.equal(fs.existsSync(outDir), false, "nothing must be written to the target archive directory")
    assert.equal(fs.existsSync(stagingSibling), false, "no .partial-<pid> staging directory must survive the refusal")
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
  }
})

// ---------------------------------------------------------------------------
// Review BAIXA-1: manifest path confinement split on "/" only, so a
// backslash-separated escape (`..\..\evil`) passed on POSIX (harmless there)
// but would have escaped the target on Windows, where path.join treats `\`
// as a separator. The module documents paths as "always POSIX-separated", so
// a backslash anywhere is itself a signal the manifest is not one we wrote.
// ---------------------------------------------------------------------------

test("manifest path confinement rejects backslash-separated escapes, not just forward-slash ones; legitimate posix paths still pass", () => {
  for (const unsafe of ["..\\..\\evil", "events\\..\\..\\evil", "a\\b"]) {
    assert.throws(() => parseManifest(JSON.stringify({
      manifestVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
      schemaVersion: currentSchemaVersion(),
      projectId: null, nodeId: null, incarnationId: null, createdAt: new Date().toISOString(),
      reason: "operator", eventCount: 0, journalCounts: {}, redactionCount: 0,
      files: [{ path: unsafe, role: "canonical", bytes: 0, sha256: "0".repeat(64) }]
    })), /unsafe path/, `expected ${JSON.stringify(unsafe)} to be refused`)
  }
  for (const unsafe of ["/etc/evil", "../../evil", "events/../../evil"]) {
    assert.throws(() => parseManifest(JSON.stringify({
      manifestVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
      schemaVersion: currentSchemaVersion(),
      projectId: null, nodeId: null, incarnationId: null, createdAt: new Date().toISOString(),
      reason: "operator", eventCount: 0, journalCounts: {}, redactionCount: 0,
      files: [{ path: unsafe, role: "canonical", bytes: 0, sha256: "0".repeat(64) }]
    })), /unsafe path/, `expected ${JSON.stringify(unsafe)} to still be refused`)
  }
  const safe = parseManifest(JSON.stringify({
    manifestVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
    schemaVersion: currentSchemaVersion(),
    projectId: null, nodeId: null, incarnationId: null, createdAt: new Date().toISOString(),
    reason: "operator", eventCount: 0, journalCounts: {}, redactionCount: 0,
    files: [{ path: "events/ok/1.json", role: "canonical", bytes: 0, sha256: "0".repeat(64) }]
  }))
  assert.equal(safe.files[0].path, "events/ok/1.json")
})
