import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as path from "path"
import test, { type TestContext } from "node:test"
import { getClaim, LEASE_TOKEN_PATTERN, readMapctxToml, StoreHandle } from "@mapctx/store"

/**
 * T-142 / C3 (3fc253c): `renewToken` as a second claim capability, and
 * `task renew --dispatch` as a lookup, from the CLI's point of view. Same
 * golden-repo + isolated MAPCTX_HOME fixture as claim-redaction.test.ts /
 * lease-cli.test.ts. Nothing here touches the real `~/.mapctx`.
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
    const payload = JSON.parse(lines[0]);
    return { result, payload, stderr };
  };
  return { ...f, cli, success, refused };
}

function createClaimableTask(f: ReturnType<typeof fixture>, title: string, effort = "4h"): string {
  const created = f.success(["task", "create", "--title", title, "--workload", "Normal", "--effort", effort, "--actor", "test"]);
  return created.taskId;
}

/** Reads a claim row directly from the store, bypassing the CLI entirely. */
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
// 13. task start --json brings renewToken at the top.
// ---------------------------------------------------------------------------

test("task start --json carries renewToken at the top level, token-shaped", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "start renewToken task");

  const started = f.success(["task", "start", taskId, "--actor", "test"]);
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.match(started.renewToken, LEASE_TOKEN_PATTERN);
  assert.notEqual(started.renewToken, started.leaseToken);
});

// ---------------------------------------------------------------------------
// 14. task renew --dispatch, with either credential.
// ---------------------------------------------------------------------------

test("task renew --dispatch --renew-token renews with exit 0 and no token anywhere in the output", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "renew by dispatch, renew token");
  const started = f.success(["task", "start", taskId, "--actor", "test"]);

  const result = f.cli(["task", "renew", taskId, "--dispatch", started.dispatchId, "--renew-token", started.renewToken, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const renewed = JSON.parse(result.stdout);
  assert.equal(renewed.ok, true, JSON.stringify(renewed));
  const combined = String(result.stdout) + String(result.stderr);
  assert.ok(!LEASE_TOKEN_PATTERN.test(combined), `renew-token-credentialed output must carry no token at all:\n${combined}`);
});

test("task renew --dispatch --token (the lease token) renews and brings the tokens back, same as before", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "renew by dispatch, lease token");
  const started = f.success(["task", "start", taskId, "--actor", "test"]);

  const renewed = f.success(["task", "renew", taskId, "--dispatch", started.dispatchId, "--token", started.leaseToken, "--actor", "test"]);
  assert.equal(renewed.ok, true, JSON.stringify(renewed));
  assert.equal(renewed.claim.leaseToken, started.leaseToken);
  assert.equal(renewed.claim.renewToken, started.renewToken);
});

// ---------------------------------------------------------------------------
// 15. --dispatch-id is refused by name on renew.
// ---------------------------------------------------------------------------

test("task renew --dispatch-id is refused, citing --dispatch, and renews nothing", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "renew dispatch-id typo task");
  const started = f.success(["task", "start", taskId, "--actor", "test"]);
  const before = readClaimDirectly(f, started.claim.claimId);
  assert.ok(before);

  const { payload, stderr } = f.refused(["task", "renew", taskId, "--dispatch-id", started.dispatchId, "--token", started.leaseToken]);
  assert.equal(payload.reason, "dispatch-id-not-accepted-on-renew");
  assert.match(stderr, /--dispatch\b/);

  const after = readClaimDirectly(f, started.claim.claimId);
  assert.equal(after!.expiresAt, before!.expiresAt, "nothing renewed on this refusal");
});

// ---------------------------------------------------------------------------
// 16. Missing address/credential, or both, names what is wrong.
// ---------------------------------------------------------------------------

test("task renew with a missing or doubled address/credential names the problem", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "renew missing args task");
  const started = f.success(["task", "start", taskId, "--actor", "test"]);

  const noCredential = f.cli(["task", "renew", taskId, "--dispatch", started.dispatchId, "--json"]);
  assert.notEqual(noCredential.status, 0);
  assert.match(String(noCredential.stderr), /exactly one address and exactly one credential/);

  const noAddress = f.cli(["task", "renew", taskId, "--token", started.leaseToken, "--json"]);
  assert.notEqual(noAddress.status, 0);
  assert.match(String(noAddress.stderr), /exactly one address and exactly one credential/);

  const bothAddresses = f.cli(["task", "renew", taskId, "--claim", started.claim.claimId, "--dispatch", started.dispatchId, "--token", started.leaseToken, "--json"]);
  assert.notEqual(bothAddresses.status, 0);
  assert.match(String(bothAddresses.stderr), /exactly one address and exactly one credential/);

  const bothCredentials = f.cli(["task", "renew", taskId, "--dispatch", started.dispatchId, "--token", started.leaseToken, "--renew-token", started.renewToken, "--json"]);
  assert.notEqual(bothCredentials.status, 0);
  assert.match(String(bothCredentials.stderr), /exactly one address and exactly one credential/);
});

// ---------------------------------------------------------------------------
// 17. task release never accepts renewToken: --token <renewToken> fails
// token-mismatch, the claim stays alive.
// ---------------------------------------------------------------------------

test("task release --claim --token <renewToken> fails as token-mismatch; the claim stays alive -- the renewToken has no release path at all", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "release with renewToken task");
  const started = f.success(["task", "start", taskId, "--actor", "test"]);

  const { payload } = f.refused(["task", "release", taskId, "--claim", started.claim.claimId, "--token", started.renewToken]);
  assert.equal(payload.reason, "token-mismatch");

  const stillActive = readClaimDirectly(f, started.claim.claimId);
  assert.ok(stillActive, "the claim row must still exist");
  assert.equal(stillActive!.state, "active", "the claim must still be alive -- the renewToken cannot release it");
});

// ---------------------------------------------------------------------------
// 18. task update --set detail.estimatedEffort warns on stderr with a live
// claim (claimId only, no token), stdout stays a clean --json document; no
// warning without a live claim.
// ---------------------------------------------------------------------------

test("task update --set detail.estimatedEffort warns on stderr naming the claimId (no token) when the task has a live claim; stdout is still a clean --json document; no warning without one", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const claimedTaskId = createClaimableTask(f, "update under live claim task");
  const started = f.success(["task", "start", claimedTaskId, "--actor", "test"]);

  const withClaim = f.cli(["task", "update", claimedTaskId, "--set", "detail.estimatedEffort=6h", "--actor", "test", "--json"]);
  assert.equal(withClaim.status, 0, withClaim.stderr);
  assert.doesNotThrow(() => JSON.parse(withClaim.stdout), `stdout must stay a clean JSON document: ${withClaim.stdout}`);
  assert.ok(String(withClaim.stderr).includes(started.claim.claimId), `stderr must name the live claim: ${withClaim.stderr}`);
  assert.ok(!LEASE_TOKEN_PATTERN.test(String(withClaim.stderr)), `the warning must never carry a token: ${withClaim.stderr}`);

  const unclaimedTaskId = createClaimableTask(f, "update without a claim task");
  const withoutClaim = f.cli(["task", "update", unclaimedTaskId, "--set", "detail.estimatedEffort=6h", "--actor", "test", "--json"]);
  assert.equal(withoutClaim.status, 0, withoutClaim.stderr);
  assert.equal(String(withoutClaim.stderr).trim(), "", `no live claim: no warning expected: ${withoutClaim.stderr}`);
});

// ---------------------------------------------------------------------------
// 19. Token-leak regression (T-134's sibling): a wrong-token renew refusal
// never leaks a token-shaped value, in stdout or stderr.
// ---------------------------------------------------------------------------

test("MUTATION GUARD: a renew refusal with a wrong token never leaks a token-shaped value, in --json or human mode", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "renew leak regression task");
  const started = f.success(["task", "start", taskId, "--actor", "test"]);
  const foreignToken = "f".repeat(started.leaseToken.length);

  for (const args of [
    ["task", "renew", taskId, "--claim", started.claim.claimId, "--token", foreignToken, "--json"],
    ["task", "renew", taskId, "--claim", started.claim.claimId, "--token", foreignToken]
  ]) {
    const result = f.cli(args);
    assert.notEqual(result.status, 0);
    const combined = String(result.stdout) + String(result.stderr);
    assert.ok(!combined.includes(started.leaseToken), `the real leaseToken leaked:\n${combined}`);
    assert.ok(!combined.includes(started.renewToken), `the real renewToken leaked:\n${combined}`);
    assert.ok(!LEASE_TOKEN_PATTERN.test(combined), `a token-shaped value leaked:\n${combined}`);
  }
});
