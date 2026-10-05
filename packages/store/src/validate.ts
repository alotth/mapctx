import { resolveMapctxToml, resolveProjectStoreDir, isStoreMaterialized } from "./config"
import { checkDrift, type DriftReport } from "./drift"
import { StoreHandle } from "./store-handle"
import { getSingleProject, listDependencies, listTasks } from "./projections"
import { checkTaskAcceptance } from "./tasks"

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

/**
 * T-120: structural/semantic contract validated purely from canonical store
 * projections -- the same guarantees the markdown structural validator gave
 * (graph integrity, date consistency, state consistency) recomputed from
 * task_projection/dependency_projection, with no filesystem input. Under
 * plansAuthority=store this is the operational validation; markdown files
 * are mirrors and cannot influence the result.
 */
export type CanonicalStoreReport = StoreSemanticReport & { totalTasks: number }

const COMPLETION_STATES = new Set(["done", "cancelled", "archived"])

// Canonical enums (protocol schemas) re-checked here because raw event
// patches bypass command-level validation; a poisoned projection must be
// diagnosable without any markdown checkout.
const PLANNING_STATES = new Set(["backlog", "ready", "blocked", "in-progress", "review", "paused", "done", "cancelled", "archived"])
const EXECUTION_STATES = new Set(["unclaimed", "claimed", "running", "blocked", "completed", "failed", "cancelled"])
const TASK_TYPES = new Set(["epic", "feature", "task", "bug", "chore"])
const SPEC_MODES = new Set(["lite", "standard", "strict"])
const DEPENDENCY_KINDS = new Set(["depends-on", "blocks"])

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isIsoDate(value: string | null | undefined): boolean {
  return typeof value === "string" && ISO_DATE_RE.test(value)
}

/**
 * Orders two ISO dates only when BOTH are present and well-formed. A null
 * side is "no constraint", never "before" (T-120 review F1): an open-dated
 * task with a startDate is valid. Malformed values fail the explicit
 * format checks instead of producing a misleading order error.
 */
function compareIsoDates(a?: string | null, b?: string | null): number | null {
  if (!isIsoDate(a) || !isIsoDate(b)) return null;
  return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
}

export function validateCanonicalStore(handle: StoreHandle): CanonicalStoreReport {
  const issues: StoreSemanticIssue[] = []
  const tasks = listTasks(handle.db)
  const byId = new Map(tasks.map(task => [task.taskId, task]))
  const project = getSingleProject(handle.db)
  const domainKeys = new Set((project?.workDomains ?? []).map(domain => domain.key))
  // Review N3: board-level warning ported from the markdown validator
  // (board-tools `empty-work-domains`), DB-only. Warning severity: it never
  // gates operational writers.
  if (domainKeys.size === 0) {
    issues.push({ severity: "warning", code: "empty-work-domains", message: "No work domain keys are declared for the project." })
  }

  for (const task of tasks) {
    if (task.parentTaskId && !byId.has(task.parentTaskId)) {
      issues.push({ severity: "error", code: "unknown-parent", message: `Parent task ${task.parentTaskId} does not exist.`, taskId: task.taskId })
    }
    if (!task.title || task.title.trim() === "") {
      issues.push({ severity: "error", code: "missing-title", message: "Task title is empty.", taskId: task.taskId })
    }
    if (task.type != null && !TASK_TYPES.has(task.type)) {
      issues.push({ severity: "error", code: "invalid-type", message: `Unknown task type "${task.type}".`, taskId: task.taskId })
    }
    if (task.type === "epic" && !task.taskId.startsWith("E-")) {
      issues.push({ severity: "warning", code: "epic-prefix", message: "Epic tasks should use `E-XXX` IDs.", taskId: task.taskId })
    }
    if (task.type != null && task.type !== "epic" && task.taskId.startsWith("E-")) {
      issues.push({ severity: "warning", code: "non-epic-prefix", message: "Non-epic tasks should use `T-XXX` IDs.", taskId: task.taskId })
    }
    if (!PLANNING_STATES.has(task.planningState)) {
      issues.push({ severity: "error", code: "invalid-planning-state", message: `Unknown planning state "${task.planningState}".`, taskId: task.taskId })
    }
    if (!EXECUTION_STATES.has(task.executionState)) {
      issues.push({ severity: "error", code: "invalid-execution-state", message: `Unknown execution state "${task.executionState}".`, taskId: task.taskId })
    }
    if (task.specMode != null && !SPEC_MODES.has(task.specMode)) {
      issues.push({ severity: "error", code: "invalid-specmode", message: '`specMode` must be `lite`, `standard`, `strict`, or null.', taskId: task.taskId })
    }
    // Review N3: warning ported from the markdown validator
    // (board-tools `external-id-format`), DB-only, same severity.
    if (task.externalId != null && !/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:.+$/.test(task.externalId)) {
      issues.push({ severity: "warning", code: "external-id-format", message: "`externalId` should match `<provider>:<entity>:<id>`.", taskId: task.taskId })
    }
    if (task.domains.length > 0 && domainKeys.size === 0) {
      issues.push({ severity: "error", code: "domains-without-work-domains", message: "Task has domains but the project declares no `## Work Domains` keys.", taskId: task.taskId })
    }
    for (const domain of task.domains) {
      if (domainKeys.size > 0 && !domainKeys.has(domain)) {
        issues.push({ severity: "error", code: "invalid-domain", message: `Unknown domain key: ${domain}`, taskId: task.taskId })
      }
    }
    if (task.startDate != null && !isIsoDate(task.startDate)) {
      issues.push({ severity: "error", code: "invalid-start-date", message: "`start` must use YYYY-MM-DD or null.", taskId: task.taskId })
    }
    if (task.dueDate != null && !isIsoDate(task.dueDate)) {
      issues.push({ severity: "error", code: "invalid-due-date", message: "`due` must use YYYY-MM-DD or null.", taskId: task.taskId })
    }
    if (task.completedOn != null && !isIsoDate(task.completedOn)) {
      issues.push({ severity: "error", code: "invalid-completed-date", message: "`completed` must use YYYY-MM-DD or null.", taskId: task.taskId })
    }
    if (task.updatedOn != null && !isIsoDate(task.updatedOn)) {
      issues.push({ severity: "error", code: "invalid-updated-date", message: "`updated` must use YYYY-MM-DD or null.", taskId: task.taskId })
    }
    // T-092 semantic reconciliation: `done` requires a completion date
    // (moveTask stamps it). cancelled/archived are terminal WITHOUT
    // completion -- a null completedOn is legitimate, and a legacy date on
    // a terminal task is preserved (format-checked above, never invented
    // or stripped). Only non-terminal states forbid completedOn.
    if (task.planningState === "done" && !task.completedOn) {
      issues.push({ severity: "error", code: "completion-date-missing", message: 'Task is "done" but completedOn is null.', taskId: task.taskId })
    }
    if (!COMPLETION_STATES.has(task.planningState) && task.completedOn) {
      issues.push({ severity: "error", code: "completion-date-unexpected", message: `Task is "${task.planningState}" but completedOn is set.`, taskId: task.taskId })
    }
    const completedVsStart = compareIsoDates(task.completedOn, task.startDate)
    if (completedVsStart !== null && completedVsStart < 0) {
      issues.push({ severity: "error", code: "completed-before-start", message: "completedOn cannot be before startDate.", taskId: task.taskId })
    }
    const dueVsStart = compareIsoDates(task.dueDate, task.startDate)
    if (dueVsStart !== null && dueVsStart < 0) {
      issues.push({ severity: "error", code: "due-before-start", message: "dueDate cannot be before startDate.", taskId: task.taskId })
    }
    // Missing or incomplete Acceptance is an error only once a task claims
    // completion. Backlog tasks may legitimately have no checklist yet.
    if (task.planningState === "done") {
      const acceptance = checkTaskAcceptance(handle.db, task.taskId)
      if (!acceptance.ok) {
        issues.push({ severity: "error", code: "completion-acceptance-incomplete", message: acceptance.message, taskId: task.taskId })
      }
    }
  }

  // Parent cycles: walk each chain; a repeat means a cycle.
  for (const task of tasks) {
    const seen = new Set<string>([task.taskId])
    let parent = task.parentTaskId ?? null
    while (parent) {
      if (seen.has(parent)) {
        issues.push({ severity: "error", code: "parent-cycle", message: `Parent cycle detected through ${parent}.`, taskId: task.taskId })
        break
      }
      seen.add(parent)
      parent = byId.get(parent)?.parentTaskId ?? null
    }
  }

  const dependencies = listDependencies(handle.db)
  const indegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()
  for (const task of tasks) {
    indegree.set(task.taskId, 0)
    adjacency.set(task.taskId, [])
  }
  for (const edge of dependencies) {
    // Both endpoints of every edge must exist, whatever the kind: a raw
    // `blocks`/upstream edge pointing at a missing task is as poisonous as
    // a dangling depends-on.
    if (!byId.has(edge.fromTaskId)) {
      issues.push({ severity: "error", code: "unknown-dependency-source", message: `Dependency edge source ${edge.fromTaskId} does not exist (edge ${edge.fromTaskId} -> ${edge.toTaskId}, kind ${edge.kind}).`, taskId: edge.toTaskId })
      continue
    }
    if (edge.kind !== "depends-on" && edge.kind !== "blocks") {
      issues.push({ severity: "error", code: "unknown-dependency-kind", message: `Unknown dependency kind "${edge.kind}" on edge ${edge.fromTaskId} -> ${edge.toTaskId}.`, taskId: edge.fromTaskId })
      continue
    }
    if (!byId.has(edge.toTaskId)) {
      issues.push({ severity: "error", code: "unknown-dependency", message: `Dependency target ${edge.toTaskId} does not exist.`, taskId: edge.fromTaskId })
      continue
    }
    if (edge.toTaskId === edge.fromTaskId) {
      issues.push({ severity: "error", code: "self-dependency", message: `Task depends on itself.`, taskId: edge.fromTaskId })
      continue
    }
    if (edge.kind !== "depends-on") continue
    indegree.set(edge.fromTaskId, (indegree.get(edge.fromTaskId) ?? 0) + 1)
    adjacency.get(edge.toTaskId)?.push(edge.fromTaskId)
  }
  const queue = tasks.map(task => task.taskId).filter(id => (indegree.get(id) ?? 0) === 0)
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift() as string
    visited += 1
    for (const next of adjacency.get(id) ?? []) {
      const after = (indegree.get(next) ?? 0) - 1
      indegree.set(next, after)
      if (after === 0) queue.push(next)
    }
  }
  if (visited !== tasks.length) {
    const cycleIds = tasks.map(task => task.taskId).filter(id => (indegree.get(id) ?? 0) > 0)
    issues.push({ severity: "error", code: "dependency-cycle", message: `Dependency cycle detected: ${cycleIds.join(", ")}` })
  }

  const counts = new Map<string, number>()
  for (const task of tasks) if (task.updatedOn) counts.set(task.updatedOn, (counts.get(task.updatedOn) ?? 0) + 1)
  for (const [date, count] of counts) {
    if (count >= 10) issues.push({ severity: "warning", code: "bulk-updated-timestamp", message: `${count} tasks share updated date ${date}; event history carries no per-task distinction.` })
  }

  return {
    totalTasks: tasks.length,
    errors: issues.filter(issue => issue.severity === "error").length,
    warnings: issues.filter(issue => issue.severity === "warning").length,
    issues
  }
}

export type StoreValidateResult =
  | { status: "no-project"; }
  | { status: "markdown-authority"; projectId: string }
  | { status: "not-materialized"; projectId: string; storeDir: string }
  | { status: "maintenance-needed"; projectId: string; storeDir: string; maintenanceNeeded: string }
  | { status: "store-authority"; projectId: string; canonical: CanonicalStoreReport; semantic: StoreSemanticReport };

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
  return {
    errors: issues.filter(issue => issue.severity === "error").length,
    warnings: issues.filter(issue => issue.severity === "warning").length,
    issues
  }
}

/**
 * T-120: explicit snapshot check, separate from operational validation.
 * Byte-compares the local checkout mirror against a freshly built export.
 * Never part of `mapctx validate` under store authority unless --snapshots
 * is passed; its result is advisory and can never gate operational moves.
 */
export type SnapshotCheckResult =
  | { status: "store-authority"; projectId: string; drift: DriftReport }
  | { status: "no-project" }
  | { status: "markdown-authority"; projectId: string }
  | { status: "not-materialized"; projectId: string; storeDir: string }
  | { status: "maintenance-needed"; projectId: string; storeDir: string; maintenanceNeeded: string };

export function checkStoreSnapshots(cwd: string, tasksRoot: string): SnapshotCheckResult {
  const regime = validateStoreRegime(cwd)
  if (regime.status !== "store-authority") return regime
  const handle = StoreHandle.openReadOnly(resolveProjectStoreDir(regime.projectId))
  try {
    return { status: "store-authority", projectId: regime.projectId, drift: checkDrift(handle.db, tasksRoot) }
  } finally {
    handle.close()
  }
}

/**
 * The store-specific half of `mapctx validate`: resolves mapctx.toml and,
 * only when plansAuthority is "store", runs the canonical validation -- a
 * project still on plansAuthority: "markdown" is unaffected (ADR 0003
 * "Authority and cutover"), and a "store" project missing its local
 * mapctx.db fails closed instead of silently treating Markdown as
 * authoritative.
 *
 * T-120: under store authority the operational result is computed purely
 * from canonical store state via a read-only handle. Local TASKS.md /
 * tasks/*.md mirrors are never read here -- divergent or absent mirrors
 * cannot change the outcome. Snapshot comparison is an explicit separate
 * operation (checkStoreSnapshots).
 */
export function validateStoreRegime(cwd: string): StoreValidateResult {
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
    const canonical = validateCanonicalStore(handle);
    const semantic = validateStoreSemantics(handle);
    return { status: "store-authority", projectId: resolved.config.projectId, canonical, semantic };
  } finally {
    handle.close();
  }
}
