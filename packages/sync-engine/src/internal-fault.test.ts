import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as path from "path"
import test, { type TestContext } from "node:test"
import { writeCliError } from "./mapctx-cli"

/**
 * T-162: `writeCliError` now prints a stack for an internal fault
 * (TypeError/ReferenceError), and ONLY for one -- never for a refusal
 * (CliRefusal or a plain operator-facing Error). The stdout/stderr contract
 * the refusal tests pin elsewhere (T-127 review A10's two-line `--json`
 * shape, the human-mode single line, T-134's leaseToken redaction) describes
 * REFUSALS; this file pins that an internal fault is deliberately not one,
 * without touching those other suites.
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
  return { ...f, cli, success };
}

// ---------------------------------------------------------------------------
// (a) + (b): a genuine refusal (not an internal fault) must still print
// exactly the pre-T-162 shape, in both modes, with no stack line mixed in.
// ---------------------------------------------------------------------------

test("T-162 regression: a --json refusal is still exactly 2 stderr lines, no stack, first line parseable", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const result = f.cli(["task", "update", "T-101", "--set", "nope=1", "--actor", "test", "--json"]);
  assert.notEqual(result.status, 0);
  assert.equal(String(result.stdout).trim(), "", "stdout is the result channel; a refusal is not a result");
  const stderr = String(result.stderr);
  const lines = stderr.split("\n").filter(line => line.length > 0);
  assert.equal(lines.length, 2, `expected exactly 2 non-empty stderr lines, got: ${JSON.stringify(lines)}`);
  assert.doesNotThrow(() => JSON.parse(lines[0]), "stderr's first line alone must be parseable JSON");
  assert.match(lines[1], /^Error: /);
  assert.ok(!stderr.includes("\n    at "), `a refusal must never carry a stack frame: ${stderr}`);
});

test("T-162 regression: a human-mode refusal still prints only the Error: line, no stack", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const result = f.cli(["task", "move", "T-101", "--status", "not-a-status", "--actor", "test"]);
  assert.notEqual(result.status, 0);
  const stderr = String(result.stderr);
  assert.equal(String(result.stdout).trim(), "");
  assert.match(stderr, /^Error: Move refused:/);
  const lines = stderr.split("\n").filter(line => line.length > 0);
  assert.equal(lines.length, 1, `expected exactly 1 non-empty stderr line, got: ${JSON.stringify(lines)}`);
  assert.ok(!stderr.includes("\n    at "), `a refusal must never carry a stack frame: ${stderr}`);
});

// ---------------------------------------------------------------------------
// (c): writeCliError called directly for an internal fault. Deliberately a
// unit call rather than hunting a CLI path that happens to throw a
// TypeError/ReferenceError -- the production code has none left to find
// (that search is what this task's source commit records), and a direct call
// is the honest way to pin the function's own contract.
// ---------------------------------------------------------------------------

/** Captures both channels writeCliError can use, in call order. */
function captureWrites(run: () => void): string[] {
  const originalConsoleError = console.error;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const calls: string[] = [];
  console.error = (...args: unknown[]) => { calls.push(args.map(String).join(" ")); };
  process.stderr.write = ((chunk: string) => { calls.push(String(chunk).replace(/\n$/, "")); return true; }) as typeof process.stderr.write;
  try { run(); } finally { console.error = originalConsoleError; process.stderr.write = originalStderrWrite; }
  return calls;
}

test("writeCliError(TypeError, false) prints the Error: line AND the stack", () => {
  const calls = captureWrites(() => writeCliError(new TypeError("boom"), false));
  assert.equal(calls.length, 2, JSON.stringify(calls));
  assert.equal(calls[0], "Error: boom");
  assert.ok(calls[1].startsWith("TypeError: boom"), calls[1]);
  assert.match(calls[1], /\n\s+at /, "the stack call must carry at least one stack frame");
});

test("writeCliError(ReferenceError, true) prints the JSON envelope line, the Error: line, AND the stack", () => {
  const calls = captureWrites(() => writeCliError(new ReferenceError("x is not defined"), true));
  assert.equal(calls.length, 3, JSON.stringify(calls));
  assert.deepEqual(JSON.parse(calls[0]), { ok: false, error: "x is not defined" });
  assert.equal(calls[1], "Error: x is not defined");
  assert.ok(calls[2].startsWith("ReferenceError: x is not defined"), calls[2]);
  assert.match(calls[2], /\n\s+at /);
});

test("writeCliError(plain Error, false) never prints a stack: only TypeError/ReferenceError are internal faults", () => {
  const calls = captureWrites(() => writeCliError(new Error("an operator-facing refusal sentence"), false));
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0], "Error: an operator-facing refusal sentence");
});
