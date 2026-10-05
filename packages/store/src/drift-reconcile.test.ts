import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as path from "path"
import { importCommit } from "./cutover"
import { diffTaskForReconcile, reconcileAccept, reconcileDiscard } from "./reconcile"
import { StoreHandle } from "./store-handle"
import { commitAcceptanceImport } from "./acceptance"
import { checkStoreSnapshots, validateStoreRegime } from "./validate"
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

    // T-120: drift is no longer part of operational validateStoreRegime; the
    // snapshot comparison is the explicit checkStoreSnapshots operation.
    let snapshots = checkStoreSnapshots(repoDir, repoDir);
    assert.equal(snapshots.status, "store-authority");
    if (snapshots.status === "store-authority") assert.equal(snapshots.drift.hasDrift, false);
    const acceptanceStore = StoreHandle.open(result.storeDir);
    const acceptanceImport = commitAcceptanceImport(acceptanceStore, repoDir, { actor: "test" });
    acceptanceStore.close();
    assert.equal(acceptanceImport.ok, true, "legacy checklist states enter canonical store only through explicit import");
    let status = validateStoreRegime(repoDir);
    assert.equal(status.status, "store-authority");
    const canonicalBefore = status.status === "store-authority" ? JSON.stringify(status.canonical) : "";

    editTaskStatus(tasksMdPath, "T-101", "backlog", "doing");

    snapshots = checkStoreSnapshots(repoDir, repoDir);
    assert.equal(snapshots.status, "store-authority");
    if (snapshots.status === "store-authority") {
      assert.equal(snapshots.drift.hasDrift, true);
      assert.ok(snapshots.drift.issues.some(i => i.taskId === "T-101"));
    }
    status = validateStoreRegime(repoDir);
    assert.equal(status.status, "store-authority");
    if (status.status === "store-authority") {
      assert.equal(JSON.stringify(status.canonical), canonicalBefore, "a divergent mirror must not change the operational canonical result");
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

    let snapshots = checkStoreSnapshots(repoDir, repoDir);
    assert.equal(snapshots.status, "store-authority");
    if (snapshots.status === "store-authority") assert.equal(snapshots.drift.hasDrift, false, "discard must revert the file to match the store");

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

    snapshots = checkStoreSnapshots(repoDir, repoDir);
    assert.equal(snapshots.status, "store-authority");
    if (snapshots.status === "store-authority") assert.equal(snapshots.drift.hasDrift, false, "accept must re-export so the file and store agree again");

    handle.close();
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("reconcile accept refuses a manual move to done when acceptance is incomplete", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    const result = importCommit({ cwd: repoDir, actor: "test" });
    const tasksMdPath = path.join(repoDir, "TASKS.md");
    const detailPath = path.join(repoDir, "tasks", "T-101.md");
    fs.writeFileSync(detailPath, fs.readFileSync(detailPath, "utf8").replace("[x] Golden task acceptance is complete.", "[ ] Golden task acceptance is complete."), "utf8");
    editTaskStatus(tasksMdPath, "T-101", "backlog", "done");

    const handle = StoreHandle.open(result.storeDir);
    assert.throws(
      () => reconcileAccept(handle, repoDir, "T-101", "reconciler-actor"),
      /no acceptance revision exists in the store/
    );
    assert.equal(handle.listEvents().filter(event => event.eventType === "task.patched").length, 0);
    assert.equal((handle.db.prepare("SELECT planning_state FROM task_projection WHERE task_id = 'T-101'").get() as { planning_state: string }).planning_state, "backlog");
    handle.close();
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("reconcile detects source-only drift and supports discard and accept", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    const result = importCommit({ cwd: repoDir, actor: "test" });
    const detailPath = path.join(repoDir, "tasks", "T-101.md");
    const legacy = fs.readFileSync(detailPath, "utf8");
    const active = legacy.replace(/^  - estimatedEffort: (.*)$/m, "  - estimatedEffort: $1\n  - estimatedEffortSource: agent-active");
    const handle = StoreHandle.open(result.storeDir);

    fs.writeFileSync(detailPath, active, "utf8");
    assert.ok(diffTaskForReconcile(handle.db, repoDir, "T-101").detailFields.some(field => field.field === "estimatedEffortSource"));
    reconcileDiscard(handle.db, repoDir);
    assert.doesNotMatch(fs.readFileSync(detailPath, "utf8"), /estimatedEffortSource:/);

    fs.writeFileSync(detailPath, active, "utf8");
    reconcileAccept(handle, repoDir, "T-101", "reconciler");
    assert.equal((handle.db.prepare("SELECT estimated_effort_source FROM task_detail_projection WHERE task_id = 'T-101'").get() as { estimated_effort_source: string }).estimated_effort_source, "agent-active");
    assert.match(fs.readFileSync(detailPath, "utf8"), /estimatedEffortSource: agent-active/);

    fs.writeFileSync(detailPath, legacy, "utf8");
    assert.ok(diffTaskForReconcile(handle.db, repoDir, "T-101").detailFields.some(field => field.field === "estimatedEffortSource"));
    reconcileAccept(handle, repoDir, "T-101", "reconciler");
    assert.doesNotMatch(fs.readFileSync(detailPath, "utf8"), /estimatedEffortSource:/);
    handle.close();
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("reconcile stamps edited legacy effort active and refuses invalid authored planning", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  try {
    const result = importCommit({ cwd: repoDir, actor: "test" });
    const detailPath = path.join(repoDir, "tasks", "T-101.md");
    const original = fs.readFileSync(detailPath, "utf8");
    const handle = StoreHandle.open(result.storeDir);
    const effortLine = original.match(/^  - estimatedEffort: (.*)$/m)?.[0];
    assert.ok(effortLine);
    fs.writeFileSync(detailPath, original.replace(effortLine, "  - estimatedEffort: 4d\n  - estimatedEffortSource: legacy-human"), "utf8");
    reconcileAccept(handle, repoDir, "T-101", "reconciler");
    assert.match(fs.readFileSync(detailPath, "utf8"), /estimatedEffortSource: agent-active/);

    const omittedSourceEdit = fs.readFileSync(detailPath, "utf8")
      .replace("estimatedEffort: 4d", "estimatedEffort: 5d")
      .replace(/^  - estimatedEffortSource: agent-active\n/m, "");
    fs.writeFileSync(detailPath, omittedSourceEdit, "utf8");
    reconcileAccept(handle, repoDir, "T-101", "reconciler");
    assert.match(fs.readFileSync(detailPath, "utf8"), /estimatedEffort: 5d\n  - estimatedEffortSource: agent-active/);

    const active = fs.readFileSync(detailPath, "utf8");
    for (const invalid of ["0.0000001m", `${"9".repeat(400)}w`]) {
      fs.writeFileSync(detailPath, active.replace("estimatedEffort: 5d", `estimatedEffort: ${invalid}`), "utf8");
      assert.throws(() => reconcileAccept(handle, repoDir, "T-101", "reconciler"), /Invalid estimatedEffort/);
    }
    fs.writeFileSync(detailPath, active.replace("estimatedEffortSource: agent-active", "estimatedEffortSource: bogus"), "utf8");
    assert.throws(() => reconcileAccept(handle, repoDir, "T-101", "reconciler"), /Invalid estimatedEffortSource/);
    fs.writeFileSync(detailPath, active, "utf8");
    const boardPath = path.join(repoDir, "TASKS.md");
    fs.writeFileSync(boardPath, fs.readFileSync(boardPath, "utf8").replace("- workload: null", "- workload: Medium"), "utf8");
    assert.throws(() => reconcileAccept(handle, repoDir, "T-101", "reconciler"), /Invalid workload/);
    assert.equal(handle.listEvents().filter(event => event.eventType === "task.patched").length, 2);
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

    const status = validateStoreRegime(repoDir);
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
    assert.equal(validateStoreRegime(repoDir).status, "store-authority");

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

    const status = validateStoreRegime(repoDir);
    assert.equal(status.status, "store-authority", "operational validation ignores snapshot order");
    const snapshots = checkStoreSnapshots(repoDir, repoDir);
    assert.equal(snapshots.status, "store-authority");
    if (snapshots.status === "store-authority") assert.equal(snapshots.drift.hasDrift, true, "explicit snapshot inspection detects swapped blocks");
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

    const status = validateStoreRegime(repoDir);
    assert.equal(status.status, "store-authority", "operational validation ignores local prose drift");
    const snapshots = checkStoreSnapshots(repoDir, repoDir);
    assert.equal(snapshots.status, "store-authority");
    if (snapshots.status === "store-authority") assert.equal(snapshots.drift.hasDrift, true, "explicit inspection retains byte-level drift detection");
  } finally {
    restoreEnv();
    cleanupDir(repoDir);
  }
});
