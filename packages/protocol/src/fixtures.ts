import { PROTOCOL_SCHEMA_VERSION } from "./schema-version";
import type {
  ArtifactRef,
  ClaimViolation,
  CostEvent,
  DependencyEdge,
  Dispatch,
  DurationMeasures,
  Epic,
  EstimateSnapshot,
  EventLogEntry,
  ExternalRef,
  PlanPeriod,
  Project,
  ResourceClaim,
  Task,
  UsageEvent,
  WorkflowGate
} from "./entities";
import type { DispatchEnvelope, RunEvent, RunReceipt } from "./envelopes";

export const FIXTURE_IDS = {
  projectId: "2f1c6c3e-0a51-4d2b-9c4a-8b7e1d90a111",
  taskId: "T-048",
  epicId: "E-009",
  dispatchId: "9b2e4d71-6c18-4a0f-b3d5-11aa22bb33cc",
  nodeId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  traycerEpicId: "e8873251-f6f0-490d-be16-8e5655300237",
  traycerArtifactId: "mapctx-vnext-t049-external-store-tech-plan",
  githubIssue: "42",
  usageEventId: "11111111-2222-4333-8444-555555555555",
  costEventId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
  planPeriodId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
  estimateId: "12345678-90ab-4cde-8f01-23456789abcd",
  claimId: "c0ffee00-1111-4222-8333-444444444444",
  artifactId: "0a1b2c3d-4e5f-4678-89ab-cdef01234567",
  refMapctx: "aaaa1111-bbbb-4ccc-8ddd-eeee22223333",
  refTraycerEpic: "bbbb2222-cccc-4ddd-8eee-ffff33334444",
  refTraycerArtifact: "cccc3333-dddd-4eee-8fff-000044445555",
  refGithub: "dddd4444-eeee-4fff-8000-111155556666",
  waveId: "eeee5555-ffff-4000-8111-222266667777",
  violationId: "ffff6666-0000-4111-8222-333377778888"
} as const;

const NOW = "2026-08-15T21:00:00.000Z";

export const projectFixture: Project = {
  id: FIXTURE_IDS.projectId,
  title: "mapctx-monorepo",
  repoBindings: [{ url: "https://github.com/alotth/mapctx", path: ".", defaultRef: "main" }],
  workflowPolicy: {
    profile: "host-guardrail-v1",
    policySource: "AGENTS.md",
    requiredGates: ["product-review", "architecture", "program-design", "vertical-slices"]
  },
  sourceMode: "local-canonical",
  plansAuthority: "markdown"
};

export const workflowGateFixture: WorkflowGate = {
  name: "product-review",
  status: "approved",
  reason: null,
  evidence: [`traycer://${FIXTURE_IDS.traycerEpicId}/mapctx-vnext-strategy`]
};

export const skippedGateFixture: WorkflowGate = {
  name: "vertical-slices",
  status: "skipped",
  reason: "localized-low-risk",
  evidence: []
};

export const epicFixture: Epic = {
  id: FIXTURE_IDS.epicId,
  title: "vNext protocol and store",
  goals: ["Define executable contracts", "Replace live Markdown state"],
  planningState: "in-progress",
  workflowGates: [workflowGateFixture, skippedGateFixture]
};

export const taskFixture: Task = {
  id: FIXTURE_IDS.taskId,
  title: "Define vNext protocol and operational domain model",
  type: "task",
  parentId: FIXTURE_IDS.epicId,
  planningState: "in-progress",
  priority: "high",
  workload: "Hard",
  tags: ["vnext", "protocol"],
  domains: ["PROTOCOL", "STORE", "DOCS"],
  start: null,
  due: null,
  acceptance: ["Every entity has an executable schema plus a versioned golden fixture"],
  specMode: "strict",
  detailPath: "./tasks/T-048.md"
};

export const dependencyEdgeFixture: DependencyEdge = {
  fromTaskId: "T-049",
  toTaskId: FIXTURE_IDS.taskId,
  kind: "depends-on"
};

export const resourceClaimFixture: ResourceClaim = {
  claimId: FIXTURE_IDS.claimId,
  taskId: FIXTURE_IDS.taskId,
  domains: ["PROTOCOL"],
  paths: ["packages/protocol/**"],
  mode: "write",
  confidence: "high",
  provenance: "authored"
};

export const externalRefsFixture: ExternalRef[] = [
  {
    refId: FIXTURE_IDS.refMapctx,
    ownerKind: "task",
    ownerId: FIXTURE_IDS.taskId,
    provider: "other",
    entityKind: "other",
    externalKey: FIXTURE_IDS.taskId,
    uri: `mapctx://task/${FIXTURE_IDS.taskId}`,
    metadata: { role: "canonical" }
  },
  {
    refId: FIXTURE_IDS.refTraycerEpic,
    ownerKind: "epic",
    ownerId: FIXTURE_IDS.epicId,
    provider: "traycer",
    entityKind: "epic",
    externalKey: FIXTURE_IDS.traycerEpicId,
    uri: `traycer://epic/${FIXTURE_IDS.traycerEpicId}`,
    metadata: {}
  },
  {
    refId: FIXTURE_IDS.refTraycerArtifact,
    ownerKind: "task",
    ownerId: FIXTURE_IDS.taskId,
    provider: "traycer",
    entityKind: "artifact",
    externalKey: FIXTURE_IDS.traycerArtifactId,
    uri: `traycer://epic/${FIXTURE_IDS.traycerEpicId}/artifact/${FIXTURE_IDS.traycerArtifactId}`,
    metadata: { kind: "spec" }
  },
  {
    refId: FIXTURE_IDS.refGithub,
    ownerKind: "task",
    ownerId: FIXTURE_IDS.taskId,
    provider: "github",
    entityKind: "issue",
    externalKey: FIXTURE_IDS.githubIssue,
    uri: "https://github.com/alotth/mapctx/issues/42",
    metadata: { repo: "alotth/mapctx" }
  }
];

export const artifactRefFixture: ArtifactRef = {
  artifactId: FIXTURE_IDS.artifactId,
  ownerKind: "task",
  ownerId: FIXTURE_IDS.taskId,
  uri: `traycer://epic/${FIXTURE_IDS.traycerEpicId}/artifact/${FIXTURE_IDS.traycerArtifactId}`,
  kind: "spec",
  version: "1",
  contentHash: "a".repeat(64),
  promotedPath: null
};

export const dispatchFixture: Dispatch = {
  dispatchId: FIXTURE_IDS.dispatchId,
  taskId: FIXTURE_IDS.taskId,
  executorKind: "traycer",
  attempt: 1,
  contextHash: "b".repeat(64),
  status: "running"
};

export const usageEventFixture: UsageEvent = {
  usageEventId: FIXTURE_IDS.usageEventId,
  dispatchId: FIXTURE_IDS.dispatchId,
  provider: "anthropic",
  model: "claude-sonnet",
  inputTokens: 1200,
  cacheTokens: 400,
  outputTokens: 800,
  source: "harness-transcript",
  coverage: "partial"
};

export const planPeriodFixture: PlanPeriod = {
  planPeriodId: FIXTURE_IDS.planPeriodId,
  biller: "anthropic",
  planName: "claude-pro",
  periodStart: "2026-08-01T00:00:00.000Z",
  periodEnd: "2026-08-31T23:59:59.000Z",
  fixedCents: 20000,
  seats: 1,
  status: "open"
};

export const costEventFixture: CostEvent = {
  costEventId: FIXTURE_IDS.costEventId,
  dispatchId: FIXTURE_IDS.dispatchId,
  usageEventId: FIXTURE_IDS.usageEventId,
  billingType: "subscription_included",
  costStatus: "allocated",
  cashCents: 0,
  shadowMicros: 1_250_000,
  allocatedMicros: 80_000,
  planPeriodId: FIXTURE_IDS.planPeriodId,
  priceTableVersion: "2026-08-01",
  appliedRateMicrosPerToken: 300
};

export const durationMeasuresFixture: DurationMeasures = {
  sessionWallClockMs: 3_600_000,
  activeTimeMs: 2_400_000,
  taskDurationMs: 2_400_000,
  leadTimeMs: 86_400_000,
  idleThresholdMs: 600_000
};

export const estimateSnapshotFixture: EstimateSnapshot = {
  estimateId: FIXTURE_IDS.estimateId,
  taskId: FIXTURE_IDS.taskId,
  createdAt: NOW,
  method: "expert-guess",
  confidence: "low",
  estimatorVersion: "v1",
  idleThresholdMs: 600_000,
  costCoverage: "partial",
  durationP50Ms: 10_800_000,
  durationP90Ms: 21_600_000,
  inputTokensP50: 8000,
  inputTokensP90: 16000,
  outputTokensP50: 4000,
  outputTokensP90: 8000,
  cacheTokensP50: 1000,
  cacheTokensP90: 2000,
  shadowMicrosP50: 4_000_000,
  shadowMicrosP90: 8_000_000,
  assumptions: ["single implementer", "no store work"]
};

export const claimViolationFixture: ClaimViolation = {
  id: FIXTURE_IDS.violationId,
  waveId: FIXTURE_IDS.waveId,
  kind: "collision",
  taskAId: "T-049",
  taskBId: "T-052",
  path: "packages/protocol/src/index.ts",
  detectedAt: NOW,
  source: "derived-from-receipts"
};

export const eventLogEntryFixture: EventLogEntry = {
  nodeId: FIXTURE_IDS.nodeId,
  sequence: 1,
  logicalClock: 1,
  eventType: "task.upserted",
  schemaVersion: PROTOCOL_SCHEMA_VERSION,
  occurredAt: NOW,
  actor: "mapctx-cli",
  causation: [],
  payload: { taskId: FIXTURE_IDS.taskId },
  payloadSha256: "c".repeat(64)
};

export const dispatchEnvelopeFixture: DispatchEnvelope = {
  schemaVersion: PROTOCOL_SCHEMA_VERSION,
  dispatchId: FIXTURE_IDS.dispatchId,
  attempt: 1,
  projectId: FIXTURE_IDS.projectId,
  task: taskFixture,
  context: {
    refs: [artifactRefFixture],
    hash: "b".repeat(64),
    tokenBudget: 2000
  },
  resourceClaims: [resourceClaimFixture],
  workflowEvidence: [artifactRefFixture],
  executor: { kind: "traycer", capabilities: ["worktree", "a2a"] }
};

export const runEventFixture: RunEvent = {
  schemaVersion: PROTOCOL_SCHEMA_VERSION,
  dispatchId: FIXTURE_IDS.dispatchId,
  attempt: 1,
  sequence: 0,
  type: "started",
  timestamp: NOW,
  payload: { agentId: "3b7f74e5-f031-4f78-b90a-3d3a827137f2" }
};

export const runReceiptFixture: RunReceipt = {
  schemaVersion: PROTOCOL_SCHEMA_VERSION,
  dispatchId: FIXTURE_IDS.dispatchId,
  attempt: 1,
  outcome: "completed",
  startedAt: NOW,
  endedAt: "2026-08-15T22:00:00.000Z",
  changedFiles: ["packages/protocol/src/index.ts"],
  usageEvents: [usageEventFixture],
  evidence: [artifactRefFixture],
  failure: null
};

export const ENTITY_FIXTURES = {
  Project: projectFixture,
  Epic: epicFixture,
  Task: taskFixture,
  DependencyEdge: dependencyEdgeFixture,
  ResourceClaim: resourceClaimFixture,
  ExternalRef: externalRefsFixture[0],
  ArtifactRef: artifactRefFixture,
  Dispatch: dispatchFixture,
  UsageEvent: usageEventFixture,
  CostEvent: costEventFixture,
  PlanPeriod: planPeriodFixture,
  DurationMeasures: durationMeasuresFixture,
  EstimateSnapshot: estimateSnapshotFixture,
  ClaimViolation: claimViolationFixture,
  EventLogEntry: eventLogEntryFixture,
  WorkflowGate: workflowGateFixture
} as const;

export const ENVELOPE_FIXTURES = {
  DispatchEnvelope: dispatchEnvelopeFixture,
  RunEvent: runEventFixture,
  RunReceipt: runReceiptFixture
} as const;
