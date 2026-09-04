import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import test from 'node:test';
import {
  dispatchCreateCommand,
  mapctxValidateCliCommand,
  taskMoveCommand,
  taskUpdateCommand
} from './mapctx-cli';

const BOARD = `# Tasks - write test

## Work Domains

- CORE: core engine work

## Tasks

### [E-200] Epic for CLI writes

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

### [T-201] Task with an empty patch target

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
  - summary: Epic for CLI write tests.
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
  - summary: Task for CLI write tests.
  - description: |
      Single line.
`;

const LEGACY_CONFIG = {
  owner: 'octocat',
  repo: 'cli-write-test',
  projectId: 'PVT_fixture2',
  statusFieldId: 'PVTSSF_fixture2',
  statusMap: {
    backlog: 'Backlog',
    'ready-for-do': 'Ready for Do',
    doing: 'Doing',
    review: 'Review',
    done: 'Done',
    paused: 'Paused'
  },
  tasksFile: './TASKS.md'
};

function setupCutoverRepo(): { repoDir: string; restore: () => void } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-cli-write-'));
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

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-cli-write-home-'));
  const previousHome = process.env.MAPCTX_HOME;
  const previousCwd = process.cwd();
  process.env.MAPCTX_HOME = home;
  process.chdir(repoDir);

  return {
    repoDir,
    restore: () => {
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.MAPCTX_HOME;
      else process.env.MAPCTX_HOME = previousHome;
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

function readTasksMd(): string {
  return fs.readFileSync('TASKS.md', 'utf8');
}

test('task move: legal transition regenerates the canonical board and keeps validate green', () => {
  const { restore } = setupCutoverRepo();
  try {
    // Cutover to store authority first.
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'import', '--commit'], { stdio: 'ignore' });

    taskMoveCommand('T-201', { status: 'ready-for-do', json: true } as never);

    const onDisk = readTasksMd();
    const t201Block = onDisk.slice(onDisk.indexOf('### [T-201]'));
    assert.ok(t201Block.includes('- status: ready-for-do'), 'board status must follow the store after the move');

    // The store changed; the regenerated board must not drift.
    mapctxValidateCliCommand({ json: true } as never);

    // Illegal jump must be refused and change nothing on disk.
    const before = readTasksMd();
    assert.throws(() => taskMoveCommand('T-201', { status: 'done', json: true } as never), /illegal-transition/);
    assert.equal(readTasksMd(), before, 'a refused move must not touch the board');
  } finally {
    restore();
  }
});

test('task update: whitelisted fields land on board and detail file together', () => {
  const { restore } = setupCutoverRepo();
  try {
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'import', '--commit'], { stdio: 'ignore' });

    taskUpdateCommand('T-201', {
      setPairs: ['priority=high', 'detail.estimatedEffort=2d'],
      dependsOn: 'E-200',
      json: true
    } as never);

    const onDisk = readTasksMd();
    const t201Block = onDisk.slice(onDisk.indexOf('### [T-201]'));
    assert.ok(t201Block.includes('- priority: high'));
    assert.ok(t201Block.includes('- dependsOn: [E-200]'));

    const detail = fs.readFileSync(path.join('tasks', 'T-201.md'), 'utf8');
    assert.ok(detail.includes('- estimatedEffort: 2d'));
    assert.ok(detail.includes('- prerequisites: [E-200]'));

    mapctxValidateCliCommand({ json: true } as never);

    assert.throws(() => taskUpdateCommand('T-201', { setPairs: ['planningState=done'], json: true } as never), /unknown-field/);
  } finally {
    restore();
  }
});

test('dispatch create: fresh dispatch then attempt+1 on the same dispatch id', () => {
  const { restore } = setupCutoverRepo();
  try {
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'import', '--commit'], { stdio: 'ignore' });

    let captured = '';
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      captured += String(chunk);
      return true;
    };
    try {
      dispatchCreateCommand('T-201', { executor: 'agent', json: true } as never);
    } finally {
      process.stdout.write = originalWrite;
    }
    const first = JSON.parse(captured);
    assert.equal(first.ok, true);
    assert.equal(first.attempt, 1);
    assert.match(first.dispatchId, /^[0-9a-f-]{36}$/);

    captured = '';
    process.stdout.write = (chunk: unknown) => {
      captured += String(chunk);
      return true;
    };
    try {
      dispatchCreateCommand('T-201', { dispatchId: first.dispatchId, json: true } as never);
    } finally {
      process.stdout.write = originalWrite;
    }
    const retry = JSON.parse(captured);
    assert.equal(retry.dispatchId, first.dispatchId);
    assert.equal(retry.attempt, 2, 'retry appends max(attempt)+1 to the same dispatch');

    assert.throws(() => dispatchCreateCommand('T-201', { dispatchId: '00000000-0000-0000-0000-000000000000', json: true } as never), /Unknown dispatch/);
  } finally {
    restore();
  }
});
