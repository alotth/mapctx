import assert from "node:assert/strict"
import * as crypto from "crypto"
import { spawnSync } from "node:child_process"
import * as fs from "fs"
import * as path from "path"
import test, { type TestContext } from "node:test"
import { resolveProjectStoreDir, readMapctxToml, StoreHandle } from "@mapctx/store"

// T-128: reuse the store's golden repo + isolated MAPCTX_HOME fixture, same
// pattern as privacy-cli.test.ts / cli-quickwins.test.ts. Its internal helpers
// are deliberately not part of the public package export surface.
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
  // Refusal path: stdout stays empty, the structured payload is one compact
  // JSON line on stderr, followed by the `Error:` line (T-127 contract).
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
  // Without --json, no JSON payload at all -- only the `Error:` line.
  const refusedHuman = (args: string[]) => {
    const result = cli(args);
    assert.notEqual(result.status, 0, "expected a refusal");
    const stderr = String(result.stderr);
    assert.equal(String(result.stdout).trim(), "", "stdout is the result channel; a refusal is not a result");
    assert.ok(!stderr.includes("{"), `expected no JSON payload on stderr without --json: ${stderr}`);
    assert.match(stderr, /^Error: /);
    return { result, stderr };
  };
  const storeDir = () => resolveProjectStoreDir(readMapctxToml(path.join(f.repoDir, "mapctx.toml")).projectId);
  const read = <T>(fn: (handle: StoreHandle) => T): T => {
    const handle = StoreHandle.openReadOnly(storeDir());
    try { return fn(handle); } finally { handle.close(); }
  };
  const checkpointEventCount = () => read(handle => handle.listEvents().filter(e => e.eventType === "checkpoint.exported").length);

  /**
   * Walks a backlog task through the board-spelling transitions to `review`
   * (ready-for-do -> doing -> review), then authors and approves a single
   * acceptance criterion so the done gate passes. Returns nothing; callers
   * read state back through `success`/`cli`.
   */
  const bringToReviewWithApprovedAcceptance = (taskId: string, criterionFile: string) => {
    success(["task", "move", taskId, "--status", "ready-for-do", "--actor", "test"]);
    success(["task", "move", taskId, "--status", "doing", "--actor", "test"]);
    success(["task", "move", taskId, "--status", "review", "--actor", "test"]);
    fs.writeFileSync(path.join(f.repoDir, criterionFile), "## Acceptance\n- [ ] one criterion.\n");
    const revised = success(["task", "acceptance", "revise", taskId, "--from-file", criterionFile, "--expect-revision", "0", "--actor", "test"]);
    success(["task", "acceptance", "approve", taskId, "--index", "0", "--expect-revision", String(revised.revision), "--actor", "test"]);
  };

  return { ...f, cli, success, refused, refusedHuman, storeDir, read, checkpointEventCount, bringToReviewWithApprovedAcceptance };
}

function hashTree(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else hashes[path.relative(root, absolute)] = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    }
  };
  visit(root);
  return hashes;
}

// ---------------------------------------------------------------------------
// Criterion 1 (central): --no-snapshot never touches the mirror. Same gate,
// no TASKS.md/tasks/*.md write, no checkpoint event.
// ---------------------------------------------------------------------------

test("task finish --no-snapshot applies the done gate but writes nothing: TASKS.md and every tasks/*.md are byte-identical, unrelated WIP is untouched, zero checkpoint events", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.bringToReviewWithApprovedAcceptance("T-101", "acceptance.md");

  // Unrelated WIP in the same directory tree that `task finish` would
  // otherwise regenerate alongside -- this is the whole point of the flag.
  const wipPath = path.join(f.repoDir, "tasks", "wip-marker.txt");
  const wipContent = "someone else's in-progress notes\n";
  fs.writeFileSync(wipPath, wipContent);

  const before = hashTree(f.repoDir);
  const checkpointsBefore = f.checkpointEventCount();

  const result = f.success(["task", "finish", "T-101", "--no-snapshot", "--actor", "test"]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.snapshot, "skipped");
  assert.ok(!("checkpoint" in result), `checkpoint key must be absent, not merely undefined: ${JSON.stringify(result)}`);
  assert.equal(result.move.performed, true);
  assert.equal(result.move.to, "done");

  const after = hashTree(f.repoDir);
  assert.deepEqual(after, before, "no file in the working tree may change under --no-snapshot");
  assert.equal(fs.readFileSync(wipPath, "utf8"), wipContent, "unrelated WIP must survive untouched");

  const shown = f.success(["task", "show", "T-101"]);
  assert.equal(shown.task.planningState, "done");
  assert.ok(shown.task.completedOn, "completedOn must be stamped even without a snapshot");

  assert.equal(f.checkpointEventCount(), checkpointsBefore, "zero checkpoint.exported events must be journaled");
});

// ---------------------------------------------------------------------------
// Criterion 1b: the default is unchanged -- plain `task finish` still
// publishes, for both a plain task (task-end) and an epic (epic-end).
// ---------------------------------------------------------------------------

test("MUTATION GUARD: task finish WITHOUT --no-snapshot still publishes by default -- snapshot:\"published\", checkpoint.reason task-end/epic-end, TASKS.md changes, one checkpoint event", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  const tasksMdPath = path.join(f.repoDir, "TASKS.md");
  const beforeTask = fs.readFileSync(tasksMdPath, "utf8");
  const checkpointsBefore = f.checkpointEventCount();

  f.bringToReviewWithApprovedAcceptance("T-101", "acceptance-task.md");
  const taskResult = f.success(["task", "finish", "T-101", "--actor", "test"]);
  assert.equal(taskResult.ok, true, JSON.stringify(taskResult));
  assert.equal(taskResult.snapshot, "published");
  assert.ok(taskResult.snapshot === "published" && taskResult.checkpoint, "checkpoint must be present when published");
  assert.equal(taskResult.checkpoint.reason, "task-end");
  assert.notEqual(fs.readFileSync(tasksMdPath, "utf8"), beforeTask, "TASKS.md must change on a published finish");
  assert.equal(f.checkpointEventCount(), checkpointsBefore + 1);

  // E-100 is already in-progress in the golden fixture: move straight to
  // review (doing -> review is legal) and approve its acceptance too.
  const afterTaskTasksMd = fs.readFileSync(tasksMdPath, "utf8");
  f.success(["task", "move", "E-100", "--status", "review", "--actor", "test"]);
  fs.writeFileSync(path.join(f.repoDir, "acceptance-epic.md"), "## Acceptance\n- [ ] epic criterion.\n");
  const revisedEpic = f.success(["task", "acceptance", "revise", "E-100", "--from-file", "acceptance-epic.md", "--expect-revision", "0", "--actor", "test"]);
  f.success(["task", "acceptance", "approve", "E-100", "--index", "0", "--expect-revision", String(revisedEpic.revision), "--actor", "test"]);

  const epicResult = f.success(["task", "finish", "E-100", "--actor", "test"]);
  assert.equal(epicResult.ok, true, JSON.stringify(epicResult));
  assert.equal(epicResult.snapshot, "published");
  assert.ok(epicResult.snapshot === "published" && epicResult.checkpoint);
  assert.equal(epicResult.checkpoint.reason, "epic-end");
  assert.notEqual(fs.readFileSync(tasksMdPath, "utf8"), afterTaskTasksMd, "TASKS.md must change again on the epic's published finish");
  assert.equal(f.checkpointEventCount(), checkpointsBefore + 2);
});

// ---------------------------------------------------------------------------
// Criterion 2: one gate, proven (not assumed). move --status done and finish
// (with or without --no-snapshot) refuse with the byte-identical acceptance
// message and the same closing advice.
// ---------------------------------------------------------------------------

test("MUTATION GUARD: task move --status done and task finish (both with and without --no-snapshot) refuse with the byte-identical acceptance-incomplete message and closing advice", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  // T-101 reaches review WITHOUT ever authoring acceptance -- the gate must
  // still be unsatisfied.
  f.success(["task", "move", "T-101", "--status", "ready-for-do", "--actor", "test"]);
  f.success(["task", "move", "T-101", "--status", "doing", "--actor", "test"]);
  f.success(["task", "move", "T-101", "--status", "review", "--actor", "test"]);

  const moveRefused = f.refused(["task", "move", "T-101", "--status", "done", "--actor", "test"]);
  const finishRefused = f.refused(["task", "finish", "T-101", "--actor", "test"]);
  const finishNoSnapshotRefused = f.refused(["task", "finish", "T-101", "--no-snapshot", "--actor", "test"]);

  for (const { stderr } of [moveRefused, finishRefused, finishNoSnapshotRefused]) {
    assert.match(stderr, /acceptance-incomplete/);
    assert.match(stderr, /close it with `mapctx task finish T-101`/);
    assert.match(stderr, /--no-snapshot/);
  }

  // The proof: the SAME sentence (reason + store message + closing advice),
  // sliced out of each differently-prefixed human-readable Error: line, must
  // be byte-identical across all three refusals -- not merely "contains the
  // same words".
  // Compare only the human `Error:` line -- the JSON line legitimately
  // differs in shape between the two commands (`move`'s payload is the flat
  // result; `finish`'s nests it under `stage`/`move`), but the sentence the
  // reader actually reads must be identical: reason, store message, and
  // closing advice, word for word, starting right after each command's own
  // "<Verb> failed/refused:" prefix.
  const sentenceFrom = (stderr: string) => {
    const errorLine = stderr.split("\n").find(line => line.startsWith("Error:"));
    assert.ok(errorLine, `no Error: line found in: ${stderr}`);
    const cut = errorLine!.indexOf("acceptance-incomplete");
    assert.ok(cut > 0, `no "acceptance-incomplete" found in: ${errorLine}`);
    return errorLine!.slice(cut);
  };
  const moveSentence = sentenceFrom(moveRefused.stderr);
  const finishSentence = sentenceFrom(finishRefused.stderr);
  const finishNoSnapshotSentence = sentenceFrom(finishNoSnapshotRefused.stderr);
  assert.equal(finishSentence, moveSentence, "finish and move must refuse with the identical sentence -- proof of one shared gate");
  assert.equal(finishNoSnapshotSentence, moveSentence, "--no-snapshot must not loosen the gate: identical refusal too");
});

// ---------------------------------------------------------------------------
// Criterion 2b: an already-done task re-verifies the gate under
// --no-snapshot instead of trusting its prior state.
// ---------------------------------------------------------------------------

test("MUTATION GUARD: finish --no-snapshot on an already-done task re-verifies the gate (move.performed:false, ok after approving, refuses after unapproving)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  // T-102 is already `done` in the golden fixture but carries no acceptance
  // revision; author and approve one first (acceptance commands do not care
  // about planning state).
  fs.writeFileSync(path.join(f.repoDir, "acceptance-done.md"), "## Acceptance\n- [ ] already-done criterion.\n");
  const revised = f.success(["task", "acceptance", "revise", "T-102", "--from-file", "acceptance-done.md", "--expect-revision", "0", "--actor", "test"]);
  const approved = f.success(["task", "acceptance", "approve", "T-102", "--index", "0", "--expect-revision", String(revised.revision), "--actor", "test"]);

  const first = f.success(["task", "finish", "T-102", "--no-snapshot", "--actor", "test"]);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.move.performed, false, "a task already done must not be re-moved");
  assert.equal(first.snapshot, "skipped");

  f.success(["task", "acceptance", "unapprove", "T-102", "--index", "0", "--expect-revision", String(approved.revision), "--actor", "test"]);

  const { payload } = f.refused(["task", "finish", "T-102", "--no-snapshot", "--actor", "test"]);
  assert.equal(payload.stage, "move");
  assert.equal(payload.move.reason, "acceptance-incomplete");
});

// ---------------------------------------------------------------------------
// Channel contract (inherited from T-127, must not regress): finish
// --no-snapshot's refusal keeps stdout empty, one compact JSON line + Error:
// under --json, and only the Error: line without it.
// ---------------------------------------------------------------------------

test("task finish --no-snapshot's refusal follows the T-127 channel contract in both --json and human mode", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.success(["task", "move", "T-101", "--status", "ready-for-do", "--actor", "test"]);
  f.success(["task", "move", "T-101", "--status", "doing", "--actor", "test"]);
  f.success(["task", "move", "T-101", "--status", "review", "--actor", "test"]);

  const { payload, stderr } = f.refused(["task", "finish", "T-101", "--no-snapshot", "--actor", "test"]);
  assert.equal(payload.ok, false);
  const lines = stderr.split("\n").filter(Boolean);
  assert.equal(lines.length, 2, `expected exactly 2 non-empty stderr lines: ${JSON.stringify(lines)}`);
  assert.doesNotThrow(() => JSON.parse(lines[0]));

  const human = f.refusedHuman(["task", "finish", "T-101", "--no-snapshot", "--actor", "test"]);
  assert.match(human.stderr, /acceptance-incomplete/, "the human-mode Error: line must still carry the specific blocking criterion");
});

// ---------------------------------------------------------------------------
// Checkpoint-failure message: the planning move already landed, and the
// message must say so and point at the escape hatch (--no-snapshot /
// `mapctx export`). Forced by making `tasks/` read-only so
// publishCheckpoint's temp-file write (`tasks/<id>.md.mapctx-tmp`) fails
// mid-publish with EACCES, after the done move already committed.
// ---------------------------------------------------------------------------

test("a checkpoint failure during the default (publishing) finish says the planning move already applied and points at --no-snapshot / mapctx export", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.bringToReviewWithApprovedAcceptance("T-101", "acceptance.md");

  const tasksDir = path.join(f.repoDir, "tasks");
  fs.chmodSync(tasksDir, 0o500);
  t.after(() => { try { fs.chmodSync(tasksDir, 0o700); } catch { /* best effort */ } });

  const { payload, stderr } = f.refused(["task", "finish", "T-101", "--actor", "test"]);
  assert.equal(payload.ok, false);
  assert.equal(payload.stage, "checkpoint");
  assert.equal(payload.move.performed, true, "the planning move must have landed before the checkpoint write failed");
  assert.match(stderr, /The planning state is already closed/);
  assert.match(stderr, /--no-snapshot/);
  assert.match(stderr, /mapctx export/);

  fs.chmodSync(tasksDir, 0o700);
  const shown = f.success(["task", "show", "T-101"]);
  assert.equal(shown.task.planningState, "done", "the move is not rolled back by a downstream checkpoint failure");
});
