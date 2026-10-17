import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as path from "path"
import test, { type TestContext } from "node:test"
import { getClaim, readMapctxToml, StoreHandle } from "@mapctx/store"

/**
 * T-145 (C6 / D6, D8): `--kind implement|review` on `task start` /
 * `dispatch create`, and the two inherited-from-T-144-review behaviours
 * (B4 1/2) plus N1's ambiguity warning. Same golden-repo + isolated
 * MAPCTX_HOME fixture as lease-cli.test.ts / renew-cli.test.ts. Nothing here
 * touches the real `~/.mapctx`. Uses `spawnSync`, not `execFileSync` --
 * the latter only surfaces stderr on a non-zero exit, and several of these
 * assertions are about stderr on exit 0 (the N1 warning).
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
    return result;
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
// C. task start --kind
// ---------------------------------------------------------------------------

test("task start --kind review: exit 0, claimRole review, claimExclusivity shared, kind review, no stderr (one live review claim)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "kind review task");

  const result = f.cli(["task", "start", taskId, "--kind", "review", "--actor", "reviewer", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.kind, "review");
  assert.equal(parsed.claimRole, "review");
  assert.equal(parsed.claimExclusivity, "shared");
  assert.equal(String(result.stderr).trim(), "", `one live review claim: no ambiguity warning expected: ${result.stderr}`);
  assert.ok(!("reviewLaneAmbiguity" in parsed), "no reviewLaneAmbiguity key with only one live review claim");
});

test("a SECOND task start --kind review on the same task: still exit 0, stderr names the count (2), --json carries reviewLaneAmbiguity.liveReviewClaims === 2", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "kind review ambiguity task");

  const first = f.cli(["task", "start", taskId, "--kind", "review", "--actor", "reviewer-1", "--json"]);
  assert.equal(first.status, 0, first.stderr);

  // A second, independently-minted review claim on the SAME task (no
  // --dispatch-id -- two reviewers, or one reviewer retrying their own lane,
  // both mint a fresh claim) is what creates the ambiguity N1 warns about.
  const second = f.cli(["task", "start", taskId, "--kind", "review", "--actor", "reviewer-2", "--json"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(String(second.stderr), /\b2\b/, `stderr must name the count 2: ${second.stderr}`);
  const parsed = JSON.parse(second.stdout);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.ok(parsed.reviewLaneAmbiguity, JSON.stringify(parsed));
  assert.equal(parsed.reviewLaneAmbiguity.liveReviewClaims, 2);
});

test("task start --kind reveiw (typo): refused by name, naming the flag and the offending value", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "kind typo task");

  const { stderr, status } = f.refused(["task", "start", taskId, "--kind", "reveiw", "--actor", "test"]);
  assert.notEqual(status, 0);
  assert.match(String(stderr), /--kind/);
  assert.match(String(stderr), /reveiw/);
});

test("an implement task start is never refused by live review claims on the same task", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "implement not refused by review task");

  f.success(["task", "start", taskId, "--kind", "review", "--actor", "reviewer"]);
  const implementStart = f.cli(["task", "start", taskId, "--kind", "implement", "--actor", "worker", "--json"]);
  assert.equal(implementStart.status, 0, implementStart.stderr);
  const parsed = JSON.parse(implementStart.stdout);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.claimRole, "implement");
});

test("B4-1: a second implement task start IS refused, and the Error line names the exclusive implement claim", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "second implement refused task");

  f.success(["task", "start", taskId, "--actor", "worker-1"]);
  const { stderr, status } = f.refused(["task", "start", taskId, "--actor", "worker-2"]);
  assert.notEqual(status, 0);
  assert.match(String(stderr), /exclusive implement claim/, `the human line must name the lane: ${stderr}`);
});

// ---------------------------------------------------------------------------
// C. dispatch create --kind
// ---------------------------------------------------------------------------

test("dispatch create --kind review without a live review claim is refused, naming the review lane", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "dispatch create review no claim task");

  const { stderr, status } = f.refused(["dispatch", "create", taskId, "--kind", "review", "--actor", "reviewer"]);
  assert.notEqual(status, 0);
  assert.match(String(stderr), /review/i, `must name the review lane: ${stderr}`);
});

test("dispatch create --dispatch-id of an implement chain with --kind review is refused, naming BOTH lanes", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "dispatch create mixed lane task");

  const started = f.success(["task", "start", taskId, "--actor", "worker"]);
  const { stderr, status } = f.refused(["dispatch", "create", taskId, "--dispatch-id", started.dispatchId, "--kind", "review", "--actor", "worker"]);
  assert.notEqual(status, 0);
  assert.match(String(stderr), /implement/i, `must name the implement lane: ${stderr}`);
  assert.match(String(stderr), /review/i, `must name the review lane: ${stderr}`);
});

test("dispatch create --kind review WITH a live review claim succeeds, kind review in the --json result", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "dispatch create review with claim task");

  // `task claim` does not take `--kind` (only `task start` and
  // `dispatch create` do) -- `task start` mints the review claim here, and
  // its OWN dispatch is irrelevant to this test, only the claim it leaves behind.
  f.success(["task", "start", taskId, "--kind", "review", "--actor", "reviewer"]);
  const result = f.success(["dispatch", "create", taskId, "--kind", "review", "--actor", "reviewer"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.kind, "review");
});

// ---------------------------------------------------------------------------
// B4-2: task update --set detail.estimatedEffort warns under a live claim of
// ANY lane, not just the exclusive one.
// ---------------------------------------------------------------------------

test("B4-2: task update --set detail.estimatedEffort warns on stderr naming the review claim when ONLY a review claim is live (no implement claim at all)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "update under review-only claim task");

  const started = f.success(["task", "start", taskId, "--kind", "review", "--actor", "reviewer"]);
  const result = f.cli(["task", "update", taskId, "--set", "detail.estimatedEffort=6h", "--actor", "test", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotThrow(() => JSON.parse(result.stdout), `stdout must stay a clean JSON document: ${result.stdout}`);
  assert.ok(String(result.stderr).includes(started.claim.claimId), `stderr must name the live review claim: ${result.stderr}`);
  assert.match(String(result.stderr), /review/, `stderr must name the review lane: ${result.stderr}`);

  // Sanity: the claim read directly from the store really is the review one.
  const claim = readClaimDirectly(f, started.claim.claimId);
  assert.equal(claim?.role, "review");
});

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

test("--help mentions --kind and reviewLeaseFactor", t => {
  const f = fixture(t);
  const result = f.cli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--kind/);
  assert.match(result.stdout, /reviewLeaseFactor/);
});
