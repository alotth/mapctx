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

// R8: a byte mismatch that per-task map comparison cannot attribute (swapped
// task blocks, parser-ignored prose) must still yield hasDrift -- never a
// silent "no drift" fallback to the parser.
function extractTaskBlock(tasksMdPath: string, taskId: string): { block: string; start: number; end: number } {
  const lines = fs.readFileSync(tasksMdPath, "utf8").split("\n");
  const start = lines.findIndex(line => line.trim().startsWith(`### [${taskId}]`));
  assert.ok(start >= 0, `block not found for ${taskId}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("### [") || lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return { block: lines.slice(start, end).join("\n"), start, end };
}

test("R8: swapping two whole task blocks is drift even though parsed fields match", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    importCommit({ cwd: repoDir, actor: "test" });
    const tasksMdPath = path.join(repoDir, "TASKS.md");
    assert.equal(validateStoreRegime(repoDir, repoDir).status, "store-authority");

    const a = extractTaskBlock(tasksMdPath, "T-101");
    const b = extractTaskBlock(tasksMdPath, "T-102");
    let content = fs.readFileSync(tasksMdPath, "utf8");
    const aLines = content.split("\n");
    // Replace b's span first (higher indices), then a's, keeping byte counts
    // aligned so only ORDER changes -- no per-task field differs.
    aLines.splice(b.start, b.end - b.start, a.block);
    const bLines = aLines.join("\n").split("\n");
    const aStartAfter = bLines.findIndex(line => line.trim().startsWith(`### [T-101]`));
    const aEndAfter = bLines.findIndex((line, i) => i > aStartAfter && (line.startsWith("### [") || line.startsWith("## ")));
    bLines.splice(aStartAfter, aEndAfter - aStartAfter, b.block);
    fs.writeFileSync(tasksMdPath, bLines.join("\n"), "utf8");

    const status = validateStoreRegime(repoDir, repoDir);
    if (status.status === "store-authority") {
      assert.equal(status.drift.hasDrift, true, "swapped task blocks preserve parsed fields but still drift");
    } else {
      assert.fail("expected store-authority regime");
    }
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("R8: parser-ignored prose inside a task block still reports drift", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    importCommit({ cwd: repoDir, actor: "test" });
    const tasksMdPath = path.join(repoDir, "TASKS.md");

    const a = extractTaskBlock(tasksMdPath, "T-101");
    let content = fs.readFileSync(tasksMdPath, "utf8");
    const lines = content.split("\n");
    lines.splice(a.end, 0, "free-form prose the parser ignores entirely");
    fs.writeFileSync(tasksMdPath, lines.join("\n"), "utf8");

    const status = validateStoreRegime(repoDir, repoDir);
    if (status.status === "store-authority") {
      assert.equal(status.drift.hasDrift, true, "byte-level prose change must not collapse to no-drift");
    } else {
      assert.fail("expected store-authority regime");
    }
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});
