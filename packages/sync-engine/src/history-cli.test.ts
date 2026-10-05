import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import {
  buildApprovalTemplate,
  commitApprovedEvidence,
  evidenceIdFor,
  collectHistoryScan,
  historyCorrectCommand,
  historyReconstructCommand,
  historyScanCommand,
  loadApprovals,
  refreshHistoryDateCache,
  resolveRepoIdentity,
  type HistoryApprovalFile
} from "./history-cli.js"
import { workloadDeltaSamplesFromStore, isPriorFallbackEstimate, type TaskMeta } from "@mapctx/forecast"
import {
  claimTask,
  reviseAcceptance,
  approveAcceptanceCriterion,
  moveTask,
  getTask,
  listInvalidatedReceiptKeys,
  listReceiptsForTask,
  listRunReceipts,
  listHistoryEvidence,
  listHistoryCorrections,
  recordDispatchAttempt,
  recordHistoryEvidence,
  recordRunReceipt,
  repairStore,
  resolveProjectStoreDir,
  StoreHandle
} from "@mapctx/store"
import { buildGanttDataset } from "./gantt.js"

const FOREIGN_DISPATCH = "33333333-3333-4333-8333-333333333333"
const GENUINE_DISPATCH = "44444444-4444-4444-8444-444444444444"

/**
 * T-116 repro fixtures: repoA is the scanned MapCtx-like repository; repoB is
 * an unrelated project whose sessions carry coincidentally identical T-* IDs
 * (the T-106/T-107/T-108 audit defect). A git worktree of repoA proves
 * main/worktree linkage, and a stale cwd proves the unverifiable bucket.
 */
function fixtureRepos(): { root: string; repoA: string; repoB: string; worktree: string; codexDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-scope-"))
  const repoA = path.join(root, "repo-a")
  const repoB = path.join(root, "repo-b")
  const codexDir = path.join(root, "codex")
  fs.mkdirSync(repoA, { recursive: true })
  fs.mkdirSync(repoB, { recursive: true })
  fs.mkdirSync(codexDir, { recursive: true })
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] })
  git(repoA, ["init", "-q"])
  fs.writeFileSync(path.join(repoA, "file.txt"), "a\n")
  git(repoA, ["add", "."])
  git(repoA, ["commit", "-q", "-m", "init"])
  git(repoB, ["init", "-q"])
  fs.writeFileSync(path.join(repoB, "file.txt"), "b\n")
  git(repoB, ["add", "."])
  git(repoB, ["commit", "-q", "-m", "init"])
  const worktree = path.join(root, "repo-a-worktrees", "w1")
  fs.mkdirSync(path.dirname(worktree), { recursive: true })
  git(repoA, ["worktree", "add", "-q", worktree])

  const at = (minute: number) => new Date(Date.parse("2026-09-13T13:00:00.000Z") + minute * 60_000).toISOString()
  // Foreign project session: same textual task IDs, dates BEFORE the board existed.
  fs.writeFileSync(path.join(codexDir, "foreign.jsonl"), [
    JSON.stringify({ timestamp: at(0), ordinal: 0, type: "session_meta", payload: { session_id: "codex-foreign", cwd: repoB, git: { branch: "main" } } }),
    JSON.stringify({ timestamp: at(2), ordinal: 1, type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "mapctx task claim T-201" }) } })
  ].join("\n"))
  // Genuine main-repo session: edits this board's own task file.
  fs.writeFileSync(path.join(codexDir, "genuine.jsonl"), [
    JSON.stringify({ timestamp: at(0), ordinal: 0, type: "session_meta", payload: { session_id: "codex-genuine", cwd: repoA, git: { branch: "main" } } }),
    JSON.stringify({ timestamp: at(1), ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "continue T-202" }] } }),
    JSON.stringify({ timestamp: at(4), ordinal: 2, type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: tasks/T-202.md\n+done" } }),
    JSON.stringify({ timestamp: at(8), ordinal: 3, type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: tasks/T-202.md\n+review" } })
  ].join("\n"))
  // Worktree session of the SAME repository: in scope via the common dir.
  fs.writeFileSync(path.join(codexDir, "worktree.jsonl"), [
    JSON.stringify({ timestamp: at(10), ordinal: 0, type: "session_meta", payload: { session_id: "codex-worktree", cwd: worktree, git: { branch: "w1" } } }),
    JSON.stringify({ timestamp: at(12), ordinal: 1, type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "mapctx task claim T-202" }) } }),
    JSON.stringify({ timestamp: at(16), ordinal: 2, type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "mapctx task move T-202 --status review" }) } })
  ].join("\n"))
  // Foreign repo-target args: session cwd is repoA, but commands operate on
  // repoB by absolute path (git -C, sed on foreign files) -- the audited
  // a617 shape. Nothing may link from these entries.
  fs.writeFileSync(path.join(codexDir, "foreign-args.jsonl"), [
    JSON.stringify({ timestamp: at(24), ordinal: 0, type: "session_meta", payload: { session_id: "codex-foreign-args", cwd: repoA, git: { branch: "main" } } }),
    JSON.stringify({ timestamp: at(26), ordinal: 1, type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "const r = await tools.exec_command({cmd:\"git -C " + repoB + " status; sed -n '1,20p' " + repoB + "/tasks/T-201.md\"})" } }),
    JSON.stringify({ timestamp: at(28), ordinal: 2, type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "const r = await tools.exec_command({cmd:\"git -C " + repoB + " log --oneline tasks/T-201.md && mapctx task move T-201 --status review\"})" } })
  ].join("\n"))
  // Unverifiable: cwd recorded but gone from disk.
  fs.writeFileSync(path.join(codexDir, "stale.jsonl"), [
    JSON.stringify({ timestamp: at(20), ordinal: 0, type: "session_meta", payload: { session_id: "codex-stale", cwd: path.join(root, "deleted-dir"), git: { branch: "x" } } }),
    JSON.stringify({ timestamp: at(22), ordinal: 1, type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "mapctx task claim T-201" }) } })
  ].join("\n"))
  return { root, repoA, repoB, worktree, codexDir }
}

function seedBoardTask(handle: StoreHandle, taskId: string, planningState: string, positionKey: number): void {
  fs.mkdirSync(path.join(handle.storeDir, "tasks"), { recursive: true })
  fs.writeFileSync(path.join(handle.storeDir, "tasks", `${taskId}.md`), `# ${taskId}\n\n## Acceptance\n- [x] Criterion one.\n`, "utf8")
  handle.appendEvent({
    eventType: "task.upserted",
    actor: "test",
    payload: {
      task: {
        taskId, positionKey, title: taskId, planningState, executionState: "unclaimed",
        workload: "Normal", detailPath: `./tasks/${taskId}.md`, tags: [], domains: [],
        externalLinks: [], assignees: []
      },
      detail: {
        taskId, role: "implementation", impact: "medium", estimatedEffort: "1d",
        prerequisites: [], blocking: [], filesAffected: [], testsRequired: [], summary: taskId
      }
    }
  })
  // Fixture's legacy Markdown [x] is not canonical after T-120. Seed an
  // explicit authored revision and approval so lifecycle tests exercise their
  // intended history behavior instead of depending on checkout fallback.
  const revised = reviseAcceptance(handle, { taskId, condition: "criteria", texts: ["Criterion one."], actor: "test", expectRevision: 0 })
  assert.ok(revised.ok)
  const approved = approveAcceptanceCriterion(handle, { taskId, index: 0, actor: "test", expectRevision: revised.revision })
  assert.ok(approved.ok)
}

function completeWithReceipt(handle: StoreHandle, taskId: string, dispatchId: string): void {
  const claim = claimTask(handle, { taskId, actor: "executor" })
  assert.ok(claim.ok)
  const dispatch = recordDispatchAttempt(handle, {
    dispatchId, taskId, executorKind: "agent", attempt: 1, contextHash: "hash", status: "claimed"
  }, "executor")
  assert.ok(dispatch.ok)
  const recorded = recordRunReceipt(handle, {
    schemaVersion: 1,
    dispatchId,
    attempt: 1,
    outcome: "completed",
    startedAt: "2026-09-13T13:00:00.000Z",
    endedAt: "2026-09-13T15:00:00.000Z",
    changedFiles: ["tasks/foreign.md"],
    usageEvents: [],
    evidence: [],
    failure: null
  }, "executor")
  assert.ok(recorded.ok)
}

type Fixture = {
  home: string
  handle: StoreHandle
  storeDir: string
  repos: ReturnType<typeof fixtureRepos>
}

function bootstrapStore(repos: ReturnType<typeof fixtureRepos>): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-home-history-"))
  process.env.MAPCTX_HOME = home
  const storeDir = resolveProjectStoreDir("hist-proj")
  const handle = StoreHandle.open(storeDir)
  handle.appendEvent({
    eventType: "project.initialized",
    actor: "test",
    payload: { projectId: "hist-proj", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "store" }
  })
  // T-201: done with the ORIGINAL foreign receipt (the audit's T-106 shape).
  seedBoardTask(handle, "T-201", "backlog", 0)
  completeWithReceipt(handle, "T-201", FOREIGN_DISPATCH)
  const done = moveTask(handle, { taskId: "T-201", to: "done", actor: "human" })
  assert.ok(done.ok, done.ok ? "" : done.reason)
  // T-202: plain backlog task for the genuine in-scope session.
  seedBoardTask(handle, "T-202", "backlog", 1)
  return { home, handle, storeDir, repos }
}

function teardown(fixture: Fixture): void {
  try { fixture.handle.close() } catch { /* already closed by the test */ }
  fs.rmSync(fixture.home, { recursive: true, force: true })
  fs.rmSync(fixture.repos.root, { recursive: true, force: true })
}

const TASKS: TaskMeta[] = [
  { taskId: "T-201", filesAffected: [] },
  { taskId: "T-202", filesAffected: [] }
]

/** v2 approval file for one task, pinned to the given scan report's sources. */
function approvalsFor(report: ReturnType<typeof collectHistoryScan>["report"], taskId: string): HistoryApprovalFile {
  const template = buildApprovalTemplate(report)
  const match = template.approvals.find(entry => entry.taskId === taskId)
  return {
    schemaVersion: 2,
    sourceScan: template.sourceScan,
    approvals: match ? [{ taskId, sessions: match.sessions, approvedBy: "test" }] : []
  }
}

function scanFixture(fixture: Fixture) {
  return collectHistoryScan({
    codexDir: fixture.repos.codexDir,
    opencodeDb: path.join(fixture.repos.root, "none.db"),
    claudeDir: path.join(fixture.repos.root, "no-claude"),
    repo: fixture.repos.repoA,
    tasks: TASKS,
    resolveIdentity: true
  }).report
}

test("scoped scan: foreign-project sessions never link; worktree + genuine do; stale cwd excluded", () => {
  const repos = fixtureRepos()
  const fixture = bootstrapStore(repos)
  try {
    const { report } = collectHistoryScan({
      codexDir: repos.codexDir,
      opencodeDb: path.join(repos.root, "none.db"),
      claudeDir: path.join(repos.root, "no-claude"),
      repo: repos.repoA,
      tasks: TASKS,
      resolveIdentity: true
    })
    assert.equal(report.scope.repoOrigin, resolveRepoIdentity(repos.repoA).repoOrigin)
    assert.equal(report.scope.outOfScopeSessions, 1, "foreign project session is excluded")
    assert.equal(report.scope.unverifiableSessions, 1, "stale cwd is unverifiable")
    assert.equal(report.scope.includedSessions, 3, "genuine main + worktree + foreign-args sessions included")
    const t201 = report.tasks.find(task => task.taskId === "T-201")!
    // The foreign toolcall for T-201 must NOT produce a link: matching ID
    // alone is not identity, and the foreign-args session's commands ran
    // against repoB by absolute path (review2 finding1, repo-target args).
    assert.equal(t201.links.length, 0)
    assert.ok(report.scope.commandOverrides.foreign >= 1, "foreign repo-target args counted")
    // Degradation applies to LINKED sessions only: foreign-args contributed
    // no link at all, so there is nothing to degrade.
    const t202 = report.tasks.find(task => task.taskId === "T-202")!
    const linkedSessions = t202.links.map(link => link.sessionId).sort()
    assert.deepEqual(linkedSessions, ["codex-genuine", "codex-worktree"])
    assert.equal(t202.tier, "measured")
  } finally {
    teardown(fixture)
  }
})

test("commit requires an approval file", () => {
  const repos = fixtureRepos()
  const fixture = bootstrapStore(repos)
  try {
    assert.throws(() => historyScanCommand(fixture.handle, repos.repoA, {
      commit: true,
      codexSessions: repos.codexDir,
      opencodeDb: path.join(repos.root, "none.db"),
      claudeDir: path.join(repos.root, "no-claude"),
      repo: repos.repoA,
      taskFilter: "T-202"
    }), /--approve/)
  } finally {
    teardown(fixture)
  }
})

test("approved evidence commit: done task history without lifecycle mutation, idempotent re-run", () => {
  const repos = fixtureRepos()
  const fixture = bootstrapStore(repos)
  try {
    const { handle } = fixture
    const { report } = collectHistoryScan({
      codexDir: repos.codexDir,
      opencodeDb: path.join(repos.root, "none.db"),
      claudeDir: path.join(repos.root, "no-claude"),
      repo: repos.repoA,
      tasks: TASKS,
      resolveIdentity: true
    })
    const before = getTask(handle.db, "T-201")!
    const receiptCountBefore = listRunReceipts(handle.db, undefined, "T-201").length

    const approvals = approvalsFor(report, "T-202")
    assert.equal(approvals.approvals[0].sessions.length, 2)
    assert.ok(approvals.approvals[0].sessions.every(session => /^[0-9a-f]{8,64}$/.test(session.sourceHash)))
    const results = commitApprovedEvidence(handle, report, approvals, "auditor")
    const recorded = results.filter(entry => entry.action === "recorded")
    assert.equal(recorded.length, 2, JSON.stringify(results))
    const evidence = listHistoryEvidence(handle.db, "T-202")
    assert.equal(evidence.length, 2)
    assert.ok(evidence.every(row => row.status === "active"))

    // Done task T-201 untouched by the T-202 evidence write.
    const after = getTask(handle.db, "T-201")!
    assert.equal(after.planningState, before.planningState)
    assert.equal(after.completedOn, before.completedOn)
    assert.equal(listRunReceipts(handle.db, undefined, "T-201").length, receiptCountBefore)

    // Idempotency: same approval file re-run records nothing new.
    const rerun = commitApprovedEvidence(handle, report, approvals, "auditor")
    assert.ok(rerun.every(entry => entry.action === "skipped"))
    assert.equal(listHistoryEvidence(handle.db, "T-202").length, 2)

    // Review2 finding 3: any unlinked/unknown entry aborts the WHOLE set.
    assert.throws(() => commitApprovedEvidence(handle, report, {
      schemaVersion: 2,
      sourceScan: approvals.sourceScan,
      approvals: [
        { taskId: "T-202", sessions: [{ harness: "codex", sessionId: "codex-foreign", sourceHash: approvals.approvals[0].sessions[0].sourceHash }] },
        { taskId: "T-999", sessions: [{ harness: "codex", sessionId: "codex-genuine", sourceHash: approvals.approvals[0].sessions[0].sourceHash }] }
      ]
    }, "auditor"), /nothing written/)
    assert.equal(listHistoryEvidence(handle.db, "T-202").length, 2, "no partial writes")
  } finally {
    teardown(fixture)
  }
})

test("correction: invalid receipt drops out of forecast + roadmap, original stays queryable", () => {
  const repos = fixtureRepos()
  const fixture = bootstrapStore(repos)
  try {
    const { handle, storeDir } = fixture
    // BEFORE: the foreign receipt counts as a workload-delta sample.
    const before = workloadDeltaSamplesFromStore(handle.db, "T-201")
    assert.equal(before.length, 1)

    const cachePath = path.join(storeDir, "history-dates.json")
    historyCorrectCommand(handle, "T-201", {
      target: `receipt:${FOREIGN_DISPATCH}/1`,
      reason: "audit 2026-10-04: primary session cwd belongs to another project",
      actor: "auditor",
      dateCachePath: cachePath
    })

    // Original receipt stays queryable, untouched.
    const receipts = listRunReceipts(handle.db, undefined, "T-201")
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].outcome, "completed")
    assert.deepEqual([...listInvalidatedReceiptKeys(handle.db)], [`${FOREIGN_DISPATCH}/1`])

    // AFTER: it never calibrates -- no samples, no accuracy contribution.
    const after = workloadDeltaSamplesFromStore(handle.db, "T-201")
    assert.equal(after.length, 0)

    // Roadmap path: the same filter the gantt command applies drops actuals.
    const invalidated = listInvalidatedReceiptKeys(handle.db)
    const validReceipts = receipts.filter(receipt => !invalidated.has(`${receipt.dispatchId}/${receipt.attempt}`))
    const dataset = buildGanttDataset({
      tasks: [{
        id: "T-201", title: "T-201", status: "done", type: null, parentId: null,
        start: null, due: null, domains: [], workload: "Normal", estimatedEffort: "1d",
        estimatedEffortSource: "agent-active", predictedStart: null, receipts: validReceipts
      }],
      dependencyEdges: [],
      mode: "store"
    })
    const entry = dataset.tasks[0]
    assert.equal(entry.actual, null)
    assert.equal(entry.history, null)

    // Done planning untouched by the correction.
    const task = getTask(handle.db, "T-201")!
    assert.equal(task.planningState, "done")
    assert.ok(task.completedOn)

    // Corrections are queryable with their reason.
    const corrections = listHistoryCorrections(handle.db, { targetKind: "receipt" })
    assert.equal(corrections.length, 1)
    assert.match(corrections[0].reason, /another project/)

    // Duplicate correction refused -- and refusals are FAILED commands
    // (nonzero), never silent successes.
    assert.throws(() => historyCorrectCommand(handle, "T-201", {
      target: `receipt:${FOREIGN_DISPATCH}/1`,
      reason: "duplicate attempt"
    }), /already-corrected/)
    assert.equal(listHistoryCorrections(handle.db).length, 1)
    void cachePath
  } finally {
    teardown(fixture)
  }
})

test("corrected evidence re-approval re-activates and the date cache follows validity", () => {
  const repos = fixtureRepos()
  const fixture = bootstrapStore(repos)
  try {
    const { handle, storeDir } = fixture
    const { report } = collectHistoryScan({
      codexDir: repos.codexDir,
      opencodeDb: path.join(repos.root, "none.db"),
      claudeDir: path.join(repos.root, "no-claude"),
      repo: repos.repoA,
      tasks: TASKS,
      resolveIdentity: true
    })
    const approvals = approvalsFor(report, "T-202")
    commitApprovedEvidence(handle, report, approvals, "auditor")
    const cachePath = path.join(storeDir, "history-dates.json")
    refreshHistoryDateCache(handle, cachePath)
    let cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { tasks: Array<{ taskId: string }> }
    assert.deepEqual(cache.tasks.map(entry => entry.taskId), ["T-202"])

    // Correct the evidence rows one by one: each leaves the cache, and with
    // both rows corrected the task drops out entirely.
    historyCorrectCommand(handle, "T-202", {
      target: "evidence:" + listHistoryEvidence(handle.db, "T-202")[0].evidenceId,
      reason: "wrong session",
      dateCachePath: cachePath
    })
    cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { tasks: Array<{ taskId: string }> }
    assert.equal(cache.tasks.length, listHistoryEvidence(handle.db, "T-202").filter(row => row.status === "active").length ? 1 : 0)
    historyCorrectCommand(handle, "T-202", {
      target: "evidence:" + listHistoryEvidence(handle.db, "T-202").find(row => row.status === "active")!.evidenceId,
      reason: "wrong session",
      dateCachePath: cachePath
    })
    cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { tasks: Array<{ taskId: string }> }
    assert.equal(cache.tasks.length, 0, "fully-corrected evidence never ghosts in the cache")

    // Re-approval after correction re-activates through a new journaled event.
    const rerun = commitApprovedEvidence(handle, report, approvals, "auditor")
    const reactivated = rerun.filter(entry => entry.action === "recorded")
    assert.equal(reactivated.length, 2)
    assert.ok(listHistoryEvidence(handle.db, "T-202").every(row => row.status === "active"))
    refreshHistoryDateCache(handle, cachePath)
    cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as { tasks: Array<{ taskId: string }> }
    assert.deepEqual(cache.tasks.map(entry => entry.taskId), ["T-202"])
  } finally {
    teardown(fixture)
  }
})

test("reconstruct tiers after corrections; repair replay reproduces evidence + corrections", () => {
  const repos = fixtureRepos()
  const fixture = bootstrapStore(repos)
  const { handle, storeDir } = fixture
  try {
    const { report } = collectHistoryScan({
      codexDir: repos.codexDir,
      opencodeDb: path.join(repos.root, "none.db"),
      claudeDir: path.join(repos.root, "no-claude"),
      repo: repos.repoA,
      tasks: TASKS,
      resolveIdentity: true
    })
    commitApprovedEvidence(handle, report, approvalsFor(report, "T-202"), "auditor")
    historyCorrectCommand(handle, "T-201", {
      target: `receipt:${FOREIGN_DISPATCH}/1`,
      reason: "foreign project"
    })

    const reconstruct = (fixtureHandle: StoreHandle) => {
      let payload = ""
      const originalWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = (chunk: string | Uint8Array) => { payload += String(chunk); return true }
      try {
        historyReconstructCommand(fixtureHandle, { json: true })
      } finally {
        process.stdout.write = originalWrite
      }
      return JSON.parse(payload) as {
        tasks: Array<{ taskId: string; tier: string; activeEvidence: number; invalidatedReceipts: unknown[] }>
        summary: Record<string, number>
      }
    }
    const before = reconstruct(handle)
    const t201 = before.tasks.find(entry => entry.taskId === "T-201")!
    const t202 = before.tasks.find(entry => entry.taskId === "T-202")!
    // T-201: done, its only receipt corrected, no approved evidence -> synthetic.
    assert.equal(t201.tier, "synthetic")
    assert.equal(t201.invalidatedReceipts.length, 1)
    assert.equal(t202.tier, "measured")
    assert.equal(t202.activeEvidence, 2)
    assert.equal(before.summary.synthetic + before.summary.measured, 2)

    // Journal replay from repair reproduces everything.
    handle.close()
    const repaired = repairStore(storeDir)
    assert.equal(repaired.status, "ok", JSON.stringify(repaired).slice(0, 200))
    const reopened = StoreHandle.open(storeDir)
    const after = reconstruct(reopened)
    assert.deepEqual(after.tasks, before.tasks)
    assert.deepEqual(after.summary, before.summary)
    reopened.close()
  } finally {
    teardown(fixture)
  }
})

test("approval file validation rejects malformed input", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-approve-"))
  try {
    const bad = path.join(dir, "bad.json")
    fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 1, approvals: [] }))
    assert.throws(() => loadApprovals(bad), /schemaVersion: 2/)
    const noSourceScan = path.join(dir, "no-sourcescan.json")
    fs.writeFileSync(noSourceScan, JSON.stringify({ schemaVersion: 2, approvals: [] }))
    assert.throws(() => loadApprovals(noSourceScan), /sourceScan/)
    const noSessions = path.join(dir, "no-sessions.json")
    fs.writeFileSync(noSessions, JSON.stringify({ schemaVersion: 2, sourceScan: { generatedAt: "2026-10-04T00:00:00.000Z", repoRoot: null, repoOrigin: null }, approvals: [{ taskId: "T-1", sessions: [] }] }))
    assert.throws(() => loadApprovals(noSessions), /no sessions/)
    const noPin = path.join(dir, "no-pin.json")
    fs.writeFileSync(noPin, JSON.stringify({
      schemaVersion: 2,
      sourceScan: { generatedAt: "2026-10-04T00:00:00.000Z", repoRoot: null, repoOrigin: null },
      approvals: [{ taskId: "T-201", sessions: [{ harness: "codex", sessionId: "x" }] }]
    }))
    assert.throws(() => loadApprovals(noPin), /sourceHash pin/)
    const good = path.join(dir, "good.json")
    fs.writeFileSync(good, JSON.stringify({
      schemaVersion: 2,
      sourceScan: { generatedAt: "2026-10-04T00:00:00.000Z", repoRoot: null, repoOrigin: null },
      approvals: [{ taskId: "T-201", sessions: [{ harness: "codex", sessionId: "x", sourceHash: "abcdef1234567890" }] }]
    }))
    assert.equal(loadApprovals(good).approvals.length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- T-116 review attempt 2: findings 3, 4, 6 ----

test("review2 finding3: one stale entry aborts the whole approval set with zero writes", () => {
  const repos = fixtureRepos()
  const fixture = bootstrapStore(repos)
  try {
    const { handle } = fixture
    const report = scanFixture(fixture)
    const approvals = approvalsFor(report, "T-202")
    // One valid entry + one entry whose session is not linked: the commit
    // must refuse EVERYTHING, not write the valid half.
    const poisoned: HistoryApprovalFile = {
      schemaVersion: 2,
      sourceScan: approvals.sourceScan,
      approvals: [
        approvals.approvals[0],
        { taskId: "T-202", sessions: [{ harness: "codex", sessionId: "codex-foreign", sourceHash: "deadbeefdeadbeef" }] }
      ]
    }
    assert.throws(() => commitApprovedEvidence(handle, report, poisoned, "auditor"), /nothing written/)
    assert.equal(listHistoryEvidence(handle.db, "T-202").length, 0, "zero journal/evidence changes on refusal")
    assert.equal(listHistoryCorrections(handle.db).length, 0)
  } finally {
    teardown(fixture)
  }
})

test("review2 finding3: mid-transaction conflict rolls back the full set", () => {
  const repos = fixtureRepos()
  const fixture = bootstrapStore(repos)
  try {
    const { handle } = fixture
    const report = scanFixture(fixture)
    const approvals = approvalsFor(report, "T-202")
    const [first, second] = approvals.approvals[0].sessions
    // Pre-record the first session's evidence with DIFFERENT content (same
    // deterministic id): the set's first row conflicts mid-transaction.
    const seeded = recordHistoryEvidence(handle, {
      evidenceId: evidenceIdFor("T-202", first.harness, first.sessionId),
      taskId: "T-202", harness: first.harness, sessionId: first.sessionId,
      tier: "inferred", confidence: "low", repoRoot: null, repoOrigin: null,
      signals: ["weak"], spanStart: null, spanEnd: null, activeMs: null,
      sourceHash: first.sourceHash, recordedAt: "2026-10-04T05:00:00.000Z"
    }, "auditor")
    assert.ok(seeded.ok)
    const before = listHistoryEvidence(handle.db, "T-202").length
    assert.throws(() => commitApprovedEvidence(handle, report, approvals, "auditor"), /rollback/)
    const after = listHistoryEvidence(handle.db, "T-202")
    assert.equal(after.length, before, "the conflicting row is untouched")
    assert.equal(after.some(row => row.sessionId === second.sessionId), false, "the fresh row was rolled back")
  } finally {
    teardown(fixture)
  }
})

test("review2 finding4: approval pinned to the reviewed source refuses grown/changed sessions", () => {
  const repos = fixtureRepos()
  const fixture = bootstrapStore(repos)
  try {
    const { handle } = fixture
    const beforeScan = scanFixture(fixture)
    const template = buildApprovalTemplate(beforeScan)
    // The reviewed session's source grows AFTER the dry-run was approved.
    const genuinePath = path.join(repos.codexDir, "genuine.jsonl")
    fs.appendFileSync(genuinePath, (fs.readFileSync(genuinePath, "utf8").endsWith("\n") ? "" : "\n") +
      JSON.stringify({ timestamp: "2026-09-13T13:30:00.000Z", ordinal: 9, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "more work on T-202" }] } }) + "\n")
    const afterScan = scanFixture(fixture)
    const genuineLinkBefore = template.approvals.find(entry => entry.taskId === "T-202")!.sessions
      .find(session => session.sessionId === "codex-genuine")!
    const genuineLinkAfter = afterScan.tasks.find(task => task.taskId === "T-202")!.links
      .find(link => link.sessionId === "codex-genuine")!
    assert.notEqual(genuineLinkBefore.sourceHash, genuineLinkAfter.sourceHash, "the fixture source really changed")
    assert.throws(() => commitApprovedEvidence(handle, afterScan, template, "auditor"),
      /changed since the approved dry-run/)
    assert.equal(listHistoryEvidence(handle.db, "T-202").length, 0, "stale approval records nothing -- re-review required")
  } finally {
    teardown(fixture)
  }
})

test("review2 finding6: date cache aggregates all measured sessions per task and tags tiers", () => {
  const repos = fixtureRepos()
  const fixture = bootstrapStore(repos)
  try {
    const { handle, storeDir } = fixture
    const report = scanFixture(fixture)
    commitApprovedEvidence(handle, report, approvalsFor(report, "T-202"), "auditor")
    const cachePath = path.join(storeDir, "history-dates.json")
    refreshHistoryDateCache(handle, cachePath)
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      schemaVersion: number
      tasks: Array<{ taskId: string; startedAt: string; endedAt: string; activeMs: number | null; tier: string; source: string }>
    }
    assert.equal(cache.schemaVersion, 2)
    const rows = cache.tasks.filter(entry => entry.taskId === "T-202")
    assert.equal(rows.length, 1, "one aggregate row per task, never one per session")
    const row = rows[0]
    assert.equal(row.tier, "measured")
    // T-202 has two approved sessions (genuine + worktree). The aggregate
    // must span from the earliest start to the latest end.
    const links = report.tasks.find(task => task.taskId === "T-202")!.links
    const expectedStart = links.map(link => link.spanStart).sort()[0]
    const expectedEnd = links.map(link => link.spanEnd).sort()[links.length - 1]
    assert.equal(row.startedAt, expectedStart)
    assert.equal(row.endedAt, expectedEnd)
    assert.ok((row.activeMs ?? 0) > 0, "active time aggregated, not dropped")
  } finally {
    teardown(fixture)
  }
})

test("review2 finding6: roadmap displays inferred evidence distinctly via historySpan tier", () => {
  const repos = fixtureRepos()
  const fixture = bootstrapStore(repos)
  try {
    const { handle, storeDir } = fixture
    const report = scanFixture(fixture)
    commitApprovedEvidence(handle, report, approvalsFor(report, "T-202"), "auditor")
    // Correct one measured session away: the task must degrade to an
    // inferred aggregate in the cache, and the gantt dataset must carry the
    // tier explicitly.
    historyCorrectCommand(handle, "T-202", {
      target: "evidence:" + listHistoryEvidence(handle.db, "T-202")[0].evidenceId,
      reason: "review2 finding6 repro",
      dateCachePath: path.join(storeDir, "history-dates.json")
    })
    const remaining = listHistoryEvidence(handle.db, "T-202").filter(row => row.status === "active")
    assert.ok(remaining.length > 0)
    const cache = JSON.parse(fs.readFileSync(path.join(storeDir, "history-dates.json"), "utf8")) as {
      tasks: Array<{ taskId: string; tier: string }>
    }
    const row = cache.tasks.find(entry => entry.taskId === "T-202")!
    assert.equal(row.tier, remaining.every(item => item.tier === "inferred") ? "inferred" : "measured")
    const dataset = buildGanttDataset({
      tasks: [{
        id: "T-202", title: "T-202", status: "backlog", type: null, parentId: null,
        start: null, due: null, domains: [], workload: "Normal", estimatedEffort: "1d",
        estimatedEffortSource: "agent-active", predictedStart: null, receipts: []
      }],
      dependencyEdges: [],
      historyDates: JSON.parse(fs.readFileSync(path.join(storeDir, "history-dates.json"), "utf8")).tasks,
      mode: "store"
    })
    const span = dataset.tasks[0].historySpan!
    assert.ok(span.startedAt && span.endedAt)
    assert.equal(span.tier, row.tier)
    assert.notEqual(span.tier, undefined, "the tier rides the shipping dataset, not just reconstruct")
  } finally {
    teardown(fixture)
  }
})

// ---- Review attempt 3 repro fixtures ----

/**
 * Review attempt 3 fixture: the shared repos plus two in-scope sessions.
 * `codex-mixed` links T-202 with genuine MapCtx commands AND runs a foreign
 * `git -C repoB` command, so its measured time is degraded (the audited
 * a617/a612 shape). `codex-longpaths` buries a foreign repo target behind
 * eight non-repository absolute path operands (the truncation fail-open).
 */
function fixtureReposMixed(): ReturnType<typeof fixtureRepos> {
  const repos = fixtureRepos()
  const at = (minute: number) => new Date(Date.parse("2026-09-13T14:00:00.000Z") + minute * 60_000).toISOString()
  fs.writeFileSync(path.join(repos.codexDir, "mixed.jsonl"), [
    JSON.stringify({ timestamp: at(0), ordinal: 0, type: "session_meta", payload: { session_id: "codex-mixed", cwd: repos.repoA, git: { branch: "main" } } }),
    JSON.stringify({ timestamp: at(2), ordinal: 1, type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "mapctx task claim T-202" }) } }),
    JSON.stringify({ timestamp: at(5), ordinal: 2, type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: `git -C ${repos.repoB} status` }) } }),
    JSON.stringify({ timestamp: at(8), ordinal: 3, type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "mapctx task move T-202 --status review" }) } })
  ].join("\n"))
  // Eight EXISTING non-repository paths (the fixture scratch root), THEN the
  // foreign repo target carrying a T-201 mention: a capped scanner that
  // stops at eight marks this entry in-scope and links T-201 (fail-open).
  const scratch = repos.root
  const fillers = Array.from({ length: 8 }, (_, index) => path.join(scratch, `filler-${index}.txt`))
  for (const filler of fillers) fs.writeFileSync(filler, "x\n")
  const longCommand = `cat ${fillers.join(" ")} && git -C ${repos.repoB} log --oneline && mapctx task claim T-201`
  fs.writeFileSync(path.join(repos.codexDir, "longpaths.jsonl"), [
    JSON.stringify({ timestamp: at(20), ordinal: 0, type: "session_meta", payload: { session_id: "codex-longpaths", cwd: repos.repoA, git: { branch: "main" } } }),
    JSON.stringify({ timestamp: at(22), ordinal: 1, type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: longCommand }) } })
  ].join("\n"))
  return repos
}

function scanMixedFixture(fixture: Fixture) {
  return collectHistoryScan({
    codexDir: fixture.repos.codexDir,
    opencodeDb: path.join(fixture.repos.root, "none.db"),
    claudeDir: path.join(fixture.repos.root, "no-claude"),
    repo: fixture.repos.repoA,
    tasks: TASKS,
    resolveIdentity: true
  }).report
}

test("review3 finding1: degraded mixed session is inferred evidence, never measured, and template excludes it by default", () => {
  const repos = fixtureReposMixed()
  const fixture = bootstrapStore(repos)
  try {
    const { handle, storeDir } = fixture
    const report = scanMixedFixture(fixture)
    const t202 = report.tasks.find(task => task.taskId === "T-202")!
    assert.equal(t202.tier, "measured", "the clean sessions still measure the task")
    const mixed = t202.links.find(link => link.sessionId === "codex-mixed")
    assert.ok(mixed, "the mixed session is linked via its genuine MapCtx commands")
    assert.ok(report.scope.commandOverrides.degradedMeasuredSessions.includes("codex-mixed"), "its foreign command degrades measured time")
    assert.equal(t202.intervals.some(interval => interval.sessionId === "codex-mixed"), false, "degraded session contributes no intervals")

    // Default approval template EXCLUDES degraded candidates.
    const template = buildApprovalTemplate(report)
    const templateSessions = template.approvals.find(entry => entry.taskId === "T-202")!.sessions.map(session => session.sessionId).sort()
    assert.deepEqual(templateSessions, ["codex-genuine", "codex-worktree"], "degraded link is not an approval candidate by default")

    // With explicit inferred intent the template includes it, marked.
    const templateWithInferred = buildApprovalTemplate(report, { includeInferred: true })
    const withMixed = templateWithInferred.approvals.find(entry => entry.taskId === "T-202")!.sessions
    const mixedCandidate = withMixed.find(session => session.sessionId === "codex-mixed")!
    assert.equal(mixedCandidate.intendedTier, "inferred", "explicitly included degraded candidate carries inferred intent")

    // Approving the degraded link WITHOUT intent refuses the whole set.
    const mixedPin = { harness: mixed.harness, sessionId: mixed.sessionId, sourceHash: mixed.sourceHash }
    assert.throws(() => commitApprovedEvidence(handle, report, {
      schemaVersion: 2,
      sourceScan: template.sourceScan,
      approvals: [{ taskId: "T-202", sessions: [mixedPin], approvedBy: "test" }]
    }, "auditor"), /inferred intent/, "task-wide measured tier must not silently promote a degraded session")
    assert.equal(listHistoryEvidence(handle.db, "T-202").length, 0, "refusal writes nothing")

    // With intent: clean sessions measure, the mixed session stays inferred
    // with null active time, and the measured date cache keeps the clean
    // bounds -- the mixed window (14:00+) must not widen Sep 13 13:xx.
    const approvals = {
      schemaVersion: 2 as const,
      sourceScan: template.sourceScan,
      approvals: [{
        taskId: "T-202",
        sessions: [
          ...template.approvals.find(entry => entry.taskId === "T-202")!.sessions,
          { ...mixedPin, intendedTier: "inferred" as const }
        ],
        approvedBy: "test"
      }]
    }
    const results = commitApprovedEvidence(handle, report, approvals, "auditor")
    const evidence = listHistoryEvidence(handle.db, "T-202")
    assert.equal(evidence.length, 3, JSON.stringify(results))
    const mixedRow = evidence.find(row => row.sessionId === "codex-mixed")!
    assert.equal(mixedRow.tier, "inferred", "per-session eligibility, not task-wide tier")
    assert.equal(mixedRow.activeMs, null, "degraded evidence carries no measured active time")
    const cleanRows = evidence.filter(row => row.sessionId !== "codex-mixed")
    assert.ok(cleanRows.every(row => row.tier === "measured" && (row.activeMs ?? 0) > 0))

    const cachePath = path.join(storeDir, "history-dates.json")
    refreshHistoryDateCache(handle, cachePath)
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      tasks: Array<{ taskId: string; startedAt: string; endedAt: string; tier: string }>
    }
    const row = cache.tasks.find(entry => entry.taskId === "T-202")!
    assert.equal(row.tier, "measured")
    const cleanLinks = t202.links.filter(link => link.sessionId !== "codex-mixed")
    assert.equal(row.startedAt, cleanLinks.map(link => link.spanStart).sort()[0], "measured bounds start at the clean sessions")
    assert.equal(row.endedAt, cleanLinks.map(link => link.spanEnd).sort().reverse()[0], "mixed window never widens measured bounds")

    // Intent mismatch: declaring inferred on a measured-eligible link refuses.
    const genuinePin = template.approvals.find(entry => entry.taskId === "T-202")!.sessions[0]
    assert.throws(() => commitApprovedEvidence(handle, report, {
      schemaVersion: 2,
      sourceScan: template.sourceScan,
      approvals: [{ taskId: "T-202", sessions: [{ ...genuinePin, intendedTier: "inferred" as const }], approvedBy: "test" }]
    }, "auditor"), /intendedTier|inferred/, "measured-eligible link cannot be approved as inferred")
  } finally {
    teardown(fixture)
  }
})

test("review3 finding2: provenance path-cap truncation degrades to unverifiable, never fails open", () => {
  const repos = fixtureReposMixed()
  const fixture = bootstrapStore(repos)
  try {
    const report = scanMixedFixture(fixture)
    const t201 = report.tasks.find(task => task.taskId === "T-201")!
    const longpathsLink = t201.links.find(link => link.sessionId === "codex-longpaths")
    assert.equal(longpathsLink, undefined, "the buried foreign repo target and its T-201 text never link")
    assert.ok(report.scope.commandOverrides.unverifiable >= 1, "truncated provenance counts as unverifiable")
    // Degradation applies to LINKED sessions: the longpaths session produced
    // no link at all, so there is nothing to degrade -- it is simply never
    // measured or linked anywhere.
    const dirty = report.scope.commandOverrides.degradedMeasuredSessions
    assert.ok(!dirty.includes("codex-longpaths"), "unlinked session has nothing to degrade")
  } finally {
    teardown(fixture)
  }
})

test("review4: inferred-only history stays activeMs null through cache and Gantt; mixed aggregate stays measured-only", () => {
  const repos = fixtureReposMixed()
  const fixture = bootstrapStore(repos)
  try {
    const { handle, storeDir } = fixture
    const identity = resolveRepoIdentity(repos.repoA)
    const at = (minute: number) => new Date(Date.parse("2026-09-13T15:00:00.000Z") + minute * 60_000).toISOString()
    // Inferred-only task: exactly what an approved intendedTier commit
    // records -- bounded window, activeMs null (review attempt 3 finding 1).
    const seeded = recordHistoryEvidence(handle, {
      evidenceId: evidenceIdFor("T-201", "codex", "codex-inferred-only"),
      taskId: "T-201",
      harness: "codex",
      sessionId: "codex-inferred-only",
      tier: "inferred",
      confidence: "low",
      repoRoot: identity.repoRoot,
      repoOrigin: identity.repoOrigin,
      signals: ["toolcall"],
      spanStart: at(0),
      spanEnd: at(30),
      activeMs: null,
      sourceHash: "a".repeat(64),
      recordedAt: new Date().toISOString()
    }, "test")
    assert.ok(seeded.ok, JSON.stringify(seeded))

    const cachePath = path.join(storeDir, "history-dates.json")
    refreshHistoryDateCache(handle, cachePath)
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      tasks: Array<{ taskId: string; activeMs: number | null; tier: string }>
    }
    const inferredRow = cache.tasks.find(entry => entry.taskId === "T-201")!
    assert.equal(inferredRow.tier, "inferred")
    assert.equal(inferredRow.activeMs, null, "inferred-only cache must say unknown, not zero")

    const dataset = buildGanttDataset({
      tasks: [
        { id: "T-201", title: "T-201", status: "done", type: null, parentId: null, start: null, due: null, domains: [], workload: "Normal", estimatedEffort: "1d", estimatedEffortSource: "agent-active", predictedStart: null, receipts: [] },
        { id: "T-202", title: "T-202", status: "backlog", type: null, parentId: null, start: null, due: null, domains: [], workload: "Normal", estimatedEffort: "1d", estimatedEffortSource: "agent-active", predictedStart: null, receipts: [] }
      ],
      dependencyEdges: [],
      historyDates: JSON.parse(fs.readFileSync(cachePath, "utf8")).tasks,
      mode: "store"
    })
    assert.equal(dataset.tasks.find(task => task.id === "T-201")!.historySpan!.activeMs, null, "Gantt forwards the null, never a fabricated zero")

    // Mixed task: clean measured + degraded inferred (explicit intent). The
    // aggregate must stay numeric and count ONLY the measured contribution.
    const report = scanMixedFixture(fixture)
    const t202 = report.tasks.find(task => task.taskId === "T-202")!
    const template = buildApprovalTemplate(report)
    const mixed = t202.links.find(link => link.sessionId === "codex-mixed")!
    const results = commitApprovedEvidence(handle, report, {
      schemaVersion: 2,
      sourceScan: template.sourceScan,
      approvals: [{
        taskId: "T-202",
        sessions: [
          ...template.approvals.find(entry => entry.taskId === "T-202")!.sessions,
          { harness: mixed.harness, sessionId: mixed.sessionId, sourceHash: mixed.sourceHash, intendedTier: "inferred" as const }
        ],
        approvedBy: "test"
      }]
    }, "auditor")
    assert.ok(results.every(entry => entry.action === "recorded"), JSON.stringify(results))
    refreshHistoryDateCache(handle, cachePath)
    const refreshed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      tasks: Array<{ taskId: string; activeMs: number | null; tier: string }>
    }
    const mixedRow = refreshed.tasks.find(entry => entry.taskId === "T-202")!
    assert.equal(mixedRow.tier, "measured")
    const measuredOnly = listHistoryEvidence(handle.db, "T-202")
      .filter(row => row.status === "active" && row.tier === "measured")
      .reduce((sum, row) => sum + (row.activeMs ?? 0), 0)
    assert.ok(measuredOnly > 0)
    assert.equal(mixedRow.activeMs, measuredOnly, "inferred evidence is never summed into the numeric aggregate")
    const dataset2 = buildGanttDataset({
      tasks: [
        { id: "T-201", title: "T-201", status: "done", type: null, parentId: null, start: null, due: null, domains: [], workload: "Normal", estimatedEffort: "1d", estimatedEffortSource: "agent-active", predictedStart: null, receipts: [] },
        { id: "T-202", title: "T-202", status: "backlog", type: null, parentId: null, start: null, due: null, domains: [], workload: "Normal", estimatedEffort: "1d", estimatedEffortSource: "agent-active", predictedStart: null, receipts: [] }
      ],
      dependencyEdges: [],
      historyDates: JSON.parse(fs.readFileSync(cachePath, "utf8")).tasks,
      mode: "store"
    })
    assert.equal(dataset2.tasks.find(task => task.id === "T-202")!.historySpan!.activeMs, measuredOnly, "Gantt measured aggregate stays numeric")
  } finally {
    teardown(fixture)
  }
})

const E2E_BOARD = `# Tasks - history scan e2e

## Work Domains

- CORE: core engine work

## Tasks

### [T-202] Task for history scan e2e

  - id: T-202
  - status: backlog
  - type: task
  - parent: null
  - subIssueProgress: null
  - priority: null
  - workload: Normal
  - tags: []
  - domains: [CORE]
  - dependsOn: []
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-09-01
  - detail: ./tasks/T-202.md

## Notes
`

const E2E_DETAIL = `# T-202

  - role: implementation
  - impact: low
  - estimatedEffort: 1d
  - estimatedEffortSource: agent-active
  - prerequisites: []
  - blocking: []
  - filesAffected: []
  - testsRequired: []
  - summary: Task for history scan e2e.
  - description: |
      Single line.

      ## Acceptance
      - [ ] History scan e2e.
`

test("review5: CLI --include-inferred reaches the emitted approval template (end-to-end parser, not helper)", () => {
  const repos = fixtureReposMixed()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-home-histcli-"))
  const previousHome = process.env.MAPCTX_HOME
  // The board lives INSIDE the fixture's repoA: its git identity scopes the
  // mixed/genuine/worktree sessions exactly like the unit fixtures.
  const repoA = repos.repoA
  fs.mkdirSync(path.join(repoA, "tasks"), { recursive: true })
  fs.writeFileSync(path.join(repoA, "TASKS.md"), E2E_BOARD, "utf8")
  fs.writeFileSync(path.join(repoA, "tasks", "T-202.md"), E2E_DETAIL, "utf8")
  fs.writeFileSync(path.join(repoA, "mapcs.config.json"), `${JSON.stringify({
    owner: "octocat",
    repo: "history-scan-e2e",
    projectId: "PVT_fixture_hist",
    statusFieldId: "PVTSSF_fixture_hist",
    statusMap: { backlog: "Backlog", "ready-for-do": "Ready for Do", doing: "Doing", review: "Review", done: "Done", paused: "Paused", cancelled: "Cancelled", archived: "Archived" },
    tasksFile: "./TASKS.md"
  }, null, 2)}\n`, "utf8")
  const git = (args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repoA, stdio: "ignore" })
  git(["add", "-A"])
  git(["commit", "-q", "-m", "board"])
  const childEnv = { ...process.env, MAPCTX_HOME: home }
  const cli = require.resolve("./mapctx-cli.js")
  const run = (args: string[]) =>
    JSON.parse(execFileSync("node", [cli, ...args], { encoding: "utf8", cwd: repoA, env: childEnv }))
  try {
    run(["import", "--commit"])
    const scanBase = [
      "history", "scan", "--task", "T-202", "--json",
      "--codex-sessions", repos.codexDir,
      "--opencode-db", path.join(repos.root, "none.db"),
      "--claude-dir", path.join(repos.root, "no-claude"),
      "--repo", repoA
    ]
    // Default: the emitted template EXCLUDES the degraded mixed session.
    const defaultPath = path.join(repos.root, "template-default.json")
    run([...scanBase, "--emit-approval-template", defaultPath])
    const templateDefault = JSON.parse(fs.readFileSync(defaultPath, "utf8")) as {
      approvals: Array<{ taskId: string; sessions: Array<{ sessionId: string; intendedTier?: string }> }>
    }
    const defaultSessions = templateDefault.approvals.find(entry => entry.taskId === "T-202")?.sessions.map(s => s.sessionId).sort() ?? []
    assert.deepEqual(defaultSessions, ["codex-genuine", "codex-worktree"], "degraded mixed session is not a default candidate")

    // Opt-in: the PUBLIC CLI flag must reach the template builder -- the
    // mixed session appears with intendedTier "inferred".
    const inferredPath = path.join(repos.root, "template-inferred.json")
    run([...scanBase, "--emit-approval-template", inferredPath, "--include-inferred"])
    const templateInferred = JSON.parse(fs.readFileSync(inferredPath, "utf8")) as {
      approvals: Array<{ taskId: string; sessions: Array<{ sessionId: string; intendedTier?: string }> }>
    }
    const inferredSessions = templateInferred.approvals.find(entry => entry.taskId === "T-202")?.sessions ?? []
    const mixedCandidate = inferredSessions.find(session => session.sessionId === "codex-mixed")
    assert.ok(mixedCandidate, "--include-inferred must include the degraded candidate")
    assert.equal(mixedCandidate!.intendedTier, "inferred", "included degraded candidate carries explicit intent")
  } finally {
    process.env.MAPCTX_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(repos.root, { recursive: true, force: true })
  }
})

/**
 * Builds an OpenCode-shaped SQLite database. `insertionOrder` varies row
 * insertion order without changing logical content, proving the pin is
 * order-stable; `mutate` applies content growth (append/update/meta).
 */
function writeOpencodeFixtureDb(dbPath: string, repoA: string, insertionOrder: "a" | "b", mutate?: "append-part" | "update-title"): void {
  fs.rmSync(dbPath, { force: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT);
    CREATE TABLE message (session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session_input (session_id TEXT, prompt TEXT, time_created INTEGER);
  `)
  const base = Date.parse("2026-09-13T16:00:00.000Z")
  const title = mutate === "update-title" ? "renamed session" : "history pin fixture"
  const partRow = { session_id: "oc-pin", time_created: base + 4000, time_updated: base + 4000, data: JSON.stringify({ type: "text", text: "mapctx task claim T-202" }) }
  const extraPart = { session_id: "oc-pin", time_created: base + 8000, time_updated: base + 8000, data: JSON.stringify({ type: "tool", tool: "bash", state: { input: { cmd: "ls" } } }) }
  const messageRow = { session_id: "oc-pin", time_created: base, time_updated: base + 1000, data: JSON.stringify({ role: "user", time: { created: base } }) }
  const promptRow = { session_id: "oc-pin", prompt: "mapctx task claim T-202", time_created: base + 500 }
  const allRows: Array<[string, unknown[]]> = [
    ["INSERT INTO session (id, directory, title) VALUES (?, ?, ?)", ["oc-pin", repoA, title]],
    ["INSERT INTO message (session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?)", [messageRow.session_id, messageRow.time_created, messageRow.time_updated, messageRow.data]],
    ["INSERT INTO part (session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?)", [partRow.session_id, partRow.time_created, partRow.time_updated, partRow.data]],
    ["INSERT INTO session_input (session_id, prompt, time_created) VALUES (?, ?, ?)", [promptRow.session_id, promptRow.prompt, promptRow.time_created]]
  ]
  if (mutate === "append-part") {
    allRows.push(["INSERT INTO part (session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?)", [extraPart.session_id, extraPart.time_created, extraPart.time_updated, extraPart.data]])
  }
  const ordered = insertionOrder === "a" ? allRows : [...allRows].reverse()
  for (const [sql, params] of ordered) db.prepare(sql).run(...(params as never[]))
  db.close()
}

test("review5b: opencode source pin covers session content; stale approvals refuse with zero writes", () => {
  const repos = fixtureReposMixed()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-home-histpin-"))
  const previousHome = process.env.MAPCTX_HOME
  const repoA = repos.repoA
  fs.mkdirSync(path.join(repoA, "tasks"), { recursive: true })
  fs.writeFileSync(path.join(repoA, "TASKS.md"), E2E_BOARD, "utf8")
  fs.writeFileSync(path.join(repoA, "tasks", "T-202.md"), E2E_DETAIL, "utf8")
  fs.writeFileSync(path.join(repoA, "mapcs.config.json"), `${JSON.stringify({
    owner: "octocat",
    repo: "history-pin-e2e",
    projectId: "PVT_fixture_pin",
    statusFieldId: "PVTSSF_fixture_pin",
    statusMap: { backlog: "Backlog", "ready-for-do": "Ready for Do", doing: "Doing", review: "Review", done: "Done", paused: "Paused", cancelled: "Cancelled", archived: "Archived" },
    tasksFile: "./TASKS.md"
  }, null, 2)}\n`, "utf8")
  const git = (args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repoA, stdio: "ignore" })
  git(["add", "-A"])
  git(["commit", "-q", "-m", "board"])
  const childEnv = { ...process.env, MAPCTX_HOME: home }
  const cli = require.resolve("./mapctx-cli.js")
  const run = (args: string[]) =>
    JSON.parse(execFileSync("node", [cli, ...args], { encoding: "utf8", cwd: repoA, env: childEnv }))
  const ocDb = path.join(repos.root, "opencode.db")
  const scanArgs = [
    "history", "scan", "--task", "T-202", "--json",
    "--codex-sessions", repos.codexDir,
    "--opencode-db", ocDb,
    "--claude-dir", path.join(repos.root, "no-claude"),
    "--repo", repoA
  ]
  const pinsFrom = (templatePath: string): Array<{ sessionId: string; sourceHash: string; intendedTier?: string }> => {
    const template = JSON.parse(fs.readFileSync(templatePath, "utf8")) as {
      approvals: Array<{ taskId: string; sessions: Array<{ sessionId: string; sourceHash: string; intendedTier?: string }> }>
    }
    return template.approvals.find(entry => entry.taskId === "T-202")?.sessions ?? []
  }
  try {
    writeOpencodeFixtureDb(ocDb, repoA, "a")
    run(["import", "--commit"])
    const t1 = path.join(repos.root, "t1.json")
    run([...scanArgs, "--emit-approval-template", t1])
    const pin1 = pinsFrom(t1).find(session => session.sessionId === "oc-pin")!
    assert.ok(pin1, "the opencode session links T-202 and appears in the template")

    // Identical DB re-scan: same pin (idempotent, no fresh randomness).
    const t1b = path.join(repos.root, "t1b.json")
    run([...scanArgs, "--emit-approval-template", t1b])
    assert.equal(pinsFrom(t1b).find(session => session.sessionId === "oc-pin")!.sourceHash, pin1.sourceHash, "identical source keeps an identical pin")

    // SQL return order must not change the pin: same logical rows, opposite
    // insertion order, separate database file.
    const ocDbOrderB = path.join(repos.root, "opencode-order-b.db")
    writeOpencodeFixtureDb(ocDbOrderB, repoA, "b")
    const tOrderB = path.join(repos.root, "t-order-b.json")
    run([...scanArgs, "--opencode-db", ocDbOrderB, "--emit-approval-template", tOrderB])
    assert.equal(pinsFrom(tOrderB).find(session => session.sessionId === "oc-pin")!.sourceHash, pin1.sourceHash, "row insertion order never changes the pin")

    // Appending a part changes the source: the pin MUST move.
    writeOpencodeFixtureDb(ocDb, repoA, "a", "append-part")
    const t2 = path.join(repos.root, "t2.json")
    run([...scanArgs, "--emit-approval-template", t2])
    const pin2 = pinsFrom(t2).find(session => session.sessionId === "oc-pin")!.sourceHash
    assert.notEqual(pin2, pin1.sourceHash, "appended part row invalidates the old pin")

    // Title-only meta change also moves the pin.
    writeOpencodeFixtureDb(ocDb, repoA, "a", "update-title")
    const t3 = path.join(repos.root, "t3.json")
    run([...scanArgs, "--emit-approval-template", t3])
    assert.notEqual(pinsFrom(t3).find(session => session.sessionId === "oc-pin")!.sourceHash, pin2, "meta change invalidates the pin")

    // Commit with the STALE pin (t1, base content) against the CURRENT
    // (mutated) source refuses the whole batch: no journal, evidence,
    // correction, or lifecycle change. The DB stays in the mutated
    // append-part state, so pin1 is genuinely stale here.
    writeOpencodeFixtureDb(ocDb, repoA, "a", "append-part")
    const stale = {
      schemaVersion: 2,
      sourceScan: JSON.parse(fs.readFileSync(t1, "utf8")).sourceScan,
      approvals: [{ taskId: "T-202", sessions: [{ harness: "opencode", sessionId: "oc-pin", sourceHash: pin1.sourceHash }], approvedBy: "test" }]
    }
    const stalePath = path.join(repos.root, "stale.json")
    fs.writeFileSync(stalePath, JSON.stringify(stale), "utf8")
    assert.throws(() => execFileSync("node", [cli, ...scanArgs.slice(0, 2), "--commit", "--approve", stalePath, ...scanArgs.slice(4)], { encoding: "utf8", cwd: repoA, env: childEnv }), /source changed/)
    const projectId = fs.readFileSync(path.join(repoA, "mapctx.toml"), "utf8").match(/projectId\s*=\s*"([^"]+)"/)![1]
    // Resolve against THIS test's MAPCTX_HOME explicitly: the parent process
    // env may still point at an earlier test's (deleted) home.
    const handle = StoreHandle.open(path.join(home, "projects", projectId))
    try {
      assert.equal(listHistoryEvidence(handle.db, "T-202").length, 0, "refused stale commit wrote no evidence")
      assert.equal(listHistoryCorrections(handle.db, { taskId: "T-202" }).length, 0, "refused stale commit wrote no corrections")
      const task = getTask(handle.db, "T-202")!
      assert.equal(task.planningState, "backlog", "lifecycle untouched")
    } finally {
      handle.close()
    }
  } finally {
    process.env.MAPCTX_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(repos.root, { recursive: true, force: true })
  }
})

test("review5c: CLI corrects an epic-owned receipt on a TERMINAL epic without lifecycle mutation", () => {
  const repos = fixtureRepos()
  const fixture = bootstrapStore(repos)
  try {
    const { handle, storeDir } = fixture
    // A terminal epic with a foreign-source history-scan receipt (the
    // coordinator's live-recovery gap: E-005/E-001/E-002/E-004 shape).
    seedBoardTask(handle, "E-005", "backlog", 2)
    completeWithReceipt(handle, "E-005", "55555555-5555-4555-8555-555555555555")
    const done = moveTask(handle, { taskId: "E-005", to: "done", actor: "human" })
    assert.ok(done.ok, done.ok ? "" : done.reason)
    const before = getTask(handle.db, "E-005")!
    assert.equal(before.planningState, "done")

    historyCorrectCommand(handle, "E-005", {
      target: "receipt:55555555-5555-4555-8555-555555555555/1",
      reason: "session cwd belongs to another project",
      dateCachePath: path.join(storeDir, "history-dates.json")
    })
    assert.equal(listHistoryCorrections(handle.db, { taskId: "E-005" }).length, 1)
    assert.ok(listInvalidatedReceiptKeys(handle.db).has("55555555-5555-4555-8555-555555555555/1"), "invalidation feeds Gantt/forecast exclusions")

    // Terminal lifecycle byte-identical; the receipt row stays queryable.
    const after = getTask(handle.db, "E-005")!
    assert.equal(after.planningState, before.planningState)
    assert.equal(after.completedOn, before.completedOn)
    assert.equal(listReceiptsForTask(handle.db, "E-005").length, 1)

    // Refusals: unknown epic and wrong owner both write nothing.
    assert.throws(() => historyCorrectCommand(handle, "E-999", {
      target: "receipt:55555555-5555-4555-8555-555555555555/1",
      reason: "no such epic",
      dateCachePath: path.join(storeDir, "history-dates.json")
    }))
    seedBoardTask(handle, "E-001", "backlog", 3)
    assert.throws(() => historyCorrectCommand(handle, "E-001", {
      target: "receipt:55555555-5555-4555-8555-555555555555/1",
      reason: "belongs to E-005",
      dateCachePath: path.join(storeDir, "history-dates.json")
    }))
    assert.equal(listHistoryCorrections(handle.db, { taskId: "E-001" }).length, 0, "wrong owner writes nothing")
  } finally {
    teardown(fixture)
  }
})
