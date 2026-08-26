import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as crypto from "crypto"
import { DatabaseSync } from "node:sqlite"
import { checkIntegrity, openDatabase } from "./db"
import { MIGRATION_001_INITIAL, MIGRATIONS } from "./schema"
import { StoreHandle } from "./store-handle"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

test("openDatabase creates schema_migrations and applies migrations exactly once", () => {
  const dir = mkTmpDir("mapctx-store-migration-");
  try {
    const dbPath = `${dir}/mapctx.db`;
    const db = openDatabase(dbPath);
    const row = db.prepare("SELECT version, checksum FROM schema_migrations WHERE version = 1").get() as { version: number; checksum: string } | undefined;
    assert.ok(row, "migration 001 should be recorded");
    assert.equal(row!.version, 1);
    db.close();

    // Reopening must not throw and must not re-apply (checksum guard passes silently).
    const db2 = openDatabase(dbPath);
    const rows = db2.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[];
    assert.deepEqual(rows.map(row => row.version), MIGRATIONS.map(migration => migration.version), "migrations should only be recorded once across repeated opens");
    db2.close();
  } finally {
    cleanupDir(dir);
  }
});

test("existing v1 store upgrades without losing v1 data", () => {
  const dir = mkTmpDir("mapctx-store-migration-upgrade-");
  try {
    const dbPath = `${dir}/mapctx.db`;
    const db = new DatabaseSync(dbPath);
    db.exec(MIGRATION_001_INITIAL);
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const checksum = crypto.createHash("sha256").update(MIGRATION_001_INITIAL, "utf8").digest("hex");
    db.prepare("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)").run(1, checksum, "2026-08-17T00:00:00.000Z");
    db.prepare("INSERT INTO store_meta (key, value_json) VALUES (?, ?)").run("sentinel", JSON.stringify({ kept: true }));
    db.close();

    const upgraded = openDatabase(dbPath);
    const sentinel = upgraded.prepare("SELECT value_json FROM store_meta WHERE key = 'sentinel'").get() as { value_json: string };
    assert.equal(sentinel.value_json, JSON.stringify({ kept: true }));
    const versions = upgraded.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
    assert.deepEqual(versions.map(row => row.version), MIGRATIONS.map(migration => migration.version));
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'claim_violation_projection'").get());
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_event_projection'").get());
    upgraded.close();
  } finally {
    cleanupDir(dir);
  }
});

test("openDatabase rejects a diverged migration checksum", () => {
  const dir = mkTmpDir("mapctx-store-migration-checksum-");
  try {
    const dbPath = `${dir}/mapctx.db`;
    const db = openDatabase(dbPath);
    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("tampered-checksum");
    db.close();

    assert.throws(() => openDatabase(dbPath), /checksum mismatch/);
  } finally {
    cleanupDir(dir);
  }
});

test("StoreHandle.open materializes store-meta.json, mapctx.db, and integrity checks pass", () => {
  const dir = mkTmpDir("mapctx-store-materialize-");
  try {
    const handle = StoreHandle.open(dir);
    assert.ok(handle.nodeId);
    assert.ok(handle.incarnationId);
    assert.ok(fs.existsSync(`${dir}/store-meta.json`));
    handle.close();
    assert.equal(checkIntegrity(StoreHandle.dbPathFor(dir)), true);

    // Reopening reuses the same node/incarnation identity.
    const handle2 = StoreHandle.open(dir);
    assert.equal(handle2.nodeId, handle.nodeId);
    assert.equal(handle2.incarnationId, handle.incarnationId);
    handle2.close();
  } finally {
    cleanupDir(dir);
  }
});
