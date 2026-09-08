import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import { listTasks } from "./projections"
import { validateStoreRegime } from "./validate"
import { resolveProjectStoreDir } from "./config"
import { StoreHandle } from "./store-handle"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

function seedTwoTasks(handle: StoreHandle): void {
  handle.appendEvent({
    eventType: "project.initialized",
    actor: "test",
    payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" }
  });
  for (let i = 1; i <= 2; i++) {
    handle.appendEvent({
      eventType: "task.upserted",
      actor: "test",
      payload: {
        task: {
          taskId: `T-00${i}`,
          positionKey: i,
          title: `task ${i}`,
          planningState: "backlog",
          executionState: "unclaimed",
          tags: [],
          domains: [],
          externalLinks: [],
          assignees: []
        }
      }
    });
  }
}

function countJournalFiles(dir: string): number {
  let count = 0;
  const eventsDir = `${dir}/events`;
  if (!fs.existsSync(eventsDir)) return 0;
  for (const node of fs.readdirSync(eventsDir)) {
    count += fs.readdirSync(`${eventsDir}/${node}`).filter(f => f.endsWith(".json")).length;
  }
  return count;
}

// R14: read-only opens must observe, never mutate -- no migrations, no
// journal replay, no identity metadata writes.
test("R14: openReadOnly reads data without migrations, reindex, or metadata writes", () => {
  const dir = mkTmpDir("mapctx-store-readonly-");
  try {
    const handle = StoreHandle.open(dir);
    seedTwoTasks(handle);
    handle.close();

    const dbPath = StoreHandle.dbPathFor(dir);
    const dbBytesBefore = fs.readFileSync(dbPath).length;
    const journalFilesBefore = countJournalFiles(dir);

    const readOnly = StoreHandle.openReadOnly(dir);
    try {
      assert.equal(listTasks(readOnly.db).length, 2, "reads still see the data");
      assert.equal(readOnly.maintenanceNeeded(), null, "a healthy store needs no maintenance");
      assert.throws(
        () => readOnly.appendEvent({ eventType: "task.upserted", actor: "test", payload: { task: {} } }),
        /readonly|read-only|attempt to write/i,
        "writes through a read-only handle must fail"
      );
    } finally {
      readOnly.close();
    }

    assert.equal(fs.readFileSync(dbPath).length, dbBytesBefore, "the database file must be byte-identical after a read-only session");
    assert.equal(countJournalFiles(dir), journalFilesBefore, "no journal entries may be added or replayed by a read");
  } finally {
    cleanupDir(dir);
  }
});

// R14: pending maintenance is reported explicitly, not healed by a read.
test("R14: pending journal entry surfaces as an explicit maintenance condition", () => {
  const dir = mkTmpDir("mapctx-store-readonly-pending-");
  try {
    const handle = StoreHandle.open(dir);
    seedTwoTasks(handle);
    handle.close();

    // Simulate a crash between journal fsync and SQLite commit: duplicate the
    // newest journal file under the next sequence so the journal runs one
    // entry ahead of the indexed state. A writable open would heal this; the
    // read-only open must report it instead of applying it.
    const journalDir = `${dir}/events`;
    const nodeId = fs.readdirSync(journalDir)[0];
    const sequences = fs.readdirSync(`${journalDir}/${nodeId}`).map(f => Number(f.replace(/\.json$/, ""))).sort((a, b) => a - b);
    const last = sequences[sequences.length - 1];
    fs.copyFileSync(`${journalDir}/${nodeId}/${last}.json`, `${journalDir}/${nodeId}/${last + 1}.json`);

    const readOnly = StoreHandle.openReadOnly(dir);
    try {
      const maintenance = readOnly.maintenanceNeeded();
      assert.ok(maintenance && /journal/.test(maintenance), `pending journal must be reported: ${maintenance}`);
      assert.equal(listTasks(readOnly.db).length, 2, "the pending entry must NOT be applied by a read");
    } finally {
      readOnly.close();
    }

    fs.rmSync(`${journalDir}/${nodeId}/${last + 1}.json`, { force: true });
    void nodeId;
  } finally {
    cleanupDir(dir);
  }
});

// R14 review P2#2: a store with pending maintenance must validate into its
// own status with the correct remedy, not masquerade as "not-materialized"
// (whose remedy, store init, is a no-op on a materialized store).
test("R14 P2#2: maintenance-needed is a distinct validate status with a repair remedy", () => {
  const previousHome = process.env.MAPCTX_HOME;
  const home = mkTmpDir("mapctx-store-readonly-home-");
  const dir = mkTmpDir("mapctx-store-readonly-maintenance-");
  const projectId = "33333333-3333-4333-8333-333333333333";
  try {
    process.env.MAPCTX_HOME = home;
    fs.writeFileSync(
      `${dir}/mapctx.toml`,
      `schemaVersion = 1\nprojectId = "${projectId}"\nplansAuthority = "store"\n`,
      "utf8"
    );
    const storeDir = resolveProjectStoreDir(projectId);
    const handle = StoreHandle.open(storeDir);
    seedTwoTasks(handle);
    handle.close();

    const journalDir = `${storeDir}/events`;
    const nodeId = fs.readdirSync(journalDir)[0];
    const sequences = fs.readdirSync(`${journalDir}/${nodeId}`).map(f => Number(f.replace(/\.json$/, ""))).sort((a, b) => a - b);
    const last = sequences[sequences.length - 1];
    fs.copyFileSync(`${journalDir}/${nodeId}/${last}.json`, `${journalDir}/${nodeId}/${last + 1}.json`);

    const status = validateStoreRegime(dir, dir);
    assert.equal(status.status, "maintenance-needed");
    if (status.status === "maintenance-needed") {
      assert.match(status.maintenanceNeeded, /journal/);
    }

    // After the manufactured lag is removed, the store is healthy again.
    fs.rmSync(`${journalDir}/${nodeId}/${last + 1}.json`, { force: true });
    assert.equal(validateStoreRegime(dir, dir).status, "store-authority");
  } finally {
    if (previousHome === undefined) delete process.env.MAPCTX_HOME;
    else process.env.MAPCTX_HOME = previousHome;
    cleanupDir(dir);
    cleanupDir(home);
  }
});
