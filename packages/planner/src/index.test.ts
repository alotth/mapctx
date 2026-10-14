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
