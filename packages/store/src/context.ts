import * as fs from "node:fs"
import * as path from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { parseTasksFile, readTaskDetailFile, type TaskBoard } from "@mapctx/core"
import { STATUS_TO_PLANNING } from "@mapctx/protocol"
import { getTask, getTaskDetail, listDependencies, listTasks } from "./projections"
import type { DependencyRecord, TaskDetailRecord, TaskRecord } from "./types"

/**
 * v1 deliberately uses a deterministic estimate. It must never be confused
 * with a model tokenizer: callers receive the method and ratio in every
 * response. Four UTF-8 characters per estimated token is a stable planning
 * heuristic, not a billing/input-token count.
 */
export const CONTEXT_TOKENIZER = {
  name: "mapctx-char-heuristic",
  version: "1",
  method: "utf8-character-ceiling",
  charsPerToken: 4,
  documentedRatio: "1 estimated token = 4 UTF-8 characters; estimate only"
} as const

export type ContextProvenance = "store" | "git" | "derived"

export type ContextSectionName = "task" | "detail" | "ancestors" | "dependencies" | "acceptance" | "decisions"

export type ContextTruncation = {
  section: ContextSectionName
  omitted: number
  reason: "budget"
}

export type TaskContext = {
  taskId: string
  budget: number
  tokenCount: number
  /** True when mandatory task identity cannot fit declared budget. */
  budgetExceeded: boolean
  /** Irreducible estimate after all declared truncation steps. Present on overrun. */
  minimumTokenCount?: number
  /** Positive estimate above requested budget. Present on overrun. */
  budgetOverrun?: number
  tokenizer: typeof CONTEXT_TOKENIZER
  task: TaskRecord
  detail: TaskDetailRecord | null
  ancestors: TaskRecord[]
  unsatisfiedDependencies: TaskRecord[]
  acceptanceCriteria: string[]
  decisions: string[]
  provenance: Record<ContextSectionName, ContextProvenance>
  truncationOrder: ContextSectionName[]
  truncated: ContextTruncation[]
}

export type TaskShow = {
  taskId: string
  task: TaskRecord
  detail: TaskDetailRecord | null
  provenance: { task: ContextProvenance; detail: ContextProvenance }
}

export type ContextQueryOptions = {
  budget: number
  tasksRoot?: string
}

function estimateTokens(value: unknown): number {
  const text = JSON.stringify(value)
  return Math.ceil(Buffer.byteLength(text, "utf8") / CONTEXT_TOKENIZER.charsPerToken)
}

function ancestorsFor(task: TaskRecord, byId: Map<string, TaskRecord>): TaskRecord[] {
  const out: TaskRecord[] = []
  const seen = new Set<string>()
  let parent = task.parentTaskId ?? null
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    const value = byId.get(parent)
    if (!value) break
    out.push(value)
    parent = value.parentTaskId ?? null
  }
  return out
}

function dependencyTasks(taskId: string, dependencies: DependencyRecord[], byId: Map<string, TaskRecord>): TaskRecord[] {
  const terminal = new Set(["done", "cancelled"])
  return dependencies
    .filter(edge => edge.fromTaskId === taskId && edge.kind === "depends-on")
    .map(edge => byId.get(edge.toTaskId))
    .filter((value): value is TaskRecord => value !== undefined && !terminal.has(value.planningState))
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
}

function extractSection(content: string, heading: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  const start = lines.findIndex(line => line.trim() === heading)
  if (start < 0) return []
  const out: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*#{1,3}\s+/.test(line)) break
    const trimmed = line.trim()
    if (trimmed.startsWith("- ")) out.push(trimmed.slice(2).trim())
  }
  return out
}

function gitSections(task: TaskRecord, tasksRoot?: string): { acceptance: string[]; decisions: string[] } {
  if (!tasksRoot || !task.detailPath) return { acceptance: [], decisions: [] }
  const detailPath = path.resolve(tasksRoot, task.detailPath)
  if (!fs.existsSync(detailPath)) return { acceptance: [], decisions: [] }
  const content = fs.readFileSync(detailPath, "utf8")
  const decisions = extractSection(content, "## Decisions Taken")
  return {
    acceptance: extractSection(content, "## Acceptance"),
    // Entries are authored oldest-to-newest in task files. Return newest first
    // so budget trimming keeps latest decisions deterministic.
    decisions: decisions.reverse()
  }
}

function trimToBudget<T>(
  value: T[],
  section: ContextSectionName,
  current: () => number,
  budget: number,
  set: (next: T[]) => void,
  truncated: ContextTruncation[]
): void {
  let next = [...value]
  while (next.length > 0 && current() > budget) {
    next = next.slice(0, next.length - 1)
    set(next)
  }
  if (next.length < value.length) truncated.push({ section, omitted: value.length - next.length, reason: "budget" })
}

function buildTaskContext(
  task: TaskRecord,
  detail: TaskDetailRecord | null,
  allTasks: TaskRecord[],
  dependencies: DependencyRecord[],
  options: ContextQueryOptions,
  taskProvenance: ContextProvenance,
  detailProvenance: ContextProvenance
): TaskContext {
  if (!Number.isInteger(options.budget) || options.budget < 1) throw new Error("context budget must be a positive integer")
  const byId = new Map(allTasks.map(value => [value.taskId, value]))
  const ancestors = ancestorsFor(task, byId)
  const unsatisfiedDependencies = dependencyTasks(task.taskId, dependencies, byId)
  const git = gitSections(task, options.tasksRoot)
  const truncated: ContextTruncation[] = []
  const result = {
    task,
    detail,
    ancestors: [...ancestors],
    unsatisfiedDependencies: [...unsatisfiedDependencies],
    acceptanceCriteria: [...git.acceptance],
    decisions: [...git.decisions]
  }
  const count = () => estimateTokens(result)
  trimToBudget(git.decisions, "decisions", count, options.budget, next => { result.decisions = next }, truncated)
  trimToBudget(result.ancestors, "ancestors", count, options.budget, next => { result.ancestors = next }, truncated)
  trimToBudget(detail ? [detail] : [], "detail", count, options.budget, next => { result.detail = next[0] ?? null }, truncated)
  trimToBudget(result.acceptanceCriteria, "acceptance", count, options.budget, next => { result.acceptanceCriteria = next }, truncated)
  trimToBudget(unsatisfiedDependencies, "dependencies", count, options.budget, next => { result.unsatisfiedDependencies = next }, truncated)
  const tokenCount = count()
  const budgetExceeded = tokenCount > options.budget
  return {
    taskId: task.taskId,
    budget: options.budget,
    tokenCount,
    budgetExceeded,
    ...(budgetExceeded ? { minimumTokenCount: tokenCount, budgetOverrun: tokenCount - options.budget } : {}),
    tokenizer: CONTEXT_TOKENIZER,
    task: result.task,
    detail: result.detail,
    ancestors: result.ancestors,
    unsatisfiedDependencies: result.unsatisfiedDependencies,
    acceptanceCriteria: result.acceptanceCriteria,
    decisions: result.decisions,
    provenance: {
      task: taskProvenance,
      detail: detailProvenance,
      ancestors: "derived",
      dependencies: "derived",
      acceptance: "git",
      decisions: "git"
    },
    truncationOrder: ["decisions", "ancestors", "detail", "acceptance", "dependencies"],
    truncated
  }
}

/** Return one task with indexed detail fields, without reading the full board. */
export function queryTask(db: DatabaseSync, taskId: string): TaskShow {
  const task = getTask(db, taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  return {
    taskId,
    task,
    detail: getTaskDetail(db, taskId) ?? null,
    provenance: { task: "store", detail: "store" }
  }
}

/**
 * Build bounded, actionable context. Drop order is explicit and stable:
 * decisions, ancestors, detail, then task/dependencies/acceptance content.
 * Acceptance and unsatisfied dependencies are intentionally last-sacrificed.
 */
export function queryTaskContext(db: DatabaseSync, taskId: string, options: ContextQueryOptions): TaskContext {
  const task = getTask(db, taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  return buildTaskContext(
    task,
    getTaskDetail(db, taskId) ?? null,
    listTasks(db),
    listDependencies(db),
    options,
    "store",
    "store"
  )
}

function markdownTaskRecord(boardTask: TaskBoard["tasks"][number], positionKey: number): TaskRecord {
  return {
    taskId: boardTask.id,
    positionKey,
    title: boardTask.title,
    planningState: STATUS_TO_PLANNING[boardTask.status] ?? boardTask.status,
    executionState: "unclaimed",
    type: boardTask.type ?? null,
    parentTaskId: boardTask.parent ?? null,
    priority: boardTask.priority ?? null,
    workload: boardTask.workload ?? null,
    tags: boardTask.tags ?? [],
    domains: boardTask.domains ?? boardTask.touch ?? [],
    startDate: boardTask.start ?? null,
    dueDate: boardTask.due ?? null,
    completedOn: boardTask.completed ?? null,
    externalId: boardTask.externalId ?? null,
    externalLinks: boardTask.externalLinks ?? [],
    iteration: boardTask.iteration ?? null,
    assignees: boardTask.assignees ?? [],
    milestone: boardTask.milestone ?? null,
    specMode: boardTask.specMode ?? null,
    detailPath: boardTask.detail ?? null,
    updatedOn: boardTask.updated ?? null
  }
}

function markdownDetail(task: TaskRecord, tasksRoot: string): TaskDetailRecord | null {
  if (!task.detailPath || task.detailPath === "null") return null
  const detailPath = path.resolve(tasksRoot, task.detailPath)
  if (!fs.existsSync(detailPath)) return null
  const detail = readTaskDetailFile(detailPath)
  return {
    taskId: task.taskId,
    role: detail.role,
    impact: detail.impact,
    estimatedEffort: detail.estimatedEffort,
    prerequisites: detail.prerequisites,
    blocking: detail.blocking,
    filesAffected: detail.filesAffected,
    testsRequired: detail.testsRequired,
    summary: detail.summary,
    descriptionGitHash: null
  }
}

function markdownContextSource(tasksRoot: string, tasksFilePath: string): {
  tasks: TaskRecord[]
  dependencies: DependencyRecord[]
  details: Map<string, TaskDetailRecord | null>
} {
  const board = parseTasksFile(tasksFilePath)
  const tasks = board.tasks.map((task, index) => markdownTaskRecord(task, index))
  const dependencies = board.tasks.flatMap(task => (task.dependsOn ?? []).map(toTaskId => ({
    fromTaskId: task.id,
    toTaskId,
    kind: "depends-on" as const
  })))
  const details = new Map(tasks.map(task => [task.taskId, markdownDetail(task, tasksRoot)]))
  return { tasks, dependencies, details }
}

/** Read-only pre-cutover equivalent of queryTask. */
export function queryTaskFromMarkdown(tasksRoot: string, taskId: string, tasksFilePath = path.join(tasksRoot, "TASKS.md")): TaskShow {
  const source = markdownContextSource(tasksRoot, tasksFilePath)
  const task = source.tasks.find(value => value.taskId === taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  return {
    taskId,
    task,
    detail: source.details.get(taskId) ?? null,
    provenance: { task: "git", detail: "git" }
  }
}

/** Read-only pre-cutover equivalent of queryTaskContext. */
export function queryTaskContextFromMarkdown(
  tasksRoot: string,
  taskId: string,
  options: ContextQueryOptions,
  tasksFilePath = path.join(tasksRoot, "TASKS.md")
): TaskContext {
  const source = markdownContextSource(tasksRoot, tasksFilePath)
  const task = source.tasks.find(value => value.taskId === taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  return buildTaskContext(
    task,
    source.details.get(taskId) ?? null,
    source.tasks,
    source.dependencies,
    { ...options, tasksRoot },
    "git",
    "git"
  )
}
