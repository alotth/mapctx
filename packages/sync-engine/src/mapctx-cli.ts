#!/usr/bin/env node
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureWorkspaceRegistry } from '@mapctx/core/workspace';
import { generateTaskDetailFile, parseTaskDetailFile, parseTasksFile } from '@mapctx/core';
import {
  buildExport,
  claimTask,
  diffTaskForReconcile,
  importCommit,
  importDryRun,
  isStoreMaterialized,
  moveTask,
  newDispatchId,
  createTask,
  reconcileAccept,
  reconcileDiscard,
  recoverStoreFromCheckpoint,
  releaseClaim,
  recordDispatchAttempt,
  recordRunReceipt,
  listClaimViolations,
  listDispatchAttempts,
  listEstimateSnapshots,
  listReceiptsForDispatch,
  listReceiptsForTask,
  renewClaim,
  resolveMapctxToml,
  resolveProjectStoreDir,
  repairStore,
  StoreHandle,
  queryTask,
  queryTaskFromMarkdown,
  queryTaskContext,
  queryTaskContextFromMarkdown,
  toPlanningState,
  updateTask,
  listDependencies,
  listTasks,
  validateStoreRegime,
  type MapctxTomlConfig
} from '@mapctx/store';
import { getValidationReport, validateCommand } from './board-tools';
import { loadConfigOptionalForBoard } from './config';
import { accountAddCommand, accountBindCommand, accountListCommand, budgetHistoryCommand, budgetSetCommand, budgetStatusCommand, planPeriodRecordCommand } from './budget-cli';
import { buildGanttDataset } from './gantt';
import { SyncOptions } from './types';
import { parseWorkspaceServerArgs, startWorkspaceServer } from './workspace-server';

type MapctxOptions = SyncOptions & {
  commit?: boolean;
  actor?: string;
  claimId?: string;
  leaseToken?: string;
  holder?: string;
  reason?: 'manual' | 'wave-end' | 'epic-end';
  reconcileMode?: 'accept' | 'discard';
  receiptPath?: string;
  readReceipt?: boolean;
  budget?: number;
  status?: string;
  setPairs?: string[];
  dependsOn?: string;
  blocking?: string;
  dispatchId?: string;
  id?: string;
  executor?: string;
  contextHash?: string;
  title?: string;
  type?: string;
  parent?: string;
  priority?: string;
  workload?: string;
  tags?: string;
  domains?: string;
  start?: string;
  due?: string;
  role?: string;
  impact?: string;
  effort?: string;
  summary?: string;
  description?: string;
  descriptionFile?: string;
  currency?: string;
  amount?: string;
  minutes?: number;
  note?: string;
  account?: string;
  planName?: string;
  seats?: number;
  end?: string;
  project?: boolean;
  remove?: boolean;
};

function printHelp(): void {
  console.log('mapctx CLI');
  console.log('');
  console.log('Commands:');
  console.log('  mapctx workspace [path] [--add path] [--org id] [--org-name name] [--org-path path] [--target target-id] [--port n] [--no-open]');
  console.log('  mapctx workspace:add <path> [--org id] [--org-name name] [--org-path path]');
  console.log('  mapctx store init [--json]');
  console.log('    Materializes the local store. If plansAuthority=store but ~/.mapctx/projects/<id>/');
  console.log('    is missing entirely (lost machine, fresh clone, unrepairable corruption), this');
  console.log('    recovers from the last git-committed TASKS.md/tasks/*.md checkpoint into a fresh');
  console.log('    incarnation. Event history, claims, and cost/usage data strictly older than that');
  console.log('    checkpoint are permanently gone -- back up ~/.mapctx/projects/<id>/mapctx.db and');
  console.log('    commit checkpoints on your own cadence if you need more than that.');
  console.log('  mapctx store repair [--json]');
  console.log('  mapctx import --dry-run [--json] [--tasks-file path]');
  console.log('  mapctx import --commit [--json] [--tasks-file path] [--config path] [--actor name]');
  console.log('  mapctx export [--reason manual|wave-end|epic-end] [--json]');
  console.log('  mapctx validate [--json]');
  console.log('  mapctx task show <task-id> [--json]');
  console.log('  mapctx task context <task-id> --budget <n> [--json]');
  console.log('  mapctx plan [--json]');
  console.log('  mapctx gantt [--json]');
  console.log('  mapctx task claim <task-id> [--json] [--actor name] [--holder json]');
  console.log('  mapctx task renew <task-id> --claim id --token token [--json] [--actor name]');
  console.log('  mapctx task release <task-id> --claim id --token token [--json] [--actor name]');
  console.log('  mapctx task create --title "<title>" [--id T-###] [--type epic|feature|task|bug|chore] [--parent id] [--status planning-state]');
  console.log('    [--priority p] [--workload w] [--tags a,b] [--domains d,e] [--depends-on a,b] [--blocking x,y]');
  console.log('    [--start date] [--due date] [--role r] [--impact i] [--effort e] [--summary s]');
  console.log('    (--description text | --description-file path) [--json] [--actor name]');
  console.log('    Auto-assigns the next free id for the type prefix (E for epic, T otherwise). The');
  console.log('    description prose goes into the new detail file and stays Git-authored.');
  console.log('  mapctx task move <task-id> --status <planning-state> [--json] [--actor name]');
  console.log('    Legal transition under store authority (backlog|ready-for-do|doing|review|done|paused,');
  console.log('    or canonical backlog|ready|in-progress|review|done|paused). done stamps completedOn and');
  console.log('    releases any active claim. Store-authority only: Markdown stays the editor pre-cutover.');
  console.log('  mapctx task update <task-id> [--set key=value ...] [--depends-on a,b] [--blocking x,y] [--json] [--actor name]');
  console.log('    Whitelisted fields only (title,type,parentTaskId,priority,workload,tags,domains,startDate,dueDate,');
  console.log('    externalId,specMode,assignees,iteration,milestone; detail.* for role,impact,estimatedEffort,');
  console.log('    filesAffected,testsRequired,summary,prerequisites,blocking). --depends-on/--blocking replace both');
  console.log('    the dependency edges and the detail prerequisites/blocking so the two surfaces never diverge.');
  console.log('  mapctx dispatch create <task-id> [--dispatch-id id] [--status claimed|running] (default claimed) [--executor kind] [--context-hash hash] [--json] [--actor name]');
  console.log('    New dispatch (fresh id, attempt 1) or --dispatch-id to append attempt max+1 to an existing one.');
  console.log('    Prints the dispatchId/attempt to feed `mapctx dispatch receipt`.');
  console.log('  mapctx dispatch receipt <dispatch-id> --receipt path [--json] [--actor name]');
  console.log('  mapctx dispatch receipt <dispatch-id> --read --json');
  console.log('  mapctx reconcile <task-id> [--accept | --discard] [--json] [--actor name]');
  console.log('  mapctx sync status [--json]');
  console.log('  mapctx account add <name> [--currency USD] [--note text] [--json] [--actor name]');
  console.log('    Records a paid-plan account ("Codex Pro") in the store. Budgets and plan periods');
  console.log('    reference accounts; projects declare which accounts they draw from via `bind`.');
  console.log('  mapctx account list [--json]');
  console.log('  mapctx account bind <account-id-or-name> [--remove] [--json] [--actor name]');
  console.log('  mapctx plan-period record --account <id-or-name> --amount <decimal> --start <date|datetime>');
  console.log('    --end <date|datetime> [--currency c] [--plan-name n] [--seats n] [--json] [--actor name]');
  console.log('    Records the plan payment on the ACCOUNT (T-070: accounts own plans, projects consume).');
  console.log('  mapctx budget set <epic-id> (--amount <decimal> | --minutes n) [--currency USD] [--start date]');
  console.log('    [--end date] [--note text] [--json] [--actor name]   (--project targets the whole project)');
  console.log('    Event-sourced: every set is a revision; history is kept, latest wins.');
  console.log('  mapctx budget status <epic-id> [--json]   (--project for the whole project)');
  console.log('    Planned/spent/remaining/spent% from the cost chain. Scopes with no cost data say');
  console.log('    "no cost data" -- never zeros that look measured.');
  console.log('  mapctx budget history <epic-id> [--json]');
}

function print(value: unknown, json?: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function parseArgs(argv: string[]): {
  command: string;
  subcommand?: string;
  options: MapctxOptions;
  positional: string[];
  help: boolean;
} {
  const args = [...argv];
  const command = args.shift() || 'help';
  const options: MapctxOptions = {};
  const positional: string[] = [];
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--dry-run') options.dryRun = true;
    else if (a === '--commit') options.commit = true;
    else if (a === '--json') options.json = true;
    else if (a === '--accept') options.reconcileMode = 'accept';
    else if (a === '--discard') options.reconcileMode = 'discard';
    else if (a === '--config') options.configPath = args[++i];
    else if (a === '--tasks-file') options.tasksFileOverride = args[++i];
    else if (a === '--actor') options.actor = args[++i];
    else if (a === '--claim') options.claimId = args[++i];
    else if (a === '--token') options.leaseToken = args[++i];
    else if (a === '--holder') options.holder = args[++i];
    else if (a === '--receipt' || a === '--file') options.receiptPath = args[++i];
    else if (a === '--read') options.readReceipt = true;
    else if (a === '--status') options.status = args[++i];
    else if (a === '--set') (options.setPairs ??= []).push(args[++i]);
    else if (a === '--depends-on') options.dependsOn = args[++i];
    else if (a === '--blocking') options.blocking = args[++i];
    else if (a === '--dispatch-id') options.dispatchId = args[++i];
    else if (a === '--id') options.id = args[++i];
    else if (a === '--executor') options.executor = args[++i];
    else if (a === '--context-hash') options.contextHash = args[++i];
    else if (a === '--title') options.title = args[++i];
    else if (a === '--type') options.type = args[++i];
    else if (a === '--parent') options.parent = args[++i];
    else if (a === '--priority') options.priority = args[++i];
    else if (a === '--workload') options.workload = args[++i];
    else if (a === '--tags') options.tags = args[++i];
    else if (a === '--domains') options.domains = args[++i];
    else if (a === '--start') options.start = args[++i];
    else if (a === '--due') options.due = args[++i];
    else if (a === '--role') options.role = args[++i];
    else if (a === '--impact') options.impact = args[++i];
    else if (a === '--effort') options.effort = args[++i];
    else if (a === '--summary') options.summary = args[++i];
    else if (a === '--description') options.description = args[++i];
    else if (a === '--description-file') options.descriptionFile = args[++i];
    else if (a === '--currency') options.currency = args[++i];
    else if (a === '--amount') options.amount = args[++i];
    else if (a === '--minutes') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--minutes must be a positive integer');
      options.minutes = value;
    }
    else if (a === '--note') options.note = args[++i];
    else if (a === '--account') options.account = args[++i];
    else if (a === '--plan-name') options.planName = args[++i];
    else if (a === '--seats') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--seats must be a positive integer');
      options.seats = value;
    }
    else if (a === '--end') options.end = args[++i];
    else if (a === '--project') options.project = true;
    else if (a === '--remove') options.remove = true;
    else if (a === '--budget') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--budget must be a positive integer');
      options.budget = value;
    }
    else if (a === '--reason') {
      const value = args[++i];
      if (value === 'manual' || value === 'wave-end' || value === 'epic-end') options.reason = value;
      else throw new Error(`Invalid --reason value: ${value}`);
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }

  return { command, subcommand: positional[0], options, positional, help };
}

function defaultActor(explicit?: string): string {
  if (explicit) return explicit;
  try {
    return os.userInfo().username || 'cli';
  } catch {
    return 'cli';
  }
}

function resolveTasksFilePath(cwd: string, options: MapctxOptions): string {
  if (options.tasksFileOverride) return path.resolve(cwd, options.tasksFileOverride);
  const { config, configPath, configExists } = loadConfigOptionalForBoard(options);
  return path.resolve(configExists ? path.dirname(configPath) : cwd, config.tasksFile);
}

function resolveStoreCheckpointPath(cwd: string, options: MapctxOptions, projectRoot: string): string {
  return options.tasksFileOverride
    ? path.resolve(cwd, options.tasksFileOverride)
    : path.join(projectRoot, 'TASKS.md');
}

type OpenStoreResult = {
  toml: { config: MapctxTomlConfig; path: string; dir: string };
  storeDir: string;
  handle: StoreHandle;
};

/**
 * Fails closed per ADR 0003 "Authority and cutover": a project with
 * plansAuthority: store but no local mapctx.db is "not materialized", not
 * pre-cutover, and tooling must never silently fall back to treating
 * Markdown as authoritative.
 */
function openStoreOrFail(cwd: string, options: { mode?: 'write' | 'read' } = {}): OpenStoreResult {
  const toml = resolveMapctxToml(cwd);
  if (!toml) {
    throw new Error('No mapctx.toml found in this repository or its parents. Run `mapctx import --commit` first.');
  }
  if (toml.config.plansAuthority !== 'store') {
    throw new Error(`plansAuthority is "${toml.config.plansAuthority}", not "store"; this project has not cut over. See mapctx.toml.`);
  }
  const storeDir = resolveProjectStoreDir(toml.config.projectId);
  if (!isStoreMaterialized(storeDir)) {
    throw new Error(`Store not materialized at ${storeDir}. Run \`mapctx store init\`.`);
  }
  // R14: query commands observe the store through a read-only handle -- they
  // cannot migrate, reindex, or write metadata. Pending maintenance is
  // surfaced as an explicit condition instead of being healed silently.
  if (options.mode === 'read') {
    const handle = StoreHandle.openReadOnly(storeDir);
    const maintenance = handle.maintenanceNeeded();
    if (maintenance) {
      handle.close();
      throw new Error(`Store maintenance needed, refusing to read stale state: ${maintenance}`);
    }
    return { toml, storeDir, handle };
  }
  return { toml, storeDir, handle: StoreHandle.open(storeDir) };
}

function storeInitCommand(options: MapctxOptions): void {
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml) {
    throw new Error('No mapctx.toml found in this repository or its parents. Run `mapctx import --commit` first.');
  }
  const storeDir = resolveProjectStoreDir(toml.config.projectId);
  const alreadyMaterialized = isStoreMaterialized(storeDir);

  if (alreadyMaterialized) {
    const handle = StoreHandle.open(storeDir);
    handle.close();
    print({ projectId: toml.config.projectId, storeDir, alreadyMaterialized: true, recovered: false, plansAuthority: toml.config.plansAuthority }, options.json);
    return;
  }

  if (toml.config.plansAuthority === 'store') {
    // Total loss of ~/.mapctx/projects/<id>/ (ADR 0003 corruption tier 3): the
    // last git-committed TASKS.md/tasks/*.md checkpoint is the only recovery
    // path. This starts a fresh incarnation at the same projectId; event
    // history strictly older than this checkpoint is permanently gone.
    const tasksFilePath = resolveTasksFilePath(cwd, options);
    const recovered = recoverStoreFromCheckpoint({
      tasksFilePath,
      tasksRoot: cwd,
      projectId: toml.config.projectId,
      storeDir,
      actor: defaultActor(options.actor)
    });
    print(
      {
        projectId: recovered.projectId,
        storeDir: recovered.storeDir,
        alreadyMaterialized: false,
        recovered: true,
        taskCount: recovered.taskCount,
        incarnationId: recovered.incarnationId,
        warning: 'Recovered from the last git-committed checkpoint. Event history, claims, and cost/usage data strictly older than this checkpoint are permanently gone.'
      },
      options.json
    );
    return;
  }

  const handle = StoreHandle.open(storeDir);
  handle.close();
  print({ projectId: toml.config.projectId, storeDir, alreadyMaterialized: false, recovered: false, plansAuthority: toml.config.plansAuthority }, options.json);
}

function storeRepairCommand(options: MapctxOptions): void {
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml) {
    throw new Error('No mapctx.toml found in this repository or its parents.');
  }
  const storeDir = resolveProjectStoreDir(toml.config.projectId);
  const result = repairStore(storeDir);
  print(result, options.json);
  if (result.status === 'gap') {
    throw new Error(`Repair aborted: ${result.gaps.length} journal gap(s) found. mapctx.db was left untouched.`);
  }
}

function importDryRunCliCommand(options: MapctxOptions): void {
  const cwd = process.cwd();
  const tasksFilePath = resolveTasksFilePath(cwd, options);
  const result = importDryRun({
    tasksFilePath,
    cwd,
    legacyConfigPath: options.configPath ? path.resolve(cwd, options.configPath) : undefined
  });
  print(result, options.json);
  if (result.plan.errors > 0) {
    throw new Error(`Import validation failed with ${result.plan.errors} error(s).`);
  }
  if (result.cutover && result.cutover.blockers.length > 0) {
    throw new Error(`Cutover blocked:\n${result.cutover.blockers.map(b => `- ${b}`).join('\n')}`);
  }
}

function importCommitCliCommand(options: MapctxOptions): void {
  const cwd = process.cwd();
  const result = importCommit({
    cwd,
    tasksFilePath: options.tasksFileOverride ? path.resolve(cwd, options.tasksFileOverride) : undefined,
    legacyConfigPath: options.configPath ? path.resolve(cwd, options.configPath) : undefined,
    actor: defaultActor(options.actor)
  });
  print(result, options.json);
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function exportCliCommand(options: MapctxOptions): void {
  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    const exported = buildExport(handle.db, { tasksRoot: cwd });
    fs.writeFileSync(exported.tasksMd.path, exported.tasksMd.content, 'utf8');
    for (const file of exported.taskDetailFiles) {
      fs.writeFileSync(file.path, file.content, 'utf8');
    }

    const filesHash: Record<string, string> = {
      [path.relative(cwd, exported.tasksMd.path)]: sha256(exported.tasksMd.content)
    };
    for (const file of exported.taskDetailFiles) {
      filesHash[path.relative(cwd, file.path)] = sha256(file.content);
    }

    const events = handle.listEvents();
    const lastEvent = events[events.length - 1];
    const exportId = crypto.randomUUID();
    const reason = options.reason ?? 'manual';
    handle.appendEvent({
      eventType: 'checkpoint.exported',
      actor: defaultActor(options.actor),
      payload: {
        exportId,
        eventCursor: lastEvent ? { node: lastEvent.nodeId, sequence: lastEvent.sequence } : { node: handle.nodeId, sequence: 0 },
        filesHash,
        reason
      }
    });

    print({ exportId, reason, files: Object.keys(filesHash) }, options.json);
  } finally {
    handle.close();
  }
}

export function mapctxValidateCliCommand(options: MapctxOptions): void {
  const cwd = process.cwd();

  let structuralOk = true;
  let validation: ReturnType<typeof getValidationReport> | null = null;
  let structuralError: Error | null = null;
  try {
    if (options.json) {
      validation = getValidationReport(options);
      structuralOk = validation.errors === 0;
    } else {
      validateCommand(options);
    }
  } catch (error) {
    structuralOk = false;
    structuralError = error instanceof Error ? error : new Error(String(error));
  }

  const tasksRoot = validation
    ? path.dirname(validation.tasksFilePath)
    : resolveMapctxToml(cwd)?.dir ?? cwd;
  const storeResult = validateStoreRegime(cwd, tasksRoot);
  if (options.json) {
    if (validation) {
      print({ ...validation, store: storeResult }, true);
    } else {
      print({
        error: 'board-resolution-failed',
        message: structuralError?.message ?? 'Board resolution failed.',
        tasksFilePath: options.tasksFileOverride ? path.resolve(cwd, options.tasksFileOverride) : null,
        store: storeResult
      }, true);
    }
  } else {
    console.log('');
    console.log(`Store regime: ${storeResult.status}`);
    if (storeResult.status === 'store-authority') {
      console.log(`Drift: ${storeResult.drift.hasDrift ? 'FAIL' : 'PASS'}`);
      console.log(`Semantic: ${storeResult.semantic.errors > 0 ? 'FAIL' : 'PASS'} (${storeResult.semantic.errors} errors, ${storeResult.semantic.warnings} warnings)`);
      for (const issue of storeResult.drift.issues.slice(0, 25)) {
        console.log(`- [error] drift ${issue.taskId}: ${issue.reason} (${issue.file})`);
      }
      for (const issue of storeResult.semantic.issues.slice(0, 25)) {
        console.log(`- [${issue.severity}] ${issue.code}${issue.taskId ? ` ${issue.taskId}` : ''}: ${issue.message}`);
      }
    } else if (storeResult.status === 'not-materialized') {
      console.log(`Store not materialized at ${storeResult.storeDir}. Run \`mapctx store init\`.`);
    } else if (storeResult.status === 'maintenance-needed') {
      // R14 review P2#2: name the condition and prescribe the remedy that
      // actually heals it -- "store init" is a no-op on a materialized store.
      console.log(`Store needs maintenance: ${storeResult.maintenanceNeeded}`);
      console.log(`Run \`mapctx store repair\` to materialize pending events, then validate again.`);
    }
  }

  const driftFailed = storeResult.status === 'store-authority' && storeResult.drift.hasDrift;
  const semanticFailed = storeResult.status === 'store-authority' && storeResult.semantic.errors > 0;
  const notMaterialized = storeResult.status === 'not-materialized' || storeResult.status === 'maintenance-needed';
  if (!structuralOk || driftFailed || semanticFailed || notMaterialized) {
    throw new Error('mapctx validate failed.');
  }
}

export function taskClaimCommand(taskId: string, options: MapctxOptions): void {
  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    const holder = options.holder ? (JSON.parse(options.holder) as Record<string, unknown>) : { pid: process.pid, host: os.hostname() };
    const result = claimTask(handle, { taskId, actor: defaultActor(options.actor), holder });
    // Claim auto-carries the planning state to doing (same authority story as
    // task move), so the canonical board must follow in the same operation or
    // the next validate drifts. A claiming worktree regenerates ITS OWN
    // checkout's snapshot; the main checkout commits it on its cadence.
    let regenerated: { tasksMd: string; detailFiles: number } | undefined;
    if (result.ok) {
      const toml = resolveMapctxToml(cwd);
      if (toml && toml.config.plansAuthority === 'store') {
        regenerated = regenerateCanonicalFiles(handle, toml.dir);
      }
    }
    print({ ...result, regenerated }, options.json);
    if (!result.ok) throw new Error(`Claim failed: ${result.reason}`);
  } finally {
    handle.close();
  }
}

export function taskShowCommand(taskId: string, options: MapctxOptions): void {
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml || toml.config.plansAuthority !== 'store') {
    const tasksFilePath = resolveTasksFilePath(cwd, options);
    print({ ...queryTaskFromMarkdown(path.dirname(tasksFilePath), taskId, tasksFilePath), tasksFilePath }, options.json);
    return;
  }
  const { handle } = openStoreOrFail(cwd, { mode: 'read' });
  try {
    print({ ...queryTask(handle.db, taskId), tasksFilePath: resolveStoreCheckpointPath(cwd, options, toml.dir) }, options.json);
  } finally {
    handle.close();
  }
}

export function taskContextCommand(taskId: string, options: MapctxOptions): void {
  if (!options.budget) throw new Error('task context requires --budget <n>');
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml || toml.config.plansAuthority !== 'store') {
    const tasksFilePath = resolveTasksFilePath(cwd, options);
    print({ ...queryTaskContextFromMarkdown(path.dirname(tasksFilePath), taskId, { budget: options.budget }, tasksFilePath), tasksFilePath }, options.json);
    return;
  }
  const { handle } = openStoreOrFail(cwd);
  try {
    print({
      ...queryTaskContext(handle.db, taskId, { budget: options.budget, tasksRoot: toml.dir }),
      tasksFilePath: resolveStoreCheckpointPath(cwd, options, toml.dir)
    }, options.json);
  } finally {
    handle.close();
  }
}

export function mapctxPlanCommand(options: MapctxOptions): void {
  const planner = require('@mapctx/planner') as { planExecution: (input: unknown) => unknown };
  const toml = resolveMapctxToml(process.cwd());
  if (!toml || toml.config.plansAuthority !== 'store') {
    // Planning is read-only. Before cutover, use the same TASKS.md fallback
    // as mapcs plan instead of forcing operators to materialize a store.
    const tasksFilePath = resolveTasksFilePath(process.cwd(), options);
    const board = parseTasksFile(tasksFilePath);
    // dependencyEdges is the single source of truth for board-sourced plans; task.dependsOn is
    // omitted here so the same relation is never sent to the planner twice (see T-063).
    const dependencyEdges = board.tasks.flatMap(task => (task.dependsOn ?? []).map(toTaskId => ({
      fromTaskId: task.id,
      toTaskId,
      kind: 'depends-on' as const
    })));
    const report = planner.planExecution({
      tasks: board.tasks.map(task => ({
        id: task.id,
        title: task.title,
        status: task.status,
        type: task.type,
        parent: task.parent ?? null,
        domains: task.domains ?? task.touch ?? []
      })),
      dependencyEdges
    });
    print({ ...(report as Record<string, unknown>), tasksFilePath }, options.json);
    return;
  }

  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd, { mode: 'read' });
  try {
    const tasks = listTasks(handle.db);
    const edges = listDependencies(handle.db);
    // dependencyEdges is the single source of truth here too; task.dependsOn is omitted (see
    // the TASKS.md fallback branch above and T-063).
    const report = planner.planExecution({
      tasks: tasks.map(task => ({
        id: task.taskId,
        title: task.title,
        status: task.planningState,
        type: task.type ?? undefined,
        parent: task.parentTaskId ?? null,
        domains: task.domains
      })),
      dependencyEdges: edges.map(edge => ({ fromTaskId: edge.fromTaskId, toTaskId: edge.toTaskId, kind: edge.kind }))
    });
    print({ ...(report as Record<string, unknown>), tasksFilePath: resolveStoreCheckpointPath(cwd, options, toml.dir) }, options.json);
  } finally {
    handle.close();
  }
}

/**
 * Emits the complete Gantt dataset (planned/forecast/actual/waves/blockers/
 * collisions/violations) as JSON. Works pre-cutover like `plan`, `task show`,
 * and `task context` -- planning and forecasting are read-only, so neither
 * needs a materialized store. Authored planned dates (start/due) are carried
 * into the dataset so both the CLI and workspace host expose one complete,
 * query-backed contract. See T-055.
 */
export function mapctxGanttCommand(options: MapctxOptions): void {
  const toml = resolveMapctxToml(process.cwd());
  if (!toml || toml.config.plansAuthority !== 'store') {
    const board = parseTasksFile(resolveTasksFilePath(process.cwd(), options));
    const dependencyEdges = board.tasks.flatMap(task => (task.dependsOn ?? []).map(toTaskId => ({
      fromTaskId: task.id,
      toTaskId,
      kind: 'depends-on' as const
    })));
    const dataset = buildGanttDataset({
      tasks: board.tasks.map(task => ({
        id: task.id,
        title: task.title,
        status: task.status,
        type: task.type,
        parentId: task.parent ?? null,
        start: task.start ?? null,
        due: task.due ?? null,
        domains: task.domains ?? task.touch ?? [],
        // No cutover means no store, so there are no receipts to read yet.
        receipts: []
      })),
      dependencyEdges,
      mode: 'pre-cutover'
    });
    print(dataset, options.json);
    return;
  }

  const { handle } = openStoreOrFail(process.cwd(), { mode: 'read' });
  try {
    const tasks = listTasks(handle.db);
    const edges = listDependencies(handle.db);
    const dataset = buildGanttDataset({
      tasks: tasks.map(task => ({
        id: task.taskId,
        title: task.title,
        status: task.planningState,
        type: task.type ?? undefined,
        parentId: task.parentTaskId ?? null,
        start: task.startDate ?? null,
        due: task.dueDate ?? null,
        domains: task.domains,
        estimateSnapshot: listEstimateSnapshots(handle.db, task.taskId).slice(-1)[0] ?? null,
        receipts: listReceiptsForTask(handle.db, task.taskId)
      })),
      dependencyEdges: edges.map(edge => ({ fromTaskId: edge.fromTaskId, toTaskId: edge.toTaskId, kind: edge.kind })),
      claimViolations: listClaimViolations(handle.db, {}),
      mode: 'store'
    });
    print(dataset, options.json);
  } finally {
    handle.close();
  }
}

function taskRenewCommand(taskId: string, options: MapctxOptions): void {
  if (!options.claimId || !options.leaseToken) throw new Error('task renew requires --claim <id> --token <token>');
  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    const result = renewClaim(handle, { taskId, claimId: options.claimId, leaseToken: options.leaseToken, actor: defaultActor(options.actor) });
    print(result, options.json);
    if (!result.ok) throw new Error(`Renew failed: ${result.reason}`);
  } finally {
    handle.close();
  }
}

function taskReleaseCommand(taskId: string, options: MapctxOptions): void {
  if (!options.claimId || !options.leaseToken) throw new Error('task release requires --claim <id> --token <token>');
  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    const result = releaseClaim(handle, { taskId, claimId: options.claimId, leaseToken: options.leaseToken, actor: defaultActor(options.actor) });
    print(result, options.json);
    if (!result.ok) throw new Error(`Release failed: ${result.reason}`);
  } finally {
    handle.close();
  }
}

function readReceiptPayload(options: MapctxOptions): unknown {
  if (options.receiptPath) return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), options.receiptPath), 'utf8'));
  if (!process.stdin.isTTY) {
    const input = fs.readFileSync(0, 'utf8').trim();
    if (input) return JSON.parse(input);
  }
  throw new Error('dispatch receipt requires --receipt <path> or JSON on stdin');
}

export function dispatchReceiptCommand(dispatchId: string, options: MapctxOptions): void {
  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    if (options.readReceipt) {
      print({
        ok: true,
        dispatchId,
        attempts: listDispatchAttempts(handle.db, dispatchId),
        receipts: listReceiptsForDispatch(handle.db, dispatchId)
      }, options.json);
      return;
    }
    const receipt = readReceiptPayload(options) as Parameters<typeof recordRunReceipt>[1];
    const result = recordRunReceipt(handle, receipt, defaultActor(options.actor), dispatchId);
    // R10: accepted receipts mutate generated state (completed moves planning
    // to review, failed moves it to ready; time-budget consumption changes),
    // so the canonical files must follow in the same operation -- exactly like
    // claim/move do. An export failure is reported DISTINCTLY: the receipt is
    // already accepted and persisted, so callers must not blindly retry.
    let regenerated: { tasksMd: string; detailFiles: number } | undefined;
    let exportError: string | undefined;
    if (result.ok) {
      const toml = resolveMapctxToml(cwd);
      if (toml && toml.config.plansAuthority === 'store') {
        try {
          regenerated = regenerateCanonicalFiles(handle, toml.dir);
        } catch (error) {
          exportError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    print({ ...result, regenerated, exportError }, options.json);
    if (exportError) throw new Error(`Receipt accepted and persisted, but canonical export failed: ${exportError}`);
    if (!result.ok) throw new Error(`Receipt rejected: ${result.reason}${result.message ? ` -- ${result.message}` : ''}`);
  } finally {
    handle.close();
  }
}

/**
 * Writing tasks is a store-authority operation: in the Markdown regime the
 * files themselves are authoritative and are edited directly, so a CLI write
 * path here would create a second writer. Fail closed with that explanation
 * instead of silently picking a side.
 */
function requireStoreAuthority(cwd: string): { toml: { config: MapctxTomlConfig; path: string; dir: string }; handle: StoreHandle; tasksRoot: string } {
  const toml = resolveMapctxToml(cwd);
  if (!toml || toml.config.plansAuthority !== 'store') {
    throw new Error('task write commands require plansAuthority=store (mapctx.toml). Pre-cutover, edit TASKS.md and tasks/<ID>.md directly.');
  }
  const { handle } = openStoreOrFail(cwd);
  return { toml, handle, tasksRoot: toml.dir };
}

/**
 * After a store write the canonical Markdown is regenerated so the drift
 * check keeps passing: the store just changed, so the generated snapshot
 * must follow in the same operation, or the next validate fails closed.
 */
function regenerateCanonicalFiles(handle: StoreHandle, tasksRoot: string): { tasksMd: string; detailFiles: number } {
  const exported = buildExport(handle.db, { tasksRoot });
  fs.writeFileSync(exported.tasksMd.path, exported.tasksMd.content, 'utf8');
  for (const file of exported.taskDetailFiles) {
    fs.writeFileSync(file.path, file.content, 'utf8');
  }
  return { tasksMd: exported.tasksMd.path, detailFiles: exported.taskDetailFiles.length };
}

function parseSetValue(field: string, raw: string): unknown {
  if (raw === 'null') return null;
  const arrayFields = new Set(['tags', 'domains', 'assignees', 'filesAffected', 'testsRequired', 'prerequisites', 'blocking']);
  if (arrayFields.has(field)) {
    return raw.trim() === '' ? [] : raw.split(',').map(v => v.trim()).filter(Boolean);
  }
  return raw;
}

export function taskMoveCommand(taskId: string, options: MapctxOptions): void {
  if (!options.status) throw new Error('task move requires --status <planning-state>');
  const cwd = process.cwd();
  const { handle, tasksRoot } = requireStoreAuthority(cwd);
  try {
    const result = moveTask(handle, { taskId, to: toPlanningState(options.status), actor: defaultActor(options.actor) });
    if (!result.ok) {
      print(result, options.json);
      throw new Error(`Move refused: ${result.reason}${result.message ? ` -- ${result.message}` : ''}`);
    }
    const regenerated = regenerateCanonicalFiles(handle, tasksRoot);
    print({ ...result, regenerated }, options.json);
  } finally {
    handle.close();
  }
}

export function splitList(value?: string): string[] | undefined {
  if (value === undefined) return undefined;
  return value.trim() === '' ? [] : value.split(',').map(v => v.trim()).filter(Boolean);
}

/**
 * Registers a new task under store authority. Auto-assigns the next free
 * sequential id for the type's prefix (E for epic, T otherwise) unless --id
 * is given. The description prose (--description / --description-file) is
 * written straight into the new detail file and stays Git-authored from then
 * on -- the store never owns prose.
 */
export function taskCreateCommand(options: MapctxOptions): void {
  if (!options.title) throw new Error('task create requires --title "<title>"');
  const cwd = process.cwd();
  const { handle, tasksRoot } = requireStoreAuthority(cwd);
  try {
    const result = createTask(handle, {
      title: options.title,
      id: options.id,
      type: options.type,
      parent: options.parent ?? null,
      status: options.status ? toPlanningState(options.status) : undefined,
      priority: options.priority ?? null,
      workload: options.workload ?? null,
      tags: splitList(options.tags) ?? [],
      domains: splitList(options.domains) ?? [],
      dependsOn: splitList(options.dependsOn),
      blocking: splitList(options.blocking),
      startDate: options.start ?? null,
      dueDate: options.due ?? null,
      detail: {
        role: options.role,
        impact: options.impact,
        estimatedEffort: options.effort,
        summary: options.summary
      },
      actor: defaultActor(options.actor)
    });
    if (!result.ok) {
      print(result, options.json);
      throw new Error(`Create refused: ${result.reason}${result.message ? ` -- ${result.message}` : ''}`);
    }

    regenerateCanonicalFiles(handle, tasksRoot);

    const description = options.description ?? (options.descriptionFile ? fs.readFileSync(path.resolve(cwd, options.descriptionFile), 'utf8') : undefined);
    if (description !== undefined) {
      const detailPath = path.resolve(cwd, result.detailPath);
      const generated = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8'));
      fs.writeFileSync(detailPath, generateTaskDetailFile({ ...generated, description }), 'utf8');
    }

    print(result, options.json);
  } finally {
    handle.close();
  }
}

export function taskUpdateCommand(taskId: string, options: MapctxOptions): void {
  const setPairs = options.setPairs ?? [];
  if (setPairs.length === 0 && options.dependsOn === undefined && options.blocking === undefined) {
    throw new Error('task update requires --set key=value, --depends-on a,b, or --blocking x,y');
  }
  const patch: Record<string, unknown> = {};
  const detailPatch: Record<string, unknown> = {};
  for (const pair of setPairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new Error(`--set expects key=value, got: ${pair}`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    if (key.startsWith('detail.')) {
      detailPatch[key.slice('detail.'.length)] = parseSetValue(key.slice('detail.'.length), raw);
    } else {
      patch[key] = parseSetValue(key, raw);
    }
  }
  const cwd = process.cwd();
  const { handle, tasksRoot } = requireStoreAuthority(cwd);
  try {
    const result = updateTask(handle, {
      taskId,
      patch: Object.keys(patch).length > 0 ? patch as never : undefined,
      detailPatch: Object.keys(detailPatch).length > 0 ? detailPatch as never : undefined,
      dependsOn: options.dependsOn !== undefined ? (options.dependsOn.trim() === '' ? [] : options.dependsOn.split(',').map(v => v.trim()).filter(Boolean)) : undefined,
      blocking: options.blocking !== undefined ? (options.blocking.trim() === '' ? [] : options.blocking.split(',').map(v => v.trim()).filter(Boolean)) : undefined,
      actor: defaultActor(options.actor)
    });
    if (!result.ok) {
      print(result, options.json);
      throw new Error(`Update refused: ${result.reason}${result.message ? ` -- ${result.message}` : ''}`);
    }
    const regenerated = regenerateCanonicalFiles(handle, tasksRoot);
    print({ taskId, ...result, regenerated }, options.json);
  } finally {
    handle.close();
  }
}

export function dispatchCreateCommand(taskId: string, options: MapctxOptions): void {
  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    const task = queryTask(handle.db, taskId);
    if (!task) throw new Error(`Cannot dispatch unknown task: ${taskId}`);

    let dispatchId: string;
    let attempt: number;
    if (options.dispatchId) {
      const history = listDispatchAttempts(handle.db, options.dispatchId);
      if (history.length === 0) throw new Error(`Unknown dispatch: ${options.dispatchId}`);
      dispatchId = options.dispatchId;
      attempt = Math.max(...history.map(a => a.attempt)) + 1;
    } else {
      dispatchId = newDispatchId();
      attempt = 1;
    }

    // A fresh attempt must enter through "claimed": unclaimed -> running is
    // not a legal execution transition, and the receipt (or an explicit
    // transition) is what moves the attempt forward.
    const status = options.status ?? 'claimed';
    if (status !== 'claimed' && status !== 'running') {
      throw new Error(`dispatch create status must be claimed or running, got: ${status}`);
    }
    const contextHash = options.contextHash
      ?? crypto.createHash('sha256').update(JSON.stringify(task)).digest('hex');

    const result = recordDispatchAttempt(handle, {
      dispatch: {
        dispatchId,
        taskId,
        executorKind: options.executor ?? 'cli',
        attempt,
        contextHash,
        status
      }
    }, defaultActor(options.actor));
    if (!result.ok) {
      print(result, options.json);
      throw new Error(`Dispatch refused: ${result.reason}`);
    }
    // R10: a dispatch attempt can change generated budget sections (scoped
    // dispatches feed the budget rollup), so keep the canonical snapshot in
    // the same operation. Export failure stays distinct from admission.
    let regenerated: { tasksMd: string; detailFiles: number } | undefined;
    let exportError: string | undefined;
    {
      const toml = resolveMapctxToml(cwd);
      if (toml && toml.config.plansAuthority === 'store') {
        try {
          regenerated = regenerateCanonicalFiles(handle, toml.dir);
        } catch (error) {
          exportError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    print({
      ok: true,
      dispatchId,
      attempt,
      taskId,
      status,
      executorKind: options.executor ?? 'cli',
      regenerated,
      exportError,
      next: `mapctx dispatch receipt ${dispatchId} --receipt <path>`
    }, options.json);
    if (exportError) throw new Error(`Dispatch accepted and persisted, but canonical export failed: ${exportError}`);
  } finally {
    handle.close();
  }
}

function reconcileCliCommand(taskId: string, options: MapctxOptions): void {
  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    if (options.reconcileMode === 'discard') {
      reconcileDiscard(handle.db, cwd);
      print({ taskId, action: 'discard' }, options.json);
      return;
    }
    if (options.reconcileMode === 'accept') {
      const diff = reconcileAccept(handle, cwd, taskId, defaultActor(options.actor));
      print({ taskId, action: 'accept', diff }, options.json);
      return;
    }
    const diff = diffTaskForReconcile(handle.db, cwd, taskId);
    print({ taskId, action: 'diff', diff }, options.json);
  } finally {
    handle.close();
  }
}

async function syncStatusCommand(options: MapctxOptions): Promise<void> {
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml || !toml.config.github) {
    print({ status: 'no-github-binding' }, options.json);
    return;
  }
  const github = toml.config.github;
  if (github.verified) {
    print({ status: 'verified', owner: github.owner, repo: github.repo }, options.json);
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    print(
      { status: 'unverified GitHub binding', reason: 'no GITHUB_TOKEN configured to verify', owner: github.owner, repo: github.repo },
      options.json
    );
    return;
  }

  try {
    const response = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      print({ status: 'unverified GitHub binding', reason: `GitHub API returned ${response.status}`, owner: github.owner, repo: github.repo }, options.json);
      return;
    }
    const scopesHeader = response.headers.get('x-oauth-scopes') || '';
    const scopes = scopesHeader.split(',').map(s => s.trim()).filter(Boolean);
    if (!scopes.includes('read:project') && !scopes.includes('project')) {
      print(
        { status: 'unverified GitHub binding', reason: 'missing scope', missingScope: 'read:project', owner: github.owner, repo: github.repo },
        options.json
      );
      return;
    }
    print({ status: 'verified', owner: github.owner, repo: github.repo, scopes }, options.json);
  } catch (error) {
    print({ status: 'unverified GitHub binding', reason: (error as Error).message, owner: github.owner, repo: github.repo }, options.json);
  }
}

async function main(): Promise<void> {
  const { command, subcommand, options, positional, help } = parseArgs(process.argv.slice(2));

  if (!command || command === 'help' || command === '--help' || command === '-h' || help) {
    printHelp();
    return;
  }

  if (command === 'workspace') {
    const wsOptions = parseWorkspaceServerArgs(process.argv.slice(3));
    await startWorkspaceServer({ ...wsOptions, open: wsOptions.open ?? true });
    return;
  }

  if (command === 'workspace:add') {
    const wsOptions = parseWorkspaceServerArgs(process.argv.slice(3));
    const projectPath = wsOptions.addProjectPath || wsOptions.projectPath;
    if (!projectPath) throw new Error('workspace:add requires <path>');
    const result = ensureWorkspaceRegistry({
      cwd: wsOptions.cwd,
      addProjectPath: projectPath,
      organizationId: wsOptions.organizationId,
      organizationName: wsOptions.organizationName,
      organizationPath: wsOptions.organizationPath,
      registryPath: wsOptions.registryPath
    });
    console.log(`Registered project in ${result.registryPath}`);
    if (result.addedProject) {
      console.log(`${result.addedProject.name}: ${result.addedProject.path}`);
    }
    return;
  }

  if (command === 'store') {
    if (subcommand === 'init') { storeInitCommand(options); return; }
    if (subcommand === 'repair') { storeRepairCommand(options); return; }
    throw new Error('Usage: mapctx store <init|repair> [--json]');
  }

  if (command === 'import') {
    if (options.commit) { importCommitCliCommand(options); return; }
    importDryRunCliCommand(options);
    return;
  }

  if (command === 'export') {
    exportCliCommand(options);
    return;
  }

  if (command === 'validate') {
    mapctxValidateCliCommand(options);
    return;
  }

  if (command === 'plan') {
    mapctxPlanCommand(options);
    return;
  }

  if (command === 'gantt') {
    mapctxGanttCommand(options);
    return;
  }

  if (command === 'task') {
    if (subcommand === 'create') { taskCreateCommand(options); return; }
    const taskId = positional[1];
    if (!taskId) throw new Error('Usage: mapctx task <create|show|context|claim|renew|release|move|update> [...]');
    if (subcommand === 'show') { taskShowCommand(taskId, options); return; }
    if (subcommand === 'context') { taskContextCommand(taskId, options); return; }
    if (subcommand === 'claim') { taskClaimCommand(taskId, options); return; }
    if (subcommand === 'renew') { taskRenewCommand(taskId, options); return; }
    if (subcommand === 'release') { taskReleaseCommand(taskId, options); return; }
    if (subcommand === 'move') { taskMoveCommand(taskId, options); return; }
    if (subcommand === 'update') { taskUpdateCommand(taskId, options); return; }
    throw new Error('Usage: mapctx task <create|show|context|claim|renew|release|move|update> <task-id> [...]');
  }

  if (command === 'dispatch') {
    if (subcommand === 'create' && positional[1]) { dispatchCreateCommand(positional[1], options); return; }
    const dispatchId = positional[1];
    if (subcommand === 'receipt' && dispatchId) { dispatchReceiptCommand(dispatchId, options); return; }
    throw new Error('Usage: mapctx dispatch create <task-id> [...] | mapctx dispatch receipt <dispatch-id> [...]');
  }

  if (command === 'reconcile') {
    const taskId = positional[0];
    if (!taskId) throw new Error('Usage: mapctx reconcile <task-id> [--accept | --discard] [--json]');
    reconcileCliCommand(taskId, options);
    return;
  }

  if (command === 'sync' && subcommand === 'status') {
    await syncStatusCommand(options);
    return;
  }

  if (command === 'account') {
    if (subcommand === 'add') { accountAddCommand(positional[1], options); return; }
    if (subcommand === 'list') { accountListCommand(options); return; }
    if (subcommand === 'bind') { accountBindCommand(positional[1], options); return; }
    throw new Error('Usage: mapctx account <add|list|bind> [...]');
  }

  if (command === 'plan-period') {
    if (subcommand === 'record') { planPeriodRecordCommand(options); return; }
    throw new Error('Usage: mapctx plan-period record --account <id-or-name> --amount <decimal> --start <date|datetime> --end <date|datetime>');
  }

  if (command === 'budget') {
    if (subcommand === 'set') { budgetSetCommand(positional[1], options); return; }
    if (subcommand === 'status') { budgetStatusCommand(positional[1], options); return; }
    if (subcommand === 'history') { budgetHistoryCommand(positional[1], options); return; }
    throw new Error('Usage: mapctx budget <set|status|history> <epic-id> [...]');
  }

  printHelp();
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
