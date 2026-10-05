import * as fs from "fs"
import * as path from "path"
import type { DatabaseSync } from "node:sqlite"
import { parseTasksFile, readTaskDetailFile } from "@mapctx/core"
import { parseEstimatedEffortMs, STATUS_TO_PLANNING, workloadSchema } from "@mapctx/protocol"
import { buildExport } from "./export"
import { getTask, getTaskDetail, listOutgoingDependencies } from "./projections"
import { checkTaskAcceptance } from "./tasks"
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

function authoredEffortSource(filePath: string): string | undefined {
  const matches = [...fs.readFileSync(filePath, "utf8").matchAll(/^  - estimatedEffortSource:\s*(.*)$/gm)];
  if (matches.length > 1) return "<duplicate>";
  return matches[0]?.[1].trim();
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
      // The ordinary detail parser intentionally ignores unknown metadata.
      // Reconcile must see the authored value to reject invalid provenance.
      pushDetail("estimatedEffortSource", detail.estimatedEffortSource, authoredEffortSource(detailFilePath));
      pushDetail("waitReason", detail.waitReason, onDisk.waitReason);
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

  const boardTask = parseTasksFile(path.join(tasksRoot, "TASKS.md")).tasks.find(task => task.id === taskId);
  if (boardTask?.droppedFields?.workload) {
    throw new Error(`Invalid workload "${boardTask.droppedFields.workload}"; expected ${workloadSchema.options.join("|")}`);
  }
  if (!diff.hasDrift) return diff;
  const workload = diff.taskFields.find(field => field.field === "workload")?.fileValue;
  if (workload != null && !workloadSchema.safeParse(workload).success) {
    throw new Error(`Invalid workload "${workload}"; expected ${workloadSchema.options.join("|")}`);
  }
  const effortField = diff.detailFields.find(field => field.field === "estimatedEffort");
  const sourceField = diff.detailFields.find(field => field.field === "estimatedEffortSource");
  if (sourceField && sourceField.fileValue !== undefined &&
      sourceField.fileValue !== "agent-active" && sourceField.fileValue !== "legacy-human") {
    throw new Error(`Invalid estimatedEffortSource "${sourceField.fileValue}"; expected agent-active|legacy-human`);
  }
  const onDiskEffort = effortField?.fileValue as string | undefined;
  if (effortField && onDiskEffort && parseEstimatedEffortMs(onDiskEffort) === null) {
    throw new Error(`Invalid estimatedEffort "${onDiskEffort}"; expected a positive m|h|d|w duration`);
  }

  const planningChange = diff.taskFields.find(field => field.field === "planningState");
  if (planningChange?.fileValue === "done") {
    // T-120: the done gate reads the canonical acceptance revision in the
    // store -- a manual markdown edit can never approve criteria by itself.
    const acceptance = checkTaskAcceptance(store.db, taskId);
    if (!acceptance.ok) throw new Error(acceptance.message);
  }

  const patch: Partial<TaskRecord> = {};
  for (const field of diff.taskFields) {
    (patch as Record<string, unknown>)[field.field] = field.field === "dependsOn" ? undefined : field.fileValue;
  }
  delete (patch as Record<string, unknown>).dependsOn;

  const detailPatch: Partial<TaskDetailRecord> = {};
  for (const field of diff.detailFields) {
    if (field.field === "blocking") continue;
    (detailPatch as Record<string, unknown>)[field.field] = field.field === "waitReason" && field.fileValue === undefined ? null : field.fileValue;
  }
  if (effortField) {
    // A changed estimate is a fresh agent-active declaration, even when the
    // manually edited file still carries an old legacy marker.
    detailPatch.estimatedEffortSource = onDiskEffort ? "agent-active" : "legacy-human";
  } else if (sourceField && sourceField.fileValue === undefined) {
    // JSON events cannot carry `undefined`; use an explicit clearing marker.
    detailPatch.estimatedEffortSource = "legacy-human";
  }
  const effectiveEffort = effortField ? onDiskEffort : getTaskDetail(store.db, taskId)?.estimatedEffort;
  if (detailPatch.estimatedEffortSource === "agent-active" && (!effectiveEffort || parseEstimatedEffortMs(effectiveEffort) === null)) {
    throw new Error("estimatedEffortSource agent-active requires a valid estimatedEffort");
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
