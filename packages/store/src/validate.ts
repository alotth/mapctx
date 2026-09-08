import { resolveMapctxToml, resolveProjectStoreDir, isStoreMaterialized } from "./config"
import { checkDrift, type DriftReport } from "./drift"
import { StoreHandle } from "./store-handle"
import { listTasks } from "./projections"

export type StoreSemanticIssue = {
  severity: "error" | "warning"
  code: string
  message: string
  taskId?: string
}

export type StoreSemanticReport = {
  errors: number
  warnings: number
  issues: StoreSemanticIssue[]
}

export type StoreValidateResult =
  | { status: "no-project"; }
  | { status: "markdown-authority"; projectId: string }
  | { status: "not-materialized"; projectId: string; storeDir: string }
  | { status: "maintenance-needed"; projectId: string; storeDir: string; maintenanceNeeded: string }
  | { status: "store-authority"; projectId: string; drift: DriftReport; semantic: StoreSemanticReport };

/** Validate fields whose authority exists only in the event-backed store. */
export function validateStoreSemantics(handle: StoreHandle): StoreSemanticReport {
  const issues: StoreSemanticIssue[] = []
  const tasks = listTasks(handle.db)
  const events = handle.listEvents()
  const latestTaskEvent = new Map<string, string>()
  for (const event of events) {
    const payload = event.payload as { task?: { taskId?: string; updatedOn?: string | null }; taskId?: string; patch?: { updatedOn?: string | null } }
    const taskId = payload.task?.taskId ?? payload.taskId
    if (!taskId || !event.eventType.startsWith("task.")) continue
    latestTaskEvent.set(taskId, event.occurredAt.slice(0, 10))
  }
  for (const task of tasks) {
    const eventDate = latestTaskEvent.get(task.taskId)
    if (task.updatedOn && eventDate && task.updatedOn > eventDate) {
      issues.push({ severity: "error", code: "updated-after-event-history", message: `updated ${task.updatedOn} is after latest task event ${eventDate}.`, taskId: task.taskId })
    }
  }
  const counts = new Map<string, number>()
  for (const task of tasks) if (task.updatedOn) counts.set(task.updatedOn, (counts.get(task.updatedOn) ?? 0) + 1)
  for (const [date, count] of counts) {
    if (count >= 10) issues.push({ severity: "warning", code: "bulk-updated-timestamp", message: `${count} tasks share updated date ${date}; event history carries no per-task distinction.` })
  }
  return {
    errors: issues.filter(issue => issue.severity === "error").length,
    warnings: issues.filter(issue => issue.severity === "warning").length,
    issues
  }
}

/**
 * The store-specific half of `mapctx validate`: resolves mapctx.toml and,
 * only when plansAuthority is "store", runs the drift check -- a project
 * still on plansAuthority: "markdown" is unaffected (ADR 0003 "Authority
 * and cutover"), and a "store" project missing its local mapctx.db fails
 * closed instead of silently treating Markdown as authoritative.
 */
export function validateStoreRegime(cwd: string, tasksRoot: string): StoreValidateResult {
  const resolved = resolveMapctxToml(cwd);
  if (!resolved) return { status: "no-project" };

  if (resolved.config.plansAuthority === "markdown") {
    return { status: "markdown-authority", projectId: resolved.config.projectId };
  }

  const storeDir = resolveProjectStoreDir(resolved.config.projectId);
  if (!isStoreMaterialized(storeDir)) {
    return { status: "not-materialized", projectId: resolved.config.projectId, storeDir };
  }

  // R14: validation is a diagnostic read -- observe through a read-only
  // handle and surface pending maintenance as an explicit result instead of
  // healing it as a side effect.
  const handle = StoreHandle.openReadOnly(storeDir);
  try {
    const maintenance = handle.maintenanceNeeded();
    if (maintenance) {
      // R14 review P2#2: maintenance-needed is its own status, not a
      // "not-materialized" alias -- the remedy is repair, not store init.
      return { status: "maintenance-needed", projectId: resolved.config.projectId, storeDir, maintenanceNeeded: maintenance };
    }
    const drift = checkDrift(handle.db, tasksRoot);
    const semantic = validateStoreSemantics(handle);
    return { status: "store-authority", projectId: resolved.config.projectId, drift, semantic };
  } finally {
    handle.close();
  }
}
