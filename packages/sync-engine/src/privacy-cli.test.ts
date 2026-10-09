import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as fs from "fs"
import * as path from "path"
import test, { type TestContext } from "node:test"
import {
  getAcceptance, getTask, getTaskDetail, getRunReceipt, listRedactions,
  readMapctxToml, resolveProjectStoreDir, StoreHandle
} from "@mapctx/store"

// Reuse the store's golden repo + isolated MAPCTX_HOME fixture. Its internal
// helpers are deliberately not part of the public package export surface.
const { setupGoldenRepo, cleanupDir } = require(path.join(path.dirname(require.resolve("@mapctx/store")), "__test-helpers__.js")) as {
  setupGoldenRepo: () => { repoDir: string; mapctxHome: string; restoreEnv: () => void };
  cleanupDir: (dir: string) => void;
};

const SECRET = "cust-ctx-9f31a778421"
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
  success(["import", "--commit", "--actor", "test"]);
  const tomlPath = path.join(f.repoDir, "mapctx.toml");
  fs.appendFileSync(tomlPath, "\n[privacy]\npatterns = ['cust-ctx-[0-9a-f]+', '(']\n");
  const storeDir = resolveProjectStoreDir(readMapctxToml(tomlPath).projectId);
  const read = <T>(fn: (handle: StoreHandle) => T): T => {
    const handle = StoreHandle.openReadOnly(storeDir);
    try { return fn(handle); } finally { handle.close(); }
  };
  const approvalRevision = () => {
    const current = success(["task", "acceptance", "show", "T-101"]).acceptance.revision ?? 0;
    fs.writeFileSync(path.join(f.repoDir, "acceptance.md"), "## Acceptance\n- [ ] Privacy CLI fixture criterion.\n");
    return success(["task", "acceptance", "revise", "T-101", "--from-file", "acceptance.md", "--expect-revision", String(current), "--actor", "test"]).revision;
  };
  return { ...f, cli, success, storeDir, read, approvalRevision };
}

function assertAdvisory(result: ReturnType<typeof spawnSync>, operation: string, field: string): void {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.signal, null);
  const stderr = String(result.stderr);
  assert.ok(stderr.includes(`privacy: ${operation} field "${field}"`), stderr);
  assert.match(stderr, /Not blocked/);
  assert.match(stderr, /starts "cu…"/);
  assert.match(stderr, /patterns\[1\] is not a valid regex.*it was skipped/);
  assert.ok(!stderr.includes(SECRET), "stderr must never echo full match");
  const stdout = String(result.stdout);
  assert.ok(!stdout.includes("privacy:"), "warnings must stay off JSON stdout");
  assert.ok(JSON.parse(stdout).ok, "operation must succeed with parseable JSON");
}

test("privacy CLI task create warns on stderr without blocking or corrupting JSON stdout", t => {
  const f = fixture(t);
  const title = `Handle ${SECRET}`;
  const result = f.cli(["task", "create", "--title", title, "--summary", "fixture", "--actor", "test", "--json"]);
  assertAdvisory(result, "task create", "title");
  const created = JSON.parse(result.stdout);
  f.read(handle => assert.equal(getTask(handle.db, created.taskId)!.title, `[${created.taskId}] ${title}`));
});

test("privacy CLI task update warns but still persists matching detail text", t => {
  const f = fixture(t);
  const result = f.cli(["task", "update", "T-101", "--set", `detail.summary=Ticket ${SECRET}`, "--actor", "test", "--json"]);
  assertAdvisory(result, "task update T-101", "detail.summary");
  f.read(handle => assert.equal(getTaskDetail(handle.db, "T-101")!.summary, `Ticket ${SECRET}`));
});

test("privacy CLI acceptance approve --evidence warns but still records approval evidence", t => {
  const f = fixture(t);
  const revision = f.approvalRevision();
  const result = f.cli(["task", "acceptance", "approve", "T-101", "--index", "0", "--expect-revision", String(revision),
    "--evidence", `customer=${SECRET}`, "--actor", "test", "--json"]);
  assertAdvisory(result, "acceptance approve T-101", "evidence.customer");
  f.read(handle => {
    const criterion = getAcceptance(handle.db, "T-101")!.criteria[0];
    assert.equal(criterion.state, "approved");
    assert.deepEqual(criterion.evidence, { customer: SECRET });
  });
});

test("privacy CLI dispatch receipt warns but still accepts schema-valid ArtifactRef evidence", t => {
  const f = fixture(t);
  f.success(["task", "update", "T-101", "--set", "workload=Normal", "--actor", "test"]);
  f.success(["task", "claim", "T-101", "--actor", "test"]);
  const dispatch = f.success(["dispatch", "create", "T-101", "--actor", "test"]);
  const receipt = {
    schemaVersion: 1, dispatchId: dispatch.dispatchId, attempt: 1, outcome: "completed",
    startedAt: "2026-10-09T10:00:00.000Z", endedAt: "2026-10-09T10:05:00.000Z", changedFiles: ["src/x.ts"], usageEvents: [],
    evidence: [{ artifactId: "22222222-2222-4222-8222-222222222222", ownerKind: "task", ownerId: "T-101",
      uri: `https://example.invalid/${SECRET}`, kind: "review", version: null, contentHash: null, promotedPath: null }], failure: null
  };
  fs.writeFileSync(path.join(f.repoDir, "receipt.json"), JSON.stringify(receipt));
  const result = f.cli(["dispatch", "receipt", dispatch.dispatchId, "--receipt", "receipt.json", "--actor", "test", "--json"]);
  assertAdvisory(result, `dispatch receipt ${dispatch.dispatchId}`, "evidence.0.uri");
  f.read(handle => assert.deepEqual(getRunReceipt(handle.db, dispatch.dispatchId, 1)!.evidence, receipt.evidence));
});

test("redact CLI lists paths without any secret preview, defaults to read-only dry-run and refuses missing --reason", t => {
  const f = fixture(t);
  const revision = f.approvalRevision();
  f.success(["task", "acceptance", "approve", "T-101", "--index", "0", "--expect-revision", String(revision),
    "--evidence", `customer=${SECRET}`, "--actor", "test"]);
  const listing = f.cli(["redact", "list", "--task", "T-101", "--json"]);
  assert.equal(listing.status, 0, listing.stderr);
  for (const fragment of [SECRET, "cust-ctx", "9f31a778421", "cu…"]) {
    assert.ok(!listing.stdout.includes(fragment), "redact list must carry field paths only");
  }
  const candidates = JSON.parse(listing.stdout).candidates;
  assert.equal(candidates.length, 1);
  const target = candidates[0];
  assert.deepEqual(target.redactableFieldPaths, ["evidence.customer"]);
  const args = ["redact", "--node", target.nodeId, "--sequence", String(target.sequence), "--field", "evidence", "--actor", "dpo"];
  const journalPath = path.join(f.storeDir, "events", target.nodeId, `${target.sequence}.json`);
  const before = fs.readFileSync(journalPath);
  const dbBefore = fs.readFileSync(StoreHandle.dbPathFor(f.storeDir));
  const refused = f.cli([...args, "--json"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /redact requires --reason/);
  assert.deepEqual(fs.readFileSync(journalPath), before);
  assert.deepEqual(fs.readFileSync(StoreHandle.dbPathFor(f.storeDir)), dbBefore);
  const dryRun = f.success([...args, "--reason", "remove production identifier"]);
  assert.equal(dryRun.mode, "dry-run");
  assert.ok(!JSON.stringify(dryRun).includes(SECRET));
  assert.deepEqual(dryRun.plan.previews, [{ fieldPath: "evidence.customer", preview: "cu…", length: SECRET.length }]);
  assert.deepEqual(fs.readFileSync(journalPath), before);
  assert.deepEqual(fs.readFileSync(StoreHandle.dbPathFor(f.storeDir)), dbBefore);
  f.read(handle => {
    assert.deepEqual(listRedactions(handle.db), []);
    assert.deepEqual(getAcceptance(handle.db, "T-101")!.criteria[0].evidence, { customer: SECRET });
  });
  const committed = f.success([...args, "--reason", "remove production identifier", "--commit"]);
  assert.equal(committed.mode, "commit");
  assert.ok(!JSON.stringify(committed).includes(SECRET));
  f.read(handle => {
    assert.equal(listRedactions(handle.db).length, 1);
    assert.equal(getAcceptance(handle.db, "T-101")!.criteria[0].state, "approved");
    assert.deepEqual(getAcceptance(handle.db, "T-101")!.criteria[0].evidence, { customer: "mapctx:redacted" });
  });
});
