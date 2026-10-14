import * as crypto from "crypto"
import { resolveMapctxToml, resolveProjectStoreDir, isStoreMaterialized } from "./config"
import { checkDrift, type DriftReport } from "./drift"
import { StoreHandle } from "./store-handle"
import { getSingleProject, getTaskDetail, listDependencies, listTasks } from "./projections"
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

/**
 * T-157: renders a list the way `mapctx task update` reads it back. An empty
 * list is `""`, not an omitted flag -- omitting the flag is now a no-op on that
 * kind, so a repair command that drops it would leave the divergence in place.
 */
function repairList(ids: readonly string[]): string {
  const unique = [...new Set(ids)].sort()
  return unique.length === 0 ? '""' : unique.join(",")
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

  // T-157: a dependency exists on two surfaces -- the edge in
  // dependency_projection and the id in the detail list -- and `task update
  // --depends-on/--blocking` promises they can never disagree. Until the
  // T-157 fix, supplying one list deleted the other kind's edges and left its
  // detail list behind, so a store written before it can carry a divergence
  // that nothing else diagnoses: `plan`/`gantt` read only the edges, and
  // `export` rebuilds BOTH detail lists from the edges, so the snapshot looks
  // correct and the next export quietly erases the orphaned list for good.
  // Error severity, because either surface is a real planning input and the
  // store cannot tell which one is the truth.
  for (const task of tasks) {
    const detail = getTaskDetail(handle.db, task.taskId)
    if (!detail) continue
    for (const surface of [
      { kind: "depends-on" as const, flag: "--depends-on", list: detail.prerequisites, field: "prerequisites" },
      { kind: "blocks" as const, flag: "--blocking", list: detail.blocking, field: "blocking" }
    ]) {
      const fromDetail = [...new Set(surface.list)].sort()
      const fromEdges = [...new Set(
        dependencies.filter(edge => edge.fromTaskId === task.taskId && edge.kind === surface.kind).map(edge => edge.toTaskId)
      )].sort()
      if (fromDetail.length === fromEdges.length && fromDetail.every((id, index) => id === fromEdges[index])) continue
      issues.push({
        severity: "error",
        code: "dependency-detail-divergence",
        message: `detail ${surface.field} ${JSON.stringify(fromDetail)} does not match the ${surface.kind} edges ${JSON.stringify(fromEdges)}.`
          + ` Repair by replaying BOTH lists through one update, which rewrites each surface from the other:`
          + ` mapctx task update ${task.taskId} --depends-on ${repairList(detail.prerequisites)} --blocking ${repairList(detail.blocking)}`
          + ` (substitute the list you consider authoritative; omitting a flag now leaves that kind untouched).`,
        taskId: task.taskId
      })
    }
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
// ---------------------------------------------------------------------------
// T-127 (R7): `validate` as a usable gate.
//
// The reported friction is that a board carrying old issues drowns the one
// issue a run just introduced, so the command is useless as a pass/fail gate.
// Two orthogonal, purely functional selectors fix that without touching any
// validation rule: restrict the report to named tasks (`--task`), and accept a
// recorded set of pre-existing issues that must not fail (`--baseline`).
//
// Both operate on the issue shape every validator in the repo already emits
// (store canonical/semantic issues and the markdown structural report), so one
// implementation serves both authority regimes.
// ---------------------------------------------------------------------------

export type ValidationGateIssue = {
  severity: "error" | "warning"
  code: string
  message: string
  taskId?: string
}

export const VALIDATION_BASELINE_SCHEMA_VERSION = 1

export type ValidationBaselineEntry = {
  fingerprint: string
  severity: "error" | "warning"
  code: string
  taskId: string | null
  message: string
}

export type ValidationBaselineFile = {
  schemaVersion: number
  issues: ValidationBaselineEntry[]
}

/**
 * Identity of one issue for baseline purposes. The message is part of it on
 * purpose: `invalid-domain` on the same task with a different unknown key is a
 * different problem, and a baseline that collapsed them would silence the
 * second one. The cost is that rewording a validator message invalidates the
 * baselines that recorded it, which is the honest direction to fail in -- a
 * stale entry is reported, never silently honoured.
 */
export function validationIssueFingerprint(issue: ValidationGateIssue): string {
  return crypto
    .createHash("sha256")
    .update([issue.severity, issue.code, issue.taskId ?? "", issue.message].join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 32)
}

function baselineEntry(issue: ValidationGateIssue): ValidationBaselineEntry {
  return {
    fingerprint: validationIssueFingerprint(issue),
    severity: issue.severity,
    code: issue.code,
    taskId: issue.taskId ?? null,
    message: issue.message
  }
}

/** Serializable baseline for the issues passed in, ordered deterministically. */
export function buildValidationBaseline(issues: ValidationGateIssue[]): ValidationBaselineFile {
  const byFingerprint = new Map<string, ValidationBaselineEntry>()
  for (const issue of issues) {
    const entry = baselineEntry(issue)
    if (!byFingerprint.has(entry.fingerprint)) byFingerprint.set(entry.fingerprint, entry)
  }
  const sorted = [...byFingerprint.values()].sort((a, b) =>
    a.code.localeCompare(b.code)
    || (a.taskId ?? "").localeCompare(b.taskId ?? "")
    || a.message.localeCompare(b.message)
    || a.fingerprint.localeCompare(b.fingerprint)
  )
  return { schemaVersion: VALIDATION_BASELINE_SCHEMA_VERSION, issues: sorted }
}

/**
 * Reads a baseline written by buildValidationBaseline. Throws on anything it
 * cannot vouch for: a gate that silently treats an unreadable baseline as
 * "nothing accepted" would turn a typo into a wall of pre-existing failures,
 * and one that treated it as "everything accepted" would pass a broken board.
 */
export function parseValidationBaseline(content: string): ValidationBaselineFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(`Baseline is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Baseline must be a JSON object produced by `mapctx validate --write-baseline`.")
  }
  const file = parsed as Partial<ValidationBaselineFile>
  if (file.schemaVersion !== VALIDATION_BASELINE_SCHEMA_VERSION) {
    throw new Error(`Unsupported baseline schemaVersion ${String(file.schemaVersion)}; expected ${VALIDATION_BASELINE_SCHEMA_VERSION}. Regenerate with \`mapctx validate --write-baseline\`.`)
  }
  if (!Array.isArray(file.issues)) {
    throw new Error("Baseline is missing the `issues` array.")
  }
  const issues = file.issues.map((entry, index) => {
    if (!entry || typeof entry !== "object" || typeof (entry as ValidationBaselineEntry).fingerprint !== "string") {
      throw new Error(`Baseline issues[${index}] has no fingerprint.`)
    }
    return entry as ValidationBaselineEntry
  })
  return { schemaVersion: file.schemaVersion, issues }
}

export type ValidationGateOptions = {
  /** Keep only issues attributed to these task ids. Undefined keeps every issue. */
  tasks?: string[]
  /** Fingerprints that must not fail. */
  baseline?: ValidationBaselineFile
}

export type ValidationGateResult<TIssue extends ValidationGateIssue> = {
  /** Issues that survived the selectors -- the ones the gate reports and counts. */
  issues: TIssue[]
  errors: number
  warnings: number
  /** Task ids the filter asked for. */
  taskFilter: string[] | null
  /** Issues dropped because they belong to another task. */
  filteredOutByTask: number
  /**
   * Issues dropped because the filter is task-scoped and they carry no task
   * attribution (board-level findings like `dependency-cycle`). Counted and
   * reported separately so a task-scoped gate never hides them in silence.
   */
  boardScopedExcluded: number
  /**
   * The excluded board-scoped issues that are ERRORS. `--task` is a filter,
   * and `--baseline` is the gate, so these legitimately stop counting -- but
   * an exit code of 0 while the board carries an unattributable error is
   * exactly the kind of quiet pass this feature exists to prevent, so the
   * caller is told about them explicitly.
   */
  boardScopedErrors: ValidationGateIssue[]
  /** Issues present and accepted by the baseline. */
  baselined: number
  /**
   * Baseline entries that matched no reported issue, each with WHY (review
   * A11): `not-reported` means the board no longer has it and it can be
   * dropped; `out-of-scope` means `--task` excluded the issue it covers, so
   * it is still valid for the whole board and must NOT be dropped.
   */
  staleBaseline: Array<ValidationBaselineEntry & { cause: "not-reported" | "out-of-scope" }>
}

/**
 * Applies `--task` and `--baseline` to one issue list. Pure: no filesystem,
 * no store, no ordering change to the issues it keeps.
 *
 * `--task` is intersected BEFORE the baseline so `staleBaseline` is reported
 * against the issues actually in scope; the baseline is matched by fingerprint
 * only, so a baseline recorded for the whole board works unchanged under a
 * narrower `--task`.
 */
export function applyValidationGate<TIssue extends ValidationGateIssue>(
  issues: TIssue[],
  options: ValidationGateOptions = {}
): ValidationGateResult<TIssue> {
  const taskFilter = options.tasks && options.tasks.length > 0 ? [...new Set(options.tasks)] : null
  const wanted = taskFilter ? new Set(taskFilter) : null

  let filteredOutByTask = 0
  let boardScopedExcluded = 0
  const boardScopedErrors: ValidationGateIssue[] = []
  const inScope: TIssue[] = []
  for (const issue of issues) {
    if (!wanted) { inScope.push(issue); continue }
    if (issue.taskId === undefined || issue.taskId === null) {
      boardScopedExcluded += 1
      if (issue.severity === "error") boardScopedErrors.push(issue)
      continue
    }
    if (!wanted.has(issue.taskId)) { filteredOutByTask += 1; continue }
    inScope.push(issue)
  }

  const accepted = new Set((options.baseline?.issues ?? []).map(entry => entry.fingerprint))
  const matched = new Set<string>()
  const kept: TIssue[] = []
  let baselined = 0
  for (const issue of inScope) {
    const fingerprint = validationIssueFingerprint(issue)
    if (accepted.has(fingerprint)) {
      matched.add(fingerprint)
      baselined += 1
      continue
    }
    kept.push(issue)
  }
  // An entry that matched nothing in scope may still describe an issue the
  // task filter excluded, so the two causes are told apart against the FULL
  // issue list before any advice is given.
  const allFingerprints = new Set(issues.map(issue => validationIssueFingerprint(issue)))
  const staleBaseline = (options.baseline?.issues ?? [])
    .filter(entry => !matched.has(entry.fingerprint))
    .map(entry => ({
      ...entry,
      cause: allFingerprints.has(entry.fingerprint) ? ("out-of-scope" as const) : ("not-reported" as const)
    }))

  return {
    issues: kept,
    errors: kept.filter(issue => issue.severity === "error").length,
    warnings: kept.filter(issue => issue.severity === "warning").length,
    taskFilter,
    filteredOutByTask,
    boardScopedExcluded,
    boardScopedErrors,
    baselined,
    staleBaseline
  }
}

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
