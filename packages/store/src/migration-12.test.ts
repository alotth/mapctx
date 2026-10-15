import assert from "node:assert/strict"
import * as crypto from "crypto"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { openDatabase } from "./db"
import { MIGRATIONS } from "./schema"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

/**
 * T-142 (C3 / D2): migration 12 adds `resource_claim_projection.renew_token`
 * (nullable, no backfill, NO DEFAULT -- a default would be a universal key).
 * Same build-a-legacy-store pattern as the other upgrade tests in
 * migration.test.ts (apply migrations <= N raw, insert a pre-migration row,
 * then let `openDatabase` bring it current).
 */

function buildV11Store(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of MIGRATIONS.filter(m => m.version <= 11)) {
    db.exec(migration.sql);
    const checksum = crypto.createHash("sha256").update(migration.sql, "utf8").digest("hex");
    db.prepare("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)").run(migration.version, checksum, "2026-10-01T00:00:00.000Z");
  }
  db.close();
}

function insertLegacyClaim(dbPath: string, claimId: string, taskId: string, leaseToken: string): void {
  const db = new DatabaseSync(dbPath);
  // The exact pre-migration-12 column set (schema.ts:106-116): no renew_token
  // column exists yet, so this INSERT cannot name it even if it wanted to.
  db.prepare(`
    INSERT INTO resource_claim_projection (claim_id, task_id, lease_token, state, claimed_at, expires_at, holder_json, event_node, event_sequence)
    VALUES (?, ?, ?, 'active', '2026-10-01T00:00:00.000Z', '2026-10-01T00:30:00.000Z', '{}', 'node-a', 1)
  `).run(claimId, taskId, leaseToken);
  db.close();
}

test("migration 12 adds resource_claim_projection.renew_token, nullable, no backfill: pre-existing rows get NULL, not a shared default", () => {
  const dir = mkTmpDir("mapctx-store-migration-12-");
  try {
    const dbPath = `${dir}/mapctx.db`;
    buildV11Store(dbPath);
    const claimIdA = crypto.randomUUID();
    const claimIdB = crypto.randomUUID();
    insertLegacyClaim(dbPath, claimIdA, "T-A", crypto.randomBytes(24).toString("hex"));
    insertLegacyClaim(dbPath, claimIdB, "T-B", crypto.randomBytes(24).toString("hex"));

    const upgraded = openDatabase(dbPath);
    try {
      const columns = (upgraded.prepare("PRAGMA table_info(resource_claim_projection)").all() as Array<{ name: string }>).map(c => c.name);
      assert.ok(columns.includes("renew_token"), "the column must exist after upgrade");

      const versions = upgraded.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
      assert.deepEqual(versions.map(row => row.version), MIGRATIONS.map(m => m.version));

      const rowA = upgraded.prepare("SELECT renew_token FROM resource_claim_projection WHERE claim_id = ?").get(claimIdA) as { renew_token: string | null };
      const rowB = upgraded.prepare("SELECT renew_token FROM resource_claim_projection WHERE claim_id = ?").get(claimIdB) as { renew_token: string | null };
      assert.equal(rowA.renew_token, null, "a pre-existing row gets NULL, not a backfilled value");
      assert.equal(rowB.renew_token, null, "every pre-existing row gets NULL");

      // NO DEFAULT: a fresh INSERT that does not name the column also lands
      // NULL -- there is no default value a legacy and a fresh-but-unset row
      // could end up sharing (which would be a universal key).
      const claimIdC = crypto.randomUUID();
      upgraded.prepare(`
        INSERT INTO resource_claim_projection (claim_id, task_id, lease_token, state, claimed_at, expires_at, holder_json, event_node, event_sequence)
        VALUES (?, 'T-C', ?, 'active', '2026-10-15T00:00:00.000Z', '2026-10-15T00:30:00.000Z', '{}', 'node-a', 2)
      `).run(claimIdC, crypto.randomBytes(24).toString("hex"));
      const rowC = upgraded.prepare("SELECT renew_token FROM resource_claim_projection WHERE claim_id = ?").get(claimIdC) as { renew_token: string | null };
      assert.equal(rowC.renew_token, null, "no DEFAULT: an insert that omits the column is NULL, same as a legacy row");

      // A claim with a renew_token explicitly set survives alongside the
      // NULL legacy rows, with no value shared between any of them.
      const claimIdD = crypto.randomUUID();
      const freshRenewToken = crypto.randomBytes(24).toString("hex");
      upgraded.prepare(`
        INSERT INTO resource_claim_projection (claim_id, task_id, lease_token, renew_token, state, claimed_at, expires_at, holder_json, event_node, event_sequence)
        VALUES (?, 'T-D', ?, ?, 'active', '2026-10-15T00:00:00.000Z', '2026-10-15T00:30:00.000Z', '{}', 'node-a', 3)
      `).run(claimIdD, crypto.randomBytes(24).toString("hex"), freshRenewToken);
      const rowD = upgraded.prepare("SELECT renew_token FROM resource_claim_projection WHERE claim_id = ?").get(claimIdD) as { renew_token: string | null };
      assert.equal(rowD.renew_token, freshRenewToken);
      assert.notEqual(rowD.renew_token, rowA.renew_token);
    } finally {
      upgraded.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("migration 12 is idempotent: a second openDatabase against the same path does not re-apply it, and its recorded checksum matches its own sql", () => {
  const dir = mkTmpDir("mapctx-store-migration-12-idempotent-");
  try {
    const dbPath = `${dir}/mapctx.db`;
    const first = openDatabase(dbPath);
    const migration12 = MIGRATIONS.find(m => m.version === 12);
    assert.ok(migration12, "migration 12 must be registered");
    const expectedChecksum = crypto.createHash("sha256").update(migration12!.sql, "utf8").digest("hex");
    const recorded = first.prepare("SELECT checksum FROM schema_migrations WHERE version = 12").get() as { checksum: string } | undefined;
    assert.ok(recorded, "migration 12 must be recorded after the first open");
    assert.equal(recorded!.checksum, expectedChecksum);
    first.close();

    // Reopening must not throw (the checksum guard passes silently) and must
    // not duplicate the row.
    const second = openDatabase(dbPath);
    const rows = second.prepare("SELECT version FROM schema_migrations WHERE version = 12").all() as Array<{ version: number }>;
    assert.equal(rows.length, 1, "migration 12 is recorded exactly once across repeated opens");
    second.close();
  } finally {
    cleanupDir(dir);
  }
});

test("migration 12's checksum guard still rejects a tampered row, same as every other migration", () => {
  const dir = mkTmpDir("mapctx-store-migration-12-tamper-");
  try {
    const dbPath = `${dir}/mapctx.db`;
    const db = openDatabase(dbPath);
    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 12").run("tampered-checksum");
    db.close();
    assert.throws(() => openDatabase(dbPath), /checksum mismatch/);
  } finally {
    cleanupDir(dir);
  }
});
