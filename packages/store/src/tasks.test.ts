import assert from "node:assert/strict"
import test from "node:test"
import { parseAcceptanceChecklist } from "@mapctx/core"
import * as fs from "fs"
import * as path from "path"
import { importCommit } from "./cutover"
import { createTask, moveTask, reopenTask, updateTask } from "./tasks"
import { approveAcceptanceCriterion, reviseAcceptance } from "./acceptance"
import { getAcceptance, getTask, getTaskDetail, listDependencies, getActiveClaimForTask } from "./projections"
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

/**
 * T-157: proves edges and the detail prerequisites/blocking lists never
 * diverge across all four dependsOn/blocking supplied-or-not combinations,
 * plus clearing. Reads both surfaces after every step so a regression that
 * only re-breaks the unsupplied kind (the exact bug in 5886fd5) still fails
 * the assertion, instead of only checking the list just written.
 */
function assertEdgesMatchDetail(handle: StoreHandle, taskId: string): { dependsOn: string[]; blocking: string[] } {
  const edges = listDependencies(handle.db).filter(e => e.fromTaskId === taskId);
  const dependsOn = edges.filter(e => e.kind === "depends-on").map(e => e.toTaskId).sort();
  const blocking = edges.filter(e => e.kind === "blocks").map(e => e.toTaskId).sort();
  const detail = getTaskDetail(handle.db, taskId);
  assert.deepEqual([...detail!.prerequisites].sort(), dependsOn, "detail.prerequisites must match depends-on edges");
  assert.deepEqual([...detail!.blocking].sort(), blocking, "detail.blocking must match blocks edges");
  return { dependsOn, blocking };
}

test("updateTask never lets depends-on/blocks edges diverge from detail.prerequisites/blocking, across all flag combinations", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const extra1 = createTask(handle, { title: "extra target 1", actor: "test" });
    const extra2 = createTask(handle, { title: "extra target 2", actor: "test" });
    const extra3 = createTask(handle, { title: "extra target 3", actor: "test" });
    assert.ok(extra1.ok && extra2.ok && extra3.ok);
    if (!extra1.ok || !extra2.ok || !extra3.ok) return;

    const subject = createTask(handle, {
      title: "subject with both edge kinds",
      dependsOn: ["T-101"],
      blocking: ["T-102"],
      actor: "test"
    });
    assert.ok(subject.ok);
    if (!subject.ok) return;
    const taskId = subject.taskId;

    let state = assertEdgesMatchDetail(handle, taskId);
    assert.deepEqual(state, { dependsOn: ["T-101"], blocking: ["T-102"] }, "subject seeded with both edge kinds");

    // (1) both flags supplied: both kinds replaced.
    assert.equal(updateTask(handle, { taskId, dependsOn: ["E-100"], blocking: [extra1.taskId], actor: "test" }).ok, true);
    state = assertEdgesMatchDetail(handle, taskId);
    assert.deepEqual(state, { dependsOn: ["E-100"], blocking: [extra1.taskId] });

    // (2) only dependsOn supplied: blocks edges AND detail.blocking must be
    // untouched -- this is the exact regression that reverts if the T-157
    // fix is undone.
    assert.equal(updateTask(handle, { taskId, dependsOn: [extra2.taskId], actor: "test" }).ok, true);
    state = assertEdgesMatchDetail(handle, taskId);
    assert.deepEqual(state, { dependsOn: [extra2.taskId], blocking: [extra1.taskId] }, "blocks surface survives a dependsOn-only patch");

    // (3) only blocking supplied: mirror of (2).
    assert.equal(updateTask(handle, { taskId, blocking: [extra3.taskId], actor: "test" }).ok, true);
    state = assertEdgesMatchDetail(handle, taskId);
    assert.deepEqual(state, { dependsOn: [extra2.taskId], blocking: [extra3.taskId] }, "depends-on surface survives a blocking-only patch");

    // (4) neither flag supplied: both surfaces untouched, applied.edges is false.
    const neither = updateTask(handle, { taskId, patch: { priority: "high" }, actor: "test" });
    assert.equal(neither.ok, true);
    assert.ok(neither.ok && neither.applied.edges === false, JSON.stringify(neither));
    state = assertEdgesMatchDetail(handle, taskId);
    assert.deepEqual(state, { dependsOn: [extra2.taskId], blocking: [extra3.taskId] });

    // Clearing: dependsOn: [] removes only the depends-on edges/list.
    assert.equal(updateTask(handle, { taskId, dependsOn: [], actor: "test" }).ok, true);
    state = assertEdgesMatchDetail(handle, taskId);
    assert.deepEqual(state, { dependsOn: [], blocking: [extra3.taskId] });
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

// ---------------------------------------------------------------------------
// T-127: externalLinks patching + unknown-field message groups.
// ---------------------------------------------------------------------------

test("T-127 externalLinks accepts https:// and provider:entity:id URIs, clears with null, and rejects malformed entries", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const applied = updateTask(handle, {
      taskId: "T-101",
      patch: { externalLinks: ["https://github.com/o/r/issues/1", "github:issue:42"] },
      actor: "test"
    });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.deepEqual(getTask(handle.db, "T-101")?.externalLinks, ["https://github.com/o/r/issues/1", "github:issue:42"]);

    const cleared = updateTask(handle, { taskId: "T-101", patch: { externalLinks: null as never }, actor: "test" });
    assert.equal(cleared.ok, true);
    assert.deepEqual(getTask(handle.db, "T-101")?.externalLinks, [], "null normalizes to [] before journaling");

    for (const bad of ["foo/bar", "https://has space.example/x", ""]) {
      const refused = updateTask(handle, { taskId: "T-101", patch: { externalLinks: [bad] }, actor: "test" });
      assert.equal(refused.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
      if (!refused.ok) assert.equal(refused.reason, "invalid-external-links");
      assert.deepEqual(getTask(handle.db, "T-101")?.externalLinks, [], "a refused patch must not land");
    }
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("T-127 unknown-field refusal names both field groups and redirects a field used on the wrong side", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const wrongSide = updateTask(handle, { taskId: "T-101", patch: { filesAffected: ["a", "b"] } as never, actor: "test" });
    assert.equal(wrongSide.ok, false);
    if (!wrongSide.ok) {
      assert.equal(wrongSide.reason, "unknown-field");
      assert.match(wrongSide.message ?? "", /detail field|detail\.filesAffected/);
      assert.match(wrongSide.message ?? "", /--set detail\.filesAffected=/);
      assert.match(wrongSide.message ?? "", /Detail fields \(prefix each with `detail\.`\):/);
      assert.match(wrongSide.message ?? "", /Task fields:/);
    }

    const otherWrongSide = updateTask(handle, { taskId: "T-101", detailPatch: { title: "x" } as never, actor: "test" });
    assert.equal(otherWrongSide.ok, false);
    if (!otherWrongSide.ok) {
      assert.match(otherWrongSide.message ?? "", /It is a task field: use `--set title=\.\.\.` without the `detail\.` prefix\./);
    }

    const noField = updateTask(handle, { taskId: "T-101", patch: { nope: 1 } as never, actor: "test" });
    assert.equal(noField.ok, false);
    if (!noField.ok) {
      assert.match(noField.message ?? "", /Task fields:/);
      assert.match(noField.message ?? "", /Detail fields/);
      assert.match(noField.message ?? "", /waitReason/);
      assert.match(noField.message ?? "", /Git-authored `description:` block/);
    }
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// T-127 attempt 2, review A2 (store-level guard): a comma inside a snapshot
// list element is refused for every caller of updateTask, not only through
// the CLI's --set parsing.
// ---------------------------------------------------------------------------

test("T-127 updateTask refuses a comma inside a list element in tags, externalLinks, and detail.filesAffected, journaling nothing; a comma-free value still lands", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const beforeTags = getTask(handle.db, "T-101")?.tags;
    const beforeLinks = getTask(handle.db, "T-101")?.externalLinks;
    const beforeFiles = getTaskDetail(handle.db, "T-101")?.filesAffected;

    const tagsRefused = updateTask(handle, { taskId: "T-101", patch: { tags: ["a,b"] }, actor: "test" });
    assert.equal(tagsRefused.ok, false);
    if (!tagsRefused.ok) assert.equal(tagsRefused.reason, "comma-in-list-element");
    assert.deepEqual(getTask(handle.db, "T-101")?.tags, beforeTags, "a refused patch must not land");

    const linksRefused = updateTask(handle, { taskId: "T-101", patch: { externalLinks: ["https://x.test/a,b"] }, actor: "test" });
    assert.equal(linksRefused.ok, false);
    if (!linksRefused.ok) assert.equal(linksRefused.reason, "comma-in-list-element");
    assert.deepEqual(getTask(handle.db, "T-101")?.externalLinks, beforeLinks);

    const filesRefused = updateTask(handle, { taskId: "T-101", detailPatch: { filesAffected: ["src/{a,b}.ts"] }, actor: "test" });
    assert.equal(filesRefused.ok, false);
    if (!filesRefused.ok) assert.equal(filesRefused.reason, "comma-in-list-element");
    assert.deepEqual(getTaskDetail(handle.db, "T-101")?.filesAffected, beforeFiles);

    // A comma-free value is unaffected.
    const clean = updateTask(handle, { taskId: "T-101", detailPatch: { filesAffected: ["src/*.ts"] }, actor: "test" });
    assert.equal(clean.ok, true, JSON.stringify(clean));
    assert.deepEqual(getTaskDetail(handle.db, "T-101")?.filesAffected, ["src/*.ts"]);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("T-127 attempt 2 (review A4) externalLinks allowlist: refuses javascript/data/file/vbscript/blob schemes and a 3-part javascript ref; accepts http(s) with a host and provider:entity:id", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html;x", "vbscript:x", "blob:http://x/y", "javascript:a:b", "ftp://x.test/a", "https://"]) {
      const refused = updateTask(handle, { taskId: "T-101", patch: { externalLinks: [bad] }, actor: "test" });
      assert.equal(refused.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
      if (!refused.ok) assert.equal(refused.reason, "invalid-external-links", `${bad}: ${JSON.stringify(refused)}`);
    }
    for (const good of ["https://github.com/o/r/issues/1", "http://x.test/a", "github:issue:42", "traycer:artifact:abc:def"]) {
      const accepted = updateTask(handle, { taskId: "T-101", patch: { externalLinks: [good] }, actor: "test" });
      assert.equal(accepted.ok, true, `expected acceptance for ${JSON.stringify(good)}: ${JSON.stringify(accepted)}`);
      assert.deepEqual(getTask(handle.db, "T-101")?.externalLinks, [good]);
    }
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// T-127 review B2: createTask is a caller of the comma-in-list-element
// invariant too, not only updateTask. Unreachable from the CLI (parseListInput
// refuses both spellings on `task create`), but @mapctx/store is a published
// package and createTask is exported, so a programmatic caller could still
// produce the exact non-convergent drift the review reproduced.
// ---------------------------------------------------------------------------

test("T-127 review B2: createTask refuses a comma inside tags, domains, detail.filesAffected, dependsOn, and blocking; nothing is created", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const cases: Array<Partial<Parameters<typeof createTask>[1]>> = [
      { tags: ["a,b"] },
      { domains: ["a,b"] },
      { detail: { filesAffected: ["x,y"] } },
      { dependsOn: ["T-101,T-102"] },
      { blocking: ["T-101,T-102"] }
    ];
    for (const extra of cases) {
      const result = createTask(handle, { title: "comma probe", actor: "test", ...extra } as never);
      assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(extra)}`);
      if (!result.ok) assert.equal(result.reason, "comma-in-list-element", JSON.stringify(result));
    }
    // Nothing was created: the board still ends at T-102.
    assert.equal(getTask(handle.db, "T-103"), undefined);

    // A comma-free create still succeeds.
    const clean = createTask(handle, { title: "clean probe", tags: ["a", "b"], actor: "test" });
    assert.equal(clean.ok, true, JSON.stringify(clean));
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// T-127 attempt 4, review B5/B6/B7: userinfo credentials refused, the
// provider:entity:id form is case-insensitive, and a length cap applies.
// ---------------------------------------------------------------------------

test("T-127 review B5: externalLinks refuses userinfo credentials and redacts the password in the refusal message", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const SECRET = "sw0rdf1sh";
    const refused = updateTask(handle, { taskId: "T-101", patch: { externalLinks: [`https://user:${SECRET}@x.test/a`] }, actor: "test" });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.reason, "invalid-external-links");
      assert.ok(!(refused.message ?? "").includes(SECRET), `message must not echo the password in clear: ${refused.message}`);
      assert.match(refused.message ?? "", /\*\*\*@/);
    }
    assert.deepEqual(getTask(handle.db, "T-101")?.externalLinks, []);

    // A link with no userinfo still works.
    const accepted = updateTask(handle, { taskId: "T-101", patch: { externalLinks: ["https://x.test/a"] }, actor: "test" });
    assert.equal(accepted.ok, true);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("T-127 review B6: provider:entity:id matches case-insensitively, like http(s); dangerous schemes still refused under any case", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    for (const good of ["GitHub:issue:42", "github:issue:42", "HTTPS://x.test/a"]) {
      const accepted = updateTask(handle, { taskId: "T-101", patch: { externalLinks: [good] }, actor: "test" });
      assert.equal(accepted.ok, true, `expected acceptance for ${JSON.stringify(good)}: ${JSON.stringify(accepted)}`);
    }
    for (const bad of ["JaVaScRiPt:alert(1)", "FILE:///etc/passwd", "javascript:a:b"]) {
      const refused = updateTask(handle, { taskId: "T-101", patch: { externalLinks: [bad] }, actor: "test" });
      assert.equal(refused.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
      if (!refused.ok) assert.equal(refused.reason, "invalid-external-links");
    }
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("T-127 review B7: a 2048-character link is accepted, 2049 is refused citing the limit; an unknown scheme:word:rest shape is accepted by design", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const prefix = "https://x.test/";
    const makeLink = (totalLength: number) => prefix + "a".repeat(totalLength - prefix.length);
    const exactly2048 = makeLink(2048);
    assert.equal(exactly2048.length, 2048);
    const accepted = updateTask(handle, { taskId: "T-101", patch: { externalLinks: [exactly2048] }, actor: "test" });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));

    const over = makeLink(2049);
    assert.equal(over.length, 2049);
    const refused = updateTask(handle, { taskId: "T-101", patch: { externalLinks: [over] }, actor: "test" });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.message ?? "", /2048/);

    // Documented pass-through: any lowercase scheme:word:rest shape is
    // accepted even for an unknown provider (import.ts maps it to "other").
    for (const shape of ["htps:a:b", "ssh:host:22"]) {
      const shapeAccepted = updateTask(handle, { taskId: "T-101", patch: { externalLinks: [shape] }, actor: "test" });
      assert.equal(shapeAccepted.ok, true, `expected ${shape} to be accepted by design: ${JSON.stringify(shapeAccepted)}`);
    }
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// T-129 criterion 0: createTask with `acceptance` records both events
// atomically (same write transaction as task.upserted).
// ---------------------------------------------------------------------------

test("T-129 createTask with acceptance records revision 1 in the same transaction: acceptanceRevision in the result, criteria pending in order via acceptance show", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const created = createTask(handle, {
      title: "Atomic acceptance",
      acceptance: { condition: "criteria", texts: ["First criterion", "Second criterion"] },
      actor: "test"
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) return;
    assert.equal(created.acceptanceRevision, 1);

    const acceptance = getAcceptance(handle.db, created.taskId);
    assert.ok(acceptance);
    assert.equal(acceptance!.revision, 1);
    assert.deepEqual(acceptance!.criteria.map(c => c.text), ["First criterion", "Second criterion"]);
    assert.ok(acceptance!.criteria.every(c => c.state === "pending"));
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("T-129 createTask without acceptance reports acceptanceRevision: null", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const created = createTask(handle, { title: "No acceptance here", actor: "test" });
    assert.equal(created.ok, true);
    if (created.ok) assert.equal(created.acceptanceRevision, null);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("MUTATION GUARD: createTask refuses invalid acceptance shapes (criteria with no texts, empty with texts, a blank text) with reason invalid-acceptance, and creates nothing", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const cases: Array<{ condition: "criteria" | "empty"; texts: string[] }> = [
      { condition: "criteria", texts: [] },
      { condition: "empty", texts: ["should not be here"] },
      { condition: "criteria", texts: ["ok", "   "] }
    ];
    for (const acceptance of cases) {
      const result = createTask(handle, { title: "invalid acceptance probe", acceptance, actor: "test" });
      assert.equal(result.ok, false, `expected refusal for ${JSON.stringify(acceptance)}`);
      if (!result.ok) assert.equal(result.reason, "invalid-acceptance", JSON.stringify(result));
    }
    // Nothing was created: the board still ends at T-102 (no T-103).
    assert.equal(getTask(handle.db, "T-103"), undefined);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});
