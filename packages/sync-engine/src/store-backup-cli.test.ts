import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "fs"
import * as path from "path"
import test, { type TestContext } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { MIGRATIONS, readMapctxToml, resolveProjectStoreDir, StoreHandle } from "@mapctx/store"

// T-138: same golden-repo + isolated MAPCTX_HOME fixture used across the
// T-127 CLI test files. Its internal helpers are deliberately not part of
// the public package export surface.
const { setupGoldenRepo, cleanupDir } = require(path.join(path.dirname(require.resolve("@mapctx/store")), "__test-helpers__.js")) as {
  setupGoldenRepo: () => { repoDir: string; mapctxHome: string; restoreEnv: () => void };
  cleanupDir: (dir: string) => void;
};

const CLI_PATH = require.resolve("./mapctx-cli.js")

function fixture(t: TestContext) {
  const f = setupGoldenRepo();
  t.after(() => { f.restoreEnv(); cleanupDir(f.repoDir); cleanupDir(f.mapctxHome); });
  const cli = (args: string[]) => spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: f.repoDir, encoding: "utf8", env: { ...process.env, MAPCTX_HOME: f.mapctxHome }
  });
  const success = (args: string[]) => {
    const result = cli([...args, "--json"]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    return JSON.parse(result.stdout);
  };
  // T-127 channel contract: stdout empty, the structured refusal is stderr's
  // first (compact JSON) line, followed by the human `Error:` line.
  const refused = (args: string[]) => {
    const result = cli([...args, "--json"]);
    assert.notEqual(result.status, 0, "expected a refusal");
    assert.equal(result.signal, null);
    assert.equal(String(result.stdout).trim(), "", "stdout is the result channel; a refusal is not a result");
    const stderr = String(result.stderr);
    const boundary = stderr.indexOf("\nError:");
    assert.ok(boundary > 0, stderr);
    return { result, payload: JSON.parse(stderr.slice(0, boundary)), stderr };
  };
  const storeDir = () => resolveProjectStoreDir(readMapctxToml(path.join(f.repoDir, "mapctx.toml")).projectId);
  const read = <T>(fn: (handle: StoreHandle) => T): T => {
    const handle = StoreHandle.openReadOnly(storeDir());
    try { return fn(handle); } finally { handle.close(); }
  };
  return { ...f, cli, success, refused, storeDir, read };
}

test("store backup -> store verify-backup -> store restore round trip via the CLI", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  const backup = f.success(["store", "backup"]);
  assert.ok(backup.backupDir);
  assert.ok(backup.eventCount > 0);

  const verified = f.success(["store", "verify-backup", backup.backupDir]);
  assert.equal(verified.ok, true);

  // Restoring over the live store requires --force.
  const blocked = f.cli(["store", "restore", backup.backupDir, "--json"]);
  assert.notEqual(blocked.status, 0);
  assert.match(String(blocked.stderr), /--force/);

  const restored = f.success(["store", "restore", backup.backupDir, "--force"]);
  assert.equal(restored.restored, true);
  assert.ok(restored.replacedStoreMovedTo, "the pre-restore store must be moved aside, not deleted");
  assert.ok(fs.existsSync(path.join(restored.replacedStoreMovedTo, "mapctx.db")));

  const listed = f.success(["store", "backups"]);
  assert.ok(Array.isArray(listed.backups) && listed.backups.length >= 1);
});

test("store verify-backup on a tampered archive is a refusal: stdout empty, stderr's first line is the compact payload", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const backup = f.success(["store", "backup"]);

  const manifestPath = path.join(backup.backupDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const metaEntry = manifest.files.find((file: { path: string }) => file.path === "store-meta.json");
  assert.ok(metaEntry, "sanity: store-meta.json must be in the archive");
  const metaPath = path.join(backup.backupDir, "store-meta.json");
  const original = fs.readFileSync(metaPath, "utf8");
  fs.writeFileSync(metaPath, original.includes("0") ? original.replace("0", "1") : `${original.slice(0, -1)}X`);

  const { payload } = f.refused(["store", "verify-backup", backup.backupDir]);
  assert.equal(payload.ok, false);
  assert.ok(payload.problems.some((p: { path: string }) => p.path === "store-meta.json"));
});

test("store repair still prints its report to stdout even though it now also takes a pre-repair snapshot (noted on stderr)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  const repair = f.cli(["store", "repair", "--json"]);
  assert.equal(repair.status, 0, repair.stderr);
  assert.notEqual(String(repair.stdout).trim(), "", "the repair report is the deliverable and must stay on stdout");
  const report = JSON.parse(repair.stdout);
  assert.equal(report.status, "ok");
  assert.match(String(repair.stderr), /Note: pre-repair snapshot/);

  const backups = f.success(["store", "backups"]);
  assert.ok(backups.backups.some((b: { manifest: { reason: string } | null }) => b.manifest?.reason === "pre-repair"));
});

test("store init --from-git <ref> reports the resolved checkpointSource; without it, human mode warns the working copy may not be committed", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const storeDir = f.storeDir();
  fs.rmSync(storeDir, { recursive: true, force: true });

  const viaGit = f.success(["store", "init", "--from-git", "HEAD"]);
  assert.equal(viaGit.checkpointSource.kind, "git");
  assert.equal(viaGit.checkpointSource.ref, "HEAD");
  assert.ok(viaGit.checkpointSource.commit);

  fs.rmSync(storeDir, { recursive: true, force: true });
  const viaDiskHuman = f.cli(["store", "init"]);
  assert.equal(viaDiskHuman.status, 0, viaDiskHuman.stderr);
  assert.match(viaDiskHuman.stdout, /may not be committed/);
});

test("redact --commit warns when a backup predates the redaction, naming the backups directory", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  // Produce an event with a redactable field: only a handful of event types
  // carry one (REDACTABLE_ROOTS in redact.ts); task.patched is not among
  // them. acceptance.approved's `evidence` root is, so author and approve a
  // criterion with evidence to get a genuine candidate.
  fs.writeFileSync(path.join(f.repoDir, "acceptance.md"), "## Acceptance\n- [ ] one\n");
  f.success(["task", "acceptance", "revise", "T-101", "--from-file", "acceptance.md", "--expect-revision", "0", "--actor", "test"]);
  f.success(["task", "acceptance", "approve", "T-101", "--index", "0", "--expect-revision", "1", "--evidence", "customer=will-be-redacted", "--actor", "test"]);
  f.success(["store", "backup"]);

  const candidates = f.success(["redact", "list"]).candidates as Array<{ nodeId: string; sequence: number; redactableFieldPaths: string[] }>;
  const candidate = candidates.find(c => c.redactableFieldPaths.length > 0);
  assert.ok(candidate, "sanity: the golden board must have at least one redactable field");

  const result = f.cli([
    "redact", "--node", candidate!.nodeId, "--sequence", String(candidate!.sequence),
    "--field", candidate!.redactableFieldPaths[0], "--reason", "test redaction", "--actor", "dpo", "--commit", "--json"
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(String(result.stderr), /backup\(s\) under/);
  assert.match(String(result.stderr), /were taken BEFORE this redaction/);
});

test("MUTATION GUARD (MEDIA-1): a pre-migration snapshot notice reaches stderr even when the trigger is NOT a store-prefixed command, and even on the error path", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  const dbPath = path.join(f.storeDir(), "mapctx.db");
  const lastMigrationVersion = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
  const db = new DatabaseSync(dbPath);
  db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(lastMigrationVersion);
  db.close();

  // `task move` is deliberately NOT one of the three store-prefixed commands
  // reportSnapshotNotices() used to be hand-wired into. The pre-migration
  // hook fires on ANY writable open, and the migration itself fails here
  // (it is not idempotent), so this also proves the notice survives the
  // error path, not only a clean exit.
  const result = f.cli(["task", "move", "T-101", "--status", "ready-for-do", "--actor", "test", "--json"]);
  assert.notEqual(result.status, 0, "the re-applied migration must fail");
  assert.match(String(result.stderr), /Note: pre-migration snapshot/);
});
