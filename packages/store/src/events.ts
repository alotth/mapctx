import type { DatabaseSync } from "node:sqlite"
import type { EventLogEntry } from "@mapctx/protocol"
import { assertTransition, type Account, type Budget, type CostEvent, type EstimateSnapshot, type PlanPeriod, type RunEvent, type RunReceipt } from "@mapctx/protocol"
import {
  getTaskDetail,
  getTask,
  applyRunReceipt,
  insertAccount,
  insertBudget,
  insertCostEvent,
  insertDispatchAttempt,
  insertClaim,
  insertClaimViolation,
  insertEstimateSnapshot,
  insertExportCheckpoint,
  insertPlanPeriod,
  insertRunEvent,
  patchTask,
  replaceOutgoingDependencies,
  replaceOwnerExternalRefs,
  setProjectAccountBindings,
  updateClaimState,
  upsertProject,
  upsertTask,
  upsertTaskDetail
} from "./projections"
import type {
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
  "budget.set"
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type ProjectMetadataPayload = ProjectMetadata;

export type TaskUpsertedPayload = {
  task: TaskRecord;
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
      patchTask(db, payload.taskId, { executionState: "claimed" }, revision);
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
      patchTask(db, payload.taskId, { executionState: "unclaimed" }, revision);
      return;
    }
    case "task.claim-expired": {
      const payload = entry.payload as unknown as TaskClaimExpiredPayload;
      updateClaimState(db, payload.claimId, "expired");
      patchTask(db, payload.taskId, { executionState: "unclaimed" }, revision);
      return;
    }
    case "checkpoint.exported": {
      const payload = entry.payload as unknown as CheckpointExportedPayload;
      insertExportCheckpoint(db, {
        exportId: payload.exportId,
        eventCursor: payload.eventCursor,
        generatedAt: entry.occurredAt,
        filesHash: payload.filesHash,
        reason: payload.reason
      });
      return;
    }
    case "dispatch.attempted": {
      const payload = entry.payload as unknown as DispatchAttemptedPayload;
      const dispatch = payload.dispatch ?? payload as unknown as DispatchAttemptedPayload["dispatch"];
      insertDispatchAttempt(db, dispatch);
      const task = getTask(db, dispatch.taskId);
      if (!task) throw new Error(`Cannot dispatch unknown task: ${dispatch.taskId}`);
      const desiredExecution = dispatch.status === "claimed" ? "claimed" : "running";
      if (task.executionState !== desiredExecution) {
        assertTransition("execution", task.executionState, desiredExecution);
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
    default:
      throw new Error(`Unknown event type: ${entry.eventType}`);
  }
}
