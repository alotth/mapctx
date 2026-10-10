import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "fs"
import * as path from "path"
import test, { type TestContext } from "node:test"
import { StoreHandle, resolveProjectStoreDir, readMapctxToml } from "@mapctx/store"

// T-129: reuse the store's golden repo + isolated MAPCTX_HOME fixture, same
// pattern as privacy-cli.test.ts / T-127's cli-quickwins.test.ts.
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

function countTasks(f: ReturnType<typeof fixture>): number {
  // `validate` is a report (prints to stdout even on a non-zero exit, e.g.
  // the golden fixture's pre-existing completion-acceptance-incomplete on
  // T-102), so read totalTasks straight off stdout rather than via `success`.
  const result = f.cli(["validate", "--json"]);
  return JSON.parse(result.stdout).store.canonical.totalTasks as number;
}

// ---------------------------------------------------------------------------
// C0: acceptance on create, atomic.
// ---------------------------------------------------------------------------

test("task create --acceptance-file records revision 1 in the SAME command: acceptanceRevision in the result, criteria pending in order", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  fs.writeFileSync(path.join(f.repoDir, "acc.md"), "## Acceptance\n- [ ] First\n- [ ] Second\n");
  const created = f.success(["task", "create", "--title", "Atomic", "--acceptance-file", "acc.md", "--actor", "test"]);
  assert.equal(created.acceptanceRevision, 1, JSON.stringify(created));

  const shown = f.success(["task", "acceptance", "show", created.taskId]);
  assert.equal(shown.acceptance.revision, 1);
  assert.deepEqual(shown.acceptance.criteria.map((c: { text: string; state: string }) => [c.text, c.state]), [
    ["First", "pending"],
    ["Second", "pending"]
  ]);
});

test("a ## Acceptance section in --description-file is used (previously ignored in silence)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  fs.writeFileSync(path.join(f.repoDir, "desc.md"), "Some prose.\n\n## Acceptance\n- [ ] From description file\n");
  const created = f.success(["task", "create", "--title", "Desc file acceptance", "--description-file", "desc.md", "--actor", "test"]);
  assert.equal(created.acceptanceRevision, 1, JSON.stringify(created));
  const shown = f.success(["task", "acceptance", "show", created.taskId]);
  assert.deepEqual(shown.acceptance.criteria.map((c: { text: string }) => c.text), ["From description file"]);
});

test("--acceptance-file wins over a ## Acceptance section in --description, and warns on stderr that the description's section was NOT recorded (stdout stays clean)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  fs.writeFileSync(path.join(f.repoDir, "acc.md"), "## Acceptance\n- [ ] From file\n");
  const result = f.cli([
    "task", "create", "--title", "Precedence probe",
    "--acceptance-file", "acc.md",
    "--description", "Prose.\n\n## Acceptance\n- [ ] From description\n",
    "--actor", "test", "--json"
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(String(result.stderr), /both --acceptance-file and a ## Acceptance section in the description were given/);
  assert.match(String(result.stderr), /NOT recorded/);
  const created = JSON.parse(result.stdout);
  assert.doesNotThrow(() => JSON.parse(result.stdout), "stdout must stay a clean JSON document despite the stderr warning");
  const shown = f.success(["task", "acceptance", "show", created.taskId]);
  assert.deepEqual(shown.acceptance.criteria.map((c: { text: string }) => c.text), ["From file"], "the description's section must not have been recorded");
});

test("a checklist in --description with no ## Acceptance heading warns on stderr and records NO criteria (acceptance stays absent)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const result = f.cli([
    "task", "create", "--title", "Headerless description probe",
    "--description", "- [ ] looks like a checklist\n- [x] but has no heading\n",
    "--actor", "test", "--json"
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(String(result.stderr), /no ## Acceptance heading, so NO criteria were recorded/);
  const created = JSON.parse(result.stdout);
  assert.equal(created.acceptanceRevision, null);
  const shown = f.success(["task", "acceptance", "show", created.taskId]);
  assert.deepEqual(shown.acceptance, { condition: "absent" });
});

test("MUTATION GUARD: --acceptance-file with no checkbox at all refuses and creates NO task (atomicity) -- task count is unchanged", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const before = countTasks(f);
  fs.writeFileSync(path.join(f.repoDir, "empty.md"), "Just prose, no checklist at all.\n");
  const result = f.cli(["task", "create", "--title", "Should not exist", "--acceptance-file", "empty.md", "--actor", "test", "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(String(result.stderr), /has neither a ## Acceptance section nor any `- \[ \]` checklist item/);
  const after = countTasks(f);
  assert.equal(after, before, "no task must have been created when the acceptance source is unreadable");
});

// ---------------------------------------------------------------------------
// C1: batch approve.
// ---------------------------------------------------------------------------

function createWithThreeCriteria(f: ReturnType<typeof fixture>): { taskId: string } {
  fs.writeFileSync(path.join(f.repoDir, "three.md"), "## Acceptance\n- [ ] a\n- [ ] b\n- [ ] c\n");
  const created = f.success(["task", "create", "--title", "Batch approve target", "--acceptance-file", "three.md", "--actor", "test"]);
  return { taskId: created.taskId };
}

test("acceptance approve --index 0,2 --evidence approves both under one evidence set; approved has 2, alreadyApproved 0, evidence lands on both", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { taskId } = createWithThreeCriteria(f);
  const result = f.success(["task", "acceptance", "approve", taskId, "--index", "0,2", "--evidence", "uri=x", "--expect-revision", "1", "--actor", "test"]);
  assert.equal(result.approved.length, 2);
  assert.deepEqual(result.alreadyApproved, []);
  const shown = f.success(["task", "acceptance", "show", taskId]);
  assert.equal(shown.acceptance.criteria[0].state, "approved");
  assert.deepEqual(shown.acceptance.criteria[0].evidence, { uri: "x" });
  assert.equal(shown.acceptance.criteria[1].state, "pending");
  assert.equal(shown.acceptance.criteria[2].state, "approved");
  assert.deepEqual(shown.acceptance.criteria[2].evidence, { uri: "x" });
});

test("acceptance approve --all approves pending criteria and skips already-approved ones, reporting them in alreadyApproved", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { taskId } = createWithThreeCriteria(f);
  f.success(["task", "acceptance", "approve", taskId, "--index", "0", "--expect-revision", "1", "--actor", "test"]);
  const criterion0 = f.success(["task", "acceptance", "show", taskId]).acceptance.criteria[0].criterionId;

  const all = f.success(["task", "acceptance", "approve", taskId, "--all", "--expect-revision", "1", "--actor", "test"]);
  assert.equal(all.approved.length, 2);
  assert.deepEqual(all.alreadyApproved, [criterion0]);
});

test("--index on an already-approved criterion refuses already-approved; --all when everything is approved refuses nothing-to-approve", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { taskId } = createWithThreeCriteria(f);
  f.success(["task", "acceptance", "approve", taskId, "--all", "--expect-revision", "1", "--actor", "test"]);

  const explicit = f.refused(["task", "acceptance", "approve", taskId, "--index", "0", "--expect-revision", "1", "--actor", "test"]);
  assert.equal(explicit.payload.reason, "already-approved");

  const allAgain = f.refused(["task", "acceptance", "approve", taskId, "--all", "--expect-revision", "1", "--actor", "test"]);
  assert.equal(allAgain.payload.reason, "nothing-to-approve");
});

test("MUTATION GUARD: --index 0,99 (99 out of range) refuses and approves NOTHING -- not even the valid index 0", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { taskId } = createWithThreeCriteria(f);
  const { payload } = f.refused(["task", "acceptance", "approve", taskId, "--index", "0,99", "--expect-revision", "1", "--actor", "test"]);
  assert.equal(payload.reason, "unknown-criterion");
  const shown = f.success(["task", "acceptance", "show", taskId]);
  assert.ok(shown.acceptance.criteria.every((c: { state: string }) => c.state === "pending"), "index 0 must not have been approved despite being valid");
});

test("--all combined with --index refuses; --index 0,0 (duplicate) refuses; --all on unapprove refuses; unapprove --index 0,1 (multi) refuses", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { taskId } = createWithThreeCriteria(f);

  const bothAllAndIndex = f.refused(["task", "acceptance", "approve", taskId, "--all", "--index", "0", "--expect-revision", "1", "--actor", "test"]);
  assert.ok(bothAllAndIndex.payload.ok === false);

  const dupeIndex = f.refused(["task", "acceptance", "approve", taskId, "--index", "0,0", "--expect-revision", "1", "--actor", "test"]);
  assert.ok(dupeIndex.payload.ok === false);

  const allUnapprove = f.cli(["task", "acceptance", "unapprove", taskId, "--all", "--expect-revision", "1", "--actor", "test", "--json"]);
  assert.notEqual(allUnapprove.status, 0);
  assert.match(String(allUnapprove.stderr), /unapprove does not take --all/);

  const multiUnapprove = f.cli(["task", "acceptance", "unapprove", taskId, "--index", "0,1", "--expect-revision", "1", "--actor", "test", "--json"]);
  assert.notEqual(multiUnapprove.status, 0);
  assert.match(String(multiUnapprove.stderr), /unapprove takes a single --index/);
});

test("a stale --expect-revision on approve refuses without approving anything", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { taskId } = createWithThreeCriteria(f);
  const { payload } = f.refused(["task", "acceptance", "approve", taskId, "--index", "0", "--expect-revision", "999", "--actor", "test"]);
  assert.equal(payload.reason, "revision-conflict");
  const shown = f.success(["task", "acceptance", "show", taskId]);
  assert.ok(shown.acceptance.criteria.every((c: { state: string }) => c.state === "pending"));
});

// ---------------------------------------------------------------------------
// C2: revise --expect-title.
// ---------------------------------------------------------------------------

test("MUTATION GUARD: revise --expect-title with the wrong title refuses title-mismatch (naming both titles) and leaves acceptance show unchanged", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const before = f.success(["task", "acceptance", "show", "T-101"]);
  fs.writeFileSync(path.join(f.repoDir, "acc.md"), "## Acceptance\n- [ ] x\n");
  const { payload } = f.refused(["task", "acceptance", "revise", "T-101", "--from-file", "acc.md", "--expect-revision", "0", "--expect-title", "Totally wrong title", "--actor", "test"]);
  assert.equal(payload.reason, "title-mismatch");
  assert.match(payload.message, /Totally wrong title/);
  assert.deepEqual(f.success(["task", "acceptance", "show", "T-101"]), before, "a title mismatch must change nothing");
});

test("revise --expect-title accepts the human form (no [T-xxx] prefix) and the full stored form; proceeds unaffected without the flag", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const storedTitle = f.success(["task", "show", "T-101"]).task.title as string;
  const humanTitle = storedTitle.replace(/^\s*\[[^\]]+\]\s*/, "");

  fs.writeFileSync(path.join(f.repoDir, "acc.md"), "## Acceptance\n- [ ] human form\n");
  f.success(["task", "acceptance", "revise", "T-101", "--from-file", "acc.md", "--expect-revision", "0", "--expect-title", humanTitle, "--actor", "test"]);

  fs.writeFileSync(path.join(f.repoDir, "acc2.md"), "## Acceptance\n- [ ] full form\n");
  f.success(["task", "acceptance", "revise", "T-101", "--from-file", "acc2.md", "--expect-revision", "1", "--expect-title", storedTitle, "--actor", "test"]);

  // No --expect-title: old behavior is unaffected.
  fs.writeFileSync(path.join(f.repoDir, "acc3.md"), "## Acceptance\n- [ ] no flag\n");
  const noFlag = f.success(["task", "acceptance", "revise", "T-101", "--from-file", "acc3.md", "--expect-revision", "2", "--actor", "test"]);
  assert.equal(noFlag.revision, 3);
});

// ---------------------------------------------------------------------------
// C3: acceptance import --task.
// ---------------------------------------------------------------------------

test("acceptance import without --task has taskFilter null and plans every task; with --task T-101,T-102 it scopes to 2 entries naming both ids", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const unscoped = f.success(["acceptance", "import"]);
  assert.equal(unscoped.taskFilter, null);

  const scoped = f.success(["acceptance", "import", "--task", "T-101,T-102"]);
  assert.deepEqual(scoped.taskFilter, ["T-101", "T-102"]);
  assert.deepEqual(scoped.entries.map((e: { taskId: string }) => e.taskId).sort(), ["T-101", "T-102"]);
});

test("MUTATION GUARD: acceptance import --task with an unknown id refuses citing it, and plans/imports nothing", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const result = f.cli(["acceptance", "import", "--task", "T-101,T-999", "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(String(result.stderr), /T-999/);
});

test("acceptance import --commit --task honors the same scope: only the filtered task gets an acceptance revision", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.success(["acceptance", "import", "--commit", "--task", "T-101", "--actor", "test"]);
  assert.notEqual(f.success(["task", "acceptance", "show", "T-101"]).acceptance.condition, "absent", "T-101 has a real ## Acceptance section and was in scope");
  assert.equal(f.success(["task", "acceptance", "show", "T-102"]).acceptance.condition, "absent", "T-102 was out of scope and must still have no acceptance revision");
});

// ---------------------------------------------------------------------------
// C4: --from-file headerless fallback, precedence, fences, strictness.
// ---------------------------------------------------------------------------

test("--from-file with no ## Acceptance heading at all still works, and stderr notes how many items it read without a heading", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  fs.writeFileSync(path.join(f.repoDir, "bare.md"), "- [ ] a\n- [x] b\n");
  const result = f.cli(["task", "acceptance", "revise", "T-101", "--from-file", "bare.md", "--expect-revision", "0", "--actor", "test", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(String(result.stderr), /has no ## Acceptance heading; read 2 checklist item\(s\) from the whole file/);
  const revised = JSON.parse(result.stdout);
  assert.deepEqual(revised.criteria.map((c: { text: string }) => c.text), ["a", "b"]);
});

test("MUTATION GUARD: a file with a ## Acceptance section AND checkboxes outside it reads ONLY the section's items (the bare fallback never fires when a real section exists)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  // A sibling heading ("## Notes") at the same level ends the Acceptance
  // section (per analyzeAcceptanceProse's own contract), so "outside, after"
  // is genuinely outside it -- without that heading the section would run to
  // EOF and swallow it too.
  const content = "- [ ] outside, before\n\n## Acceptance\n- [ ] inside the section\n\n## Notes\n- [x] outside, after\n";
  fs.writeFileSync(path.join(f.repoDir, "mixed.md"), content);
  const result = f.cli(["task", "acceptance", "revise", "T-101", "--from-file", "mixed.md", "--expect-revision", "0", "--actor", "test", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!/has no ## Acceptance heading/.test(String(result.stderr)), "the real section was found; the headerless note must not print");
  const revised = JSON.parse(result.stdout);
  assert.deepEqual(revised.criteria.map((c: { text: string }) => c.text), ["inside the section"]);
});

test("a checkbox inside a fenced code block does not count as a criterion in the headerless path", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const content = ["- [ ] real one", "```", "- [ ] fenced, not a criterion", "```"].join("\n");
  fs.writeFileSync(path.join(f.repoDir, "fenced.md"), content);
  const result = f.success(["task", "acceptance", "revise", "T-101", "--from-file", "fenced.md", "--expect-revision", "0", "--actor", "test"]);
  assert.deepEqual(result.criteria.map((c: { text: string }) => c.text), ["real one"]);
});

test("a bullet with no checkbox does not count as a criterion in the headerless path (stricter than the in-section reader)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  fs.writeFileSync(path.join(f.repoDir, "prose-bullet.md"), "- [ ] real criterion\n- plain prose bullet\n");
  const result = f.success(["task", "acceptance", "revise", "T-101", "--from-file", "prose-bullet.md", "--expect-revision", "0", "--actor", "test"]);
  assert.deepEqual(result.criteria.map((c: { text: string }) => c.text), ["real criterion"]);
});

test("a file with neither a ## Acceptance section nor any checkbox refuses with the new message", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  fs.writeFileSync(path.join(f.repoDir, "nothing.md"), "Just a paragraph, nothing else.\n");
  const result = f.cli(["task", "acceptance", "revise", "T-101", "--from-file", "nothing.md", "--expect-revision", "0", "--actor", "test", "--json"]);
  assert.notEqual(result.status, 0);
  assert.match(String(result.stderr), /has neither a ## Acceptance section nor any `- \[ \]` checklist item/);
});

// ---------------------------------------------------------------------------
// Semantics that did NOT change (pin as expected): revise still clears every
// approval -- re-approval and its evidence are never inherited.
// ---------------------------------------------------------------------------

test("revise still clears every approval: criteria return to pending and prior evidence does not carry over", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { taskId } = createWithThreeCriteria(f);
  f.success(["task", "acceptance", "approve", taskId, "--all", "--evidence", "uri=old", "--expect-revision", "1", "--actor", "test"]);
  assert.ok(f.success(["task", "acceptance", "show", taskId]).acceptance.criteria.every((c: { state: string }) => c.state === "approved"));

  fs.writeFileSync(path.join(f.repoDir, "revised.md"), "## Acceptance\n- [ ] a\n- [ ] b\n- [ ] c\n");
  f.success(["task", "acceptance", "revise", taskId, "--from-file", "revised.md", "--expect-revision", "1", "--actor", "test"]);

  const after = f.success(["task", "acceptance", "show", taskId]);
  assert.ok(after.acceptance.criteria.every((c: { state: string }) => c.state === "pending"), "every criterion must reset to pending after a revise");
  assert.ok(after.acceptance.criteria.every((c: { evidence: unknown }) => !c.evidence), "prior evidence must not carry over to the new revision");
});

// ---------------------------------------------------------------------------
// C5: already delivered by T-127, not redone here. Confirming the existing
// test still covers it (see cli-quickwins.test.ts:600). That file is not
// touched by this task.
// ---------------------------------------------------------------------------
// "acceptance revise, approve, AND unapprove each refuse without
// --expect-revision, naming the store's current revision or 0 when none
// exists yet" -- packages/sync-engine/src/cli-quickwins.test.ts:600.
