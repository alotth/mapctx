#!/usr/bin/env node
import { initConfigCommand } from './config';
import { bootstrapCommand, listConflictsCommand, pullCommand, pushCommand, reconcileCommand, statusCommand } from './sync';
import { planCommand, validateCommand } from './board-tools';
import { SyncOptions } from './types';

function parseArgs(argv: string[]): {
  command: string;
  options: SyncOptions;
  from?: 'local' | 'github';
  taskId?: string;
  help: boolean;
} {
  const args = [...argv];
  const command = args.shift() || 'help';
  const options: SyncOptions = {};
  let from: 'local' | 'github' | undefined;
  let taskId: string | undefined;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--dry-run') options.dryRun = true;
    else if (a === '--force') options.force = true;
    else if (a === '--list') options.list = true;
    else if (a === '--json') options.json = true;
    else if (a === '--confirm') options.confirm = true;
    else if (a === '--mermaid') options.mermaid = true;
    else if (a === '--accept') {
      const value = args[++i];
      if (value === 'local' || value === 'remote') options.accept = value;
      else throw new Error(`Invalid --accept value: ${value}`);
    }
    else if (a === '--config') options.configPath = args[++i];
    else if (a === '--tasks-file') options.tasksFileOverride = args[++i];
    else if (a === '--from') {
      const value = args[++i];
      if (value === 'local' || value === 'github') from = value;
      else throw new Error(`Invalid --from value: ${value}`);
    } else if (!a.startsWith('-') && !taskId) {
      taskId = a;
    }
  }

  return { command, options, from, taskId, help };
}

function printHelp(): void {
  console.log('mapcs CLI (deprecated alias; canonical CLI is `mapctx`)');
  console.log('');
  console.log('Commands:');
  console.log('  mapcs init [--force] [--config path] [--tasks-file path]');
  console.log('  mapcs status [--json] [--config path] [--tasks-file path]');
  console.log('  mapcs validate [--json] [--config path] [--tasks-file path]');
  console.log('  mapcs plan [--json] [--mermaid] [--config path] [--tasks-file path]');
  console.log('  mapcs pull [--dry-run] [--config path] [--tasks-file path]');
  console.log('  mapcs push [--dry-run] [--force] [--config path] [--tasks-file path]');
  console.log('  mapcs bootstrap --from <local|github> [--dry-run] [--confirm] [--config path] [--tasks-file path]');
  console.log('  mapcs reconcile <task-id> [--accept <local|remote>] [--config path] [--tasks-file path]');
  console.log('  mapcs reconcile --list [--json] [--config path] [--tasks-file path]');
}

function printCommandHelp(command: string): void {
  if (command === 'validate') {
    console.log('mapcs validate [--json] [--config path] [--tasks-file path]');
    console.log('');
    console.log('Validates a TASKS.md board. If mapcs.config.json is absent, uses ./TASKS.md or --tasks-file.');
    return;
  }
  if (command === 'plan') {
    console.log('mapcs plan [--json] [--mermaid] [--config path] [--tasks-file path]');
    console.log('');
    console.log('Builds dependency waves after validation. If mapcs.config.json is absent, uses ./TASKS.md or --tasks-file.');
    return;
  }
  printHelp();
}

const MAPCS_DEPRECATION_NOTICE =
  'Warning: `mapcs` is deprecated and will be removed in an upcoming release. ' +
  'Use `mapctx` instead. See docs/migration-mapcs-to-mapctx.md for the CLI and skill migration guide.';

function printDeprecationNotice(): void {
  console.error(MAPCS_DEPRECATION_NOTICE);
}

function main(): void {
  try {
    printDeprecationNotice();
    const { command, options, from, taskId, help } = parseArgs(process.argv.slice(2));

    if (command === 'help' || command === '--help' || command === '-h') {
      printHelp();
      return;
    }
    if (help) {
      printCommandHelp(command);
      return;
    }

    if (command === 'init') {
      initConfigCommand(options);
      return;
    }
    if (command === 'status') {
      statusCommand(options);
      return;
    }
    if (command === 'pull') {
      pullCommand(options);
      return;
    }
    if (command === 'validate') {
      validateCommand(options);
      return;
    }
    if (command === 'plan') {
      planCommand(options);
      return;
    }
    if (command === 'push') {
      pushCommand(options);
      return;
    }
    if (command === 'bootstrap') {
      if (!from) throw new Error('bootstrap requires --from <local|github>');
      bootstrapCommand(from, options);
      return;
    }
    if (command === 'reconcile') {
      if (options.list) {
        listConflictsCommand(options);
        return;
      }
      if (!taskId) throw new Error('reconcile requires <task-id>');
      reconcileCommand(taskId, options);
      return;
    }

    printHelp();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
