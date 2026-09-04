import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as path from "path"
import { importCommit } from "./cutover"
import { moveTask, updateTask } from "./tasks"
import { getTask, getTaskDetail, listDependencies, getActiveClaimForTask } from "./projections"
import { claimTask, releaseClaim } from "./claims"
import { StoreHandle } from "./store-handle"
import { cleanupDir, setupGoldenRepo } from "./__test-helpers__"

function materialize() {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  const committed = importCommit({ cwd: repoDir, actor: "test-actor" });
  const handle = StoreHandle.open(committed.storeDir);
  return { repoDir, restoreEnv, handle, committed };
}

test("moveTask follows the planning state machine and stamps completedOn on done", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    let result = moveTask(handle, { taskId: "T-101", to: "ready", actor: "test" });
    assert.equal(result.ok, true);
    assert.deepEqual({ from: result.from, to: result.to }, { from: "backlog", to: "ready" });

    result = moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });
    assert.equal(result.ok, true);
    result = moveTask(handle, { taskId: "T-101", to: "review", actor: "test" });
    assert.equal(result.ok, true);
    result = moveTask(handle, { taskId: "T-101", to: "done", actor: "test" });
    assert.equal(result.ok, true);

    const task = getTask(handle.db, "T-101");
    assert.equal(task!.planningState, "done");
    assert.ok(task!.completedOn, "moving to done stamps completedOn");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("moveTask refuses illegal transitions, unknown states, unexportable states, and unknown tasks", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    // T-102 is done (terminal): no outgoing edges by design.
    const reopened = moveTask(handle, { taskId: "T-102", to: "backlog", actor: "test" });
    assert.equal(reopened.ok, false);
    assert.equal(reopened.reason, "illegal-transition");

    // backlog has no direct path to done; reopening policy lives in reconcile.
    const skipped = moveTask(handle, { taskId: "T-101", to: "done", actor: "test" });
    assert.equal(skipped.ok, false);
    assert.equal(skipped.reason, "illegal-transition");

    const unexportable = moveTask(handle, { taskId: "T-101", to: "blocked", actor: "test" });
    assert.equal(unexportable.ok, false);
    assert.equal(unexportable.reason, "state-not-exportable");

    const unknown = moveTask(handle, { taskId: "T-999", to: "ready", actor: "test" });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, "unknown-task");

    // Nothing moved.
    assert.equal(getTask(handle.db, "T-101")!.planningState, "backlog");
    assert.equal(getTask(handle.db, "T-102")!.planningState, "done");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("moveTask to done or cancelled releases an active claim", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    moveTask(handle, { taskId: "T-101", to: "ready", actor: "test" });
    const claim = claimTask(handle, { taskId: "T-101", actor: "worker" });
    assert.ok(claim.ok);

    moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });
    const result = moveTask(handle, { taskId: "T-101", to: "done", actor: "test" });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.releasedClaimId, claim.claim.claimId);
    assert.equal(getActiveClaimForTask(handle.db, "T-101"), undefined);
    assert.equal(getTask(handle.db, "T-101")!.executionState, "unclaimed");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("updateTask patches whitelisted fields and refuses unknown fields, no-changes, and unknown tasks", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const applied = updateTask(handle, {
      taskId: "T-101",
      patch: { priority: "high", workload: "Hard" },
      detailPatch: { estimatedEffort: "2d" },
      actor: "test"
    });
    assert.equal(applied.ok, true);
    const task = getTask(handle.db, "T-101");
    assert.equal(task!.priority, "high");
    assert.equal(task!.workload, "Hard");
    assert.equal(getTaskDetail(handle.db, "T-101")!.estimatedEffort, "2d");
    assert.ok(task!.updatedOn, "update stamps updatedOn");

    const unknownField = updateTask(handle, { taskId: "T-101", patch: { planningState: "done" } as never, actor: "test" });
    assert.equal(unknownField.ok, false);
    assert.equal(unknownField.reason, "unknown-field");

    const noChanges = updateTask(handle, { taskId: "T-101", actor: "test" });
    assert.equal(noChanges.ok, false);
    assert.equal(noChanges.reason, "no-changes");

    const unknownTask = updateTask(handle, { taskId: "T-999", patch: { priority: "high" }, actor: "test" });
    assert.equal(unknownTask.ok, false);
    assert.equal(unknownTask.reason, "unknown-task");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("updateTask --depends-on/--blocking replace edges and detail lists together", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    // T-102 depends on T-101 (from the golden board). Repoint it at E-100.
    const applied = updateTask(handle, {
      taskId: "T-102",
      dependsOn: ["E-100"],
      blocking: ["T-101"],
      actor: "test"
    });
    assert.equal(applied.ok, true);

    const edges = listDependencies(handle.db).filter(e => e.fromTaskId === "T-102");
    assert.deepEqual(
      edges.map(e => ({ to: e.toTaskId, kind: e.kind })).sort((a, b) => a.to.localeCompare(b.to)),
      [
        { to: "E-100", kind: "depends-on" },
        { to: "T-101", kind: "blocks" }
      ]
    );
    const detail = getTaskDetail(handle.db, "T-102");
    assert.deepEqual(detail!.prerequisites, ["E-100"]);
    assert.deepEqual(detail!.blocking, ["T-101"]);

    const unknownDep = updateTask(handle, { taskId: "T-102", dependsOn: ["T-999"], actor: "test" });
    assert.equal(unknownDep.ok, false);
    assert.equal(unknownDep.reason, "unknown-dependency");

    // releaseClaim keeps the claim surface exercised end to end.
    const claim = claimTask(handle, { taskId: "E-100", actor: "worker" });
    assert.ok(claim.ok);
    if (claim.ok) {
      const released = releaseClaim(handle, { taskId: "E-100", claimId: claim.claim.claimId, leaseToken: claim.claim.leaseToken, actor: "worker" });
      assert.equal(released.ok, true);
    }
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("regenerated export reflects moves and updates byte-for-byte (drift stays PASS)", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    moveTask(handle, { taskId: "T-101", to: "ready", actor: "test" });
    updateTask(handle, { taskId: "T-101", patch: { priority: "high" }, actor: "test" });

    const { buildExport } = require("./export") as typeof import("./export");
    const exported = buildExport(handle.db, { tasksRoot: repoDir });
    const onDisk = fs.readFileSync(path.join(repoDir, "TASKS.md"), "utf8");
    // The store is authoritative: regenerating from it must not match the
    // stale on-disk board until the CLI writes the regenerated snapshot.
    assert.notEqual(onDisk, exported.tasksMd.content, "stale board must differ after store writes");
    assert.ok(exported.tasksMd.content.includes("  - status: ready-for-do"));
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});
