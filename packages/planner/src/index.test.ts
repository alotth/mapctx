import assert from "node:assert/strict";
import test from "node:test";
import { planExecution } from "./index";

const claim = (claimId: string, taskId: string, paths: string[], mode: "read" | "write" = "write") => ({
  claimId,
  taskId,
  domains: ["CODE"],
  paths,
  mode,
  confidence: "high" as const,
  provenance: "authored" as const
});

test("DAG waves serialize colliding writes and expose per-claim explanation", () => {
  const report = planExecution({
    tasks: [
      { id: "T-C", title: "independent", status: "backlog", type: "task", dependsOn: ["T-A"] },
      { id: "T-B", title: "same file", status: "backlog", type: "task" },
      { id: "T-A", title: "first", status: "backlog", type: "task" }
    ],
    claims: [
      claim("00000000-0000-5000-8000-000000000001", "T-A", ["src/shared.ts"]),
      claim("00000000-0000-5000-8000-000000000002", "T-B", ["src/shared.ts"])
    ]
  });

  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B", "T-C"]]);
  assert.equal(report.serializedPairs.length, 1);
  const pair = report.serializedPairs[0];
  assert.deepEqual([pair.taskAId, pair.taskBId], ["T-A", "T-B"]);
  assert.deepEqual(pair.taskAClaimIds, ["00000000-0000-5000-8000-000000000001"]);
  assert.deepEqual(pair.taskBClaimIds, ["00000000-0000-5000-8000-000000000002"]);
  assert.deepEqual(pair.causes[0].paths, ["src/shared.ts ↔ src/shared.ts"]);
  assert.equal(report.policy.scheduling, "collision-aware");
  assert.equal(report.policy.claimsAreAdvisory, true);
  assert.equal(report.policy.correctnessBackstop, "worktree-merge");
});

test("same board gives byte-identical output regardless of task input order", () => {
  const input: Parameters<typeof planExecution>[0] = {
    tasks: [
      { id: "T-3", status: "ready-for-do", type: "task", domains: ["B"] },
      { id: "T-1", status: "backlog", type: "task", domains: ["A"] },
      { id: "T-2", status: "backlog", type: "task", domains: ["B"] }
    ]
  };
  const first = planExecution(input);
  const second = planExecution({ ...input, tasks: [...input.tasks].reverse() });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("paused/review/doing statuses and container epics are excluded; leaf work is recommended", () => {
  const report = planExecution({
    tasks: [
      { id: "E-1", title: "container", status: "ready-for-do", type: "epic" },
      { id: "T-1", title: "leaf", status: "ready-for-do", type: "task", parentId: "E-1" },
      { id: "T-2", title: "paused", status: "paused", type: "task" },
      { id: "T-3", title: "review", status: "review", type: "task" },
      { id: "T-4", title: "already running", status: "doing", type: "task" },
      { id: "T-5", title: "finished", status: "done", type: "task" }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-1"]]);
  assert.deepEqual(report.recommendedNext, ["T-1"]);
  assert.deepEqual(report.excludedTaskIds, ["E-1", "T-2", "T-3", "T-4", "T-5"]);
  assert.deepEqual(report.runnableTaskIds, ["T-1"]);
  assert.deepEqual(report.graphTaskIds, ["E-1", "T-1", "T-2", "T-3", "T-4"]);
});

test("dependency on paused work and workflow gates have named blocking reasons", () => {
  const report = planExecution({
    tasks: [
      { id: "T-1", status: "paused", type: "task" },
      { id: "T-2", status: "backlog", type: "task", dependsOn: ["T-1"] },
      {
        id: "T-3",
        status: "backlog",
        type: "task",
        workflowGates: [{ name: "architecture", status: "pending", reason: null, evidence: [] }]
      }
    ]
  });
  assert.deepEqual(report.waves, []);
  assert.deepEqual(report.blockedTaskIds, ["T-2", "T-3"]);
  assert.ok(report.blockedReasons.some(reason => reason.message === "blocked by paused T-1"));
  assert.ok(report.blockedReasons.some(reason => reason.message === "blocked by workflow gate architecture (pending)"));
});

test("depends-on edge: from waits on to", () => {
  // {from: T-A, to: T-B, kind: depends-on} means T-A depends on T-B, so T-A must wait.
  const report = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task" },
      { id: "T-B", status: "backlog", type: "task" }
    ],
    dependencyEdges: [{ fromTaskId: "T-A", toTaskId: "T-B", kind: "depends-on" }]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-B"], ["T-A"]]);
});

test("blocks edge: to waits on from", () => {
  // {from: T-A, to: T-B, kind: blocks} means T-A blocks T-B, so T-B must wait.
  const report = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task" },
      { id: "T-B", status: "backlog", type: "task" }
    ],
    dependencyEdges: [{ fromTaskId: "T-A", toTaskId: "T-B", kind: "blocks" }]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]]);
});

test("ready task depending on a completed task schedules and is not dropped (regression for T-063)", () => {
  const report = planExecution({
    tasks: [
      { id: "T-DONE", status: "done", type: "task" },
      { id: "T-READY", status: "backlog", type: "task" }
    ],
    dependencyEdges: [{ fromTaskId: "T-READY", toTaskId: "T-DONE", kind: "depends-on" }]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-READY"]]);
  assert.deepEqual(report.cycleTaskIds, []);
});

test("tasks stuck in a dependency cycle are named in blockedReasons, not silently dropped", () => {
  const report = planExecution({
    tasks: [
      { id: "T-1", status: "backlog", type: "task" },
      { id: "T-2", status: "backlog", type: "task" }
    ],
    dependencyEdges: [
      { fromTaskId: "T-1", toTaskId: "T-2", kind: "depends-on" },
      { fromTaskId: "T-2", toTaskId: "T-1", kind: "depends-on" }
    ]
  });
  assert.deepEqual(report.waves, []);
  assert.deepEqual(report.cycleTaskIds, ["T-1", "T-2"]);
  assert.deepEqual(
    report.blockedReasons.filter(reason => reason.kind === "cycle").map(reason => reason.taskId).sort(),
    ["T-1", "T-2"]
  );
});

test("completeness invariant: every non-terminal, non-container task appears in a wave or in blockedReasons", () => {
  const report = planExecution({
    tasks: [
      { id: "E-1", title: "container", status: "ready-for-do", type: "epic" },
      { id: "T-1", title: "leaf", status: "ready-for-do", type: "task", parentId: "E-1" },
      { id: "T-2", title: "paused", status: "paused", type: "task" },
      { id: "T-3", title: "review", status: "review", type: "task" },
      { id: "T-4", title: "already running", status: "doing", type: "task" },
      { id: "T-5", title: "finished", status: "done", type: "task" },
      { id: "T-6", status: "backlog", type: "task" },
      { id: "T-7", status: "backlog", type: "task" }
    ],
    dependencyEdges: [
      { fromTaskId: "T-6", toTaskId: "T-7", kind: "depends-on" },
      { fromTaskId: "T-7", toTaskId: "T-6", kind: "depends-on" }
    ]
  });
  const accountedFor = new Set([...Object.keys(report.waveByTaskId), ...report.blockedReasons.map(reason => reason.taskId)]);
  const containers = new Set(["E-1"]);
  const terminal = new Set(["T-5"]);
  for (const task of ["E-1", "T-1", "T-2", "T-3", "T-4", "T-5", "T-6", "T-7"]) {
    if (containers.has(task) || terminal.has(task)) continue;
    assert.ok(accountedFor.has(task), `expected ${task} to appear in a wave or blockedReasons`);
  }
});

test("executor capacity limits each wave without changing collision explanation", () => {
  const report = planExecution({
    executorCapacity: 1,
    tasks: [
      { id: "T-1", status: "backlog", type: "task" },
      { id: "T-2", status: "backlog", type: "task" }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-1"], ["T-2"]]);
  assert.deepEqual(report.serializedPairs, []);
});
