import * as fs from "node:fs"
import * as path from "node:path"

export type ThreadRunStatus =
  | "queued"
  | "running"
  | "retrying"
  | "waiting_for_human"
  | "completed"
  | "failed"
  | "canceled"

export type ThreadTokenUsage = {
  input: number | null
  output: number | null
  total: number | null
}

export type ThreadMeta = {
  taskId: string
  schemaVersion: number
  status: string | null
  primaryThread: string
  workingSummary: string
  preferredRuntime: string | null
  lastRuntime: string | null
  lastAgentProfile: string | null
  lastModel: string | null
  lastRunId: string | null
  updatedAt: string
}

export type ThreadRunRecord = {
  runId: string
  taskId: string
  threadPath: string
  summaryPath: string
  runtime: string | null
  agentProfile: string | null
  model: string | null
  status: ThreadRunStatus
  startedAt: string
  endedAt: string | null
  tokenUsage: ThreadTokenUsage
  costUsd: number | null
  result: string | null
}

export type ThreadPaths = {
  taskId: string
  rootPath: string
  threadDirPath: string
  threadPath: string
  summaryPath: string
  metaPath: string
  runsDirPath: string
}

export type ThreadContext = ThreadPaths & {
  exists: boolean
  thread: string | null
  summary: string | null
  meta: ThreadMeta | null
  runs: ThreadRunRecord[]
}

export type ReadThreadContextOptions = {
  includeThread?: boolean
  includeRuns?: boolean
}

export type EnsureThreadContextOptions = {
  status?: string | null
  preferredRuntime?: string | null
  initialSummary?: string | null
  now?: string | Date
}

export type CreateThreadRunOptions = {
  runId?: string
  runtime?: string | null
  agentProfile?: string | null
  model?: string | null
  status?: ThreadRunStatus
  startedAt?: string | Date
  result?: string | null
}

export type UpdateThreadRunPatch = Partial<Omit<ThreadRunRecord, "runId" | "taskId">>

const THREAD_SCHEMA_VERSION = 1

export function getThreadPaths(rootPath: string, taskId: string): ThreadPaths {
  const safeTaskId = normalizeTaskId(taskId)
  const resolvedRoot = path.resolve(rootPath)
  const threadDirPath = path.join(resolvedRoot, ".mapctx", "threads", safeTaskId)
  return {
    taskId: safeTaskId,
    rootPath: resolvedRoot,
    threadDirPath,
    threadPath: path.join(threadDirPath, "thread.md"),
    summaryPath: path.join(threadDirPath, "summary.md"),
    metaPath: path.join(threadDirPath, "meta.json"),
    runsDirPath: path.join(threadDirPath, "runs")
  }
}

export function readThreadContext(
  rootPath: string,
  taskId: string,
  options: ReadThreadContextOptions = {}
): ThreadContext {
  const paths = getThreadPaths(rootPath, taskId)
  const exists = fs.existsSync(paths.threadDirPath)
  return {
    ...paths,
    exists,
    thread: options.includeThread === true ? readTextIfExists(paths.threadPath) : null,
    summary: readTextIfExists(paths.summaryPath),
    meta: readMeta(paths.metaPath),
    runs: options.includeRuns === false ? [] : listTaskRuns(rootPath, paths.taskId)
  }
}

export function ensureThreadContext(
  rootPath: string,
  taskId: string,
  options: EnsureThreadContextOptions = {}
): ThreadContext {
  const paths = getThreadPaths(rootPath, taskId)
  const now = normalizeIso(options.now)

  fs.mkdirSync(paths.threadDirPath, { recursive: true })
  fs.mkdirSync(paths.runsDirPath, { recursive: true })

  if (!fs.existsSync(paths.threadPath)) {
    fs.writeFileSync(paths.threadPath, renderInitialThread(paths.taskId, now), "utf8")
  }

  if (!fs.existsSync(paths.summaryPath)) {
    fs.writeFileSync(paths.summaryPath, renderInitialSummary(paths.taskId, options.initialSummary), "utf8")
  }

  const existingMeta = readMeta(paths.metaPath)
  const meta: ThreadMeta = {
    taskId: paths.taskId,
    schemaVersion: THREAD_SCHEMA_VERSION,
    status: options.status ?? existingMeta?.status ?? null,
    primaryThread: "thread.md",
    workingSummary: "summary.md",
    preferredRuntime: options.preferredRuntime ?? existingMeta?.preferredRuntime ?? null,
    lastRuntime: existingMeta?.lastRuntime ?? null,
    lastAgentProfile: existingMeta?.lastAgentProfile ?? null,
    lastModel: existingMeta?.lastModel ?? null,
    lastRunId: existingMeta?.lastRunId ?? null,
    updatedAt: now
  }
  writeJson(paths.metaPath, meta)

  return readThreadContext(rootPath, paths.taskId, { includeRuns: true })
}

export function appendThreadMessage(
  rootPath: string,
  taskId: string,
  role: string,
  message: string,
  now: string | Date = new Date()
): void {
  const paths = getThreadPaths(rootPath, taskId)
  ensureThreadContext(rootPath, paths.taskId, { now })
  const timestamp = normalizeIso(now)
  const entry = [
    "",
    `### ${timestamp} - ${String(role || "note").trim() || "note"}`,
    "",
    String(message || "").trim(),
    ""
  ].join("\n")
  fs.appendFileSync(paths.threadPath, entry, "utf8")
}

export function updateThreadSummary(rootPath: string, taskId: string, summary: string): void {
  const paths = getThreadPaths(rootPath, taskId)
  ensureThreadContext(rootPath, paths.taskId)
  fs.writeFileSync(paths.summaryPath, normalizeTrailingNewline(summary), "utf8")
  touchMeta(paths.metaPath)
}

export function listTaskRuns(rootPath: string, taskId: string): ThreadRunRecord[] {
  const paths = getThreadPaths(rootPath, taskId)
  if (!fs.existsSync(paths.runsDirPath)) return []

  return fs
    .readdirSync(paths.runsDirPath)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => readRunRecord(path.join(paths.runsDirPath, fileName)))
    .filter((run): run is ThreadRunRecord => Boolean(run))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

export function createThreadRun(
  rootPath: string,
  taskId: string,
  options: CreateThreadRunOptions = {}
): ThreadRunRecord {
  const paths = getThreadPaths(rootPath, taskId)
  const startedAt = normalizeIso(options.startedAt)
  const runId = options.runId ? sanitizeRunId(options.runId) : makeRunId(startedAt)

  ensureThreadContext(rootPath, paths.taskId, { now: startedAt })

  const run: ThreadRunRecord = {
    runId,
    taskId: paths.taskId,
    threadPath: "../thread.md",
    summaryPath: "../summary.md",
    runtime: options.runtime ?? null,
    agentProfile: options.agentProfile ?? null,
    model: options.model ?? null,
    status: options.status ?? "queued",
    startedAt,
    endedAt: null,
    tokenUsage: {
      input: null,
      output: null,
      total: null
    },
    costUsd: null,
    result: options.result ?? null
  }

  writeRun(paths, run)
  updateMetaForRun(paths.metaPath, run)
  return run
}

export function updateThreadRun(
  rootPath: string,
  taskId: string,
  runId: string,
  patch: UpdateThreadRunPatch
): ThreadRunRecord {
  const paths = getThreadPaths(rootPath, taskId)
  const safeRunId = sanitizeRunId(runId)
  const runPath = path.join(paths.runsDirPath, `${safeRunId}.json`)
  const existing = readRunRecord(runPath)
  if (!existing) {
    throw new Error(`Thread run not found: ${paths.taskId}/${safeRunId}`)
  }

  const next: ThreadRunRecord = {
    ...existing,
    ...patch,
    tokenUsage: {
      ...existing.tokenUsage,
      ...(patch.tokenUsage ?? {})
    }
  }
  writeRun(paths, next)
  updateMetaForRun(paths.metaPath, next)
  return next
}

function normalizeTaskId(taskId: string): string {
  const value = String(taskId || "").trim()
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid task id for thread substrate: ${taskId}`)
  }
  return value
}

function sanitizeRunId(runId: string): string {
  const value = String(runId || "").trim()
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`Invalid run id for thread substrate: ${runId}`)
  }
  return value.replaceAll(":", "-")
}

function normalizeIso(value?: string | Date): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string" && value.trim()) return new Date(value).toISOString()
  return new Date().toISOString()
}

function makeRunId(startedAt: string): string {
  return `run-${startedAt.replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z")}`
}

function readTextIfExists(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null
  return fs.readFileSync(filePath, "utf8")
}

function readMeta(filePath: string): ThreadMeta | null {
  const raw = readTextIfExists(filePath)
  if (!raw) return null
  try {
    return normalizeMeta(JSON.parse(raw))
  } catch {
    return null
  }
}

function normalizeMeta(value: unknown): ThreadMeta | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const taskId = typeof raw.taskId === "string" ? raw.taskId : null
  if (!taskId) return null
  return {
    taskId,
    schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : THREAD_SCHEMA_VERSION,
    status: asNullableString(raw.status),
    primaryThread: typeof raw.primaryThread === "string" ? raw.primaryThread : "thread.md",
    workingSummary: typeof raw.workingSummary === "string" ? raw.workingSummary : "summary.md",
    preferredRuntime: asNullableString(raw.preferredRuntime),
    lastRuntime: asNullableString(raw.lastRuntime),
    lastAgentProfile: asNullableString(raw.lastAgentProfile),
    lastModel: asNullableString(raw.lastModel),
    lastRunId: asNullableString(raw.lastRunId),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString()
  }
}

function readRunRecord(filePath: string): ThreadRunRecord | null {
  const raw = readTextIfExists(filePath)
  if (!raw) return null
  try {
    return normalizeRunRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

function normalizeRunRecord(value: unknown): ThreadRunRecord | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const runId = typeof raw.runId === "string" ? raw.runId : null
  const taskId = typeof raw.taskId === "string" ? raw.taskId : null
  if (!runId || !taskId) return null
  const tokenUsage = raw.tokenUsage && typeof raw.tokenUsage === "object" ? raw.tokenUsage as Record<string, unknown> : {}
  return {
    runId,
    taskId,
    threadPath: typeof raw.threadPath === "string" ? raw.threadPath : "../thread.md",
    summaryPath: typeof raw.summaryPath === "string" ? raw.summaryPath : "../summary.md",
    runtime: asNullableString(raw.runtime),
    agentProfile: asNullableString(raw.agentProfile),
    model: asNullableString(raw.model),
    status: normalizeRunStatus(raw.status),
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : new Date().toISOString(),
    endedAt: asNullableString(raw.endedAt),
    tokenUsage: {
      input: asNullableNumber(tokenUsage.input),
      output: asNullableNumber(tokenUsage.output),
      total: asNullableNumber(tokenUsage.total)
    },
    costUsd: asNullableNumber(raw.costUsd),
    result: asNullableString(raw.result)
  }
}

function normalizeRunStatus(value: unknown): ThreadRunStatus {
  const status = typeof value === "string" ? value : ""
  if (
    status === "queued" ||
    status === "running" ||
    status === "retrying" ||
    status === "waiting_for_human" ||
    status === "completed" ||
    status === "failed" ||
    status === "canceled"
  ) {
    return status
  }
  return "queued"
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function writeRun(paths: ThreadPaths, run: ThreadRunRecord): void {
  fs.mkdirSync(paths.runsDirPath, { recursive: true })
  writeJson(path.join(paths.runsDirPath, `${sanitizeRunId(run.runId)}.json`), run)
}

function updateMetaForRun(metaPath: string, run: ThreadRunRecord): void {
  const existing = readMeta(metaPath)
  const meta: ThreadMeta = {
    taskId: run.taskId,
    schemaVersion: THREAD_SCHEMA_VERSION,
    status: existing?.status ?? null,
    primaryThread: existing?.primaryThread ?? "thread.md",
    workingSummary: existing?.workingSummary ?? "summary.md",
    preferredRuntime: existing?.preferredRuntime ?? null,
    lastRuntime: run.runtime,
    lastAgentProfile: run.agentProfile,
    lastModel: run.model,
    lastRunId: run.runId,
    updatedAt: new Date().toISOString()
  }
  writeJson(metaPath, meta)
}

function touchMeta(metaPath: string): void {
  const meta = readMeta(metaPath)
  if (!meta) return
  writeJson(metaPath, { ...meta, updatedAt: new Date().toISOString() })
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function renderInitialThread(taskId: string, now: string): string {
  return [
    `# Thread ${taskId}`,
    "",
    "## Messages",
    "",
    `### ${now} - system`,
    "",
    `Created portable MapCtx thread substrate for ${taskId}.`,
    ""
  ].join("\n")
}

function renderInitialSummary(taskId: string, initialSummary?: string | null): string {
  if (initialSummary && initialSummary.trim()) return normalizeTrailingNewline(initialSummary)
  return [
    `# Working Summary - ${taskId}`,
    "",
    "## Current Goal",
    "",
    "Pending.",
    "",
    "## Current State",
    "",
    "Thread substrate created. No run has started yet.",
    "",
    "## Decisions",
    "",
    "- None recorded.",
    "",
    "## Review Feedback",
    "",
    "- None recorded.",
    "",
    "## Next Action",
    "",
    "Clarify the next execution step.",
    "",
    "## Important Files",
    "",
    "- None recorded.",
    ""
  ].join("\n")
}

function normalizeTrailingNewline(value: string): string {
  return String(value || "").trimEnd() + "\n"
}
