import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "fs"
import * as path from "path"
import test, { type TestContext } from "node:test"
import { parseTaskDetailFile } from "@mapctx/core"
import { getTask, readMapctxToml, resolveProjectStoreDir, StoreHandle } from "@mapctx/store"

// T-136: `task update --description` / `--description-file` edits the
// Git-authored prose block of tasks/<ID>.md in any planning state, without
// touching the store. Same golden-repo fixture as cli-quickwins.test.ts.
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
    assert.equal(result.status, 0, result.stderr);
    return { payload: JSON.parse(result.stdout), stderr: String(result.stderr) };
  };
  const detail = (id: string) => fs.readFileSync(path.join(f.repoDir, "tasks", `${id}.md`), "utf8");
  const write = (name: string, content: string) => {
    const file = path.join(f.repoDir, name);
    fs.writeFileSync(file, content, "utf8");
    return file;
  };
  const read = <T>(fn: (handle: StoreHandle) => T): T => {
    const handle = StoreHandle.openReadOnly(resolveProjectStoreDir(readMapctxToml(path.join(f.repoDir, "mapctx.toml")).projectId));
    try { return fn(handle); } finally { handle.close(); }
  };
  const eventCount = () => read(handle => (handle.db.prepare("SELECT COUNT(*) AS n FROM event_log").get() as { n: number }).n);
  return { ...f, cli, success, detail, write, read, eventCount };
}

const linesOutsideDescription = (content: string) => {
  const lines = content.split("\n");
  return lines.slice(0, lines.indexOf("  - description: |") + 1);
};

test("--description-file rewrites only the description of a done task: no store event, state and fields untouched", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const before = f.detail("T-102");
  const taskBefore = f.read(handle => getTask(handle.db, "T-102"));
  const events = f.eventCount();

  const file = f.write("desc.md", "## Escopo\n\nTexto novo,\ncom duas linhas.\n");
  const { payload } = f.success(["task", "update", "T-102", "--description-file", file, "--actor", "test"]);
  assert.deepEqual(payload.description, { detailPath: "tasks/T-102.md", changed: true });

  const after = f.detail("T-102");
  assert.deepEqual(linesOutsideDescription(after), linesOutsideDescription(before));
  assert.equal(parseTaskDetailFile(after).description, "## Escopo\n\nTexto novo,\ncom duas linhas.");
  assert.ok(after.endsWith("com duas linhas.\n"), JSON.stringify(after.slice(-40)));
  assert.equal(f.eventCount(), events, "the store never receives prose");
  const taskAfter = f.read(handle => getTask(handle.db, "T-102"));
  assert.equal(taskAfter?.planningState, "done");
  assert.equal(taskAfter?.completedOn, taskBefore?.completedOn);
  assert.equal(taskAfter?.updatedOn, taskBefore?.updatedOn);

  // Same text again is a no-op write.
  assert.equal(f.success(["task", "update", "T-102", "--description-file", file, "--actor", "test"]).payload.description.changed, false);
});

test("--description with literal \\n is unescaped on update and on create; real newlines are kept verbatim", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const updated = f.success(["task", "update", "T-101", "--description", "## A\\n\\nbody", "--actor", "test"]);
  assert.match(updated.stderr, /converted \\n to line breaks/);
  assert.equal(parseTaskDetailFile(f.detail("T-101")).description, "## A\n\nbody");

  const created = f.success(["task", "create", "--title", "Escaped", "--workload", "Easy", "--effort", "1h", "--description", "## B\\n\\nlinha", "--actor", "test"]);
  assert.equal(parseTaskDetailFile(f.detail(created.payload.taskId)).description, "## B\n\nlinha");

  const verbatim = f.success(["task", "update", "T-101", "--description", "x\nkeep \\n here", "--actor", "test"]);
  assert.doesNotMatch(verbatim.stderr, /converted/);
  assert.equal(parseTaskDetailFile(f.detail("T-101")).description, "x\nkeep \\n here");
});

test("store-owned acceptance survives a description edit; a different supplied checklist is reported, not recorded", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const created = f.success(["task", "create", "--title", "With acceptance", "--workload", "Easy", "--effort", "1h",
    "--description-file", f.write("seed.md", "## Scope\n\nold\n\n## Acceptance\n\n- [ ] criterion A\n"), "--actor", "test"]);
  const id = created.payload.taskId as string;

  const edited = f.success(["task", "update", id, "--description-file",
    f.write("edit.md", "## Scope\n\nnew scope\n\n## Acceptance\n\n- [ ] criterion B\n"), "--actor", "test"]);
  assert.match(edited.stderr, /store-owned/);
  const description = parseTaskDetailFile(f.detail(id)).description;
  assert.match(description, /new scope/);
  assert.match(description, /- \[ \] criterion A/);
  assert.doesNotMatch(description, /criterion B/);
  assert.deepEqual(f.success(["task", "acceptance", "show", id]).payload.acceptance.criteria.map((c: { text: string }) => c.text), ["criterion A"]);

  // The file is exactly what the next export would write.
  f.success(["export"]);
  assert.equal(parseTaskDetailFile(f.detail(id)).description, description);
});

test("a description edit can ride along with --set in one command, and keeps an epic's budget section", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.success(["budget", "set", "E-100", "--minutes", "120", "--actor", "test"]);
  f.success(["export"]);
  const before = f.detail("E-100");
  const tail = before.slice(before.indexOf("\n  - budget"));
  assert.ok(tail.length > 1, `fixture should render a budget section: ${before}`);

  const { payload } = f.success(["task", "update", "E-100", "--set", "title=Renamed epic",
    "--description", "Only prose\nchanged.", "--actor", "test"]);
  assert.deepEqual(payload.applied.fields, ["title"]);
  const after = f.detail("E-100");
  assert.ok(after.endsWith(tail), after);
  assert.equal(parseTaskDetailFile(after).description, "Only prose\nchanged.");
  assert.equal(f.read(handle => getTask(handle.db, "E-100"))?.title, "Renamed epic");
});

test("a store refusal leaves the description file untouched", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const before = f.detail("T-101");
  const result = f.cli(["task", "update", "T-101", "--set", "workload=Gigantic", "--description", "never written", "--actor", "test", "--json"]);
  assert.notEqual(result.status, 0);
  assert.equal(f.detail("T-101"), before);
});

// Review F4: an empty value (usually an unset shell variable) must not erase
// Git-authored prose. Refused through the T-127 channel, before any write.
test("an empty or whitespace-only description is refused on update and create, and writes nothing", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const before = f.detail("T-101");
  const events = f.eventCount();
  const refusedJson = (args: string[]) => {
    const result = f.cli([...args, "--json"]);
    assert.notEqual(result.status, 0, "expected a refusal");
    assert.equal(String(result.stdout).trim(), "", "a refusal is not a result");
    const lines = String(result.stderr).split("\n").filter(line => line.length > 0);
    assert.match(lines[1], /^Error: (Update|Create) refused: empty-description -- /);
    return JSON.parse(lines[0]);
  };

  assert.deepEqual(refusedJson(["task", "update", "T-101", "--description", "", "--actor", "test"]), { ok: false, reason: "empty-description", to: "T-101" });
  assert.equal(refusedJson(["task", "update", "T-101", "--description", " \n\t ", "--actor", "test"]).reason, "empty-description");
  assert.equal(refusedJson(["task", "update", "T-101", "--description-file", f.write("blank.md", "\n  \n"), "--actor", "test"]).reason, "empty-description");
  // Riding along with --set does not slip the store change through.
  assert.equal(refusedJson(["task", "update", "T-101", "--set", "title=Never applied", "--description", "", "--actor", "test"]).reason, "empty-description");
  assert.deepEqual(refusedJson(["task", "create", "--title", "No prose", "--workload", "Easy", "--effort", "1h", "--description", "", "--actor", "test"]), { ok: false, reason: "empty-description" });

  assert.equal(f.detail("T-101"), before);
  assert.equal(f.eventCount(), events, "nothing reached the store");
});
