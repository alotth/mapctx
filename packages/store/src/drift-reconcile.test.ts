import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as path from "path"
import { importCommit } from "./cutover"
import { diffTaskForReconcile, reconcileAccept, reconcileDiscard } from "./reconcile"
import { StoreHandle } from "./store-handle"
import { validateStoreRegime } from "./validate"
import { cleanupDir, setupGoldenRepo } from "./__test-helpers__"

function editTaskStatus(tasksMdPath: string, taskId: string, from: string, to: string): void {
  const content = fs.readFileSync(tasksMdPath, "utf8");
  const lines = content.split("\n");
  let insideTarget = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `- id: ${taskId}`) insideTarget = true;
    else if (insideTarget && lines[i].trim() === `- status: ${from}`) {
      lines[i] = lines[i].replace(`status: ${from}`, `status: ${to}`);
      insideTarget = false;
    }
  }
  fs.writeFileSync(tasksMdPath, lines.join("\n"), "utf8");
}

test("checkDrift/validateStoreRegime: clean right after cutover, flags a manual edit per task ID", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    const result = importCommit({ cwd: repoDir, actor: "test" });
    const tasksMdPath = path.join(repoDir, "TASKS.md");

    let status = validateStoreRegime(repoDir, repoDir);
    assert.equal(status.status, "store-authority");
    if (status.status === "store-authority") assert.equal(status.drift.hasDrift, false);

    editTaskStatus(tasksMdPath, "T-101", "backlog", "doing");

    status = validateStoreRegime(repoDir, repoDir);
    assert.equal(status.status, "store-authority");
    if (status.status === "store-authority") {
      assert.equal(status.drift.hasDrift, true);
      assert.ok(status.drift.issues.some(i => i.taskId === "T-101"));
    }

    void result;
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("reconcile discard reverts the manual edit; reconcile accept writes it into the store with manual-reconcile provenance", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    const result = importCommit({ cwd: repoDir, actor: "test" });
    const tasksMdPath = path.join(repoDir, "TASKS.md");

    // --- discard path ---
    editTaskStatus(tasksMdPath, "T-101", "backlog", "doing");
    let handle = StoreHandle.open(result.storeDir);
    reconcileDiscard(handle.db, repoDir);
    handle.close();

    let status = validateStoreRegime(repoDir, repoDir);
    assert.equal(status.status, "store-authority");
    if (status.status === "store-authority") assert.equal(status.drift.hasDrift, false, "discard must revert the file to match the store");

    // --- accept path ---
    editTaskStatus(tasksMdPath, "T-101", "backlog", "doing");
    handle = StoreHandle.open(result.storeDir);
    const diff = diffTaskForReconcile(handle.db, repoDir, "T-101");
    assert.ok(diff.taskFields.some(f => f.field === "planningState"));

    reconcileAccept(handle, repoDir, "T-101", "reconciler-actor");

    const events = handle.listEvents();
    const patchEvent = events.find(e => e.eventType === "task.patched");
    assert.ok(patchEvent, "accept must write a task.patched event");
    assert.equal((patchEvent!.payload as { source?: string }).source, "manual-reconcile");
    assert.equal(patchEvent!.actor, "reconciler-actor");

    status = validateStoreRegime(repoDir, repoDir);
    assert.equal(status.status, "store-authority");
    if (status.status === "store-authority") assert.equal(status.drift.hasDrift, false, "accept must re-export so the file and store agree again");

    handle.close();
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("validateStoreRegime fails closed as not-materialized when plansAuthority=store but no local mapctx.db exists", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    const result = importCommit({ cwd: repoDir, actor: "test" });
    fs.rmSync(result.storeDir, { recursive: true, force: true });

    const status = validateStoreRegime(repoDir, repoDir);
    assert.equal(status.status, "not-materialized");
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});
