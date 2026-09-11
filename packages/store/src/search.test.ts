import assert from "node:assert/strict"
import test from "node:test"
import { searchTasks, foldSearchText } from "./projections"
import { importCommit } from "./cutover"
import { StoreHandle } from "./store-handle"
import { cleanupDir, setupGoldenRepo } from "./__test-helpers__"

function materialize() {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  const committed = importCommit({ cwd: repoDir, actor: "test-actor" });
  const handle = StoreHandle.open(committed.storeDir);
  return { repoDir, restoreEnv, handle, committed };
}

test("foldSearchText strips diacritics and lowercases", () => {
  assert.equal(foldSearchText("Divêrgência Ção ÉPIC"), "divergencia cao epic");
  assert.equal(foldSearchText("Sübtask ünicode"), "subtask unicode");
});

test("searchTasks matches accent-folded titles and ranks title matches first", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const hits = searchTasks(handle.db, { query: "subtask unicode" });
    assert.equal(hits[0].taskId, "T-101", "query typed without accents matches the accented title");
    assert.ok(hits.some(hit => hit.taskId === "E-100"), "unicode term matched via tags when absent from title");
    assert.equal(hits[0].planningState, "backlog");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("searchTasks matches summary text only", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const hits = searchTasks(handle.db, { query: "long multi-line description" });
    assert.deepEqual(hits.map(hit => hit.taskId), ["T-102"]);
    assert.equal(hits[0].summary, "Depends on T-101, has a long multi-line description.");
    assert.equal(hits[0].completedOn, "2026-01-09");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("searchTasks ANDs terms across fields", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const hits = searchTasks(handle.db, { query: "docs task" });
    assert.deepEqual(hits.map(hit => hit.taskId), ["T-102"], "docs in tags + task in title");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("searchTasks filters by status and honors limit", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const doneOnly = searchTasks(handle.db, { query: "task", status: "done" });
    assert.deepEqual(doneOnly.map(hit => hit.taskId), ["T-102"]);
    const limited = searchTasks(handle.db, { query: "task", limit: 1 });
    assert.equal(limited.length, 1);
    assert.equal(limited[0].taskId, "E-100", "limit keeps board order within the same rank");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("searchTasks returns no matches for blank queries", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    assert.deepEqual(searchTasks(handle.db, { query: "" }), []);
    assert.deepEqual(searchTasks(handle.db, { query: "   " }), []);
    assert.deepEqual(searchTasks(handle.db, { query: "zzz-no-such-term" }), []);
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});
