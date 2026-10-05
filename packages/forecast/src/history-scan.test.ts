import assert from "node:assert/strict"
import test from "node:test"
import { runReceiptSchema, timeEvidenceSchema } from "@mapctx/protocol"
import {
  activeMsOf,
  buildEvidenceFromTimestamps,
  buildHistoryReceipt,
  buildReport,
  extractCommandWorkdir,
  gradeSessionSignals,
  historyKey,
  isSpecificPath,
  parseClaudeSession,
  parseCodexSession,
  parseOpencodeSession,
  type RawSession,
  type TaskMeta
} from "./history-scan"
import { extractClaudeIntervals } from "./claude-intervals"
import { buildEstimateSnapshot, workloadBaselines } from "./estimate"

const T0 = Date.parse("2026-04-01T10:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()
const MIN = 60_000

const TASKS: TaskMeta[] = [
  { taskId: "T-101", filesAffected: ["packages/forecast/src/history-scan.ts"] },
  { taskId: "T-102", filesAffected: ["packages/vscode-extension/src/html/workspaceV2.js"] }
]
const byId = new Map(TASKS.map(task => [task.taskId, task]))

function codexLine(timestamp: string, ordinal: number, type: string, payload: unknown): string {
  return JSON.stringify({ timestamp, ordinal, type, payload })
}

function codexSession(opts: { sessionId: string; userTexts: string[]; calls?: string[]; patches?: string[]; start?: number }): string {
  const start = opts.start ?? T0
  const lines = [
    codexLine(iso(start), 0, "session_meta", {
      session_id: opts.sessionId,
      cwd: "/Users/alt/repos/mapctx",
      git: { branch: "mapctx-t101-history" }
    })
  ]
  let ordinal = 1
  let at = start
  for (const text of opts.userTexts) {
    lines.push(codexLine(iso(at), ordinal++, "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }]
    }))
    at += 5 * MIN
  }
  for (const cmd of opts.calls ?? []) {
    lines.push(codexLine(iso(at), ordinal++, "response_item", {
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd })
    }))
    at += 5 * MIN
  }
  for (const input of opts.patches ?? []) {
    lines.push(codexLine(iso(at), ordinal++, "response_item", {
      type: "custom_tool_call",
      status: "completed",
      name: "apply_patch",
      input
    }))
    at += 5 * MIN
  }
  return lines.join("\n")
}

test("codex: toolcall links, file-edit links, bare mention stays weak", () => {
  const jsonl = codexSession({
    sessionId: "codex-1",
    userTexts: ["Work on T-101 history scan SUPERSECRET_CANARY_7f3a"],
    calls: ["mapctx task claim T-101 --actor traycer", "npx tsc packages/forecast/src/history-scan.ts"],
    patches: ["*** Begin Patch\n*** Update File: packages/forecast/src/history-scan.ts\n+line"]
  })
  const session = parseCodexSession(jsonl, "codex-1.jsonl")
  assert.equal(session.sessionId, "codex-1")
  assert.ok(session.eventTimestamps.length >= 3)
  const grades = gradeSessionSignals(session, byId)
  assert.ok(grades.get("T-101")?.has("toolcall"))
  assert.ok(grades.get("T-101")?.has("file-edit"))
  assert.ok(!grades.has("T-102"))

  // Board-listing style session: every task named, nothing acted on.
  const listing = parseCodexSession(codexSession({
    sessionId: "codex-list",
    userTexts: ["T-101 T-102 status overview, no changes"]
  }), "list.jsonl")
  const listingGrades = gradeSessionSignals(listing, byId)
  assert.ok(listingGrades.get("T-101")?.has("weak"))
  assert.ok(!listingGrades.get("T-101")?.has("toolcall"))
  assert.ok(!listingGrades.get("T-101")?.has("file-edit"))
  const report = buildReport({ sessions: [session, listing], tasks: TASKS, generatedAt: iso(T0) })
  const t101 = report.tasks.find(task => task.taskId === "T-101")!
  assert.equal(t101.tier, "measured")
  assert.equal(t101.confidence, "high")
  assert.ok(t101.intervals.length > 0)
  const t102 = report.tasks.find(task => task.taskId === "T-102")!
  assert.equal(t102.tier, "no-history")
  assert.deepEqual(report.weakMentions.find(entry => entry.sessionId === "codex-list")?.taskIds.sort(), ["T-101", "T-102"])
  // Privacy: prompt content never leaves the adapter.
  assert.ok(!JSON.stringify(report).includes("SUPERSECRET_CANARY_7f3a"))
})

test("opencode rows: bash toolcall links; db opened read-only by caller", () => {
  const session = parseOpencodeSession({
    session: { id: "ses_op1", directory: "/Users/alt/repos/mapctx", title: "history work" },
    messages: [
      { timeCreated: T0, role: "user", text: "continue T-102 roadmap" },
      { timeCreated: T0 + 2 * MIN, timeCompleted: T0 + 4 * MIN, role: "assistant" }
    ],
    parts: [
      { timeCreated: T0 + MIN, tool: "bash", inputText: "mapctx dispatch create T-102 --executor traycer" },
      { timeCreated: T0 + 3 * MIN, tool: "edit", inputText: "packages/vscode-extension/src/html/workspaceV2.js", files: ["packages/vscode-extension/src/html/workspaceV2.js"] }
    ]
  }, "hash-op1")
  const report = buildReport({ sessions: [session], tasks: TASKS, generatedAt: iso(T0) })
  const t102 = report.tasks.find(task => task.taskId === "T-102")!
  assert.equal(t102.tier, "measured")
  assert.equal(t102.evidenceSource, "opencode-db")
  assert.ok(t102.attributedActiveMs > 0)
})

test("claude: signal scan reuses T-100 interval extractor, never reimplements it", () => {
  const at = (minute: number) => iso(T0 + minute * MIN)
  const row = (sessionId: string, uuid: string, timestamp: string, type: string, content: unknown, stop?: string) =>
    JSON.stringify({ sessionId, uuid, timestamp, type, message: { content, stop_reason: stop } })
  const jsonl = [
    row("s9", "a", at(0), "user", "mapctx task claim T-101"),
    row("s9", "b", at(2), "assistant", [{ type: "text", text: "working" }]),
    row("s9", "c", at(5), "assistant", [], "end_turn")
  ].join("\n")
  const session = parseClaudeSession(jsonl)
  assert.equal(session.sessionId, "s9")
  assert.ok(gradeSessionSignals(session, byId).get("T-101")?.has("toolcall"))
  const evidence = extractClaudeIntervals(jsonl)
  assert.ok(evidence.intervals.length > 0)
  const report = buildReport({
    sessions: [session],
    tasks: TASKS,
    claudeJsonlBySession: new Map([["s9", jsonl]]),
    generatedAt: iso(T0)
  })
  const t101 = report.tasks.find(task => task.taskId === "T-101")!
  assert.equal(t101.tier, "measured")
  assert.equal(t101.evidenceSource, "claude-jsonl")
})

test("multi-task session splits: primary measured, secondary inferred, ambiguous listed", () => {
  const jsonl = codexSession({
    sessionId: "codex-multi",
    userTexts: ["T-101 and T-102 both need work"],
    calls: ["mapctx task claim T-101 --actor traycer", "mapctx task claim T-102 --actor traycer"]
  })
  const session = parseCodexSession(jsonl, "multi.jsonl")
  const report = buildReport({ sessions: [session], tasks: TASKS, generatedAt: iso(T0) })
  assert.equal(report.ambiguousSessions.length, 1)
  assert.deepEqual(report.ambiguousSessions[0].taskIds.sort(), ["T-101", "T-102"])
  const [first, second] = report.tasks.filter(task => task.links.length > 0)
    .sort((a, b) => b.attributedActiveMs - a.attributedActiveMs)
  assert.equal(first.tier, "measured")
  assert.ok(first.intervals.length > 0)
  assert.equal(second.tier, "inferred")
  assert.equal(second.intervals.length, 0)
  // Contested primaries taint the primary task; secondaries stay clean scraps.
  assert.equal(first.ambiguous, true)
  assert.equal(second.ambiguous, false)
  assert.ok(report.ambiguousSessions.some(entry => entry.sessionId === "codex-multi"))
})

test("reversed and degenerate spans rejected, never fabricated", () => {
  assert.throws(() => buildEvidenceFromTimestamps("codex", "s", [T0]), /no positive span/)
  assert.throws(() => buildEvidenceFromTimestamps("codex", "s", [T0, T0]), /no positive span/)
  // Unsorted input normalizes to the same evidence (deterministic).
  const sorted = buildEvidenceFromTimestamps("codex", "s", [T0, T0 + 2 * MIN, T0 + 4 * MIN])
  const shuffled = buildEvidenceFromTimestamps("codex", "s", [T0 + 4 * MIN, T0, T0 + 2 * MIN])
  assert.deepEqual(shuffled, sorted)
  assert.equal(activeMsOf(sorted.intervals), 4 * MIN)
  // T-100 validators reject reversed/invalid spans at the schema gate.
  const bad = timeEvidenceSchema.safeParse({
    schemaVersion: 1,
    source: "codex-jsonl",
    policy: { idleThresholdMs: 600_000, reviewThresholdMs: 900_000, parkedThresholdMs: 7_200_000, timeZone: "UTC" },
    intervals: [{ start: iso(T0 + MIN), end: iso(T0), owner: "agent", kind: "active", sessionId: "s" }],
    sessionSpans: [{ start: iso(T0), end: iso(T0 + MIN), sessionId: "s" }]
  })
  assert.equal(bad.success, false)
})

test("receipt build validates, scans are idempotent, privacy holds", () => {
  const session = parseCodexSession(codexSession({
    sessionId: "codex-r",
    userTexts: ["mapctx dispatch create T-101"],
    calls: ["mapctx task claim T-101 --actor traycer"]
  }), "r.jsonl")
  const first = buildReport({ sessions: [session], tasks: TASKS, generatedAt: iso(T0) })
  const second = buildReport({ sessions: [session], tasks: TASKS, generatedAt: iso(T0) })
  const history = first.tasks.find(task => task.taskId === "T-101")!
  assert.equal(historyKey(history), historyKey(second.tasks.find(task => task.taskId === "T-101")!))
  const dispatchId = "5431e08a-78fe-4972-81a4-82d9c23c441f"
  const one = buildHistoryReceipt(history, dispatchId, 1)
  const two = buildHistoryReceipt(second.tasks.find(task => task.taskId === "T-101")!, dispatchId, 1)
  assert.deepEqual(one, two)
  const parsed = runReceiptSchema.parse(one)
  assert.equal(parsed.historySource, "codex")
  assert.equal(parsed.historyTier, "measured")
  assert.ok(parsed.timeEvidence && parsed.timeEvidence.intervals.length > 0)
  assert.ok(Date.parse(parsed.startedAt) < Date.parse(parsed.endedAt))
  for (const item of parsed.evidence) {
    assert.match(item.uri, /^history:\/\/(codex|opencode|claude-code)\/session\//)
  }
  assert.ok(!JSON.stringify(one).includes("dispatch create T-101"))
  assert.throws(() => buildHistoryReceipt(second.tasks.find(task => task.taskId === "T-102")!, dispatchId, 1), /no time bounds/)
})

test("inferred and declared tiers never enter calibration", () => {
  const measured = {
    duration: { sessionWallClockMs: 100, activeTimeMs: 100, humanTimeMs: 0, parkedTimeMs: 0, taskDurationMs: 100, leadTimeMs: 100, idleThresholdMs: 600_000, activeTimeCoverage: "measured" as const },
    workload: "Hard" as const
  }
  const inferred = {
    ...measured,
    historyTier: "inferred" as const,
    duration: { ...measured.duration }
  }
  assert.deepEqual(workloadBaselines([measured, inferred]), [{
    workload: "Hard",
    sampleCount: 1,
    durationP50Ms: 100,
    durationP90Ms: 100
  }])
  const snapshot = buildEstimateSnapshot("T-101", [inferred], {
    workload: "Hard",
    estimateId: "f2345678-90ab-4cde-8f01-23456789abcd",
    createdAt: iso(T0)
  })
  assert.equal(snapshot.method, "expert-guess")
})

test("generic filesAffected entries never link (specificity floor)", () => {
  assert.equal(isSpecificPath("packages/opencode-plugin/"), true)
  assert.equal(isSpecificPath("skills/mapctx-ralph-tasks/references/"), true)
  for (const generic of ["docs/", "tasks", "TASKS.md", "packages/", "scripts/", "tests/", "mapctx.toml"]) {
    assert.equal(isSpecificPath(generic), false)
  }
  const generic: RawSession = {
    harness: "codex",
    sessionId: "generic",
    eventTimestamps: [T0, T0 + 2 * MIN],
    signalTexts: [{ text: "read TASKS.md about T-900 and docs/guide in scripts/run for context" }],
    writeTexts: [{ text: "read TASKS.md about T-900 and docs/guide in scripts/run for context" }],
    sourceHash: "h"
  }
  const metas = new Map<string, TaskMeta>([["T-900", {
    taskId: "T-900",
    filesAffected: ["TASKS.md", "docs/", "scripts/"]
  }]])
  assert.deepEqual([...gradeSessionSignals(generic, metas).get("T-900") ?? []], ["weak"])
})

test("git commits link inferred; multi-task commits go to manual review", () => {
  const session: RawSession = {
    harness: "codex",
    sessionId: "empty",
    eventTimestamps: [],
    signalTexts: [],
    writeTexts: [],
    sourceHash: "h"
  }
  const report = buildReport({
    sessions: [session],
    tasks: TASKS,
    commits: [
      { hash: "aaa", date: iso(T0), subject: "feat: T-101 history scan adapter" },
      { hash: "bbb", date: iso(T0), subject: "fix: T-101 and T-102 shared helper" }
    ],
    generatedAt: iso(T0)
  })
  const t101 = report.tasks.find(task => task.taskId === "T-101")!
  assert.equal(t101.tier, "inferred")
  assert.deepEqual(t101.commitHashes, ["aaa"])
  assert.equal(t101.confidence, "low")
})

// ---- T-116 project/worktree scoping ----

const SCOPE_A = { repoRoot: "/repos/a", repoOrigin: "/repos/a" }

function sessionWithIdentity(overrides: Partial<RawSession> & { sessionId: string }): RawSession {
  return {
    harness: "codex",
    eventTimestamps: [T0, T0 + 5 * MIN],
    signalTexts: [{ text: "mapctx task claim T-101" }],
    writeTexts: [],
    sourceHash: "f".repeat(16),
    cwdVerified: true,
    repoRoot: SCOPE_A.repoRoot,
    repoOrigin: SCOPE_A.repoOrigin,
    ...overrides
  }
}

test("T-116 scope: identical task IDs in another repository never link", () => {
  const foreign = sessionWithIdentity({
    sessionId: "codex-foreign",
    cwd: "/repos/other-project",
    repoRoot: "/repos/other-project",
    repoOrigin: "/repos/other-project",
    signalTexts: [{ text: "mapctx task claim T-101 SUPERSECRET_CANARY_SCOPE_2m8z" }],
    eventTimestamps: [T0 - 30 * 24 * 60 * MIN, T0 - 30 * 24 * 60 * MIN + 10 * MIN]
  })
  const report = buildReport({
    sessions: [foreign],
    tasks: TASKS,
    scope: SCOPE_A
  })
  // The textual task-ID match exists but is invisible: the session belongs to
  // another repository, so nothing links, nothing measures.
  assert.equal(report.scope.outOfScopeSessions, 1)
  assert.deepEqual(report.scope.outOfScope.map(entry => entry.sessionId), ["codex-foreign"])
  assert.equal(report.scope.includedSessions, 0)
  const t101 = report.tasks.find(task => task.taskId === "T-101")!
  assert.equal(t101.links.length, 0)
  assert.equal(t101.tier, "no-history")
  assert.equal(t101.attributedActiveMs, 0)
  assert.ok(!JSON.stringify(report).includes("SUPERSECRET_CANARY_SCOPE_2m8z"))
})

test("T-116 scope: linked worktrees of the same repository stay in scope", () => {
  const worktreeSession = sessionWithIdentity({
    sessionId: "codex-worktree",
    cwd: "/repos/a-worktrees/w1",
    repoRoot: "/repos/a-worktrees/w1",
    repoOrigin: SCOPE_A.repoOrigin
  })
  const report = buildReport({ sessions: [worktreeSession], tasks: TASKS, scope: SCOPE_A })
  assert.equal(report.scope.includedSessions, 1)
  assert.equal(report.scope.outOfScopeSessions, 0)
  const t101 = report.tasks.find(task => task.taskId === "T-101")!
  assert.equal(t101.links.length, 1)
  assert.equal(t101.tier, "measured")
})

test("T-116 scope: unverifiable cwd is listed, never linked or measured", () => {
  const noCwd = sessionWithIdentity({ sessionId: "codex-nocwd", cwd: undefined, cwdVerified: false, repoRoot: null, repoOrigin: null })
  const staleCwd = sessionWithIdentity({ sessionId: "codex-stale", cwd: "/deleted/path", cwdVerified: false, repoRoot: null, repoOrigin: null })
  const report = buildReport({ sessions: [noCwd, staleCwd], tasks: TASKS, scope: SCOPE_A })
  assert.equal(report.scope.unverifiableSessions, 2)
  assert.deepEqual(report.scope.unverifiable.map(entry => entry.sessionId).sort(), ["codex-nocwd", "codex-stale"])
  const t101 = report.tasks.find(task => task.taskId === "T-101")!
  assert.equal(t101.links.length, 0)
  assert.equal(t101.tier, "no-history")
})

test("T-116: without a scope the report keeps the unscoped behavior", () => {
  const session = sessionWithIdentity({ sessionId: "codex-anywhere", cwd: "/anywhere" })
  const report = buildReport({ sessions: [session], tasks: TASKS })
  assert.equal(report.scope.includedSessions, 1)
  assert.equal(report.scope.outOfScopeSessions, 0)
  assert.equal(report.scope.unverifiableSessions, 0)
  const t101 = report.tasks.find(task => task.taskId === "T-101")!
  assert.equal(t101.links.length, 1)
})

// ---- T-116 review attempt 2, finding 1: command-level provenance ----

test("review2 finding1: foreign per-command workdir overrides never link, even in a MapCtx session", () => {
  // The audited T-106 shape: session_meta cwd is MapCtx, tools run with an
  // explicit workdir in another repository. Session-level scoping alone
  // cannot catch this; each command's effective provenance must.
  const session: RawSession = {
    harness: "codex",
    sessionId: "codex-a617-repro",
    sourceHash: "a1",
    eventTimestamps: [T0, T0 + 5 * MIN, T0 + 10 * MIN],
    cwd: "/Users/alt/repos/mapctx",
    cwdVerified: true,
    repoRoot: SCOPE_A.repoRoot,
    repoOrigin: SCOPE_A.repoOrigin,
    signalTexts: [
      { text: "exec_command: {\"cmd\":\"mapctx task claim T-101\",\"workdir\":\"/repos/other-project\"}", workdir: "/repos/other-project", scope: "out-of-scope" },
      { text: "apply_patch: *** Update File: packages/forecast/src/history-scan.ts", workdir: null }
    ],
    writeTexts: [
      { text: "apply_patch: *** Update File: packages/forecast/src/history-scan.ts", workdir: null }
    ]
  }
  const report = buildReport({ sessions: [session], tasks: TASKS, scope: SCOPE_A })
  const t101 = report.tasks.find(task => task.taskId === "T-101")!
  // The foreign command names T-101 as a toolcall, but its provenance is
  // another repository: it must not grade a link. The remaining in-scope
  // file-edit keeps the session linked, but the span is degraded to
  // inferred: foreign commands ran inside this session's wall clock, so the
  // time cannot honestly count as measured MapCtx work.
  assert.equal(t101.links.length, 1)
  assert.equal(t101.links[0].signals.includes("toolcall"), false)
  assert.equal(t101.tier, "inferred")
  assert.equal(t101.attributedActiveMs, 0)
  // The exclusion is surfaced for review, content-free.
  assert.equal(report.scope.commandOverrides.foreign, 1)
  assert.ok(report.scope.commandOverrides.degradedMeasuredSessions.includes("codex-a617-repro"))
})

test("review2 finding1: all-foreign commands leave the session unlinked and unmeasured", () => {
  const session: RawSession = {
    harness: "codex",
    sessionId: "codex-all-foreign",
    sourceHash: "a2",
    eventTimestamps: [T0, T0 + 5 * MIN],
    cwd: "/Users/alt/repos/mapctx",
    cwdVerified: true,
    repoRoot: SCOPE_A.repoRoot,
    repoOrigin: SCOPE_A.repoOrigin,
    signalTexts: [
      { text: "exec_command: {\"cmd\":\"mapctx task claim T-101\"}", workdir: "/repos/other-project", scope: "out-of-scope" },
      { text: "exec_command: {\"cmd\":\"apply_patch tasks/T-101.md\"}", workdir: "/deleted/path", scope: "unverifiable" }
    ],
    writeTexts: []
  }
  const report = buildReport({ sessions: [session], tasks: TASKS, scope: SCOPE_A })
  const t101 = report.tasks.find(task => task.taskId === "T-101")!
  assert.equal(t101.links.length, 0)
  assert.equal(t101.tier, "no-history")
  assert.equal(t101.attributedActiveMs, 0)
})

test("review2 finding1: any foreign command degrades measured time even when in-scope signals link", () => {
  const session: RawSession = {
    harness: "codex",
    sessionId: "codex-mixed",
    sourceHash: "a3",
    eventTimestamps: [T0, T0 + 5 * MIN, T0 + 10 * MIN],
    cwd: "/Users/alt/repos/mapctx",
    cwdVerified: true,
    repoRoot: SCOPE_A.repoRoot,
    repoOrigin: SCOPE_A.repoOrigin,
    signalTexts: [
      { text: "exec_command: {\"cmd\":\"mapctx task claim T-101\"}", workdir: "/repos/other-project", scope: "out-of-scope" },
      { text: "apply_patch: *** Update File: packages/forecast/src/history-scan.ts", workdir: null }
    ],
    writeTexts: [
      { text: "apply_patch: *** Update File: packages/forecast/src/history-scan.ts", workdir: null }
    ]
  }
  const report = buildReport({ sessions: [session], tasks: TASKS, scope: SCOPE_A })
  const t101 = report.tasks.find(task => task.taskId === "T-101")!
  // Link survives on the genuine in-scope signal, but the span is no longer
  // trusted as measured active time for this repository.
  assert.equal(t101.links.length, 1)
  assert.equal(t101.tier, "inferred")
  assert.equal(t101.attributedActiveMs, 0)
})

test("review2 finding1: in-scope worktree workdir override still links and measures", () => {
  const session: RawSession = {
    harness: "codex",
    sessionId: "codex-worktree-override",
    sourceHash: "a4",
    eventTimestamps: [T0, T0 + 5 * MIN],
    cwd: SCOPE_A.repoRoot!,
    cwdVerified: true,
    repoRoot: SCOPE_A.repoRoot,
    repoOrigin: SCOPE_A.repoOrigin,
    signalTexts: [
      { text: "exec_command: {\"cmd\":\"mapctx task claim T-101\"}", workdir: "/repos/a-worktrees/w1", scope: "in-scope" }
    ],
    writeTexts: []
  }
  const report = buildReport({ sessions: [session], tasks: TASKS, scope: SCOPE_A })
  const t101 = report.tasks.find(task => task.taskId === "T-101")!
  assert.equal(t101.links.length, 1)
  assert.equal(t101.tier, "measured")
})

test("review2 finding1: codex exec JS-source input carries workdir/cd provenance (a617 shape)", () => {
  const foreign = '/Users/alt/repos/inlift/audit_financeiro'
  const js = (call: string) => `const r = await tools.exec_command(${call}); text(r)`
  // quoted-key and bare-key object literals inside JS source, not JSON
  assert.equal(extractCommandWorkdir(js(`{"cmd":"git status","workdir":"${foreign}"}`)), foreign)
  assert.equal(extractCommandWorkdir(js(`{cmd:'git status', workdir:'${foreign}'}`)), foreign)
  assert.equal(extractCommandWorkdir(js(`{cmd:"cd ${foreign} && git status"}`)), foreign)
  // relative / variable overrides are unverifiable
  assert.equal(extractCommandWorkdir(js(`{cmd:"ls", workdir:"sub"}`)), ".")
  // disagreeing workdirs in one entry cannot be attributed safely
  assert.equal(extractCommandWorkdir(js(`{cmd:"a", workdir:"/a/b"}); await tools.exec_command({cmd:"b", workdir:"/c/d"}`)), ".")
  // no override: stays undefined; a plain cwd() call is not an override
  assert.equal(extractCommandWorkdir(js(`{cmd:"node -e 'process.cwd()'"}`)), undefined)
})
