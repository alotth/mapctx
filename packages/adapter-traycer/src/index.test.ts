import assert from "node:assert/strict";
import test from "node:test";
import { dispatchEnvelopeSchema } from "@mapctx/protocol";
import {
  importTraycerTicket,
  mapPlanToDispatchEnvelopes,
  mapTaskToDispatchEnvelope,
  promoteApprovedArtifact,
  renderTraycerTicket
} from "./index";

const task = {
  id: "T-101",
  title: "Ship adapter",
  type: "task" as const,
  parentId: null,
  planningState: "ready" as const,
  priority: "high" as const,
  workload: "Normal" as const,
  tags: ["adapter"],
  domains: ["INTEGRATION"],
  start: null,
  due: null,
  acceptance: ["Maps a task"],
  specMode: "standard" as const,
  detailPath: "./tasks/T-101.md"
};

test("maps a canonical task to a schema-valid DispatchEnvelope", () => {
  const claim = {
    claimId: "44444444-4444-4444-8444-444444444444",
    taskId: "T-101",
    domains: ["INTEGRATION"],
    paths: ["packages/adapter-traycer/**"],
    mode: "write" as const,
    confidence: "high" as const,
    provenance: "authored" as const
  };
  const envelope = mapTaskToDispatchEnvelope(task, {
    projectId: "11111111-1111-4111-8111-111111111111",
    contextHash: "sha256:test",
    resourceClaims: [claim]
  });
  assert.equal(dispatchEnvelopeSchema.safeParse(envelope).success, true);
  assert.equal(envelope.task.id, "T-101");
  assert.equal(envelope.executor.kind, "traycer");
  assert.deepEqual(envelope.resourceClaims, [claim]);
});

test("renders only closed Traycer frontmatter and links MapCtx as authority", () => {
  const envelope = mapTaskToDispatchEnvelope(task, {
    projectId: "11111111-1111-4111-8111-111111111111",
    dispatchId: "22222222-2222-4222-8222-222222222222",
    contextHash: "sha256:test"
  });
  const ticket = renderTraycerTicket(envelope, {
    epic: { externalKey: "epic-1", uri: "traycer://epic/epic-1" }
  });
  assert.match(ticket.content, /^---\nkind: ticket\ntitle: \"Ship adapter\"\nstatus: 0\n---/);
  assert.equal(ticket.content.includes("domains:"), false);
  assert.equal(ticket.content.includes("mapctx://task/T-101"), true);
  assert.equal(ticket.requiresHumanTraycerAttach, true);
});

test("imports Traycer-first tickets as explicitly unplanned", () => {
  const imported = importTraycerTicket(`---
kind: ticket
title: "Existing ticket"
status: 1
---

- Canonical task: \`mapctx://task/T-202\`
- Dispatch: \`33333333-3333-4333-8333-333333333333\` (attempt 1)
`, { ticketKey: "ticket-202" });
  assert.equal(imported.externalRef.provider, "traycer");
  assert.equal(imported.externalRef.entityKind, "artifact");
  assert.equal(imported.mapctxTaskId, "T-202");
  assert.equal(imported.planningState, "backlog");
  assert.equal(imported.unplanned, true);
  assert.deepEqual(imported.missingPlanning, ["domains", "paths", "dependencies", "acceptance"]);
});

test("promotes artifacts only with explicit approval", () => {
  const ref = {
    artifactId: "55555555-5555-4555-8555-555555555555",
    ownerKind: "task" as const,
    ownerId: "T-101",
    uri: "traycer://artifact/ticket-101",
    kind: "ticket" as const,
    version: null,
    contentHash: null,
    promotedPath: null
  };
  assert.throws(() => promoteApprovedArtifact(ref, "docs/ticket.md", false), /explicit approval/);
  assert.equal(promoteApprovedArtifact(ref, "docs/ticket.md", true).promotedPath, "docs/ticket.md");
});

test("maps a synthetic multi-task plan without owning planner scheduling", () => {
  const taskB = { ...task, id: "T-102", title: "Second task" };
  const report = {
    waves: [
      { wave: 1, taskIds: ["T-101", "T-102"], tasks: [] }
    ],
    claims: [],
    waveByTaskId: { "T-101": 1, "T-102": 1 },
    serializedPairs: [],
    graphTaskIds: ["T-101", "T-102"],
    runnableTaskIds: ["T-101", "T-102"],
    excludedTaskIds: [],
    blockedTaskIds: [],
    blockedReasons: [],
    cycleTaskIds: [],
    recommendedNext: ["T-101", "T-102"],
    policy: {
      scheduling: "collision-aware" as const,
      claimsAreAdvisory: true as const,
      correctnessBackstop: "worktree-merge" as const,
      guarantee: "none" as const,
      explanation: "serialized-pairs" as const
    }
  };
  const result = mapPlanToDispatchEnvelopes(report, [task, taskB], {
    projectId: "11111111-1111-4111-8111-111111111111"
  });
  assert.deepEqual(result.waves[0].taskIds, ["T-101", "T-102"]);
  assert.deepEqual(result.waves[0].envelopes.map(item => item.task.id), ["T-101", "T-102"]);
});
