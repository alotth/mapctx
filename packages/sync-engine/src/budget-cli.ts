import * as crypto from 'crypto';
import {
  bindProjectAccount,
  budgetStatus,
  getSingleProject,
  listAccounts,
  listBudgets,
  listPlanPeriods,
  recordAccountAdd,
  recordBudgetSet,
  recordPlanPeriod,
  resolveAccount,
  unbindProjectAccount,
  StoreHandle
} from '@mapctx/store';
import { DEFAULT_CURRENCY, formatMoney, parseMoneyAmount, type Account, type Budget } from '@mapctx/protocol';
import { regenerateCanonicalFilesSafe, requireStoreAuthorityForBudget, type BudgetCliOptions } from './budget-cli-support';

function print(value: unknown, json?: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function isoDateTime(value: string, edge: 'start' | 'end'): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return edge === 'start' ? `${value}T00:00:00.000Z` : `${value}T23:59:59.000Z`;
  }
  return value;
}

function requireAccount(handle: StoreHandle, idOrName: string): Account {
  const account = resolveAccount(handle.db, idOrName);
  if (!account) {
    const byName = listAccounts(handle.db).filter(a => a.name === idOrName);
    if (byName.length > 1) {
      throw new Error(`Account name "${idOrName}" is ambiguous (${byName.length} accounts). Use the account id.`);
    }
    throw new Error(`Unknown account: ${idOrName}. Add one first with \`mapctx account add "${idOrName}"\`.`);
  }
  return account;
}

function countDecimals(text: string): number {
  const dot = text.trim().indexOf('.');
  return dot === -1 ? 0 : text.trim().length - dot - 1;
}

export function accountAddCommand(name: string | undefined, options: BudgetCliOptions): void {
  if (!name) throw new Error('Usage: mapctx account add <name> [--currency USD] [--note text] [--json]');
  const currency = options.currency ?? DEFAULT_CURRENCY;
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`--currency must be an ISO-4217 alpha-3 code, got: ${currency}`);
  const { handle } = requireStoreAuthorityForBudget(process.cwd());
  try {
    const result = recordAccountAdd(handle, {
      accountId: crypto.randomUUID(),
      name,
      currency,
      createdAt: new Date().toISOString(),
      note: options.note ?? null
    }, options.actor ?? 'cli');
    if (!result.ok) throw new Error(`Account add refused: ${result.reason}`);
    print({ ok: true, account: result.account }, options.json);
  } finally {
    handle.close();
  }
}

export function accountListCommand(options: BudgetCliOptions): void {
  const { handle } = requireStoreAuthorityForBudget(process.cwd());
  try {
    const accounts = listAccounts(handle.db).map(account => ({
      ...account,
      planPeriods: listPlanPeriods(handle.db, account.accountId).length
    }));
    print({ ok: true, accounts }, options.json);
  } finally {
    handle.close();
  }
}

export function accountBindCommand(idOrName: string | undefined, options: BudgetCliOptions): void {
  if (!idOrName) throw new Error('Usage: mapctx account bind <account-id-or-name> [--remove] [--json]');
  const { handle } = requireStoreAuthorityForBudget(process.cwd());
  try {
    const account = requireAccount(handle, idOrName);
    const result = options.remove
      ? unbindProjectAccount(handle, account.accountId, options.actor ?? 'cli')
      : bindProjectAccount(handle, account.accountId, options.actor ?? 'cli');
    print({ ok: true, accountId: account.accountId, boundAccountIds: result.accountIds }, options.json);
  } finally {
    handle.close();
  }
}

export function planPeriodRecordCommand(options: BudgetCliOptions): void {
  if (!options.account) throw new Error('plan-period record requires --account <id-or-name>');
  if (options.amount === undefined) throw new Error('plan-period record requires --amount <decimal>');
  if (!options.start) throw new Error('plan-period record requires --start <date|datetime>');
  if (!options.end) throw new Error('plan-period record requires --end <date|datetime>');
  const { handle } = requireStoreAuthorityForBudget(process.cwd());
  try {
    const account = requireAccount(handle, options.account);
    const currency = options.currency ?? account.currency;
    if (currency !== account.currency) throw new Error('plan-period currency must match account currency');
    if (currency !== 'USD') throw new Error('plan-period recording supports USD only until native currency conversion is supported');
    const money = parseMoneyAmount(options.amount, currency, countDecimals(options.amount));
    if (money.decimals > 2) {
      throw new Error('plan periods are recorded against fixedCents (2 decimals max); use at most cents precision');
    }
    const fixedCents = money.amountMinor * 10 ** (2 - money.decimals);
    const result = recordPlanPeriod(handle, {
      planPeriodId: crypto.randomUUID(),
      accountId: account.accountId,
      biller: account.name,
      planName: options.planName ?? account.name,
      periodStart: isoDateTime(options.start, 'start'),
      periodEnd: isoDateTime(options.end, 'end'),
      fixedCents,
      seats: options.seats ?? 1,
      status: 'open'
    }, options.actor ?? 'cli');
    print({ ok: true, period: result.period }, options.json);
  } finally {
    handle.close();
  }
}

export function budgetSetCommand(ownerArg: string | undefined, options: BudgetCliOptions): void {
  if (!ownerArg && !options.project) throw new Error('Usage: mapctx budget set <epic-id> (--amount <decimal> | --minutes <n>) [--currency USD] [--start date] [--end date] [--note text] [--json]');
  if (options.amount === undefined && options.minutes === undefined) throw new Error('budget set requires --amount <decimal> (money) or --minutes <n> (time)');
  if (options.amount !== undefined && options.minutes !== undefined) throw new Error('budget set takes either --amount or --minutes, not both');
  const { handle, tasksRoot } = requireStoreAuthorityForBudget(process.cwd());
  try {
    let budget: Budget;
    if (options.project) {
      const project = getSingleProject(handle.db);
      if (!project) throw new Error('No project initialized in this store.');
      budget = buildBudget('project', project.projectId, options);
    } else {
      budget = buildBudget('epic', ownerArg as string, options);
    }
    const result = recordBudgetSet(handle, budget, options.actor ?? 'cli');
    if (!result.ok) {
      throw new Error(`Budget set refused: ${result.reason} (${budget.ownerKind} ${budget.ownerId}). Is "${budget.ownerId}" a task in this store?`);
    }
    // The epic detail file carries the generated budget projection, so the
    // canonical snapshot must be regenerated in the same operation or the
    // next validate drifts (same authority story as task move).
    const regenerated = regenerateCanonicalFilesSafe(handle, tasksRoot);
    print({ ok: true, budget: result.budget, regenerated }, options.json);
  } finally {
    handle.close();
  }
}

function buildBudget(ownerKind: Budget['ownerKind'], ownerId: string, options: BudgetCliOptions): Budget {
  const common = {
    budgetId: crypto.randomUUID(),
    ownerKind,
    ownerId,
    periodStart: options.start ?? null,
    periodEnd: options.end ?? options.due ?? null,
    setAt: new Date().toISOString(),
    note: options.note ?? null
  };
  if (options.minutes !== undefined) {
    return { ...common, unit: 'time', money: null, minutes: options.minutes };
  }
  const currency = options.currency ?? DEFAULT_CURRENCY;
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`--currency must be an ISO-4217 alpha-3 code, got: ${currency}`);
  return {
    ...common,
    unit: 'money',
    money: parseMoneyAmount(options.amount as string, currency, countDecimals(options.amount as string)),
    minutes: null
  };
}

function resolveOwner(handle: StoreHandle, ownerArg: string): { ownerKind: Budget['ownerKind']; ownerId: string } {
  const project = getSingleProject(handle.db);
  if (project && ownerArg === project.projectId) return { ownerKind: 'project', ownerId: ownerArg };
  return { ownerKind: 'epic', ownerId: ownerArg };
}

export function budgetStatusCommand(ownerArg: string | undefined, options: BudgetCliOptions): void {
  if (!ownerArg && !options.project) throw new Error('Usage: mapctx budget status <epic-id> [--json]');
  const { handle } = requireStoreAuthorityForBudget(process.cwd(), { mode: 'read' });
  try {
    const { ownerKind, ownerId } = options.project
      ? resolveProjectOwner(handle)
      : resolveOwner(handle, ownerArg as string);
    const status = budgetStatus(handle.db, ownerKind, ownerId);
    if (options.json) {
      print({ ok: true, status }, true);
      return;
    }
    printHuman(status);
  } finally {
    handle.close();
  }
}

export function budgetHistoryCommand(ownerArg: string | undefined, options: BudgetCliOptions): void {
  if (!ownerArg && !options.project) throw new Error('Usage: mapctx budget history <epic-id> [--json]');
  const { handle } = requireStoreAuthorityForBudget(process.cwd(), { mode: 'read' });
  try {
    const { ownerKind, ownerId } = options.project
      ? resolveProjectOwner(handle)
      : resolveOwner(handle, ownerArg as string);
    print({ ok: true, budgets: listBudgets(handle.db, ownerKind, ownerId) }, options.json);
  } finally {
    handle.close();
  }
}

function resolveProjectOwner(handle: StoreHandle): { ownerKind: Budget['ownerKind']; ownerId: string } {
  const project = getSingleProject(handle.db);
  if (!project) throw new Error('No project initialized in this store.');
  return { ownerKind: 'project', ownerId: project.projectId };
}

function printHuman(status: ReturnType<typeof budgetStatus>): void {
  const scope = status.ownerKind === 'project' ? 'project' : 'epic';
  if (!status.hasBudget) {
    console.log(`No budget set for ${scope} ${status.ownerId}. Set one with \`mapctx budget set ${status.ownerId} --amount <n>\`.`);
    return;
  }
  if (status.unit === 'money' && status.plannedMoney) {
    console.log(`Budget for ${scope} ${status.ownerId} (money)`);
    console.log(`  Planned:   ${formatMoney(status.plannedMoney)}`);
    if (status.consumed.coverage === 'no-data') {
      console.log(`  Consumed:  NO COST DATA (${status.consumed.reason ?? 'no reason recorded'})`);
      console.log('  Consumption is not measured in this scope -- the cost chain carries no data here. Unknown, not zero.');
    } else if (status.consumed.currency && status.consumed.decimals !== null) {
      console.log(`  Consumed:  ${formatMoney({ amountMinor: status.consumed.consumedMinor ?? 0, currency: status.consumed.currency, decimals: status.consumed.decimals })} (${status.consumed.coverage} coverage)`);
    }
    if (status.remainingMinor !== null && status.consumed.currency && status.consumed.decimals !== null) {
      console.log(`  Remaining: ${formatMoney({ amountMinor: status.remainingMinor, currency: status.consumed.currency, decimals: status.consumed.decimals })}`);
    }
    if (status.spentBp !== null) {
      console.log(`  Spent:     ${(status.spentBp / 100).toFixed(2)}%`);
    } else {
      console.log('  Spent:     unknown (planned amount is zero)');
    }
    return;
  }
  console.log(`Budget for ${scope} ${status.ownerId} (time)`);
  const plannedMinutes = status.plannedMinutes ?? 0;
  const consumedMinutes = (status.consumed.consumedMs ?? 0) / 60_000;
  const remainingMinutes = (status.remainingMs ?? 0) / 60_000;
  console.log(`  Planned:   ${plannedMinutes}m`);
  if (status.consumed.coverage === 'no-data') {
    console.log(`  Consumed:  NO RECEIPT DATA (${status.consumed.reason ?? 'no reason recorded'})`);
    console.log('  Consumption is not measured in this scope -- no accepted receipts cover it. Unknown, not zero.');
  } else {
    console.log(`  Consumed:  ${consumedMinutes.toFixed(1)}m wall clock (${status.consumed.coverage} coverage; activeTime not yet persisted per run)`);
    console.log(`  Remaining: ${remainingMinutes.toFixed(1)}m`);
  }
  if (status.spentBp !== null) {
    console.log(`  Spent:     ${(status.spentBp / 100).toFixed(2)}%`);
  }
}
