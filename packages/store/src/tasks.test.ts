import assert from "node:assert/strict"
import test from "node:test"
import { parseAcceptanceChecklist } from "@mapctx/core"
import * as fs from "fs"
import * as path from "path"
import { importCommit } from "./cutover"
import { createTask, moveTask, reopenTask, updateTask } from "./tasks"
import { approveAcceptanceCriterion, reviseAcceptance } from "./acceptance"
import { getTask, getTaskDetail, listDependencies, getActiveClaimForTask } from "./projections"
import { claimTask, releaseClaim } from "./claims"
import { StoreHandle } from "./store-handle"
import { buildExport } from "./export"
import { cleanupDir, setupGoldenRepo } from "./__test-helpers__"

function materialize() {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  const committed = importCommit({ cwd: repoDir, actor: "test-actor" });
  const handle = StoreHandle.open(committed.storeDir);
  return { repoDir, restoreEnv, handle, committed };
}

/** T-120: the done gate reads store acceptance; tests author + approve it explicitly. */
function approveAllCriteria(handle: StoreHandle, taskId: string, texts: string[]): void {
  const revised = reviseAcceptance(handle, { taskId, condition: "criteria", texts, actor: "test", expectRevision: 0 });
  assert.ok(revised.ok, JSON.stringify(revised));
  if (!revised.ok) return;
  revised.criteria.forEach((criterion, index) => {
    const approved = approveAcceptanceCriterion(handle, { taskId, index, actor: "test", expectRevision: revised.revision });
    assert.ok(approved.ok, JSON.stringify(approved));
  });
}

test("waitReason validates and survives projection reads", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    assert.equal(updateTask(handle, { taskId: "T-101", detailPatch: { waitReason: "decision" }, actor: "test" }).ok, true);
    assert.equal(getTaskDetail(handle.db, "T-101")?.waitReason, "decision");
    const invalid = updateTask(handle, { taskId: "T-101", detailPatch: { waitReason: "unsure" as never }, actor: "test" });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.reason, "invalid-wait-reason");
    assert.equal(getTaskDetail(handle.db, "T-101")?.waitReason, "decision");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("T-102 predictedStart patches, validates, clears, and survives projection reads", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    assert.equal(getTask(handle.db, "T-101")?.predictedStart ?? null, null);
    const applied = updateTask(handle, {
      taskId: "T-101",
      patch: { predictedStart: { start: "2026-10-15", method: "manual", confidence: "low" } },
      actor: "test"
    });
    assert.equal(applied.ok, true);
    assert.deepEqual(getTask(handle.db, "T-101")?.predictedStart, { start: "2026-10-15", method: "manual", confidence: "low" });
    const badDate = updateTask(handle, {
      taskId: "T-101",
      patch: { predictedStart: { start: "tomorrow", method: "manual", confidence: "low" } as never },
      actor: "test"
    });
    assert.equal(badDate.ok, false);
    if (!badDate.ok) assert.equal(badDate.reason, "invalid-predicted-start");
    const badMethod = updateTask(handle, {
      taskId: "T-101",
      patch: { predictedStart: { start: "2026-10-15", method: "guess", confidence: "low" } as never },
      actor: "test"
    });
    assert.equal(badMethod.ok, false);
    assert.deepEqual(getTask(handle.db, "T-101")?.predictedStart, { start: "2026-10-15", method: "manual", confidence: "low" });
    assert.equal(updateTask(handle, { taskId: "T-101", patch: { predictedStart: null }, actor: "test" }).ok, true);
    assert.equal(getTask(handle.db, "T-101")?.predictedStart ?? null, null);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("createTask retains waitReason through event, projection, and export; rejects invalid input", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const created = createTask(handle, { id: "T-900", title: "Wait reason", workload: "Normal", detail: { estimatedEffort: "1d", waitReason: "decision" }, actor: "test" });
    assert.equal(created.ok, true);
    assert.equal(getTaskDetail(handle.db, "T-900")?.waitReason, "decision");
    const exported = buildExport(handle.db, { tasksRoot: repoDir });
    assert.match(exported.taskDetailFiles.find(file => file.path.endsWith("T-900.md"))?.content ?? "", /- waitReason: decision/);
    const invalid = createTask(handle, { id: "T-901", title: "Invalid wait", workload: "Normal", detail: { estimatedEffort: "1d", waitReason: "guess" as never }, actor: "test" });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.reason, "invalid-wait-reason");
    assert.equal(getTask(handle.db, "T-901"), undefined);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("acceptance parser requires explicit checks and keeps nested acceptance headings in scope", () => {
  const parsed = parseAcceptanceChecklist(`
## Acceptance
### Runtime
- [x] First criterion.
- plain criterion without checkbox.
### Evidence
\`\`\`md
- [ ] Example inside code.
\`\`\`
## Steps
- [ ] Outside acceptance.
`)
  assert.equal(parsed.found, true)
  assert.deepEqual(parsed.items, [
    { text: "First criterion.", completed: true },
    { text: "plain criterion without checkbox.", completed: false }
  ])
})

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
    approveAllCriteria(handle, "T-101", ["Golden task acceptance is complete."]);
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

test("reopenTask moves done to review, clears completion, and records audit provenance", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const now = () => new Date("2026-09-16T12:34:56.000Z");
    const result = reopenTask(handle, { taskId: "T-102", to: "review", actor: "reviewer", now });
    assert.deepEqual(result, { ok: true, from: "done", to: "review" });

    const task = getTask(handle.db, "T-102");
    assert.equal(task!.planningState, "review");
    assert.equal(task!.completedOn, null);
    assert.equal(task!.updatedOn, "2026-09-16");

    const events = handle.listEvents().filter(event => event.eventType === "task.patched");
    const reopenEvent = events[events.length - 1];
    assert.equal(reopenEvent!.actor, "reviewer");
    assert.deepEqual((reopenEvent!.payload as { taskId: string; patch: Record<string, unknown>; source: string }), {
      taskId: "T-102",
      patch: { planningState: "review", completedOn: null, updatedOn: "2026-09-16" },
      source: "task-reopen"
    });

    const notDone = reopenTask(handle, { taskId: "T-101", to: "review", actor: "reviewer", now });
    assert.equal(notDone.ok, false);
    if (!notDone.ok) assert.equal(notDone.reason, "not-done");

    const wrongTarget = reopenTask(handle, { taskId: "T-102", to: "doing", actor: "reviewer", now });
    assert.equal(wrongTarget.ok, false);
    if (!wrongTarget.ok) assert.equal(wrongTarget.reason, "unsupported-target");
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
    updateTask(handle, { taskId: "T-101", patch: { workload: "Normal" }, actor: "test" });
    const claim = claimTask(handle, { taskId: "T-101", actor: "worker" });
    assert.ok(claim.ok);

    moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });
    approveAllCriteria(handle, "T-101", ["Golden task acceptance is complete."]);
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

test("moveTask to cancelled releases the claim, stamps no completedOn, exports, and reopens to review", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    moveTask(handle, { taskId: "T-101", to: "ready", actor: "test" });
    updateTask(handle, { taskId: "T-101", patch: { workload: "Normal" }, actor: "test" });
    const claim = claimTask(handle, { taskId: "T-101", actor: "worker" });
    assert.ok(claim.ok);
    moveTask(handle, { taskId: "T-101", to: "in-progress", actor: "test" });

    const result = moveTask(handle, { taskId: "T-101", to: "cancelled", actor: "operator" });
    assert.deepEqual(result, { ok: true, from: "in-progress", to: "cancelled", releasedClaimId: claim.claim!.claimId });
    assert.equal(getTask(handle.db, "T-101")!.planningState, "cancelled");
    assert.equal(getTask(handle.db, "T-101")!.completedOn, null, "cancelled does not stamp completedOn");
    assert.equal(getActiveClaimForTask(handle.db, "T-101"), undefined);

    const { buildExport } = require("./export") as typeof import("./export");
    const exported = buildExport(handle.db, { tasksRoot: repoDir });
    assert.ok(exported.tasksMd.content.includes("  - status: cancelled"), "canonical board represents cancelled");

    // Terminal for normal moves, but reopenable like done/archived.
    const terminalMove = moveTask(handle, { taskId: "T-101", to: "ready", actor: "test" });
    assert.equal(terminalMove.ok, false);
    if (!terminalMove.ok) assert.equal(terminalMove.reason, "illegal-transition");

    const reopened = reopenTask(handle, { taskId: "T-101", to: "review", actor: "operator" });
    assert.deepEqual(reopened, { ok: true, from: "cancelled", to: "review" });
    assert.equal(getTask(handle.db, "T-101")!.planningState, "review");
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
    assert.equal(getTaskDetail(handle.db, "T-101")!.estimatedEffortSource, "agent-active");
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

test("createTask auto-assigns the next free id and lands at the end of the board", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const created = createTask(handle, {
      title: "Created via CLI",
      priority: "high",
      tags: ["cli"],
      domains: ["CORE"],
      dependsOn: ["T-101"],
      detail: { summary: "Custom summary", description: "Prose lives in the file, not the store." },
      actor: "test"
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.taskId, "T-103", "next free sequential id after the golden board");
    assert.deepEqual(created.warnings, [
      "Missing workload. Set it before claim: mapctx task update T-103 --set workload=Normal",
      "Missing estimatedEffort. Set it before claim: mapctx task update T-103 --set detail.estimatedEffort=1d"
    ]);

    const task = getTask(handle.db, "T-103");
    assert.equal(task!.title, "[T-103] Created via CLI", "board convention: heading title carries the bracketed id");
    assert.equal(task!.planningState, "backlog");
    assert.equal(task!.type, "task");
    assert.equal(task!.detailPath, "./tasks/T-103.md");
    const maxPosition = getTask(handle.db, "T-102")!.positionKey;
    assert.ok(task!.positionKey > maxPosition, "new task lands at the end");

    const edges = listDependencies(handle.db).filter(e => e.fromTaskId === "T-103");
    assert.deepEqual(edges, [{ fromTaskId: "T-103", toTaskId: "T-101", kind: "depends-on" }]);
    const detail = getTaskDetail(handle.db, "T-103");
    assert.equal(detail!.summary, "Custom summary");
    assert.deepEqual(detail!.prerequisites, ["T-101"]);
    assert.equal(detail!.estimatedEffort, "", "missing effort is not silently invented");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("createTask refuses duplicate ids, bad types, unknown parents, unknown deps, and unexportable states", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    assert.equal(createTask(handle, { title: "x", id: "T-101", actor: "t" }).ok, false, "duplicate id");
    assert.equal(createTask(handle, { title: "x", id: "E-900", actor: "t" }).ok, false, "id prefix must match type");
    assert.equal(createTask(handle, { title: "x", type: "banana", actor: "t" }).ok, false, "invalid type");
    assert.equal(createTask(handle, { title: "x", parent: "T-999", actor: "t" }).ok, false, "unknown parent");
    assert.equal(createTask(handle, { title: "x", dependsOn: ["T-999"], actor: "t" }).ok, false, "unknown dependency");
    assert.equal(createTask(handle, { title: "x", status: "blocked", actor: "t" }).ok, false, "unexportable state");
    assert.equal(createTask(handle, { title: "  ", actor: "t" }).ok, false, "missing title");

    const epic = createTask(handle, { title: "New epic", type: "epic", actor: "t" });
    assert.equal(epic.ok, true);
    if (epic.ok) assert.match(epic.taskId, /^E-\d+$/, "epic type implies the E- prefix");
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("createTask and updateTask reject noncanonical workload and nonpositive or malformed effort", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const invalidCreates = [
      createTask(handle, { title: "medium", workload: "Medium", detail: { estimatedEffort: "1d" }, actor: "t" }),
      createTask(handle, { title: "unknown", workload: "Banana", detail: { estimatedEffort: "1d" }, actor: "t" }),
      createTask(handle, { title: "malformed", workload: "Normal", detail: { estimatedEffort: "tomorrow" }, actor: "t" }),
      createTask(handle, { title: "zero", workload: "Normal", detail: { estimatedEffort: "0d" }, actor: "t" }),
      createTask(handle, { title: "sub-ms", workload: "Normal", detail: { estimatedEffort: "0.0000001m" }, actor: "t" }),
      createTask(handle, { title: "overflow", workload: "Normal", detail: { estimatedEffort: `${"9".repeat(400)}w` }, actor: "t" })
    ];
    assert.deepEqual(invalidCreates.map(result => result.ok ? "ok" : result.reason), [
      "invalid-workload",
      "invalid-workload",
      "invalid-estimated-effort",
      "invalid-estimated-effort",
      "invalid-estimated-effort",
      "invalid-estimated-effort"
    ]);

    const invalidUpdates = [
      updateTask(handle, { taskId: "T-101", patch: { workload: "Medium" }, actor: "t" }),
      updateTask(handle, { taskId: "T-101", patch: { workload: "Banana" }, actor: "t" }),
      updateTask(handle, { taskId: "T-101", detailPatch: { estimatedEffort: "tomorrow" }, actor: "t" }),
      updateTask(handle, { taskId: "T-101", detailPatch: { estimatedEffort: "0h" }, actor: "t" }),
      updateTask(handle, { taskId: "T-101", detailPatch: { estimatedEffort: "0.0000001m" }, actor: "t" }),
      updateTask(handle, { taskId: "T-101", detailPatch: { estimatedEffort: `${"9".repeat(400)}w` }, actor: "t" })
    ];
    assert.deepEqual(invalidUpdates.map(result => result.ok ? "ok" : result.reason), [
      "invalid-workload",
      "invalid-workload",
      "invalid-estimated-effort",
      "invalid-estimated-effort",
      "invalid-estimated-effort",
      "invalid-estimated-effort"
    ]);
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});

test("updateTask accepts explicit null effort as a clear and removes active provenance", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    assert.equal(updateTask(handle, { taskId: "T-101", patch: { workload: "Normal" }, detailPatch: { estimatedEffort: "2d" }, actor: "t" }).ok, true);
    assert.equal(getTaskDetail(handle.db, "T-101")?.estimatedEffortSource, "agent-active");
    assert.equal(updateTask(handle, { taskId: "T-101", detailPatch: { estimatedEffort: null } as never, actor: "t" }).ok, true);
    assert.equal(getTaskDetail(handle.db, "T-101")?.estimatedEffort, "");
    assert.equal(getTaskDetail(handle.db, "T-101")?.estimatedEffortSource, undefined);
    const claim = claimTask(handle, { taskId: "T-101", actor: "worker" });
    assert.equal(claim.ok, false);
    if (!claim.ok) assert.equal(claim.reason, "missing-workload-or-estimate");
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

test("completed receipt on a task that was never claimed is rejected with the remedy; the retroactive attestation path is accepted", () => {
  const { repoDir, restoreEnv, handle, committed } = materialize();
  try {
    const receiptFor = (dispatchId: string, startedAt: string, endedAt: string) => ({
      schemaVersion: 1,
      dispatchId,
      attempt: 1,
      outcome: "completed" as const,
      startedAt,
      endedAt,
      changedFiles: ["README.md"],
      usageEvents: [],
      evidence: [],
      failure: null
    });

    // Register a dispatch without claiming (the flow error this guard exists for).
    const { recordDispatchAttempt, recordRunReceipt } = require("./dispatch") as typeof import("./dispatch");
    const dispatch = recordDispatchAttempt(handle, {
      dispatch: { dispatchId: "3f0b9550-1111-4111-8111-111111111111", taskId: "T-101", executorKind: "agent", attempt: 1, contextHash: "hash", status: "claimed" }
    }, "orchestrator");
    assert.ok(dispatch.ok);

    const rejected = recordRunReceipt(handle, receiptFor(
      "3f0b9550-1111-4111-8111-111111111111",
      "2026-09-05T10:00:00.000Z",
      "2026-09-05T10:45:00.000Z"
    ), "orchestrator");
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.reason, "task-not-in-progress");
      assert.match(rejected.message!, /claim first/i);
      assert.match(rejected.message!, /retroactive attestation/);
    }

    // The retroactive attestation flow: claim now (carries to doing), then the
    // same receipt with the TRUE historical times is accepted, and the board
    // lands in review without anyone fabricating the in-progress moment.
    updateTask(handle, { taskId: "T-101", patch: { workload: "Normal" }, actor: "operator" });
    const claim = require("./claims").claimTask(handle, { taskId: "T-101", actor: "orchestrator" });
    assert.ok(claim.ok);
    assert.equal(getTask(handle.db, "T-101")!.planningState, "in-progress");

    const accepted = recordRunReceipt(handle, receiptFor(
      "3f0b9550-1111-4111-8111-111111111111",
      "2026-09-05T10:00:00.000Z",
      "2026-09-05T10:45:00.000Z"
    ), "orchestrator");
    assert.equal(accepted.ok, true);
    const task = getTask(handle.db, "T-101");
    assert.equal(task!.planningState, "review");
    assert.equal(task!.executionState, "completed");
    void committed;
  } finally {
    handle.close();
    restoreEnv();
    cleanupDir(repoDir);
  }
});
