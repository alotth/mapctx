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
  failure: failureDetailSchema.nullable()
});

export const runReceiptSchema = runReceiptBaseSchema.superRefine((receipt, ctx) => {
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
