import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as path from "path"
import { listTasks } from "./projections"
import { acquireMaintenanceLock, readMaintenanceLock } from "./maintenance"
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

// R12: repair swaps the database file, so a live maintenance lock must
// exclude openers and writers for the duration -- refused, never interleaved.
test("R12: live maintenance lock refuses open and writes; repair refuses too", () => {
  const dir = mkTmpDir("mapctx-store-repair-lock-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);

    const lock = acquireMaintenanceLock(dir);
    try {
      assert.throws(() => StoreHandle.open(dir), /under maintenance/, "open must refuse under a live maintenance lock");
      assert.throws(
        () => handle.appendEvent({ eventType: "task.upserted", actor: "test", payload: { task: { taskId: "T-099", positionKey: 99, title: "x", planningState: "backlog", executionState: "unclaimed", tags: [], domains: [], externalLinks: [], assignees: [] } } }),
        /under maintenance/,
        "a handle open across the lock must refuse new writes"
      );
      assert.throws(() => repairStore(dir), /under maintenance/, "repair must refuse a live holder");
    } finally {
      lock.release();
    }

    // After release everything works again and no event was lost or duplicated.
    assert.equal(repairStore(dir).status, "ok");
    handle.close();
    const reopened = StoreHandle.open(dir);
    try {
      assert.equal(listTasks(reopened.db).length, 5, "journal identity survived the refused writers untouched");
    } finally {
      reopened.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("R12: a stale maintenance lock left by a dead process is stolen, not a permanent brick", async () => {
  const dir = mkTmpDir("mapctx-store-repair-stale-lock-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);
    handle.close();

    // A PID that provably belongs to no live process.
    const child = (await import("child_process")).spawn("sleep", ["1"]);
    const deadPid = child.pid as number;
    child.kill("SIGKILL");
    await new Promise(resolve => child.once("exit", resolve));
    fs.writeFileSync(path.join(dir, "maintenance.lock"), JSON.stringify({ pid: deadPid, takenAt: "2026-09-08T00:00:00.000Z" }), "utf8");

    assert.equal(repairStore(dir).status, "ok", "a dead holder's lock must be stealable");
    const lock = readMaintenanceLock(dir);
    assert.equal(lock, null, "the stolen lock must not persist");
  } finally {
    cleanupDir(dir);
  }
});

// R12 review P2#1: a stale crash-dirty WAL must not survive the swap next to
// the replacement main DB -- SQLite would recover its frames against the
// replaced generation on the next open. Repair quiesces and removes the WAL
// set under the maintenance lock before the rename.
test("R12 P2#1: repair removes a stale -wal/-shm so the replacement is never paired with old frames", () => {
  const dir = mkTmpDir("mapctx-store-repair-stale-wal-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);
    handle.close();

    // Simulate a crash-dirty WAL: garbage -wal/-shm files beside a healthy
    // main DB (exactly what a kill mid-write leaves behind).
    fs.writeFileSync(`${StoreHandle.dbPathFor(dir)}-wal`, "STALE WAL FRAMES");
    fs.writeFileSync(`${StoreHandle.dbPathFor(dir)}-shm`, "STALE SHM");

    const result = repairStore(dir);
    assert.equal(result.status, "ok");

    assert.equal(fs.existsSync(`${StoreHandle.dbPathFor(dir)}-wal`), false, "no stale WAL may survive the repair");
    assert.equal(fs.existsSync(`${StoreHandle.dbPathFor(dir)}-shm`), false, "no stale SHM may survive the repair");
    assert.equal(storeDbIntegrityOk(dir), true);

    const reopened = StoreHandle.open(dir);
    try {
      assert.equal(listTasks(reopened.db).length, 5, "the replacement DB carries the replayed journal");
    } finally {
      reopened.close();
    }
  } finally {
    cleanupDir(dir);
  }
});
