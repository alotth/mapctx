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
import { currencyCodeSchema, moneySchema } from "./money";

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

/**
 * PlanPeriod is account-scoped as of T-070: the subscription plan is paid to
 * an Account ("Codex Pro"), not to a project, and projects consume the plan
 * via allocatedCost rated by shadowCost. `accountId` is optional/null so
 * pre-004 rows and events (project-scoped era) stay valid data forever;
 * plan periods recorded through `mapctx plan-period record --account` always
 * carry it.
 */
export const planPeriodSchema = z.object({
  planPeriodId: uuidSchema,
  accountId: uuidSchema.nullable().optional(),
  biller: nonEmptyStringSchema,
  planName: nonEmptyStringSchema,
  periodStart: isoDateTimeSchema,
  periodEnd: isoDateTimeSchema,
  fixedCents: centsSchema,
  seats: z.number().int().positive(),
  status: planPeriodStatusSchema
});
export type PlanPeriod = z.infer<typeof planPeriodSchema>;

/**
 * A subscription/paid-plan account the user pays once ("paguei $200 no Codex
 * em 05/09"). Accounts are store entities: event-sourced per project store,
 * with projects declaring which accounts they draw from (project.accounts-set).
 */
export const accountSchema = z.object({
  accountId: uuidSchema,
  name: nonEmptyStringSchema,
  currency: currencyCodeSchema,
  createdAt: isoDateTimeSchema,
  note: z.string().nullable()
});
export type Account = z.infer<typeof accountSchema>;

export const budgetUnitSchema = z.enum(["money", "time"]);
export const budgetOwnerKindSchema = z.enum(["epic", "project"]);

/**
 * Budget: the plan that actuals consume. Unit-agnostic (money | time) by
 * decision -- a money budget is Money minor units of one currency; a time
 * budget is planned active minutes. Every `budget set` appends a new Budget
 * row: revisions/top-ups are history in the event log, latest-wins in the
 * projection (max event logical clock).
 */
export const budgetSchema = z
  .object({
    budgetId: uuidSchema,
    ownerKind: budgetOwnerKindSchema,
    ownerId: nonEmptyStringSchema,
    unit: budgetUnitSchema,
    money: moneySchema.nullable(),
    minutes: z.number().int().positive().nullable(),
    periodStart: isoDateSchema.nullable(),
    periodEnd: isoDateSchema.nullable(),
    setAt: isoDateTimeSchema,
    note: z.string().nullable()
  })
  .superRefine((budget, ctx) => {
    if (budget.unit === "money" && budget.money === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["money"],
        message: "money budgets require money"
      });
    }
    if (budget.unit === "time" && budget.minutes === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minutes"],
        message: "time budgets require minutes"
      });
    }
    if (budget.unit === "money" && budget.minutes !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minutes"],
        message: "money budgets must not carry minutes"
      });
    }
    if (budget.unit === "time" && budget.money !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["money"],
        message: "time budgets must not carry money"
      });
    }
    if (budget.periodStart !== null && budget.periodEnd !== null && budget.periodStart > budget.periodEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["periodEnd"],
        message: "periodEnd must not precede periodStart"
      });
    }
  });
export type Budget = z.infer<typeof budgetSchema>;

export const budgetCoverageSchema = z.enum(["no-data", "partial", "full"]);

/**
 * budget.consumed derivation spec (the rollup every consumer shares):
 *
 * Scope(owner): for `epic`, every task descending from the epic id in
 * task_projection (transitive through parentTaskId); for `project`, every
 * task in the store. Task order is taskId ASC -- rollups must be
 * byte-identical on repeated runs and rebuilds.
 *
 * Money budgets (currency must be USD -- the denomination of cashCents and
 * cost micros -- otherwise coverage is "no-data" with reason
 * "cross-currency-manual"; conversion is manual and explicit, D1):
 *   - Candidate stream: CostEvent rows joined through dispatch_projection to
 *     in-scope tasks, ordered by cost_event_id ASC.
 *   - Real money per row: cashCents when costStatus is "reported"; plus
 *     allocatedMicros when non-null (subscription share of the plan fee).
 *     Negative values are credits/adjustments (R16 signed policy): they enter
 *     the sum signed and still count as attribution -- coverage never depends
 *     on sign, and the signed net matches the never-clamped remaining
 *     arithmetic. Zero-valued rows contribute nothing and stay unattributed.
 *   - Rows with neither (unpriced, estimated-only, zero-allocation
 *     subscription runs) contribute NOTHING to consumed; they count in
 *     unattributedDispatches. Zeros-that-look-measured are forbidden.
 *   - consumedMinor = sum(centsToMinorUnits(cashCents)) +
 *     sum(microsToMinorUnits(allocatedMicros)), computed in the FINER of
 *     (budget decimals, 6) so every conversion is an exact upward scaling --
 *     sub-cent allocation micros are routine and must never be rounded away.
 *     Every conversion and partial sum is checked against the safe-integer
 *     range and throws instead of silently rounding or wrapping (R7). Output
 *     `decimals` reports the grid actually used.
 *   - coverage: "no-data" when the scope has no dispatch with any attributed
 *     cost; "full" when every scoped dispatch has at least one attributed
 *     cost event; "partial" otherwise.
 *   - Period scope: dated MONEY budgets are refused at the write path
 *     (CostEvent carries no occurrence timestamp, so period consumption
 *     cannot be attributed); legacy dated money budgets report lifetime sums
 *     with reason "dated-money-budget-lifetime-basis" (R15).
 *
 * Time budgets: consumedMs = sum over accepted RunReceipts of in-scope
 * dispatches of the intersection of [startedAt, endedAt] with the declared
 * [periodStart, periodEnd] when the budget is dated (undated budgets sum the
 * full intervals) -- wall-clock basis, activeTime is not yet persisted per
 * run, so the output labels the basis honestly. A receipt entirely outside
 * the period contributes zero and is not attributed (R15). coverage follows
 * the same no-data/partial/full rules over receipts.
 *
 * Deriving a budget status never mutates the store: rollups are pure reads,
 * and a spent-over-planned result renders negative remaining -- it is never
 * clamped and never written back.
 */
export const budgetConsumedSchema = z.object({
  unit: budgetUnitSchema,
  currency: currencyCodeSchema.nullable(),
  decimals: z.number().int().min(0).max(18).nullable(),
  consumedMinor: z.number().int().nullable(),
  consumedMs: z.number().int().nullable(),
  coverage: budgetCoverageSchema,
  reason: z.string().nullable(),
  scopedDispatches: z.number().int().nonnegative(),
  unattributedDispatches: z.number().int().nonnegative()
});
export type BudgetConsumed = z.infer<typeof budgetConsumedSchema>;

export const durationMeasuresSchema = z.object({
  sessionWallClockMs: z.number().int().nonnegative(),
  activeTimeMs: z.number().int().nonnegative(),
  taskDurationMs: z.number().int().nonnegative(),
  leadTimeMs: z.number().int().nonnegative(),
  idleThresholdMs: z.number().int().positive(),
  // Optional for compatibility with v1 snapshots; new measurements always
  // include this provenance marker.
  activeTimeCoverage: z.enum(["measured", "substituted", "none"]).optional()
});
export type DurationMeasures = z.infer<typeof durationMeasuresSchema>;

export const durationCoverageSchema = z.enum(["measured", "substituted", "none"]);
export type DurationCoverage = z.infer<typeof durationCoverageSchema>;

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
  // Optional keeps previously persisted snapshots readable. Forecasts built
  // by current code persist explicit coverage here.
  durationCoverage: durationCoverageSchema.optional(),
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
  Account: accountSchema,
  Budget: budgetSchema,
  Money: moneySchema,
  DurationMeasures: durationMeasuresSchema,
  EstimateSnapshot: estimateSnapshotSchema,
  ClaimViolation: claimViolationSchema,
  EventLogEntry: eventLogEntrySchema,
  WorkflowGate: workflowGateSchema
} as const;

export type EntityName = keyof typeof ENTITY_SCHEMAS;
