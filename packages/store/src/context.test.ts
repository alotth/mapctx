import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { queryTask, queryTaskContext } from "./context"
import { StoreHandle } from "./store-handle"

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-context-"))
}

function task(taskId: string, parentTaskId: string | null = null, planningState = "backlog") {
  return {
    taskId,
    positionKey: Number(taskId.slice(2)),
    title: `Task ${taskId}`,
    planningState,
    executionState: "unclaimed",
    type: "task",
    parentTaskId,
    tags: [],
    domains: ["TEST"],
    externalLinks: [],
    assignees: [],
    detailPath: `./tasks/${taskId}.md`,
    updatedOn: "2026-08-17"
  }
}

test("queryTask returns store task/detail and deterministic bounded context metadata", () => {
  const root = tempDir()
  fs.mkdirSync(path.join(root, "tasks"), { recursive: true })
  fs.writeFileSync(path.join(root, "tasks", "T-001.md"), [
    "# T-001",
    "",
    "  - role: backend",
    "  - impact: high",
    "  - estimatedEffort: 1d",
    "  - prerequisites: [T-002]",
    "  - blocking: []",
    "  - filesAffected: [packages/store]",
    "  - testsRequired: [context]",
    "  - summary: compact context",
    "  - description: |",
    "      ## Acceptance",
    "      - [ ] Keep task actionable",
    "      - [ ] Declare omissions",
    "",
    "      ## Decisions Taken",
    "      - [2026-08-15] Old decision",
    "      - [2026-08-17] New decision",
    ""
  ].join("\n"), "utf8")
  const handle = StoreHandle.open(root)
  try {
    handle.appendEvent({ eventType: "project.initialized", actor: "test", payload: {
      projectId: "p", boardTitle: "test", workDomains: [{ key: "TEST", description: "test" }], notesMarkdown: "", plansAuthority: "store"
    } })
    handle.appendEvent({ eventType: "task.upserted", actor: "test", payload: {
      task: task("T-002", null, "done"),
      detail: { taskId: "T-002", role: "backend", impact: "low", estimatedEffort: "1d", prerequisites: [], blocking: [], filesAffected: [], testsRequired: [], summary: "dep" },
      outgoingEdges: []
    } })
    handle.appendEvent({ eventType: "task.upserted", actor: "test", payload: {
      task: task("T-001"),
      detail: { taskId: "T-001", role: "backend", impact: "high", estimatedEffort: "1d", prerequisites: ["T-002"], blocking: [], filesAffected: ["packages/store"], testsRequired: ["context"], summary: "compact context" },
      outgoingEdges: [{ fromTaskId: "T-001", toTaskId: "T-002", kind: "depends-on" }]
    } })
    const shown = queryTask(handle.db, "T-001")
    assert.equal(shown.task.taskId, "T-001")
    assert.equal(shown.detail?.summary, "compact context")
    const first = queryTaskContext(handle.db, "T-001", { budget: 500, tasksRoot: root })
    const second = queryTaskContext(handle.db, "T-001", { budget: 500, tasksRoot: root })
    assert.deepEqual(first, second)
    assert.equal(first.tokenizer.method, "utf8-character-ceiling")
    assert.equal(first.provenance.acceptance, "git")
    assert.ok(first.acceptanceCriteria.length > 0)
    assert.deepEqual(first.unsatisfiedDependencies, [])

    const bounded = queryTaskContext(handle.db, "T-001", { budget: 40, tasksRoot: root })
    assert.ok(bounded.truncated.length > 0)
    assert.ok(bounded.truncated.some(item => item.section === "decisions" || item.section === "ancestors" || item.section === "detail"))
    assert.equal(bounded.budgetExceeded, true)
    assert.equal(bounded.minimumTokenCount, bounded.tokenCount)
    assert.equal(bounded.budgetOverrun, bounded.tokenCount - bounded.budget)
  } finally {
    handle.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
