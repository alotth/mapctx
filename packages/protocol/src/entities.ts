import { z } from "zod";
import {
  centsSchema,
  isoDateSchema,
  isoDateTimeSchema,
  microsSchema,
  nonEmptyStringSchema,
  schemaVersionSchema,
  taskIdSchema,
  tokenCountSchema,
  uuidSchema
} from "./primitives";

export const planningStateSchema = z.enum([
  "backlog",
  "ready",
  "blocked",
  "in-progress",
  "review",
  "paused",
  "done",
  "cancelled"
]);
export type PlanningState = z.infer<typeof planningStateSchema>;

export const executionStateSchema = z.enum([
  "unclaimed",
  "claimed",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled"
]);
export type ExecutionState = z.infer<typeof executionStateSchema>;

export const taskTypeSchema = z.enum(["epic", "feature", "task", "bug", "chore"]);
export const prioritySchema = z.enum(["high", "medium", "low"]);
export const workloadSchema = z.enum(["Easy", "Normal", "Hard", "Extreme"]);
export const specModeSchema = z.enum(["lite", "standard", "strict"]);

export const sourceModeSchema = z.enum(["local-canonical", "github-canonical"]);
export const plansAuthoritySchema = z.enum(["markdown", "store"]);

export const repoBindingSchema = z.object({
  url: z.string().nullable(),
  path: z.string().nullable(),
  defaultRef: z.string().nullable()
});

export const workflowPolicySchema = z.object({
  profile: nonEmptyStringSchema,
  policySource: nonEmptyStringSchema,
  requiredGates: z.array(z.enum(["product-review", "architecture", "program-design", "vertical-slices"]))
});

export const projectSchema = z.object({
  id: uuidSchema,
  title: nonEmptyStringSchema,
  repoBindings: z.array(repoBindingSchema),
  workflowPolicy: workflowPolicySchema,
  sourceMode: sourceModeSchema,
  plansAuthority: plansAuthoritySchema
});
export type Project = z.infer<typeof projectSchema>;

export const workflowGateNameSchema = z.enum([
  "product-review",
  "architecture",
  "program-design",
  "vertical-slices"
]);

export const workflowGateSchema = z.discriminatedUnion("status", [
  z.object({
    name: workflowGateNameSchema,
    status: z.literal("skipped"),
    reason: nonEmptyStringSchema,
    evidence: z.array(z.string()).default([])
  }),
  z.object({
    name: workflowGateNameSchema,
    status: z.enum(["pending", "approved", "rejected"]),
    reason: z.string().nullable(),
    evidence: z.array(z.string()).default([])
  })
]);
export type WorkflowGate = z.infer<typeof workflowGateSchema>;

export const epicSchema = z.object({
  id: taskIdSchema,
  title: nonEmptyStringSchema,
  goals: z.array(z.string()),
  planningState: planningStateSchema,
  workflowGates: z.array(workflowGateSchema)
});
export type Epic = z.infer<typeof epicSchema>;

export const taskSchema = z.object({
  id: taskIdSchema,
  title: nonEmptyStringSchema,
  type: taskTypeSchema,
  parentId: taskIdSchema.nullable(),
  planningState: planningStateSchema,
  priority: prioritySchema.nullable(),
  workload: workloadSchema.nullable(),
  tags: z.array(z.string()),
  domains: z.array(z.string()),
  start: isoDateSchema.nullable(),
  due: isoDateSchema.nullable(),
  acceptance: z.array(z.string()),
  specMode: specModeSchema.nullable(),
  detailPath: z.string().nullable()
});
export type Task = z.infer<typeof taskSchema>;

export const dependencyKindSchema = z.enum(["blocks", "depends-on"]);

export const dependencyEdgeSchema = z.object({
  fromTaskId: taskIdSchema,
  toTaskId: taskIdSchema,
  kind: dependencyKindSchema
});
export type DependencyEdge = z.infer<typeof dependencyEdgeSchema>;

export const resourceClaimModeSchema = z.enum(["read", "write"]);
export const resourceClaimProvenanceSchema = z.enum([
  "authored",
  "filesAffected",
  "glob-heuristic",
  "inferred"
]);

export const resourceClaimSchema = z.object({
  claimId: uuidSchema,
  taskId: taskIdSchema,
  domains: z.array(z.string()),
  paths: z.array(z.string()),
  mode: resourceClaimModeSchema,
  confidence: z.enum(["low", "medium", "high"]),
  provenance: resourceClaimProvenanceSchema
});
export type ResourceClaim = z.infer<typeof resourceClaimSchema>;

export const externalRefProviderSchema = z.enum(["traycer", "github", "orca", "paperclip", "other"]);
export const externalRefEntityKindSchema = z.enum([
  "epic",
  "artifact",
  "issue",
  "project-item",
  "run",
  "dispatch",
  "other"
]);

export const externalRefSchema = z.object({
  refId: uuidSchema,
  ownerKind: z.enum(["project", "epic", "task", "dispatch"]),
  ownerId: nonEmptyStringSchema,
  provider: externalRefProviderSchema,
  entityKind: externalRefEntityKindSchema,
  externalKey: nonEmptyStringSchema,
  uri: nonEmptyStringSchema,
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type ExternalRef = z.infer<typeof externalRefSchema>;

export const artifactKindSchema = z.enum(["spec", "ticket", "story", "review", "adr", "other"]);

export const artifactRefSchema = z.object({
  artifactId: uuidSchema,
  ownerKind: z.enum(["project", "epic", "task", "dispatch"]),
  ownerId: nonEmptyStringSchema,
  uri: nonEmptyStringSchema,
  kind: artifactKindSchema,
  version: z.string().nullable(),
  contentHash: z.string().nullable(),
  promotedPath: z.string().nullable()
});
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const dispatchStatusSchema = z.enum([
  "claimed",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "expired"
]);
export type DispatchStatus = z.infer<typeof dispatchStatusSchema>;

export const dispatchSchema = z.object({
  dispatchId: uuidSchema,
  taskId: taskIdSchema,
  executorKind: nonEmptyStringSchema,
  attempt: z.number().int().positive(),
  contextHash: nonEmptyStringSchema,
  status: dispatchStatusSchema
});
export type Dispatch = z.infer<typeof dispatchSchema>;

export const usageSourceSchema = z.enum([
  "harness-transcript",
  "provider-api",
  "manual",
  "absent"
]);
export const usageCoverageSchema = z.enum(["full", "partial", "none"]);

export const usageEventSchema = z.object({
  usageEventId: uuidSchema,
  dispatchId: uuidSchema,
  provider: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  inputTokens: tokenCountSchema,
  cacheTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  source: usageSourceSchema,
  coverage: usageCoverageSchema
});
export type UsageEvent = z.infer<typeof usageEventSchema>;

export const billingTypeSchema = z.enum([
  "metered_api",
  "subscription_included",
  "subscription_overage",
  "credits",
  "fixed",
  "unknown"
]);
export const costStatusSchema = z.enum([
  "reported",
  "unpriced",
  "allocated",
  "estimated"
]);

export const costEventSchema = z.object({
  costEventId: uuidSchema,
  dispatchId: uuidSchema,
  usageEventId: uuidSchema.nullable(),
  billingType: billingTypeSchema,
  costStatus: costStatusSchema,
  cashCents: centsSchema,
  shadowMicros: microsSchema,
  allocatedMicros: microsSchema.nullable(),
  planPeriodId: uuidSchema.nullable(),
  priceTableVersion: nonEmptyStringSchema,
  appliedRateMicrosPerToken: z.number().int().nonnegative()
});
export type CostEvent = z.infer<typeof costEventSchema>;

export const planPeriodStatusSchema = z.enum(["open", "closed"]);

export const planPeriodSchema = z.object({
  planPeriodId: uuidSchema,
  biller: nonEmptyStringSchema,
  planName: nonEmptyStringSchema,
  periodStart: isoDateTimeSchema,
  periodEnd: isoDateTimeSchema,
  fixedCents: centsSchema,
  seats: z.number().int().positive(),
  status: planPeriodStatusSchema
});
export type PlanPeriod = z.infer<typeof planPeriodSchema>;

export const durationMeasuresSchema = z.object({
  sessionWallClockMs: z.number().int().nonnegative(),
  activeTimeMs: z.number().int().nonnegative(),
  taskDurationMs: z.number().int().nonnegative(),
  leadTimeMs: z.number().int().nonnegative(),
  idleThresholdMs: z.number().int().positive()
});
export type DurationMeasures = z.infer<typeof durationMeasuresSchema>;

export const estimateMethodSchema = z.enum([
  "expert-guess",
  "historical-baseline",
  "workload-table",
  "calibrated"
]);
export const estimateConfidenceSchema = z.enum(["low", "medium", "high"]);

export const estimateSnapshotSchema = z.object({
  estimateId: uuidSchema,
  taskId: taskIdSchema,
  createdAt: isoDateTimeSchema,
  method: estimateMethodSchema,
  confidence: estimateConfidenceSchema,
  estimatorVersion: nonEmptyStringSchema,
  idleThresholdMs: z.number().int().positive(),
  costCoverage: usageCoverageSchema,
  durationP50Ms: z.number().int().nonnegative(),
  durationP90Ms: z.number().int().nonnegative(),
  inputTokensP50: tokenCountSchema,
  inputTokensP90: tokenCountSchema,
  outputTokensP50: tokenCountSchema,
  outputTokensP90: tokenCountSchema,
  cacheTokensP50: tokenCountSchema,
  cacheTokensP90: tokenCountSchema,
  shadowMicrosP50: microsSchema,
  shadowMicrosP90: microsSchema,
  assumptions: z.array(z.string())
});
export type EstimateSnapshot = z.infer<typeof estimateSnapshotSchema>;

export const claimViolationKindSchema = z.enum(["collision", "overbroad"]);

export const claimViolationSchema = z.object({
  id: uuidSchema,
  waveId: uuidSchema,
  kind: claimViolationKindSchema,
  taskAId: taskIdSchema,
  taskBId: taskIdSchema,
  path: nonEmptyStringSchema,
  detectedAt: isoDateTimeSchema,
  source: z.literal("derived-from-receipts")
});
export type ClaimViolation = z.infer<typeof claimViolationSchema>;

export const eventIdentitySchema = z.object({
  nodeId: uuidSchema,
  sequence: z.number().int().positive()
});
export type EventIdentity = z.infer<typeof eventIdentitySchema>;

export const eventLogEntrySchema = z.object({
  nodeId: uuidSchema,
  sequence: z.number().int().positive(),
  logicalClock: z.number().int().positive(),
  eventType: nonEmptyStringSchema,
  schemaVersion: schemaVersionSchema,
  occurredAt: isoDateTimeSchema,
  actor: nonEmptyStringSchema,
  causation: z.array(eventIdentitySchema),
  payload: z.record(z.string(), z.unknown()),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/)
});
export type EventLogEntry = z.infer<typeof eventLogEntrySchema>;

export const ENTITY_SCHEMAS = {
  Project: projectSchema,
  Epic: epicSchema,
  Task: taskSchema,
  DependencyEdge: dependencyEdgeSchema,
  ResourceClaim: resourceClaimSchema,
  ExternalRef: externalRefSchema,
  ArtifactRef: artifactRefSchema,
  Dispatch: dispatchSchema,
  UsageEvent: usageEventSchema,
  CostEvent: costEventSchema,
  PlanPeriod: planPeriodSchema,
  DurationMeasures: durationMeasuresSchema,
  EstimateSnapshot: estimateSnapshotSchema,
  ClaimViolation: claimViolationSchema,
  EventLogEntry: eventLogEntrySchema,
  WorkflowGate: workflowGateSchema
} as const;

export type EntityName = keyof typeof ENTITY_SCHEMAS;
