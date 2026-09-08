import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import test from 'node:test';
import { StoreHandle, resolveProjectStoreDir, writeMapctxToml } from '@mapctx/store';
import { planCommand, getValidationReport } from './board-tools';
import { mapctxPlanCommand, taskShowCommand, taskContextCommand, mapctxValidateCliCommand } from './mapctx-cli';

function makeTempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-resolution-')));
}

function writeTasks(dir: string): string {
  const lines = [
    '# Tasks - sample',
    '',
    '## Work Domains',
    '',
    '- SYNC: sync domain',
    '',
    '## Tasks',
    '',
    '### [T-001] first',
    '',
    '  - id: T-001',
    '  - status: ready-for-do',
    '  - type: task',
    '  - parent: null',
    '  - subIssueProgress: null',
    '  - priority: medium',
    '  - workload: Normal',
    '  - tags: []',
    '  - domains: []',
    '  - dependsOn: []',
    '  - start: null',
    '  - due: null',
    '  - completed: null',
    '  - externalId: null',
    '  - updated: 2026-08-17',
    '  - detail: null',
    '',
    '## Notes',
    ''
  ];
  const tasksFilePath = path.resolve(dir, 'TASKS.md');
  fs.writeFileSync(tasksFilePath, lines.join('\n'), 'utf8');
  return tasksFilePath;
}

function captureJson(run: () => void): unknown {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return JSON.parse(chunks.join(''));
}

function captureJsonError(run: () => void): { output: unknown; error: unknown } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  } finally {
    process.stdout.write = original;
  }
  return { output: JSON.parse(chunks.join('')), error };
}

function withCwd<T>(dir: string, fn: () => T): T {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.resolve(dir, '.gitignore'), '', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
}

test('mapctx plan resolves TASKS.md by walking up from a nested subdirectory', () => {
  const root = makeTempDir();
  const tasksFilePath = writeTasks(root);
  const nested = path.resolve(root, 'packages', 'store');
  fs.mkdirSync(nested, { recursive: true });

  const report = withCwd(nested, () => captureJson(() => mapctxPlanCommand({ json: true } as never)));
  assert.equal((report as { tasksFilePath: string }).tasksFilePath, tasksFilePath);
});

test('mapctx task show resolves from a nested subdirectory', () => {
  const root = makeTempDir();
  const tasksFilePath = writeTasks(root);
  const nested = path.resolve(root, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });

  const result = withCwd(nested, () => captureJson(() => taskShowCommand('T-001', { json: true } as never))) as { taskId: string; tasksFilePath: string };
  assert.equal(result.taskId, 'T-001');
  assert.equal(result.tasksFilePath, tasksFilePath);
});

test('mapctx task context resolves from a nested subdirectory', () => {
  const root = makeTempDir();
  const tasksFilePath = writeTasks(root);
  const nested = path.resolve(root, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });

  const result = withCwd(nested, () =>
    captureJson(() => taskContextCommand('T-001', { json: true, budget: 1000 } as never))
  ) as { taskId: string; tasksFilePath: string };
  assert.equal(result.taskId, 'T-001');
  assert.equal(result.tasksFilePath, tasksFilePath);
});

test('mapctx validate reports the resolved board path in --json from a nested subdirectory', () => {
  const root = makeTempDir();
  const tasksFilePath = writeTasks(root);
  const nested = path.resolve(root, 'nested');
  fs.mkdirSync(nested, { recursive: true });

  const result = withCwd(nested, () => captureJson(() => mapctxValidateCliCommand({ json: true } as never))) as { tasksFilePath: string };
  assert.equal(result.tasksFilePath, tasksFilePath);
});

test('mapcs plan resolves TASKS.md by walking up from a nested subdirectory', () => {
  const root = makeTempDir();
  const tasksFilePath = writeTasks(root);
  const nested = path.resolve(root, 'packages', 'store');
  fs.mkdirSync(nested, { recursive: true });

  const report = withCwd(nested, () => planCommand({ json: false }));
  assert.equal(report.tasksFilePath, tasksFilePath);
});

test('mapcs validate resolves TASKS.md by walking up from a nested subdirectory', () => {
  const root = makeTempDir();
  const tasksFilePath = writeTasks(root);
  const nested = path.resolve(root, 'packages', 'store');
  fs.mkdirSync(nested, { recursive: true });

  const report = withCwd(nested, () => getValidationReport({}));
  assert.equal(report.tasksFilePath, tasksFilePath);
});

test('mapcs and mapctx agree on the resolved board path from the same nested subdirectory', () => {
  const root = makeTempDir();
  const tasksFilePath = writeTasks(root);
  const nested = path.resolve(root, 'packages', 'store');
  fs.mkdirSync(nested, { recursive: true });

  const mapcsReport = withCwd(nested, () => planCommand({ json: false }));
  const mapctxReport = withCwd(nested, () => captureJson(() => mapctxPlanCommand({ json: true } as never))) as { tasksFilePath: string };
  assert.equal(mapcsReport.tasksFilePath, tasksFilePath);
  assert.equal(mapctxReport.tasksFilePath, tasksFilePath);
});

test('mapcs and mapctx honor a discovered root config and its configured tasksFile from a nested subdirectory', () => {
  const root = makeTempDir();
  const boardDir = path.resolve(root, 'boards');
  fs.mkdirSync(boardDir, { recursive: true });
  const tasksFilePath = writeTasks(boardDir);
  const configuredTasksFilePath = path.resolve(boardDir, 'WORK.md');
  fs.renameSync(tasksFilePath, configuredTasksFilePath);
  fs.writeFileSync(path.resolve(root, 'mapcs.config.json'), `${JSON.stringify({
    owner: 'local',
    repo: 'configured-board',
    tasksFile: './boards/WORK.md',
    allowedStatuses: ['backlog', 'ready-for-do', 'doing', 'review', 'done', 'paused'],
    completionStatuses: ['done'],
    statusMap: {
      backlog: 'Backlog',
      'ready-for-do': 'Ready for Do',
      doing: 'Doing',
      review: 'Review',
      done: 'Done',
      paused: 'Paused'
    }
  }, null, 2)}\n`, 'utf8');
  initGitRepo(root);
  const nested = path.resolve(root, 'packages', 'store');
  fs.mkdirSync(nested, { recursive: true });

  const mapcsReport = withCwd(nested, () => planCommand({ json: false }));
  const mapctxReport = withCwd(nested, () =>
    captureJson(() => mapctxPlanCommand({ json: true } as never))
  ) as { tasksFilePath: string };

  assert.equal(mapcsReport.tasksFilePath, configuredTasksFilePath);
  assert.equal(mapctxReport.tasksFilePath, configuredTasksFilePath);
});

test('explicit --tasks-file overrides discovery and is resolved relative to cwd', () => {
  const root = makeTempDir();
  writeTasks(root);
  const nested = path.resolve(root, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  const altTasksFile = path.resolve(nested, 'ALT.md');
  fs.writeFileSync(altTasksFile, fs.readFileSync(path.resolve(root, 'TASKS.md'), 'utf8'), 'utf8');

  const mapcsReport = withCwd(nested, () => planCommand({ tasksFileOverride: 'ALT.md', json: false }));
  assert.equal(mapcsReport.tasksFilePath, altTasksFile);

  const mapctxReport = withCwd(nested, () =>
    captureJson(() => mapctxPlanCommand({ json: true, tasksFileOverride: 'ALT.md' } as never))
  ) as { tasksFilePath: string };
  assert.equal(mapctxReport.tasksFilePath, altTasksFile);
});

test('resolution stops at the repository root and does not adopt a TASKS.md from an outer directory', () => {
  const outer = makeTempDir();
  writeTasks(outer);
  const repo = path.resolve(outer, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  initGitRepo(repo);
  const nested = path.resolve(repo, 'packages', 'store');
  fs.mkdirSync(nested, { recursive: true });

  assert.throws(() => withCwd(nested, () => getValidationReport({})));
});

test('git worktree: mapcs and mapctx resolve the board from a nested subdirectory inside the worktree', () => {
  const source = makeTempDir();
  const repo = path.resolve(source, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const tasksFilePath = writeTasks(repo);
  initGitRepo(repo);

  const worktreeParent = makeTempDir();
  const worktree = path.resolve(worktreeParent, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt-branch', worktree], { cwd: repo });
  try {
    const nested = path.resolve(worktree, 'packages', 'store');
    fs.mkdirSync(nested, { recursive: true });
    const worktreeTasksFile = path.resolve(worktree, 'TASKS.md');

    const mapcsReport = withCwd(nested, () => planCommand({ json: false }));
    assert.equal(mapcsReport.tasksFilePath, worktreeTasksFile);

    const mapctxReport = withCwd(nested, () =>
      captureJson(() => mapctxPlanCommand({ json: true } as never))
    ) as { tasksFilePath: string };
    assert.equal(mapctxReport.tasksFilePath, worktreeTasksFile);
  } finally {
    execFileSync('git', ['worktree', 'remove', '-f', worktree], { cwd: repo });
  }
});

test('store-only mapctx reads work from nested cwd without requiring TASKS.md and preserve git detail sections', () => {
  const root = makeTempDir();
  const mapctxHome = makeTempDir();
  const previousHome = process.env.MAPCTX_HOME;
  const projectId = '11111111-1111-4111-8111-111111111111';
  process.env.MAPCTX_HOME = mapctxHome;
  try {
    writeMapctxToml(path.resolve(root, 'mapctx.toml'), { schemaVersion: 1, projectId, plansAuthority: 'store' });
    fs.mkdirSync(path.resolve(root, 'tasks'), { recursive: true });
    fs.writeFileSync(path.resolve(root, 'tasks', 'T-001.md'), [
      '# T-001',
      '',
      '## Acceptance',
      '- [ ] Nested store context keeps this criterion',
      '',
      '## Decisions Taken',
      '- [2026-08-26] Resolve detail paths from the project root',
      ''
    ].join('\n'), 'utf8');

    const handle = StoreHandle.open(resolveProjectStoreDir(projectId));
    try {
      handle.appendEvent({
        eventType: 'project.initialized',
        actor: 'test',
        payload: { projectId, boardTitle: 'store-only', workDomains: [], notesMarkdown: '', plansAuthority: 'store' }
      });
      handle.appendEvent({
        eventType: 'task.upserted',
        actor: 'test',
        payload: {
          task: {
            taskId: 'T-001',
            positionKey: 1,
            title: 'store task',
            planningState: 'backlog',
            executionState: 'unclaimed',
            type: 'task',
            parentTaskId: null,
            tags: [],
            domains: [],
            externalLinks: [],
            assignees: [],
            detailPath: './tasks/T-001.md'
          },
          detail: {
            taskId: 'T-001',
            role: 'implementation',
            impact: 'medium',
            estimatedEffort: '1d',
            prerequisites: [],
            blocking: [],
            filesAffected: [],
            testsRequired: [],
            summary: 'store-only nested context'
          },
          outgoingEdges: []
        }
      });
    } finally {
      handle.close();
    }

    const nested = path.resolve(root, 'packages', 'store', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(fs.existsSync(path.resolve(root, 'TASKS.md')), false);
    assert.equal(fs.existsSync(path.resolve(root, 'mapcs.config.json')), false);

    const plan = withCwd(nested, () => captureJson(() => mapctxPlanCommand({ json: true } as never))) as { tasksFilePath: string };
    const shown = withCwd(nested, () => captureJson(() => taskShowCommand('T-001', { json: true } as never))) as { task: { taskId: string }; tasksFilePath: string };
    const context = withCwd(nested, () => captureJson(() => taskContextCommand('T-001', { json: true, budget: 1000 } as never))) as {
      acceptanceCriteria: string[];
      decisions: string[];
      tasksFilePath: string;
    };

    const checkpointPath = path.resolve(root, 'TASKS.md');
    assert.equal(plan.tasksFilePath, checkpointPath);
    assert.equal(shown.task.taskId, 'T-001');
    assert.equal(shown.tasksFilePath, checkpointPath);
    assert.equal(context.tasksFilePath, checkpointPath);
    assert.ok(context.acceptanceCriteria.some(value => value.includes('Nested store context')));
    assert.ok(context.decisions.some(value => value.includes('project root')));
  } finally {
    if (previousHome === undefined) delete process.env.MAPCTX_HOME;
    else process.env.MAPCTX_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mapctxHome, { recursive: true, force: true });
  }
});

test('mapctx validate --json emits one machine-readable error when board resolution fails', () => {
  const root = makeTempDir();
  initGitRepo(root);
  const nested = path.resolve(root, 'nested');
  fs.mkdirSync(nested, { recursive: true });

  const captured = withCwd(nested, () => captureJsonError(() => mapctxValidateCliCommand({ json: true } as never)));
  assert.ok(captured.error instanceof Error);
  assert.equal((captured.output as { error: string }).error, 'board-resolution-failed');
  assert.equal((captured.output as { tasksFilePath: null }).tasksFilePath, null);
});
