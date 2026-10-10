import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "fs"
import * as path from "path"
import test, { type TestContext } from "node:test"
import {
  getTask, readMapctxToml, resolveProjectStoreDir, StoreHandle
} from "@mapctx/store"
import { workloadSchema, prioritySchema, taskTypeSchema, specModeSchema, planningStateSchema } from "@mapctx/protocol"
import { CHECKPOINT_REASONS } from "./checkpoint"

// T-127: reuse the store's golden repo + isolated MAPCTX_HOME fixture, same
// pattern as privacy-cli.test.ts. Its internal helpers are deliberately not
// part of the public package export surface.
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
  // Refusal path: stdout must stay empty, the structured payload is the first
  // document on stderr, followed by the `Error:` line. Same contract
  // privacy-cli.test.ts already asserts for `redact`.
  const refused = (args: string[]) => {
    const result = cli([...args, "--json"]);
    assert.notEqual(result.status, 0, "expected a refusal");
    assert.equal(result.signal, null);
    assert.equal(String(result.stdout).trim(), "", "stdout is the result channel; a refusal is not a result");
    const stderr = String(result.stderr);
    const boundary = stderr.indexOf("\nError:");
    assert.ok(boundary > 0, stderr);
    // Review A9/A10: under --json, stderr is exactly one line of compact JSON
    // followed by the human `Error:` line -- a consumer can read stderr's
    // first line directly instead of hunting the boundary.
    const lines = stderr.split("\n").filter(line => line.length > 0);
    assert.equal(lines.length, 2, `expected exactly 2 non-empty stderr lines, got: ${JSON.stringify(lines)}`);
    assert.deepEqual(JSON.parse(lines[0]), JSON.parse(stderr.slice(0, boundary)), "the first stderr line alone must parse to the same payload");
    return { result, payload: JSON.parse(stderr.slice(0, boundary)), stderr };
  };
  // Review A9: without --json, no JSON payload at all -- only the `Error:`
  // line -- because the payload can embed a holder's leaseToken (T-124 C0).
  const refusedHuman = (args: string[]) => {
    const result = cli(args);
    assert.notEqual(result.status, 0, "expected a refusal");
    const stderr = String(result.stderr);
    assert.equal(String(result.stdout).trim(), "", "stdout is the result channel; a refusal is not a result");
    assert.ok(!stderr.includes("{"), `expected no JSON payload on stderr without --json: ${stderr}`);
    assert.match(stderr, /^Error: /);
    return { result, stderr };
  };
  // `validate` (like `store repair` / `import --dry-run`) prints its report to
  // stdout and only THEN throws a plain Error -- it never goes through
  // CliRefusal, so a failing gate still leaves the real JSON document on
  // stdout; stderr carries only the generic {ok:false,error} envelope.
  const reportFailure = (args: string[]) => {
    const result = cli([...args, "--json"]);
    assert.notEqual(result.status, 0, "expected the gate to fail");
    assert.notEqual(String(result.stdout).trim(), "", "the report must stay on stdout even on failure");
    return { result, payload: JSON.parse(result.stdout) };
  };
  const storeDir = () => resolveProjectStoreDir(readMapctxToml(path.join(f.repoDir, "mapctx.toml")).projectId);
  const read = <T>(fn: (handle: StoreHandle) => T): T => {
    const handle = StoreHandle.openReadOnly(storeDir());
    try { return fn(handle); } finally { handle.close(); }
  };
  return { ...f, cli, success, refused, refusedHuman, reportFailure, storeDir, read };
}

// ---------------------------------------------------------------------------
// 1. Enumerated values in help, compared against the protocol schemas.
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compares the help's printed line for `flag` against the schema's own
 * `.options` directly (never a hardcoded copy), so this test fails the moment
 * the help text and the validator it describes drift apart. `*` marks a
 * schema-derived row (review A13); it is optional here because this helper
 * also asserts the manually-maintained rows, which never carry it.
 */
function assertEnumLine(out: string, flag: string, values: string): void {
  const re = new RegExp(`^\\s*${escapeRegExp(flag)}(?: \\*)?\\s+${escapeRegExp(values)}$`, "m");
  assert.match(out, re, `expected a help line for ${flag} with values "${values}"`);
}

test("mapctx --help prints an Enumerated values table whose values match the protocol schemas exactly", t => {
  const f = fixture(t);
  const result = f.cli(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  assert.match(out, /Enumerated values:/);
  assertEnumLine(out, "--workload", workloadSchema.options.join("|"));
  assertEnumLine(out, "--priority", prioritySchema.options.join("|"));
  assertEnumLine(out, "--type", taskTypeSchema.options.join("|"));
  assertEnumLine(out, "--set specMode", specModeSchema.options.join("|"));
  assertEnumLine(out, "--status (canonical)", planningStateSchema.options.join("|"));
});

test("the Enumerated values table marks schema-derived rows with `*` and leaves hand-maintained rows unmarked", t => {
  const f = fixture(t);
  const out = f.cli(["--help"]).stdout;
  for (const flag of ["--workload", "--priority", "--type", "--status (canonical)", "--set specMode", "--reason (export)"]) {
    const re = new RegExp(`^\\s*${escapeRegExp(flag)} \\*\\s+\\S`, "m");
    assert.match(out, re, `expected ${flag} to carry the schema-derived marker`);
  }
  const manualRe = /^\s*--status \(board spelling\)\s+backlog\|/m;
  assert.match(out, manualRe);
  assert.ok(!/--status \(board spelling\) \*/.test(out), "a hand-maintained row must never carry the schema marker");
  assert.match(out, /read straight off the schema the validators use, so it cannot drift/);
});

test("mapctx help (subcommand spelling) and -h both print the same Enumerated values table", t => {
  const f = fixture(t);
  const viaHelp = f.cli(["help"]).stdout;
  const viaDashH = f.cli(["-h"]).stdout;
  assert.match(viaHelp, /Enumerated values:/);
  assert.match(viaDashH, /Enumerated values:/);
  assert.ok(viaHelp.includes(workloadSchema.options.join("|")));
  assert.ok(viaDashH.includes(workloadSchema.options.join("|")));
});

// ---------------------------------------------------------------------------
// 2. Unknown-field refusal on `task update` names both groups, redirects a
//    field used on the wrong side, and mentions waitReason for a bogus field.
// ---------------------------------------------------------------------------

test("task update --set filesAffected=a,b (missing detail. prefix) refuses and tells the caller to use --set detail.filesAffected=", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { payload } = f.refused(["task", "update", "T-101", "--set", "filesAffected=a,b", "--actor", "test"]);
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, "unknown-field");
  assert.match(payload.message, /detail field/);
  assert.match(payload.message, /--set detail\.filesAffected=/);
  assert.match(payload.message, /Task fields:/);
  assert.match(payload.message, /Detail fields \(prefix each with `detail\.`\):/);
});

test("task update --set detail.title=x (task field under detail.) refuses and tells the caller to drop the prefix", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { payload } = f.refused(["task", "update", "T-101", "--set", "detail.title=x", "--actor", "test"]);
  assert.equal(payload.reason, "unknown-field");
  assert.match(payload.message, /It is a task field: use `--set title=\.\.\.` without the `detail\.` prefix\./);
});

test("task update --set nope=1 (field that exists nowhere) lists both groups and mentions waitReason", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { payload } = f.refused(["task", "update", "T-101", "--set", "nope=1", "--actor", "test"]);
  assert.equal(payload.reason, "unknown-field");
  assert.match(payload.message, /Task fields:/);
  assert.match(payload.message, /Detail fields/);
  assert.match(payload.message, /waitReason/);
});

// ---------------------------------------------------------------------------
// 3. externalLinks patchable with URI validation.
// ---------------------------------------------------------------------------

test("task update --set externalLinks accepts two URIs, task show --json returns exactly them, =null clears, and export snapshots the TASKS.md line", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.success(["task", "update", "T-101", "--set", "externalLinks=https://github.com/o/r/issues/1,github:issue:42", "--actor", "test"]);
  const shown = f.success(["task", "show", "T-101"]);
  assert.deepEqual(shown.task.externalLinks, ["https://github.com/o/r/issues/1", "github:issue:42"]);

  const exported = f.success(["export", "--actor", "test"]);
  assert.ok(exported.ok !== false, JSON.stringify(exported));
  // externalLinks is rendered into the TASKS.md board block (renderTaskBlock
  // in export.ts), not into the per-task detail file.
  const tasksMd = fs.readFileSync(path.join(f.repoDir, "TASKS.md"), "utf8");
  assert.match(tasksMd, /- externalLinks: \[https:\/\/github\.com\/o\/r\/issues\/1, github:issue:42\]/);

  // The golden fixture always carries a pre-existing canonical error
  // (T-102's completion-acceptance-incomplete), so `validate` itself exits
  // non-zero regardless of externalLinks; only the --snapshots sub-report
  // (structural + drift against the just-exported snapshot) is under test.
  const snapshotsRun = f.cli(["validate", "--snapshots", "--json"]);
  const snapshots = JSON.parse(snapshotsRun.stdout);
  assert.equal(snapshots.snapshots.status, "passed", JSON.stringify(snapshots.snapshots));

  f.success(["task", "update", "T-101", "--set", "externalLinks=null", "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).task.externalLinks, []);
});

test("task update --set externalLinks refuses a schemeless value and a value with whitespace, journaling nothing; =empty clears to []", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const before = f.success(["task", "show", "T-101"]).task.externalLinks;
  for (const bad of ["foo/bar", "has space"]) {
    const { payload } = f.refused(["task", "update", "T-101", "--set", `externalLinks=${bad}`, "--actor", "test"]);
    assert.equal(payload.reason, "invalid-external-links");
  }
  assert.deepEqual(f.success(["task", "show", "T-101"]).task.externalLinks, before, "a refused patch must not land");

  f.success(["task", "update", "T-101", "--set", "externalLinks=https://example.invalid/1", "--actor", "test"]);
  f.success(["task", "update", "T-101", "--set", "externalLinks=", "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).task.externalLinks, [], "=empty (no entries) clears rather than refusing");
});

// ---------------------------------------------------------------------------
// 4. `validate --task` / `--baseline` / `--write-baseline`.
// ---------------------------------------------------------------------------

test("validate --task keeps only that task's issues (and still fails if one remains); another task's issues are filteredOutByTask and stop failing the gate", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  // T-102 picks up a task-scoped error (invalid-domain); the golden fixture
  // also always carries a pre-existing task-scoped error on T-102
  // (completion-acceptance-incomplete), so --task T-102 must still fail.
  f.success(["task", "update", "T-102", "--set", "domains=NOPE", "--actor", "test"]);

  const { payload: scoped } = f.reportFailure(["validate", "--task", "T-102"]);
  assert.ok(scoped.gate, JSON.stringify(scoped));
  assert.deepEqual(scoped.gate.taskFilter, ["T-102"]);
  assert.ok(scoped.store.canonical.issues.every((i: { taskId?: string }) => i.taskId === undefined || i.taskId === "T-102"));
  assert.ok(scoped.store.canonical.issues.some((i: { code: string }) => i.code === "invalid-domain"));

  // --task T-101: T-102's errors are all filteredOutByTask, and T-101 itself
  // has none, so the gate passes even though the board as a whole does not.
  const other = f.success(["validate", "--task", "T-101"]);
  assert.ok(other.gate.filteredOutByTask >= 1, JSON.stringify(other.gate));
  assert.ok(!other.store.canonical.issues.some((i: { taskId?: string }) => i.taskId === "T-102"));
});

test("validate --task excludes board-scoped issues (a dependency cycle) from the gate, but warns about them on stderr without touching stdout's JSON", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  // T-102 already dependsOn T-101; make T-101 depend on T-102 too, forming a
  // board-scoped (no taskId) dependency-cycle error.
  f.success(["task", "update", "T-101", "--depends-on", "T-102", "--actor", "test"]);

  const result = f.cli(["validate", "--task", "T-101", "--json"]);
  assert.equal(result.status, 0, String(result.stderr));
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.gate.boardScopedExcluded >= 1, JSON.stringify(payload.gate));
  const cycle = payload.gate.boardScopedErrors.find((i: { code: string }) => i.code === "dependency-cycle");
  assert.ok(cycle, JSON.stringify(payload.gate.boardScopedErrors));
  assert.ok(!payload.gate.boardScopedErrors.some((i: { code: string }) => i.code === "empty-work-domains"), "a board-scoped WARNING must never land in boardScopedErrors");
  assert.match(String(result.stderr), /Warning: board-scoped error not covered by --task: \[error\] dependency-cycle:/);
  assert.ok(!String(result.stdout).includes("Warning:"), "the warning must stay off stdout's JSON document");
});

test("validate --write-baseline records the current run, exits 0 even with errors present, and respects --task", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.success(["task", "update", "T-102", "--set", "domains=NOPE", "--actor", "test"]);
  const baselinePath = path.join(f.repoDir, "baseline.json");

  const written = f.success(["validate", "--write-baseline", baselinePath]);
  assert.ok(written.wroteBaseline, JSON.stringify(written));
  assert.equal(written.schemaVersion, 1);
  const file = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  assert.equal(file.schemaVersion, 1);
  assert.ok(Array.isArray(file.issues));

  // --baseline with the freshly written file: nothing new, exit 0.
  const gated = f.success(["validate", "--baseline", baselinePath]);
  assert.equal(gated.gate.staleBaseline.length, 0);

  // Respects --task: writing with --task narrows what gets recorded.
  const scopedPath = path.join(f.repoDir, "baseline-t101.json");
  const scopedWrite = f.success(["validate", "--write-baseline", scopedPath, "--task", "T-101"]);
  assert.ok(scopedWrite.wroteBaseline);
  const scopedFile = JSON.parse(fs.readFileSync(scopedPath, "utf8"));
  assert.ok(scopedFile.issues.every((i: { taskId: string | null }) => i.taskId === "T-101" || i.taskId === null), JSON.stringify(scopedFile));
});

test("validate --baseline fails only a NEW issue introduced after the baseline was written; prior issues count as baselined", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.success(["task", "update", "T-102", "--set", "domains=NOPE", "--actor", "test"]);
  const baselinePath = path.join(f.repoDir, "baseline.json");
  f.success(["validate", "--write-baseline", baselinePath]);

  // MUTATION: introduce a brand-new issue after the baseline was recorded --
  // point T-101's parentTaskId at a task that does not exist.
  f.success(["task", "update", "T-101", "--set", "parentTaskId=T-999", "--actor", "test"]);

  const { payload } = f.reportFailure(["validate", "--baseline", baselinePath]);
  assert.ok(payload.gate, JSON.stringify(payload));
  assert.ok(payload.gate.baselined >= 1, "the pre-existing domains issue must count as baselined");
  assert.deepEqual(payload.store.canonical.issues.map((i: { code: string }) => i.code), ["unknown-parent"], "only the new issue survives the gate");
});

test("validate --baseline reports a now-absent entry as staleBaseline without failing the gate", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.success(["task", "update", "T-102", "--set", "domains=NOPE", "--actor", "test"]);
  const baselinePath = path.join(f.repoDir, "baseline.json");
  f.success(["validate", "--write-baseline", baselinePath]);

  // Fix the issue the baseline recorded: its entry no longer matches anything.
  f.success(["task", "update", "T-102", "--set", "domains=CORE", "--actor", "test"]);

  const result = f.success(["validate", "--baseline", baselinePath]);
  assert.ok(result.gate.staleBaseline.length >= 1, JSON.stringify(result.gate));
});

test("validate refuses --baseline together with --write-baseline, a missing baseline file, invalid JSON, and a wrong schemaVersion -- all before validating", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  const both = f.cli(["validate", "--baseline", "a.json", "--write-baseline", "b.json", "--json"]);
  assert.notEqual(both.status, 0);
  assert.match(String(both.stderr), /mutually exclusive/);

  const missing = f.cli(["validate", "--baseline", "does-not-exist.json", "--json"]);
  assert.notEqual(missing.status, 0);
  assert.match(String(missing.stderr), /Baseline file not found/);

  const badJsonPath = path.join(f.repoDir, "bad.json");
  fs.writeFileSync(badJsonPath, "{not json");
  const badJson = f.cli(["validate", "--baseline", badJsonPath, "--json"]);
  assert.notEqual(badJson.status, 0);
  assert.match(String(badJson.stderr), /not valid JSON/);

  const wrongVersionPath = path.join(f.repoDir, "wrong-version.json");
  fs.writeFileSync(wrongVersionPath, JSON.stringify({ schemaVersion: 999, issues: [] }));
  const wrongVersion = f.cli(["validate", "--baseline", wrongVersionPath, "--json"]);
  assert.notEqual(wrongVersion.status, 0);
  assert.match(String(wrongVersion.stderr), /Unsupported baseline schemaVersion/);
});

test("validate without --task/--baseline/--write-baseline is unchanged from the pre-T-127 shape: no gate key at all", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  // The golden fixture always carries a pre-existing store error (T-102's
  // completion-acceptance-incomplete), so a plain `validate` exits non-zero
  // regardless of T-127 -- the no-gate-key contract is what is under test.
  const result = f.cli(["validate", "--json"]);
  const plain = JSON.parse(result.stdout);
  assert.ok(!("gate" in plain), JSON.stringify(plain));
});

// ---------------------------------------------------------------------------
// 5. description is Git-authored, never patchable.
// ---------------------------------------------------------------------------

test("task update --set description=x is refused, and --help documents description as Git-authored, never --set-able", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { payload } = f.refused(["task", "update", "T-101", "--set", "description=x", "--actor", "test"]);
  assert.equal(payload.reason, "unknown-field");
  assert.match(payload.message, /Git-authored `description:` block/);

  const help = f.cli(["--help"]).stdout;
  assert.match(help, /description.*Git-authored|Git-authored.*description/s);
  assert.match(help, /There is no `--set description`/);
  assert.match(help, /NOT patchable here/);
});

// ---------------------------------------------------------------------------
// 6. List parsing -- the bug that corrupted T-126. Mutation: brackets must
//    never be silently accepted again.
// ---------------------------------------------------------------------------

test("MUTATION GUARD: --set detail.filesAffected=[a,b] (unquoted bracket list) is refused and leaves the prior value intact", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.success(["task", "update", "T-101", "--set", "detail.filesAffected=x.ts", "--actor", "test"]);
  const before = f.success(["task", "show", "T-101"]).detail.filesAffected;

  const refused = f.cli(["task", "update", "T-101", "--set", "detail.filesAffected=[a,b]", "--actor", "test", "--json"]);
  assert.notEqual(refused.status, 0, "a bracket-shaped bare list must never be silently accepted again");
  assert.match(String(refused.stderr), /not valid JSON/);

  const after = f.success(["task", "show", "T-101"]).detail.filesAffected;
  assert.deepEqual(after, before, "a refused --set must not mutate the prior value");
  assert.ok(!after.some((v: string) => v.includes("[") || v.includes("]")), "brackets must never land in storage");
});

// Review A1 (blocking regression): the bracket detector used `startsWith('[')
// || endsWith(']')`, so ANY value merely ending in `]` -- a dynamic route
// segment like `app/[locale]`, the most common filesAffected entry in a web
// project -- was misrouted to the JSON branch and refused. The fix requires
// BOTH ends. This test is written so reverting `&&` back to `||` fails it.
test("MUTATION GUARD (A1): bracket-suffixed paths (dynamic route segments) store correctly; `[a,b]` is still refused", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  f.success(["task", "update", "T-101", "--set", "detail.filesAffected=app/[locale]", "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).detail.filesAffected, ["app/[locale]"]);

  f.success(["task", "update", "T-101", "--set", "detail.filesAffected=pages/[slug]", "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).detail.filesAffected, ["pages/[slug]"]);

  f.success(["task", "update", "T-101", "--set", "detail.filesAffected=[locale]/page.tsx", "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).detail.filesAffected, ["[locale]/page.tsx"]);

  f.success(["task", "update", "T-101", "--set", "detail.filesAffected=app/[locale]/page.tsx", "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).detail.filesAffected, ["app/[locale]/page.tsx"]);

  // A bare comma list where one element is bracket-suffixed stores both --
  // the suffix alone must never flip the WHOLE input into the JSON branch.
  f.success(["task", "update", "T-101", "--set", "detail.filesAffected=a,pages/[slug]", "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).detail.filesAffected, ["a", "pages/[slug]"]);

  // The bracket-array target of T-127 itself must still be refused.
  const stillRefused = f.cli(["task", "update", "T-101", "--set", "detail.filesAffected=[a,b]", "--actor", "test", "--json"]);
  assert.notEqual(stillRefused.status, 0, "the T-127 target ([a,b]) must stay refused");

  // A malformed JSON array (trailing comma) is refused too.
  const malformedArray = f.cli(["task", "update", "T-101", "--set", 'detail.filesAffected=["a",]', "--actor", "test", "--json"]);
  assert.notEqual(malformedArray.status, 0, '["a",] is not valid JSON and must be refused');

  // A well-formed JSON array is accepted.
  f.success(["task", "update", "T-101", "--set", 'detail.filesAffected=["a","b"]', "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).detail.filesAffected, ["a", "b"]);
});

// Review A2: the JSON spelling made a comma INSIDE one element reachable for
// the first time, in every list field. The generated snapshots join with
// ", " and split on ",", so such an element does not round-trip -- it comes
// back as two entries, and `reconcile --accept` would write the split value
// back into the store. Mutation: removing this check must break this test.
test("MUTATION GUARD (A2): a comma inside a list element is refused in the JSON spelling for filesAffected and externalLinks, and never round-trips through export+reconcile", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  // The CLI's parseListInput check and the store's updateTask check are two
  // independent layers (review A2 follow-up): mutating only the CLI's
  // `item.includes(',')` leaves the store's own comma guard (reason
  // comma-in-list-element) to catch the same input, which would mask the
  // CLI layer's removal if these assertions only checked "refused". Pinning
  // the CLI layer specifically requires two properties the store layer does
  // NOT have: the exact parseListInput wording (not the store's reason
  // string), and that mapctx.db is untouched -- the CLI refuses before any
  // writable store handle opens (no migration, no metadata write), while the
  // store's own refusal happens AFTER that handle is already open.
  const beforeDbStat = fs.statSync(path.join(f.storeDir(), "mapctx.db")).mtimeMs;

  const filesRefused = f.cli(["task", "update", "T-101", "--set", 'detail.filesAffected=["src/{a,b}.ts"]', "--actor", "test", "--json"]);
  assert.notEqual(filesRefused.status, 0, "a comma inside one element must be refused");
  assert.match(String(filesRefused.stderr), /contains a comma/);
  assert.ok(!/comma-in-list-element/.test(String(filesRefused.stderr)), "this must be the CLI's parseListInput refusal, not the store's reason string -- proves the CLI layer caught it, not the store layer");
  assert.deepEqual(f.success(["task", "show", "T-101"]).detail.filesAffected, [], "nothing must be stored");
  assert.equal(fs.statSync(path.join(f.storeDir(), "mapctx.db")).mtimeMs, beforeDbStat, "the CLI layer refuses before any writable store handle opens; mapctx.db must be untouched");

  const linksRefused = f.cli(["task", "update", "T-101", "--set", 'externalLinks=["https://x.test/a,b"]', "--actor", "test", "--json"]);
  assert.notEqual(linksRefused.status, 0, "a comma inside one externalLinks element must be refused");
  assert.match(String(linksRefused.stderr), /contains a comma/);
  assert.ok(!/comma-in-list-element/.test(String(linksRefused.stderr)), "this must be the CLI's parseListInput refusal, not the store's reason string");
  assert.deepEqual(f.success(["task", "show", "T-101"]).task.externalLinks, [], "nothing must be stored");
  assert.equal(fs.statSync(path.join(f.storeDir(), "mapctx.db")).mtimeMs, beforeDbStat, "mapctx.db must still be untouched after both refusals");

  // Bonus (review A2): a comma-free glob and a balanced brace group store,
  // export, and reconcile with zero drift -- the round trip this review
  // reproduced as broken must now converge.
  f.success(["task", "update", "T-101", "--set", "detail.filesAffected=src/*.ts,src/{ab}.ts", "--actor", "test"]);
  f.success(["export", "--actor", "test"]);
  const reconciled = f.success(["reconcile", "T-101"]);
  assert.equal(reconciled.diff.hasDrift, false, JSON.stringify(reconciled.diff));
});

// Review A3: `src/{a,b}.ts` still split silently into `src/{a` + `b}.ts` in
// the bare comma spelling -- the same corruption T-127 closes for brackets,
// in the same field, and exactly the brace pattern T-132 teaches the planner
// to expand. An element left with an unbalanced delimiter after the
// comma-split is refused. Mutation: `unbalancedDelimiter` always returning
// null must break this test.
test("MUTATION GUARD (A3): an unbalanced bracket/brace/paren left by the comma-split is refused; balanced groups store fine", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  for (const bad of ["src/{a,b}.ts", "[a,b].ts", "src/(a,b).ts"]) {
    const refused = f.cli(["task", "update", "T-101", "--set", `detail.filesAffected=${bad}`, "--actor", "test", "--json"]);
    assert.notEqual(refused.status, 0, `expected ${bad} to be refused`);
    assert.match(String(refused.stderr), /unbalanced/);
  }
  assert.deepEqual(f.success(["task", "show", "T-101"]).detail.filesAffected, [], "none of the refused values must land");

  for (const good of ["src/*.ts", "src/{ab}.ts", "app/[locale]"]) {
    f.success(["task", "update", "T-101", "--set", `detail.filesAffected=${good}`, "--actor", "test"]);
    assert.deepEqual(f.success(["task", "show", "T-101"]).detail.filesAffected, [good]);
  }
});

// Review A4: `externalLinks` promised "https://... or provider:entity:id" in
// help and the skill, but any opaque URL (`javascript:`, `data:`, `file:`)
// parsed and stored. The CLI-level spot check; the full matrix is in
// packages/store/src/tasks.test.ts. Mutation: removing the denylist lets
// `javascript:a:b` (the 3-part form that matches the provider shape) through.
test("MUTATION GUARD (A4): externalLinks refuses dangerous schemes (incl. the 3-part javascript:a:b) and accepts the promised shapes", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  for (const bad of ["javascript:alert(1)", "javascript:a:b", "file:///etc/passwd", "vbscript:x"]) {
    const refused = f.cli(["task", "update", "T-101", "--set", `externalLinks=${bad}`, "--actor", "test", "--json"]);
    assert.notEqual(refused.status, 0, `expected ${bad} to be refused`);
  }
  assert.deepEqual(f.success(["task", "show", "T-101"]).task.externalLinks, []);

  f.success(["task", "update", "T-101", "--set", "externalLinks=https://github.com/o/r/issues/1,github:issue:42", "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).task.externalLinks, ["https://github.com/o/r/issues/1", "github:issue:42"]);
});

test("--set detail.filesAffected=[\"a\",\"b\"] (valid JSON array) is accepted and stores unquoted, unbracketed values", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.success(["task", "update", "T-101", "--set", 'detail.filesAffected=["a","b"]', "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).detail.filesAffected, ["a", "b"]);
});

test("--set detail.filesAffected=a,b,c (bare comma list) stores all three without brackets or quotes", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.success(["task", "update", "T-101", "--set", "detail.filesAffected=a,b,c", "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).detail.filesAffected, ["a", "b", "c"]);
});

test("a fully-quoted comma element is refused; a value only containing quotes in the middle is accepted", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const fullyQuoted = f.cli(["task", "update", "T-101", "--set", 'tags="a","b"', "--actor", "test", "--json"]);
  assert.notEqual(fullyQuoted.status, 0);
  assert.match(String(fullyQuoted.stderr), /wrapped in quotes/);

  f.success(["task", "update", "T-101", "--set", 'detail.testsRequired=npm test -- --grep "foo"', "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).detail.testsRequired, ['npm test -- --grep "foo"']);
});

test("--set of a list field: =null clears, = (empty) yields an empty list", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.success(["task", "update", "T-101", "--set", "detail.filesAffected=a,b", "--actor", "test"]);
  f.success(["task", "update", "T-101", "--set", "detail.filesAffected=null", "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).detail.filesAffected, []);
  f.success(["task", "update", "T-101", "--set", "detail.filesAffected=a,b", "--actor", "test"]);
  f.success(["task", "update", "T-101", "--set", "detail.filesAffected=", "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).detail.filesAffected, []);
});

test("task create --tags/--domains/--depends-on/--blocking reject a bracketed list the same way, before any store is opened", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const refused = f.cli(["task", "create", "--title", "mutation guard", "--tags", "[a,b]", "--actor", "test", "--json"]);
  assert.notEqual(refused.status, 0);
  assert.match(String(refused.stderr), /not valid JSON/);

  const created = f.success(["task", "create", "--title", "list syntax ok", "--tags", '["x","y"]', "--domains", "CORE,DOCS", "--depends-on", "T-101", "--actor", "test"]);
  const shown = f.success(["task", "show", created.taskId]);
  assert.deepEqual(shown.task.tags, ["x", "y"]);
  assert.deepEqual(shown.task.domains, ["CORE", "DOCS"]);
});

test("task update --depends-on/--blocking reject a bracketed list before the writable store opens, and accept both spellings", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const refused = f.cli(["task", "update", "T-101", "--depends-on", "[T-102]", "--actor", "test", "--json"]);
  assert.notEqual(refused.status, 0);
  assert.match(String(refused.stderr), /not valid JSON/);

  f.success(["task", "update", "T-101", "--blocking", '["T-102"]', "--actor", "test"]);
  assert.deepEqual(f.success(["task", "show", "T-101"]).detail.blocking, ["T-102"]);
});

test("list syntax refusals happen before the writable store opens: no event is journaled for a refused task update", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const before = f.read(handle => require("@mapctx/store").getTask(handle.db, "T-101"));
  const beforeStat = fs.statSync(path.join(f.storeDir(), "mapctx.db")).mtimeMs;
  const refused = f.cli(["task", "update", "T-101", "--set", "detail.filesAffected=[a,b]", "--actor", "test", "--json"]);
  assert.notEqual(refused.status, 0);
  const after = f.read(handle => require("@mapctx/store").getTask(handle.db, "T-101"));
  assert.deepEqual(after, before, "a syntax refusal must never reach the journal");
  assert.equal(fs.statSync(path.join(f.storeDir(), "mapctx.db")).mtimeMs, beforeStat, "mapctx.db must be untouched by a syntax refusal");
});

// ---------------------------------------------------------------------------
// 7. Extras: --expect-revision hint, stdout/stderr under --json, reports vs.
//    refusals (`store repair`, `import --dry-run`).
// ---------------------------------------------------------------------------

// Review A8: a test of this name used to run only `approve` twice, so the
// reviewer's mutation of the `revise` guard (`options.expectRevision ===
// undefined` -> `=== -1`) passed 39/39 unnoticed. All THREE verbs are
// exercised here without --expect-revision, each asserting both branches of
// the hint (no revision yet -> "pass --expect-revision 0"; a revision N ->
// "revision N"). Mutating either branch's guard in either verb must break
// this test.
test("acceptance revise, approve, AND unapprove each refuse without --expect-revision, naming the store's current revision or 0 when none exists yet", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  // revise: no revision exists yet for T-101.
  fs.writeFileSync(path.join(f.repoDir, "acceptance.md"), "## Acceptance\n- [ ] one\n- [ ] two\n");
  const reviseNoRevision = f.cli(["task", "acceptance", "revise", "T-101", "--from-file", "acceptance.md", "--actor", "test", "--json"]);
  assert.notEqual(reviseNoRevision.status, 0);
  assert.match(String(reviseNoRevision.stderr), /No acceptance revision exists for T-101 yet: pass --expect-revision 0/);

  // approve: still no revision exists yet.
  const approveNoRevision = f.cli(["task", "acceptance", "approve", "T-101", "--index", "0", "--actor", "test", "--json"]);
  assert.notEqual(approveNoRevision.status, 0);
  assert.match(String(approveNoRevision.stderr), /No acceptance revision exists for T-101 yet: pass --expect-revision 0/);

  // unapprove: still no revision exists yet.
  const unapproveNoRevision = f.cli(["task", "acceptance", "unapprove", "T-101", "--index", "0", "--actor", "test", "--json"]);
  assert.notEqual(unapproveNoRevision.status, 0);
  assert.match(String(unapproveNoRevision.stderr), /No acceptance revision exists for T-101 yet: pass --expect-revision 0/);

  // Now actually author a revision (with the flag, so this itself succeeds).
  const revised = f.success(["task", "acceptance", "revise", "T-101", "--from-file", "acceptance.md", "--expect-revision", "0", "--actor", "test"]);
  const revision = revised.revision;
  assert.ok(revision >= 1);
  const revisionHint = new RegExp(`The store currently holds revision ${revision} for T-101: pass --expect-revision ${revision}\\.`);

  // All three verbs again, now WITH an existing revision -- each must name it.
  fs.writeFileSync(path.join(f.repoDir, "acceptance2.md"), "## Acceptance\n- [ ] one\n- [ ] two\n- [ ] three\n");
  const reviseWithRevision = f.cli(["task", "acceptance", "revise", "T-101", "--from-file", "acceptance2.md", "--actor", "test", "--json"]);
  assert.notEqual(reviseWithRevision.status, 0);
  assert.match(String(reviseWithRevision.stderr), revisionHint);

  const approveWithRevision = f.cli(["task", "acceptance", "approve", "T-101", "--index", "0", "--actor", "test", "--json"]);
  assert.notEqual(approveWithRevision.status, 0);
  assert.match(String(approveWithRevision.stderr), revisionHint);

  const unapproveWithRevision = f.cli(["task", "acceptance", "unapprove", "T-101", "--index", "0", "--actor", "test", "--json"]);
  assert.notEqual(unapproveWithRevision.status, 0);
  assert.match(String(unapproveWithRevision.stderr), revisionHint);
});

test("task move with an illegal transition keeps stdout empty and puts the structured payload first on stderr, then Error:", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { payload, stderr } = f.refused(["task", "move", "T-101", "--status", "not-a-status", "--actor", "test"]);
  assert.equal(payload.ok, false);
  assert.match(stderr, /Error: Move refused:/);
});

test("import --dry-run keeps printing the plan on stdout even when it exits non-zero: a plan with errors is a report, not a refusal", t => {
  const f = fixture(t);
  // The pre-cutover legacy config check runs independently of the plan and
  // would otherwise mask this scenario (the golden fixture's legacy config
  // is deliberately incomplete for a different test's purposes); remove it
  // so the only failure in play is the corrupted type this test introduces.
  fs.unlinkSync(path.join(f.repoDir, "mapcs.config.json"));
  const tasksPath = path.join(f.repoDir, "TASKS.md");
  const original = fs.readFileSync(tasksPath, "utf8");
  assert.ok(original.includes("  - type: epic"), "fixture shape changed; update this test's replacement");
  fs.writeFileSync(tasksPath, original.replace("  - type: epic", "  - type: not-a-real-type"));

  const dryRun = f.cli(["import", "--dry-run", "--json"]);
  assert.notEqual(dryRun.status, 0, "a plan with errors must fail the command");
  assert.notEqual(String(dryRun.stdout).trim(), "", "the plan is the deliverable and must stay on stdout even on failure");
  const plan = JSON.parse(dryRun.stdout);
  assert.ok(plan.plan.errors > 0, JSON.stringify(plan.plan));
  assert.match(String(dryRun.stderr), /Error: Import validation failed/);
});

test("store repair keeps printing the gap report on stdout even when it exits non-zero: a gap is a report, not a refusal", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  // Force a mid-history gap by deleting a journal entry and corrupting
  // mapctx.db, same technique as packages/store/src/repair.test.ts.
  const storeDir = f.storeDir();
  const nodeId = f.read(handle => handle.nodeId);
  const dbPath = path.join(storeDir, "mapctx.db");
  const eventsDir = path.join(storeDir, "events", nodeId);
  const sequences = fs.readdirSync(eventsDir).map(name => Number(name.replace(".json", ""))).sort((a, b) => a - b);
  const midSequence = sequences[Math.floor(sequences.length / 2)];
  fs.unlinkSync(path.join(eventsDir, `${midSequence}.json`));
  fs.writeFileSync(dbPath, "CORRUPT");

  const repair = f.cli(["store", "repair", "--json"]);
  assert.notEqual(repair.status, 0, "a journal gap must fail the command");
  assert.notEqual(String(repair.stdout).trim(), "", "the gap report is the deliverable and must stay on stdout even on failure");
  const report = JSON.parse(repair.stdout);
  assert.equal(report.status, "gap");
  assert.match(String(repair.stderr), /Repair aborted/);
});

// ---------------------------------------------------------------------------
// 8. Review A5: every value-taking flag refuses when the next token is
//    missing or is itself another flag, instead of silently swallowing it.
//    The worst case journaled an event attributed to actor "--json".
// ---------------------------------------------------------------------------

test("MUTATION GUARD (A5): --actor with no value refuses instead of journaling an event attributed to actor \"--json\"", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const before = f.read(handle => require("@mapctx/store").getTask(handle.db, "T-101"));

  const result = f.cli(["task", "update", "T-101", "--set", "detail.summary=x", "--actor", "--json"]);
  assert.notEqual(result.status, 0, "--actor with no value (the next token is --json) must refuse");
  assert.match(String(result.stderr), /--actor is missing its value/);

  const after = f.read(handle => require("@mapctx/store").getTask(handle.db, "T-101"));
  assert.deepEqual(after, before, "a refused parse must never reach the journal");
});

test("MUTATION GUARD (A5): --title, --tags, --reason and the validate gate flags all refuse when their value is missing", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  const cases: Array<{ args: string[]; flag: string }> = [
    { args: ["task", "create", "--title", "--json"], flag: "--title" },
    { args: ["task", "create", "--title", "ok", "--tags", "--json"], flag: "--tags" },
    { args: ["export", "--reason", "--json"], flag: "--reason" },
    { args: ["validate", "--task", "--json"], flag: "--task" },
    { args: ["validate", "--baseline", "--json"], flag: "--baseline" }
  ];
  for (const { args, flag } of cases) {
    const result = f.cli([...args, "--json"]);
    assert.notEqual(result.status, 0, `${flag}: expected a refusal, got exit ${result.status} stdout=${result.stdout}`);
    assert.match(String(result.stderr), /is missing its value/, `${flag}: ${result.stderr}`);
  }

  // No task must have been created by the --title case above.
  const board = f.success(["task", "show", "T-101"]);
  assert.ok(board.task, "sanity: T-101 must still be readable");
});

test("a legitimate single-dash value still passes: --set 'detail.summary=- item one' stores the dash-prefixed text", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.success(["task", "update", "T-101", "--set", "detail.summary=- item one", "--actor", "test"]);
  assert.equal(f.success(["task", "show", "T-101"]).detail.summary, "- item one");
});

// ---------------------------------------------------------------------------
// 9. Review A9/A10: refusal payload only under --json (never in human mode,
//    because it can embed a holder's leaseToken); one compact JSON line.
// ---------------------------------------------------------------------------

test("MUTATION GUARD (A9): a refusal in human mode (no --json) prints only the Error: line -- no JSON payload at all", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { stderr } = f.refusedHuman(["task", "move", "T-101", "--status", "not-a-status", "--actor", "test"]);
  assert.match(stderr, /^Error: Move refused:/);
});

test("a refusal with --json is exactly 2 stderr lines: one compact JSON line, then Error:", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const { stderr } = f.refused(["task", "update", "T-101", "--set", "nope=1", "--actor", "test"]);
  const lines = stderr.split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.doesNotThrow(() => JSON.parse(lines[0]), "stderr's first line alone must be parseable JSON");
  assert.ok(!lines[0].includes("\n"), "the payload line must be compact (single line), not pretty-printed");
});

// ---------------------------------------------------------------------------
// 10. Review A11: staleBaseline entries carry a cause -- out-of-scope
//     (excluded by --task, still valid for the board) vs not-reported (gone).
// ---------------------------------------------------------------------------

test("staleBaseline distinguishes out-of-scope (excluded by --task) from not-reported (issue actually gone)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  f.success(["task", "update", "T-102", "--set", "domains=NOPE", "--actor", "test"]);
  const baselinePath = path.join(f.repoDir, "baseline.json");
  // Write a whole-board baseline, which records the T-102 domains issue.
  f.success(["validate", "--write-baseline", baselinePath]);

  // out-of-scope: narrow to --task T-101, so the T-102 entry matches nothing
  // IN SCOPE, but the issue it describes is still reported for the board.
  const scoped = f.success(["validate", "--baseline", baselinePath, "--task", "T-101"]);
  const outOfScope = scoped.gate.staleBaseline.find((e: { taskId: string | null }) => e.taskId === "T-102");
  assert.ok(outOfScope, JSON.stringify(scoped.gate.staleBaseline));
  assert.equal(outOfScope.cause, "out-of-scope");

  // not-reported: fix the domains issue so it is genuinely gone from the board.
  f.success(["task", "update", "T-102", "--set", "domains=CORE", "--actor", "test"]);
  const fixed = f.success(["validate", "--baseline", baselinePath]);
  const notReported = fixed.gate.staleBaseline.find((e: { code: string }) => e.code === "invalid-domain");
  assert.ok(notReported, JSON.stringify(fixed.gate.staleBaseline));
  assert.equal(notReported.cause, "not-reported");
});

// ---------------------------------------------------------------------------
// 11. Review A12: --write-baseline is temp + rename -- the final file is
//     valid JSON and no *.tmp sibling is left behind.
// ---------------------------------------------------------------------------

test("--write-baseline writes temp+rename: the final file is valid JSON and no *.tmp file is left in the directory", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const baselinePath = path.join(f.repoDir, "baseline.json");
  f.success(["validate", "--write-baseline", baselinePath]);

  assert.ok(fs.existsSync(baselinePath));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(baselinePath, "utf8")));
  const leftoverTmp = fs.readdirSync(f.repoDir).filter(name => name.includes(".tmp"));
  assert.deepEqual(leftoverTmp, [], `no *.tmp file must survive a write-baseline: ${JSON.stringify(leftoverTmp)}`);
});

// ---------------------------------------------------------------------------
// 12. Review A13: --reason (export) lists ALL CheckpointReason values, read
//     off CHECKPOINT_REASONS -- not a hand-retyped subset.
// ---------------------------------------------------------------------------

test("the Enumerated values table's --reason (export) row matches CHECKPOINT_REASONS exactly, including task-end; export --reason task-end is accepted", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  const out = f.cli(["--help"]).stdout;
  assertEnumLine(out, "--reason (export)", CHECKPOINT_REASONS.join("|"));
  assert.ok(CHECKPOINT_REASONS.includes("task-end" as never), "sanity: task-end must be a real CheckpointReason");

  const exported = f.success(["export", "--reason", "task-end", "--actor", "test"]);
  assert.equal(exported.reason, "task-end");
});
