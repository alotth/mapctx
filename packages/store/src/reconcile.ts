import * as fs from "fs"
import * as path from "path"
import type { DatabaseSync } from "node:sqlite"
import { parseTasksFile, readTaskDetailFile } from "@mapctx/core"
import { STATUS_TO_PLANNING } from "@mapctx/protocol"
import { buildExport } from "./export"
import { getTask, getTaskDetail, listOutgoingDependencies } from "./projections"
import type { StoreHandle } from "./store-handle"
import type { DependencyRecord, TaskDetailRecord, TaskRecord } from "./types"

export type FieldDiff = {
  field: string;
  storeValue: unknown;
  fileValue: unknown;
};

export type ReconcileDiff = {
  taskId: string;
  hasDrift: boolean;
  taskFields: FieldDiff[];
  detailFields: FieldDiff[];
};

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sortedArr(items: string[]): string[] {
  return [...items].sort();
}

/**
 * Diffs the on-disk (possibly manually edited) TASKS.md block and detail
 * file for one task against current store state, field by field. Used by
 * `mapctx reconcile <task-id>` to show exactly what would change under
 * discard (revert to store) vs. accept (write the edit into the store).
 */
export function diffTaskForReconcile(db: DatabaseSync, tasksRoot: string, taskId: string): ReconcileDiff {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);

  const tasksMdPath = path.join(tasksRoot, "TASKS.md");
  const board = parseTasksFile(tasksMdPath);
  const boardTask = board.tasks.find(t => t.id === taskId);
  if (!boardTask) throw new Error(`Task ${taskId} not found in ${tasksMdPath}`);

  const taskFields: FieldDiff[] = [];
  const push = (field: string, storeValue: unknown, fileValue: unknown) => {
    if (!eq(storeValue, fileValue)) taskFields.push({ field, storeValue, fileValue });
  };

  const filePlanningState = STATUS_TO_PLANNING[boardTask.status] ?? task.planningState;
  push("planningState", task.planningState, filePlanningState);
  push("type", task.type ?? null, boardTask.type ?? null);
  push("parentTaskId", task.parentTaskId ?? null, boardTask.parent ?? null);
  push("priority", task.priority ?? null, boardTask.priority ?? null);
  push("workload", task.workload ?? null, boardTask.workload ?? null);
  push("tags", sortedArr(task.tags), sortedArr(boardTask.tags ?? []));
  push("domains", sortedArr(task.domains), sortedArr(boardTask.domains ?? boardTask.touch ?? []));
  push("startDate", task.startDate ?? null, boardTask.start ?? null);
  push("dueDate", task.dueDate ?? null, boardTask.due ?? null);
  push("completedOn", task.completedOn ?? null, boardTask.completed ?? null);
  push("externalId", task.externalId ?? null, boardTask.externalId ?? null);
  push("updatedOn", task.updatedOn ?? null, boardTask.updated ?? null);
  push("iteration", task.iteration ?? null, boardTask.iteration ?? null);
  push("assignees", sortedArr(task.assignees), sortedArr(boardTask.assignees ?? []));
  push("externalLinks", sortedArr(task.externalLinks), sortedArr(boardTask.externalLinks ?? []));
  push("milestone", task.milestone ?? null, boardTask.milestone ?? null);
  push("specMode", task.specMode ?? null, boardTask.specMode ?? null);

  const storeDependsOn = sortedArr(listOutgoingDependencies(db, taskId).filter(e => e.kind === "depends-on").map(e => e.toTaskId));
  const fileDependsOn = sortedArr(boardTask.dependsOn ?? []);
  push("dependsOn", storeDependsOn, fileDependsOn);

  const detailFields: FieldDiff[] = [];
  const detail = getTaskDetail(db, taskId);
  if (task.detailPath && detail) {
    const detailFilePath = path.resolve(tasksRoot, task.detailPath);
    if (fs.existsSync(detailFilePath)) {
      const onDisk = readTaskDetailFile(detailFilePath);
      const pushDetail = (field: string, storeValue: unknown, fileValue: unknown) => {
        if (!eq(storeValue, fileValue)) detailFields.push({ field, storeValue, fileValue });
      };
      pushDetail("role", detail.role, onDisk.role);
      pushDetail("impact", detail.impact, onDisk.impact);
      pushDetail("estimatedEffort", detail.estimatedEffort, onDisk.estimatedEffort);
      pushDetail("filesAffected", sortedArr(detail.filesAffected), sortedArr(onDisk.filesAffected));
      pushDetail("testsRequired", sortedArr(detail.testsRequired), sortedArr(onDisk.testsRequired));
      pushDetail("summary", detail.summary, onDisk.summary);

      const storeBlocking = sortedArr(listOutgoingDependencies(db, taskId).filter(e => e.kind === "blocks").map(e => e.toTaskId));
      const fileBlocking = sortedArr(onDisk.blocking);
      pushDetail("blocking", storeBlocking, fileBlocking);
    }
  }

  return { taskId, hasDrift: taskFields.length > 0 || detailFields.length > 0, taskFields, detailFields };
}

/**
 * Discard: regenerate TASKS.md and this task's detail file from current
 * store state, throwing away the on-disk manual edit. Mechanically the same
 * write path as `mapctx export`, since the store did not change.
 */
export function reconcileDiscard(db: DatabaseSync, tasksRoot: string): void {
  const exported = buildExport(db, { tasksRoot });
  fs.writeFileSync(exported.tasksMd.path, exported.tasksMd.content, "utf8");
  for (const file of exported.taskDetailFiles) {
    fs.writeFileSync(file.path, file.content, "utf8");
  }
}

/**
 * Accept: writes the on-disk edit into the store as a new task.patched event
 * with `source: manual-reconcile` provenance (never a silent merge -- the
 * event is what makes the acceptance an auditable, attributable mutation),
 * then re-exports so the file and the store agree again.
 */
export function reconcileAccept(store: StoreHandle, tasksRoot: string, taskId: string, actor: string): ReconcileDiff {
  const diff = diffTaskForReconcile(store.db, tasksRoot, taskId);
  if (!diff.hasDrift) return diff;

  const patch: Partial<TaskRecord> = {};
  for (const field of diff.taskFields) {
    (patch as Record<string, unknown>)[field.field] = field.field === "dependsOn" ? undefined : field.fileValue;
  }
  delete (patch as Record<string, unknown>).dependsOn;

  const detailPatch: Partial<TaskDetailRecord> = {};
  for (const field of diff.detailFields) {
    if (field.field === "blocking") continue;
    (detailPatch as Record<string, unknown>)[field.field] = field.fileValue;
  }

  const dependsOnField = diff.taskFields.find(f => f.field === "dependsOn");
  const blockingField = diff.detailFields.find(f => f.field === "blocking");
  let outgoingEdges: DependencyRecord[] | undefined;
  if (dependsOnField || blockingField) {
    const dependsOn = (dependsOnField ? dependsOnField.fileValue : listOutgoingDependencies(store.db, taskId).filter(e => e.kind === "depends-on").map(e => e.toTaskId)) as string[];
    const blocking = (blockingField ? blockingField.fileValue : listOutgoingDependencies(store.db, taskId).filter(e => e.kind === "blocks").map(e => e.toTaskId)) as string[];
    outgoingEdges = [
      ...dependsOn.map(toTaskId => ({ fromTaskId: taskId, toTaskId, kind: "depends-on" as const })),
      ...blocking.map(toTaskId => ({ fromTaskId: taskId, toTaskId, kind: "blocks" as const }))
    ];
  }

  store.appendEvent({
    eventType: "task.patched",
    actor,
    payload: {
      taskId,
      patch,
      ...(Object.keys(detailPatch).length > 0 ? { detailPatch } : {}),
      ...(outgoingEdges ? { outgoingEdges } : {}),
      source: "manual-reconcile"
    }
  });

  reconcileDiscard(store.db, tasksRoot);
  return diff;
}
