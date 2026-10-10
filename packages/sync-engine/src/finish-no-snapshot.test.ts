import assert from "node:assert/strict"
import * as crypto from "crypto"
import { spawnSync } from "node:child_process"
import * as fs from "fs"
import * as path from "path"
import test, { type TestContext } from "node:test"
import {
  resolveProjectStoreDir, readMapctxToml, StoreHandle,
  upsertProject, createTask, moveTask, reviseAcceptance, approveAcceptanceCriterion, buildExport
} from "@mapctx/store"
import { taskFinishCommand, CliRefusal } from "./mapctx-cli"

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

// ---------------------------------------------------------------------------
// Review F1 (the blocking regression): an unrecognized `--flag` must be an
// error, not silently dropped -- four plausible misspellings of
// `--no-snapshot` used to publish instead of skipping, exit 0, no warning.
// Each row gets its own fixture, with WIP in tasks/ and approved acceptance,
// asserting both exit/snapshot AND the actual mirror byte count.
// ---------------------------------------------------------------------------

function countChangedMirrorFiles(before: Record<string, string>, after: Record<string, string>): number {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let changed = 0;
  for (const key of keys) if (before[key] !== after[key]) changed += 1;
  return changed;
}

test("MUTATION GUARD (F1): --no-snapshot and --snapshot=none / --snapshot none all skip (0 files changed); unknown spellings are refused (0 files changed); no flag publishes (files change)", t => {
  const cases: Array<{ args: string[]; expectExitZero: boolean; expectSnapshot?: "skipped" | "published"; messageRe?: RegExp }> = [
    { args: ["--no-snapshot"], expectExitZero: true, expectSnapshot: "skipped" },
    { args: ["--snapshot=none"], expectExitZero: true, expectSnapshot: "skipped" },
    { args: ["--snapshot", "none"], expectExitZero: true, expectSnapshot: "skipped" },
    { args: ["--no-snapshots"], expectExitZero: false, messageRe: /Unknown flag: --no-snapshots/ },
    { args: ["--no-snapshot=true"], expectExitZero: false, messageRe: /--no-snapshot takes no value/ },
    { args: ["--snapshot=task"], expectExitZero: false, messageRe: /filesHash/ },
    { args: ["--snapshot=task"], expectExitZero: false, messageRe: /mapctx export/ },
    { args: ["--snapshot=weird"], expectExitZero: false, messageRe: /--snapshot must be none or full/ },
    { args: ["--bogus-flag"], expectExitZero: false, messageRe: /Unknown flag: --bogus-flag/ },
    { args: [], expectExitZero: true, expectSnapshot: "published" }
  ];

  for (const { args, expectExitZero, expectSnapshot, messageRe } of cases) {
    const t2 = t; // one sub-fixture per row, as asked
    const f = fixture(t2);
    f.success(["import", "--commit", "--actor", "test"]);
    f.bringToReviewWithApprovedAcceptance("T-101", "acceptance.md");
    const wipPath = path.join(f.repoDir, "tasks", "wip-marker.txt");
    fs.writeFileSync(wipPath, "wip\n");
    const before = hashTree(f.repoDir);

    const result = f.cli(["task", "finish", "T-101", ...args, "--actor", "test", "--json"]);
    if (expectExitZero) {
      assert.equal(result.status, 0, `${JSON.stringify(args)}: expected exit 0, got stderr=${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.snapshot, expectSnapshot, `${JSON.stringify(args)}`);
    } else {
      assert.notEqual(result.status, 0, `${JSON.stringify(args)}: expected a refusal`);
      if (messageRe) assert.match(String(result.stderr), messageRe, `${JSON.stringify(args)}: ${result.stderr}`);
    }

    const after = hashTree(f.repoDir);
    const changed = countChangedMirrorFiles(before, after);
    if (expectSnapshot === "published") {
      assert.ok(changed > 0, `${JSON.stringify(args)}: expected mirrors to change (unchanged default)`);
    } else {
      assert.equal(changed, 0, `${JSON.stringify(args)}: expected 0 changed files, got ${changed}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Review F1b: must not regress T-127 (`validate --json=true` stays human
// mode -- already covered in cli-quickwins.test.ts) nor the CI pack:smoke
// step (`mapctx workspace --no-open --port <n>` and friends must still
// parse). The drift guard against workspace-server.ts's own literals already
// lives in mapctx-cli.test.ts; this is the behavioral half.
// ---------------------------------------------------------------------------

test("workspace-only flags (--port, --no-open, --org, ...) pass through parseArgs unrejected on an unrelated command; an actual typo is still refused", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  const passthrough = f.cli(["task", "show", "T-101", "--port", "123", "--no-open", "--org", "x", "--json"]);
  assert.equal(passthrough.status, 0, `workspace flags must not be rejected by the unknown-flag rule: ${passthrough.stderr}`);
  const shown = JSON.parse(passthrough.stdout);
  assert.equal(shown.taskId, "T-101");

  const typo = f.cli(["task", "show", "T-101", "--porttypo", "--json"]);
  assert.notEqual(typo.status, 0, "an actual typo must still be refused");
  assert.match(String(typo.stderr), /Unknown flag: --porttypo/);
});

// ---------------------------------------------------------------------------
// Review F2: a checkpoint failure at the `precondition` stage means the
// planning state is NOT closed (it changed under the lock) -- the message
// must say so, and must NOT claim "already closed" (which would invite
// re-closing a task someone deliberately reopened). The `publish`-stage
// failure (EACCES) keeps the "already closed" wording, which is true there.
// ---------------------------------------------------------------------------

/**
 * Library-level fixture for the precondition race: writes a store-authority
 * mapctx.toml + isolated MAPCTX_HOME, like checkpoint.test.ts's openFixture,
 * but also chdir's into the repo so `taskFinishCommand` (which reads
 * `process.cwd()` internally) finds it exactly as the CLI binary would.
 */
function libraryFixture(t: TestContext) {
  const repoDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "mapctx-finish-lib-repo-"));
  const mapctxHome = fs.mkdtempSync(path.join(require("os").tmpdir(), "mapctx-finish-lib-home-"));
  const previousHome = process.env.MAPCTX_HOME;
  const previousCwd = process.cwd();
  process.env.MAPCTX_HOME = mapctxHome;
  const projectId = "00000000-0000-0000-0000-0000000000f2";
  const storeDir = path.join(mapctxHome, "projects", projectId);
  fs.writeFileSync(path.join(repoDir, "mapctx.toml"), [
    "schemaVersion = 1",
    `projectId = "${projectId}"`,
    'plansAuthority = "store"',
    ""
  ].join("\n"), "utf8");
  const handle = StoreHandle.open(storeDir);
  upsertProject(handle.db, {
    projectId, boardTitle: "F2 fixture",
    workDomains: [{ key: "CORE", description: "core" }],
    notesMarkdown: "", plansAuthority: "store", sourceSnapshotHash: null
  });
  const created = createTask(handle, { id: "T-001", title: "F2 task", actor: "test", status: "review", workload: "Normal" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const taskId = "T-001";
  const revised = reviseAcceptance(handle, { taskId, condition: "criteria", texts: ["one criterion"], actor: "author", expectRevision: 0 });
  assert.equal(revised.ok, true);
  if (revised.ok) assert.equal(approveAcceptanceCriterion(handle, { taskId, index: 0, expectRevision: revised.revision, actor: "reviewer" }).ok, true);
  // Materialize tasks/ so a later (unrelated) publish attempt in the same
  // process does not fail on a missing directory for a different reason.
  const exported = buildExport(handle.db, { tasksRoot: repoDir });
  fs.mkdirSync(path.join(repoDir, "tasks"), { recursive: true });
  fs.writeFileSync(exported.tasksMd.path, exported.tasksMd.content, "utf8");
  for (const file of exported.taskDetailFiles) fs.writeFileSync(file.path, file.content, "utf8");
  // Move to done FIRST, regularly (unpatched), so the only
  // runInWriteTransaction call left for `taskFinishCommand` to make is the
  // publish step -- finishTask skips its internal move when already done.
  assert.equal(moveTask(handle, { taskId, to: "done", actor: "test" }).ok, true);
  process.chdir(repoDir);
  t.after(() => {
    process.chdir(previousCwd);
    handle.close();
    if (previousHome === undefined) delete process.env.MAPCTX_HOME; else process.env.MAPCTX_HOME = previousHome;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(mapctxHome, { recursive: true, force: true });
  });
  return { repoDir, handle, taskId };
}

test("MUTATION GUARD (F2): a precondition-stage checkpoint failure says the task is NOT closed (never 'already closed'); the publish-stage failure still says 'already closed'", t => {
  const lib = libraryFixture(t);

  // Simulate a concurrent reopen landing in the gap between the gated move
  // and the publication transaction, same technique as checkpoint.test.ts's
  // "finish refuses a task-end checkpoint when the task is reopened in the
  // gap" -- but patched on the PROTOTYPE, so it intercepts the handle
  // `taskFinishCommand` opens internally (it opens its own, via cwd + toml).
  const originalTx = StoreHandle.prototype.runInWriteTransaction;
  let injected = false;
  (StoreHandle.prototype as unknown as { runInWriteTransaction: unknown }).runInWriteTransaction = function (this: StoreHandle, fn: unknown) {
    if (!injected && this.nodeId === lib.handle.nodeId) {
      injected = true;
      this.appendEvent({ eventType: "task.patched", actor: "gap-writer", payload: { taskId: lib.taskId, patch: { planningState: "review" } } });
    }
    return (originalTx as (fn: unknown) => unknown).call(this, fn);
  };
  t.after(() => { StoreHandle.prototype.runInWriteTransaction = originalTx; });

  let thrown: unknown;
  try {
    taskFinishCommand(lib.taskId, { actor: "finisher", json: true } as never);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof CliRefusal, `expected a CliRefusal, got: ${thrown}`);
  const message = (thrown as CliRefusal).message;
  assert.match(message, /The task is NOT closed/);
  assert.ok(!/already closed/.test(message), `precondition-stage failure must never claim "already closed": ${message}`);
});

test("a publish-stage (EACCES) checkpoint failure keeps the 'already closed' wording and --no-snapshot pointer", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.bringToReviewWithApprovedAcceptance("T-101", "acceptance.md");
  const tasksDir = path.join(f.repoDir, "tasks");
  fs.chmodSync(tasksDir, 0o500);
  t.after(() => { try { fs.chmodSync(tasksDir, 0o700); } catch { /* best effort */ } });
  const { stderr } = f.refused(["task", "finish", "T-101", "--actor", "test"]);
  assert.match(stderr, /already closed/);
  assert.match(stderr, /--no-snapshot/);
  fs.chmodSync(tasksDir, 0o700);
});

// ---------------------------------------------------------------------------
// Review F3: documentation + the actual durability trade-off, proven by
// recovery. Closing via --no-snapshot alone does not survive a total store
// loss; a later export (or default finish) does.
// ---------------------------------------------------------------------------

function commitAll(repoDir: string, message: string): void {
  const { execFileSync } = require("child_process") as typeof import("child_process");
  execFileSync("git", ["add", "-A"], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repoDir });
}

test("--no-snapshot WITHOUT a later export loses the closure: after a total store loss, store init recovers the task as it was at the last checkpoint, NOT done", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.bringToReviewWithApprovedAcceptance("T-101", "acceptance.md");
  const finished = f.success(["task", "finish", "T-101", "--no-snapshot", "--actor", "test"]);
  assert.equal(finished.snapshot, "skipped");
  assert.equal(f.success(["task", "show", "T-101"]).task.planningState, "done", "sanity: the store itself does show done before the loss");

  commitAll(f.repoDir, "pre-loss state (TASKS.md still says the pre-close status)");
  fs.rmSync(f.storeDir(), { recursive: true, force: true });

  const recovered = f.success(["store", "init", "--actor", "test"]);
  assert.equal(recovered.recovered, true);
  assert.notEqual(f.success(["task", "show", "T-101"]).task.planningState, "done", "the --no-snapshot closure was never durable, so recovery must NOT show done");
});

test("--no-snapshot FOLLOWED BY a later mapctx export makes the closure durable: after a total store loss, store init recovers the task as done", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.bringToReviewWithApprovedAcceptance("T-101", "acceptance.md");
  f.success(["task", "finish", "T-101", "--no-snapshot", "--actor", "test"]);
  f.success(["export", "--actor", "test"]);

  commitAll(f.repoDir, "export after no-snapshot close");
  fs.rmSync(f.storeDir(), { recursive: true, force: true });

  const recovered = f.success(["store", "init", "--actor", "test"]);
  assert.equal(recovered.recovered, true);
  assert.equal(f.success(["task", "show", "T-101"]).task.planningState, "done", "a later export must capture the closure and make it recoverable");
});

test("help/README/skill document the durability trade-off, not only mirror freshness", t => {
  const f = fixture(t);
  const help = f.cli(["--help"]).stdout;
  assert.match(help, /DURABILITY/);
  assert.match(help, /filesHash of the whole mirror set/);

  // __dirname is dist/ (dist -> sync-engine -> packages -> repo root).
  const repoRoot = path.join(__dirname, "..", "..", "..");
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /durability trade/i);
  assert.match(readme, /filesHash/);

  const skill = fs.readFileSync(path.join(repoRoot, "skills", "mapctx-traycer", "SKILL.md"), "utf8");
  assert.match(skill, /durability trade/i);
});

// ---------------------------------------------------------------------------
// Review F4: the `task move --status done` help line no longer claims
// unconditional equivalence with `task finish --no-snapshot` -- they diverge
// once the task IS already done (`done` has no self-edge).
// ---------------------------------------------------------------------------

test("MUTATION GUARD (F4): on an already-done task, task move --status done is illegal-transition while task finish --no-snapshot succeeds with move.performed:false; help no longer claims unconditional equivalence", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.bringToReviewWithApprovedAcceptance("T-101", "acceptance.md");
  f.success(["task", "finish", "T-101", "--no-snapshot", "--actor", "test"]);

  const moveRefused = f.refused(["task", "move", "T-101", "--status", "done", "--actor", "test"]);
  assert.match(moveRefused.stderr, /illegal-transition/);

  const finishResult = f.success(["task", "finish", "T-101", "--no-snapshot", "--actor", "test"]);
  assert.equal(finishResult.ok, true);
  assert.equal(finishResult.move.performed, false);

  const help = f.cli(["--help"]).stdout;
  assert.ok(!/no more and no less/.test(help), "help must no longer claim unconditional equivalence");
  assert.match(help, /not yet done/);
});

// ---------------------------------------------------------------------------
// Review F5: closing releases whatever claim is active, even one held by a
// different actor -- previously silent. Both closing paths now warn on
// stderr, naming the released claim id, without disturbing --json stdout.
// ---------------------------------------------------------------------------

test("MUTATION GUARD (F5): finish --no-snapshot and move --status done both warn on stderr and report releasedClaimId when closing revokes another holder's active claim", t => {
  for (const closeVia of ["finish", "move"] as const) {
    const f = fixture(t);
    f.success(["import", "--commit", "--actor", "test"]);
    f.success(["task", "update", "T-101", "--set", "workload=Normal", "--set", "detail.estimatedEffort=1d", "--actor", "test"]);
    f.success(["task", "claim", "T-101", "--actor", "other-agent"]);
    f.success(["task", "move", "T-101", "--status", "review", "--actor", "test"]);
    fs.writeFileSync(path.join(f.repoDir, "acceptance.md"), "## Acceptance\n- [ ] one.\n");
    const revised = f.success(["task", "acceptance", "revise", "T-101", "--from-file", "acceptance.md", "--expect-revision", "0", "--actor", "test"]);
    f.success(["task", "acceptance", "approve", "T-101", "--index", "0", "--expect-revision", String(revised.revision), "--actor", "test"]);

    const result = closeVia === "finish"
      ? f.cli(["task", "finish", "T-101", "--no-snapshot", "--actor", "me", "--json"])
      : f.cli(["task", "move", "T-101", "--status", "done", "--actor", "me", "--json"]);
    assert.equal(result.status, 0, `${closeVia}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    const releasedClaimId = closeVia === "finish" ? payload.move.releasedClaimId : payload.releasedClaimId;
    assert.ok(releasedClaimId, `${closeVia}: expected releasedClaimId in the payload: ${JSON.stringify(payload)}`);
    assert.match(String(result.stderr), /released the active claim/);
    assert.ok(String(result.stderr).includes(releasedClaimId), `${closeVia}: stderr must name the released claim id`);
  }
});

// ---------------------------------------------------------------------------
// Extra (cheap): the skill now documents that `task create --status done`
// bypasses the done gate entirely -- pin the fact at the store level.
// ---------------------------------------------------------------------------

test("createTask({status:'done'}) bypasses the acceptance gate entirely: no acceptance revision required, completedOn is null (unlike moveTask, which stamps it)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const created = f.success(["task", "create", "--title", "bootstrap bypass", "--status", "done", "--workload", "Normal", "--actor", "test"]);
  assert.ok(created.ok);
  const shown = f.success(["task", "show", created.taskId]);
  assert.equal(shown.task.planningState, "done");
  assert.equal(shown.task.completedOn, null, "createTask does not stamp completedOn the way moveTask does");
  const acceptance = f.success(["task", "acceptance", "show", created.taskId]);
  assert.equal(acceptance.acceptance.condition, "absent", "no acceptance revision was required to create it as done");
});
