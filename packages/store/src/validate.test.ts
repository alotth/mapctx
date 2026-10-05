import assert from "node:assert/strict"
import test from "node:test"
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { DatabaseSync } from "node:sqlite"
import { importCommit } from "./cutover"
import { resolveProjectStoreDir } from "./config"
import { validateCanonicalStore, validateStoreRegime } from "./validate"
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
