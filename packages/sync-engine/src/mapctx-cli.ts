#!/usr/bin/env node
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureWorkspaceRegistry } from '@mapctx/core/workspace';
import { parseTasksFile } from '@mapctx/core';
import {
  buildExport,
  claimTask,
  diffTaskForReconcile,
  importCommit,
  importDryRun,
  isStoreMaterialized,
  reconcileAccept,
  reconcileDiscard,
  recoverStoreFromCheckpoint,
  releaseClaim,
  recordRunReceipt,
  listDispatchAttempts,
  listReceiptsForDispatch,
  renewClaim,
  resolveMapctxToml,
  resolveProjectStoreDir,
  repairStore,
  StoreHandle,
  queryTask,
  queryTaskFromMarkdown,
  queryTaskContext,
  queryTaskContextFromMarkdown,
  listDependencies,
  listTasks,
  validateStoreRegime,
  type MapctxTomlConfig
} from '@mapctx/store';
import { validateCommand } from './board-tools';
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
  console.log('  mapctx task claim <task-id> [--json] [--actor name] [--holder json]');
  console.log('  mapctx task renew <task-id> --claim id --token token [--json] [--actor name]');
  console.log('  mapctx task release <task-id> --claim id --token token [--json] [--actor name]');
  console.log('  mapctx dispatch receipt <dispatch-id> --receipt path [--json] [--actor name]');
  console.log('  mapctx dispatch receipt <dispatch-id> --read --json');
  console.log('  mapctx reconcile <task-id> [--accept | --discard] [--json] [--actor name]');
  console.log('  mapctx sync status [--json]');
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
  return options.tasksFileOverride ? path.resolve(cwd, options.tasksFileOverride) : path.join(cwd, 'TASKS.md');
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
function openStoreOrFail(cwd: string): OpenStoreResult {
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
  const result = importDryRun({ tasksFilePath });
  print(result, options.json);
  if (result.plan.errors > 0) {
    throw new Error(`Import validation failed with ${result.plan.errors} error(s).`);
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

function mapctxValidateCliCommand(options: MapctxOptions): void {
  const cwd = process.cwd();

  let structuralOk = true;
  try {
    validateCommand(options);
  } catch {
    structuralOk = false;
  }

  const storeResult = validateStoreRegime(cwd, cwd);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(storeResult, null, 2)}\n`);
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
    }
  }

  const driftFailed = storeResult.status === 'store-authority' && storeResult.drift.hasDrift;
  const semanticFailed = storeResult.status === 'store-authority' && storeResult.semantic.errors > 0;
  const notMaterialized = storeResult.status === 'not-materialized';
  if (!structuralOk || driftFailed || semanticFailed || notMaterialized) {
    throw new Error('mapctx validate failed.');
  }
}

function taskClaimCommand(taskId: string, options: MapctxOptions): void {
  const cwd = process.cwd();
  const { handle } = openStoreOrFail(cwd);
  try {
    const holder = options.holder ? (JSON.parse(options.holder) as Record<string, unknown>) : { pid: process.pid, host: os.hostname() };
    const result = claimTask(handle, { taskId, actor: defaultActor(options.actor), holder });
    print(result, options.json);
    if (!result.ok) throw new Error(`Claim failed: ${result.reason}`);
  } finally {
    handle.close();
  }
}

function taskShowCommand(taskId: string, options: MapctxOptions): void {
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml || toml.config.plansAuthority !== 'store') {
    const tasksFilePath = resolveTasksFilePath(cwd, options);
    print(queryTaskFromMarkdown(path.dirname(tasksFilePath), taskId, tasksFilePath), options.json);
    return;
  }
  const { handle } = openStoreOrFail(cwd);
  try {
    print(queryTask(handle.db, taskId), options.json);
  } finally {
    handle.close();
  }
}

function taskContextCommand(taskId: string, options: MapctxOptions): void {
  if (!options.budget) throw new Error('task context requires --budget <n>');
  const cwd = process.cwd();
  const toml = resolveMapctxToml(cwd);
  if (!toml || toml.config.plansAuthority !== 'store') {
    const tasksFilePath = resolveTasksFilePath(cwd, options);
    print(queryTaskContextFromMarkdown(path.dirname(tasksFilePath), taskId, { budget: options.budget }, tasksFilePath), options.json);
    return;
  }
  const { handle } = openStoreOrFail(cwd);
  try {
    print(queryTaskContext(handle.db, taskId, { budget: options.budget, tasksRoot: cwd }), options.json);
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
    const board = parseTasksFile(resolveTasksFilePath(process.cwd(), options));
    // dependencyEdges is the single source of truth for board-sourced plans; task.dependsOn is
    // omitted here so the same relation is never sent to the planner twice (see T-063).
    const dependencyEdges = board.tasks.flatMap(task => (task.dependsOn ?? []).map(toTaskId => ({
      fromTaskId: task.id,
      toTaskId,
      kind: 'depends-on' as const
    })));
    print(planner.planExecution({
      tasks: board.tasks.map(task => ({
        id: task.id,
        title: task.title,
        status: task.status,
        type: task.type,
        parent: task.parent ?? null,
        domains: task.domains ?? task.touch ?? []
      })),
      dependencyEdges
    }), options.json);
    return;
  }

  const { handle } = openStoreOrFail(process.cwd());
  try {
    const tasks = listTasks(handle.db);
    const edges = listDependencies(handle.db);
    // dependencyEdges is the single source of truth here too; task.dependsOn is omitted (see
    // the TASKS.md fallback branch above and T-063).
    print(planner.planExecution({
      tasks: tasks.map(task => ({
        id: task.taskId,
        title: task.title,
        status: task.planningState,
        type: task.type ?? undefined,
        parent: task.parentTaskId ?? null,
        domains: task.domains
      })),
      dependencyEdges: edges.map(edge => ({ fromTaskId: edge.fromTaskId, toTaskId: edge.toTaskId, kind: edge.kind }))
    }), options.json);
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

function dispatchReceiptCommand(dispatchId: string, options: MapctxOptions): void {
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
    print(result, options.json);
    if (!result.ok) throw new Error(`Receipt rejected: ${result.reason}`);
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

  if (command === 'task') {
    const taskId = positional[1];
    if (!taskId) throw new Error('Usage: mapctx task <claim|renew|release> <task-id> [...]');
    if (subcommand === 'show') { taskShowCommand(taskId, options); return; }
    if (subcommand === 'context') { taskContextCommand(taskId, options); return; }
    if (subcommand === 'claim') { taskClaimCommand(taskId, options); return; }
    if (subcommand === 'renew') { taskRenewCommand(taskId, options); return; }
    if (subcommand === 'release') { taskReleaseCommand(taskId, options); return; }
    throw new Error('Usage: mapctx task <claim|renew|release> <task-id> [...]');
  }

  if (command === 'dispatch') {
    const dispatchId = positional[1];
    if (subcommand === 'receipt' && dispatchId) { dispatchReceiptCommand(dispatchId, options); return; }
    throw new Error('Usage: mapctx dispatch receipt <dispatch-id> --receipt <path> [--json]');
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

  printHelp();
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
