import { createHash } from "node:crypto"
import {
  timeEvidenceSchema,
  type HistorySource,
  type HistoryTier,
  type RunReceipt,
  type TimeEvidence
} from "@mapctx/protocol"
import { DEFAULT_INTERVAL_POLICY, extractClaudeIntervals } from "./claude-intervals"

/**
 * T-101 history scan: link local harness sessions (Codex JSONL, OpenCode
 * SQLite rows, Claude Code JSONL leftovers) plus git commits to MapCtx tasks
 * by signal strength, then backfill measured/inferred history as retroactive
 * receipts.
 *
 * Privacy: every adapter keeps only ids, timestamps, owners, hashes and
 * session ids. Signal scanning reads text in memory but the scan report,
 * receipts and evidence carry matched task ids and signal kinds only -- never
 * prompt, answer, command-output or file content.
 */

export type HistoryHarness = "codex" | "opencode" | "claude-code"
export type SignalKind = "toolcall" | "file-edit" | "branch" | "first-prompt" | "weak"

/**
 * T-116 review attempt 2: per-command provenance. A session's recorded cwd
 * does not bind its tools -- a command can carry an explicit workdir/cwd
 * argument or `cd` into another repository. Every signal text therefore
 * carries the effective workdir it ran under (null = session cwd) and, once
 * the caller resolves identities, the scope that workdir belongs to.
 * `workdir: "."` marks an override that cannot be resolved safely (relative
 * path, shell variable): conservative exclusion.
 */
export type CommandScope = "in-scope" | "out-of-scope" | "unverifiable"

export type SignalEntry = {
  text: string
  /** Effective working directory override for this command, if any. */
  workdir?: string | null
  /** Resolved by the caller that owns filesystem/git access. */
  scope?: CommandScope
}

function entry(text: string, workdir?: string | null): SignalEntry {
  return workdir === undefined ? { text } : { text, workdir }
}

/** Signal strength order: tool calls > file edits > branch/first-prompt > weak. */
export const SIGNAL_WEIGHT: Record<SignalKind, number> = {
  toolcall: 4,
  "file-edit": 3,
  branch: 2,
  "first-prompt": 2,
  weak: 1
}

/** Minimum weight that links a session to a task. Bare mentions never link. */
export const LINK_THRESHOLD = SIGNAL_WEIGHT["file-edit"]

/** Tools whose inputs prove file writes (patch/edit/write family, separator-normalized). */
const WRITE_TOOLS = new Set(["applypatch", "edit", "write", "patch", "notebookedit"])

/** Shell text markers indicating the command writes files. */
const WRITE_CMD_MARKERS = /apply_patch|>+\s*\S|sed\s+-i|\btee\b/

function isWriteCommand(cmd: string): boolean {
  return WRITE_CMD_MARKERS.test(cmd)
}

export type RawSession = {
  harness: HistoryHarness
  sessionId: string
  /** ms epoch event timestamps (unsorted ok). */
  eventTimestamps: number[]
  /** Owner of the session host user, when known (os user / session meta). */
  owner?: string
  /**
   * T-116: recorded working directory of the session (Codex session_meta,
   * OpenCode session.directory, Claude row cwd). Metadata only.
   */
  cwd?: string
  /**
   * T-116: resolved repository identity. repoRoot is the session's git
   * toplevel (worktree-specific); repoOrigin the git common dir shared by
   * all worktrees of one repository. Resolved by the caller that owns
   * filesystem/git access; null when the cwd is outside any repository.
   */
  repoRoot?: string | null
  repoOrigin?: string | null
  /** True when a cwd was recorded and resolved; false = unverifiable. */
  cwdVerified?: boolean
  /** Working directory / branch / title context for branch-grade signals. */
  contextText?: string
  /** First user prompt text (first-prompt-grade signal source). */
  firstPromptText?: string
  /** All signal-bearing text: prompts, tool inputs, edited paths. Memory-only. */
  signalTexts: SignalEntry[]
  /**
   * Write-context text only: patch inputs and shell commands with write
   * markers. File-edit signals are graded from these alone -- a task file
   * quoted in prose, board dumps or tool outputs is a mention, not an edit.
   */
  writeTexts: SignalEntry[]
  /** sha256 of the raw session source (file bytes or row ids). */
  sourceHash: string
}

export type TaskMeta = {
  taskId: string
  filesAffected: string[]
  startDate?: string | null
  dueDate?: string | null
  planningState?: string
}

export type SessionLink = {
  sessionId: string
  harness: HistoryHarness
  taskId: string
  signals: SignalKind[]
  weight: number
  spanStart: string
  spanEnd: string
  /** sha256 of the raw session source; evidence carries the hash, never bytes. */
  sourceHash: string
  /** True when this task is not the session's primary attribution. */
  secondary: boolean
  ambiguous: boolean
}

export type TaskHistory = {
  taskId: string
  tier: HistoryTier
  confidence: "high" | "medium" | "low" | "none"
  links: SessionLink[]
  /** Active ms attributed to this task (primary sessions only). */
  attributedActiveMs: number
  intervals: TimeEvidence["intervals"]
  sessionSpans: NonNullable<TimeEvidence["sessionSpans"]>
  evidenceSource: TimeEvidence["source"] | null
  commitHashes: string[]
  ambiguous: boolean
}

export type HistoryScanReport = {
  schemaVersion: 1
  generatedAt: string
  tasks: TaskHistory[]
  /** Sessions whose top signals tie across tasks (or multi toolcall tasks). */
  ambiguousSessions: Array<{ sessionId: string; harness: HistoryHarness; taskIds: string[] }>
  /** Bare-mention-only hits: observed but never linked. */
  weakMentions: Array<{ sessionId: string; harness: HistoryHarness; taskIds: string[] }>
  sources: Record<string, { status: "ok" | "missing" | "locked" | "error"; sessions: number; detail?: string }>
  /**
   * T-116 project/worktree scoping. Sessions are only linkable to tasks of
   * the scanned repository identity; out-of-scope and unverifiable sessions
   * stay listed (content-free) but are never linked or measured. Task-ID
   * text collisions across projects cannot cross this boundary.
   */
  scope: {
    repoRoot: string | null
    repoOrigin: string | null
    includedSessions: number
    outOfScopeSessions: number
    unverifiableSessions: number
    outOfScope: Array<{ sessionId: string; harness: HistoryHarness; repoRoot: string | null }>
    unverifiable: Array<{ sessionId: string; harness: HistoryHarness }>
    /**
     * Review attempt 2, finding 1: per-command provenance. Counts of
     * explicit workdir/cd overrides that resolved outside the scanned
     * repository or could not be resolved, plus the sessions whose measured
     * time was degraded to inferred because such a command ran inside their
     * wall clock.
     */
    commandOverrides: {
      foreign: number
      unverifiable: number
      degradedMeasuredSessions: string[]
    }
  }
  summary: {
    measured: number
    inferred: number
    declared: number
    noHistory: number
    linkedTasks: number
    /** Tier reach over done tasks only (the backfill population). */
    done: { total: number; measured: number; inferred: number; declared: number; noHistory: number }
  }
}

const TASK_ID_PATTERN = /\bT-(\d{1,4})\b/g
const MAPCTX_TOOLCALL_PATTERN = /mapctx\s+(?:task\s+(?:claim|dispatch|move)|dispatch\s+(?:create|receipt))\s+(T-\d{1,4})/g
const TASK_FILE_PATTERN = /tasks\/(T-\d{1,4})\.md/g

function taskIdsIn(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(TASK_ID_PATTERN)) found.add(`T-${match[1]}`)
  return [...found]
}

/**
 * Specificity floor for filesAffected linkage. Only multi-segment paths of
 * substance ("packages/opencode-plugin/") link sessions; bare names and short
 * directory prefixes match nearly every session and must not link.
 */
export function isSpecificPath(entry: string): boolean {
  const stripped = entry.replace(/\/+$/, "")
  return stripped.includes("/") && stripped.length >= 12
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

/** `cd <target>` at a command boundary; quoted or bare paths. */
const CD_PATTERN = /(?:^|[;&|]\s*|&&\s*|then\s+|["']\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/

/**
 * Effective-workdir extraction for one tool input (review attempt 2,
 * finding 1). Returns undefined when the input carries no cwd override,
 * an absolute path when it does, or "." when an override exists but cannot
 * be resolved safely (relative target, shell variable) -- callers must
 * treat "." as unverifiable and exclude conservatively.
 */
export function extractCommandWorkdir(inputText: string): string | null | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(inputText)
  } catch {
    parsed = undefined
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    for (const key of ["workdir", "cwd"]) {
      const value = record[key]
      if (typeof value === "string" && value.trim()) {
        return value.startsWith("/") ? value : "."
      }
    }
    for (const key of ["cmd", "command"]) {
      const value = record[key]
      if (typeof value === "string") return extractShellCd(value) ?? undefined
      if (Array.isArray(value) && value.every(part => typeof part === "string")) {
        return extractShellCd(value.join(" ")) ?? undefined
      }
    }
    return undefined
  }
  // Raw shell text or JS source (Codex `exec` wraps tools.exec_command({cmd,
  // workdir}) calls): collect every workdir/cwd object-literal key plus any
  // leading cd. Never scan inside structured JSON -- a literal "cd" in a
  // payload string must not invent provenance.
  const found = new Set<string>()
  for (const match of inputText.matchAll(WORKDIR_KEY_PATTERN)) {
    const value = (match[1] ?? match[2] ?? "").trim()
    found.add(value.startsWith("/") ? value : ".")
  }
  const cd = extractShellCd(inputText)
  if (cd) found.add(cd)
  if (found.size === 0) return undefined
  // Disagreeing overrides inside one entry cannot be attributed safely.
  return found.size === 1 ? [...found][0] : "."
}

/** `workdir: "/abs"` / `"cwd":'/abs'` object-literal keys inside JS source. */
const WORKDIR_KEY_PATTERN = /["']?\b(?:workdir|cwd)["']?\s*:\s*(?:"([^"\n]+)"|'([^'\n]+)')/g

function extractShellCd(text: string): string | null | undefined {
  const match = text.match(CD_PATTERN)
  if (!match) return undefined
  const target = (match[1] ?? match[2] ?? match[3] ?? "").trim()
  if (!target || !target.startsWith("/")) return "."
  return target
}

/**
 * Grade signals for one session against known tasks. Returns per-task signal
 * sets. Weak (bare mention) is recorded but never reaches LINK_THRESHOLD.
 * Entries whose command provenance resolved out-of-scope or unverifiable are
 * skipped entirely (review attempt 2, finding 1): a foreign command never
 * grades a link, not even a weak mention.
 */
export function gradeSessionSignals(
  session: RawSession,
  tasksById: Map<string, TaskMeta>
): Map<string, Set<SignalKind>> {
  const graded = new Map<string, Set<SignalKind>>()
  const touch = (taskId: string, kind: SignalKind) => {
    if (!tasksById.has(taskId)) return
    const set = graded.get(taskId) ?? new Set<SignalKind>()
    set.add(kind)
    graded.set(taskId, set)
  }
  const inScope = (item: SignalEntry): boolean =>
    item.scope !== "out-of-scope" && item.scope !== "unverifiable"
  const contextIds = taskIdsIn(session.contextText ?? "")
  for (const id of contextIds) touch(id, "branch")
  if (session.firstPromptText) {
    for (const id of taskIdsIn(session.firstPromptText)) touch(id, "first-prompt")
  }
  for (const signal of session.signalTexts) {
    if (!inScope(signal)) continue
    const text = signal.text
    for (const match of text.matchAll(MAPCTX_TOOLCALL_PATTERN)) touch(match[1], "toolcall")
    // Bare mentions are weak hints only -- recorded, never link-grade.
    for (const id of taskIdsIn(text)) touch(id, "weak")
  }
  // File edits grade from write-context text only.
  for (const signal of session.writeTexts) {
    if (!inScope(signal)) continue
    const text = signal.text
    for (const match of text.matchAll(TASK_FILE_PATTERN)) touch(match[1], "file-edit")
    // filesAffected linkage: a patch/command naming a task's tracked file.
    // Precision gate: single-segment or short entries ("docs/", "tasks",
    // "TASKS.md", "packages/") appear in nearly every session and caused
    // thousands of false file-edit links. Only multi-segment paths of
    // substance link; generic entries stay silent rather than noisy.
    for (const [taskId, meta] of tasksById) {
      if (meta.filesAffected.length === 0) continue
      if (meta.filesAffected.some(file => isSpecificPath(file) && text.includes(file))) {
        touch(taskId, "file-edit")
      }
    }
  }
  return graded
}

function sessionWeight(kinds: Set<SignalKind>): number {
  let weight = 0
  for (const kind of kinds) weight = Math.max(weight, SIGNAL_WEIGHT[kind])
  return weight
}

export type LinkedSession = {
  session: RawSession
  grades: Map<string, Set<SignalKind>>
}

/** Link graded sessions to tasks. Primary = strongest signal; ties = ambiguous. */
export function linkSessions(linked: LinkedSession[]): {
  links: SessionLink[]
  ambiguousSessions: HistoryScanReport["ambiguousSessions"]
  weakMentions: HistoryScanReport["weakMentions"]
} {
  const links: SessionLink[] = []
  const ambiguousSessions: HistoryScanReport["ambiguousSessions"] = []
  const weakMentions: HistoryScanReport["weakMentions"] = []
  for (const { session, grades } of linked) {
    const stamps = session.eventTimestamps.filter(Number.isFinite).sort((a, b) => a - b)
    if (stamps.length === 0) continue
    const spanStart = new Date(stamps[0]).toISOString()
    const spanEnd = new Date(stamps[stamps.length - 1]).toISOString()
    const ranked = [...grades.entries()]
      .map(([taskId, kinds]) => ({ taskId, kinds: [...kinds], weight: sessionWeight(kinds) }))
      .sort((a, b) => b.weight - a.weight || a.taskId.localeCompare(b.taskId))
    const linkable = ranked.filter(entry => entry.weight >= LINK_THRESHOLD)
    const weakOnly = ranked.filter(entry => entry.weight < LINK_THRESHOLD)
    if (weakOnly.length > 0) {
      weakMentions.push({ sessionId: session.sessionId, harness: session.harness, taskIds: weakOnly.map(entry => entry.taskId) })
    }
    if (linkable.length === 0) continue
    const top = linkable[0].weight
    const tied = linkable.filter(entry => entry.weight === top)
    const multiToolcall = linkable.filter(entry => entry.kinds.includes("toolcall")).length > 1
    const ambiguous = tied.length > 1 || multiToolcall
    if (ambiguous) {
      ambiguousSessions.push({
        sessionId: session.sessionId,
        harness: session.harness,
        taskIds: linkable.map(entry => entry.taskId)
      })
    }
    linkable.forEach((entry, index) => {
      links.push({
        sessionId: session.sessionId,
        harness: session.harness,
        taskId: entry.taskId,
        signals: entry.kinds as SignalKind[],
        weight: entry.weight,
        spanStart,
        spanEnd,
        sourceHash: session.sourceHash,
        secondary: index > 0,
        ambiguous
      })
    })
  }
  return { links, ambiguousSessions, weakMentions }
}

const EVIDENCE_SOURCE: Record<HistoryHarness, TimeEvidence["source"]> = {
  codex: "codex-jsonl",
  opencode: "opencode-db",
  "claude-code": "claude-jsonl"
}

/**
 * Timestamp-only evidence for Codex/OpenCode sessions. Mirrors the active-gap
 * rule in duration.ts (gaps below the idle threshold count as agent-active)
 * and validates through the same T-100 TimeEvidence schema -- reversed or
 * zero-length spans are rejected, never fabricated.
 */
export function buildEvidenceFromTimestamps(
  harness: Exclude<HistoryHarness, "claude-code">,
  sessionId: string,
  eventTimestamps: number[]
): { intervals: TimeEvidence["intervals"]; sessionSpans: NonNullable<TimeEvidence["sessionSpans"]> } {
  const stamps = [...new Set(eventTimestamps.filter(Number.isFinite))].sort((a, b) => a - b)
  if (stamps.length < 2 || stamps[stamps.length - 1] <= stamps[0]) {
    throw new Error(`history scan: session ${sessionId} has no positive span`)
  }
  const intervals: TimeEvidence["intervals"] = []
  let runStart: number | null = null
  for (let i = 1; i < stamps.length; i += 1) {
    const gap = stamps[i] - stamps[i - 1]
    if (gap < 0) throw new Error(`history scan: session ${sessionId} timestamps run backwards`)
    if (gap < DEFAULT_INTERVAL_POLICY.idleThresholdMs) {
      runStart ??= stamps[i - 1]
    } else if (runStart !== null) {
      intervals.push({
        start: new Date(runStart).toISOString(),
        end: new Date(stamps[i - 1]).toISOString(),
        owner: "agent",
        kind: "active",
        sessionId
      })
      runStart = null
    }
  }
  if (runStart !== null) {
    intervals.push({
      start: new Date(runStart).toISOString(),
      end: new Date(stamps[stamps.length - 1]).toISOString(),
      owner: "agent",
      kind: "active",
      sessionId
    })
  }
  const sessionSpans = [{
    start: new Date(stamps[0]).toISOString(),
    end: new Date(stamps[stamps.length - 1]).toISOString(),
    sessionId
  }]
  // Same validator the Claude path uses: invalid spans throw here.
  const parsed = timeEvidenceSchema.safeParse({
    schemaVersion: 1,
    source: EVIDENCE_SOURCE[harness],
    policy: DEFAULT_INTERVAL_POLICY,
    intervals,
    sessionSpans
  })
  if (!parsed.success) throw new Error(`history scan: invalid ${harness} evidence for ${sessionId}: ${parsed.error.message}`)
  return { intervals: parsed.data.intervals, sessionSpans: parsed.data.sessionSpans! }
}

/** Active ms inside evidence intervals (union; sessions here never overlap). */
export function activeMsOf(intervals: TimeEvidence["intervals"]): number {
  return intervals
    .filter(interval => interval.owner === "agent")
    .reduce((sum, interval) => sum + (Date.parse(interval.end) - Date.parse(interval.start)), 0)
}

/** Parse one Codex session file (JSONL). Throws on invalid JSONL lines. */
export function parseCodexSession(jsonl: string, sourcePath = "<memory>"): RawSession {
  let sessionId = ""
  let cwd = ""
  let branch = ""
  const stamps: number[] = []
  const signalTexts: SignalEntry[] = []
  const writeTexts: SignalEntry[] = []
  let firstPromptText = ""
  for (const [lineNumber, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      throw new Error(`history scan: invalid Codex JSONL line ${lineNumber + 1} in ${sourcePath}`)
    }
    const at = Date.parse((row.timestamp as string) ?? "")
    if (Number.isFinite(at)) stamps.push(at)
    const payload = row.payload as Record<string, unknown> | undefined
    if (row.type === "session_meta" && payload && typeof payload === "object") {
      sessionId = (payload.session_id as string) ?? sessionId
      cwd = (payload.cwd as string) ?? cwd
      const git = payload.git as Record<string, unknown> | undefined
      branch = (git?.branch as string) ?? branch
      continue
    }
    if (row.type !== "response_item" || !payload || typeof payload !== "object") continue
    if (payload.type === "message" && payload.role === "user") {
      const content = payload.content as Array<{ text?: unknown }> | undefined
      const text = Array.isArray(content)
        ? content.map(block => typeof block?.text === "string" ? block.text : "").join("\n")
        : ""
      if (text.trim()) {
        signalTexts.push(entry(text))
        firstPromptText ||= text
      }
    } else if (payload.type === "function_call") {
      const args = typeof payload.arguments === "string" ? payload.arguments : JSON.stringify(payload.arguments ?? {})
      const text = `${String(payload.name ?? "tool")}: ${args}`
      signalTexts.push(entry(text, extractCommandWorkdir(args)))
      if (typeof payload.name === "string" && WRITE_TOOLS.has(payload.name.toLowerCase().replace(/[-_]/g, "")) || isWriteCommand(args)) {
        writeTexts.push(entry(text, extractCommandWorkdir(args)))
      }
    } else if (payload.type === "custom_tool_call") {
      const input = typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input ?? {})
      const name = String(payload.name ?? "tool")
      const text = `${name}: ${input.slice(0, 4000)}`
      signalTexts.push(entry(text, extractCommandWorkdir(input)))
      if (WRITE_TOOLS.has(name.toLowerCase().replace(/[-_]/g, "")) || isWriteCommand(input)) {
        writeTexts.push(entry(text, extractCommandWorkdir(input)))
      }
    }
  }
  if (!sessionId) sessionId = sha256Hex(sourcePath).slice(0, 32)
  return {
    harness: "codex",
    sessionId,
    eventTimestamps: stamps,
    cwd: cwd || undefined,
    contextText: [cwd, branch].filter(Boolean).join(" "),
    firstPromptText: firstPromptText || undefined,
    signalTexts,
    writeTexts,
    sourceHash: sha256Hex(jsonl)
  }
}

export type OpenCodeRows = {
  session: { id: string; directory?: string | null; title?: string | null }
  messages: Array<{ timeCreated: number; timeCompleted?: number | null; role: string; text?: string }>
  parts: Array<{ timeCreated: number; timeUpdated?: number | null; tool?: string | null; inputText?: string; files?: string[] }>
}

/** Build a RawSession from read-only OpenCode DB rows. */
export function parseOpencodeSession(rows: OpenCodeRows, sourceHash: string): RawSession {
  const stamps: number[] = []
  const signalTexts: SignalEntry[] = []
  const writeTexts: SignalEntry[] = []
  let firstPromptText = ""
  for (const message of rows.messages) {
    if (Number.isFinite(message.timeCreated)) stamps.push(message.timeCreated)
    if (Number.isFinite(message.timeCompleted)) stamps.push(message.timeCompleted!)
    if (message.role === "user" && message.text?.trim()) {
      signalTexts.push(entry(message.text))
      firstPromptText ||= message.text
    }
  }
  for (const part of rows.parts) {
    if (Number.isFinite(part.timeCreated)) stamps.push(part.timeCreated)
    if (Number.isFinite(part.timeUpdated)) stamps.push(part.timeUpdated!)
    const toolName = (part.tool ?? "tool").toLowerCase().replace(/[-_]/g, "")
    const text = `${part.tool ?? "tool"}: ${part.inputText ?? ""}`
    const workdir = part.inputText !== undefined ? extractCommandWorkdir(part.inputText) : undefined
    if (part.tool || part.inputText) signalTexts.push(entry(text, workdir))
    for (const file of part.files ?? []) signalTexts.push(entry(file))
    // Edit/write/patch tool inputs and file/patch parts prove writes; shell
    // commands only when they carry write markers. Reads stay mentions.
    if (WRITE_TOOLS.has(toolName) || ((part.files ?? []).length > 0 && toolName !== "read") ||
        (toolName === "bash" && part.inputText !== undefined && isWriteCommand(part.inputText))) {
      if (part.tool || part.inputText) writeTexts.push(entry(text, workdir))
      for (const file of part.files ?? []) writeTexts.push(entry(file))
    }
  }
  return {
    harness: "opencode",
    sessionId: rows.session.id,
    eventTimestamps: stamps,
    cwd: rows.session.directory || undefined,
    contextText: [rows.session.directory, rows.session.title].filter(Boolean).join(" "),
    firstPromptText: firstPromptText || undefined,
    signalTexts,
    writeTexts,
    sourceHash
  }
}

/**
 * Claude Code signal scan. Interval extraction stays in
 * extractClaudeIntervals (T-100, never reimplemented here); this pass only
 * grades task signals from prompt/tool text, hashed the same privacy-safe way.
 */
export function parseClaudeSession(jsonl: string, sourcePath = "<memory>"): RawSession {
  const stamps: number[] = []
  const signalTexts: SignalEntry[] = []
  const writeTexts: SignalEntry[] = []
  let firstPromptText = ""
  let sessionId = ""
  let cwd = ""
  for (const [lineNumber, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      throw new Error(`history scan: invalid Claude JSONL line ${lineNumber + 1} in ${sourcePath}`)
    }
    sessionId = (row.sessionId as string) || sessionId
    if (typeof row.cwd === "string" && row.cwd.trim()) cwd = row.cwd
    const at = Date.parse((row.timestamp as string) ?? "")
    if (Number.isFinite(at)) stamps.push(at)
    const message = row.message as { content?: unknown } | undefined
    const content = message?.content
    const texts: string[] = []
    if (typeof content === "string") texts.push(content)
    else if (Array.isArray(content)) {
      for (const block of content) {
        const typed = block as { type?: unknown; text?: unknown; input?: unknown; name?: unknown } | null
        if (typed && typeof typed.text === "string") texts.push(typed.text)
        if (typed?.input !== undefined && typed.type === "tool_use") {
          const inputText = JSON.stringify(typed.input)
          const workdir = extractCommandWorkdir(inputText)
          const toolEntry = entry(inputText.slice(0, 4000), workdir)
          signalTexts.push(toolEntry)
          if (typeof typed.name === "string" &&
              WRITE_TOOLS.has(typed.name.toLowerCase().replace(/[-_]/g, ""))) {
            writeTexts.push(toolEntry)
          }
        }
      }
    }
    const joined = texts.join("\n")
    if (joined.trim()) {
      signalTexts.push(entry(joined))
      if (row.type === "user") firstPromptText ||= joined
    }
  }
  if (!sessionId) sessionId = sha256Hex(sourcePath).slice(0, 32)
  return {
    harness: "claude-code",
    sessionId,
    eventTimestamps: stamps,
    cwd: cwd || undefined,
    firstPromptText: firstPromptText || undefined,
    signalTexts,
    writeTexts,
    sourceHash: sha256Hex(jsonl)
  }
}

export type GitCommit = { hash: string; date: string; subject: string }

export function commitsForTasks(
  commits: GitCommit[],
  tasksById: Map<string, TaskMeta>
): { perTask: Map<string, GitCommit[]>; ambiguous: GitCommit[] } {
  const perTask = new Map<string, GitCommit[]>()
  const ambiguous: GitCommit[] = []
  for (const commit of commits) {
    const ids = taskIdsIn(commit.subject).filter(id => tasksById.has(id))
    if (ids.length === 0) continue
    if (ids.length > 1) {
      ambiguous.push(commit)
      continue
    }
    const list = perTask.get(ids[0]) ?? []
    list.push(commit)
    perTask.set(ids[0], list)
  }
  return { perTask, ambiguous }
}

export type ScanScope = {
  /** Realpath'd git toplevel of the scanned repository. */
  repoRoot: string | null
  /** Realpath'd git common dir (null when the repo is not a worktree-aware repo). */
  repoOrigin: string | null
}

/** Session is linkable only when its identity matches the scanned repo. */
export function sessionInScope(session: RawSession, scope: ScanScope): boolean {
  if (!session.cwdVerified) return false
  if (scope.repoRoot && session.repoRoot && session.repoRoot === scope.repoRoot) return true
  if (scope.repoOrigin && session.repoOrigin && session.repoOrigin === scope.repoOrigin) return true
  return false
}

/**
 * A session whose wall clock contains a command that verifiably (or
 * provably-unverifiably) ran outside the scanned repository cannot have its
 * span trusted as measured active time for this repository.
 */
export function sessionProvenanceDirty(session: RawSession): boolean {
  return [...session.signalTexts, ...session.writeTexts].some(item =>
    item.scope === "out-of-scope" || item.scope === "unverifiable")
}

/**
 * Assemble the per-task report. Primary session links contribute measured
 * intervals (via the harness extractor); secondary links stay inferred so one
 * session's minutes never calibrate two tasks. Tasks with only git links are
 * inferred; with only start/due dates, declared; otherwise no-history.
 *
 * With a `scope`, sessions are first partitioned by repository identity:
 * only sessions inside the scanned repository (root or any worktree sharing
 * its origin) reach the linker. Sessions with an unverifiable cwd and
 * sessions from other repositories are counted and listed, never linked or
 * measured -- a matching task ID alone is never sufficient attribution.
 */
export function buildReport(args: {
  sessions: RawSession[]
  tasks: TaskMeta[]
  commits?: GitCommit[]
  claudeJsonlBySession?: Map<string, string>
  generatedAt?: string
  sources?: HistoryScanReport["sources"]
  scope?: ScanScope
}): HistoryScanReport {
  const tasksById = new Map(args.tasks.map(task => [task.taskId, task]))
  const scope: HistoryScanReport["scope"] = {
    repoRoot: args.scope?.repoRoot ?? null,
    repoOrigin: args.scope?.repoOrigin ?? null,
    includedSessions: 0,
    outOfScopeSessions: 0,
    unverifiableSessions: 0,
    outOfScope: [],
    unverifiable: [],
    commandOverrides: { foreign: 0, unverifiable: 0, degradedMeasuredSessions: [] }
  }
  let sessions = args.sessions
  if (args.scope) {
    sessions = []
    for (const session of args.sessions) {
      if (!session.cwdVerified) {
        scope.unverifiableSessions += 1
        scope.unverifiable.push({ sessionId: session.sessionId, harness: session.harness })
        continue
      }
      if (!sessionInScope(session, args.scope)) {
        scope.outOfScopeSessions += 1
        scope.outOfScope.push({ sessionId: session.sessionId, harness: session.harness, repoRoot: session.repoRoot ?? null })
        continue
      }
      scope.includedSessions += 1
      sessions.push(session)
    }
  } else {
    scope.includedSessions = args.sessions.length
  }
  for (const session of sessions) {
    for (const item of [...session.signalTexts, ...session.writeTexts]) {
      if (item.scope === "out-of-scope") scope.commandOverrides.foreign += 1
      else if (item.scope === "unverifiable") scope.commandOverrides.unverifiable += 1
    }
  }
  const graded = sessions.map(session => ({ session, grades: gradeSessionSignals(session, tasksById) }))
  const { links, ambiguousSessions, weakMentions } = linkSessions(graded)
  const linksByTask = new Map<string, SessionLink[]>()
  for (const link of links) {
    const list = linksByTask.get(link.taskId) ?? []
    list.push(link)
    linksByTask.set(link.taskId, list)
  }
  const sessionsById = new Map(args.sessions.map(session => [session.sessionId, session]))
  const { perTask: commitsByTask } = commitsForTasks(args.commits ?? [], tasksById)
  const histories: TaskHistory[] = []
  for (const task of args.tasks) {
    const taskLinks = (linksByTask.get(task.taskId) ?? []).sort((a, b) => Number(a.secondary) - Number(b.secondary))
    const primary = taskLinks.filter(link => !link.secondary)
    const intervals: TimeEvidence["intervals"] = []
    const sessionSpans: NonNullable<TimeEvidence["sessionSpans"]> = []
    let evidenceSource: TimeEvidence["source"] | null = null
    for (const link of primary) {
      const session = sessionsById.get(link.sessionId)
      if (!session) continue
      // Review attempt 2, finding 1: a session that contains foreign or
      // unverifiable commands keeps its in-scope links but loses measured
      // time -- the span cannot be attributed honestly to this repository.
      if (args.scope && sessionProvenanceDirty(session)) {
        if (!scope.commandOverrides.degradedMeasuredSessions.includes(session.sessionId)) {
          scope.commandOverrides.degradedMeasuredSessions.push(session.sessionId)
        }
        continue
      }
      try {
        if (session.harness === "claude-code") {
          const jsonl = args.claudeJsonlBySession?.get(session.sessionId)
          if (!jsonl) continue
          const evidence = extractClaudeIntervals(jsonl)
          intervals.push(...evidence.intervals)
          sessionSpans.push(...(evidence.sessionSpans ?? []))
        } else {
          const built = buildEvidenceFromTimestamps(session.harness, session.sessionId, session.eventTimestamps)
          intervals.push(...built.intervals)
          sessionSpans.push(...built.sessionSpans)
        }
        evidenceSource ??= EVIDENCE_SOURCE[session.harness]
      } catch {
        // Sessions without a positive span cannot measure; they stay linked
        // (signal-grade) but contribute no intervals.
      }
    }
    const commits = commitsByTask.get(task.taskId) ?? []
    const tier: HistoryTier = intervals.length > 0
      ? "measured"
      : taskLinks.length > 0 || commits.length > 0
        ? "inferred"
        : task.startDate || task.dueDate
          ? "declared"
          : "no-history"
    // Confidence and ambiguity read PRIMARY links only: secondary scraps
    // (shared-tree spillover attributed elsewhere) neither promote nor taint.
    const primaryWeight = primary.length > 0 ? Math.max(...primary.map(link => link.weight)) : 0
    const confidence = tier === "no-history" || tier === "declared"
      ? "none"
      : primaryWeight >= SIGNAL_WEIGHT.toolcall
        ? "high"
        : primaryWeight >= SIGNAL_WEIGHT["file-edit"]
          ? "medium"
          : "low"
    histories.push({
      taskId: task.taskId,
      tier,
      confidence,
      links: taskLinks,
      attributedActiveMs: activeMsOf(intervals),
      intervals,
      sessionSpans,
      evidenceSource,
      commitHashes: commits.map(commit => commit.hash),
      ambiguous: primary.some(link => link.ambiguous)
    })
  }
  const doneHistories = histories.filter(history =>
    args.tasks.find(task => task.taskId === history.taskId)?.planningState === "done")
  const summary = {
    measured: histories.filter(history => history.tier === "measured").length,
    inferred: histories.filter(history => history.tier === "inferred").length,
    declared: histories.filter(history => history.tier === "declared").length,
    noHistory: histories.filter(history => history.tier === "no-history").length,
    linkedTasks: histories.filter(history => history.links.length > 0).length,
    done: {
      total: doneHistories.length,
      measured: doneHistories.filter(history => history.tier === "measured").length,
      inferred: doneHistories.filter(history => history.tier === "inferred").length,
      declared: doneHistories.filter(history => history.tier === "declared").length,
      noHistory: doneHistories.filter(history => history.tier === "no-history").length
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: args.generatedAt ?? new Date().toISOString(),
    tasks: histories,
    ambiguousSessions,
    weakMentions,
    sources: args.sources ?? {},
    scope,
    summary
  }
}

/** Deterministic UUID from a hash hex (idempotent receipts need stable ids). */
export function uuidFromHash(hex: string): string {
  const normalized = (hex.replace(/[^a-f0-9]/gi, "0") + "0".repeat(32)).slice(0, 32)
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20, 32)}`
}

/**
 * Deterministic history key: identical scans re-commit identical markers, so
 * re-runs are idempotent by pre-check instead of by duplicate writes.
 */
export function historyKey(history: TaskHistory): string {
  const sessions = history.links.map(link => `${link.harness}:${link.sessionId}`).sort()
  return sha256Hex(`${history.taskId}|${history.tier}|${sessions.join(",")}`).slice(0, 16)
}

export function historySourceOf(history: TaskHistory): HistorySource {
  const harnesses = new Set(history.links.map(link => link.harness))
  if (harnesses.size === 0) return "git"
  if (harnesses.size > 1) return "mixed"
  const only = [...harnesses][0]
  return only === "codex" ? "codex" : only === "opencode" ? "opencode" : "claude-code"
}

/**
 * Build the retroactive-attestation receipt for one linked task. Bounds are
 * the true historical session span; measured links carry their intervals,
 * inferred links carry none (and never calibrate). Session linkage rides in
 * evidence as content-free history:// URIs; ids/hashes only, per privacy rule.
 */
export function buildHistoryReceipt(history: TaskHistory, dispatchId: string, attempt: number): RunReceipt {
  const bounds = [
    ...history.intervals.map(interval => Date.parse(interval.start)),
    ...history.intervals.map(interval => Date.parse(interval.end)),
    ...history.sessionSpans.map(span => Date.parse(span.start)),
    ...history.sessionSpans.map(span => Date.parse(span.end))
  ].filter(Number.isFinite)
  if (bounds.length === 0) throw new Error(`history scan: task ${history.taskId} has no time bounds for a receipt`)
  const startedAt = new Date(Math.min(...bounds)).toISOString()
  const endedAt = new Date(Math.max(...bounds)).toISOString()
  const tier = history.tier === "measured" || history.tier === "inferred" ? history.tier : "inferred"
  const measured = tier === "measured" && history.evidenceSource
  const receipt = {
    schemaVersion: 1,
    dispatchId,
    attempt,
    outcome: "completed",
    startedAt,
    endedAt,
    changedFiles: history.links.some(link => link.signals.includes("file-edit")) ? [`tasks/${history.taskId}.md`] : [],
    usageEvents: [],
    evidence: history.links.map(link => ({
      artifactId: uuidFromHash(sha256Hex(`history-evidence:${history.taskId}:${link.harness}:${link.sessionId}`)),
      ownerKind: "task",
      ownerId: history.taskId,
      uri: `history://${link.harness}/session/${link.sessionId}`,
      kind: "other",
      version: null,
      contentHash: sha256Hex(`${link.harness}:${link.sessionId}:${link.weight}`).slice(0, 16),
      promotedPath: null
    })),
    ...(measured
      ? {
        timeEvidence: {
          schemaVersion: 1,
          source: history.evidenceSource!,
          policy: DEFAULT_INTERVAL_POLICY,
          intervals: history.intervals,
          sessionSpans: history.sessionSpans
        }
      }
      : {}),
    historySource: historySourceOf(history),
    historyTier: tier,
    failure: null
  } as const
  return receipt as unknown as RunReceipt
}
