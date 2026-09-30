import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import test from 'node:test';
import { taskMoveCommand, taskUpdateCommand } from './mapctx-cli';

const BOARD = `# Tasks - board test

## Work Domains

- CORE: core engine work

## Tasks

### [E-200] Epic for board reads

  - id: E-200
  - status: doing
  - type: epic
  - parent: null
  - subIssueProgress: null
  - priority: high
  - workload: Normal
  - tags: []
  - domains: [CORE]
  - dependsOn: []
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: 2026-09-01
  - detail: ./tasks/E-200.md

### [T-201] Task for board reads

  - id: T-201
  - status: backlog
  - type: task
  - parent: E-200
  - subIssueProgress: null
  - priority: null
  - workload: null
  - tags: []
  - domains: []
  - dependsOn: []
  - start: null
  - due: null
  - completed: null
  - externalId: null
  - updated: null
  - detail: ./tasks/T-201.md

## Notes
`;

const DETAIL_E200 = `# E-200

  - role: coordination
  - impact: high
  - estimatedEffort: 1w
  - prerequisites: []
  - blocking: []
  - filesAffected: []
  - testsRequired: []
  - summary: Epic for board read tests.
  - description: |
      Goals live here.
`;

const DETAIL_T201 = `# T-201

  - role: implementation
  - impact: low
  - estimatedEffort: 1d
  - prerequisites: []
  - blocking: []
  - filesAffected: []
  - testsRequired: []
  - summary: Task for board read tests.
  - description: |
      Single line.

      ## Acceptance
      - [ ] Board read test.
`;

const LEGACY_CONFIG = {
  owner: 'octocat',
  repo: 'board-read-test',
  projectId: 'PVT_fixture_board',
  statusFieldId: 'PVTSSF_fixture_board',
  statusMap: {
    backlog: 'Backlog',
    'ready-for-do': 'Ready for Do',
    doing: 'Doing',
    review: 'Review',
    done: 'Done',
    paused: 'Paused',
    cancelled: 'Cancelled',
    archived: 'Archived'
  },
  tasksFile: './TASKS.md'
};

function runBoardCli(): { title: string; mode: string; tasks: Array<Record<string, unknown>> } {
  const stdout = execFileSync('node', [require.resolve('./mapctx-cli.js'), 'board', '--json'], {
    encoding: 'utf8',
    cwd: process.cwd()
  });
  return JSON.parse(stdout);
}

function taskById(dataset: { tasks: Array<Record<string, unknown>> }, id: string): Record<string, unknown> {
  const task = dataset.tasks.find(entry => entry.id === id);
  assert.ok(task, `task ${id} must be in the board dataset`);
  return task;
}

function writeBoardRepo(repoDir: string): void {
  fs.mkdirSync(path.join(repoDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'TASKS.md'), BOARD, 'utf8');
  fs.writeFileSync(path.join(repoDir, 'tasks', 'E-200.md'), DETAIL_E200, 'utf8');
  fs.writeFileSync(path.join(repoDir, 'tasks', 'T-201.md'), DETAIL_T201, 'utf8');
  fs.writeFileSync(path.join(repoDir, 'mapcs.config.json'), `${JSON.stringify(LEGACY_CONFIG, null, 2)}\n`, 'utf8');
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial board']);
}

test('mapctx board: store authority serves the SQLite projection through the export field mapping', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-board-store-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-board-store-home-'));
  const previousHome = process.env.MAPCTX_HOME;
  const previousCwd = process.cwd();
  process.env.MAPCTX_HOME = home;
  process.chdir(repoDir);

  try {
    writeBoardRepo(repoDir);
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'import', '--commit'], { stdio: 'ignore' });

    // Store-backed baseline: statuses mapped back to the TASKS.md vocabulary,
    // sub-issue progress derived from children, hierarchy and detail intact.
    const storeDataset = runBoardCli();
    assert.equal(storeDataset.mode, 'store');
    assert.equal(storeDataset.title, 'Tasks - board test');
    assert.equal(storeDataset.tasks.length, 2);

    const epic = taskById(storeDataset, 'E-200');
    assert.equal(epic.status, 'doing');
    assert.equal(epic.priority, 'high');
    assert.equal(epic.detailPath, './tasks/E-200.md');
    assert.equal(epic.subIssueProgress, '0/1');

    const child = taskById(storeDataset, 'T-201');
    assert.equal(child.status, 'backlog');
    assert.equal(child.parent, 'E-200');

    // A planning-state move lands on the board in board vocabulary.
    taskMoveCommand('T-201', { status: 'ready-for-do', json: true } as never);
    taskMoveCommand('T-201', { status: 'doing', json: true } as never);
    assert.equal(taskById(runBoardCli(), 'T-201').status, 'doing');

    // Dependencies come from the store's dependency projection.
    taskUpdateCommand('T-201', { dependsOn: 'E-200', json: true } as never);
    assert.deepEqual(taskById(runBoardCli(), 'T-201').dependsOn, ['E-200']);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) {delete process.env.MAPCTX_HOME;}
    else {process.env.MAPCTX_HOME = previousHome;}
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('mapctx board: pre-cutover repos keep parsing TASKS.md with the v2-status model', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-board-file-'));
  const previousCwd = process.cwd();
  process.chdir(repoDir);

  try {
    writeBoardRepo(repoDir);

    const dataset = runBoardCli();
    assert.equal(dataset.mode, 'v2-status');
    assert.equal(dataset.title, 'Tasks - board test');
    assert.equal(dataset.tasks.length, 2);

    const epic = taskById(dataset, 'E-200');
    assert.equal(epic.status, 'doing');
    assert.equal(epic.subIssueProgress ?? null, null, 'unset markdown nulls stay unset in the view');

    const child = taskById(dataset, 'T-201');
    assert.equal(child.parent, 'E-200');
    assert.equal(child.completed, undefined);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
