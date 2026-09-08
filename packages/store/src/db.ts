import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { DatabaseSync } from "node:sqlite"
import { MIGRATIONS } from "./schema"

export type OpenDatabaseOptions = {
  busyTimeoutMs?: number
}

function checksumOf(sql: string): string {
  return crypto.createHash("sha256").update(sql, "utf8").digest("hex")
}

function applyPragmas(db: DatabaseSync, options: OpenDatabaseOptions): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  db.exec("PRAGMA synchronous = FULL");
}

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedStmt = db.prepare("SELECT version, checksum FROM schema_migrations WHERE version = ?");
  const insertStmt = db.prepare("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)");

  for (const migration of MIGRATIONS) {
    const checksum = checksumOf(migration.sql);
    const existing = appliedStmt.get(migration.version) as { version: number; checksum: string } | undefined;
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(
          `Migration ${migration.version} checksum mismatch: on-disk migration binary has diverged from the applied schema. Refusing to proceed.`
        );
      }
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      insertStmt.run(migration.version, checksum, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function openDatabase(dbPath: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  applyPragmas(db, options);
  runMigrations(db);
  return db;
}

/**
 * Read-only open of an EXISTING database (R14): no file creation, no
 * migrations, no metadata writes. Query commands must observe the store
 * without changing it -- including the maintenance state, which they surface
 * instead of healing.
 */
export function openDatabaseReadOnly(dbPath: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Cannot open read-only: database not found at ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  return db;
}

/**
 * Read-only schema state: which migrations are pending, and whether any
 * applied migration checksum diverges. Never applies anything.
 */
export function schemaMaintenanceNeeded(db: DatabaseSync): string | null {
  try {
    const applied = db.prepare(
      "SELECT version, checksum FROM schema_migrations ORDER BY version ASC"
    ).all() as Array<{ version: number; checksum: string }>;
    for (const migration of MIGRATIONS) {
      const existing = applied.find(row => row.version === migration.version);
      if (!existing) {
        return `schema migration ${migration.version} is pending (run the materialization path: mapctx store init or repair)`;
      }
      if (existing.checksum !== checksumOf(migration.sql)) {
        return `schema migration ${migration.version} checksum mismatch on disk (run repair)`;
      }
    }
    return null;
  } catch (error) {
    return `schema state unreadable: ${String(error)}`;
  }
}

export function checkIntegrity(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  try {
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
      return row?.integrity_check === "ok";
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export function readMetaValue<T>(db: DatabaseSync, key: string): T | undefined {
  const row = db.prepare("SELECT value_json FROM store_meta WHERE key = ?").get(key) as { value_json: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.value_json) as T;
}

export function writeMetaValue(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO store_meta (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
  ).run(key, JSON.stringify(value));
}

export function clearProjections(db: DatabaseSync): void {
  const tables = [
    "project_projection",
    "task_projection",
    "task_detail_projection",
    "dependency_projection",
    "external_ref_projection",
    "resource_claim_projection",
    "artifact_ref_projection",
    "workflow_gate_projection",
    "dispatch_projection",
    "run_event_projection",
    "run_receipt_projection",
    "usage_event_projection",
    "cost_event_projection",
    "plan_period_projection",
    "estimate_snapshot_projection",
    "claim_violation_projection",
    "account_projection",
    "project_account_binding",
    "budget_projection",
    "export_checkpoint"
  ];
  for (const table of tables) {
    db.exec(`DELETE FROM ${table}`);
  }
}
