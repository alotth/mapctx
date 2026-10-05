import { isStoreMaterialized, resolveMapctxToml, resolveProjectStoreDir, StoreHandle, type MapctxTomlConfig } from '@mapctx/store';

export type BudgetCliOptions = {
  json?: boolean;
  actor?: string;
  currency?: string;
  note?: string;
  amount?: string;
  minutes?: number;
  account?: string;
  planName?: string;
  seats?: number;
  start?: string;
  end?: string;
  due?: string;
  project?: boolean;
  remove?: boolean;
};

type Toml = { config: MapctxTomlConfig; path: string; dir: string };

export type StoreAuthorityContext = {
  toml: Toml;
  handle: StoreHandle;
  tasksRoot: string;
};

/**
 * Budget/account/budget-status writes are store-authority operations: in the
 * Markdown regime there is no store to record them against, so fail closed
 * with the remedy instead of silently picking a side (same rule as task
 * write commands).
 */
export function requireStoreAuthorityForBudget(cwd: string, options: { mode?: 'write' | 'read' } = {}): StoreAuthorityContext {
  const toml = resolveMapctxToml(cwd);
  if (!toml) {
    throw new Error('No mapctx.toml found in this repository or its parents. Run `mapctx import --commit` first.');
  }
  if (toml.config.plansAuthority !== 'store') {
    throw new Error(`plansAuthority is "${toml.config.plansAuthority}", not "store"; budget commands need a materialized store. See mapctx.toml.`);
  }
  const storeDir = resolveProjectStoreDir(toml.config.projectId);
  if (!isStoreMaterialized(storeDir)) {
    throw new Error(`Store not materialized at ${storeDir}. Run \`mapctx store init\`.`);
  }
  // R14: read commands (budget status/history) observe through a read-only
  // handle; maintenance pending is surfaced instead of healed silently.
  if (options.mode === 'read') {
    const handle = StoreHandle.openReadOnly(storeDir);
    const maintenance = handle.maintenanceNeeded();
    if (maintenance) {
      handle.close();
      throw new Error(`Store maintenance needed, refusing to read stale state: ${maintenance}`);
    }
    return { toml, handle, tasksRoot: toml.dir };
  }
  return { toml, handle: StoreHandle.open(storeDir), tasksRoot: toml.dir };
}
