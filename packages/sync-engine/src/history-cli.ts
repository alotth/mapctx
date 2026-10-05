import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  appendHistoryEvidence,
  listHistoryCorrections,
  listHistoryEvidence,
  listTasks,
  getTaskDetail,
  recordHistoryCorrection,
  resolveMapctxToml,
  type HistoryCorrectionRecord,
  type HistoryEvidenceRecord,
  type StoreHandle
} from "@mapctx/store"
import {
  activeMsOf,
  buildReport,
  parseClaudeSession,
  parseCodexSession,
  parseOpencodeSession,
  uuidFromHash,
  sessionInScope,
  type GitCommit,
  type HistoryScanReport,
  type RawSession,
  type ScanScope,
  type TaskMeta
} from "@mapctx/forecast"

export type HistoryScanOptions = {
  json?: boolean
  commit?: boolean
  /** T-116: approval file required for --commit; records only approved links. */
  approvePath?: string
  /** Review attempt 2, finding 4: emit the approval CANDIDATE template. */
  emitApprovalPath?: string
  /**
   * Review attempt 5: opt degraded mixed-provenance sessions INTO the
   * emitted template as explicit `intendedTier: "inferred"` candidates.
   * Default templates exclude them.
   */
  includeInferred?: boolean
  dateCachePath?: string
  actor?: string
  codexSessions?: string
  opencodeDb?: string
  claudeDir?: string
  repo?: string
  taskFilter?: string
}

export function defaultHistoryPaths(): { codex: string; opencode: string; claude: string } {
  const home = os.homedir()
  return {
    codex: path.join(home, ".codex", "sessions"),
    opencode: path.join(home, ".local", "share", "opencode", "opencode.db"),
    claude: path.join(home, ".claude", "projects")
  }
}

function walkJsonl(dir: string): string[] {
  const found: string[] = []
  const visit = (current: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full)
    }
  }
  visit(dir)
  return found.sort()
}

function readCodexSessions(
  dir: string,
  sources: HistoryScanReport["sources"],
  errors: string[]
): RawSession[] {
  if (!fs.existsSync(dir)) {
    sources.codex = { status: "missing", sessions: 0, detail: `not found: ${dir}` }
    return []
  }
  const sessions: RawSession[] = []
  let failed = 0
  for (const file of walkJsonl(dir)) {
    let content: string
    try {
      content = fs.readFileSync(file, "utf8")
    } catch (error) {
      failed += 1
      errors.push(`codex unreadable ${file}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    try {
      sessions.push(parseCodexSession(content, file))
    } catch (error) {
      failed += 1
      errors.push(`codex unparseable ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  sources.codex = { status: "ok", sessions: sessions.length, detail: failed > 0 ? `${failed} file(s) skipped` : undefined }
  return sessions
}

type OpenCodeMessageRow = { role: string; timeCreated: number; timeCompleted?: number | null; text?: string }

function safeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Review attempt 5 (live-audit gap): the approval source pin must reflect
 * the OpenCode session's actual source content -- a hash of only the
 * session id never changes, so appended/updated messages, parts, prompts,
 * or edited meta could not invalidate a stale approval. The pin covers the
 * session meta (directory, title) plus every message/part/prompt row,
 * canonicalized line-by-line with a full ordering key so SQL return order
 * can never change the value. Row payloads enter only as sha256 digests:
 * the pin never exposes transcript text, and the full (untruncated) data
 * column is digested -- no truncation may hide a source change.
 */
function opencodeSessionSourceHash(input: {
  id: string
  directory: string | null
  title: string | null
  messages: Array<{ timeCreated: number; timeUpdated: number; data: string }>
  parts: Array<{ timeCreated: number; timeUpdated: number; data: string }>
  prompts: Array<{ timeCreated: number; prompt: string }>
}): string {
  const digest = (payload: string) => createHash("sha256").update(payload, "utf8").digest("hex")
  const line = (prefix: string, timeCreated: number, timeUpdated: number | null, payload: string) =>
    `${prefix}:${timeCreated}:${timeUpdated ?? ""}:${digest(payload)}\n`
  const rows = [
    ...input.messages.map(row => line("m", row.timeCreated, row.timeUpdated, row.data)),
    ...input.parts.map(row => line("p", row.timeCreated, row.timeUpdated, row.data)),
    ...input.prompts.map(row => line("i", row.timeCreated, null, row.prompt))
  ].sort()
  const hash = createHash("sha256")
  hash.update(`opencode:v2:${input.id}\n${input.directory ?? ""}\n${input.title ?? ""}\n`)
  for (const value of rows) hash.update(value)
  return hash.digest("hex")
}

function readOpencodeSessions(
  dbPath: string,
  sources: HistoryScanReport["sources"],
  errors: string[]
): RawSession[] {
  if (!fs.existsSync(dbPath)) {
    sources.opencode = { status: "missing", sessions: 0, detail: `not found: ${dbPath}` }
    return []
  }
  let db: DatabaseSync
  try {
    // Read-only open: the live OpenCode database is never written or locked by the scan.
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    sources.opencode = { status: "locked", sessions: 0, detail: error instanceof Error ? error.message : String(error) }
    errors.push(`opencode locked: ${dbPath}`)
    return []
  }
  try {
    const sessions = db.prepare("SELECT id, directory, title FROM session").all() as Array<{ id: string; directory: string | null; title: string | null }>
    const messages = db.prepare("SELECT session_id AS sessionId, time_created AS timeCreated, time_updated AS timeUpdated, data FROM message").all() as Array<{ sessionId: string; timeCreated: number; timeUpdated: number; data: string }>
    const parts = db.prepare("SELECT session_id AS sessionId, time_created AS timeCreated, time_updated AS timeUpdated, data FROM part").all() as Array<{ sessionId: string; timeCreated: number; timeUpdated: number; data: string }>
    let prompts: Array<{ sessionId: string; prompt: string; timeCreated: number }> = []
    try {
      prompts = db.prepare("SELECT session_id AS sessionId, prompt, time_created AS timeCreated FROM session_input").all() as typeof prompts
    } catch {
      prompts = []
    }
    const rawPromptsBySession = new Map<string, Array<{ timeCreated: number; prompt: string }>>()
    for (const row of prompts) {
      if (typeof row.prompt !== "string" || !row.prompt.trim()) continue
      const rawList = rawPromptsBySession.get(row.sessionId) ?? []
      rawList.push({ timeCreated: row.timeCreated, prompt: row.prompt })
      rawPromptsBySession.set(row.sessionId, rawList)
    }
    const messagesBySession = new Map<string, OpenCodeMessageRow[]>()
    const rawMessagesBySession = new Map<string, Array<{ timeCreated: number; timeUpdated: number; data: string }>>()
    for (const row of messages) {
      const rawList = rawMessagesBySession.get(row.sessionId) ?? []
      rawList.push({ timeCreated: row.timeCreated, timeUpdated: row.timeUpdated, data: row.data })
      rawMessagesBySession.set(row.sessionId, rawList)
      const data = safeJson(row.data)
      const role = typeof data?.role === "string" ? data.role : "unknown"
      const time = data?.time as { created?: unknown; completed?: unknown } | undefined
      const created = typeof time?.created === "number" ? time.created : row.timeCreated
      const completed = typeof time?.completed === "number" ? time.completed : undefined
      // User prompt text lives in session_input; message rows carry summaries only.
      const list = messagesBySession.get(row.sessionId) ?? []
      list.push({ role, timeCreated: created, timeCompleted: completed ?? undefined })
      messagesBySession.set(row.sessionId, list)
    }
    for (const row of prompts) {
      if (typeof row.prompt !== "string" || !row.prompt.trim()) continue
      const list = messagesBySession.get(row.sessionId) ?? []
      list.push({ role: "user", timeCreated: row.timeCreated, text: row.prompt })
      messagesBySession.set(row.sessionId, list)
    }
    const partsBySession = new Map<string, Array<{ timeCreated: number; timeUpdated?: number | null; tool?: string | null; inputText?: string; files?: string[] }>>()
    const rawPartsBySession = new Map<string, Array<{ timeCreated: number; timeUpdated: number; data: string }>>()
    for (const row of parts) {
      const rawList = rawPartsBySession.get(row.sessionId) ?? []
      rawList.push({ timeCreated: row.timeCreated, timeUpdated: row.timeUpdated, data: row.data })
      rawPartsBySession.set(row.sessionId, rawList)
      const data = safeJson(row.data)
      if (!data) continue
      const entry: { timeCreated: number; timeUpdated?: number | null; tool?: string | null; inputText?: string; files?: string[] } = {
        timeCreated: row.timeCreated,
        timeUpdated: row.timeUpdated
      }
      if (data.type === "tool") {
        entry.tool = typeof data.tool === "string" ? data.tool : "tool"
        const state = data.state as { input?: unknown } | undefined
        if (state?.input !== undefined) entry.inputText = JSON.stringify(state.input).slice(0, 4000)
      } else if (data.type === "text" && typeof data.text === "string") {
        entry.tool = "text"
        entry.inputText = data.text.slice(0, 4000)
      }
      const files = (data as { files?: unknown }).files
      if (Array.isArray(files)) entry.files = files.filter((file): file is string => typeof file === "string")
      const list = partsBySession.get(row.sessionId) ?? []
      list.push(entry)
      partsBySession.set(row.sessionId, list)
    }
    const out: RawSession[] = []
    for (const session of sessions) {
      const hash = opencodeSessionSourceHash({
        id: session.id,
        directory: session.directory,
        title: session.title,
        messages: rawMessagesBySession.get(session.id) ?? [],
        parts: rawPartsBySession.get(session.id) ?? [],
        prompts: rawPromptsBySession.get(session.id) ?? []
      })
      out.push(parseOpencodeSession(
        { session, messages: messagesBySession.get(session.id) ?? [], parts: partsBySession.get(session.id) ?? [] },
        hash
      ))
    }
    sources.opencode = { status: "ok", sessions: out.length }
    return out
  } catch (error) {
    sources.opencode = { status: "error", sessions: 0, detail: error instanceof Error ? error.message : String(error) }
    errors.push(`opencode read failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  } finally {
    db.close()
  }
}

function readClaudeSessions(
  dir: string,
  sources: HistoryScanReport["sources"],
  errors: string[]
): { sessions: RawSession[]; jsonlBySession: Map<string, string> } {
  const jsonlBySession = new Map<string, string>()
  if (!fs.existsSync(dir)) {
    sources.claude = { status: "missing", sessions: 0, detail: `not found: ${dir}` }
    return { sessions: [], jsonlBySession }
  }
  const sessions: RawSession[] = []
  let failed = 0
  for (const file of walkJsonl(dir)) {
    let content: string
    try {
      content = fs.readFileSync(file, "utf8")
    } catch (error) {
      failed += 1
      errors.push(`claude unreadable ${file}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    try {
      const session = parseClaudeSession(content, file)
      sessions.push(session)
      // Interval bytes are re-read only for linked sessions at report time;
      // keep them keyed here so the scan never stores transcript content.
      jsonlBySession.set(session.sessionId, content)
    } catch (error) {
      failed += 1
      errors.push(`claude unparseable ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  sources.claude = { status: "ok", sessions: sessions.length, detail: failed > 0 ? `${failed} file(s) skipped` : undefined }
  return { sessions, jsonlBySession }
}

function readGitCommits(repo: string, errors: string[]): GitCommit[] {
  try {
    // A repo without commits yet has no history to link -- not an error.
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch {
    return []
  }
  try {
    const output = execFileSync("git", ["log", "--format=%H%x00%aI%x00%s%x00%b%x1e", "--no-merges", "-n", "5000"], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    })
    return output.split("\x1e").flatMap(entry => {
      const parts = entry.split("\x00")
      if (parts.length < 3) return []
      return [{ hash: parts[0].trim(), date: parts[1].trim(), subject: `${parts[2].trim()} ${parts[3]?.trim() ?? ""}`.trim() }]
    }).filter(commit => /^[0-9a-f]{40}$/.test(commit.hash))
  } catch (error) {
    errors.push(`git log failed in ${repo}: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

// ---- T-116 repository / session identity ----

export type RepoIdentity = { repoRoot: string | null; repoOrigin: string | null }

function gitPath(dir: string, flag: string): string | null {
  try {
    const value = execFileSync("git", ["rev-parse", "--path-format=absolute", flag], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim()
    return value ? fs.realpathSync.native(value) : null
  } catch {
    return null
  }
}

/**
 * Canonical repository identity for scoping: the realpath'd git toplevel
 * (worktree-specific) and the git common dir (shared by every worktree of
 * the repository). Non-git directories carry null identities and can only
 * match by exact root equality, which null never does.
 */
export function resolveRepoIdentity(dir: string): RepoIdentity {
  let real: string
  try {
    real = fs.realpathSync.native(dir)
  } catch {
    return { repoRoot: null, repoOrigin: null }
  }
  return { repoRoot: gitPath(real, "--show-toplevel"), repoOrigin: gitPath(real, "--git-common-dir") }
}

/** Absolute paths (2+ segments) that may name foreign repo targets in command text. */
const ABSOLUTE_PATH_PATTERN = /\/[A-Za-z0-9._@~-]+(?:\/[A-Za-z0-9._@~-]+){1,}/g
const MAX_PROVENANCE_PATHS_PER_ENTRY = 8

/**
 * Review attempt 2, finding 1 (repo-target args): commands can operate on
 * another repository without cd or a workdir key -- `git -C <path>`,
 * absolute file paths, etc. A command text that references a verifiable
 * DIFFERENT git repository is foreign provenance for that entry, no matter
 * which directory the session claims.
 *
 * Review attempt 3, finding 2: the candidate cap must never fail open. When
 * the scan stops before every candidate was resolved, the entry's
 * provenance is `truncated` -- callers must grade it unverifiable, because
 * a foreign repo target can hide behind earlier absolute path operands.
 */
type ProvenanceScan = "clean" | "foreign" | "truncated"

function foreignRepoPathsIn(text: string, scope: ScanScope, resolvePath: (target: string) => { exists: boolean; identity: RepoIdentity }): ProvenanceScan {
  const candidates = text.match(ABSOLUTE_PATH_PATTERN) ?? []
  let checked = 0
  for (const candidate of candidates) {
    if (candidate.length > 200) continue
    if (scope.repoRoot && (candidate === scope.repoRoot || candidate.startsWith(`${scope.repoRoot}/`))) continue
    if (checked >= MAX_PROVENANCE_PATHS_PER_ENTRY) return "truncated"
    checked += 1
    const { exists, identity } = resolvePath(candidate)
    if (!exists) continue
    // A verifiable git repository that is not this one (by root or common
    // origin) makes the whole entry foreign. Files outside any repository
    // (dot-directories, scratch) carry no repo provenance and stay with the
    // session's own scope.
    if (identity.repoRoot && identity.repoRoot !== scope.repoRoot && identity.repoOrigin !== scope.repoOrigin) {
      return "foreign"
    }
    if (scope.repoOrigin && identity.repoOrigin && identity.repoOrigin !== scope.repoOrigin && identity.repoRoot !== scope.repoRoot) {
      return "foreign"
    }
  }
  return "clean"
}

/**
 * Resolve each session's repository identity from its recorded cwd, then
 * resolve every signal entry's command-level provenance (review attempt 2,
 * finding 1): an explicit workdir/cd override is scoped against the scanned
 * repository on its own -- a MapCtx session whose tool ran inside another
 * repository carries an out-of-scope entry, and an unresolvable override
 * (relative path, shell variable, or ".") is unverifiable. Command text
 * referencing a foreign git repository (git -C, absolute paths) is foreign
 * too, and a command whose provenance scan hit the path-candidate cap is
 * unverifiable as well (review attempt 3, finding 2: never fail open). All
 * such entries are graded as never-linking downstream, and any such
 * entry degrades the session's measured time.
 */
export function resolveSessionIdentities(sessions: RawSession[], scope?: ScanScope): void {
  const memo = new Map<string, { exists: boolean; identity: RepoIdentity }>()
  const resolvePath = (target: string): { exists: boolean; identity: RepoIdentity } => {
    let cached = memo.get(target)
    if (!cached) {
      const exists = fs.existsSync(target)
      cached = { exists, identity: exists ? resolveRepoIdentity(target) : { repoRoot: null, repoOrigin: null } }
      memo.set(target, cached)
    }
    return cached
  }
  const scopeForPath = (target: string): "in-scope" | "out-of-scope" | "unverifiable" => {
    if (target === "." || !target.startsWith("/")) return "unverifiable"
    if (!scope) return "in-scope"
    const { exists, identity } = resolvePath(target)
    if (!exists) return "unverifiable"
    if (scope.repoRoot && (identity.repoRoot === scope.repoRoot || identity.repoOrigin === scope.repoOrigin)) return "in-scope"
    return "out-of-scope"
  }
  for (const session of sessions) {
    if (!session.cwd) {
      session.cwdVerified = false
      session.repoRoot = null
      session.repoOrigin = null
    } else {
      const resolved = resolvePath(session.cwd)
      session.cwdVerified = resolved.exists
      session.repoRoot = resolved.identity.repoRoot
      session.repoOrigin = resolved.identity.repoOrigin
    }
    const sessionScope: "in-scope" | "out-of-scope" | "unverifiable" = !session.cwdVerified
      ? "unverifiable"
      : scope && !sessionInScope(session, scope)
        ? "out-of-scope"
        : "in-scope"
    for (const item of [...session.signalTexts, ...session.writeTexts]) {
      if (item.workdir === undefined || item.workdir === null) {
        const foreign = scope ? foreignRepoPathsIn(item.text, scope, resolvePath) : "clean"
        item.scope = sessionScope !== "in-scope"
          ? sessionScope
          : foreign === "foreign"
            ? "out-of-scope"
            : foreign === "truncated"
              ? "unverifiable"
              : "in-scope"
      } else {
        const own = scopeForPath(item.workdir)
        // An in-scope workdir does not excuse command text that targets a
        // different repository (workdir MapCtx + `git -C <foreign>`), and a
        // truncated path scan is unverifiable, never trusted as in-scope.
        const foreign = scope && own === "in-scope" ? foreignRepoPathsIn(item.text, scope, resolvePath) : "clean"
        item.scope = foreign === "foreign" ? "out-of-scope" : foreign === "truncated" ? "unverifiable" : own
      }
    }
  }
}

export type HistoryCommitResult = {
  taskId: string
  action: "recorded" | "skipped" | "refused"
  evidenceId?: string
  harness?: string
  sessionId?: string
  tier?: string
  reason?: string
}

// ---- T-116 approved evidence commit ----

export type HistoryApprovalSession = {
  harness: string
  sessionId: string
  /** Review attempt 2, finding 4: pins the reviewed source version. */
  sourceHash: string
  /** Review attempt 3, finding 1: explicit intent to record a non-measured
   * (degraded/secondary/spanless) session as inferred evidence. */
  intendedTier?: "inferred"
}

export type HistoryApprovalEntry = {
  taskId: string
  sessions: HistoryApprovalSession[]
  approvedBy?: string
}

export type HistoryApprovalFile = {
  schemaVersion: 2
  sourceScan: { generatedAt: string; repoRoot: string | null; repoOrigin: string | null }
  approvals: HistoryApprovalEntry[]
}

export function loadApprovals(approvePath: string): HistoryApprovalFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(approvePath), "utf8"))
  } catch (error) {
    throw new Error(`history commit: unreadable approval file ${approvePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const file = parsed as HistoryApprovalFile
  if (file.schemaVersion !== 2 || !Array.isArray(file.approvals)) {
    throw new Error("history commit: approval file must be { schemaVersion: 2, sourceScan: {...}, approvals: [{ taskId, sessions: [{ harness, sessionId, sourceHash }] }] } (schema v1 files are obsolete -- regenerate from a fresh dry-run)")
  }
  if (!file.sourceScan || typeof file.sourceScan.generatedAt !== "string") {
    throw new Error("history commit: approval file must name the dry-run it reviewed (sourceScan.generatedAt)")
  }
  for (const entry of file.approvals) {
    if (!/^T-\d{1,4}$/.test(entry.taskId ?? "")) throw new Error(`history commit: invalid taskId in approvals: ${entry.taskId}`)
    if (!Array.isArray(entry.sessions) || entry.sessions.length === 0) {
      throw new Error(`history commit: approval for ${entry.taskId} lists no sessions`)
    }
    for (const session of entry.sessions) {
      if (!session.harness || !session.sessionId) {
        throw new Error(`history commit: approval for ${entry.taskId} has a session without harness/sessionId`)
      }
      if (!/^[0-9a-f]{8,64}$/.test(session.sourceHash ?? "")) {
        throw new Error(`history commit: approval for ${entry.taskId} session ${session.sessionId} lacks a valid sourceHash pin (regenerate the template from a fresh dry-run)`)
      }
      if (session.intendedTier !== undefined && session.intendedTier !== "inferred") {
        throw new Error(`history commit: approval for ${entry.taskId} session ${session.sessionId} has an invalid intendedTier (only "inferred" is accepted)`)
      }
    }
  }
  return file
}

/**
 * Review attempt 2, finding 4: build the approval CANDIDATE file from a
 * dry-run report. Candidates are not approvals -- an operator must prune and
 * review the file, then pass it to `history scan --commit --approve`.
 *
 * Review attempt 3, finding 1: degraded mixed-provenance sessions are NOT
 * approval candidates by default -- a task-wide measured tier must never
 * silently promote them. `includeInferred` opts in explicitly, marking such
 * candidates `intendedTier: "inferred"`; every other non-measured candidate
 * (secondary, no positive span) is marked the same way so the recorded tier
 * always states its intent.
 */
export function sessionMeasuredEligible(
  history: { intervals: Array<{ sessionId?: string }> },
  link: { sessionId: string; secondary: boolean }
): boolean {
  return !link.secondary && history.intervals.some(interval => interval.sessionId === link.sessionId)
}

export function buildApprovalTemplate(
  report: HistoryScanReport,
  opts: { includeInferred?: boolean } = {}
): HistoryApprovalFile {
  const degraded = new Set(report.scope.commandOverrides.degradedMeasuredSessions)
  return {
    schemaVersion: 2,
    sourceScan: {
      generatedAt: report.generatedAt,
      repoRoot: report.scope.repoRoot,
      repoOrigin: report.scope.repoOrigin
    },
    approvals: report.tasks
      .filter(task => task.links.length > 0)
      .map(task => ({
        taskId: task.taskId,
        sessions: task.links
          .filter(link => opts.includeInferred || !degraded.has(link.sessionId))
          .map(link => sessionMeasuredEligible(task, link)
            ? { harness: link.harness, sessionId: link.sessionId, sourceHash: link.sourceHash }
            : { harness: link.harness, sessionId: link.sessionId, sourceHash: link.sourceHash, intendedTier: "inferred" as const })
      }))
      .filter(entry => entry.sessions.length > 0)
  }
}

export function evidenceIdFor(taskId: string, harness: string, sessionId: string): string {
  return uuidFromHash(createHash("sha256").update(`t116-history:${taskId}:${harness}:${sessionId}`, "utf8").digest("hex"))
}

function confidenceForWeight(weight: number): HistoryEvidenceRecord["confidence"] {
  return weight >= 4 ? "high" : weight >= 3 ? "medium" : "low"
}

/**
 * T-116 commit path: records approved links as historical evidence through
 * the store's single-writer journal. There is deliberately NO claim, NO
 * dispatch, NO receipt, and NO task projection mutation: done tasks keep
 * planning state and completedOn, backlog stays backlog.
 *
 * Review attempt 2, finding 3: the whole approval set is prefetched and
 * validated BEFORE any mutation, then written in ONE store transaction.
 * Any stale, unlinked, conflicting, or malformed entry aborts the entire
 * commit with zero journal/evidence changes and a nonzero CLI exit.
 * Finding 4: an approval whose session source changed since the reviewed
 * dry-run is a stale approval -- refused pending re-review.
 */
export function commitApprovedEvidence(
  handle: StoreHandle,
  report: HistoryScanReport,
  approvals: HistoryApprovalFile,
  actor: string
): HistoryCommitResult[] {
  const prepared: Array<{ entry: HistoryApprovalEntry; requested: HistoryApprovalSession; link: (typeof report.tasks)[number]["links"][number]; evidence: HistoryEvidenceRecord }> = []
  const problems: string[] = []
  const degradedSessions = new Set(report.scope.commandOverrides.degradedMeasuredSessions)
  for (const entry of approvals.approvals) {
    const history = report.tasks.find(task => task.taskId === entry.taskId)
    if (!history) {
      problems.push(`${entry.taskId}: task not in scan report`)
      continue
    }
    for (const requested of entry.sessions) {
      const link = history.links.find(candidate =>
        candidate.harness === requested.harness && candidate.sessionId === requested.sessionId)
      if (!link) {
        problems.push(`${entry.taskId} ${requested.harness}:${requested.sessionId.slice(0, 12)}: session not linked to this task by the scoped scan`)
        continue
      }
      if (link.sourceHash !== requested.sourceHash) {
        problems.push(`${entry.taskId} ${requested.harness}:${requested.sessionId.slice(0, 12)}: session source changed since the approved dry-run (approval pin ${requested.sourceHash.slice(0, 8)} != scan ${link.sourceHash.slice(0, 8)}) -- re-review required`)
        continue
      }
      // Review attempt 3, finding 1: tier comes from PER-SESSION measurement
      // eligibility -- a session contributes measured evidence only when it
      // is primary AND its intervals survived provenance grading. A degraded
      // mixed-provenance session stays inferred even when the task measures
      // cleanly elsewhere, and its whole window can never widen measured
      // bounds. Intent must be explicit and must match: a degraded session
      // approved without `intendedTier: "inferred"` refuses; a measured-
      // eligible session declared inferred refuses too.
      const degraded = degradedSessions.has(link.sessionId)
      const eligible = sessionMeasuredEligible(history, link)
      const tier: "measured" | "inferred" = eligible ? "measured" : "inferred"
      if (requested.intendedTier !== undefined) {
        if (requested.intendedTier !== tier) {
          problems.push(`${entry.taskId} ${requested.harness}:${requested.sessionId.slice(0, 12)}: intendedTier ${requested.intendedTier} does not match scan eligibility (${tier}) -- regenerate the approval from a fresh dry-run`)
          continue
        }
      } else if (degraded && !eligible) {
        problems.push(`${entry.taskId} ${requested.harness}:${requested.sessionId.slice(0, 12)}: degraded mixed-provenance session requires explicit inferred intent (regenerate the template with --include-inferred and review the linkage)`)
        continue
      }
      const sessionIntervals = eligible
        ? history.intervals.filter(interval => interval.sessionId === link.sessionId)
        : []
      const evidence: HistoryEvidenceRecord = {
        evidenceId: evidenceIdFor(entry.taskId, link.harness, link.sessionId),
        taskId: entry.taskId,
        harness: link.harness,
        sessionId: link.sessionId,
        tier,
        confidence: confidenceForWeight(link.weight),
        repoRoot: report.scope.repoRoot,
        repoOrigin: report.scope.repoOrigin,
        signals: [...link.signals],
        spanStart: link.spanStart,
        spanEnd: link.spanEnd,
        activeMs: eligible ? activeMsOf(sessionIntervals) : null,
        sourceHash: link.sourceHash,
        recordedAt: new Date().toISOString()
      }
      if (tier === "measured" && !evidence.spanStart) {
        problems.push(`${entry.taskId} ${link.harness}:${link.sessionId.slice(0, 12)}: measured link has no recoverable timestamps`)
        continue
      }
      prepared.push({ entry, requested, link, evidence })
    }
  }
  if (problems.length > 0) {
    throw new Error(`history commit refused -- approval set does not match the current scoped scan (nothing written):\n  - ${problems.join("\n  - ")}`)
  }
  return handle.runInWriteTransaction(append => {
    const results: HistoryCommitResult[] = []
    for (const item of prepared) {
      const recorded = appendHistoryEvidence(handle, item.evidence, append, actor)
      if (!recorded.ok) {
        // Throwing rolls back the whole transaction: no partial writes.
        throw new Error(`history commit failed mid-transaction (full rollback): ${item.entry.taskId} ${item.requested.harness}:${item.requested.sessionId.slice(0, 12)}: ${recorded.reason}${recorded.message ? ` -- ${recorded.message}` : ""}`)
      }
      results.push({
        taskId: item.entry.taskId,
        action: recorded.duplicate ? "skipped" : "recorded",
        evidenceId: item.evidence.evidenceId,
        harness: item.link.harness,
        sessionId: item.link.sessionId,
        tier: item.evidence.tier,
        reason: recorded.duplicate ? "already recorded (idempotent re-run)" : recorded.reactivated ? "re-activated after correction" : undefined
      })
    }
    return results
  })
}

/**
 * Rebuild the measured-date cache from ACTIVE approved evidence only, one
 * AGGREGATE row per task (review attempt 2, finding 6): all active measured
 * sessions collapse into the task's full earliest/latest bounds with summed
 * active time, and inferred evidence rides along explicitly tier-tagged so
 * the roadmap can display it as distinctly inferred -- never as measured
 * actual. Corrected/invalidated evidence drops out here, so roadmap displays
 * and this cache never disagree, and unrelated valid tasks are never erased
 * (the cache is rebuilt from the whole store, not the latest scan).
 *
 * Review attempt 4: an inferred-only aggregate serializes `activeMs: null`
 * (unknown, never zero); a numeric value appears only when measured evidence
 * contributes, and inferred active time is never summed into it.
 */
export function refreshHistoryDateCache(handle: StoreHandle, dateCachePath: string): void {
  const confidenceRank: Record<string, number> = { high: 3, medium: 2, low: 1, none: 0 }
  // Review attempt 4: null active time must survive serialization -- an
  // inferred aggregate is UNKNOWN active time, never zero. A numeric value
  // appears only when measured evidence contributes, and inferred rows are
  // never summed into it.
  const measuredSum = (a: number | null, b: number | null): number | null =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0)
  const byTask = new Map<string, {
    taskId: string
    startedAt: string
    endedAt: string
    activeMs: number | null
    confidence: string
    source: string
    tier: "measured" | "inferred"
  }>()
  for (const evidence of listHistoryEvidence(handle.db)) {
    if (evidence.status !== "active") continue
    // Only bounded evidence renders in the roadmap timeline; measured tiers
    // always carry bounds (store validation enforces it).
    if (!evidence.spanStart || !evidence.spanEnd) continue
    const existing = byTask.get(evidence.taskId)
    const startMs = Date.parse(evidence.spanStart)
    const endMs = Date.parse(evidence.spanEnd)
    const source = evidence.harness === "codex" ? "codex-jsonl" : evidence.harness === "opencode" ? "opencode-db" : "claude-jsonl"
    if (!existing) {
      byTask.set(evidence.taskId, {
        taskId: evidence.taskId,
        startedAt: evidence.spanStart ?? "",
        endedAt: evidence.spanEnd ?? "",
        activeMs: evidence.activeMs ?? null,
        confidence: evidence.confidence,
        source,
        tier: evidence.tier
      })
      continue
    }
    // Measured evidence dominates a task's aggregate: an inferred row never
    // widens a measured task's bounds or demotes its tier.
    if (existing.tier === "measured" && evidence.tier === "inferred") continue
    const merged: typeof existing = {
      taskId: existing.taskId,
      startedAt: new Date(Math.min(startMs, Date.parse(existing.startedAt) || startMs)).toISOString(),
      endedAt: new Date(Math.max(endMs, Date.parse(existing.endedAt) || endMs)).toISOString(),
      activeMs: measuredSum(existing.activeMs, evidence.activeMs),
      confidence: (confidenceRank[evidence.confidence] ?? 0) < (confidenceRank[existing.confidence] ?? 0)
        ? evidence.confidence
        : existing.confidence,
      source: existing.source,
      tier: existing.tier === "measured" ? "measured" : evidence.tier
    }
    byTask.set(evidence.taskId, merged)
  }
  const dates = [...byTask.values()].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.startedAt.localeCompare(b.startedAt))
  const cache = { schemaVersion: 2, generatedAt: new Date().toISOString(), tasks: dates }
  fs.mkdirSync(path.dirname(dateCachePath), { recursive: true })
  const temporaryPath = `${dateCachePath}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8")
  fs.renameSync(temporaryPath, dateCachePath)
}

export function collectHistoryScan(options: {
  codexDir: string
  opencodeDb: string
  claudeDir: string
  repo: string
  tasks: TaskMeta[]
  /** T-116: resolve repository identities and scope the report (CLI path). */
  resolveIdentity?: boolean
}): { report: HistoryScanReport; errors: string[] } {
  const sources: HistoryScanReport["sources"] = {}
  const errors: string[] = []
  const sessions: RawSession[] = [
    ...readCodexSessions(options.codexDir, sources, errors),
    ...readOpencodeSessions(options.opencodeDb, sources, errors)
  ]
  const claude = readClaudeSessions(options.claudeDir, sources, errors)
  sessions.push(...claude.sessions)
  sources.git = { status: "ok", sessions: 0 }
  const commits = readGitCommits(options.repo, errors)
  if (commits.length === 0 && errors.some(error => error.startsWith("git log failed"))) {
    sources.git = { status: "error", sessions: 0, detail: "git log failed" }
  }
  let scope: ScanScope | undefined
  if (options.resolveIdentity) {
    scope = resolveRepoIdentity(options.repo)
    resolveSessionIdentities(sessions, scope)
  }
  const report = buildReport({
    sessions,
    tasks: options.tasks,
    commits,
    claudeJsonlBySession: claude.jsonlBySession,
    sources,
    scope
  })
  return { report, errors }
}

export function taskMetasForScan(handle: StoreHandle, filter?: string): { tasks: TaskMeta[]; planningByTask: Map<string, string> } {
  const wanted = filter ? new Set(filter.split(",").map(part => part.trim()).filter(Boolean)) : undefined
  const tasks: TaskMeta[] = []
  const planningByTask = new Map<string, string>()
  for (const task of listTasks(handle.db)) {
    if (wanted && !wanted.has(task.taskId)) continue
    planningByTask.set(task.taskId, task.planningState)
    tasks.push({
      taskId: task.taskId,
      filesAffected: getTaskDetail(handle.db, task.taskId)?.filesAffected ?? [],
      startDate: task.startDate,
      dueDate: task.dueDate,
      planningState: task.planningState
    })
  }
  return { tasks, planningByTask }
}

export function historyScanCommand(handle: StoreHandle, tasksRoot: string, options: HistoryScanOptions): void {
  const defaults = defaultHistoryPaths()
  const { tasks, planningByTask } = taskMetasForScan(handle, options.taskFilter)
  const { report, errors } = collectHistoryScan({
    codexDir: options.codexSessions ?? defaults.codex,
    opencodeDb: options.opencodeDb ?? defaults.opencode,
    claudeDir: options.claudeDir ?? defaults.claude,
    repo: options.repo ?? tasksRoot,
    tasks,
    resolveIdentity: true
  })
  let commits: HistoryCommitResult[] | undefined
  if (options.emitApprovalPath) {
    const template = buildApprovalTemplate(report, { includeInferred: options.includeInferred })
    fs.mkdirSync(path.dirname(path.resolve(options.emitApprovalPath)), { recursive: true })
    fs.writeFileSync(options.emitApprovalPath, `${JSON.stringify(template, null, 2)}\n`, "utf8")
    if (!options.json) {
      console.log(`approval template: ${options.emitApprovalPath} (candidates only -- prune, review, then pass to --commit --approve)`)
    }
  }
  if (options.commit) {
    if (!options.approvePath) {
      throw new Error("history commit requires --approve <file>: recording happens only for approved links (see the dry-run report)")
    }
    const approvals = loadApprovals(options.approvePath)
    // All-or-nothing: preflight failures throw here (zero writes); a
    // mid-transaction failure rolls the whole set back and surfaces as a
    // nonzero CLI exit.
    commits = commitApprovedEvidence(handle, report, approvals, options.actor ?? "history-scan")
    if (options.dateCachePath) refreshHistoryDateCache(handle, options.dateCachePath)
  }
  const payload = { ...report, errors, commits }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }
  const recorded = commits?.filter(entry => entry.action === "recorded").length ?? 0
  const skipped = commits?.filter(entry => entry.action === "skipped").length ?? 0
  const refused = commits?.filter(entry => entry.action === "refused").length ?? 0
  console.log(`history scan: ${report.summary.measured} measured / ${report.summary.inferred} inferred / ${report.summary.declared} declared / ${report.summary.noHistory} no-history (${report.summary.linkedTasks} linked)`)
  console.log(`done tasks: ${report.summary.done.total} total -- ${report.summary.done.measured} measured / ${report.summary.done.inferred} inferred / ${report.summary.done.declared} declared / ${report.summary.done.noHistory} no-history`)
  console.log(`scope: ${report.scope.includedSessions} in-scope / ${report.scope.outOfScopeSessions} out-of-scope / ${report.scope.unverifiableSessions} unverifiable sessions (out-of-scope and unverifiable are never linked)`)
  const overrides = report.scope.commandOverrides
  if (overrides.foreign > 0 || overrides.unverifiable > 0 || overrides.degradedMeasuredSessions.length > 0) {
    console.log(`command provenance: ${overrides.foreign} foreign + ${overrides.unverifiable} unverifiable command override(s) excluded; measured degraded to inferred for ${overrides.degradedMeasuredSessions.length} session(s)`)
  }
  for (const source of Object.keys(report.sources).sort()) {
    const entry = report.sources[source]
    console.log(`- ${source}: ${entry.status} (${entry.sessions} sessions)${entry.detail ? ` -- ${entry.detail}` : ""}`)
  }
  for (const history of report.tasks.filter(task => task.links.length > 0 || task.commitHashes.length > 0)) {
    const sessions = history.links.map(link => `${link.harness}:${link.sessionId.slice(0, 8)}${link.secondary ? " (secondary)" : ""}`).join(", ")
    console.log(`- ${history.taskId}: ${history.tier}/${history.confidence} active=${history.attributedActiveMs}ms sessions=[${sessions}] commits=${history.commitHashes.length}${history.ambiguous ? " AMBIGUOUS" : ""}`)
  }
  if (report.ambiguousSessions.length > 0) {
    console.log(`ambiguous (${report.ambiguousSessions.length}): manual review required`)
    for (const entry of report.ambiguousSessions.slice(0, 20)) {
      console.log(`  ${entry.harness}:${entry.sessionId.slice(0, 8)} -> ${entry.taskIds.join(", ")}`)
    }
  }
  if (options.commit) {
    console.log(`commit: ${recorded} evidence recorded, ${skipped} skipped (idempotent), ${refused} refused`)
    for (const entry of commits ?? []) {
      if (entry.action !== "recorded") console.log(`  ${entry.action} ${entry.taskId}${entry.sessionId ? ` ${entry.harness}:${entry.sessionId.slice(0, 8)}` : ""}: ${entry.reason}`)
    }
  }
  if (errors.length > 0 && !options.json) {
    for (const error of errors.slice(0, 10)) console.log(`warn: ${error}`)
  }
}

// ---- T-116 corrections ----

export type HistoryCorrectOptions = {
  json?: boolean
  /** Target selector: "receipt:<dispatchId>/<attempt>" or "evidence:<id>". */
  target?: string
  reason?: string
  actor?: string
  dateCachePath?: string
}

export function historyCorrectCommand(handle: StoreHandle, taskId: string, options: HistoryCorrectOptions): void {
  if (!options.target) throw new Error("history correct requires --target receipt:<dispatchId>/<attempt> | evidence:<evidenceId>")
  if (!options.reason?.trim()) throw new Error("history correct requires --because <reason> (the audit trail keeps it verbatim)")
  const targetKind = options.target.startsWith("receipt:") ? "receipt" : options.target.startsWith("evidence:") ? "evidence" : null
  if (!targetKind) throw new Error(`invalid --target: ${options.target} (expected receipt:<dispatchId>/<attempt> or evidence:<evidenceId>)`)
  const targetId = options.target.slice(options.target.indexOf(":") + 1)
  const correction: HistoryCorrectionRecord = {
    correctionId: randomUUID(),
    taskId,
    targetKind,
    targetId,
    verdict: "invalid",
    reason: options.reason,
    recordedAt: new Date().toISOString()
  }
  const result = recordHistoryCorrection(handle, correction, options.actor ?? "history-correct")
  if (options.dateCachePath) refreshHistoryDateCache(handle, options.dateCachePath)
  // Live-recovery follow-up: a refused correction is a FAILED command (the
  // operator's script must see nonzero), whether or not --json is set. The
  // JSON body still prints first so tooling can parse the refusal reason.
  if (!result.ok) {
    const detail = `history correct refused -- ${result.reason}${result.message ? ` -- ${result.message}` : ""}`
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    throw new Error(detail)
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  console.log(`correct: ${correction.targetKind} ${correction.targetId} marked invalid for ${taskId} (correction ${correction.correctionId}); original remains queryable`)
}

// ---- T-116 reconstruction ----

export type ReconstructedTask = {
  taskId: string
  planningState: string
  tier: "measured" | "inferred" | "declared" | "synthetic" | "no-history"
  evidence: Array<{ evidenceId: string; harness: string; sessionId: string; tier: string; confidence: string; status: string; spanStart: string | null; spanEnd: string | null }>
  activeEvidence: number
  invalidatedEvidence: number
  invalidatedReceipts: Array<{ targetId: string; reason: string; recordedAt: string }>
  spanStart: string | null
  spanEnd: string | null
}

export type ReconstructReport = {
  schemaVersion: 1
  generatedAt: string
  tasks: ReconstructedTask[]
  summary: { measured: number; inferred: number; declared: number; synthetic: number; noHistory: number }
}

/**
 * Reconstruct the approved history view: per task, the tier derived from
 * ACTIVE evidence only, after corrections. measured > inferred > declared
 * (task dates) > synthetic (done without any evidence -- the roadmap renders
 * an honest synthetic position) > no-history. Invalidated receipts and
 * evidence are listed so the audit trail stays visible; they never set the
 * tier.
 */
export function historyReconstructCommand(handle: StoreHandle, options: { json?: boolean; taskFilter?: string }): void {
  const wanted = options.taskFilter ? new Set(options.taskFilter.split(",").map(part => part.trim()).filter(Boolean)) : undefined
  const tasks = listTasks(handle.db).filter(task => !wanted || wanted.has(task.taskId))
  const corrections = listHistoryCorrections(handle.db)
  const correctionsByTask = new Map<string, typeof corrections>()
  for (const correction of corrections) {
    const list = correctionsByTask.get(correction.taskId) ?? []
    list.push(correction)
    correctionsByTask.set(correction.taskId, list)
  }
  const tasksOut: ReconstructedTask[] = tasks.map(task => {
    const evidence = listHistoryEvidence(handle.db, task.taskId)
    const active = evidence.filter(row => row.status === "active")
    const measured = active.filter(row => row.tier === "measured" && row.spanStart && row.spanEnd)
    const taskCorrections = correctionsByTask.get(task.taskId) ?? []
    const invalidatedReceipts = taskCorrections
      .filter(correction => correction.targetKind === "receipt")
      .map(correction => ({ targetId: correction.targetId, reason: correction.reason, recordedAt: correction.recordedAt }))
    const tier: ReconstructedTask["tier"] = measured.length > 0
      ? "measured"
      : active.length > 0
        ? "inferred"
        : task.startDate || task.dueDate
          ? "declared"
          : task.planningState === "done"
            ? "synthetic"
            : "no-history"
    const spans = measured.map(row => ({ start: Date.parse(row.spanStart!), end: Date.parse(row.spanEnd!) }))
    return {
      taskId: task.taskId,
      planningState: task.planningState,
      tier,
      evidence: evidence.map(row => ({
        evidenceId: row.evidenceId,
        harness: row.harness,
        sessionId: row.sessionId,
        tier: row.tier,
        confidence: row.confidence,
        status: row.status,
        spanStart: row.spanStart,
        spanEnd: row.spanEnd
      })),
      activeEvidence: active.length,
      invalidatedEvidence: evidence.length - active.length,
      invalidatedReceipts,
      spanStart: spans.length > 0 ? new Date(Math.min(...spans.map(span => span.start))).toISOString() : null,
      spanEnd: spans.length > 0 ? new Date(Math.max(...spans.map(span => span.end))).toISOString() : null
    }
  })
  const report: ReconstructReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tasks: tasksOut,
    summary: {
      measured: tasksOut.filter(task => task.tier === "measured").length,
      inferred: tasksOut.filter(task => task.tier === "inferred").length,
      declared: tasksOut.filter(task => task.tier === "declared").length,
      synthetic: tasksOut.filter(task => task.tier === "synthetic").length,
      noHistory: tasksOut.filter(task => task.tier === "no-history").length
    }
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  console.log(`history reconstruct: ${report.summary.measured} measured / ${report.summary.inferred} inferred / ${report.summary.declared} declared / ${report.summary.synthetic} synthetic / ${report.summary.noHistory} no-history`)
  for (const task of tasksOut.filter(entry => entry.activeEvidence > 0 || entry.invalidatedEvidence > 0 || entry.invalidatedReceipts.length > 0)) {
    const sessions = task.evidence.map(row => `${row.harness}:${row.sessionId.slice(0, 8)}${row.status === "invalid" ? " (invalid)" : ""}`).join(", ")
    console.log(`- ${task.taskId}: ${task.tier} (${task.planningState}) active=${task.activeEvidence} invalid=${task.invalidatedEvidence} sessions=[${sessions}]`)
    for (const receipt of task.invalidatedReceipts) {
      console.log(`    corrected receipt ${receipt.targetId}: ${receipt.reason}`)
    }
  }
}

export function resolveTasksRoot(): string {
  const toml = resolveMapctxToml(process.cwd())
  return toml?.dir ?? process.cwd()
}
