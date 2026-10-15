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
  type DispatchKind,
  type EstimateSnapshot,
  type PlanPeriod,
  type RunEvent,
  type RunReceipt
} from "@mapctx/protocol"
import {
  assertReceiptPlanningAdmission, getActiveExclusiveClaimForTask, getDispatchAttempt, getRunEvent, getTask, latestDispatchKind, listActiveClaimsForTask, listDispatchAttempts, listRunReceipts } from "./projections"
import { appendRunEventClaimRenewal, type RunEventRenewal } from "./claims"
import type { CoordinationSettings } from "./config"
import type { DispatchAttemptRecord } from "./types"
import { StoreHandle, type AppendEventInput } from "./store-handle"
import type { EventLogEntry } from "@mapctx/protocol"
import type { DatabaseSync } from "node:sqlite"

/**
 * T-144: `kind` is optional on the INPUT and required on the record. Every
 * caller that predates lanes keeps compiling and keeps meaning `implement`,
 * while every reader of a stored attempt still learns the lane without
 * deciding what absent means.
 */
export type DispatchAttemptInput =
  Omit<DispatchAttemptRecord, "status" | "kind">
  & { status?: DispatchAttemptRecord["status"]; kind?: DispatchKind; actor?: string }
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
  /**
   * `renewal` is present only when the caller asked for one (T-143), so every
   * existing caller keeps the exact result shape it asserts today. Renewal is
   * opt-in rather than automatic for the same reason: `mapctx run event` is
   * the surface C4 ships, and a store-internal writer should not acquire a
   * lease side effect because a CLI command wanted one.
   */
  | { ok: true; event: RunEvent; renewal?: RunEventRenewal }
  | { ok: false; reason: "dispatch-mismatch" | "unknown-attempt" | "duplicate-run-event" | "conflicting-run-event" }

/** Persist one dispatch attempt and move its task into the executor-running state. */
export function recordDispatchAttempt(
  store: StoreHandle,
  rawInput: DispatchAttemptInput | DispatchAttemptEnvelopeInput,
  actor?: string,
  requireActiveClaim = false
): DispatchWriteResult {
  return store.runInWriteTransaction(append => appendDispatchAttempt(store, rawInput, append, actor, requireActiveClaim));
}

/** Compose dispatch admission with a claim in one caller-owned transaction. */
export function appendDispatchAttempt(
  store: StoreHandle,
  rawInput: DispatchAttemptInput | DispatchAttemptEnvelopeInput,
  append: (input: AppendEventInput) => EventLogEntry,
  actor?: string,
  requireActiveClaim = false
): DispatchWriteResult {
  const input: DispatchAttemptInput = "dispatch" in rawInput
    ? { ...rawInput.dispatch, actor: rawInput.actor ?? actor }
    : rawInput;
  const status = input.status ?? "running";
  if (status !== "claimed" && status !== "running") throw new Error(`Invalid dispatch admission status: ${status}`);
  const task = getTask(store.db, input.taskId);
  if (!task) throw new Error(`Cannot dispatch unknown task: ${input.taskId}`);
  if (["done", "cancelled", "archived"].includes(task.planningState)) throw new Error(`Cannot dispatch terminal task: ${input.taskId}`);
  const history = listDispatchAttempts(store.db, input.dispatchId);
  // T-144 (C5): a dispatch id names a LANE, for its whole life. Attempt N+1 is
  // a retry of the same work in the same lane, and `evaluateRunReceipt` is
  // scoped per `dispatchId` -- so letting a later attempt change kind would
  // make one attempt chain half implement and half review, with the receipts
  // of each invalidating the other's. Refused by name rather than silently
  // inheriting, because a caller that passed the other kind believes something
  // false about what it is dispatching.
  // The chain's lane by the SAME rule every other reader uses (attempt 2:
  // `latestDispatchKind`, not `history[0]`). It matters only for a chain this
  // binary did not admit -- a journal merged from another node -- but a guard
  // that judged attempt 1 while the renewal lookup judged the latest attempt
  // would be two answers to one question.
  const existingKind = history.length > 0 ? latestDispatchKind(history) : undefined;
  const kind: DispatchKind = input.kind ?? existingKind ?? "implement";
  if (existingKind !== undefined && kind !== existingKind) {
    throw new Error(
      `Dispatch ${input.dispatchId} is a ${existingKind} dispatch; attempt ${input.attempt} cannot be ${kind}. `
      + `Open a separate dispatch for the ${kind} lane.`
    );
  }
  if (requireActiveClaim) {
    // T-144 (review N1): validate against the dispatch's OWN lane. This block
    // is the one place in this file that reads "this task's active claim", and
    // on the single-row getter it read whichever lane the query planner
    // reached -- so a review claim could satisfy an implement dispatch's gate,
    // or an implement claim a review dispatch's.
    //
    // The two lanes resolve differently because their cardinalities differ:
    // `implement` has at most one exclusive claim by index, while `review`
    // may have several shared ones, and here ANY live claim in the lane
    // satisfies the gate. That is deliberately weaker than the renewal
    // lookup's "exactly one": this gate asks whether the lane is held at all,
    // and two reviewers both holding it is a yes, not an ambiguity -- nothing
    // is being addressed, only checked.
    const nowMs = Date.now();
    const lane = kind === "implement"
      ? [getActiveExclusiveClaimForTask(store.db, input.taskId)].filter(claim => claim !== undefined)
      : listActiveClaimsForTask(store.db, input.taskId, { role: "review" });
    const held = lane.find(claim => new Date(claim!.expiresAt).getTime() > nowMs);
    if (!held) {
      throw new Error(
        `Dispatch requires an active ${kind} claim. Use mapctx task start ${input.taskId}, or task claim followed by dispatch create.`
      );
    }
  }
  if (history.some(a => a.attempt === input.attempt)) {
    return { ok: false, reason: "duplicate-attempt" };
  }
  const desiredExecution = status === "claimed" ? "claimed" : "running";
  // T-144: everything from here to the `dispatch.attempted` append moves the
  // task's `executionState` -- the retry-admission reset and the legality
  // assertion alike -- and all of it belongs to the implement lane alone. A
  // review dispatch records itself and changes nothing about the task: it must
  // not reset a running implementation to `unclaimed` (which the reset would
  // do when the implement attempt had failed), and it must not be refused by
  // `assertTransition` for failing to move a state it has no business moving.
  if (kind === "implement") {
    applyImplementExecutionAdmission(task, desiredExecution, input, append);
  }
  // T-071: the store freezes the planned workload at hand-off. Server-side
  // read, never client-supplied -- the stamp must record what the board
  // believed when the executor took the task, not what a caller asserts.
  // Untagged tasks stamp null and stay null.
  const dispatch = {
    ...input,
    status,
    kind,
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
}

/**
 * The implement lane's execution-state admission, lifted out of
 * `appendDispatchAttempt` by T-144 so the lane check reads as one decision
 * rather than as an `if` wrapped around forty lines.
 */
function applyImplementExecutionAdmission(
  task: { executionState: string; taskId: string },
  desiredExecution: "claimed" | "running",
  input: DispatchAttemptInput,
  append: (input: AppendEventInput) => EventLogEntry
): void {
  if (task.executionState === "failed" || task.executionState === "blocked" || task.executionState === "completed") {
    // New-attempt admission: dispatching a new attempt re-opens a terminal-
    // for-the-attempt execution through a journaled reset to unclaimed
    // (failed, blocked, or completed -> unclaimed). The old attempt remains
    // immutable and its receipt remains queryable; only the new dispatch
    // attempt may advance from the reset state. Without this the terminal
    // state blocks every legal route to claimed/running and a completed run
    // could never be retried after review.
    append({
      eventType: "task.patched",
      actor: input.actor ?? "store",
      payload: { taskId: input.taskId, patch: { executionState: "unclaimed" }, source: "retry-admission" }
    });
    if (desiredExecution === "running") {
      // Replays must take both legal hops: unclaimed -> claimed -> running.
      // The lease event preceded the completed-attempt reset and cannot do this hop.
      append({
        eventType: "task.patched",
        actor: input.actor ?? "store",
        payload: { taskId: input.taskId, patch: { executionState: "claimed" }, source: "retry-admission" }
      });
    }
  } else if (task.executionState !== desiredExecution) {
    assertTransition("execution", task.executionState, desiredExecution);
  }
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

/**
 * Validate and append one executor event; identity is (dispatch, attempt, sequence).
 *
 * With `options.renew` the event also keeps the lane's lease alive (T-143 /
 * C4), in this same transaction and with no credential -- the renewal rules
 * and their rationale live in `appendRunEventClaimRenewal`. A duplicate or
 * conflicting event cannot renew by construction: it is refused here before
 * anything is appended, so a replayed heartbeat extends nothing and needs no
 * rule of its own.
 */
export function recordRunEvent(
  store: StoreHandle,
  rawEvent: RunEvent,
  actor = "store",
  expectedDispatchId?: string,
  options: { renew?: { coordination?: CoordinationSettings; leaseDurationMs?: number; actor?: string; now?: () => Date } } = {}
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
    if (!options.renew) return { ok: true, event };
    // After the event, never before: the renewal is a consequence of evidence
    // that is already in the journal, and both live or die with this one
    // transaction.
    const renewal = appendRunEventClaimRenewal(
      store,
      {
        dispatchId: event.dispatchId,
        attempt: event.attempt,
        actor: options.renew.actor ?? actor,
        coordination: options.renew.coordination,
        leaseDurationMs: options.renew.leaseDurationMs,
        now: options.renew.now
      },
      append
    );
    return { ok: true, event, renewal };
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
  // T-118: shared with the new-event writer gate (events.ts) so command and
  // raw admission can never drift apart on any outcome.
  assertReceiptPlanningAdmission(task.planningState, receipt.outcome);
}
