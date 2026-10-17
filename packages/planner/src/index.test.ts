import assert from "node:assert/strict";
import test from "node:test";
import { pathsOverlap } from "@mapctx/protocol";
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

test("same inferred domain with disjoint filesAffected stays in one wave", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task", domains: ["CODE"], filesAffected: ["src/a.ts"] },
      { id: "T-B", status: "backlog", type: "task", domains: ["CODE"], filesAffected: ["src/b.ts"] }
    ]
  });

  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A", "T-B"]]);
  assert.deepEqual(report.serializedPairs, []);
});

test("overlapping filesAffected serializes and reports exact path pair", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task", domains: ["CODE"], filesAffected: ["src/shared.ts"] },
      { id: "T-B", status: "backlog", type: "task", domains: ["CODE"], filesAffected: ["src/shared.ts"] }
    ]
  });

  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]]);
  assert.equal(report.serializedPairs.length, 1);
  assert.equal(report.serializedPairs[0].reason, "resource-claim-collision");
  assert.deepEqual(report.serializedPairs[0].causes[0].paths, ["src/shared.ts ↔ src/shared.ts"]);
});

test("path-bearing filesAffected and domain-only inferred sharing a domain is advisory", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task", domains: ["CODE"], filesAffected: ["src/a.ts"] },
      { id: "T-B", status: "backlog", type: "task", domains: ["CODE"] }
    ]
  });

  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A", "T-B"]]);
  assert.deepEqual(report.serializedPairs, []);
  assert.deepEqual(report.advisories?.map(({ taskAId, taskBId, domains }) => ({ taskAId, taskBId, domains })), [
    { taskAId: "T-A", taskBId: "T-B", domains: ["CODE"] }
  ]);
});

test("authored high-confidence domain-only claim serializes against path-bearing claim sharing domain", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task" },
      { id: "T-B", status: "backlog", type: "task" }
    ],
    claims: [
      { claimId: "00000000-0000-5000-8000-000000000021", taskId: "T-A", domains: ["CODE"], paths: [], mode: "write", confidence: "high", provenance: "authored" },
      claim("00000000-0000-5000-8000-000000000022", "T-B", ["src/a.ts"])
    ]
  });

  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]]);
  assert.equal(report.serializedPairs.length, 1);
  assert.deepEqual(report.serializedPairs[0].domains, ["CODE"]);
  assert.deepEqual(report.serializedPairs[0].paths, []);
  assert.deepEqual(report.advisories, []);
});

test("blank paths are ignored and case-folded paths collide", () => {
  const blankPathReport = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task", domains: ["CODE"], filesAffected: ["  "] },
      { id: "T-B", status: "backlog", type: "task", domains: ["CODE"] }
    ]
  });
  assert.deepEqual(blankPathReport.waves.map(wave => wave.taskIds), [["T-A", "T-B"]]);
  assert.deepEqual(blankPathReport.serializedPairs, []);
  const blankPathClaim = blankPathReport.claims.find(({ taskId }) => taskId === "T-A");
  assert.deepEqual(blankPathClaim?.paths, []);
  assert.equal(blankPathClaim?.provenance, "inferred");
  assert.deepEqual(blankPathReport.advisories?.map(({ taskAId, taskBId }) => ({ taskAId, taskBId })), [
    { taskAId: "T-A", taskBId: "T-B" }
  ]);

  const caseFoldedReport = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task" },
      { id: "T-B", status: "backlog", type: "task" }
    ],
    claims: [
      claim("00000000-0000-5000-8000-000000000033", "T-A", ["src/A.ts"]),
      claim("00000000-0000-5000-8000-000000000034", "T-B", ["src/a.ts"])
    ]
  });
  assert.deepEqual(caseFoldedReport.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]]);
  assert.deepEqual(caseFoldedReport.serializedPairs[0].causes[0].paths, ["src/a.ts ↔ src/a.ts"]);
});

test("task pair is not reported as both serialized and advisory (multi-claim: overlapping path claim plus shared low/inferred domain)", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task" },
      { id: "T-B", status: "backlog", type: "task" }
    ],
    claims: [
      { claimId: "00000000-0000-5000-8000-000000000041", taskId: "T-A", domains: ["CODE"], paths: ["src/shared.ts"], mode: "write", confidence: "high", provenance: "filesAffected" },
      { claimId: "00000000-0000-5000-8000-000000000043", taskId: "T-A", domains: ["CODE"], paths: [], mode: "write", confidence: "low", provenance: "inferred" },
      { claimId: "00000000-0000-5000-8000-000000000042", taskId: "T-B", domains: ["CODE"], paths: ["src/shared.ts"], mode: "write", confidence: "high", provenance: "filesAffected" },
      { claimId: "00000000-0000-5000-8000-000000000044", taskId: "T-B", domains: ["CODE"], paths: [], mode: "write", confidence: "low", provenance: "inferred" }
    ]
  });
  assert.equal(report.serializedPairs.length, 1);
  const advisories = report.advisories ?? [];
  assert.equal(advisories.length, 0);
  const serialized = new Set(report.serializedPairs.map(pair => `${pair.taskAId}:${pair.taskBId}`));
  assert.ok(advisories.every(pair => !serialized.has(`${pair.taskAId}:${pair.taskBId}`)));
});

test("low-confidence inferred domain overlap is advisory and stays in one wave", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task", domains: ["CODE"] },
      { id: "T-B", status: "backlog", type: "task", domains: ["CODE"] }
    ]
  });

  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A", "T-B"]]);
  assert.deepEqual(report.serializedPairs, []);
  const advisories = report.advisories ?? [];
  assert.equal(advisories.length, 1);
  assert.equal(advisories[0].reason, "low-confidence-inferred-domain-overlap");
});

test("leading glob path conservatively overlaps matching extension", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task" },
      { id: "T-B", status: "backlog", type: "task" }
    ],
    claims: [
      claim("00000000-0000-5000-8000-000000000011", "T-A", ["**/*.ts"]),
      claim("00000000-0000-5000-8000-000000000012", "T-B", ["src/lib/a.ts"])
    ]
  });

  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]]);
  assert.deepEqual(report.serializedPairs[0].causes[0].paths, ["**/*.ts ↔ src/lib/a.ts"]);
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

test("authored/high domain-only serializes against low/inferred domain-only with no duplicate advisory (R1 guard)", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task" },
      { id: "T-B", status: "backlog", type: "task" }
    ],
    claims: [
      { claimId: "00000000-0000-5000-8000-000000000051", taskId: "T-A", domains: ["CODE"], paths: [], mode: "write", confidence: "high", provenance: "authored" },
      { claimId: "00000000-0000-5000-8000-000000000052", taskId: "T-B", domains: ["CODE"], paths: [], mode: "write", confidence: "low", provenance: "inferred" }
    ]
  });

  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]]);
  assert.equal(report.serializedPairs.length, 1);
  assert.deepEqual(report.serializedPairs[0].domains, ["CODE"]);
  assert.deepEqual(report.serializedPairs[0].paths, []);
  assert.deepEqual(report.advisories, []);
});

test("R2 guards: wildcard filesAffected overlaps serialize with exact cause path (regression, fails on 85c5f85)", () => {
  const cases: Array<{ a: string; b: string; cause: string }> = [
    { a: "src/foo*.ts", b: "src/foobar.ts", cause: "src/foo*.ts ↔ src/foobar.ts" },
    { a: "src/file?.ts", b: "src/file1.ts", cause: "src/file?.ts ↔ src/file1.ts" },
    { a: "src/file[12].ts", b: "src/file1.ts", cause: "src/file[12].ts ↔ src/file1.ts" }
  ];
  for (const { a, b, cause } of cases) {
    const report = planExecution({
      tasks: [
        { id: "T-A", status: "backlog", type: "task", domains: ["CODE"], filesAffected: [a] },
        { id: "T-B", status: "backlog", type: "task", domains: ["CODE"], filesAffected: [b] }
      ]
    });
    assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]], `${a} vs ${b}`);
    assert.equal(report.serializedPairs.length, 1, `${a} vs ${b}`);
    assert.deepEqual(report.serializedPairs[0].causes[0].paths, [cause], `${a} vs ${b}`);
  }
});

test("T-132: brace, extglob, negation, and path-resolution overlaps serialize with exact cause path", () => {
  const cases: Array<{ a: string; b: string; cause: string }> = [
    { a: "{a,b}/x.ts", b: "a/x.ts", cause: "{a,b}/x.ts ↔ a/x.ts" },
    { a: "src/{a,b}.ts", b: "src/a.ts", cause: "src/{a,b}.ts ↔ src/a.ts" },
    { a: "@(a|b)/x.ts", b: "a/x.ts", cause: "@(a|b)/x.ts ↔ a/x.ts" },
    { a: "src/@(a|b).ts", b: "src/a.ts", cause: "src/@(a|b).ts ↔ src/a.ts" },
    { a: "!src/a.ts", b: "src/a.ts", cause: "!src/a.ts ↔ src/a.ts" },
    { a: "/src/a.ts", b: "src/a.ts", cause: "src/a.ts ↔ src/a.ts" },
    { a: "src/../src/a.ts", b: "src/a.ts", cause: "src/a.ts ↔ src/a.ts" },
    { a: ".//src/a.ts", b: "src/a.ts", cause: "src/a.ts ↔ src/a.ts" },
    { a: "src/**/../a.ts", b: "src/foo/a.ts", cause: "src/**/../a.ts ↔ src/foo/a.ts" },
    { a: "src/*/../a.ts", b: "src/a.ts", cause: "src/a.ts ↔ src/a.ts" },
    { a: "(a|b)/x.ts", b: "a/x.ts", cause: "(a|b)/x.ts ↔ a/x.ts" },
    { a: "src/{a..c}.ts", b: "src/b.ts", cause: "src/{a..c}.ts ↔ src/b.ts" }
  ];
  for (const { a, b, cause } of cases) {
    const report = planExecution({
      tasks: [
        { id: "T-A", status: "backlog", type: "task", domains: ["CODE"], filesAffected: [a] },
        { id: "T-B", status: "backlog", type: "task", domains: ["CODE"], filesAffected: [b] }
      ]
    });
    assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]], `${a} vs ${b}`);
    assert.equal(report.serializedPairs.length, 1, `${a} vs ${b}`);
    assert.deepEqual(report.serializedPairs[0].causes[0].paths, [cause], `${a} vs ${b}`);
  }
});

test("T-132 attempt 2: F1 pin — a single-segment wildcard before `..` resolves exactly, so it stays in one wave", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task", domains: ["CODE"], filesAffected: ["src/*/../a.ts"] },
      { id: "T-B", status: "backlog", type: "task", domains: ["CODE"], filesAffected: ["src/foo/a.ts"] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A", "T-B"]]);
  assert.deepEqual(report.serializedPairs, []);
});

test("T-132 attempt 2: F2 pin — bare parens and braces are literals, not glob syntax, so they stay in one wave", () => {
  const cases: Array<{ a: string; b: string }> = [
    { a: "app/(marketing)/page.tsx", b: "app/(shop)/page.tsx" },
    { a: "src/{id}.ts", b: "src/other.ts" },
    { a: "src/foo(1).ts", b: "src/a.ts" }
  ];
  for (const { a, b } of cases) {
    const report = planExecution({
      tasks: [
        { id: "T-A", status: "backlog", type: "task", domains: ["CODE"], filesAffected: [a] },
        { id: "T-B", status: "backlog", type: "task", domains: ["CODE"], filesAffected: [b] }
      ]
    });
    assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A", "T-B"]], `${a} vs ${b}`);
    assert.deepEqual(report.serializedPairs, [], `${a} vs ${b}`);
  }
});

test("T-132 attempt 2: F3/F5 guard — a path that normalizes away entirely still collides and names itself in the cause", () => {
  const cases: Array<{ a: string; b: string; cause: string }> = [
    { a: ".", b: "src/a.ts", cause: ". ↔ src/a.ts" },
    { a: "src/..", b: "src/a.ts", cause: "src/.. ↔ src/a.ts" }
  ];
  for (const { a, b, cause } of cases) {
    const report = planExecution({
      tasks: [
        { id: "T-A", status: "backlog", type: "task", domains: ["CODE"], filesAffected: [a] },
        { id: "T-B", status: "backlog", type: "task", domains: ["CODE"], filesAffected: [b] }
      ]
    });
    assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]], `${a} vs ${b}`);
    assert.equal(report.serializedPairs.length, 1, `${a} vs ${b}`);
    assert.deepEqual(report.serializedPairs[0].causes[0].paths, [cause], `${a} vs ${b}`);
  }
});

test("T-132 attempt 2: F3 guard — blank paths stay ignored even with mixed whitespace and empty strings (T-125 finding 5 stays fixed)", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task" },
      { id: "T-B", status: "backlog", type: "task" }
    ],
    claims: [
      { claimId: "00000000-0000-5000-8000-000000000071", taskId: "T-A", domains: [], paths: ["   "], mode: "write", confidence: "high", provenance: "authored" },
      { claimId: "00000000-0000-5000-8000-000000000072", taskId: "T-B", domains: [], paths: [""], mode: "write", confidence: "high", provenance: "authored" }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A", "T-B"]]);
  assert.deepEqual(report.serializedPairs, []);
});

test("R2 non-regression: literal path siblings with a shared prefix stay disjoint and in one wave", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task", domains: ["CODE"], filesAffected: ["packages/store"] },
      { id: "T-B", status: "backlog", type: "task", domains: ["CODE"], filesAffected: ["packages/store-ui"] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A", "T-B"]]);
  assert.deepEqual(report.serializedPairs, []);

  const wildcardReport = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task", domains: ["CODE"], filesAffected: ["packages/store/*.ts"] },
      { id: "T-B", status: "backlog", type: "task", domains: ["CODE"], filesAffected: ["packages/store-ui/a.ts"] }
    ]
  });
  assert.deepEqual(wildcardReport.waves.map(wave => wave.taskIds), [["T-A", "T-B"]]);
  assert.deepEqual(wildcardReport.serializedPairs, []);
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

// ---- T-133 point 6: this file's own (unexported) normalizePath compares
// DECLARED claims before any work runs and case-folds for macOS/Windows
// default filesystems, erring toward serializing. @mapctx/protocol's
// normalizePath (used by claim-violation detection, via pathsOverlap) compares
// OBSERVED paths a receipt actually reported, where case is meaningful. The
// two are deliberately NOT merged (see the normalizePath doc comment above
// pathOverlap in index.ts) -- this test exists so nobody "simplifies" that
// apparent duplication later without re-reading why it is not one. Since this
// file's normalizePath is not exported, it is exercised by the behaviour it
// causes in planExecution, not by calling it directly. ----
// ---- T-166: the scheduler's normalizePath (scheduler-paths.ts) folds Unicode
// to a canonical normal form, so `planExecution` itself -- not just the
// violations.ts guard -- must agree that NFC and NFD spellings of one
// filename are the same declared path, including through a glob and through
// dependency-free scheduling into separate waves. A disjoint-accent control
// sits alongside each positive case, same reasoning as the T-132/T-159 pairs
// above: a scheduler that always serializes on any accented path would pass
// the positive case for the wrong reason.
//
// T-166 review F1: the chosen form is NFD, not NFC -- NFC is not
// prefix-preserving (composing a base letter with its mark consumes the
// letter a glob's static prefix ended on), which narrows what the scheduler
// serializes rather than only widening it. See scheduler-paths.ts.
//
// Cause labels (`causes[].paths`) are built from the NORMALIZED (lowercased,
// NFD) form on both sides (see `causePath` in index.ts), not the raw input
// spelling -- so an NFC/NFD pair's cause label shows the same normalized
// string on both sides of the arrow, which is itself part of what T-166
// fixed: before, the two different byte sequences would have produced two
// different-looking labels for what is now one file.

test("T-166: NFC and NFD declared paths for the same filename serialize into separate waves", () => {
  const nfc = "caf\u00E9.ts";
  const nfd = "cafe\u0301.ts";
  assert.notEqual(nfc, nfd, "sentinel: the two spellings must differ byte-wise");
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "writes NFC", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${nfc}`] },
      { id: "T-B", title: "writes NFD", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${nfd}`] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]],
    "the scheduler must fold Unicode and serialize these as the same declared file");
  assert.equal(report.serializedPairs.length, 1);
  // Both sides of the cause label normalize to the same NFD-folded string
  // (causePath -> normalizeSchedulerPath, which normalizes to NFD).
  assert.deepEqual(report.serializedPairs[0].causes[0].paths, [`src/${nfd} ↔ src/${nfd}`]);
});

test("T-166 control: two genuinely different accented filenames stay in one wave", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "writes acute", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/caf\u00E9.ts"] },
      { id: "T-B", title: "writes grave", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/caf\u00E8.ts"] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A", "T-B"]],
    "different accents are different files, not different normal forms of one file");
  assert.deepEqual(report.serializedPairs, []);
});

test("T-166: an accented glob collides with the other normal form of a matching concrete path", () => {
  // `pathOverlap` is not exported, so this is exercised through
  // `planExecution`'s waves/serializedPairs rather than called directly.
  const nfc = "caf\u00E9";
  const nfd = "cafe\u0301";
  assert.notEqual(nfc, nfd, "sentinel: the two spellings must differ byte-wise");
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "glob over NFC dir", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${nfc}/**`] },
      { id: "T-B", title: "writes NFD dir file", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${nfd}/a.ts`] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]]);
  assert.equal(report.serializedPairs.length, 1);
  assert.deepEqual(report.serializedPairs[0].causes[0].paths, [`src/${nfd}/** ↔ src/${nfd}/a.ts`]);
});

test("T-166 F1: an NFC glob narrows and MISSES the NFD spelling of a matching concrete path (regression)", () => {
  // T-166 review F1's exact failure mode, pinned at the scheduler level. Under
  // NFC the static prefix of `src/cafe*` is `src/cafe`, which is NOT a prefix
  // of the NFD spelling `cafe` + U+0301 + `.ts` -- composing the mark consumes
  // the base letter the prefix ended on. The pair must still serialize (NFD
  // does not narrow this); the companion test below pins the control.
  const nfd = "cafe\u0301"; // "e" + U+0301 COMBINING ACUTE ACCENT
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "glob with cut prefix", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/cafe*"] },
      { id: "T-B", title: "writes NFD file", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${nfd}.ts`] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]],
    "src/cafe* must still match the NFD spelling of café.ts -- under NFC this pair would run in parallel over one file");
  assert.equal(report.serializedPairs.length, 1);
});

test("T-166 F1: an NFC glob narrows and MISSES an NFD glob over the same name (regression)", () => {
  const nfd = "cafe\u0301";
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "glob with cut prefix", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/cafe*"] },
      { id: "T-B", title: "glob over NFD spelling", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${nfd}*`] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]]);
  assert.equal(report.serializedPairs.length, 1);
});

test("T-166 F1: an NFC single-char wildcard narrows and MISSES the NFD spelling (regression)", () => {
  const nfd = "cafe\u0301";
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "single-char wildcard", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/cafe?.ts"] },
      { id: "T-B", title: "writes NFD file", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${nfd}.ts`] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]]);
  assert.equal(report.serializedPairs.length, 1);
});

test("T-166 F1: an NFC directory glob narrows and MISSES the NFD spelling of the directory (regression)", () => {
  const nfd = "cafe\u0301";
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "glob over cut-prefix dir", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/cafe*/x.ts"] },
      { id: "T-B", title: "writes NFD dir file", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${nfd}/x.ts`] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]]);
  assert.equal(report.serializedPairs.length, 1);
});

test("T-166 F1 control: the cut-prefix glob stays disjoint from an unrelated path", () => {
  // Guards the four regressions above against widening to always-true: the
  // same glob shape used in every case above must still leave a genuinely
  // unrelated path alone.
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "glob with cut prefix", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/cafe*"] },
      { id: "T-B", title: "unrelated file", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/other.ts"] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A", "T-B"]]);
  assert.deepEqual(report.serializedPairs, []);
});

test("T-166: an accented glob does not collide with a genuinely different accented directory", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "glob over acute dir", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/caf\u00E9/**"] },
      { id: "T-B", title: "writes grave dir file", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/caf\u00E8/a.ts"] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A", "T-B"]]);
  assert.deepEqual(report.serializedPairs, []);
});

// ---- T-170 (T-166 review attempt 2, N1): `staticPrefix` cuts a declared
// pattern at its first wildcard and `pathOverlap` compares the pieces with
// `startsWith`. Canonical normalization SORTS a run of combining marks by
// canonical combining class, so a cut landing BETWEEN two marks written out
// of canonical order is not a reliable prefix of anything -- no choice of
// normal form fixes this, because the defect is in the truncation, not the
// form. `staticPrefix` now drops trailing combining marks (`\p{M}+$`) so its
// head always ends on a base character.
//
// GRAVE = U+0300 COMBINING GRAVE ACCENT (Mn, ccc 230)
// DOTBELOW = U+0323 COMBINING DOT BELOW (Mn, ccc 220 -- sorts BEFORE grave)
// TILDEOVER = U+0334 COMBINING TILDE OVERLAY (Mn, ccc 1)
// HANGUL2 = U+302F HANGUL DOUBLE DOT TONE MARK (Mc, ccc 224 -- spacing, reorders)
// BALI = U+1B44 BALINESE ADEG ADEG (Mc, ccc 9 -- spacing, reorders)
// VISARGA = U+0903 DEVANAGARI SIGN VISARGA (Mc, ccc 0 -- spacing, does NOT reorder)
//
// Escapes throughout, never raw combining marks: the marks are themselves
// invisible in a terminal/editor, which is worse than T-166's accented
// literals -- a tool that silently re-orders or re-normalizes the file would
// make this fail (or pass) for the wrong reason without any visible diff.

test("T-170: the N1 repro -- a glob ending in a combining mark serializes against the canonically-equivalent out-of-order file", () => {
  const grave = "a\u0300"; // "a" + COMBINING GRAVE ACCENT (ccc 230)
  const dotBelowThenGrave = "a\u0323\u0300"; // dot-below (ccc 220) + grave (ccc 230): canonical order
  const graveThenDotBelow = "a\u0300\u0323"; // grave + dot-below: NOT canonical order
  assert.notEqual(graveThenDotBelow, dotBelowThenGrave, "sentinel: the two mark orderings must differ byte-wise");
  // The file is written grave-then-dot-below (non-canonical); normalizePath's
  // NFD step sorts it to dot-below-then-grave, so the glob's trimmed head
  // (`src/a`, mark dropped) must still match it.
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "glob ending in a combining mark", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${grave}*`] },
      { id: "T-B", title: "file with marks in non-canonical order", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${graveThenDotBelow}.ts`] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]],
    "without the trim, the head keeps the grave mark and stops matching the sorted (canonical) spelling of the file");
  assert.equal(report.serializedPairs.length, 1);
});

test("T-170: the N1 repro still serializes when the file is already in canonical mark order", () => {
  const grave = "a\u0300";
  const dotBelowThenGrave = "a\u0323\u0300"; // already canonical order
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "glob ending in a combining mark", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${grave}*`] },
      { id: "T-B", title: "file already in canonical mark order", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${dotBelowThenGrave}.ts`] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]]);
  assert.equal(report.serializedPairs.length, 1);
});

test("T-170: a single-character wildcard right after a combining mark still serializes", () => {
  const grave = "a\u0300";
  const graveThenDotBelowX = "a\u0300\u0323x"; // non-canonical order, extra trailing char
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "single-char wildcard after a mark", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${grave}?.ts`] },
      { id: "T-B", title: "out-of-order file", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${graveThenDotBelowX}.ts`] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]]);
  assert.equal(report.serializedPairs.length, 1);
});

test("T-170: a directory-boundary wildcard after a combining mark still serializes", () => {
  const grave = "a\u0300";
  const graveThenDotBelow = "a\u0300\u0323";
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "directory glob after a mark", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${grave}*/x.ts`] },
      { id: "T-B", title: "out-of-order directory file", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${graveThenDotBelow}/x.ts`] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]]);
  assert.equal(report.serializedPairs.length, 1);
});

// ---- T-170: the two spacing marks (Mc) that canonical ordering reorders.
// `\p{Mn}` (nonspacing-only) would miss both; `\p{M}` (any mark) is required.

test("T-170: a HANGUL DOUBLE DOT TONE MARK (Mc, reorders) glob still serializes -- \\p{Mn} alone would miss this", () => {
  const hangul = "a\u302F"; // U+302F HANGUL DOUBLE DOT TONE MARK (Mc, ccc 224)
  const hangulThenTilde = "a\u302F\u0334"; // + U+0334 COMBINING TILDE OVERLAY (Mn, ccc 1 -- lower ccc, so NFD reorders it to sort BEFORE the ccc-224 mark, ahead of the one dropped by the \p{M} trim)
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "glob ending in a spacing mark", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${hangul}*`] },
      { id: "T-B", title: "file with a second, lower-ccc mark appended", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${hangulThenTilde}.ts`] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]],
    "a nonspacing-only trim (\\p{Mn}) would leave this Mc mark in the head and miss the match");
  assert.equal(report.serializedPairs.length, 1);
});

test("T-170: a BALINESE ADEG ADEG (Mc, reorders) glob still serializes -- \\p{Mn} alone would miss this", () => {
  const bali = "a\u1B44"; // U+1B44 BALINESE ADEG ADEG (Mc, ccc 9)
  const baliThenTilde = "a\u1B44\u0334"; // + U+0334 COMBINING TILDE OVERLAY (Mn, ccc 1)
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "glob ending in a spacing mark", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${bali}*`] },
      { id: "T-B", title: "file with a second, lower-ccc mark appended", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${baliThenTilde}.ts`] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]],
    "a nonspacing-only trim (\\p{Mn}) would leave this Mc mark in the head and miss the match");
  assert.equal(report.serializedPairs.length, 1);
});

// ---- T-170: the reviewer's four non-suppression controls. Unchanged by the
// trim -- it must not have widened to always-true.

test("T-170 control: an unrelated path stays disjoint from an accented glob", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "glob", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/a*"] },
      { id: "T-B", title: "unrelated", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["docs/b.md"] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A", "T-B"]]);
  assert.deepEqual(report.serializedPairs, []);
});

test("T-170 control: two concrete (non-glob) paths with genuinely different accents stay disjoint", () => {
  // No wildcard on either side, so `staticPrefix` returns before the trim
  // ever runs. Both fixtures end in ".ts" (not a mark), so the trim would be a
  // no-op on them even if it DID run -- this is a non-widening control, not
  // coverage of the early return itself. The early return's necessity --
  // that it must gate the trim at all -- is covered by the literal/child
  // collision test below instead.
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "acute", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/caf\u00E9.ts"] },
      { id: "T-B", title: "grave", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/caf\u00E8.ts"] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A", "T-B"]]);
  assert.deepEqual(report.serializedPairs, []);
});

test("T-170 review M\u00C9DIA-2: a literal path ending in a combining mark still collides with its own child -- the trim must not run on a literal", () => {
  // `staticPrefix`'s early return (`if (wildcard < 0) ...`) must gate the
  // trim: a literal path is a complete name, not a truncated head, so
  // trimming it would drop a mark the filesystem actually has. Under the
  // mutation that applies the trim unconditionally, the literal `src/a`+GRAVE
  // becomes the bare prefix `src/a`, which is no longer a `/`-boundary prefix
  // of `src/a`+GRAVE+`/x.ts` -- a real parent/child collision goes missed and
  // the pair runs in parallel. With the early return intact, the literal
  // keeps its mark and the collision is found.
  const grave = "a\u0300"; // "a" + COMBINING GRAVE ACCENT
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "literal ending in a combining mark", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${grave}`] },
      { id: "T-B", title: "child of that literal", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${grave}/x.ts`] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]],
    "a literal ending in a combining mark must still collide with its own child -- the trim is for truncated glob heads, not literal names");
  assert.equal(report.serializedPairs.length, 1);
});

test("T-170 review MÉDIA-1: `partial` must come from the UNTRIMMED head, or a dir-boundary glob stops colliding with its string prefix", () => {
  // The head here is `src/` + a trailing combining mark -- trimming the mark
  // exposes the `/` that was already there, so `head.endsWith("/")` becomes
  // true and `partial` (read from the TRIMMED head) would flip to false. That
  // sends `pathOverlap` down the strict `/`-boundary branch instead of the
  // broad string-prefix one, and the literal "sr" -- a string prefix of "src"
  // but not a path-boundary prefix of it -- stops colliding. `partial` must
  // therefore come from the UNTRIMMED head: the wildcard truncated inside a
  // segment, and the head only *looks* like it ends on a boundary once the
  // mark comes off.
  //
  // The pair itself is a benign false positive either way -- "sr" and "src"
  // are different directories, never the same file -- so what this test
  // actually pins is MONOTONICITY (nothing that used to serialize may start
  // running in parallel), not this specific pair's correctness. This is the
  // shape of all 8 pairs the reviewer's full ordered-pair sweep found
  // narrowed by the bug (T-170 review attempt 1, MÉDIA-1).
  const grave = "\u0300"; // COMBINING GRAVE ACCENT
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "dir-boundary glob ending in a combining mark", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${grave}*`] },
      { id: "T-B", title: "string prefix, not a path-boundary prefix", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["sr"] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]],
    "partial read from the trimmed head would flip this collision off -- it must come from the untrimmed head instead");
  assert.equal(report.serializedPairs.length, 1);
});

test("T-170: a combining mark in the MIDDLE of the head must survive the trim -- only a trailing run is dropped", () => {
  // The trim is `/\p{M}+$/u` -- anchored to the END of the head. A mark
  // partway through the head is part of the real name of a directory the
  // glob is inside, not a truncation artifact, and dropping it would produce
  // a prefix that fails to match the glob's OWN declared files. Here the
  // mark sits right after "a", well before the wildcard that truncates at
  // "/b*": the head is `src/a`+GRAVE+`/b`, which has no trailing mark at all,
  // so the trim must be a no-op and the collision must still be found.
  //
  // This is the mutation-killer for the `$` anchor specifically: without it,
  // `.replace(/\p{M}+/u, "")` (no anchor) eats the FIRST run of marks found
  // anywhere in the string -- here, the internal one -- turning the head into
  // `src/a/b`, which does not match `src/a`+GRAVE+`/bc.ts` at all.
  const grave = "a\u0300"; // "a" + COMBINING GRAVE ACCENT, in the MIDDLE of the head
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "glob with a mark mid-head, not at the end", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${grave}/b*`] },
      { id: "T-B", title: "file sharing the same mid-head mark", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${grave}/bc.ts`] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]],
    "an unanchored trim would eat the mid-head mark and the glob would stop matching its own declared file");
  assert.equal(report.serializedPairs.length, 1);
});

test("T-170 control: sibling literal paths with a shared prefix stay disjoint", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "store", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["packages/store"] },
      { id: "T-B", title: "store-ui", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["packages/store-ui"] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A", "T-B"]]);
  assert.deepEqual(report.serializedPairs, []);
});

test("T-170 control: a partial-prefix glob still matches its sibling as before", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "glob", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/foo*.ts"] },
      { id: "T-B", title: "matching file", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/foobar.ts"] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]]);
  assert.equal(report.serializedPairs.length, 1);
});

// ---- T-170: the cost of the trim, pinned so it is not rediscovered as a
// defect later. Deliberate over-serialization: an accented glob's trimmed
// head now also matches its bare base letter, in the conservative direction
// this comparison is required to err in.

test("T-170 cost: an accented glob now also serializes against its bare base-letter spelling", () => {
  const grave = "caf\u0300"; // "caf" + COMBINING GRAVE ACCENT
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "accented glob", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${grave}*`] },
      { id: "T-B", title: "bare base letter, no accent at all", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/cafe.ts"] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]],
    "deliberate breadth cost: the trimmed head no longer distinguishes an accented glob from its unaccented base letter");
  assert.equal(report.serializedPairs.length, 1);
});

test("T-170 cost: an accented glob now also serializes against a DIFFERENT accent on the same base letter", () => {
  const grave = "caf\u0300";
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "accented glob (grave)", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${grave}*`] },
      { id: "T-B", title: "different accent (acute)", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/caf\u00E9.ts"] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]],
    "deliberate breadth cost: the trim cannot tell this accent from any other once the mark is dropped from the head");
  assert.equal(report.serializedPairs.length, 1);
});

test("T-170 control: a non-reordering spacing mark (VISARGA, Mc, ccc 0) does not accidentally widen an unrelated collision", () => {
  const visarga = "a\u0903"; // U+0903 DEVANAGARI SIGN VISARGA (Mc, ccc 0 -- does not reorder)
  const report = planExecution({
    tasks: [
      { id: "T-A", title: "glob ending in a non-reordering mark", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: [`src/${visarga}*`] },
      { id: "T-B", title: "unrelated file", status: "ready", type: "task", domains: ["PLANNER"], filesAffected: ["src/b.ts"] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A", "T-B"]]);
  assert.deepEqual(report.serializedPairs, []);
});


test("T-133 point 6: the scheduler's normalizePath case-folds declared claims; protocol's pathsOverlap does not fold observed paths", () => {
  const report = planExecution({
    tasks: [
      { id: "T-A", status: "backlog", type: "task", domains: ["CODE"], filesAffected: ["SRC/a.ts"] },
      { id: "T-B", status: "backlog", type: "task", domains: ["CODE"], filesAffected: ["src/a.ts"] }
    ]
  });
  assert.deepEqual(report.waves.map(wave => wave.taskIds), [["T-A"], ["T-B"]],
    "the scheduler must fold case and serialize these as the same declared file");
  assert.equal(report.serializedPairs.length, 1);

  assert.equal(pathsOverlap("SRC/a.ts", "src/a.ts"), false,
    "protocol's observed-path comparison is case-sensitive: these are different files on a case-sensitive filesystem");
});
