import {
  assertTransition,
  canonicalJson,
  evaluateRunReceipt,
  runReceiptSchema,
  runEventSchema,
  costEventSchema,
  estimateSnapshotSchema,
  planPeriodSchema,
  type DispatchAttemptHistory,
  type CostEvent,
  type EstimateSnapshot,
  type PlanPeriod,
  type RunEvent,
  type RunReceipt
} from "@mapctx/protocol"
import { getDispatchAttempt, getRunEvent, getTask, listDispatchAttempts, listRunReceipts } from "./projections"
import type { DispatchAttemptRecord } from "./types"
import { StoreHandle } from "./store-handle"
import type { DatabaseSync } from "node:sqlite"

export type DispatchAttemptInput = Omit<DispatchAttemptRecord, "status"> & { status?: DispatchAttemptRecord["status"]; actor?: string }
export type DispatchAttemptEnvelopeInput = { dispatch: DispatchAttemptInput; actor?: string }

export type DispatchWriteResult =
  | { ok: true; dispatch: DispatchAttemptRecord }
  | { ok: false; reason: "duplicate-attempt" }

export type ReceiptWriteResult =
  | { ok: true; receipt: RunReceipt; dispatch: DispatchAttemptRecord }
  | {
      ok: false;
      reason: "dispatch-mismatch" | "unknown-attempt" | "stale-attempt" | "duplicate-receipt" | "task-not-in-progress";
      message?: string;
    }

export type RunEventWriteResult =
  | { ok: true; event: RunEvent }
  | { ok: false; reason: "dispatch-mismatch" | "unknown-attempt" | "duplicate-run-event" | "conflicting-run-event" }

/** Persist one dispatch attempt and move its task into the executor-running state. */
export function recordDispatchAttempt(
  store: StoreHandle,
  rawInput: DispatchAttemptInput | DispatchAttemptEnvelopeInput,
  actor?: string
): DispatchWriteResult {
  const input: DispatchAttemptInput = "dispatch" in rawInput
    ? { ...rawInput.dispatch, actor: rawInput.actor ?? actor }
    : rawInput;
  const status = input.status ?? "running";
  return store.runInWriteTransaction(append => {
    const task = getTask(store.db, input.taskId);
    if (!task) throw new Error(`Cannot dispatch unknown task: ${input.taskId}`);
    if (["done", "cancelled"].includes(task.planningState)) throw new Error(`Cannot dispatch terminal task: ${input.taskId}`);
    if (listDispatchAttempts(store.db, input.dispatchId).some(a => a.attempt === input.attempt)) {
      return { ok: false, reason: "duplicate-attempt" };
    }
    const desiredExecution = status === "claimed" ? "claimed" : "running";
    if (task.executionState === "failed" || task.executionState === "blocked") {
      // New-attempt admission: dispatching a new attempt re-opens a terminal-
      // for-the-attempt execution through the machine's one legal edge
      // (failed -> unclaimed, or blocked -> unclaimed), journaled so replay
      // reproduces the reset. Without this the terminal state blocks every
      // legal route to claimed/running and an honestly-blocked run could
      // never be retried through the normal claim -> dispatch -> receipt
      // flow (R9 review P2#3).
      append({
        eventType: "task.patched",
        actor: input.actor ?? "store",
        payload: { taskId: input.taskId, patch: { executionState: "unclaimed" }, source: "retry-admission" }
      });
    } else if (task.executionState !== desiredExecution) {
      assertTransition("execution", task.executionState, desiredExecution);
    }
    // T-071: the store freezes the planned workload at hand-off. Server-side
    // read, never client-supplied -- the stamp must record what the board
    // believed when the executor took the task, not what a caller asserts.
    // Untagged tasks stamp null and stay null.
    const dispatch = {
      ...input,
      status,
      workloadAtDispatch: task.workload ?? null,
      executorModel: input.executorModel ?? null
    };
    delete dispatch.actor;
    append({
      eventType: "dispatch.attempted",
      actor: input.actor ?? "store",
      payload: { dispatch }
    });
    return { ok: true, dispatch };
  });
}

function receiptHistory(store: StoreHandle, dispatchId: string) {
  return getDispatchAttemptHistory(store.db, dispatchId);
}

export function getDispatchAttemptHistory(db: DatabaseSync, dispatchId: string): DispatchAttemptHistory {
  return {
    dispatchId,
    attempts: listDispatchAttempts(db, dispatchId).map(({ attempt, status }) => ({ attempt, status })),
    acceptedReceiptAttempts: listRunReceipts(db, dispatchId).map(receipt => receipt.attempt)
  };
}

export const listReceiptsForDispatch = listRunReceipts;

export function listReceiptsForTask(db: DatabaseSync, taskId: string): RunReceipt[] {
  return listRunReceipts(db, undefined, taskId);
}

/**
 * Validate and durably accept one receipt. evaluateRunReceipt is the sole
 * idempotency/staleness gate; state-machine assertions protect task/dispatch
 * lifecycle transitions before the event is journaled.
 */
export function recordRunReceipt(
  store: StoreHandle,
  receipt: RunReceipt,
  actor = "store",
  expectedDispatchId?: string
): ReceiptWriteResult {
  const parsed = runReceiptSchema.safeParse(receipt);
  if (!parsed.success) throw new Error(`Invalid RunReceipt: ${parsed.error.message}`);
  const value = parsed.data;
  return store.runInWriteTransaction(append => {
    const historyId = expectedDispatchId ?? value.dispatchId;
    const decision = evaluateRunReceipt(receiptHistory(store, historyId), value);
    if (!decision.accepted) return { ok: false, reason: decision.reason };
    const dispatch = listDispatchAttempts(store.db, value.dispatchId).find(a => a.attempt === value.attempt);
    if (!dispatch) return { ok: false, reason: "unknown-attempt" };
    const guard = receiptPlanningGuard(store, value, dispatch);
    if (guard) return guard;
    assertReceiptTransitions(store, value, dispatch);
    // T-071: freeze the discovered workload at receipt time. Journaled with
    // the event so replay reproduces the stamp even though the task's live
    // workload has moved on by then. Null stays null -- untagged is never
    // guessed.
    const task = getTask(store.db, dispatch.taskId);
    const workloadAtReceipt = task?.workload ?? null;
    append({
      eventType: "run.receipt-recorded",
      actor,
      payload: { receipt: value, workloadAtReceipt }
    });
    return { ok: true, receipt: value, dispatch: { ...dispatch, status: value.outcome } };
  });
}

export const submitRunReceipt = recordRunReceipt;

/** Validate and append one executor event; identity is (dispatch, attempt, sequence). */
export function recordRunEvent(
  store: StoreHandle,
  rawEvent: RunEvent,
  actor = "store",
  expectedDispatchId?: string
): RunEventWriteResult {
  const parsed = runEventSchema.safeParse(rawEvent);
  if (!parsed.success) throw new Error(`Invalid RunEvent: ${parsed.error.message}`);
  const event = parsed.data;
  if (expectedDispatchId !== undefined && expectedDispatchId !== event.dispatchId) {
    return { ok: false, reason: "dispatch-mismatch" };
  }
  return store.runInWriteTransaction(append => {
    if (!getDispatchAttempt(store.db, event.dispatchId, event.attempt)) {
      return { ok: false, reason: "unknown-attempt" };
    }
    const existing = getRunEvent(store.db, event.dispatchId, event.attempt, event.sequence);
    if (existing) {
      return canonicalJson(existing) === canonicalJson(event)
        ? { ok: false, reason: "duplicate-run-event" }
        : { ok: false, reason: "conflicting-run-event" };
    }
    append({
      eventType: "run.event-recorded",
      actor,
      payload: { event }
    });
    return { ok: true, event };
  });
}

export const submitRunEvent = recordRunEvent;

export type CostWriteResult =
  | { ok: true; costEvent: CostEvent }
  | { ok: false; reason: "duplicate-cost-event" }

export function recordCostEvent(store: StoreHandle, rawCost: CostEvent, actor = "store"): CostWriteResult {
  const parsed = costEventSchema.safeParse(rawCost)
  if (!parsed.success) throw new Error(`Invalid CostEvent: ${parsed.error.message}`)
  const cost = parsed.data
  return store.runInWriteTransaction(append => {
    if (store.db.prepare("SELECT 1 FROM cost_event_projection WHERE cost_event_id = ?").get(cost.costEventId)) {
      return { ok: false, reason: "duplicate-cost-event" }
    }
    append({ eventType: "cost.recorded", actor, payload: { cost } })
    return { ok: true, costEvent: cost }
  })
}

export type PlanPeriodWriteResult = { ok: true; period: PlanPeriod }

export function recordPlanPeriod(store: StoreHandle, rawPeriod: PlanPeriod, actor = "store"): PlanPeriodWriteResult {
  const parsed = planPeriodSchema.safeParse(rawPeriod)
  if (!parsed.success) throw new Error(`Invalid PlanPeriod: ${parsed.error.message}`)
  const period = parsed.data
  return store.runInWriteTransaction(append => {
    append({ eventType: "plan-period.recorded", actor, payload: { period } })
    return { ok: true, period }
  })
}

export type EstimateSnapshotWriteResult =
  | { ok: true; snapshot: EstimateSnapshot }
  | { ok: false; reason: "duplicate-estimate" }

export function recordEstimateSnapshot(
  store: StoreHandle,
  rawSnapshot: EstimateSnapshot,
  actor = "store"
): EstimateSnapshotWriteResult {
  const parsed = estimateSnapshotSchema.safeParse(rawSnapshot)
  if (!parsed.success) throw new Error(`Invalid EstimateSnapshot: ${parsed.error.message}`)
  const snapshot = parsed.data
  return store.runInWriteTransaction(append => {
    if (store.db.prepare("SELECT 1 FROM estimate_snapshot_projection WHERE estimate_id = ?").get(snapshot.estimateId)) {
      return { ok: false, reason: "duplicate-estimate" }
    }
    append({ eventType: "estimate.snapshot-recorded", actor, payload: { snapshot } })
    return { ok: true, snapshot }
  })
}

/**
 * A completed receipt lands the task in review -- but only from in-progress,
 * because the planning state must say the work was started before it can say
 * it finished. Rejecting early lets the guard teach the remedy instead of the
 * raw FSM error surfacing as "Illegal planning transition" with no path
 * forward. The remedy is also the retroactive-attestation flow: claiming now
 * carries the task to doing, `dispatch create` registers the attempt, and
 * this same receipt (with the true startedAt/endedAt from the session) is
 * then accepted -- the board records when it learned, the receipt keeps when
 * the work actually happened.
 */
function receiptPlanningGuard(store: StoreHandle, receipt: RunReceipt, dispatch: DispatchAttemptRecord): Extract<ReceiptWriteResult, { ok: false }> | null {
  if (receipt.outcome !== "completed") return null;
  const task = getTask(store.db, dispatch.taskId);
  if (!task) return null;
  if (task.planningState === "in-progress" || task.planningState === "review") return null;
  return {
    ok: false,
    reason: "task-not-in-progress",
    message: `task ${dispatch.taskId} is "${task.planningState}" -- completed receipts land in review from in-progress only. Claim first: \`mapctx task claim ${dispatch.taskId}\` (carries it to doing). If the work already happened outside the flow, that claim + \`mapctx dispatch create ${dispatch.taskId}\` + this same receipt is the retroactive attestation: the receipt's startedAt/endedAt keep the true times.`
  };
}

function assertReceiptTransitions(store: StoreHandle, receipt: RunReceipt, dispatch: DispatchAttemptRecord): void {
  const task = getTask(store.db, dispatch.taskId);
  if (!task) throw new Error(`Cannot record receipt for unknown task: ${dispatch.taskId}`);
  let execution = task.executionState;
  let dispatchStatus = dispatch.status;
  if (dispatchStatus === "claimed") {
    assertTransition("dispatch", dispatchStatus, "running");
    dispatchStatus = "running";
    if (execution !== "running") {
      assertTransition("execution", execution, "running");
      execution = "running";
    }
  }
  assertTransition("dispatch", dispatchStatus, receipt.outcome);
  assertTransition("execution", execution, receipt.outcome);
  const targetPlanning = receipt.outcome === "completed"
    ? "review"
    : receipt.outcome === "failed"
      ? (task.planningState === "in-progress" || task.planningState === "blocked" ? "ready" : undefined)
      : receipt.outcome === "blocked"
        ? "blocked"
        : undefined;
  if (targetPlanning !== undefined && task.planningState !== targetPlanning) {
    assertPlanningReceiptTransition(task.planningState, targetPlanning);
  }
}

function assertPlanningReceiptTransition(from: string, to: string): void {
  if (from === "in-progress" && to === "ready") {
    assertTransition("planning", from, "blocked");
    assertTransition("planning", "blocked", to);
    return;
  }
  assertTransition("planning", from, to);
}
