import {
  budgetSchema,
  centsToMinorUnits,
  microsToMinorUnits,
  type Account,
  type Budget,
  type BudgetConsumed,
  type Money
} from "@mapctx/protocol"
import {
  getAccount,
  getLatestBudgetFor,
  getSingleProject,
  getTask,
  listAccounts,
  listBudgets,
  listPlanPeriods,
  listProjectAccountIds,
  listRunReceipts,
  listTasks,
  setProjectAccountBindings
} from "./projections"
import type { DatabaseSync } from "node:sqlite"
import { StoreHandle } from "./store-handle"

export type BudgetOwnerKind = Budget["ownerKind"];

// ---- writes ----

export type AccountWriteResult =
  | { ok: true; account: Account }
  | { ok: false; reason: "duplicate-account-id" }

export function recordAccountAdd(
  store: StoreHandle,
  input: { accountId: string; name: string; currency: string; createdAt: string; note: string | null },
  actor = "store"
): AccountWriteResult {
  if (store.db.prepare("SELECT 1 FROM account_projection WHERE account_id = ?").get(input.accountId)) {
    return { ok: false, reason: "duplicate-account-id" };
  }
  const account: Account = { ...input };
  return store.runInWriteTransaction(append => {
    append({ eventType: "account.added", actor, payload: { account } });
    return { ok: true, account };
  });
}

/**
 * Replace-all declaration of which accounts this store's project draws from
 * (project.accounts-set). Unknown account ids are refused up front: a binding
 * to an account that does not exist would silently strand its plan fees
 * outside every rollup.
 */
export function setProjectAccounts(store: StoreHandle, accountIds: string[], actor = "store"): { ok: true; accountIds: string[] } {
  const project = getSingleProject(store.db);
  if (!project) throw new Error("Cannot bind accounts: no project initialized in this store.");
  for (const accountId of accountIds) {
    if (!getAccount(store.db, accountId)) {
      throw new Error(`Cannot bind unknown account: ${accountId}`);
    }
  }
  return store.runInWriteTransaction(append => {
    append({ eventType: "project.accounts-set", actor, payload: { projectId: project.projectId, accountIds } });
    return { ok: true, accountIds };
  });
}

export function bindProjectAccount(store: StoreHandle, accountId: string, actor = "store"): { ok: true; accountIds: string[] } {
  const project = getSingleProject(store.db);
  if (!project) throw new Error("Cannot bind accounts: no project initialized in this store.");
  const current = listProjectAccountIds(store.db, project.projectId);
  if (current.includes(accountId)) return { ok: true, accountIds: current };
  return setProjectAccounts(store, [...current, accountId], actor);
}

export function unbindProjectAccount(store: StoreHandle, accountId: string, actor = "store"): { ok: true; accountIds: string[] } {
  const project = getSingleProject(store.db);
  if (!project) throw new Error("Cannot bind accounts: no project initialized in this store.");
  const current = listProjectAccountIds(store.db, project.projectId);
  return setProjectAccounts(store, current.filter(id => id !== accountId), actor);
}

export type BudgetWriteResult =
  | { ok: true; budget: Budget }
  | { ok: false; reason: "unknown-owner" }

/**
 * Appends one budget.set event. Revisions/top-ups are new events -- history
 * lives in the log, the projection resolves latest-wins by event order.
 */
export function recordBudgetSet(
  store: StoreHandle,
  rawBudget: Budget,
  actor = "store"
): BudgetWriteResult {
  const parsed = budgetSchema.safeParse(rawBudget);
  if (!parsed.success) throw new Error(`Invalid Budget: ${parsed.error.message}`);
  const budget = parsed.data;
  return store.runInWriteTransaction(append => {
    if (budget.ownerKind === "epic" && !getTask(store.db, budget.ownerId)) {
      return { ok: false, reason: "unknown-owner" };
    }
    if (budget.ownerKind === "project" && !getSingleProject(store.db)) {
      return { ok: false, reason: "unknown-owner" };
    }
    append({ eventType: "budget.set", actor, payload: { budget } });
    return { ok: true, budget };
  });
}

// ---- reads ----

export function resolveAccount(db: DatabaseSync, idOrName: string): Account | undefined {
  const byId = getAccount(db, idOrName);
  if (byId) return byId;
  const matches = listAccounts(db).filter(account => account.name === idOrName);
  if (matches.length === 1) return matches[0];
  return undefined;
}

/**
 * Rollup scope: for an epic every task descending from it (transitive through
 * parentTaskId); for a project every task in the store. Output is sorted by
 * taskId so aggregates are byte-identical on repeated runs and rebuilds.
 */
export function budgetScopeTaskIds(db: DatabaseSync, ownerKind: BudgetOwnerKind, ownerId: string): string[] {
  const tasks = listTasks(db);
  if (ownerKind === "project") {
    return tasks.map(task => task.taskId).sort();
  }
  const childrenByParent = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.parentTaskId) continue;
    const list = childrenByParent.get(task.parentTaskId) ?? [];
    list.push(task.taskId);
    childrenByParent.set(task.parentTaskId, list);
  }
  const scope: string[] = [];
  const queue = [ownerId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const childId of childrenByParent.get(current) ?? []) {
      scope.push(childId);
      queue.push(childId);
    }
  }
  return [...new Set(scope)].sort();
}

function noConsumedData(unit: Budget["unit"], reason: string, planned?: Money | null): BudgetConsumed {
  return {
    unit,
    currency: planned?.currency ?? null,
    decimals: planned ? Math.max(planned.decimals, 6) : null,
    consumedMinor: unit === "money" ? 0 : null,
    consumedMs: unit === "time" ? 0 : null,
    coverage: "no-data",
    reason,
    scopedDispatches: 0,
    unattributedDispatches: 0
  };
}

/**
 * Money consumption per the budget.consumed derivation spec (see
 * budgetConsumedSchema in @mapctx/protocol). Everything is summed in the
 * FINER of (budget decimals, 6) minor-unit grid so conversions from cents
 * and micros are exact upward scalings -- sub-cent allocation micros are
 * routine and must never be rounded away. Cash and allocated amounts roll
 * into that grid; everything else is reported as unattributed, never as
 * measured zeros. Only USD auto-rolls: cashCents/cost micros are
 * USD-denominated, so any other budget currency degrades to a no-data state
 * with an explicit manual-conversion reason.
 */
export function rollupMoneyConsumed(db: DatabaseSync, taskIds: string[], planned: Money): BudgetConsumed {
  if (planned.currency !== "USD") {
    return noConsumedData("money", "cross-currency-manual", planned);
  }
  const grid = Math.max(planned.decimals, 6);
  const dispatches = scopedDispatches(db, taskIds);
  if (dispatches.length === 0) {
    return noConsumedData("money", "no-dispatches", planned);
  }
  const placeholders = dispatches.map(() => "?").join(", ");
  const costRows = db.prepare(
    `SELECT dispatch_id, cash_cents, allocated_micros, cost_status
     FROM cost_event_projection WHERE dispatch_id IN (${placeholders})
     ORDER BY cost_event_id ASC`
  ).all(...dispatches) as Array<{ dispatch_id: string; cash_cents: number; allocated_micros: number | null; cost_status: string }>;
  if (costRows.length === 0) {
    return noConsumedData("money", "no-cost-data", planned);
  }

  let consumedMinor = 0;
  const attributedDispatches = new Set<string>();
  for (const row of costRows) {
    const cashAttributed = row.cost_status === "reported" && row.cash_cents > 0;
    const allocatedAttributed = row.allocated_micros !== null && row.allocated_micros > 0;
    if (cashAttributed) consumedMinor += centsToMinorUnits(row.cash_cents, grid);
    if (row.allocated_micros !== null) consumedMinor += microsToMinorUnits(row.allocated_micros, grid);
    if (cashAttributed || allocatedAttributed) attributedDispatches.add(row.dispatch_id);
  }
  const unattributed = dispatches.length - attributedDispatches.size;
  const coverage = attributedDispatches.size === 0
    ? "no-data"
    : unattributed > 0
      ? "partial"
      : "full";
  return {
    unit: "money",
    currency: planned.currency,
    decimals: grid,
    consumedMinor,
    consumedMs: null,
    coverage,
    reason: attributedDispatches.size === 0
      ? "unattributed-cost"
      : unattributed > 0
        ? "partial-cost-coverage"
        : null,
    scopedDispatches: dispatches.length,
    unattributedDispatches: unattributed
  };
}

/**
 * Time consumption from accepted receipts (wall-clock basis: endedAt -
 * startedAt). activeTime is not persisted per run yet, so the output labels
 * this basis through the reason field rather than implying measured active
 * time.
 */
export function rollupTimeConsumed(db: DatabaseSync, taskIds: string[]): BudgetConsumed {
  const dispatches = scopedDispatches(db, taskIds);
  if (dispatches.length === 0) {
    return noConsumedData("time", "no-dispatches");
  }
  const placeholders = dispatches.map(() => "?").join(", ");
  const receipts = listRunReceipts(db).filter(receipt =>
    dispatches.includes(receipt.dispatchId) &&
    (receipt.outcome === "completed" || receipt.outcome === "failed" || receipt.outcome === "blocked" || receipt.outcome === "cancelled")
  );
  const receiptsByDispatch = new Map<string, number>();
  let consumedMs = 0;
  for (const receipt of receipts) {
    const deltaMs = Date.parse(receipt.endedAt) - Date.parse(receipt.startedAt);
    if (deltaMs > 0) {
      consumedMs += deltaMs;
      receiptsByDispatch.set(receipt.dispatchId, (receiptsByDispatch.get(receipt.dispatchId) ?? 0) + deltaMs);
    }
  }
  const attributed = receiptsByDispatch.size;
  const unattributed = dispatches.length - attributed;
  const coverage = receipts.length === 0
    ? "no-data"
    : attributed === 0
      ? "no-data"
      : unattributed > 0
        ? "partial"
        : "full";
  return {
    unit: "time",
    currency: null,
    decimals: null,
    consumedMinor: null,
    consumedMs,
    coverage,
    reason: receipts.length === 0
      ? "no-receipt-data"
      : attributed === 0
        ? "no-positive-receipt-intervals"
        : unattributed > 0
          ? "partial-receipt-coverage"
          : null,
    scopedDispatches: dispatches.length,
    unattributedDispatches: unattributed
  };
}

function scopedDispatches(db: DatabaseSync, taskIds: string[]): string[] {
  if (taskIds.length === 0) return [];
  const placeholders = taskIds.map(() => "?").join(", ");
  const rows = db.prepare(
    `SELECT DISTINCT dispatch_id FROM dispatch_projection WHERE task_id IN (${placeholders}) ORDER BY dispatch_id ASC`
  ).all(...taskIds) as Array<{ dispatch_id: string }>;
  return rows.map(row => row.dispatch_id);
}

export type BudgetStatus = {
  ownerKind: BudgetOwnerKind;
  ownerId: string;
  hasBudget: boolean;
  budgetId: string | null;
  unit: Budget["unit"] | null;
  plannedMoney: Money | null;
  plannedMinutes: number | null;
  consumed: BudgetConsumed;
  remainingMinor: number | null;
  remainingMs: number | null;
  /** Basis points, floor(consumed/planned*10000); null when no budget or planned 0. */
  spentBp: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  setAt: string | null;
};

const NO_BUDGET_STATUS: Omit<BudgetStatus, "ownerKind" | "ownerId" | "consumed"> = {
  hasBudget: false,
  budgetId: null,
  unit: null,
  plannedMoney: null,
  plannedMinutes: null,
  remainingMinor: null,
  remainingMs: null,
  spentBp: null,
  periodStart: null,
  periodEnd: null,
  setAt: null
};

/**
 * Pure read: planned (latest budget) vs consumed (cost/receipt rollup). A
 * spent-over-planned budget renders negative remaining; it is never clamped,
 * and computing a status never writes an event.
 */
export function budgetStatus(db: DatabaseSync, ownerKind: BudgetOwnerKind, ownerId: string): BudgetStatus {
  const budget = getLatestBudgetFor(db, ownerKind, ownerId);
  const taskIds = budgetScopeTaskIds(db, ownerKind, ownerId);
  const consumed = budget?.unit === "time"
    ? rollupTimeConsumed(db, taskIds)
    : rollupMoneyConsumed(db, taskIds, budget?.money ?? { amountMinor: 0, currency: "USD", decimals: 2 });

  if (!budget) {
    return { ...NO_BUDGET_STATUS, ownerKind, ownerId, consumed };
  }
  if (budget.unit === "money") {
    const plannedMoney = budget.money ?? { amountMinor: 0, currency: "USD", decimals: 2 };
    const grid = consumed.decimals ?? Math.max(plannedMoney.decimals, 6);
    const plannedGridMinor = plannedMoney.amountMinor * 10 ** (grid - plannedMoney.decimals);
    const spent = consumed.consumedMinor ?? 0;
    return {
      ...NO_BUDGET_STATUS,
      ownerKind,
      ownerId,
      hasBudget: true,
      budgetId: budget.budgetId,
      unit: "money",
      plannedMoney,
      consumed,
      remainingMinor: plannedGridMinor - spent,
      spentBp: plannedGridMinor > 0 ? Math.floor((spent * 10_000) / plannedGridMinor) : null,
      periodStart: budget.periodStart,
      periodEnd: budget.periodEnd,
      setAt: budget.setAt
    };
  }
  const plannedMs = (budget.minutes ?? 0) * 60_000;
  const spentMs = consumed.consumedMs ?? 0;
  return {
    ...NO_BUDGET_STATUS,
    ownerKind,
    ownerId,
    hasBudget: true,
    budgetId: budget.budgetId,
    unit: "time",
    plannedMinutes: budget.minutes,
    consumed,
    remainingMs: plannedMs - spentMs,
    spentBp: plannedMs > 0 ? Math.floor((spentMs * 10_000) / plannedMs) : null,
    periodStart: budget.periodStart,
    periodEnd: budget.periodEnd,
    setAt: budget.setAt
  };
}

export {
  getAccount,
  getLatestBudgetFor,
  listAccounts,
  listBudgets,
  listPlanPeriods,
  listProjectAccountIds
};
