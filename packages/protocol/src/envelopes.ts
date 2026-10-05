import { z } from "zod";
import {
  artifactRefSchema,
  resourceClaimSchema,
  taskSchema,
  usageEventSchema
} from "./entities";
import { isoDateTimeSchema, nonEmptyStringSchema, schemaVersionSchema, uuidSchema } from "./primitives";

export const dispatchEnvelopeSchema = z.object({
  schemaVersion: schemaVersionSchema,
  dispatchId: uuidSchema,
  attempt: z.number().int().positive(),
  projectId: uuidSchema,
  task: taskSchema,
  context: z.object({
    refs: z.array(artifactRefSchema),
    hash: nonEmptyStringSchema,
    tokenBudget: z.number().int().positive().optional()
  }),
  resourceClaims: z.array(resourceClaimSchema),
  workflowEvidence: z.array(artifactRefSchema),
  executor: z.object({
    kind: nonEmptyStringSchema,
    capabilities: z.array(z.string())
  })
});
export type DispatchEnvelope = z.infer<typeof dispatchEnvelopeSchema>;

export const runEventTypeSchema = z.enum([
  "started",
  "progress",
  "question",
  "blocked",
  "heartbeat",
  "completed",
  "failed",
  "cancelled"
]);

export const runEventSchema = z.object({
  schemaVersion: schemaVersionSchema,
  dispatchId: uuidSchema,
  attempt: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  type: runEventTypeSchema,
  timestamp: isoDateTimeSchema,
  payload: z.record(z.string(), z.unknown()).default({})
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const runOutcomeSchema = z.enum(["completed", "failed", "blocked", "cancelled"]);

export const failureCategorySchema = z.enum([
  "executor-error",
  "timeout",
  "policy-violation",
  "context-mismatch",
  "cancelled-by-operator",
  "unknown"
]);

export const failureDetailSchema = z.object({
  category: failureCategorySchema,
  message: nonEmptyStringSchema,
  retryable: z.boolean()
});
export type FailureDetail = z.infer<typeof failureDetailSchema>;

export const timeIntervalSchema = z.object({
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
  owner: z.enum(["agent", "human"]),
  kind: z.enum(["active", "review", "human", "parked"]),
  confidence: z.enum(["inferred", "corroborated"]).optional(),
  sessionId: nonEmptyStringSchema.optional()
}).superRefine((interval, ctx) => {
  if (!Number.isFinite(Date.parse(interval.start)) || !Number.isFinite(Date.parse(interval.end)) || Date.parse(interval.end) <= Date.parse(interval.start)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "interval end must follow start" });
  if ((interval.owner === "agent") !== (interval.kind === "active")) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "interval owner/kind mismatch" });
  if (interval.confidence === "corroborated" && interval.kind !== "parked") ctx.addIssue({ code: z.ZodIssueCode.custom, message: "only parked intervals can be corroborated" });
});
export type TimeInterval = z.infer<typeof timeIntervalSchema>;

export const timeSessionSpanSchema = z.object({
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
  sessionId: nonEmptyStringSchema
}).superRefine((span, ctx) => {
  if (!Number.isFinite(Date.parse(span.start)) || !Number.isFinite(Date.parse(span.end)) || Date.parse(span.end) <= Date.parse(span.start)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "session span end must follow start" });
  }
});

export const timeEvidenceSourceSchema = z.enum(["claude-jsonl", "codex-jsonl", "opencode-db"]);
export type TimeEvidenceSource = z.infer<typeof timeEvidenceSourceSchema>;

export const timeEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  source: timeEvidenceSourceSchema,
  policy: z.object({
    idleThresholdMs: z.number().int().positive(),
    reviewThresholdMs: z.number().int().positive(),
    parkedThresholdMs: z.number().int().positive(),
    timeZone: nonEmptyStringSchema
  }).refine(policy => policy.reviewThresholdMs < policy.parkedThresholdMs, "review threshold must precede parked threshold")
    .refine(policy => { try { new Intl.DateTimeFormat("en-CA", { timeZone: policy.timeZone }); return true; } catch { return false; } }, "invalid time zone"),
  intervals: z.array(timeIntervalSchema),
  /** Full session boundaries retain idle gaps omitted from ownership intervals. */
  sessionSpans: z.array(timeSessionSpanSchema).optional()
}).superRefine((evidence, ctx) => {
  if (!evidence.sessionSpans) return;
  for (const [index, interval] of evidence.intervals.entries()) {
    const span = evidence.sessionSpans.find(item => item.sessionId === interval.sessionId &&
      Date.parse(item.start) <= Date.parse(interval.start) && Date.parse(item.end) >= Date.parse(interval.end));
    if (!span) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["intervals", index], message: "interval outside session span" });
  }
});
export type TimeEvidence = z.infer<typeof timeEvidenceSchema>;

export const historySourceSchema = z.enum(["codex", "opencode", "claude-code", "git", "mixed"]);
export type HistorySource = z.infer<typeof historySourceSchema>;

export const historyTierSchema = z.enum(["measured", "inferred", "declared", "no-history"]);
export type HistoryTier = z.infer<typeof historyTierSchema>;

const runReceiptBaseSchema = z.object({
  schemaVersion: schemaVersionSchema,
  dispatchId: uuidSchema,
  attempt: z.number().int().positive(),
  outcome: runOutcomeSchema,
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema,
  changedFiles: z.array(z.string()),
  usageEvents: z.array(usageEventSchema),
  evidence: z.array(artifactRefSchema),
  /** Versioned timestamp-only evidence; absent on legacy receipts. */
  timeEvidence: timeEvidenceSchema.optional(),
  /**
   * T-101 history backfill marker. Present only on retroactive-attestation
   * receipts written by `mapctx history scan --commit`: which local session
   * store the linkage came from, and the evidence tier. Inferred and declared
   * tiers never enter calibration/accuracy metrics (same rule as T-099
   * aligned-from-actual). Absent on live executor receipts.
   */
  historySource: historySourceSchema.optional(),
  historyTier: historyTierSchema.optional(),
  failure: failureDetailSchema.nullable()
});

export const runReceiptSchema = runReceiptBaseSchema.superRefine((receipt, ctx) => {
  if ((receipt.historySource === undefined) !== (receipt.historyTier === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["historyTier"], message: "historySource and historyTier must appear together" });
  }
  if (!Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.endedAt)) || Date.parse(receipt.endedAt) < Date.parse(receipt.startedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endedAt"], message: "invalid receipt bounds" });
  }
  for (const [index, interval] of (receipt.timeEvidence?.intervals ?? []).entries()) {
    if (Date.parse(interval.start) < Date.parse(receipt.startedAt) || Date.parse(interval.end) > Date.parse(receipt.endedAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["timeEvidence", "intervals", index], message: "interval outside receipt bounds" });
    }
  }
  for (const [index, span] of (receipt.timeEvidence?.sessionSpans ?? []).entries()) {
    if (Date.parse(span.start) < Date.parse(receipt.startedAt) || Date.parse(span.end) > Date.parse(receipt.endedAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["timeEvidence", "sessionSpans", index], message: "session span outside receipt bounds" });
    }
  }
  if (receipt.outcome === "failed" && receipt.failure === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure"],
      message: "failure is required when outcome is \"failed\""
    });
  }
  if (receipt.outcome !== "failed" && receipt.failure !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure"],
      message: "failure must be null unless outcome is \"failed\""
    });
  }
});
export type RunReceipt = z.infer<typeof runReceiptBaseSchema>;

export const ENVELOPE_SCHEMAS = {
  DispatchEnvelope: dispatchEnvelopeSchema,
  RunEvent: runEventSchema,
  RunReceipt: runReceiptSchema
} as const;
