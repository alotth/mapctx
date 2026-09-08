import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as path from "path"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { StoreHandle } from "./store-handle"
import { createTask, updateTask } from "./tasks"
import { getTask, getTaskDetail } from "./projections"
import { budgetScopeTaskIds, recordAccountAdd, setProjectAccounts } from "./budget"
import { bumpSequenceWatermark, createStoreMeta, readSequenceWatermark, readStoreMetaFile, writeStoreMetaFile } from "./identity"
import { journalEntryPath, listJournalSequences, readJournalEntry, writeJournalEntrySync } from "./journal"
import { readMetaValue } from "./db"
import { repairStore } from "./repair"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

const project = { eventType: "project.initialized", actor: "test", payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "store" } };
const patch = (title: string) => ({ eventType: "task.patched", actor: "test", payload: { taskId: "T-001", patch: { title }, source: "test" } });
function seed(dir: string): StoreHandle {
  const h = StoreHandle.open(dir);
  h.appendEvent(project);
  assert.ok(createTask(h, { title: "original", actor: "test" }).ok);
  return h;
}
const workerImports = `
const fs = require('fs');
const { StoreHandle } = require(${JSON.stringify(path.join(__dirname, "store-handle.js"))});
const { createTask } = require(${JSON.stringify(path.join(__dirname, "tasks.js"))});
const wait = p => { const until = Date.now() + 10000; while (!fs.existsSync(p)) { if (Date.now() > until) throw Error('barrier timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } };
`;
function crashWriter(dir: string, phase: "callback" | "staging" | "published" | "commit"): void {
  const r = spawnSync(process.execPath, ["-e", workerImports + `
const h = StoreHandle.open(${JSON.stringify(dir)});
const rename = fs.renameSync;
fs.renameSync = function(a, b) {
  if (String(b).includes('/batch-')) {
    if (${JSON.stringify(phase)} === 'staging') process.exit(71);
    rename(a, b);
    if (${JSON.stringify(phase)} === 'published') process.exit(71);
    return;
  }
  return rename(a, b);
};
h.runInWriteTransaction(append => {
  append(${JSON.stringify(patch("A-one"))});
  if (${JSON.stringify(phase)} === "callback") process.exit(71);
  append(${JSON.stringify(patch("A-two"))});
});
h.close();
`], { encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, phase === "commit" ? 0 : 71, r.stderr);
}
async function untilFile(file: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`Timeout waiting for ${file}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function worker(script: string) {
  const child = spawn(process.execPath, ["-e", workerImports + script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => stdout += b);
  child.stderr.on("data", b => stderr += b);
  const done = new Promise<string>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `worker exit ${code}`)));
  });
  void done.catch(() => {}); // Install rejection handler while barriers are pending.
  return { child, done };
}

test("R1 rejected callback and invalid projection never become replayable, even when append errors are caught", () => {
  const dir = mkTmpDir("mapctx-integrity-");
  let h = seed(dir);
  try {
    const before = h.listEvents();
    assert.throws(() => h.runInWriteTransaction(append => { append(patch("aborted")); throw Error("abort"); }), /abort/);
    assert.throws(() => h.runInWriteTransaction(append => { try { append({ eventType: "invalid", actor: "test", payload: {} }); } catch {} }), /Unknown event/);
    assert.deepEqual(h.listEvents(), before);
    assert.equal(listJournalSequences(dir, h.nodeId).length, before.length);
    const id = randomUUID();
    recordAccountAdd(h, { accountId: id, name: "A", currency: "USD", createdAt: new Date().toISOString(), note: null });
    const count = h.listEvents().length;
    assert.throws(() => setProjectAccounts(h, [id, id]));
    assert.equal(h.listEvents().length, count);
    h.close(); h = StoreHandle.open(dir);
    assert.equal(getTask(h.db, "T-001")?.title, "[T-001] original");
    h.close();
    assert.equal(repairStore(dir).status, "ok");
    h = StoreHandle.open(dir);
    assert.equal(h.listEvents().length, count);
  } finally { h.close(); cleanupDir(dir); }
});

for (const phase of ["callback", "staging", "published"] as const) {
  test(`R1 process death during ${phase}: replay accepts all or none of the batch`, () => {
    const dir = mkTmpDir("mapctx-crash-");
    const h = seed(dir); h.close();
    try {
      crashWriter(dir, phase);
      assert.equal(repairStore(dir).status, "ok");
      const reopened = StoreHandle.open(dir);
      try {
        assert.equal(reopened.listEvents().length, phase === "published" ? 4 : 2);
        assert.equal(getTask(reopened.db, "T-001")?.title, phase === "published" ? "A-two" : "[T-001] original");
      } finally { reopened.close(); }
    } finally { cleanupDir(dir); }
  });
}

for (const phase of ["published", "commit"] as const) {
  test(`R2 writer waiting before BEGIN sees A's ${phase} batch without overwrite or double replay`, async () => {
    const dir = mkTmpDir("mapctx-race-");
    const h = seed(dir); h.close();
    const ready = path.join(dir, "ready"), go = path.join(dir, "go");
    const b = worker(`
const h = StoreHandle.open(${JSON.stringify(dir)});
const exec = h.db.exec.bind(h.db);
let paused = false;
h.db.exec = sql => {
  if (sql === 'BEGIN IMMEDIATE' && !paused) { paused = true; fs.writeFileSync(${JSON.stringify(ready)}, ''); wait(${JSON.stringify(go)}); }
  return exec(sql);
};
const event = h.appendEvent(${JSON.stringify(patch("B"))});
console.log(event.sequence); h.close();
`);
    try {
      await untilFile(ready);
      crashWriter(dir, phase);
      fs.writeFileSync(go, "");
      assert.equal((await b.done).trim(), "5");
      const r = StoreHandle.open(dir);
      try {
        assert.deepEqual(r.listEvents().slice(2).map(e => (e.payload.patch as { title: string }).title), ["A-one", "A-two", "B"]);
        const a = readJournalEntry(dir, r.nodeId, 3);
        assert.equal(a.status, "ok");
        if (a.status === "ok") assert.throws(() => writeJournalEntrySync(dir, { ...a.entry, sequence: 5 }), /EEXIST/);
      } finally { r.close(); }
    } finally { b.child.kill(); await b.done.catch(() => {}); cleanupDir(dir); }
  });
}

for (const explicit of [false, true]) {
  test(`R3 concurrent ${explicit ? "explicit" : "automatic"} creation preserves identity and detail`, async () => {
    const dir = mkTmpDir("mapctx-create-race-");
    const h = seed(dir); h.close();
    const go = path.join(dir, "go");
    const workers: ReturnType<typeof worker>[] = [];
    for (const title of ["one", "two"]) {
      workers.push(worker(`
const h = StoreHandle.open(${JSON.stringify(dir)});
const run = h.runInWriteTransaction.bind(h);
h.runInWriteTransaction = fn => { fs.writeFileSync(${JSON.stringify(path.join(dir, title))}, ''); wait(${JSON.stringify(go)}); return run(fn); };
console.log(JSON.stringify(createTask(h, { title: ${JSON.stringify(title)}, actor: 'test', ${explicit ? "id: 'T-002'," : ""} detail: { summary: ${JSON.stringify(title)} } })));
h.close();
`));
      await untilFile(path.join(dir, title));
    }
    try {
      await Promise.all(["one", "two"].map(title => untilFile(path.join(dir, title))));
      fs.writeFileSync(go, "");
      const results = (await Promise.all(workers.map(w => w.done))).map(s => JSON.parse(s));
      assert.equal(results.filter(r => r.ok).length, explicit ? 1 : 2);
      if (explicit) assert.equal(results.find(r => !r.ok).reason, "duplicate-id");
      else assert.equal(new Set(results.map(r => r.taskId)).size, 2);
      const r = StoreHandle.open(dir);
      try {
        results.forEach((result, i) => {
          if (!result.ok) return;
          const title = ["one", "two"][i];
          assert.equal(getTask(r.db, result.taskId)?.title, `[${result.taskId}] ${title}`);
          assert.equal(getTaskDetail(r.db, result.taskId)?.summary, title);
        });
      } finally { r.close(); }
    } finally { workers.forEach(w => w.child.kill()); await Promise.all(workers.map(w => w.done.catch(() => {}))); cleanupDir(dir); }
  });
}

test("R4 self/ancestor cycles rejected across patch/upsert; corrupt historical rollup terminates", () => {
  const dir = mkTmpDir("mapctx-cycle-");
  const h = seed(dir);
  try {
    createTask(h, { id: "E-001", type: "epic", title: "parent", actor: "test" });
    createTask(h, { id: "E-002", type: "epic", title: "child", parent: "E-001", actor: "test" });
    const count = h.listEvents().length;
    assert.throws(() => updateTask(h, { taskId: "E-001", patch: { parentTaskId: "E-001" }, actor: "test" }), /Parent cycle/);
    assert.throws(() => updateTask(h, { taskId: "E-001", patch: { parentTaskId: "E-002" }, actor: "test" }), /Parent cycle/);
    assert.throws(() => h.appendEvent({ eventType: "task.upserted", actor: "import", payload: { task: { ...getTask(h.db, "E-001"), parentTaskId: "E-002" } } }), /Parent cycle/);
    assert.equal(h.listEvents().length, count);
    h.db.exec("UPDATE task_projection SET parent_task_id = 'E-002' WHERE task_id = 'E-001'");
    assert.throws(() => budgetScopeTaskIds(h.db, "epic", "E-001"), /Parent cycle/);
  } finally { h.close(); cleanupDir(dir); }
});

test("R1 caught SQLite commit failure removes the published batch before releasing the lock", () => {
  const dir = mkTmpDir("mapctx-commit-failure-");
  let h = seed(dir);
  try {
    const before = h.listEvents();
    const exec = h.db.exec.bind(h.db);
    h.db.exec = sql => {
      if (sql === "COMMIT") throw new Error("injected commit failure");
      return exec(sql);
    };
    assert.throws(() => h.runInWriteTransaction(append => { append(patch("one")); append(patch("two")); }), /injected commit failure/);
    h.db.exec = exec;
    assert.deepEqual(h.listEvents(), before);
    assert.deepEqual(listJournalSequences(dir, h.nodeId), [1, 2]);
    h.close(); h = StoreHandle.open(dir);
    assert.equal(getTask(h.db, "T-001")?.title, "[T-001] original");
  } finally { h.close(); cleanupDir(dir); }
});

test("R2 recovery refuses a noncontiguous pending journal without allocating across the gap", () => {
  const dir = mkTmpDir("mapctx-recovery-gap-");
  const h = seed(dir);
  try {
    const entry = h.listEvents()[1];
    writeJournalEntrySync(dir, { ...entry, sequence: 4, logicalClock: 4 });
    assert.throws(() => h.appendEvent(patch("must not write")), /Journal gap/);
    assert.equal(h.listEvents().length, 2);
    assert.equal(readJournalEntry(dir, h.nodeId, 3).status, "missing");
  } finally { h.close(); cleanupDir(dir); }
});

test("P1 watermark: concurrent out-of-order post-commit updates converge on the max and stay parseable", async () => {
  const dir = mkTmpDir("mapctx-watermark-race-");
  try {
    const meta = createStoreMeta();
    writeStoreMetaFile(dir, meta);
    const go = path.join(dir, "go");
    const workers = [3, 4, 5].map(seq => worker(`
wait(${JSON.stringify(go)});
const { bumpSequenceWatermark } = require(${JSON.stringify(path.join(__dirname, "identity.js"))});
for (let i = 0; i < 25; i++) bumpSequenceWatermark(${JSON.stringify(dir)}, ${JSON.stringify(meta.nodeId)}, ${seq});
fs.writeFileSync(${JSON.stringify(path.join(dir, `done-${seq}`))}, '');
`));
    fs.writeFileSync(go, "");
    await Promise.all(workers.map(w => w.done));
    assert.equal(readStoreMetaFile(dir)?.sequenceWatermarks[meta.nodeId], 5);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "store-meta.json"), "utf8")).sequenceWatermarks[meta.nodeId], 5);
    assert.equal(fs.existsSync(path.join(dir, "store-meta.lock")), false, "lock directory must be released");
    // an explicitly late update can never regress the watermark
    bumpSequenceWatermark(dir, meta.nodeId, 3);
    assert.equal(readSequenceWatermark(dir, meta.nodeId), 5);
  } finally { cleanupDir(dir); }
});

test("P1 watermark persistence failure: commit stays accepted, store records the stale marker, repair keeps loss detection, open self-heals", () => {
  const dir = mkTmpDir("mapctx-watermark-degraded-");
  let h = seed(dir);
  try {
    const realFs = require("fs") as { renameSync: (a: fs.PathLike, b: fs.PathLike) => void };
    const rename = realFs.renameSync;
    realFs.renameSync = (a: fs.PathLike, b: fs.PathLike) => {
      if (String(b).endsWith("store-meta.json")) throw new Error("injected meta rename failure");
      return rename(a, b);
    };
    try {
      assert.doesNotThrow(() => h.appendEvent(patch("watermark-lags")), "a committed transaction must not surface as rejected");
    } finally { realFs.renameSync = rename; }
    assert.equal(h.listEvents().length, 3);
    assert.equal(readMetaValue<string>(h.db, "watermark_stale"), h.nodeId);
    assert.equal(readSequenceWatermark(dir, h.nodeId), 2);

    // the lagged watermark alone would hide a deleted trailing journal file;
    // the intact-database floor keeps repair's independent loss detection
    h.close();
    fs.rmSync(journalEntryPath(dir, h.nodeId, 3));
    assert.deepEqual(repairStore(dir), {
      status: "gap",
      dbWasCorrupt: false,
      gaps: [{ nodeId: h.nodeId, sequence: 3, reason: "missing journal file" }]
    });

    // reopen reconciles the watermark from the committed database and clears the marker
    h = StoreHandle.open(dir);
    assert.equal(readSequenceWatermark(dir, h.nodeId), 3);
    assert.equal(readMetaValue(h.db, "watermark_stale"), undefined);
  } finally { h.close(); cleanupDir(dir); }
});

// Patch through require("fs"): the ESM-star import is a getter-only copy,
// while the production modules resolve fs.* through getters onto the real
// (mutable) builtin module object at call time.
function injectFsyncFailure(failOn: number[]): () => void {
  const realFs = require("fs") as { fsyncSync: (fd: number) => void };
  const realFsync = realFs.fsyncSync;
  let calls = 0;
  realFs.fsyncSync = (fd: number) => {
    calls += 1;
    if (failOn.includes(calls)) throw new Error("injected fsync failure");
    realFsync(fd);
  };
  return () => { realFs.fsyncSync = realFsync; };
}

test("P1 parent-fsync failure after single-entry publication durably removes the entry before rejecting", () => {
  const dir = mkTmpDir("mapctx-pubfsync-single-");
  let h = seed(dir);
  try {
    // fsync 1: staged temp file; fsync 2: parent directory after publication
    const restore = injectFsyncFailure([2]);
    try {
      assert.throws(() => h.appendEvent(patch("never-durable")), /Journal publication fsync failed/);
    } finally { restore(); }
    assert.equal(readJournalEntry(dir, h.nodeId, 3).status, "missing");
    assert.deepEqual(listJournalSequences(dir, h.nodeId), [1, 2]);
    h.close(); h = StoreHandle.open(dir);
    assert.equal(h.listEvents().length, 2);
    // the rejected sequence is allocatable again afterwards
    assert.ok(h.appendEvent(patch("after-abort")));
    assert.equal((h.listEvents()[2].payload.patch as { title: string }).title, "after-abort");
  } finally { h.close(); cleanupDir(dir); }
});

test("P1 parent-fsync failure after batch publication durably removes the whole batch before rejecting", () => {
  const dir = mkTmpDir("mapctx-pubfsync-batch-");
  let h = seed(dir);
  try {
    // fsyncs 1-2: staged batch files; 3: staged directory; 4: parent after rename
    const restore = injectFsyncFailure([4]);
    try {
      assert.throws(() => h.runInWriteTransaction(append => { append(patch("b-one")); append(patch("b-two")); }), /batch publication fsync failed/);
    } finally { restore(); }
    assert.deepEqual(listJournalSequences(dir, h.nodeId), [1, 2]);
    h.close(); h = StoreHandle.open(dir);
    assert.equal(h.listEvents().length, 2);
    // both batch sequences are allocatable again afterwards
    assert.ok(h.appendEvent(patch("after-abort")));
    assert.equal((h.listEvents()[2].payload.patch as { title: string }).title, "after-abort");
  } finally { h.close(); cleanupDir(dir); }
});

test("P1 cleanup fsync failure surfaces an explicit INDETERMINATE outcome instead of a safe-sounding rejection", () => {
  const dir = mkTmpDir("mapctx-pubfsync-indeterminate-");
  let h = seed(dir);
  try {
    // fsync 2: parent directory after publication; fsync 3: the cleanup's own parent fsync
    const restore = injectFsyncFailure([2, 3]);
    try {
      assert.throws(() => h.appendEvent(patch("x")), /INDETERMINATE/);
    } finally { restore(); }
  } finally { h.close(); cleanupDir(dir); }
});
