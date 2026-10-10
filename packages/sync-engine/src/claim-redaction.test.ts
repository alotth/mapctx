import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as path from "path"
import test, { type TestContext } from "node:test"
import { LEASE_TOKEN_BYTES, LEASE_TOKEN_PATTERN } from "@mapctx/store"
import { renderHolder } from "./mapctx-cli"

// T-134 (C0/D1): a refused claim must never disclose the holder's leaseToken
// -- the bearer credential for `task renew`/`task release` -- in either
// output mode, while staying actionable (claimId, holder, expiresAt). Same
// golden-repo + isolated MAPCTX_HOME fixture as privacy-cli.test.ts /
// cli-quickwins.test.ts.
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

/**
 * The golden fixture's T-101/T-102 are not freely claimable (T-102 is
 * terminal; T-101 lacks workload/estimatedEffort), so every test here claims
 * a freshly created, clean executable task instead.
 */
function createClaimableTask(f: ReturnType<typeof fixture>, title: string): string {
  const created = f.success(["task", "create", "--title", title, "--workload", "Normal", "--effort", "1h", "--actor", "test"]);
  return created.taskId;
}

// Sanity: the pattern this suite relies on is derived from the generator,
// not a hardcoded width. If a future change widens or narrows the token and
// forgets to update the pattern's derivation, THIS assertion catches it
// before the redaction scan below silently stops matching anything.
test("sanity: LEASE_TOKEN_PATTERN is derived from LEASE_TOKEN_BYTES (hex, 2 chars/byte), not a hardcoded width", () => {
  assert.equal(LEASE_TOKEN_BYTES, 24);
  assert.ok(LEASE_TOKEN_PATTERN.source.includes(`{${LEASE_TOKEN_BYTES * 2}}`), LEASE_TOKEN_PATTERN.source);
  assert.match("a".repeat(LEASE_TOKEN_BYTES * 2), LEASE_TOKEN_PATTERN);
  assert.ok(!LEASE_TOKEN_PATTERN.test("a".repeat(LEASE_TOKEN_BYTES * 2 - 1) /* one short */));
});

test("MUTATION GUARD: task claim against a held task never discloses the holder's leaseToken, in --json or human mode, and stays actionable", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "claim redaction target");

  const holderA = f.success(["task", "claim", taskId, "--holder", '{"agent":"A"}', "--actor", "holder-a"]);
  assert.equal(holderA.ok, true);
  const realToken: string = holderA.claim.leaseToken;
  assert.match(realToken, LEASE_TOKEN_PATTERN);

  const attempts: Array<{ label: string; args: string[] }> = [
    { label: "claim --json", args: ["task", "claim", taskId, "--holder", '{"agent":"B"}', "--actor", "holder-b", "--json"] },
    { label: "claim human", args: ["task", "claim", taskId, "--holder", '{"agent":"B"}', "--actor", "holder-b"] },
    { label: "start --json", args: ["task", "start", taskId, "--holder", '{"agent":"B"}', "--actor", "holder-b", "--json"] },
    { label: "start human", args: ["task", "start", taskId, "--holder", '{"agent":"B"}', "--actor", "holder-b"] }
  ];

  for (const { label, args } of attempts) {
    const result = f.cli(args);
    assert.notEqual(result.status, 0, `${label}: expected the refusal (task is already held)`);
    const stdout = String(result.stdout);
    const stderr = String(result.stderr);
    const combined = stdout + stderr;

    assert.ok(!combined.includes(realToken), `${label}: the exact holder token leaked:\n${combined}`);
    // Generic regression scan (criterion 2): ANY token-shaped value, not just
    // the one we happen to know -- catches a NEW leak with a different value,
    // e.g. from a future secret field reusing the same hex-24-byte shape.
    assert.ok(!LEASE_TOKEN_PATTERN.test(combined), `${label}: a token-shaped value appeared in output:\n${combined}`);

    assert.ok(combined.includes("claimId") || /claim [0-9a-f-]{36}/.test(combined), `${label}: claimId must survive: ${combined}`);
    // Review F2: human mode no longer echoes raw JSON (`"agent":"A"`); it
    // renders only identity-shaped fields via renderHolder(), e.g. `agent=A`.
    // --json's activeClaim.holder is untouched (the structured channel), so
    // either spelling counts as "holder survived".
    assert.ok(combined.includes("holder") || combined.includes("agent=A") || combined.includes('"agent":"A"'), `${label}: holder must survive: ${combined}`);
    assert.ok(combined.includes("expiresAt") || /expires \S/.test(combined), `${label}: expiresAt must survive: ${combined}`);
  }
});

test("--json refusal's activeClaim has exactly the 8 allowlisted keys and no leaseToken (pins a new secret field leaking through the allowlist)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "allowlist shape target");
  f.success(["task", "claim", taskId, "--holder", '{"agent":"A"}', "--actor", "holder-a"]);

  const refused = f.cli(["task", "claim", taskId, "--holder", '{"agent":"B"}', "--actor", "holder-b", "--json"]);
  assert.notEqual(refused.status, 0);
  const stderr = String(refused.stderr);
  const boundary = stderr.indexOf("\nError:");
  assert.ok(boundary > 0, stderr);
  const payload = JSON.parse(stderr.slice(0, boundary));
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, "active-claim-held");
  assert.ok(payload.activeClaim, JSON.stringify(payload));
  assert.deepEqual(
    Object.keys(payload.activeClaim).sort(),
    ["claimId", "claimedAt", "eventNode", "eventSequence", "expiresAt", "holder", "state", "taskId"].sort()
  );
  assert.equal("leaseToken" in payload.activeClaim, false);
});

test("criterion 3: the holder still gets its own leaseToken from claim/start/renew; release works; a wrong token is token-mismatch", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  const claimedTaskId = createClaimableTask(f, "holder round trip: claim");
  const claimed = f.success(["task", "claim", claimedTaskId, "--holder", '{"agent":"A"}', "--actor", "holder-a"]);
  assert.equal(claimed.ok, true);
  assert.match(claimed.claim.leaseToken, LEASE_TOKEN_PATTERN);

  const startedTaskId = createClaimableTask(f, "holder round trip: start");
  const started = f.success(["task", "start", startedTaskId, "--holder", '{"agent":"A"}', "--actor", "holder-a"]);
  assert.equal(started.ok, true);
  assert.match(started.claim.leaseToken, LEASE_TOKEN_PATTERN);

  const renewed = f.success(["task", "renew", claimedTaskId, "--claim", claimed.claim.claimId, "--token", claimed.claim.leaseToken, "--actor", "holder-a"]);
  assert.equal(renewed.ok, true);
  assert.match(renewed.claim.leaseToken, LEASE_TOKEN_PATTERN);
  assert.equal(renewed.claim.claimId, claimed.claim.claimId);

  const wrongToken = f.cli(["task", "renew", claimedTaskId, "--claim", claimed.claim.claimId, "--token", "0".repeat(LEASE_TOKEN_BYTES * 2), "--actor", "holder-a", "--json"]);
  assert.notEqual(wrongToken.status, 0);
  assert.match(String(wrongToken.stderr), /token-mismatch/);

  const released = f.success(["task", "release", claimedTaskId, "--claim", claimed.claim.claimId, "--token", claimed.claim.leaseToken, "--actor", "holder-a"]);
  assert.equal(released.ok, true);

  // Released, so a new claimant succeeds cleanly.
  const reclaimed = f.success(["task", "claim", claimedTaskId, "--holder", '{"agent":"C"}', "--actor", "holder-c"]);
  assert.equal(reclaimed.ok, true);
});

test("criterion 4: CHANGELOG's 0.4.0 (Unreleased) section has a security entry for the claim leaseToken redaction", () => {
  const fs = require("fs") as typeof import("fs");
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const sectionStart = changelog.indexOf("## mapctx CLI — [0.4.0] (Unreleased)");
  assert.ok(sectionStart >= 0, "0.4.0 (Unreleased) section must exist");
  const nextSection = changelog.indexOf("\n## ", sectionStart + 1);
  const section = changelog.slice(sectionStart, nextSection === -1 ? undefined : nextSection);
  assert.match(section, /\*\*security:\*\*/);
  assert.match(section, /leaseToken/);
});

// ---------------------------------------------------------------------------
// Review F2: `activeClaimSuffix`'s human-mode render of the holder must stay
// bounded and identity-only -- no default pid/host, no secret-looking field
// from an oversized holder, and no raw `{` reaching stderr in human mode.
// ---------------------------------------------------------------------------

test("renderHolder(): unit-level edge cases (empty, unidentified, clipping, total cap, brace/newline stripping)", () => {
  assert.equal(renderHolder(undefined), "an unidentified holder");
  assert.equal(renderHolder({}), "an unidentified holder");

  // Fields present but none of them identity-shaped: counted, not echoed.
  assert.equal(renderHolder({ pid: 123, host: "box" }), "an unidentified holder (2 field(s))");

  // A single identity key.
  assert.equal(renderHolder({ agent: "alice" }), "agent=alice");

  // Clipping: a value over HOLDER_VALUE_LIMIT (40) is cut with an ellipsis.
  const longValue = "x".repeat(100);
  const clipped = renderHolder({ agent: longValue });
  assert.ok(clipped.startsWith("agent="));
  const clippedValue = clipped.slice("agent=".length);
  assert.ok(clippedValue.length <= 41, `expected <=41 chars (40 + ellipsis), got ${clippedValue.length}: ${clippedValue}`);
  assert.ok(clippedValue.endsWith("…"));

  // Braces and newlines are stripped from a value even when short.
  assert.ok(!renderHolder({ agent: "a{b}c\nd" }).includes("{"));
  assert.ok(!renderHolder({ agent: "a{b}c\nd" }).includes("}"));
  assert.ok(!renderHolder({ agent: "a{b}c\nd" }).includes("\n"));

  // Total render cap (100), with multiple identity fields.
  const many = renderHolder({ provider: "x".repeat(40), agent: "y".repeat(40), actor: "z".repeat(40) });
  assert.ok(many.length <= 101, `expected <=101 chars (100 + ellipsis), got ${many.length}`);
  assert.ok(many.endsWith("…"));

  // pid/host are never identity keys, even alongside a real identity field.
  const mixed = renderHolder({ pid: 999, host: "evil.internal", agent: "bob" });
  assert.equal(mixed, "agent=bob");
  assert.ok(!mixed.includes("999"));
  assert.ok(!mixed.includes("evil.internal"));
});

test("MUTATION GUARD (F2): default holder ({pid,host}) renders as unidentified, with no hostname, no pid, and no brace in human mode", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "default holder target");

  // No --holder: taskClaimCommand defaults to { pid: process.pid, host: os.hostname() }.
  const first = f.cli(["task", "claim", taskId, "--actor", "holder-a"]);
  assert.equal(first.status, 0, String(first.stderr));

  const refused = f.cli(["task", "claim", taskId, "--holder", '{"agent":"B"}', "--actor", "holder-b"]);
  assert.notEqual(refused.status, 0);
  const stderr = String(refused.stderr);
  assert.match(stderr, /held by an unidentified holder \(2 field\(s\)\)/);
  assert.ok(!stderr.includes(String(process.pid)), `must not disclose the first claimer's pid: ${stderr}`);
  assert.ok(!/[A-Za-z0-9-]+\.(local|lan|internal)|held by \{/.test(stderr), `must not disclose a hostname shape: ${stderr}`);
  assert.ok(!stderr.includes("{"), `human mode must never carry a raw brace: ${stderr}`);
});

test("MUTATION GUARD (F2): an oversized holder with a secret-looking field renders only the identity key, clipped, under the total cap", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "oversized holder target");

  const bigNote = "x".repeat(300);
  const holder = JSON.stringify({ note: bigNote, secret: "hunter2", agent: "alice" });
  f.success(["task", "claim", taskId, "--holder", holder, "--actor", "holder-a"]);

  const refused = f.cli(["task", "claim", taskId, "--holder", '{"agent":"B"}', "--actor", "holder-b"]);
  assert.notEqual(refused.status, 0);
  const stderr = String(refused.stderr);
  assert.ok(!stderr.includes("hunter2"), `the secret-looking field must never reach stderr: ${stderr}`);
  assert.ok(!stderr.includes("x".repeat(50)), `the oversized note must never reach stderr intact: ${stderr}`);
  assert.ok(!stderr.includes("{"), `human mode must never carry a raw brace: ${stderr}`);
  assert.match(stderr, /held by agent=alice,/, stderr);
  const line = stderr.split("\n")[0];
  assert.ok(line.length < 200, `expected a bounded Error: line, got ${line.length} chars: ${line}`);
});

test("a Traycer-style holder ({provider, epic}) still identifies the claim in human mode", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);
  const taskId = createClaimableTask(f, "traycer holder target");

  const epicId = "e8873251-f6f0-490d-be16-8e5655300237";
  f.success(["task", "claim", taskId, "--holder", JSON.stringify({ provider: "traycer", epic: epicId }), "--actor", "holder-a"]);

  const refused = f.cli(["task", "claim", taskId, "--holder", '{"agent":"B"}', "--actor", "holder-b"]);
  assert.notEqual(refused.status, 0);
  const stderr = String(refused.stderr);
  assert.match(stderr, /provider=traycer/);
  assert.match(stderr, new RegExp(`epic=${epicId.slice(0, 40)}`));
});

test("channel convention: human-mode claim and start refusals never carry a raw `{` (CliRefusal payload stays off stderr without --json)", t => {
  const f = fixture(t);
  f.success(["import", "--commit", "--actor", "test"]);

  const claimTaskId = createClaimableTask(f, "channel convention: claim");
  f.success(["task", "claim", claimTaskId, "--holder", '{"agent":"A"}', "--actor", "holder-a"]);
  const claimRefused = f.cli(["task", "claim", claimTaskId, "--holder", '{"agent":"B"}', "--actor", "holder-b"]);
  assert.notEqual(claimRefused.status, 0);
  assert.equal(String(claimRefused.stdout).trim(), "");
  assert.ok(!String(claimRefused.stderr).includes("{"), `claim human mode: ${claimRefused.stderr}`);

  const startTaskId = createClaimableTask(f, "channel convention: start");
  f.success(["task", "start", startTaskId, "--holder", '{"agent":"A"}', "--actor", "holder-a"]);
  const startRefused = f.cli(["task", "start", startTaskId, "--holder", '{"agent":"B"}', "--actor", "holder-b"]);
  assert.notEqual(startRefused.status, 0);
  assert.equal(String(startRefused.stdout).trim(), "");
  assert.ok(!String(startRefused.stderr).includes("{"), `start human mode: ${startRefused.stderr}`);
});
