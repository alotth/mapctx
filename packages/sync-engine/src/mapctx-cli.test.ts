import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import { planExecution } from '@mapctx/planner';
import { parseTasksFile } from '@mapctx/core';
import { mapctxPlanCommand, taskSearchCommand } from './mapctx-cli';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-cli-'));
}

function taskBlock(fields: {
  id: string;
  title: string;
  status: string;
  type?: string;
  parent?: string;
  dependsOn?: string[];
}): string[] {
  return [
    `### [${fields.id}] ${fields.title}`,
    '',
    `  - id: ${fields.id}`,
    `  - status: ${fields.status}`,
    `  - type: ${fields.type ?? 'task'}`,
    `  - parent: ${fields.parent ?? 'null'}`,
    '  - subIssueProgress: null',
    '  - priority: medium',
    '  - workload: Normal',
    '  - tags: []',
    '  - domains: []',
    `  - dependsOn: [${(fields.dependsOn ?? []).join(', ')}]`,
    '  - start: null',
    '  - due: null',
    '  - completed: null',
    '  - externalId: null',
    '  - updated: 2026-08-17',
    '  - detail: null',
    ''
  ];
}

function writeTasks(tempDir: string, taskFields: Parameters<typeof taskBlock>[0][]): string {
  const lines = [
    '# Tasks - sample',
    '',
    '## Work Domains',
    '',
    '- SYNC: sync domain',
    '',
    '## Tasks',
    '',
    ...taskFields.flatMap(taskBlock),
    '## Notes',
    ''
  ];
  const tasksFilePath = path.resolve(tempDir, 'TASKS.md');
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

test('mapctx plan --json and direct planExecution agree on the same board (CLI/library parity)', () => {
  const tempDir = makeTempDir();
  writeTasks(tempDir, [
    { id: 'T-001', title: 'first', status: 'ready-for-do' },
    { id: 'T-002', title: 'depends on first', status: 'backlog', dependsOn: ['T-001'] },
    { id: 'T-003', title: 'independent', status: 'backlog' }
  ]);

  const previousCwd = process.cwd();
  process.chdir(tempDir);
  let cliReport: unknown;
  try {
    cliReport = captureJson(() => mapctxPlanCommand({ json: true } as never));
  } finally {
    process.chdir(previousCwd);
  }

  const board = parseTasksFile(path.resolve(tempDir, 'TASKS.md'));
  const dependencyEdges = board.tasks.flatMap(task => (task.dependsOn ?? []).map(toTaskId => ({
    fromTaskId: task.id,
    toTaskId,
    kind: 'depends-on' as const
  })));
  const libraryReport = planExecution({
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

  assert.deepEqual((cliReport as { waves: Array<{ taskIds: string[] }> }).waves.map(wave => wave.taskIds), [
    ['T-001', 'T-003'],
    ['T-002']
  ]);
  assert.deepEqual(cliReport, { ...(libraryReport as Record<string, unknown>), tasksFilePath: path.resolve(fs.realpathSync(tempDir), 'TASKS.md') });
});

test('real board (this repo TASKS.md): every non-terminal, non-container task is scheduled or named in blockedReasons', () => {
  const tasksFilePath = path.resolve(__dirname, '../../../TASKS.md');
  const board = parseTasksFile(tasksFilePath);
  const dependencyEdges = board.tasks.flatMap(task => (task.dependsOn ?? []).map(toTaskId => ({
    fromTaskId: task.id,
    toTaskId,
    kind: 'depends-on' as const
  })));
  const report = planExecution({
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

  const containers = new Set(
    board.tasks.filter(task => task.type === 'epic' || board.tasks.some(other => (other.parent ?? null) === task.id)).map(task => task.id)
  );
  const terminal = new Set(['done', 'cancelled']);
  const accountedFor = new Set([...Object.keys(report.waveByTaskId), ...report.blockedReasons.map(reason => reason.taskId)]);

  for (const task of board.tasks) {
    if (containers.has(task.id) || terminal.has(task.status)) continue;
    assert.ok(accountedFor.has(task.id), `expected ${task.id} (status: ${task.status}) to appear in a wave or blockedReasons`);
  }
});

test('task search markdown fallback matches accent-folded and returns compact hits', () => {
  const tempDir = makeTempDir();
  writeTasks(tempDir, [
    { id: 'T-001', title: 'Divêrgência Ção reconciliação', status: 'done' },
    { id: 'T-002', title: 'unrelated', status: 'backlog', dependsOn: ['T-001'] }
  ]);

  const previousCwd = process.cwd();
  process.chdir(tempDir);
  let result: { query?: string; matches?: Array<{ taskId: string; title: string; planningState: string; completedOn: string | null; tags: string[]; domains: string[]; summary: string | null }> };
  try {
    result = captureJson(() => taskSearchCommand({ query: 'divergencia cao', json: true } as never)) as typeof result;
  } finally {
    process.chdir(previousCwd);
  }

  assert.equal(result.query, 'divergencia cao');
  assert.deepEqual(result.matches, [
    {
      taskId: 'T-001',
      title: '[T-001] Divêrgência Ção reconciliação',
      planningState: 'done',
      completedOn: null,
      tags: [],
      domains: [],
      summary: null
    }
  ]);
});

test('task search markdown fallback filters by status and limit', () => {
  const tempDir = makeTempDir();
  writeTasks(tempDir, [
    { id: 'T-001', title: 'channel runtime', status: 'done' },
    { id: 'T-002', title: 'channel handoff', status: 'backlog' }
  ]);

  const previousCwd = process.cwd();
  process.chdir(tempDir);
  let filtered: { matches?: Array<{ taskId: string }> };
  let limited: { matches?: Array<{ taskId: string }> };
  try {
    filtered = captureJson(() => taskSearchCommand({ query: 'channel', status: 'backlog', json: true } as never)) as typeof filtered;
    limited = captureJson(() => taskSearchCommand({ query: 'channel', limit: 1, json: true } as never)) as typeof limited;
  } finally {
    process.chdir(previousCwd);
  }

  assert.deepEqual(filtered.matches!.map(hit => hit.taskId), ['T-002']);
  assert.deepEqual(limited.matches!.map(hit => hit.taskId), ['T-001']);
});
