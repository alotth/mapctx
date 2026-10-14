import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "fs"
import * as path from "path"
import test, { type TestContext } from "node:test"

/**
 * T-141 / C2 (29b35fe): `--lease` on `task claim`/`task start`, precedence
 * over `[coordination]` and over the derived value, and the `[coordination]`
 * read-time refusal from the CLI's point of view. Same golden-repo +
 * isolated MAPCTX_HOME fixture as claim-redaction.test.ts / cli-quickwins.test.ts.
 * Nothing here touches the real `~/.mapctx`.
 */
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
  const refused = (args: string[]) => {
    const result = cli([...args, "--json"]);
    assert.notEqual(result.status, 0, "expected a refusal");
    assert.equal(result.signal, null);
    assert.equal(String(result.stdout).trim(), "", "stdout is the result channel; a refusal is not a result");
    const stderr = String(result.stderr);
    const lines = stderr.split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, stderr);
    // T-127/0.4.0 convention: the FIRST line of stderr is the compact JSON
    // refusal payload under --json, regardless of where the \nError: line falls.
    const payload = JSON.parse(lines[0]);
    return { result, payload, stderr };
  };
  return { ...f, cli, success, refused };
}

/** The golden fixture's T-101/T-102 are not freely claimable (missing workload/estimate or terminal); every test claims a fresh, clean executable task instead. */
function createClaimableTask(f: ReturnType<typeof fixture>, title: string, effort: string): string {
  const created = f.success(["task", "create", "--title", title, "--workload", "Normal", "--effort", effort, "--actor", "test"]);
  return created.taskId;
}

function leaseMsOfClaim(claimLike: { claim: { claimedAt: string; expiresAt: string } }): number {
  return new Date(claimLike.claim.expiresAt).getTime() - new Date(claimLike.claim.claimedAt).getTime();
}

/**
 * The CLI uses the real wall clock (no injected `now`), and `appendTaskClaim`
 * reads it twice -- once for the `nowMs` the lease is computed against, once
 * again for `claimedAt` -- so `expiresAt - claimedAt` can be a couple of
 * milliseconds short of the exact derived/override duration. A tolerance
 * check here is about that clock-read gap, not about the derivation itself,
 * which the store-level tests already pin exactly with an injected clock.
 */
function assertLeaseCloseTo(actualMs: number, expectedMs: number, label: string): void {
  const driftMs = expectedMs - actualMs;
  assert.ok(driftMs >= 0 && driftMs <= 50, `${label}: expected ~${expectedMs}ms, got ${actualMs}ms (drift ${driftMs}ms)`);
}

function appendCoordination(repoDir: string, tomlBody: string): void {
  fs.appendFileSync(path.join(repoDir, "mapctx.toml"), `\n[coordination]\n${tomlBody}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// 8. --lease <duration> and --lease=<duration> both override the derived value.
// ---------------------------------------------------------------------------

test("task claim --lease 4h sets the lease to 4h, not the derived value", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "lease flag task", "1d"); // derives to 4h by default; --lease picks a different number so the override is unmistakable

  const claimed = f.success(["task", "claim", taskId, "--lease", "6h", "--actor", "test"]);
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assertLeaseCloseTo(leaseMsOfClaim(claimed), 6 * 60 * 60 * 1000, "--lease 6h");
});

test("the inline --lease=4h form works the same as --lease 4h", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "lease inline flag task", "1d");

  const claimed = f.success(["task", "claim", taskId, "--lease=6h", "--actor", "test"]);
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assertLeaseCloseTo(leaseMsOfClaim(claimed), 6 * 60 * 60 * 1000, "--lease=6h");
});

// ---------------------------------------------------------------------------
// 9. Full precedence: --lease > [coordination] > derived, and --lease is
// deliberately NOT clamped by maxLease.
// ---------------------------------------------------------------------------

test("precedence: no flag uses [coordination]'s derived value; --lease wins over it, even above maxLease (the flag is never clamped)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  // leaseFactor=1 and maxLease=8h: a 2h-effort task derives to exactly 2h,
  // comfortably inside maxLease, so the "no flag" case is unambiguous.
  appendCoordination(f.repoDir, 'leaseFactor = 1\nmaxLease = "8h"\n');
  const taskId = createClaimableTask(f, "precedence task", "2h");

  const derived = f.success(["task", "claim", taskId, "--actor", "test"]);
  assert.equal(derived.ok, true, JSON.stringify(derived));
  assertLeaseCloseTo(leaseMsOfClaim(derived), 2 * 60 * 60 * 1000, "no flag: the config-derived value (2h x leaseFactor 1 = 2h)");

  const taskId2 = createClaimableTask(f, "precedence task 2", "2h");
  const overridden = f.success(["task", "claim", taskId2, "--lease", "10h", "--actor", "test"]);
  assert.equal(overridden.ok, true, JSON.stringify(overridden));
  assertLeaseCloseTo(leaseMsOfClaim(overridden), 10 * 60 * 60 * 1000, "--lease wins over config, and 10h > maxLease(8h) is honoured as written, never clamped down");
});

// ---------------------------------------------------------------------------
// 10. Invalid --lease refuses with the T-127/0.4.0 channel contract.
// ---------------------------------------------------------------------------

test("task claim --lease banana refuses: non-zero exit, empty stdout, first stderr line is the compact refusal JSON under --json, message names accepted formats", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "bad lease task", "1d");

  const { payload, stderr } = f.refused(["task", "claim", taskId, "--lease", "banana", "--actor", "test"]);
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, "invalid-lease");
  assert.equal(payload.lease, "banana");
  assert.match(stderr, /30m/);
  assert.match(stderr, /4h/);
  assert.match(stderr, /1d/);

  // Human mode: same refusal, no JSON payload on stderr at all.
  const human = f.cli(["task", "claim", taskId, "--lease", "banana", "--actor", "test"]);
  assert.notEqual(human.status, 0);
  assert.equal(String(human.stdout).trim(), "");
  assert.ok(!String(human.stderr).includes("{"), `expected no JSON payload without --json: ${human.stderr}`);
  assert.match(String(human.stderr), /^Error: /);
});

// ---------------------------------------------------------------------------
// 11. task start resolves --lease the same way as task claim.
// ---------------------------------------------------------------------------

test("task start --lease 1d sets the lease to 1d, the same resolution as task claim", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "start lease task", "4h"); // derives to 2h by default; 1d picks a different number

  const started = f.success(["task", "start", taskId, "--lease", "1d", "--actor", "test"]);
  assert.equal(started.ok, true, JSON.stringify(started));
  const durationMs = new Date(started.expiresAt).getTime() - new Date(started.claim.claimedAt).getTime();
  // --lease is parsed by the same parseEstimatedEffortMs as estimatedEffort,
  // whose "d" unit is 8 agent-active hours (@mapctx/protocol's convention),
  // not a calendar day.
  assertLeaseCloseTo(durationMs, 8 * 60 * 60 * 1000, "--lease 1d on task start");
});

// ---------------------------------------------------------------------------
// 12. An invalid [coordination] refuses ANY command that opens the project,
// naming the key and the mapctx.toml path.
// ---------------------------------------------------------------------------

test("an invalid [coordination] in mapctx.toml refuses any command that opens the project, citing the offending key and the file path", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "poisoned config task", "1h");
  appendCoordination(f.repoDir, 'maxLease = "not-a-duration"\n');

  for (const args of [["task", "show", taskId], ["task", "claim", taskId, "--actor", "test"], ["task", "search", "--query", "poisoned"]]) {
    const result = f.cli([...args, "--json"]);
    assert.notEqual(result.status, 0, `${JSON.stringify(args)}: expected a refusal`);
    const stderr = String(result.stderr);
    assert.match(stderr, /maxLease/, `${JSON.stringify(args)}: ${stderr}`);
    assert.ok(stderr.includes(path.join(f.repoDir, "mapctx.toml")), `${JSON.stringify(args)}: message must name the mapctx.toml path: ${stderr}`);
  }
});

// ---------------------------------------------------------------------------
// 13. --help documents --lease and [coordination] -- an acceptance criterion,
// so pinned by a test rather than left to manual inspection.
// ---------------------------------------------------------------------------

test("--help documents --lease on task claim and task start, and the [coordination] block", t => {
  const f = fixture(t);
  const help = f.cli(["--help"]).stdout;
  const claimLine = help.split("\n").find(line => line.includes("mapctx task claim"));
  const startLine = help.split("\n").find(line => line.includes("mapctx task start"));
  assert.ok(claimLine, help);
  assert.ok(startLine, help);
  assert.match(claimLine!, /--lease/);
  assert.match(startLine!, /--lease/);
  assert.match(help, /\[coordination\]/);
  assert.match(help, /leaseFactor/);
});
