import assert from "node:assert/strict"
import * as crypto from "crypto"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { openDatabase } from "./db"
import { MIGRATIONS } from "./schema"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

/**
 * T-144 (C5 / D5): migration 13 adds `resource_claim_projection.exclusivity`,
 * `resource_claim_projection.role` and `dispatch_projection.kind` -- all
 * `NOT NULL DEFAULT ... CHECK (...)`, never nullable, and swaps
 * `idx_resource_claim_active_task` under the SAME name so the old
 * `WHERE state = 'active'` predicate cannot survive anywhere. Same
 * build-a-legacy-store pattern as migration-12.test.ts: apply migrations <= N
 * raw, insert pre-migration rows, then let `openDatabase` bring the store
 * current.
 */

function buildV12Store(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (const migration of MIGRATIONS.filter(m => m.version <= 12)) {
    db.exec(migration.sql);
    const checksum = crypto.createHash("sha256").update(migration.sql, "utf8").digest("hex");
    db.prepare("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)").run(migration.version, checksum, "2026-10-01T00:00:00.000Z");
  }
  db.close();
}

function insertLegacyClaim(dbPath: string, claimId: string, taskId: string, leaseToken: string): void {
  const db = new DatabaseSync(dbPath);
  // The exact pre-migration-13 column set: no exclusivity/role columns exist
  // yet, so this INSERT cannot name them even if it wanted to.
  db.prepare(`
    INSERT INTO resource_claim_projection (claim_id, task_id, lease_token, state, claimed_at, expires_at, holder_json, event_node, event_sequence)
    VALUES (?, ?, ?, 'active', '2026-10-01T00:00:00.000Z', '2026-10-01T00:30:00.000Z', '{}', 'node-a', 1)
  `).run(claimId, taskId, leaseToken);
  db.close();
}

function insertLegacyDispatch(dbPath: string, dispatchId: string, taskId: string, attempt: number): void {
  const db = new DatabaseSync(dbPath);
  // Pre-migration-13: no `kind` column either.
  db.prepare(`
    INSERT INTO dispatch_projection (dispatch_id, task_id, executor_kind, attempt, context_hash, status)
    VALUES (?, ?, 'cli', ?, 'hash', 'running')
  `).run(dispatchId, taskId, attempt);
  db.close();
}

test("migration 13 upgrades a legacy (schema <= 12) store: the store opens, zero NULLs, exactly one index under the old name with the new predicate", () => {
  const dir = mkTmpDir("mapctx-store-migration-13-");
  try {
    const dbPath = `${dir}/mapctx.db`;
    buildV12Store(dbPath);
    const claimIdA = crypto.randomUUID();
    const claimIdB = crypto.randomUUID();
    insertLegacyClaim(dbPath, claimIdA, "T-A", crypto.randomBytes(24).toString("hex"));
    insertLegacyClaim(dbPath, claimIdB, "T-B", crypto.randomBytes(24).toString("hex"));
    insertLegacyDispatch(dbPath, crypto.randomUUID(), "T-A", 1);

    // The store opens without throwing: the upgrade succeeds end to end.
    const upgraded = openDatabase(dbPath);
    try {
      const versions = upgraded.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
      assert.deepEqual(versions.map(row => row.version), MIGRATIONS.map(m => m.version));

      const claimColumns = (upgraded.prepare("PRAGMA table_info(resource_claim_projection)").all() as Array<{ name: string }>).map(c => c.name);
      assert.ok(claimColumns.includes("exclusivity") && claimColumns.includes("role"), "both new claim columns must exist after upgrade");
      const dispatchColumns = (upgraded.prepare("PRAGMA table_info(dispatch_projection)").all() as Array<{ name: string }>).map(c => c.name);
      assert.ok(dispatchColumns.includes("kind"), "the new dispatch column must exist after upgrade");

      // Exactly one index of this name, and its SQL carries the NEW predicate.
      const indexRows = upgraded.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_resource_claim_active_task'"
      ).all() as Array<{ sql: string | null }>;
      assert.equal(indexRows.length, 1, "exactly one index named idx_resource_claim_active_task");
      assert.match(indexRows[0]!.sql ?? "", /exclusivity\s*=\s*'exclusive'/, "the surviving index's SQL must carry the new predicate");

      // Zero NULLs in any of the three new columns -- migration 13's whole
      // safety argument is NOT NULL DEFAULT with no backfill window.
      const nullClaims = (upgraded.prepare(
        "SELECT COUNT(*) AS n FROM resource_claim_projection WHERE exclusivity IS NULL OR role IS NULL"
      ).get() as { n: number }).n;
      assert.equal(nullClaims, 0, "zero NULL exclusivity/role rows after migration");
      const nullDispatches = (upgraded.prepare(
        "SELECT COUNT(*) AS n FROM dispatch_projection WHERE kind IS NULL"
      ).get() as { n: number }).n;
      assert.equal(nullDispatches, 0, "zero NULL kind rows after migration");

      const rowA = upgraded.prepare("SELECT exclusivity, role FROM resource_claim_projection WHERE claim_id = ?").get(claimIdA) as { exclusivity: string; role: string };
      assert.equal(rowA.exclusivity, "exclusive");
      assert.equal(rowA.role, "implement");
      const rowB = upgraded.prepare("SELECT exclusivity, role FROM resource_claim_projection WHERE claim_id = ?").get(claimIdB) as { exclusivity: string; role: string };
      assert.equal(rowB.exclusivity, "exclusive");
      assert.equal(rowB.role, "implement");
      const dispatchRow = upgraded.prepare("SELECT kind FROM dispatch_projection WHERE task_id = ?").get("T-A") as { kind: string };
      assert.equal(dispatchRow.kind, "implement");
    } finally {
      upgraded.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("after migration, a second EXCLUSIVE claim on the same task fails UNIQUE, but a SHARED review claim is admitted beside a live exclusive one", () => {
  const dir = mkTmpDir("mapctx-store-migration-13-unique-");
  try {
    const dbPath = `${dir}/mapctx.db`;
    buildV12Store(dbPath);
    const firstClaimId = crypto.randomUUID();
    insertLegacyClaim(dbPath, firstClaimId, "T-C", crypto.randomBytes(24).toString("hex"));
    const upgraded = openDatabase(dbPath);
    try {
      // T-C now holds an exclusive implement claim (the migrated legacy row).
      // A second exclusive claim on the SAME task must fail UNIQUE.
      assert.throws(
        () => upgraded.prepare(`
          INSERT INTO resource_claim_projection (claim_id, task_id, lease_token, state, claimed_at, expires_at, holder_json, event_node, event_sequence, exclusivity, role)
          VALUES (?, 'T-C', ?, 'active', '2026-10-15T00:00:00.000Z', '2026-10-15T00:30:00.000Z', '{}', 'node-a', 2, 'exclusive', 'implement')
        `).run(crypto.randomUUID(), crypto.randomBytes(24).toString("hex")),
        /UNIQUE constraint failed/
      );

      // A SHARED review claim on the same task, beside the live exclusive
      // row, must insert cleanly -- the whole point of the swapped predicate.
      const reviewClaimId = crypto.randomUUID();
      assert.doesNotThrow(() => upgraded.prepare(`
        INSERT INTO resource_claim_projection (claim_id, task_id, lease_token, state, claimed_at, expires_at, holder_json, event_node, event_sequence, exclusivity, role)
        VALUES (?, 'T-C', ?, 'active', '2026-10-15T00:00:00.000Z', '2026-10-15T00:30:00.000Z', '{}', 'node-a', 3, 'shared', 'review')
      `).run(reviewClaimId, crypto.randomBytes(24).toString("hex")));

      const activeOnTask = upgraded.prepare("SELECT claim_id FROM resource_claim_projection WHERE task_id = 'T-C' AND state = 'active'").all() as Array<{ claim_id: string }>;
      assert.deepEqual(new Set(activeOnTask.map(r => r.claim_id)), new Set([firstClaimId, reviewClaimId]), "both the migrated exclusive claim and the new shared one are active side by side");

      // A SECOND shared/review claim is also admitted -- shared rows are
      // deliberately uncapped (two reviewers on one task is legitimate).
      assert.doesNotThrow(() => upgraded.prepare(`
        INSERT INTO resource_claim_projection (claim_id, task_id, lease_token, state, claimed_at, expires_at, holder_json, event_node, event_sequence, exclusivity, role)
        VALUES (?, 'T-C', ?, 'active', '2026-10-15T00:00:00.000Z', '2026-10-15T00:30:00.000Z', '{}', 'node-a', 4, 'shared', 'review')
      `).run(crypto.randomUUID(), crypto.randomBytes(24).toString("hex")));
    } finally {
      upgraded.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("a legacy writer that omits the new columns on a fresh insert lands on the defaults exclusive/implement/implement", () => {
  const dir = mkTmpDir("mapctx-store-migration-13-legacy-writer-");
  try {
    const dbPath = `${dir}/mapctx.db`;
    const upgraded = openDatabase(dbPath); // fresh database: every migration applies, including 13
    try {
      const claimId = crypto.randomUUID();
      // A writer built against schema <= 12 names none of the new columns.
      upgraded.prepare(`
        INSERT INTO resource_claim_projection (claim_id, task_id, lease_token, state, claimed_at, expires_at, holder_json, event_node, event_sequence)
        VALUES (?, 'T-D', ?, 'active', '2026-10-15T00:00:00.000Z', '2026-10-15T00:30:00.000Z', '{}', 'node-a', 1)
      `).run(claimId, crypto.randomBytes(24).toString("hex"));
      const claimRow = upgraded.prepare("SELECT exclusivity, role FROM resource_claim_projection WHERE claim_id = ?").get(claimId) as { exclusivity: string; role: string };
      assert.equal(claimRow.exclusivity, "exclusive");
      assert.equal(claimRow.role, "implement");

      const dispatchId = crypto.randomUUID();
      upgraded.prepare(`
        INSERT INTO dispatch_projection (dispatch_id, task_id, executor_kind, attempt, context_hash, status)
        VALUES (?, 'T-D', 'cli', 1, 'hash', 'running')
      `).run(dispatchId);
      const dispatchRow = upgraded.prepare("SELECT kind FROM dispatch_projection WHERE dispatch_id = ?").get(dispatchId) as { kind: string };
      assert.equal(dispatchRow.kind, "implement");
    } finally {
      upgraded.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("both CHECK constraints refuse a value outside the enum: claim exclusivity, claim role, dispatch kind", () => {
  const dir = mkTmpDir("mapctx-store-migration-13-check-");
  try {
    const dbPath = `${dir}/mapctx.db`;
    const upgraded = openDatabase(dbPath);
    try {
      assert.throws(
        () => upgraded.prepare(`
          INSERT INTO resource_claim_projection (claim_id, task_id, lease_token, state, claimed_at, expires_at, holder_json, event_node, event_sequence, exclusivity, role)
          VALUES (?, 'T-E', ?, 'active', '2026-10-15T00:00:00.000Z', '2026-10-15T00:30:00.000Z', '{}', 'node-a', 1, 'bogus', 'implement')
        `).run(crypto.randomUUID(), crypto.randomBytes(24).toString("hex")),
        /CHECK constraint failed/,
        "an exclusivity value outside the enum must be refused"
      );
      assert.throws(
        () => upgraded.prepare(`
          INSERT INTO resource_claim_projection (claim_id, task_id, lease_token, state, claimed_at, expires_at, holder_json, event_node, event_sequence, exclusivity, role)
          VALUES (?, 'T-E', ?, 'active', '2026-10-15T00:00:00.000Z', '2026-10-15T00:30:00.000Z', '{}', 'node-a', 2, 'exclusive', 'bogus')
        `).run(crypto.randomUUID(), crypto.randomBytes(24).toString("hex")),
        /CHECK constraint failed/,
        "a role value outside the enum must be refused"
      );
      assert.throws(
        () => upgraded.prepare(`
          INSERT INTO dispatch_projection (dispatch_id, task_id, executor_kind, attempt, context_hash, status, kind)
          VALUES (?, 'T-E', 'cli', 1, 'hash', 'running', 'bogus')
        `).run(crypto.randomUUID()),
        /CHECK constraint failed/,
        "a dispatch kind value outside the enum must be refused"
      );
    } finally {
      upgraded.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("migration 13 is idempotent and its checksum guard rejects a tampered row, same as every other migration", () => {
  const dir = mkTmpDir("mapctx-store-migration-13-idempotent-");
  try {
    const dbPath = `${dir}/mapctx.db`;
    const first = openDatabase(dbPath);
    const migration13 = MIGRATIONS.find(m => m.version === 13);
    assert.ok(migration13, "migration 13 must be registered");
    const expectedChecksum = crypto.createHash("sha256").update(migration13!.sql, "utf8").digest("hex");
    const recorded = first.prepare("SELECT checksum FROM schema_migrations WHERE version = 13").get() as { checksum: string } | undefined;
    assert.ok(recorded, "migration 13 must be recorded after the first open");
    assert.equal(recorded!.checksum, expectedChecksum);
    first.close();

    const second = openDatabase(dbPath);
    const rows = second.prepare("SELECT version FROM schema_migrations WHERE version = 13").all() as Array<{ version: number }>;
    assert.equal(rows.length, 1, "migration 13 is recorded exactly once across repeated opens");
    second.close();

    const third = openDatabase(dbPath);
    third.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 13").run("tampered-checksum");
    third.close();
    assert.throws(() => openDatabase(dbPath), /checksum mismatch/);
  } finally {
    cleanupDir(dir);
  }
});
