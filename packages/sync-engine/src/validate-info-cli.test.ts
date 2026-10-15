import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "fs"
import * as path from "path"
import test, { type TestContext } from "node:test"

// T-127/T-148: reuse the store's golden repo + isolated MAPCTX_HOME fixture,
// same pattern as cli-quickwins.test.ts. Its internal helpers are
// deliberately not part of the public package export surface.
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
  return { ...f, cli, success };
}

/**
 * The golden board starts with E-100, T-101, T-102 (3 tasks). Creates 7 more
 * so 10 tasks exist, then stamps every one's `updated` to the same date via
 * `task update --set priority=high` -- `task create` leaves `updated` null,
 * which the rule does not count, so only the subsequent update trips the
 * `count >= 10` threshold.
 */
function tripBulkTimestamp(f: ReturnType<typeof fixture>): string[] {
  const ids = ["E-100", "T-101", "T-102"]
  for (let i = 0; i < 7; i++) {
    const created = f.success(["task", "create", "--title", `Bulk task ${i}`, "--actor", "test"])
    ids.push(created.taskId)
  }
  for (const id of ids) {
    f.success(["task", "update", id, "--set", "priority=high", "--actor", "test"])
  }
  return ids
}

test("T-148: validate --write-baseline omits bulk-updated-timestamp; validate --baseline then exits 0 with the info surviving the baseline", t => {
  const f = fixture(t)
  f.success(["import", "--commit", "--actor", "test"])
  // The golden board's pre-existing error (completion-acceptance-incomplete
  // on T-102, which is "done" with an incomplete Acceptance) must still be
  // present and gets baselined away below -- this is not a zero-error board.
  tripBulkTimestamp(f)

  const baselinePath = path.join(f.repoDir, "baseline.json")
  f.success(["validate", "--write-baseline", baselinePath])
  const baselineFile = JSON.parse(fs.readFileSync(baselinePath, "utf8"))
  assert.ok(!baselineFile.issues.some((entry: { code: string }) => entry.code === "bulk-updated-timestamp"), JSON.stringify(baselineFile.issues))
  assert.ok(baselineFile.issues.some((entry: { code: string }) => entry.code === "completion-acceptance-incomplete"), JSON.stringify(baselineFile.issues))

  const result = f.cli(["validate", "--baseline", baselinePath, "--json"])
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  const bulk = payload.store.canonical.issues.find((issue: { code: string }) => issue.code === "bulk-updated-timestamp")
  assert.ok(bulk, JSON.stringify(payload.store.canonical.issues))
  assert.equal(bulk.severity, "info")
  assert.equal(payload.store.canonical.errors, 0, JSON.stringify(payload.store.canonical.issues))
  assert.equal(payload.store.canonical.warnings, 0, JSON.stringify(payload.store.canonical.issues))
})
