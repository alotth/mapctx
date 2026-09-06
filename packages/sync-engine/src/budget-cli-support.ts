import * as fs from 'fs';
import { buildExport, isStoreMaterialized, resolveMapctxToml, resolveProjectStoreDir, StoreHandle, type MapctxTomlConfig } from '@mapctx/store';

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
export function requireStoreAuthorityForBudget(cwd: string): StoreAuthorityContext {
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
  return { toml, handle: StoreHandle.open(storeDir), tasksRoot: toml.dir };
}

/**
 * After a budget write the canonical Markdown must follow in the same
 * operation (the epic detail carries the generated budget projection), or
 * the next validate fails closed. Safe to call on any store: no budgets set
 * means the export is byte-identical to before.
 */
export function regenerateCanonicalFilesSafe(handle: StoreHandle, tasksRoot: string): { tasksMd: string; detailFiles: number } {
  const exported = buildExport(handle.db, { tasksRoot });
  fs.writeFileSync(exported.tasksMd.path, exported.tasksMd.content, 'utf8');
  for (const file of exported.taskDetailFiles) {
    fs.writeFileSync(file.path, file.content, 'utf8');
  }
  return { tasksMd: exported.tasksMd.path, detailFiles: exported.taskDetailFiles.length };
}
