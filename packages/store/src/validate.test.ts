import assert from "node:assert/strict"
import test from "node:test"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { DatabaseSync } from "node:sqlite"
import { importCommit } from "./cutover"
import { resolveProjectStoreDir } from "./config"
import {
  validateCanonicalStore, validateStoreRegime,
  applyValidationGate, buildValidationBaseline, parseValidationBaseline, validationIssueFingerprint,
  VALIDATION_BASELINE_SCHEMA_VERSION, type ValidationGateIssue, type ValidationBaselineFile
} from "./validate"
import { createTask, updateTask } from "./tasks"
import { StoreHandle } from "./store-handle"
import { cleanupDir, setupGoldenRepo } from "./__test-helpers__"

function treeHashes(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.name !== "mapctx.db-wal" && entry.name !== "mapctx.db-shm") {
        // SQLite may create transient WAL coordination sidecars for a
        // read-only connection. They carry no committed store state; compare
        // the DB, journal, and metadata bytes that validation must preserve.
        result[path.relative(root, file)] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
      }
    }
  }
  walk(root)
  return result
}

test("store validate is identical across divergent or absent worktree mirrors and performs no writes", () => {
  const first = setupGoldenRepo()
  const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-validate-worktree-"))
  try {
    const imported = importCommit({ cwd: first.repoDir, actor: "test" })
    const config = fs.readFileSync(path.join(first.repoDir, "mapctx.toml"), "utf8")
    fs.writeFileSync(path.join(secondDir, "mapctx.toml"), config)
    fs.writeFileSync(path.join(secondDir, "TASKS.md"), "not a TASKS.md snapshot; malformed and intentionally divergent\n")
    // Missing detail directory and Acceptance are also intentional in this
    // worktree. Operational validate must never open either file.
    const storeDir = resolveProjectStoreDir(imported.projectId)
    const before = treeHashes(storeDir)

    const a = validateStoreRegime(first.repoDir)
    const b = validateStoreRegime(secondDir)
    assert.equal(a.status, "store-authority")
    assert.equal(b.status, "store-authority")
    assert.deepEqual(b, a)
    assert.deepEqual(treeHashes(storeDir), before, "read-only validation leaves DB, journal, and metadata bytes unchanged")
  } finally {
    first.restoreEnv()
    cleanupDir(first.repoDir)
    cleanupDir(secondDir)
  }
})

test("store validate reports pending schema migration without applying it", () => {
  const fixture = setupGoldenRepo()
  try {
    const imported = importCommit({ cwd: fixture.repoDir, actor: "test" })
    const storeDir = resolveProjectStoreDir(imported.projectId)
    const dbPath = path.join(storeDir, "mapctx.db")
    const db = new DatabaseSync(dbPath)
    db.prepare("DELETE FROM schema_migrations WHERE version = 10").run()
    db.close()
    const before = treeHashes(storeDir)

    const result = validateStoreRegime(fixture.repoDir)
    assert.equal(result.status, "maintenance-needed")
    if (result.status === "maintenance-needed") assert.match(result.maintenanceNeeded, /migration 10 is pending/)
    assert.deepEqual(treeHashes(storeDir), before, "validation reports migration need without applying schema changes")
  } finally {
    fixture.restoreEnv()
    cleanupDir(fixture.repoDir)
  }
})

/** Minimal canonical fixture: a store with one CORE domain and one task. */
function openCanonicalFixture(options: { workDomains?: Array<{ key: string; description: string }>; task?: { id?: string; title?: string; status?: string; startDate?: string | null } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-canonical-validate-"))
  const storeDir = path.join(dir, "projects", crypto.randomUUID())
  const handle = StoreHandle.open(storeDir)
  handle.appendEvent({
    eventType: "project.initialized",
    actor: "test",
    payload: {
      projectId: path.basename(storeDir),
      boardTitle: "Canonical fixture",
      workDomains: options.workDomains ?? [{ key: "CORE", description: "core" }],
      notesMarkdown: "",
      plansAuthority: "store",
      sourceSnapshotHash: null
    }
  })
  const created = createTask(handle, {
    id: options.task?.id ?? "T-001",
    title: options.task?.title ?? "Canonical task",
    actor: "test",
    status: options.task?.status ?? "backlog",
    workload: "Normal",
    ...(options.task?.startDate !== undefined ? { startDate: options.task.startDate } : {})
  })
  assert.equal(created.ok, true)
  return {
    handle,
    taskId: created.ok ? created.taskId : "T-001",
    close: () => {
      handle.close()
      cleanupDir(dir)
    }
  }
}

function codesOf(report: { issues: Array<{ severity: string; code: string }> }): string[] {
  return report.issues.filter(issue => issue.severity === "error").map(issue => issue.code)
}

test("F1: null due/completed with a startDate is valid; order errors only when both dates exist", () => {
  const fixture = openCanonicalFixture({ task: { status: "in-progress", startDate: "2026-01-01" } })
  try {
    const clean = validateCanonicalStore(fixture.handle)
    assert.equal(clean.errors, 0, JSON.stringify(clean.issues))
    assert.ok(!codesOf(clean).includes("due-before-start"))
    assert.ok(!codesOf(clean).includes("completed-before-start"))

    // due before start: both present -> real error.
    assert.equal(updateTask(fixture.handle, { taskId: fixture.taskId, patch: { dueDate: "2025-12-31" }, actor: "test" }).ok, true)
    assert.ok(codesOf(validateCanonicalStore(fixture.handle)).includes("due-before-start"))

    // malformed due: format error, NOT a misleading order error.
    assert.equal(updateTask(fixture.handle, { taskId: fixture.taskId, patch: { dueDate: "garbage" }, actor: "test" }).ok, true)
    const malformed = validateCanonicalStore(fixture.handle)
    assert.ok(codesOf(malformed).includes("invalid-due-date"))
    assert.ok(!codesOf(malformed).includes("due-before-start"))

    // completed before start: both present -> real error (completedOn is
    // moveTask-stamped, so poison it via a raw patch like a legacy store).
    fixture.handle.appendEvent({ eventType: "task.patched", actor: "raw-fixture", payload: { taskId: fixture.taskId, patch: { completedOn: "2025-01-01" } } })
    const completed = validateCanonicalStore(fixture.handle)
    assert.ok(codesOf(completed).includes("completed-before-start"))
  } finally {
    fixture.close()
  }
})

test("F2: canonical validate restores domain/date/specMode/state/title/type and edge guarantees", () => {
  const fixture = openCanonicalFixture()
  try {
    // Bad due/domain/specMode via the public update path, then validate fails.
    assert.equal(
      updateTask(fixture.handle, { taskId: fixture.taskId, patch: { dueDate: "garbage", domains: ["NO_SUCH_DOMAIN"], specMode: "nonsense" }, actor: "test" }).ok,
      true
    )
    const report = validateCanonicalStore(fixture.handle)
    const codes = codesOf(report)
    assert.ok(codes.includes("invalid-due-date"), JSON.stringify(codes))
    assert.ok(codes.includes("invalid-domain"), JSON.stringify(codes))
    assert.ok(codes.includes("invalid-specmode"), JSON.stringify(codes))

    // Raw event patches bypass commands: poisoned enums must still be diagnosed.
    fixture.handle.appendEvent({
      eventType: "task.patched",
      actor: "raw-fixture",
      payload: { taskId: fixture.taskId, patch: { planningState: "not-a-planning-state", executionState: "not-an-execution-state" } }
    })
    const poisoned = codesOf(validateCanonicalStore(fixture.handle))
    assert.ok(poisoned.includes("invalid-planning-state"), JSON.stringify(poisoned))
    assert.ok(poisoned.includes("invalid-execution-state"), JSON.stringify(poisoned))

    // Structural identity/type.
    fixture.handle.appendEvent({ eventType: "task.patched", actor: "raw-fixture", payload: { taskId: fixture.taskId, patch: { title: "", type: "banana" } } })
    const identity = codesOf(validateCanonicalStore(fixture.handle))
    assert.ok(identity.includes("missing-title"), JSON.stringify(identity))
    assert.ok(identity.includes("invalid-type"), JSON.stringify(identity))

    // Raw dependency edges: unknown source and unknown kind are diagnosed
    // even though the projection-level DAG check only walks depends-on.
    fixture.handle.db.prepare("INSERT INTO dependency_projection (from_task_id, to_task_id, kind) VALUES ('GHOST', 'T-001', 'depends-on')").run()
    fixture.handle.db.prepare("INSERT INTO dependency_projection (from_task_id, to_task_id, kind) VALUES ('T-001', 'T-001', 'related-to')").run()
    const edges = codesOf(validateCanonicalStore(fixture.handle))
    assert.ok(edges.includes("unknown-dependency-source"), JSON.stringify(edges))
    assert.ok(edges.includes("unknown-dependency-kind"), JSON.stringify(edges))
  } finally {
    fixture.close()
  }
})

/**
 * T-157: validateCanonicalStore must diagnose a dependency edge diverging
 * from the detail prerequisites/blocking list it mirrors. Poisoned the way
 * the pre-fix updateTask actually wrote one -- a raw task.patched event
 * whose outgoingEdges replaces the FULL edge set while detailPatch only
 * updates the list it names -- never by hand-editing dependency_projection.
 */
test("dependency-detail-divergence: clean store has none; a pre-fix-style patch poisons one surface; one updateTask replay repairs it", () => {
  const fixture = openCanonicalFixture()
  try {
    const t2 = createTask(fixture.handle, { title: "dep target", actor: "test" })
    const t3 = createTask(fixture.handle, { title: "block target", actor: "test" })
    const t4 = createTask(fixture.handle, { title: "extra dep target", actor: "test" })
    const t5 = createTask(fixture.handle, { title: "extra block target", actor: "test" })
    assert.ok(t2.ok && t3.ok && t4.ok && t5.ok)
    if (!t2.ok || !t3.ok || !t4.ok || !t5.ok) return

    assert.equal(
      updateTask(fixture.handle, { taskId: fixture.taskId, dependsOn: [t2.taskId], blocking: [t3.taskId], actor: "test" }).ok,
      true
    )
    assert.ok(!codesOf(validateCanonicalStore(fixture.handle)).includes("dependency-detail-divergence"), "consistent store reports none")

    // Pre-fix recipe: detailPatch adds t4 to prerequisites but outgoingEdges
    // only re-lists the depends-on edge to t2 -- the full-replace semantics
    // of outgoingEdges silently drop the blocks edge to t3 too, so detail
    // ends up holding MORE than the edges on both surfaces.
    fixture.handle.appendEvent({
      eventType: "task.patched",
      actor: "pre-fix-fixture",
      payload: {
        taskId: fixture.taskId,
        patch: {},
        detailPatch: { prerequisites: [t2.taskId, t4.taskId] },
        outgoingEdges: [{ fromTaskId: fixture.taskId, toTaskId: t2.taskId, kind: "depends-on" }]
      }
    })
    const poisoned = validateCanonicalStore(fixture.handle)
    const divergences = poisoned.issues.filter(issue => issue.code === "dependency-detail-divergence")
    assert.equal(divergences.length, 2, JSON.stringify(poisoned.issues))
    for (const issue of divergences) {
      assert.equal(issue.severity, "error")
      assert.equal(issue.taskId, fixture.taskId)
      assert.ok(issue.message.includes("--depends-on") && issue.message.includes("--blocking"), issue.message)
    }

    // Repair: replay BOTH lists through one updateTask, as the message prescribes.
    assert.equal(
      updateTask(fixture.handle, { taskId: fixture.taskId, dependsOn: [t2.taskId, t4.taskId], blocking: [t3.taskId], actor: "test" }).ok,
      true
    )
    assert.ok(!codesOf(validateCanonicalStore(fixture.handle)).includes("dependency-detail-divergence"), "repair clears both surfaces")

    // Opposite direction: edges hold MORE than the detail list. Raw
    // outgoingEdges adds a second blocks edge (t5) without a matching
    // detailPatch, so detail.blocking stays behind.
    fixture.handle.appendEvent({
      eventType: "task.patched",
      actor: "pre-fix-fixture",
      payload: {
        taskId: fixture.taskId,
        patch: {},
        outgoingEdges: [
          { fromTaskId: fixture.taskId, toTaskId: t2.taskId, kind: "depends-on" },
          { fromTaskId: fixture.taskId, toTaskId: t4.taskId, kind: "depends-on" },
          { fromTaskId: fixture.taskId, toTaskId: t3.taskId, kind: "blocks" },
          { fromTaskId: fixture.taskId, toTaskId: t5.taskId, kind: "blocks" }
        ]
      }
    })
    const edgesAhead = validateCanonicalStore(fixture.handle)
    const edgesAheadIssue = edgesAhead.issues.find(issue => issue.code === "dependency-detail-divergence")
    assert.ok(edgesAheadIssue, JSON.stringify(edgesAhead.issues))
    assert.equal(edgesAheadIssue?.taskId, fixture.taskId)

    assert.equal(
      updateTask(fixture.handle, { taskId: fixture.taskId, blocking: [t3.taskId, t5.taskId], actor: "test" }).ok,
      true
    )
    assert.ok(!codesOf(validateCanonicalStore(fixture.handle)).includes("dependency-detail-divergence"), "repair clears the edges-ahead case too")
  } finally {
    fixture.close()
  }
})

test("F2: domains without declared project work domains are an error", () => {
  const fixture = openCanonicalFixture({ workDomains: [] })
  try {
    assert.equal(updateTask(fixture.handle, { taskId: fixture.taskId, patch: { domains: ["CORE"] }, actor: "test" }).ok, true)
    assert.ok(codesOf(validateCanonicalStore(fixture.handle)).includes("domains-without-work-domains"))
  } finally {
    fixture.close()
  }
})

test("T-092: done requires completedOn; terminal cancelled/archived may be null or keep legacy date; non-terminal date rejected", () => {
  const fixture = openCanonicalFixture()
  try {
    // done without completedOn (poisoned projection): rejected.
    fixture.handle.appendEvent({ eventType: "task.patched", actor: "raw-fixture", payload: { taskId: fixture.taskId, patch: { planningState: "done" } } })
    assert.ok(codesOf(validateCanonicalStore(fixture.handle)).includes("completion-date-missing"))

    // terminal cancelled with a LEGACY completedOn: preserved, no error.
    fixture.handle.appendEvent({ eventType: "task.patched", actor: "raw-fixture", payload: { taskId: fixture.taskId, patch: { planningState: "cancelled", completedOn: "2026-02-02" } } })
    const legacyTerminal = codesOf(validateCanonicalStore(fixture.handle))
    assert.ok(!legacyTerminal.includes("completion-date-missing"), JSON.stringify(legacyTerminal))
    assert.ok(!legacyTerminal.includes("completion-date-unexpected"), JSON.stringify(legacyTerminal))

    // terminal cancelled with null completedOn: legitimate.
    fixture.handle.appendEvent({ eventType: "task.patched", actor: "raw-fixture", payload: { taskId: fixture.taskId, patch: { planningState: "cancelled", completedOn: null } } })
    assert.ok(!codesOf(validateCanonicalStore(fixture.handle)).some(code => code.startsWith("completion-date")))

    // non-terminal with completedOn: still invalid.
    fixture.handle.appendEvent({ eventType: "task.patched", actor: "raw-fixture", payload: { taskId: fixture.taskId, patch: { planningState: "backlog", completedOn: "2026-03-03" } } })
    assert.ok(codesOf(validateCanonicalStore(fixture.handle)).includes("completion-date-unexpected"))
  } finally {
    fixture.close()
  }
})

test("N3: external-id-format and empty-work-domains warnings port DB-only at warning severity", () => {
  const fixture = openCanonicalFixture()
  try {
    // Malformed externalId -> warning, never an error.
    assert.equal(updateTask(fixture.handle, { taskId: fixture.taskId, patch: { externalId: "not-a-mapping" }, actor: "test" }).ok, true)
    const report = validateCanonicalStore(fixture.handle)
    const external = report.issues.find(issue => issue.code === "external-id-format")
    assert.ok(external, JSON.stringify(report.issues))
    assert.equal(external?.severity, "warning")
    assert.equal(report.errors, 0, "warnings do not become errors")

    // Well-formed externalId -> no warning.
    assert.equal(updateTask(fixture.handle, { taskId: fixture.taskId, patch: { externalId: "github:issue:42" }, actor: "test" }).ok, true)
    assert.ok(!validateCanonicalStore(fixture.handle).issues.some(issue => issue.code === "external-id-format"))

    // Project without declared work domains -> board-level warning.
    const bare = openCanonicalFixture({ workDomains: [] })
    try {
      const bareReport = validateCanonicalStore(bare.handle)
      const empty = bareReport.issues.find(issue => issue.code === "empty-work-domains")
      assert.ok(empty, JSON.stringify(bareReport.issues))
      assert.equal(empty?.severity, "warning")
      assert.equal(bareReport.errors, 0)
    } finally {
      bare.close()
    }
  } finally {
    fixture.close()
  }
})

// ---------------------------------------------------------------------------
// T-127 (R7): pure applyValidationGate / baseline helpers.
// ---------------------------------------------------------------------------

function issue(partial: Partial<ValidationGateIssue> & Pick<ValidationGateIssue, "code" | "message">): ValidationGateIssue {
  return { severity: "error", taskId: undefined, ...partial }
}

test("validationIssueFingerprint distinguishes same code+taskId with a different message, and is stable otherwise", () => {
  const a = issue({ code: "invalid-domain", taskId: "T-1", message: "Unknown domain key: FOO" })
  const b = issue({ code: "invalid-domain", taskId: "T-1", message: "Unknown domain key: BAR" })
  const aAgain = issue({ code: "invalid-domain", taskId: "T-1", message: "Unknown domain key: FOO" })
  assert.notEqual(validationIssueFingerprint(a), validationIssueFingerprint(b))
  assert.equal(validationIssueFingerprint(a), validationIssueFingerprint(aAgain))
})

test("applyValidationGate --task keeps only matching-task issues, counts others as filteredOutByTask, and excludes board-scoped issues without failing", () => {
  const issues: ValidationGateIssue[] = [
    issue({ code: "invalid-domain", taskId: "T-1", message: "m1" }),
    issue({ code: "invalid-domain", taskId: "T-2", message: "m2" }),
    issue({ code: "dependency-cycle", message: "board cycle" }), // no taskId
    issue({ code: "empty-work-domains", severity: "warning", message: "no domains" }) // no taskId
  ]
  const gated = applyValidationGate(issues, { tasks: ["T-1"] })
  assert.deepEqual(gated.issues.map(i => i.code), ["invalid-domain"])
  assert.equal(gated.errors, 1)
  assert.equal(gated.filteredOutByTask, 1)
  assert.equal(gated.boardScopedExcluded, 2)
  assert.deepEqual(gated.taskFilter, ["T-1"])
  assert.equal(gated.baselined, 0)
})

test("buildValidationBaseline is deterministic under input reordering and deduplicates identical issues", () => {
  const i1 = issue({ code: "invalid-domain", taskId: "T-1", message: "m1" })
  const i2 = issue({ code: "invalid-domain", taskId: "T-2", message: "m2" })
  const dup = issue({ code: "invalid-domain", taskId: "T-1", message: "m1" })
  const forward = buildValidationBaseline([i1, i2])
  const backward = buildValidationBaseline([i2, i1])
  const withDup = buildValidationBaseline([i1, dup, i2])
  assert.deepEqual(forward, backward)
  assert.equal(withDup.issues.length, 2, "duplicate issue collapses to one baseline entry")
  assert.equal(forward.schemaVersion, VALIDATION_BASELINE_SCHEMA_VERSION)
})

test("applyValidationGate --baseline accepts recorded issues (baselined), fails a new one, and reports a non-matching entry as stale", () => {
  const existing = issue({ code: "invalid-domain", taskId: "T-1", message: "m1" })
  const baseline = buildValidationBaseline([existing])
  const newIssue = issue({ code: "invalid-domain", taskId: "T-2", message: "a new problem" })
  const gated = applyValidationGate([existing, newIssue], { baseline })
  assert.equal(gated.baselined, 1)
  assert.deepEqual(gated.issues.map(i => i.message), ["a new problem"], "only the unrecorded issue fails the gate")
  assert.equal(gated.errors, 1)
  assert.equal(gated.staleBaseline.length, 0)

  const staleRun = applyValidationGate([newIssue], { baseline })
  assert.equal(staleRun.staleBaseline.length, 1, "the baselined entry absent from this run is reported as stale")
  assert.equal(staleRun.staleBaseline[0].fingerprint, baseline.issues[0].fingerprint)
  assert.equal(staleRun.errors, 1, "stale baseline entries never fail the gate")
})

test("applyValidationGate intersects --task before --baseline, so staleBaseline is reported against the narrowed scope", () => {
  const t1 = issue({ code: "invalid-domain", taskId: "T-1", message: "m1" })
  const t2 = issue({ code: "invalid-domain", taskId: "T-2", message: "m2" })
  const baseline = buildValidationBaseline([t1, t2])
  // Only T-1 is in scope; T-2's baseline entry is unreachable and reported stale.
  const gated = applyValidationGate([t1], { tasks: ["T-1"], baseline })
  assert.equal(gated.baselined, 1)
  assert.equal(gated.issues.length, 0)
  assert.equal(gated.staleBaseline.length, 1)
  assert.equal(gated.staleBaseline[0].taskId, "T-2")
})

// ---------------------------------------------------------------------------
// T-148 (D13): `bulk-updated-timestamp` is `info`, routed around the T-127
// gate entirely.
// ---------------------------------------------------------------------------

/**
 * Creates 9 additional tasks alongside the fixture's own task (10 total),
 * then stamps all 10 with the SAME updatedOn date via a real patch --
 * `createTask` leaves `updatedOn: null`, which the rule does not count, so
 * only the subsequent `updateTask` trips the `count >= 10` threshold. A
 * fixed `now` keeps the recorded date (and the fingerprint/message built
 * from it) deterministic across test runs.
 */
const BULK_UPDATE_DATE = "2026-05-01"
function tripBulkTimestamp(fixture: ReturnType<typeof openCanonicalFixture>): string[] {
  const ids = [fixture.taskId]
  for (let i = 0; i < 9; i++) {
    const created = createTask(fixture.handle, { title: `Bulk task ${i}`, actor: "test" })
    assert.equal(created.ok, true)
    if (created.ok) ids.push(created.taskId)
  }
  for (const id of ids) {
    assert.equal(
      updateTask(fixture.handle, { taskId: id, patch: { priority: "high" }, actor: "test", now: () => new Date(`${BULK_UPDATE_DATE}T00:00:00.000Z`) }).ok,
      true
    )
  }
  return ids
}

test("T-148.1: bulk-updated-timestamp is severity info with its exact T-127-fingerprinted message", () => {
  const fixture = openCanonicalFixture()
  try {
    tripBulkTimestamp(fixture)
    const report = validateCanonicalStore(fixture.handle)
    const bulk = report.issues.find(issue => issue.code === "bulk-updated-timestamp")
    assert.ok(bulk, JSON.stringify(report.issues))
    assert.equal(bulk?.severity, "info")
    // Exact literal on purpose: this message is part of the T-127 baseline
    // fingerprint (validationIssueFingerprint hashes severity+code+taskId+
    // message), so rewording it here would mask a breaking change to every
    // baseline file that recorded this issue.
    assert.equal(bulk?.message, `10 tasks share updated date ${BULK_UPDATE_DATE}; event history carries no per-task distinction.`)
  } finally {
    fixture.close()
  }
})

test("T-148.2: bulk-updated-timestamp counts in neither errors nor warnings, and a real error in the same run is still counted", () => {
  const fixture = openCanonicalFixture()
  try {
    tripBulkTimestamp(fixture)
    // A real error alongside it, so the change cannot be blinding the gate.
    fixture.handle.appendEvent({ eventType: "task.patched", actor: "raw-fixture", payload: { taskId: fixture.taskId, patch: { title: "" } } })
    const report = validateCanonicalStore(fixture.handle)
    assert.ok(report.issues.some(issue => issue.code === "bulk-updated-timestamp"), JSON.stringify(report.issues))
    assert.ok(codesOf(report).includes("missing-title"), JSON.stringify(report.issues))
    assert.equal(report.errors, 1, "only the real error counts")
    assert.equal(report.warnings, 0, "the info issue never becomes a warning")
  } finally {
    fixture.close()
  }
})

test("T-148.3: buildValidationBaseline records no entry for bulk-updated-timestamp while still recording a real error", () => {
  const fixture = openCanonicalFixture()
  try {
    tripBulkTimestamp(fixture)
    fixture.handle.appendEvent({ eventType: "task.patched", actor: "raw-fixture", payload: { taskId: fixture.taskId, patch: { title: "" } } })
    const report = validateCanonicalStore(fixture.handle)
    assert.ok(report.issues.some(issue => issue.code === "bulk-updated-timestamp"))
    const baseline = buildValidationBaseline(report.issues)
    assert.ok(!baseline.issues.some(entry => entry.code === "bulk-updated-timestamp"), JSON.stringify(baseline.issues))
    assert.ok(baseline.issues.some(entry => entry.code === "missing-title"), JSON.stringify(baseline.issues))
  } finally {
    fixture.close()
  }
})

test("T-148.4: applyValidationGate keeps an info issue even when a forged baseline carries its exact fingerprint", () => {
  const fixture = openCanonicalFixture()
  try {
    tripBulkTimestamp(fixture)
    const report = validateCanonicalStore(fixture.handle)
    const bulk = report.issues.find(issue => issue.code === "bulk-updated-timestamp")
    assert.ok(bulk)
    if (!bulk) return
    // A baseline cannot legitimately be built with an info entry (T-148.3),
    // so this forges one directly -- as if a hand-edited or pre-T-148
    // baseline file carried the info's own fingerprint -- to prove
    // applyValidationGate ignores the match rather than relying on nothing
    // ever producing such a file.
    const forged = {
      schemaVersion: VALIDATION_BASELINE_SCHEMA_VERSION,
      issues: [{
        fingerprint: validationIssueFingerprint(bulk),
        severity: bulk.severity,
        code: bulk.code,
        taskId: bulk.taskId ?? null,
        message: bulk.message
      }]
    } as unknown as ValidationBaselineFile
    const gated = applyValidationGate(report.issues, { baseline: forged })
    assert.ok(gated.issues.some(issue => issue.code === "bulk-updated-timestamp"), "a baseline cannot silence an info issue")
    assert.equal(gated.baselined, 0, "an info issue is never counted as baselined")
  } finally {
    fixture.close()
  }
})

test("T-148.5: applyValidationGate --task excludes bulk-updated-timestamp as board-scoped without counting it as an error", () => {
  const fixture = openCanonicalFixture()
  try {
    const ids = tripBulkTimestamp(fixture)
    const report = validateCanonicalStore(fixture.handle)
    assert.ok(report.issues.some(issue => issue.code === "bulk-updated-timestamp" && issue.taskId === undefined))
    const gated = applyValidationGate(report.issues, { tasks: [ids[0]] })
    assert.ok(!gated.issues.some(issue => issue.code === "bulk-updated-timestamp"), "excluded by the --task filter")
    assert.ok(gated.boardScopedExcluded >= 1, JSON.stringify(gated))
    assert.ok(!gated.boardScopedErrors.some(issue => issue.code === "bulk-updated-timestamp"), "info is never a boardScopedError")
  } finally {
    fixture.close()
  }
})

test("parseValidationBaseline round-trips buildValidationBaseline's JSON and rejects malformed input", () => {
  const baseline = buildValidationBaseline([issue({ code: "invalid-domain", taskId: "T-1", message: "m1" })])
  const serialized = JSON.stringify(baseline)
  assert.deepEqual(parseValidationBaseline(serialized), baseline)

  assert.throws(() => parseValidationBaseline("not json"), /not valid JSON/)
  assert.throws(() => parseValidationBaseline(JSON.stringify({ schemaVersion: 999, issues: [] })), /Unsupported baseline schemaVersion/)
  assert.throws(() => parseValidationBaseline(JSON.stringify({ schemaVersion: VALIDATION_BASELINE_SCHEMA_VERSION })), /missing the `issues` array/)
  assert.throws(() => parseValidationBaseline(JSON.stringify({ schemaVersion: VALIDATION_BASELINE_SCHEMA_VERSION, issues: [{ code: "x" }] })), /no fingerprint/)
})
