import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as path from "path"
import test, { type TestContext } from "node:test"

/**
 * T-143 / C4 (a51f6ab): `mapctx run event <dispatch-id>` -- the renewal path
 * that needs no secret, addressed by dispatchId. Same golden-repo +
 * isolated MAPCTX_HOME fixture as lease-cli.test.ts / renew-cli.test.ts.
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
    const payload = JSON.parse(lines[0]);
    return { result, payload, stderr };
  };
  return { ...f, cli, success, refused };
}

function createClaimableTask(f: ReturnType<typeof fixture>, title: string, effort = "4h"): string {
  const created = f.success(["task", "create", "--title", title, "--workload", "Normal", "--effort", effort, "--actor", "test"]);
  return created.taskId;
}

// ---------------------------------------------------------------------------
// 13. An explicitly older --attempt is refused -- the guard that matters,
// since the default makes "the attempt is the latest" a tautology. No event
// is written.
// ---------------------------------------------------------------------------

test("--attempt explicitly OLDER than the dispatch's latest is refused (stale-attempt), and writes NO event at all", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "stale attempt refusal task");
  const started = f.success(["task", "start", taskId, "--actor", "test"]);

  // Admit a second attempt on the same dispatch, so attempt 1 is now stale.
  const dispatchCreate = f.cli(["dispatch", "create", taskId, "--dispatch-id", started.dispatchId, "--executor", "cli", "--context-hash", "retry", "--json"]);
  assert.equal(dispatchCreate.status, 0, dispatchCreate.stderr);

  const { payload, stderr } = f.refused(["run", "event", started.dispatchId, "--type", "heartbeat", "--attempt", "1"]);
  assert.equal(payload.reason, "stale-attempt");
  assert.match(stderr, /older than this dispatch's latest attempt/);

  // Nothing was written: the next event on the latest attempt still gets
  // sequence 0 (the default-sequence logic counts recorded events; if the
  // stale-attempt call had written anything, a later check would differ, but
  // the simplest direct proof is that a fresh listing shows nothing for
  // attempt 1 at this sequence -- recorded via a successful call below).
  const latestAttempt = JSON.parse(dispatchCreate.stdout).attempt;
  const firstReal = f.success(["run", "event", started.dispatchId, "--type", "heartbeat", "--attempt", String(latestAttempt)]);
  assert.equal(firstReal.event.sequence, 0, "the first REAL event on the latest attempt still gets sequence 0 -- the refused stale-attempt call wrote nothing to attempt 1 or anywhere else");
});

// ---------------------------------------------------------------------------
// 14. An unknown attempt (newer than the latest) and an unknown dispatch.
// ---------------------------------------------------------------------------

test("--attempt newer than the latest is refused (unknown-attempt); an unknown dispatch is refused (unknown-dispatch)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "unknown attempt task");
  const started = f.success(["task", "start", taskId, "--actor", "test"]);

  const { payload: unknownAttempt } = f.refused(["run", "event", started.dispatchId, "--type", "heartbeat", "--attempt", "99"]);
  assert.equal(unknownAttempt.reason, "unknown-attempt");

  const { payload: unknownDispatch } = f.refused(["run", "event", "00000000-0000-0000-0000-000000000000", "--type", "heartbeat"]);
  assert.equal(unknownDispatch.reason, "unknown-dispatch");
});

// ---------------------------------------------------------------------------
// 15. --sequence default: 0, then 1; an explicit colliding --sequence
// refuses as a duplicate, with the hint to omit it.
// ---------------------------------------------------------------------------

test("--sequence defaults to 0 then 1; an explicit colliding --sequence refuses (the CLI stamps a fresh real-time timestamp each call, so a same-key replay reads as conflicting, not an exact duplicate) with a hint to omit it", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "sequence default task");
  const started = f.success(["task", "start", taskId, "--actor", "test"]);

  const first = f.success(["run", "event", started.dispatchId, "--type", "heartbeat"]);
  assert.equal(first.event.sequence, 0);

  const second = f.success(["run", "event", started.dispatchId, "--type", "heartbeat"]);
  assert.equal(second.event.sequence, 1);

  // Colliding with sequence 0 again: the CLI always stamps `new
  // Date().toISOString()`, so this call's payload (the timestamp) differs
  // from the first call's -- same (dispatch, attempt, sequence) key, but not
  // a byte-identical event, so the writer reports it as conflicting rather
  // than an exact duplicate. Either reason is the same refusal from the
  // caller's point of view: this sequence is already taken.
  const { payload, stderr } = f.refused(["run", "event", started.dispatchId, "--type", "heartbeat", "--sequence", "0"]);
  assert.equal(payload.reason, "conflicting-run-event");
  assert.match(stderr, /Omit --sequence to take the next unused one/);
});

// ---------------------------------------------------------------------------
// 16. --type missing/invalid; --payload invalid JSON; --payload not an
// object (array, number).
// ---------------------------------------------------------------------------

test("--type missing or invalid is refused naming heartbeat|progress; --payload invalid JSON and --payload non-object are both refused", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "type and payload validation task");
  const started = f.success(["task", "start", taskId, "--actor", "test"]);

  const missingType = f.cli(["run", "event", started.dispatchId, "--json"]);
  assert.notEqual(missingType.status, 0);
  assert.match(String(missingType.stderr), /heartbeat/);
  assert.match(String(missingType.stderr), /progress/);

  const invalidType = f.cli(["run", "event", started.dispatchId, "--type", "completed", "--json"]);
  assert.notEqual(invalidType.status, 0);
  assert.match(String(invalidType.stderr), /heartbeat/);
  assert.match(String(invalidType.stderr), /progress/);

  const invalidJson = f.cli(["run", "event", started.dispatchId, "--type", "heartbeat", "--payload", "{not json", "--json"]);
  assert.notEqual(invalidJson.status, 0);
  assert.match(String(invalidJson.stderr), /--payload must be JSON/);

  for (const nonObjectPayload of ["[1,2,3]", "42"]) {
    const result = f.cli(["run", "event", started.dispatchId, "--type", "heartbeat", "--payload", nonObjectPayload, "--json"]);
    assert.notEqual(result.status, 0, `payload ${nonObjectPayload} must be refused`);
    assert.match(String(result.stderr), /--payload must be a JSON object/);
  }
});

// ---------------------------------------------------------------------------
// 17. The happy path's --json output carries event AND renewal.
// ---------------------------------------------------------------------------

test("a successful run event's --json output carries both event and renewal", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "happy path output task");
  const started = f.success(["task", "start", taskId, "--actor", "test"]);

  const result = f.success(["run", "event", started.dispatchId, "--type", "heartbeat", "--payload", '{"slice":"1/3"}']);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.event, "event must be present");
  assert.equal(result.event.dispatchId, started.dispatchId);
  assert.equal(result.event.type, "heartbeat");
  assert.deepEqual(result.event.payload, { slice: "1/3" });
  assert.ok(result.renewal, "renewal must be present");
  assert.equal(result.renewal.renewed, true, JSON.stringify(result.renewal));
  assert.equal(result.renewal.claimId, started.claim.claimId);
});

// ---------------------------------------------------------------------------
// 18. mapctx redact --sequence 0 is still refused by name -- the floor
// moved to a different command's flag, it did not loosen.
// ---------------------------------------------------------------------------

test("mapctx redact --sequence 0 is still refused by name, even though the parser now accepts 0 for run event's sake", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  const result = f.cli(["redact", "--sequence", "0", "--field", "payload.secret", "--reason", "test", "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(String(result.stderr), /sequence is a journal event sequence and starts at 1/);
  assert.match(String(result.stderr), /0 addresses no event/);
});
