import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as path from "path"
import test, { type TestContext } from "node:test"

// T-161: minimal slice of the cli-quickwins.test.ts fixture -- same golden
// repo + isolated MAPCTX_HOME pattern, only the helpers this file uses.
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
  // Refusal contract (T-127): stdout is the result channel and stays empty;
  // stderr carries the structured JSON payload first, then an `Error:` line.
  const refused = (args: string[]) => {
    const result = cli([...args, "--json"]);
    assert.notEqual(result.status, 0, "expected a refusal");
    assert.equal(result.signal, null);
    assert.equal(String(result.stdout).trim(), "", "stdout is the result channel; a refusal is not a result");
    const stderr = String(result.stderr);
    const boundary = stderr.indexOf("\nError:");
    assert.ok(boundary > 0, stderr);
    const lines = stderr.split("\n").filter(line => line.length > 0);
    assert.equal(lines.length, 2, `expected exactly 2 non-empty stderr lines, got: ${JSON.stringify(lines)}`);
    assert.deepEqual(JSON.parse(lines[0]), JSON.parse(stderr.slice(0, boundary)), "the first stderr line alone must parse to the same payload");
    return { result, payload: JSON.parse(stderr.slice(0, boundary)), stderr };
  };
  return { ...f, cli, success, refused };
}

test("T-161 task update --set detail.prerequisites=... is refused, not merely non-zero: empty stdout, structured edge-list-not-patchable payload on stderr", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { payload } = f.refused(["task", "update", "T-102", "--set", "detail.prerequisites=T-101", "--actor", "test"]);
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, "edge-list-not-patchable");
});

test("T-161 task update --set detail.blocking=... is refused the same way", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { payload } = f.refused(["task", "update", "T-102", "--set", "detail.blocking=T-101", "--actor", "test"]);
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, "edge-list-not-patchable");
});

test("T-161 task update --depends-on is not collateral damage: still exits 0 under --json", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const updated = f.success(["task", "update", "T-102", "--depends-on", "T-101", "--actor", "test"]);
  assert.equal(updated.ok, true, JSON.stringify(updated));
});
