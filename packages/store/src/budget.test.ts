import assert from "node:assert/strict"
import test from "node:test"
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { canonicalJson, formatMoney, PROTOCOL_SCHEMA_VERSION, type Budget, type CostEvent, type RunReceipt } from "@mapctx/protocol"
import { parseTaskDetailFile } from "@mapctx/core"
import { buildExport } from "./export"
import { repairStore } from "./repair"
import { StoreHandle } from "./store-handle"
import {
  bindProjectAccount,
  budgetScopeTaskIds,
  budgetStatus,
  recordAccountAdd,
  recordBudgetSet,
  resolveAccount,
  setProjectAccounts,
  unbindProjectAccount
} from "./budget"
import { getLatestBudgetFor, listPlanPeriods, listProjectAccountIds } from "./projections"
import { recordDispatchAttempt, recordPlanPeriod, recordRunReceipt } from "./dispatch"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

const NOW = "2026-09-06T12:00:00.000Z"

function seedTask(taskId: string, parentTaskId: string | null = null) {
  return {
    taskId,
    positionKey: Number(taskId.replace(/\D/g, "")),
    title: `Task ${taskId}`,
    planningState: "in-progress",
    executionState: "unclaimed",
    type: taskId.startsWith("E-") ? "epic" : "task",
    parentTaskId,
    tags: [],
    domains: ["TEST"],
    externalLinks: [],
    assignees: [],
    detailPath: null,
    updatedOn: "2026-09-06"
  }
}

function seedStore(): ReturnType<typeof StoreHandle.open> {
  const handle = StoreHandle.open(mkTmpDir("mapctx-store-budget-"))
  handle.appendEvent({
    eventType: "project.initialized",
    actor: "test",
    payload: {
      projectId: crypto.randomUUID(),
      boardTitle: "budget test board",
      workDomains: [{ key: "TEST", description: "test" }],
      notesMarkdown: "",
      plansAuthority: "store"
    }
  })
  return handle
}

function addTask(handle: ReturnType<typeof StoreHandle.open>, taskId: string, parentTaskId: string | null = null): void {
  handle.appendEvent({ eventType: "task.upserted", actor: "test", payload: { task: seedTask(taskId, parentTaskId) } })
}

function addDispatch(handle: ReturnType<typeof StoreHandle.open>, dispatchId: string, taskId: string): void {
  const result = recordDispatchAttempt(handle, {
    dispatchId,
    taskId,
    executorKind: "test",
    attempt: 1,
    contextHash: "h".repeat(64),
    status: "claimed"
  }, "test")
  assert.equal(result.ok, true)
}

function addReceipt(handle: ReturnType<typeof StoreHandle.open>, dispatchId: string, startedAt: string, endedAt: string): void {
  const receipt: RunReceipt = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    dispatchId,
    attempt: 1,
    outcome: "completed",
    startedAt,
    endedAt,
    changedFiles: [],
    usageEvents: [],
    evidence: [],
    failure: null
  }
  const result = recordRunReceipt(handle, receipt, "test", dispatchId)
  assert.equal(result.ok, true, `receipt rejected: ${JSON.stringify(result)}`)
}

function addCost(handle: ReturnType<typeof StoreHandle.open>, costEventId: string, dispatchId: string, fields: Partial<CostEvent> = {}): void {
  const cost: CostEvent = {
    costEventId,
    dispatchId,
    usageEventId: null,
    billingType: "metered_api",
    costStatus: "reported",
    cashCents: 0,
    shadowMicros: 0,
    allocatedMicros: null,
    planPeriodId: null,
    priceTableVersion: "test",
    appliedRateMicrosPerToken: 0,
    ...fields
  }
  handle.appendEvent({ eventType: "cost.recorded", actor: "test", payload: { cost } })
}

function moneyBudget(ownerId: string, amountMinor: number, decimals = 2): Budget {
  return {
    budgetId: crypto.randomUUID(),
    ownerKind: "epic",
    ownerId,
    unit: "money",
    money: { amountMinor, currency: "USD", decimals },
    minutes: null,
    periodStart: null,
    periodEnd: null,
    setAt: NOW,
    note: null
  }
}

test("accounts are event-sourced, resolvable by id or unique name, and duplicates are refused", () => {
  const handle = seedStore()
  let accountId = ""
  try {
    const added = recordAccountAdd(handle, {
      accountId: crypto.randomUUID(),
      name: "Codex Pro",
      currency: "USD",
      createdAt: NOW,
      note: "paguei $200 em 05/09"
    }, "test")
    assert.equal(added.ok, true)
    if (!added.ok) return
    accountId = added.account.accountId
    assert.equal(resolveAccount(handle.db, added.account.name)?.accountId, added.account.accountId)
    assert.equal(resolveAccount(handle.db, added.account.accountId)?.accountId, added.account.accountId)
    assert.equal(resolveAccount(handle.db, "missing"), undefined)

    const duplicate = recordAccountAdd(handle, { accountId: added.account.accountId, name: "Other", currency: "USD", createdAt: NOW, note: null }, "test")
    assert.deepEqual(duplicate, { ok: false, reason: "duplicate-account-id" })
  } finally {
    handle.close()
  }

  // repair replays the journal into fresh projections; the account survives
  assert.equal(repairStore(handle.storeDir).status, "ok")
  const reopened = StoreHandle.open(handle.storeDir)
  try {
    assert.equal(resolveAccount(reopened.db, accountId)?.name, "Codex Pro")
  } finally {
    reopened.close()
    cleanupDir(handle.storeDir)
  }
})

test("plan periods are account-scoped through the re-scoped projection", () => {
  const handle = seedStore();
  try {
    const account = recordAccountAdd(handle, { accountId: crypto.randomUUID(), name: "Claude Pro", currency: "USD", createdAt: NOW, note: null }, "test")
    assert.ok(account.ok)
    if (!account.ok) return
    const result = recordPlanPeriod(handle, {
      planPeriodId: crypto.randomUUID(),
      accountId: account.account.accountId,
      biller: "anthropic",
      planName: "pro",
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-09-30T23:59:59.000Z",
      fixedCents: 20000,
      seats: 1,
      status: "open"
    }, "test")
    assert.equal(result.ok, true)

    const stored = listPlanPeriods(handle.db, account.account.accountId)
    assert.equal(stored.length, 1)
    assert.equal(stored[0].accountId, account.account.accountId)
    assert.equal(listPlanPeriods(handle.db, crypto.randomUUID()).length, 0)
  } finally {
    handle.close()
    cleanupDir(handle.storeDir)
  }
})

test("projects declare which accounts they draw from (replace-all bindings)", () => {
  const handle = seedStore();
  try {
    const a = recordAccountAdd(handle, { accountId: crypto.randomUUID(), name: "A", currency: "USD", createdAt: NOW, note: null }, "test")
    const b = recordAccountAdd(handle, { accountId: crypto.randomUUID(), name: "B", currency: "USD", createdAt: NOW, note: null }, "test")
    assert.ok(a.ok && b.ok)
    if (!a.ok || !b.ok) return

    assert.throws(() => setProjectAccounts(handle, [crypto.randomUUID()], "test"), /unknown account/)

    bindProjectAccount(handle, a.account.accountId, "test")
    bindProjectAccount(handle, b.account.accountId, "test")
    assert.deepEqual(listProjectAccountIds(handle.db, "p"), [])
    const project = handle.db.prepare("SELECT project_id FROM project_projection LIMIT 1").get() as { project_id: string }
    assert.equal(listProjectAccountIds(handle.db, project.project_id).length, 2)

    unbindProjectAccount(handle, a.account.accountId, "test")
    assert.deepEqual(listProjectAccountIds(handle.db, project.project_id), [b.account.accountId])
  } finally {
    handle.close()
    cleanupDir(handle.storeDir)
  }
})

test("budget.set revisions keep history and latest-wins resolution is event-order correct", () => {
  const handle = seedStore();
  try {
    addTask(handle, "E-300", null)
    const first = moneyBudget("E-300", 10_000)
    const second = moneyBudget("E-300", 50_000)
    assert.deepEqual(recordBudgetSet(handle, first, "test"), { ok: true, budget: first })
    assert.deepEqual(recordBudgetSet(handle, second, "test"), { ok: true, budget: second })

    assert.equal(getLatestBudgetFor(handle.db, "epic", "E-300")?.budgetId, second.budgetId)
    const status = budgetStatus(handle.db, "epic", "E-300")
    assert.equal(status.plannedMoney?.amountMinor, 50_000)
    assert.equal(formatMoney(status.plannedMoney!), "500.00 USD")

    assert.deepEqual(recordBudgetSet(handle, moneyBudget("E-999", 1), "test"), { ok: false, reason: "unknown-owner" })
    assert.throws(() => recordBudgetSet(handle, { ...moneyBudget("E-300", 1), money: null }, "test"), /Invalid Budget/)
  } finally {
    handle.close()
    cleanupDir(handle.storeDir)
  }
})

test("budget scope for epics is transitive descendants; project scope is every task", () => {
  const handle = seedStore();
  try {
    addTask(handle, "E-310", null)
    addTask(handle, "T-311", "E-310")
    addTask(handle, "T-312", "T-311")
    addTask(handle, "T-313", null)
    assert.deepEqual(budgetScopeTaskIds(handle.db, "epic", "E-310"), ["T-311", "T-312"])
    assert.deepEqual(budgetScopeTaskIds(handle.db, "epic", "T-313"), [])
    assert.deepEqual(budgetScopeTaskIds(handle.db, "project", "p").length, 4)
  } finally {
    handle.close()
    cleanupDir(handle.storeDir)
  }
})

test("money rollup: cash plus allocated count, unpriced stays unattributed, coverage degrades honestly", () => {
  const handle = seedStore();
  try {
    addTask(handle, "E-320", null)
    addTask(handle, "T-321", "E-320")
    addTask(handle, "T-322", "E-320")
    recordBudgetSet(handle, moneyBudget("E-320", 10_000), "test")

    // $50 metered cash + $20 allocated plan share; $10 unpriced row
    addDispatch(handle, crypto.randomUUID(), "T-321")
    const d1 = handle.db.prepare("SELECT dispatch_id FROM dispatch_projection WHERE task_id = 'T-321'").get() as { dispatch_id: string }
    addDispatch(handle, crypto.randomUUID(), "T-322")
    const d2 = handle.db.prepare("SELECT dispatch_id FROM dispatch_projection WHERE task_id = 'T-322'").get() as { dispatch_id: string }
    addCost(handle, crypto.randomUUID(), d1.dispatch_id, { cashCents: 5000, costStatus: "reported" })
    addCost(handle, crypto.randomUUID(), d2.dispatch_id, { allocatedMicros: 20_000_000, costStatus: "allocated" })
    addCost(handle, crypto.randomUUID(), d2.dispatch_id, { costStatus: "unpriced", shadowMicros: 10_000_000 })

    const status = budgetStatus(handle.db, "epic", "E-320")
    assert.equal(status.consumed.decimals, 6, "consumption rolls up in the micros grid")
    assert.equal(status.consumed.consumedMinor, 70_000_000, "50 USD cash + 20 USD allocated = 70 USD at 6 decimals")
    assert.equal(status.consumed.coverage, "full")
    assert.equal(status.consumed.reason, null)
    assert.equal(status.remainingMinor, 30_000_000)
    assert.equal(status.spentBp, 7_000)

    // Overrun renders negative remaining without clamping -- and never mutates
    recordBudgetSet(handle, moneyBudget("E-320", 1_000), "test")
    const eventsBefore = handle.listEvents().length
    const overrun = budgetStatus(handle.db, "epic", "E-320")
    assert.equal(overrun.remainingMinor, -60_000_000)
    assert.equal(overrun.spentBp, 70_000)
    assert.equal(handle.listEvents().length, eventsBefore, "budgetStatus must not append events")
  } finally {
    handle.close()
    cleanupDir(handle.storeDir)
  }
})

test("honest no-data states: no dispatches, empty usage/cost data, unattributed, cross-currency", () => {
  const handle = seedStore();
  try {
    addTask(handle, "E-330", null)
    addTask(handle, "T-331", "E-330")
    recordBudgetSet(handle, moneyBudget("E-330", 10_000), "test")

    // No dispatches at all.
    const noDispatches = budgetStatus(handle.db, "epic", "E-330").consumed
    assert.equal(noDispatches.coverage, "no-data")
    assert.equal(noDispatches.reason, "no-dispatches")

    // Dispatch exists but today's harness exposes no tokens: no cost rows.
    addDispatch(handle, crypto.randomUUID(), "T-331")
    const noCostData = budgetStatus(handle.db, "epic", "E-330").consumed
    assert.equal(noCostData.coverage, "no-data")
    assert.equal(noCostData.reason, "no-cost-data")
    assert.equal(noCostData.consumedMinor, 0)

    // Cost rows exist but none carry real money (all unpriced): still no-data,
    // explicitly unattributed -- never a measured-looking zero.
    const d = handle.db.prepare("SELECT dispatch_id FROM dispatch_projection WHERE task_id = 'T-331'").get() as { dispatch_id: string }
    addCost(handle, crypto.randomUUID(), d.dispatch_id, { costStatus: "unpriced", shadowMicros: 5_000_000 })
    const unattributed = budgetStatus(handle.db, "epic", "E-330").consumed
    assert.equal(unattributed.coverage, "no-data")
    assert.equal(unattributed.reason, "unattributed-cost")

    // Cross-currency budgets never auto-convert (decision D1).
    recordBudgetSet(handle, { ...moneyBudget("E-330", 50_000), money: { amountMinor: 50_000, currency: "BRL", decimals: 2 } }, "test")
    const crossCurrency = budgetStatus(handle.db, "epic", "E-330").consumed
    assert.equal(crossCurrency.coverage, "no-data")
    assert.equal(crossCurrency.reason, "cross-currency-manual")
  } finally {
    handle.close()
    cleanupDir(handle.storeDir)
  }
})

test("time rollup consumes receipt wall clock and reports its basis", () => {
  const handle = seedStore();
  try {
    addTask(handle, "E-340", null)
    addTask(handle, "T-341", "E-340")
    recordBudgetSet(handle, {
      budgetId: crypto.randomUUID(),
      ownerKind: "epic",
      ownerId: "E-340",
      unit: "time",
      money: null,
      minutes: 60,
      periodStart: null,
      periodEnd: null,
      setAt: NOW,
      note: null
    }, "test")

    const beforeDispatch = budgetStatus(handle.db, "epic", "E-340").consumed
    assert.equal(beforeDispatch.coverage, "no-data")
    assert.equal(beforeDispatch.reason, "no-dispatches")

    addDispatch(handle, crypto.randomUUID(), "T-341")
    const d = handle.db.prepare("SELECT dispatch_id FROM dispatch_projection WHERE task_id = 'T-341'").get() as { dispatch_id: string }
    const beforeReceipts = budgetStatus(handle.db, "epic", "E-340").consumed
    assert.equal(beforeReceipts.coverage, "no-data")
    assert.equal(beforeReceipts.reason, "no-receipt-data")

    addReceipt(handle, d.dispatch_id, "2026-09-06T10:00:00.000Z", "2026-09-06T10:15:00.000Z")

    const status = budgetStatus(handle.db, "epic", "E-340")
    assert.equal(status.consumed.consumedMs, 15 * 60_000)
    assert.equal(status.consumed.coverage, "full")
    assert.equal(status.remainingMs, 45 * 60_000)
    assert.equal(status.spentBp, 2_500)
    assert.equal(handle.listEvents().length > 0, true)
  } finally {
    handle.close()
    cleanupDir(handle.storeDir)
  }
})

// R15: dated money budgets cannot be attributed (CostEvent has no occurrence
// timestamp), so the write path refuses them instead of misreporting.
test("R15: dated money budgets are refused at budget.set", () => {
  const handle = seedStore();
  try {
    addTask(handle, "E-345", null)
    assert.throws(
      () => recordBudgetSet(handle, { ...moneyBudget("E-345", 10_000), periodStart: "2026-09-01", periodEnd: "2026-09-30" }, "test"),
      /Dated money budgets are not supported/
    )
    // Undated money budgets keep working.
    const undated = moneyBudget("E-345", 10_000)
    assert.deepEqual(recordBudgetSet(handle, undated, "test"), { ok: true, budget: undated })
  } finally {
    handle.close()
    cleanupDir(handle.storeDir)
  }
})

// R15: dated time budgets attribute receipts by interval intersection --
// only the in-period span of each receipt counts, receipts entirely outside
// the window contribute zero and are not attributed.
test("R15: dated time budgets consume only the receipt/period intersection", () => {
  const handle = seedStore();
  try {
    addTask(handle, "E-346", null)
    addTask(handle, "T-347", "E-346")
    recordBudgetSet(handle, {
      budgetId: crypto.randomUUID(),
      ownerKind: "epic",
      ownerId: "E-346",
      unit: "time",
      money: null,
      minutes: 60,
      periodStart: "2026-09-02",
      periodEnd: "2026-10-01",
      setAt: NOW,
      note: null
    }, "test")

    // One dispatch per receipt (a second receipt on the same attempt is a
    // duplicate, and a completed task refuses a new dispatch) -- three child
    // tasks, each with its own dispatch and receipt.
    const tasks = ["T-357", "T-358", "T-359"]
    const dispatchIds = tasks.map((taskId, index) => {
      addTask(handle, taskId, "E-346")
      addDispatch(handle, crypto.randomUUID(), taskId)
      return (handle.db.prepare("SELECT dispatch_id FROM dispatch_projection WHERE task_id = ?").get(taskId) as { dispatch_id: string }).dispatch_id
    })

    // Before the period: contributes nothing, not attributed.
    addReceipt(handle, dispatchIds[0], "2026-09-01T10:00:00.000Z", "2026-09-01T10:20:00.000Z")
    // Inside the period: full 30 minutes.
    addReceipt(handle, dispatchIds[1], "2026-09-10T08:00:00.000Z", "2026-09-10T08:30:00.000Z")
    // Straddling the period end (Oct 1 00:00 UTC): only the in-period 5 minutes count.
    addReceipt(handle, dispatchIds[2], "2026-09-30T23:55:00.000Z", "2026-10-01T00:05:00.000Z")

    const status = budgetStatus(handle.db, "epic", "E-346")
    assert.equal(status.consumed.consumedMs, 35 * 60_000, "30 in-period + 5 in-period straddle")
    assert.equal(status.consumed.coverage, "partial", "outside-period receipt is not attributed")
    assert.equal(status.consumed.reason, "partial-receipt-coverage")
    assert.equal(status.remainingMs, 25 * 60_000)

    // Undated budget on the same store still reports the lifetime sum.
    recordBudgetSet(handle, {
      budgetId: crypto.randomUUID(),
      ownerKind: "epic",
      ownerId: "E-346",
      unit: "time",
      money: null,
      minutes: 120,
      periodStart: null,
      periodEnd: null,
      setAt: NOW,
      note: null
    }, "test")
    const lifetime = budgetStatus(handle.db, "epic", "E-346")
    assert.equal(lifetime.consumed.consumedMs, 60 * 60_000, "20 + 30 + 10 lifetime minutes")
  } finally {
    handle.close()
    cleanupDir(handle.storeDir)
  }
})

// R16 signed-cost policy: negative values are credits; they net into the sum
// signed and count as attribution. Allocated and reported follow one policy.
test("R16: negative costs net as credits with sign-independent coverage", () => {
  const handle = seedStore();
  try {
    addTask(handle, "E-348", null)
    addTask(handle, "T-349", "E-348")
    recordBudgetSet(handle, moneyBudget("E-348", 10_000), "test")

    addDispatch(handle, crypto.randomUUID(), "T-349")
    const d = handle.db.prepare("SELECT dispatch_id FROM dispatch_projection WHERE task_id = 'T-349'").get() as { dispatch_id: string }
    // Reported $10 charge and a reported $5 credit on the SAME dispatch must
    // net to $5 (the old code yielded $10, ignoring the credit entirely).
    addCost(handle, crypto.randomUUID(), d.dispatch_id, { cashCents: 1000, costStatus: "reported" })
    addCost(handle, crypto.randomUUID(), d.dispatch_id, { cashCents: -500, costStatus: "reported" })

    const cashNet = budgetStatus(handle.db, "epic", "E-348")
    assert.equal(cashNet.consumed.consumedMinor, 5_000_000, "10 USD - 5 USD credit = 5 USD")
    assert.equal(cashNet.consumed.coverage, "full", "a credit row is still measured data")
    assert.equal(cashNet.remainingMinor, 95_000_000, "planned 100 USD minus 5 USD net spent")

    // Allocated negatives follow the same policy.
    recordBudgetSet(handle, { ...moneyBudget("E-348", 10_000), budgetId: crypto.randomUUID() }, "test")
    addCost(handle, crypto.randomUUID(), d.dispatch_id, { allocatedMicros: 8_000_000, costStatus: "allocated" })
    addCost(handle, crypto.randomUUID(), d.dispatch_id, { allocatedMicros: -3_000_000, costStatus: "allocated" })
    const allocatedNet = budgetStatus(handle.db, "epic", "E-348")
    assert.equal(allocatedNet.consumed.consumedMinor, 10_000_000, "5 USD net cash + 8 USD - 3 USD allocated")
  } finally {
    handle.close()
    cleanupDir(handle.storeDir)
  }
})

// R7: rollup accumulation throws beyond the safe-integer range instead of
// silently wrapping the aggregate.
test("R7: money rollup refuses aggregates beyond safe-integer range", () => {
  const handle = seedStore();
  try {
    addTask(handle, "E-355", null)
    addTask(handle, "T-356", "E-355")
    recordBudgetSet(handle, { ...moneyBudget("E-355", 10_000), money: { amountMinor: 10_000, currency: "USD", decimals: 2 } }, "test")

    addDispatch(handle, crypto.randomUUID(), "T-356")
    const d = handle.db.prepare("SELECT dispatch_id FROM dispatch_projection WHERE task_id = 'T-356'").get() as { dispatch_id: string }
    // Each row converts safely on its own (micros pass through at grid 6), but
    // their SUM exceeds Number.MAX_SAFE_INTEGER -- accumulation must refuse.
    addCost(handle, crypto.randomUUID(), d.dispatch_id, { allocatedMicros: 8_000_000_000_000_000, costStatus: "reported", cashCents: 0 })
    addCost(handle, crypto.randomUUID(), d.dispatch_id, { allocatedMicros: 8_000_000_000_000_000, costStatus: "reported", cashCents: 0 })

    assert.throws(() => budgetStatus(handle.db, "epic", "E-355"), /safe-integer range/)
  } finally {
    handle.close()
    cleanupDir(handle.storeDir)
  }
})

test("rollup determinism: status JSON is byte-identical across reads and after full journal rebuild", () => {
  const handle = seedStore()
  let first = ""
  try {
    addTask(handle, "E-350", null)
    addTask(handle, "T-351", "E-350")
    addTask(handle, "T-352", "E-350")
    recordBudgetSet(handle, moneyBudget("E-350", 100_000), "test")
    addDispatch(handle, crypto.randomUUID(), "T-351")
    const d1 = handle.db.prepare("SELECT dispatch_id FROM dispatch_projection WHERE task_id = 'T-351'").get() as { dispatch_id: string }
    addDispatch(handle, crypto.randomUUID(), "T-352")
    const d2 = handle.db.prepare("SELECT dispatch_id FROM dispatch_projection WHERE task_id = 'T-352'").get() as { dispatch_id: string }
    addCost(handle, crypto.randomUUID(), d1.dispatch_id, { cashCents: 12_345, costStatus: "reported" })
    addCost(handle, crypto.randomUUID(), d2.dispatch_id, { allocatedMicros: 1_111_111, costStatus: "allocated" })
    addReceipt(handle, d1.dispatch_id, "2026-09-06T08:00:00.000Z", "2026-09-06T08:30:00.000Z")

    first = canonicalJson(budgetStatus(handle.db, "epic", "E-350"))
    const second = canonicalJson(budgetStatus(handle.db, "epic", "E-350"))
    assert.equal(first, second)
  } finally {
    handle.close()
  }

  assert.equal(repairStore(handle.storeDir).status, "ok")
  const reopened = StoreHandle.open(handle.storeDir)
  try {
    const afterRepair = canonicalJson(budgetStatus(reopened.db, "epic", "E-350"))
    assert.equal(first, afterRepair, "rollup must be identical after a full projection rebuild")
  } finally {
    reopened.close()
    cleanupDir(handle.storeDir)
  }
})

test("epic detail export carries the generated budget projection, round-trip stable", () => {
  const root = mkTmpDir("mapctx-store-budget-export-")
  const handle = StoreHandle.open(root);
  try {
    handle.appendEvent({
      eventType: "project.initialized",
      actor: "test",
      payload: {
        projectId: crypto.randomUUID(),
        boardTitle: "budget export",
        workDomains: [],
        notesMarkdown: "",
        plansAuthority: "store"
      }
    })
    const epic = { ...seedTask("E-360", null), detailPath: "./tasks/E-360.md" }
    handle.appendEvent({
      eventType: "task.upserted",
      actor: "test",
      payload: {
        task: epic,
        detail: { taskId: "E-360", role: "coordination", impact: "high", estimatedEffort: "2w", prerequisites: [], blocking: [], filesAffected: [], testsRequired: [], summary: "epic" }
      }
    })
    fs.mkdirSync(path.join(root, "tasks"), { recursive: true })
    const detailPath = path.join(root, "tasks", "E-360.md")
    fs.writeFileSync(detailPath, [
      "# E-360",
      "",
      "  - role: coordination",
      "  - impact: high",
      "  - estimatedEffort: 2w",
      "  - prerequisites: []",
      "  - blocking: []",
      "  - filesAffected: []",
      "  - testsRequired: []",
      "  - summary: epic",
      "  - description: |",
      "      Prose that must survive regeneration.",
      ""
    ].join("\n"), "utf8")

    // No budget yet: export has no budget section at all.
    const before = buildExport(handle.db, { tasksRoot: root })
    assert.equal(before.taskDetailFiles[0].content.includes("budgetUnit"), false)

    recordBudgetSet(handle, moneyBudget("E-360", 20_000), "test")
    const withBudget = buildExport(handle.db, { tasksRoot: root })
    const content = withBudget.taskDetailFiles[0].content
    assert.ok(content.includes("  - budgetUnit: money"))
    assert.ok(content.includes("  - budgetPlanned: 200.00 USD"))
    assert.ok(content.includes("  - budgetCoverage:"))

    // Second export is byte-identical and the description prose survives.
    const again = buildExport(handle.db, { tasksRoot: root })
    assert.equal(again.taskDetailFiles[0].content, content)
    assert.equal(parseTaskDetailFile(content).description, "Prose that must survive regeneration.")
  } finally {
    handle.close()
    cleanupDir(root)
  }
})
