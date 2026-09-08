import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as path from "path"
import { listTasks } from "./projections"
import { repairStore } from "./repair"
import { StoreHandle, storeDbIntegrityOk } from "./store-handle"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

function seedFiveTasks(handle: StoreHandle): void {
  handle.appendEvent({
    eventType: "project.initialized",
    actor: "test",
    payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" }
  });
  for (let i = 1; i <= 5; i++) {
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

test("store repair rebuilds mapctx.db from the independent journal when the SQLite file is corrupt", () => {
  const dir = mkTmpDir("mapctx-store-repair-corrupt-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);
    handle.close();

    fs.writeFileSync(StoreHandle.dbPathFor(dir), "NOT A SQLITE FILE");
    assert.equal(storeDbIntegrityOk(dir), false);

    const result = repairStore(dir);
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.dbWasCorrupt, true);
      assert.equal(result.eventsReplayed, 6); // project.initialized + 5 task.upserted
    }

    assert.equal(storeDbIntegrityOk(dir), true);
    const reopened = StoreHandle.open(dir);
    assert.equal(listTasks(reopened.db).length, 5);
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

test("store repair reports a named gap for a missing journal entry and leaves mapctx.db untouched", () => {
  const dir = mkTmpDir("mapctx-store-repair-gap-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);
    const nodeId = handle.nodeId;
    handle.close();

    // Delete sequence 3 (project.initialized=1, task.upserted x5 = 2..6) --
    // a mid-history gap, not just a trailing one.
    fs.unlinkSync(path.join(dir, "events", nodeId, "3.json"));
    fs.writeFileSync(StoreHandle.dbPathFor(dir), "CORRUPT");

    const result = repairStore(dir);
    assert.equal(result.status, "gap");
    if (result.status === "gap") {
      assert.equal(result.gaps.length, 1);
      assert.equal(result.gaps[0].nodeId, nodeId);
      assert.equal(result.gaps[0].sequence, 3);
    }

    assert.equal(fs.readFileSync(StoreHandle.dbPathFor(dir), "utf8"), "CORRUPT", "a gap must abort before touching mapctx.db");
  } finally {
    cleanupDir(dir);
  }
});

test("store repair detects a fully-deleted trailing journal entry via the sequence watermark, not just directory listing", () => {
  const dir = mkTmpDir("mapctx-store-repair-watermark-");
  try {
    const handle = StoreHandle.open(dir);
    handle.appendEvent({
      eventType: "project.initialized",
      actor: "test",
      payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" }
    });
    const nodeId = handle.nodeId;
    handle.close();

    // Deleting the only (and therefore trailing) journal file makes
    // directory listing alone look like "nothing was ever written" --
    // the watermark in store-meta.json is what catches this.
    fs.unlinkSync(path.join(dir, "events", nodeId, "1.json"));
    fs.writeFileSync(StoreHandle.dbPathFor(dir), "CORRUPT");

    const result = repairStore(dir);
    assert.equal(result.status, "gap");
    if (result.status === "gap") {
      assert.equal(result.gaps.length, 1);
      assert.equal(result.gaps[0].sequence, 1);
    }
  } finally {
    cleanupDir(dir);
  }
});

test("store repair with an intact, non-corrupt store is a safe no-op reprojection", () => {
  const dir = mkTmpDir("mapctx-store-repair-noop-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);
    handle.close();

    const result = repairStore(dir);
    assert.equal(result.status, "ok");
    if (result.status === "ok") assert.equal(result.dbWasCorrupt, false);

    const reopened = StoreHandle.open(dir);
    assert.equal(listTasks(reopened.db).length, 5);
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});
