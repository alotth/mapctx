// T-058 walking skeleton: hand-build one DispatchEnvelope + RunReceipt for a
// real MapCtx task, validate both against the real protocol schemas (T-052),
// and run the receipt through evaluateRunReceipt. No adapter automation, no
// waves, no forecast, no UI -- see tasks/T-058.md.
//
// This script does not talk to the store directly. Claiming/releasing the
// task in @mapctx/store is done separately via the `mapctx` CLI so the
// cross-worktree test exercises the real CLI surface, not an in-process
// shortcut. This script only proves the DispatchEnvelope/RunReceipt contract
// shapes and the evaluateRunReceipt idempotency gate.
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  dispatchEnvelopeSchema,
  runReceiptSchema,
  emptyDispatchAttemptHistory,
  recordAttempt,
  recordAcceptedReceipt,
  evaluateRunReceipt,
  type DispatchEnvelope,
  type RunReceipt
} from "@mapctx/protocol";

const PROJECT_ID = process.argv[2];
if (!PROJECT_ID) {
  console.error("usage: dispatch-skeleton.ts <projectId> [outDir]");
  process.exit(1);
}
const OUT_DIR = process.argv[3] ?? join(__dirname, "..", "out");
mkdirSync(OUT_DIR, { recursive: true });

const dispatchId = randomUUID();

// Task shape mirrors tasks/T-021.md + its TASKS.md entry as of the T-058 run.
const envelope: DispatchEnvelope = {
  schemaVersion: 1,
  dispatchId,
  attempt: 1,
  projectId: PROJECT_ID,
  task: {
    id: "T-021",
    title: "Add product-oriented example detail files and runbook",
    type: "chore",
    parentId: "E-002",
    planningState: "backlog",
    priority: "medium",
    workload: "Easy",
    tags: ["examples", "docs", "onboarding"],
    domains: ["DOCS", "SKILLS"],
    start: null,
    due: null,
    acceptance: [
      "At least one lite, one standard, and one strict example exists.",
      "Examples use the new section order and language.",
      "Runbook explains when to choose each depth level."
    ],
    specMode: null,
    detailPath: "./tasks/T-021.md"
  },
  context: {
    refs: [],
    hash: "sha256:t058-manual-dispatch-skeleton",
    tokenBudget: undefined
  },
  resourceClaims: [
    {
      claimId: randomUUID(),
      taskId: "T-021",
      domains: ["DOCS", "SKILLS"],
      paths: ["tasks/", "docs/"],
      mode: "write",
      confidence: "high",
      provenance: "filesAffected"
    }
  ],
  workflowEvidence: [],
  executor: {
    kind: "manual-traycer-ticket",
    capabilities: []
  }
};

const envelopeResult = dispatchEnvelopeSchema.safeParse(envelope);
if (!envelopeResult.success) {
  console.error("DispatchEnvelope failed schema validation:", envelopeResult.error.format());
  process.exit(1);
}
writeFileSync(join(OUT_DIR, "dispatch-envelope.json"), JSON.stringify(envelopeResult.data, null, 2));

const startedAt = new Date().toISOString();
const endedAt = new Date(Date.now() + 60_000).toISOString();

const receipt: RunReceipt = {
  schemaVersion: 1,
  dispatchId,
  attempt: 1,
  outcome: "completed",
  startedAt,
  endedAt,
  changedFiles: [
    "tasks/T-021-example-lite.md",
    "tasks/T-021-example-standard.md",
    "tasks/T-021-example-strict.md",
    "docs/task-detail-depth-runbook.md"
  ],
  usageEvents: [],
  evidence: [],
  failure: null
};

const receiptResult = runReceiptSchema.safeParse(receipt);
if (!receiptResult.success) {
  console.error("RunReceipt failed schema validation:", receiptResult.error.format());
  process.exit(1);
}
writeFileSync(join(OUT_DIR, "run-receipt.json"), JSON.stringify(receiptResult.data, null, 2));

// Store has no persisted DispatchAttemptHistory (no dispatch/run/receipt
// event types in packages/store/src/events.ts EVENT_TYPES as of T-058) --
// build the history in-process here. See tasks/T-058.md gap notes.
let history = emptyDispatchAttemptHistory(dispatchId);
history = recordAttempt(history, { attempt: 1, status: "claimed" });

const firstDecision = evaluateRunReceipt(history, receiptResult.data);
console.log("evaluateRunReceipt (first delivery):", firstDecision);
if (!firstDecision.accepted) {
  console.error("Expected first receipt delivery to be accepted.");
  process.exit(1);
}

// Caller (this script, standing in for whatever eventually persists
// DispatchAttemptHistory) must record acceptance itself -- evaluateRunReceipt
// is a pure decision function with no side effects.
history = recordAcceptedReceipt(history, receiptResult.data.attempt);

const replayDecision = evaluateRunReceipt(history, receiptResult.data);
console.log("evaluateRunReceipt (duplicate delivery, e.g. at-least-once retry):", replayDecision);
if (replayDecision.accepted) {
  console.error("Expected duplicate receipt delivery to be rejected.");
  process.exit(1);
}

console.log(`\nWrote ${join(OUT_DIR, "dispatch-envelope.json")}`);
console.log(`Wrote ${join(OUT_DIR, "run-receipt.json")}`);
console.log(`dispatchId: ${dispatchId}`);
