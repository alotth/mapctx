import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "fs"
import * as path from "path"
import test, { type TestContext } from "node:test"
import { getClaim, readMapctxToml, StoreHandle } from "@mapctx/store"

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
 * The CLI uses the real wall clock (no injected `now`). Since T-162,
 * `appendTaskClaim` derives `claimedAt` and `expiresAt` from ONE clock read, so
 * `expiresAt - claimedAt` is the derived/override duration exactly -- no
 * tolerance. A drift here means the two timestamps came from different reads
 * again.
 */
function assertLeaseCloseTo(actualMs: number, expectedMs: number, label: string): void {
  assert.equal(actualMs, expectedMs, `${label}: expected exactly ${expectedMs}ms, got ${actualMs}ms (drift ${expectedMs - actualMs}ms)`);
}

function appendCoordination(repoDir: string, tomlBody: string): void {
  fs.appendFileSync(path.join(repoDir, "mapctx.toml"), `\n[coordination]\n${tomlBody}\n`, "utf8");
}

/** Reads a claim row directly from the store, bypassing the CLI entirely -- for asserting that a refused command changed nothing. */
function readClaimDirectly(f: ReturnType<typeof fixture>, claimId: string) {
  const toml = readMapctxToml(path.join(f.repoDir, "mapctx.toml"));
  const storeDir = path.join(f.mapctxHome, "projects", toml.projectId);
  const handle = StoreHandle.openReadOnly(storeDir);
  try {
    return getClaim(handle.db, claimId);
  } finally {
    handle.close();
  }
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
// fcb2720 (attempt 2), B1: --lease is refused on renew, not silently dropped
// -- and nothing renews when it is.
// ---------------------------------------------------------------------------

test("B1: task renew --claim --token --lease 15m refuses (lease-not-accepted-on-renew), citing the re-derivation, and renews NOTHING", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "renew flag task", "4h");

  const claimed = f.success(["task", "claim", taskId, "--actor", "test"]);
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const claimId: string = claimed.claim.claimId;
  const token: string = claimed.claim.leaseToken;
  const expiresAtBefore: string = claimed.claim.expiresAt;

  const { payload, stderr } = f.refused(["task", "renew", taskId, "--claim", claimId, "--token", token, "--lease", "15m"]);
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, "lease-not-accepted-on-renew");
  assert.equal(payload.lease, "15m");
  assert.match(stderr, /re-derives the lease from the task plan/);

  // The point of the finding this fixes: before, the flag was discarded and
  // the renewal happened anyway with the derived duration. Now nothing moves.
  const claimRow = readClaimDirectly(f, claimId);
  assert.ok(claimRow, "the claim row must still exist");
  assert.equal(claimRow!.state, "active", "not touched by the refused attempt");
  assert.equal(claimRow!.expiresAt, expiresAtBefore, "expiresAt must be byte-identical to before the refused renew -- nothing was renewed");
});

test("B1, order: task renew --lease 15m WITHOUT --claim/--token still refuses by the flag's own name, not the missing-claim/token message", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "renew flag order task", "4h");
  f.success(["task", "claim", taskId, "--actor", "test"]);

  const { payload, stderr } = f.refused(["task", "renew", taskId, "--lease", "15m"]);
  assert.equal(payload.reason, "lease-not-accepted-on-renew", "the --lease refusal must win even with --claim/--token also missing");
  assert.ok(!/requires --claim/.test(stderr), `must not instead report the missing --claim/--token: ${stderr}`);
});

// ---------------------------------------------------------------------------
// fcb2720, B3: --lease is still not clamped by maxLease, but it IS bounded
// by the 24h absolute ceiling -- refused above it, not shrunk. Exact boundary.
// ---------------------------------------------------------------------------

test("B3 boundary: --lease 24h is accepted at exactly 24h; --lease 1441m (24h+1m) and --lease 9999w are refused with lease-above-ceiling, citing 24h", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  const atCeiling = createClaimableTask(f, "lease at ceiling", "1h");
  const claimed = f.success(["task", "claim", atCeiling, "--lease", "24h", "--actor", "test"]);
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assertLeaseCloseTo(leaseMsOfClaim(claimed), 24 * 60 * 60 * 1000, "--lease 24h: exactly at the ceiling, must be accepted");

  const overByAMinute = createClaimableTask(f, "lease one minute over ceiling", "1h");
  const { payload: minutePayload, stderr: minuteStderr } = f.refused(["task", "claim", overByAMinute, "--lease", "1441m", "--actor", "test"]);
  assert.equal(minutePayload.reason, "lease-above-ceiling");
  assert.equal(minutePayload.lease, "1441m");
  assert.equal(minutePayload.ceilingMs, 24 * 60 * 60 * 1000);
  assert.match(minuteStderr, /24h/);

  const wayOver = createClaimableTask(f, "lease 9999 weeks", "1h");
  const { payload: weekPayload } = f.refused(["task", "claim", wayOver, "--lease", "9999w", "--actor", "test"]);
  assert.equal(weekPayload.reason, "lease-above-ceiling");
  assert.equal(weekPayload.ceilingMs, 24 * 60 * 60 * 1000);
});

test("B3 boundary on task start too: --lease 1441m is refused the same way, proving claim and start share one resolution", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "start lease over ceiling", "1h");

  const { payload } = f.refused(["task", "start", taskId, "--lease", "1441m", "--actor", "test"]);
  assert.equal(payload.reason, "lease-above-ceiling");
  assert.equal(payload.ceilingMs, 24 * 60 * 60 * 1000);
});

test("B3: nothing changed below the 24h ceiling -- --lease above maxLease but under 24h is still accepted unclamped (the new ceiling is not a disguised clamp)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  appendCoordination(f.repoDir, 'maxLease = "8h"\n');
  const taskId = createClaimableTask(f, "below ceiling above maxLease task", "1h");

  const claimed = f.success(["task", "claim", taskId, "--lease", "12h", "--actor", "test"]);
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assertLeaseCloseTo(leaseMsOfClaim(claimed), 12 * 60 * 60 * 1000, "--lease 12h with maxLease=8h: still unclamped, well under the 24h ceiling");
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

test("--help documents --lease on task claim and task start, the [coordination] block, the 24h ceiling, --lease's refusal on renew, and the estimatedEffort coupling", t => {
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

  // fcb2720 (attempt 2): the 24h absolute ceiling, documented near claim/start.
  assert.match(help, /24h absolute ceiling/);

  // B1: task renew's help states the flag is refused, not silently dropped.
  const renewLine = help.split("\n").find(line => line.includes("mapctx task renew"));
  assert.ok(renewLine, help);
  assert.match(help, /--lease. is refused here/);

  // B2: the known estimatedEffort coupling is stated, not left to be discovered.
  assert.match(help, /detail\.estimatedEffort/);
  assert.match(help, /nothing requires.*holder|requires the editor to be the holder/);
});
