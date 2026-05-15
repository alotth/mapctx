#!/usr/bin/env node
import { ensureWorkspaceRegistry } from '@mapctx/core/workspace';
import { parseWorkspaceServerArgs, startWorkspaceServer } from './workspace-server';

function printHelp(): void {
  console.log('mapctx CLI');
  console.log('');
  console.log('Commands:');
  console.log('  mapctx workspace [path] [--add path] [--org id] [--org-name name] [--org-path path] [--target target-id] [--port n] [--no-open]');
  console.log('  mapctx workspace:add <path> [--org id] [--org-name name] [--org-path path]');
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'workspace') {
    const options = parseWorkspaceServerArgs(rest);
    void startWorkspaceServer({ ...options, open: options.open ?? true }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exit(1);
    });
    return;
  }

  if (command === 'workspace:add') {
    const options = parseWorkspaceServerArgs(rest);
    const projectPath = options.addProjectPath || options.projectPath;
    if (!projectPath) throw new Error('workspace:add requires <path>');
    const result = ensureWorkspaceRegistry({
      cwd: options.cwd,
      addProjectPath: projectPath,
      organizationId: options.organizationId,
      organizationName: options.organizationName,
      organizationPath: options.organizationPath,
      registryPath: options.registryPath
    });
    console.log(`Registered project in ${result.registryPath}`);
    if (result.addedProject) {
      console.log(`${result.addedProject.name}: ${result.addedProject.path}`);
    }
    return;
  }

  printHelp();
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}
