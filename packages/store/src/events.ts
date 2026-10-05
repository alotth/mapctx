import type { DatabaseSync } from "node:sqlite"
import type { EventLogEntry } from "@mapctx/protocol"
import { assertTransition, type Account, type Budget, type CostEvent, type EstimateSnapshot, type PlanPeriod, type RunEvent, type RunReceipt } from "@mapctx/protocol"
import {
  getTaskDetail,
  getTask,
  getDispatchAttempt,
  applyRunReceipt,
  assertReceiptPlanningAdmission,
  getAcceptance,
  getAcceptanceRevisionHeader,
  insertAccount,
  insertBudget,
  insertCostEvent,
  insertDispatchAttempt,
  insertClaim,
  insertClaimViolation,
  insertEstimateSnapshot,
  insertExportCheckpoint,
  insertHistoryCorrection,
  insertHistoryEvidence,
  insertPlanPeriod,
  insertRunEvent,
  invalidateHistoryEvidence,
  listAcceptanceCriteria,
  patchTask,
  replaceAcceptanceCriteria,
  replaceOutgoingDependencies,
  replaceOwnerExternalRefs,
  setCriterionApproval,
  setProjectAccountBindings,
  updateClaimState,
  upsertAcceptanceRevision,
  upsertProject,
  upsertTask,
  upsertTaskDetail,
  type HistoryCorrectionRecord,
  type HistoryEvidenceRecord
} from "./projections"
import type {
  AcceptanceCriterionRecord,
  DependencyRecord,
  EventRevision,
  ExternalRefRecord,
  ProjectMetadata,
  TaskDetailRecord,
  TaskRecord
} from "./types"

export const EVENT_TYPES = [
  "project.initialized",
  "board.metadata.set",
  "task.upserted",
  "task.patched",
  "task.claimed",
  "task.claim-renewed",
  "task.claim-released",
  "task.claim-expired",
  "checkpoint.exported",
  "dispatch.attempted",
  "run.event-recorded",
  "run.receipt-recorded",
  "cost.recorded",
  "plan-period.recorded",
  "estimate.snapshot-recorded",
  "claim-violation.detected",
  "account.added",
  "project.accounts-set",
  "budget.set",
  "history.evidence-recorded",
  "history.correction-recorded",
  "acceptance.revised",
  "acceptance.approved",
  "acceptance.unapproved",
  "acceptance.imported"
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type ProjectMetadataPayload = ProjectMetadata;

export type TaskUpsertedPayload = {
  task: TaskRecord;
  createOnly?: boolean;
  detail?: TaskDetailRecord;
  outgoingEdges?: DependencyRecord[];
  externalRefs?: ExternalRefRecord[];
};

export type TaskPatchedPayload = {
  taskId: string;
  patch: Partial<TaskRecord>;
  detailPatch?: Partial<TaskDetailRecord>;
  outgoingEdges?: DependencyRecord[];
  source: string;
};

export type TaskClaimedPayload = {
  claimId: string;
  taskId: string;
  leaseToken: string;
  holder: Record<string, unknown>;
  claimedAt: string;
  expiresAt: string;
};

export type TaskClaimRenewedPayload = { claimId: string; taskId: string; expiresAt: string };
export type TaskClaimReleasedPayload = { claimId: string; taskId: string };
export type TaskClaimExpiredPayload = { claimId: string; taskId: string };

export type CheckpointExportedPayload = {
  exportId: string;
  eventCursor: EventRevision;
  filesHash: Record<string, string>;
  reason: string;
  /** T-120: payload schema of the checkpoint record itself. */
  exportSchemaVersion?: number;
  /** T-120: per-task acceptance revisions the exported mirrors were rendered from. */
  acceptanceRevisions?: Record<string, number>;
};

export type DispatchAttemptedPayload = {
  dispatch: {
    dispatchId: string;
    taskId: string;
    executorKind: string;
    attempt: number;
    contextHash: string;
    status: "claimed" | "running" | "completed" | "failed" | "blocked" | "cancelled" | "expired";
    /** T-071: planned workload frozen at hand-off; null for untagged/pre-005 events. */
    workloadAtDispatch?: string | null;
    /** T-071/D5: raw executor identity fact; tiers are derived, never stored. */
    executorModel?: string | null;
  };
};

export type RunReceiptRecordedPayload = {
  receipt: RunReceipt;
  /** T-071: discovered workload read by the store at receipt time; null for untagged/pre-005 events. */
  workloadAtReceipt?: string | null;
};
export type RunEventRecordedPayload = { event: RunEvent };
export type CostRecordedPayload = { cost: CostEvent };
export type PlanPeriodRecordedPayload = { period: PlanPeriod };
export type EstimateSnapshotRecordedPayload = { snapshot: EstimateSnapshot };
export type ClaimViolationDetectedPayload = { violation: import("@mapctx/protocol").ClaimViolation };
export type AccountAddedPayload = { account: Account };
export type ProjectAccountsSetPayload = { projectId: string; accountIds: string[] };
export type BudgetSetPayload = { budget: Budget };
export type HistoryEvidenceRecordedPayload = { evidence: HistoryEvidenceRecord };
export type HistoryCorrectionRecordedPayload = { correction: HistoryCorrectionRecord };

/**
 * T-120: acceptance events. A revise/import REPLACES the full criterion
 * list of a task under a new revision; every criterion lands pending in a
 * revise (approval never carries across revisions -- re-approval is always
 * explicit). Import additionally records where the observed states came
 * from (sha256 of the bytes actually read). Approve/unapprove target one
 * criterion under one explicit revision.
 */
export type AcceptanceRevisedPayload = {
  taskId: string;
  revision: number;
  condition: "criteria" | "empty";
  criteria: AcceptanceCriterionRecord[];
};

export type AcceptanceApprovedPayload = {
  taskId: string;
  revision: number;
  criterionId: string;
  evidence?: Record<string, string> | null;
  approvedAt: string;
};

export type AcceptanceUnapprovedPayload = {
  taskId: string;
  revision: number;
  criterionId: string;
};

export type AcceptanceImportedPayload = AcceptanceRevisedPayload & {
  sourcePath: string;
  sourceSha256: string;
};

/**
 * Applies one journal entry to the SQLite projections. Used both by the live
 * append path and by repair/reindex replay, so projections stay a pure
 * function of the event log.
 */
export function applyEventToProjections(db: DatabaseSync, entry: EventLogEntry): void {
  const revision: EventRevision = { node: entry.nodeId, sequence: entry.sequence };

  switch (entry.eventType as EventType) {
    case "project.initialized":
    case "board.metadata.set": {
      const payload = entry.payload as unknown as ProjectMetadataPayload;
      upsertProject(db, payload);
      return;
    }
    case "task.upserted": {
      const payload = entry.payload as unknown as TaskUpsertedPayload;
      if (payload.createOnly && getTask(db, payload.task.taskId)) throw new Error(`Task already exists: ${payload.task.taskId}`);
      upsertTask(db, payload.task, revision);
      if (payload.detail) upsertTaskDetail(db, payload.detail);
      if (payload.outgoingEdges) replaceOutgoingDependencies(db, payload.task.taskId, payload.outgoingEdges);
      if (payload.externalRefs) replaceOwnerExternalRefs(db, "task", payload.task.taskId, payload.externalRefs);
      return;
    }
    case "task.patched": {
      const payload = entry.payload as unknown as TaskPatchedPayload;
      patchTask(db, payload.taskId, payload.patch, revision);
      if (payload.detailPatch) {
        const currentDetail = getTaskDetail(db, payload.taskId);
        if (!currentDetail) throw new Error(`Cannot apply detailPatch: no task_detail_projection row for ${payload.taskId}`);
        upsertTaskDetail(db, { ...currentDetail, ...payload.detailPatch, taskId: payload.taskId });
      }
      if (payload.outgoingEdges) {
        replaceOutgoingDependencies(db, payload.taskId, payload.outgoingEdges);
      }
      return;
    }
    case "task.claimed": {
      const payload = entry.payload as unknown as TaskClaimedPayload;
      insertClaim(db, {
        claimId: payload.claimId,
        taskId: payload.taskId,
        leaseToken: payload.leaseToken,
        state: "active",
        claimedAt: payload.claimedAt,
        expiresAt: payload.expiresAt,
        holder: payload.holder,
        eventNode: entry.nodeId,
        eventSequence: entry.sequence
      });
      // A new claim is new-attempt admission: a failed execution is terminal
      // for the attempt, not for the task. Re-open it through the machine's
      // one legal edge (failed -> unclaimed) before claiming, so retry works
      // through the normal claim -> dispatch -> receipt flow. Applied here in
      // the shared projection applier, so replay reproduces it identically.
      const execution = getTask(db, payload.taskId)?.executionState;
      if (execution === "failed") {
        assertTransition("execution", execution, "unclaimed");
        patchTask(db, payload.taskId, { executionState: "unclaimed" }, revision);
      }
      if (["unclaimed", "claimed"].includes(getTask(db, payload.taskId)?.executionState ?? "")) {
        patchTask(db, payload.taskId, { executionState: "claimed" }, revision);
      }
      return;
    }
    case "task.claim-renewed": {
      const payload = entry.payload as unknown as TaskClaimRenewedPayload;
      updateClaimState(db, payload.claimId, "active", payload.expiresAt);
      return;
    }
    case "task.claim-released": {
      const payload = entry.payload as unknown as TaskClaimReleasedPayload;
      updateClaimState(db, payload.claimId, "released");
      if (getTask(db, payload.taskId)?.executionState === "claimed") {
        patchTask(db, payload.taskId, { executionState: "unclaimed" }, revision);
      }
      return;
    }
    case "task.claim-expired": {
      const payload = entry.payload as unknown as TaskClaimExpiredPayload;
      updateClaimState(db, payload.claimId, "expired");
      if (getTask(db, payload.taskId)?.executionState === "claimed") {
        patchTask(db, payload.taskId, { executionState: "unclaimed" }, revision);
      }
      return;
    }
    case "checkpoint.exported": {
      const payload = entry.payload as unknown as CheckpointExportedPayload;
      const sourceState: Record<string, unknown> | null =
        payload.exportSchemaVersion !== undefined || payload.acceptanceRevisions !== undefined
          ? {
              ...(payload.exportSchemaVersion !== undefined ? { exportSchemaVersion: payload.exportSchemaVersion } : {}),
              ...(payload.acceptanceRevisions !== undefined ? { acceptanceRevisions: payload.acceptanceRevisions } : {})
            }
          : null;
      insertExportCheckpoint(db, {
        exportId: payload.exportId,
        eventCursor: payload.eventCursor,
        generatedAt: entry.occurredAt,
        filesHash: payload.filesHash,
        reason: payload.reason,
        sourceState
      });
      return;
    }
    case "dispatch.attempted": {
      const payload = entry.payload as unknown as DispatchAttemptedPayload;
      const dispatch = payload.dispatch ?? payload as unknown as DispatchAttemptedPayload["dispatch"];
      const task = getTask(db, dispatch.taskId);
      if (!task) throw new Error(`Cannot dispatch unknown task: ${dispatch.taskId}`);
      // T-118: no admission re-adjudication on the shared applier. Whether a
      // dispatch may touch a terminal-planning task, and which execution
      // transitions (including the journaled retry-admission resets) are
      // legal, is decided where NEW dispatches are admitted (dispatch.ts
      // appendDispatchAttempt). A journal event is an immutable historical
      // fact: replay must project it -- including dispatches recorded under
      // older admission rules (e.g. dispatched while archived, or before the
      // retry-admission reset existed) -- never reject it with today's rules.
      insertDispatchAttempt(db, dispatch);
      const desiredExecution = dispatch.status === "claimed" ? "claimed" : "running";
      if (task.executionState !== desiredExecution) {
        patchTask(db, task.taskId, { executionState: desiredExecution }, revision);
      }
      return;
    }
    case "run.receipt-recorded": {
      const payload = entry.payload as unknown as RunReceiptRecordedPayload;
      applyRunReceipt(db, payload.receipt ?? payload as unknown as RunReceipt, revision, payload.workloadAtReceipt ?? null);
      return;
    }
    case "run.event-recorded": {
      const payload = entry.payload as unknown as RunEventRecordedPayload;
      insertRunEvent(db, payload.event ?? payload as unknown as RunEvent);
      return;
    }
    case "cost.recorded": {
      const payload = entry.payload as unknown as CostRecordedPayload;
      insertCostEvent(db, payload.cost);
      return;
    }
    case "plan-period.recorded": {
      const payload = entry.payload as unknown as PlanPeriodRecordedPayload;
      insertPlanPeriod(db, payload.period);
      return;
    }
    case "estimate.snapshot-recorded": {
      const payload = entry.payload as unknown as EstimateSnapshotRecordedPayload;
      insertEstimateSnapshot(db, payload.snapshot);
      return;
    }
    case "claim-violation.detected": {
      const payload = entry.payload as unknown as ClaimViolationDetectedPayload;
      insertClaimViolation(db, payload.violation);
      return;
    }
    case "account.added": {
      const payload = entry.payload as unknown as AccountAddedPayload;
      insertAccount(db, payload.account);
      return;
    }
    case "project.accounts-set": {
      const payload = entry.payload as unknown as ProjectAccountsSetPayload;
      setProjectAccountBindings(db, payload.projectId, payload.accountIds, entry.logicalClock);
      return;
    }
    case "budget.set": {
      const payload = entry.payload as unknown as BudgetSetPayload;
      insertBudget(db, payload.budget, entry.logicalClock);
      return;
    }
    case "history.evidence-recorded": {
      // T-116: historical evidence is lifecycle-independent. Recording it
      // never touches task_projection: no planning/execution transition, no
      // completedOn change, no claim/dispatch/receipt. Done tasks keep their
      // state and dates; the evidence row is the only write.
      const payload = entry.payload as unknown as HistoryEvidenceRecordedPayload;
      insertHistoryEvidence(db, payload.evidence, revision);
      return;
    }
    case "history.correction-recorded": {
      // T-116: corrections are additive audit facts. The original receipt or
      // evidence row is never rewritten or deleted; the correction row plus
      // (for evidence targets) the status flip is the whole effect.
      const payload = entry.payload as unknown as HistoryCorrectionRecordedPayload;
      insertHistoryCorrection(db, payload.correction, revision);
      if (payload.correction.targetKind === "evidence") {
        invalidateHistoryEvidence(db, payload.correction.targetId);
      }
      return;
    }
    case "acceptance.revised":
    case "acceptance.imported": {
      // T-120: full-list replacement under a new revision. Import is the
      // cutover's observed-state mapping; revise is authored authoring.
      // Both project identically: header upsert + criteria replacement.
      const payload = entry.payload as unknown as AcceptanceRevisedPayload;
      upsertAcceptanceRevision(db, {
        taskId: payload.taskId,
        revision: payload.revision,
        condition: payload.condition,
        revisionEventNode: entry.nodeId,
        revisionEventSequence: entry.sequence
      });
      replaceAcceptanceCriteria(db, payload.taskId, payload.revision, payload.criteria);
      return;
    }
    case "acceptance.approved": {
      const payload = entry.payload as unknown as AcceptanceApprovedPayload;
      const applied = setCriterionApproval(db, payload.taskId, payload.criterionId, payload.revision, {
        state: "approved",
        evidence: payload.evidence ?? null,
        approvedAt: payload.approvedAt,
        approvedBy: entry.actor
      });
      if (!applied) throw new Error(`Cannot apply acceptance.approved: criterion ${payload.criterionId} not found at revision ${payload.revision} for ${payload.taskId}`);
      return;
    }
    case "acceptance.unapproved": {
      const payload = entry.payload as unknown as AcceptanceUnapprovedPayload;
      const applied = setCriterionApproval(db, payload.taskId, payload.criterionId, payload.revision, {
        state: "pending",
        evidence: null,
        approvedAt: null,
        approvedBy: null
      });
      if (!applied) throw new Error(`Cannot apply acceptance.unapproved: criterion ${payload.criterionId} not found at revision ${payload.revision} for ${payload.taskId}`);
      return;
    }
    default:
      throw new Error(`Unknown event type: ${entry.eventType}`);
  }
}

/**
 * T-118: admission rules for NEW events entering through the write API
 * (StoreHandle.appendEvent and the runInWriteTransaction append callback).
 *
 * The shared projection applier must stay a pure projector: it replays
 * historical journal facts (repair, reindex) that were admitted under
 * whatever rules were in force when they were written, so it carries no
 * admission guards. Fresh appends are different -- they create new history,
 * so they must satisfy today's admission rules. The guards that replay must
 * NOT re-apply live here, and are invoked by the writer only:
 *
 * - dispatch.attempted: no dispatching unknown or terminal-planning tasks,
 *   and no execution transition without the journaled retry-admission reset
 *   (the composed command path journals those resets before the dispatch).
 * - run.receipt-recorded: the receipt's target must exist, and a completed
 *   receipt may only land from in-progress/review (the same rule the
 *   command-level receipt admission enforces, with the same remedy).
 * - acceptance.*: the task must exist; revise/import must advance the
 *   per-task revision by exactly one (import refuses any existing
 *   revisioning), revise lands every criterion pending (approval is never
 *   inherited), and approve/unapprove must name an existing criterion under
 *   the current revision in the matching state.
 */
export function assertNewEventAdmission(db: DatabaseSync, entry: EventLogEntry): void {
  if (entry.eventType === "dispatch.attempted") {
    const payload = entry.payload as unknown as DispatchAttemptedPayload;
    const dispatch = payload.dispatch ?? payload as unknown as DispatchAttemptedPayload["dispatch"];
    const task = getTask(db, dispatch.taskId);
    if (!task) throw new Error(`Cannot dispatch unknown task: ${dispatch.taskId}`);
    if (["done", "cancelled", "archived"].includes(task.planningState)) throw new Error(`Cannot dispatch terminal task: ${dispatch.taskId}`);
    const desiredExecution = dispatch.status === "claimed" ? "claimed" : "running";
    if (task.executionState !== desiredExecution) {
      assertTransition("execution", task.executionState, desiredExecution);
    }
    return;
  }
  if (entry.eventType === "run.receipt-recorded") {
    const payload = entry.payload as unknown as RunReceiptRecordedPayload;
    const receipt = payload.receipt ?? payload as unknown as RunReceipt;
    const dispatch = getDispatchAttempt(db, receipt.dispatchId, receipt.attempt);
    if (!dispatch) throw new Error(`Cannot record receipt for unknown dispatch attempt: ${receipt.dispatchId}/${receipt.attempt}`);
    const task = getTask(db, dispatch.taskId);
    if (!task) throw new Error(`Cannot record receipt for unknown task: ${dispatch.taskId}`);
    if (receipt.outcome === "completed" && !["in-progress", "review"].includes(task.planningState)) {
      throw new Error(
        `Cannot record completed receipt: task ${task.taskId} is "${task.planningState}" -- completed receipts land in review from in-progress only. ` +
        `Claim first: \`mapctx task claim ${task.taskId}\` (carries it to doing). If the work already happened outside the flow, that claim + \`mapctx dispatch create ${task.taskId}\` + this same receipt is the retroactive attestation.`
      );
    }
    assertReceiptPlanningAdmission(task.planningState, receipt.outcome);
    return;
  }
  if (entry.eventType.startsWith("acceptance.")) {
    // T-120 admission rules for fresh acceptance events. Replay never
    // re-adjudicates (the shared applier has no guards); these run only
    // where new history is created.
    if (entry.eventType === "acceptance.revised" || entry.eventType === "acceptance.imported") {
      const payload = entry.payload as unknown as AcceptanceRevisedPayload;
      const task = getTask(db, payload.taskId);
      if (!task) throw new Error(`Cannot revise acceptance for unknown task: ${payload.taskId}`);
      const header = getAcceptanceRevisionHeader(db, payload.taskId);
      if (entry.eventType === "acceptance.imported" && header) {
        throw new Error(
          `Cannot import acceptance for ${payload.taskId}: revision ${header.revision} already exists in the store. ` +
          `Import never overwrites canonical revisioning; re-running with an identical source is a reported no-op.`
        );
      }
      const expected = (header?.revision ?? 0) + 1;
      if (payload.revision !== expected) {
        throw new Error(`Cannot revise acceptance for ${payload.taskId}: revision ${payload.revision} does not follow current revision ${header?.revision ?? 0} (expected ${expected}).`);
      }
      if (payload.condition === "criteria" && payload.criteria.length === 0) {
        throw new Error(`Cannot revise acceptance for ${payload.taskId}: condition "criteria" requires at least one criterion.`);
      }
      if (payload.condition === "empty" && payload.criteria.length > 0) {
        throw new Error(`Cannot revise acceptance for ${payload.taskId}: condition "empty" forbids criterion rows.`);
      }
      for (const criterion of payload.criteria) {
        if (entry.eventType === "acceptance.revised") {
          if (criterion.state !== "pending") {
            throw new Error(`Cannot revise acceptance for ${payload.taskId}: revise lands every criterion pending (criterion ${criterion.criterionId} is "${criterion.state}"); approval is explicit.`);
          }
          // A new revision must not smuggle prior approval state back in:
          // approvedAt/approvedBy/evidence belong to approval events, never
          // to a revise. Otherwise a raw pending criterion would silently
          // carry the old revision's evidence (review F5).
          if (criterion.approvedAt != null || criterion.approvedBy != null || criterion.evidence != null) {
            throw new Error(
              `Cannot revise acceptance for ${payload.taskId}: criterion ${criterion.criterionId} carries approval metadata ` +
              `(approvedAt=${criterion.approvedAt ? "set" : "null"}, approvedBy=${criterion.approvedBy ? "set" : "null"}, evidence=${criterion.evidence ? "set" : "null"}). ` +
              `A revise lands all-pending with approval state reset; re-approve explicitly.`
            );
          }
        }
      }
      return;
    }
    const approved = entry.eventType === "acceptance.approved";
    const payload = entry.payload as unknown as AcceptanceApprovedPayload | AcceptanceUnapprovedPayload;
    const task = getTask(db, payload.taskId);
    if (!task) throw new Error(`Cannot change acceptance for unknown task: ${payload.taskId}`);
    const header = getAcceptanceRevisionHeader(db, payload.taskId);
    if (!header) throw new Error(`Cannot change acceptance for ${payload.taskId}: no acceptance revision exists yet.`);
    if (payload.revision !== header.revision) {
      throw new Error(`Cannot change acceptance for ${payload.taskId}: revision ${payload.revision} is stale (current is ${header.revision}); re-read and retry.`);
    }
    const criteria = listAcceptanceCriteria(db, payload.taskId);
    const criterion = criteria.find(item => item.criterionId === payload.criterionId);
    if (!criterion) throw new Error(`Cannot change acceptance for ${payload.taskId}: criterion ${payload.criterionId} does not exist at revision ${header.revision}.`);
    if (approved && criterion.state !== "pending") {
      throw new Error(`Cannot approve ${payload.taskId}/${payload.criterionId}: already approved. Unapprove first if this is intentional.`);
    }
    if (!approved && criterion.state !== "approved") {
      throw new Error(`Cannot unapprove ${payload.taskId}/${payload.criterionId}: criterion is not approved.`);
    }
    return;
  }
}
