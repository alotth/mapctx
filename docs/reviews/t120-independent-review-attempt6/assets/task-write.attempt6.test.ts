import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import test from 'node:test';
import {
  dispatchCreateCommand,
  mapctxValidateCliCommand,
  taskCreateCommand,
  dispatchReceiptCommand,
  mapctxGanttCommand,
  taskClaimCommand,
  taskStartCommand,
  taskMoveCommand,
  taskUpdateCommand
} from './mapctx-cli';
import { finishTask } from './checkpoint';
import { listExportCheckpoints, resolveMapctxToml, resolveProjectStoreDir, StoreHandle, writeJournalEntrySync, payloadSha256 } from '@mapctx/store';
import { DatabaseSync } from 'node:sqlite';

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
  - workload: Normal
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

      ## Acceptance
      - [ ] CLI completion gate test.
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

test('task move: canonical store changes without regenerating local mirrors', () => {
  const { restore } = setupCutoverRepo();
  try {
    // Cutover to store authority first.
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'import', '--commit'], { stdio: 'ignore' });

    const boardBeforeMove = readTasksMd();
    taskMoveCommand('T-201', { status: 'ready-for-do', json: true } as never);

    const onDisk = readTasksMd();
    assert.equal(onDisk, boardBeforeMove, 'operational move leaves snapshots untouched');

    mapctxValidateCliCommand({ json: true } as never);
    assert.throws(() => mapctxValidateCliCommand({ json: true, snapshots: true } as never), /validate failed/);

    // Illegal jump must be refused and change nothing on disk.
    const before = readTasksMd();
    assert.throws(() => taskMoveCommand('T-201', { status: 'done', json: true } as never), /illegal-transition/);
    assert.equal(readTasksMd(), before, 'a refused move must not touch the board');
  } finally {
    restore();
  }
});

test('task move and reopen: completion gate then done-to-review reopen', () => {
  const { restore } = setupCutoverRepo();
  try {
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'import', '--commit'], { stdio: 'ignore' });
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'acceptance', 'import', '--commit', '--json'], { stdio: 'ignore' });
    taskMoveCommand('T-201', { status: 'ready-for-do', json: true } as never);
    taskMoveCommand('T-201', { status: 'doing', json: true } as never);
    taskMoveCommand('T-201', { status: 'review', json: true } as never);

    assert.throws(
      () => taskMoveCommand('T-201', { status: 'done', json: true } as never),
      /acceptance-incomplete.*pending approval/
    );
    assert.match(readTasksMd(), /- status: backlog/, 'moves leave mirror at its original state');

    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'task', 'acceptance', 'approve', 'T-201', '--index', '0', '--expect-revision', '1', '--json'], { stdio: 'ignore' });
    taskMoveCommand('T-201', { status: 'done', json: true } as never);
    assert.match(readTasksMd(), /- status: doing/, 'move does not rewrite local mirror');

    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'task', 'reopen', 'T-201', '--status', 'review', '--json', '--actor', 'reviewer'], { encoding: 'utf8' });
    assert.match(readTasksMd(), /- status: backlog/, 'reopen does not rewrite local mirror');
    mapctxValidateCliCommand({ json: true } as never);
  } finally {
    restore();
  }
});

test('task update: whitelisted fields land in canonical store without snapshot writes', () => {
  const { restore } = setupCutoverRepo();
  try {
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'import', '--commit'], { stdio: 'ignore' });
    const mirrorBefore = readTasksMd();

    taskUpdateCommand('T-201', {
      setPairs: ['priority=high', 'detail.estimatedEffort=2d'],
      dependsOn: 'E-200',
      json: true
    } as never);

    assert.equal(readTasksMd(), mirrorBefore, 'task update must not rewrite TASKS.md');

    const detail = fs.readFileSync(path.join('tasks', 'T-201.md'), 'utf8');
    assert.ok(detail.includes('- estimatedEffort: 1d'), 'detail snapshot remains unchanged');

    taskUpdateCommand('T-201', { setPairs: ['waitReason=decision'], json: true } as never);
    assert.doesNotMatch(fs.readFileSync(path.join('tasks', 'T-201.md'), 'utf8'), /waitReason:/);
    assert.throws(() => taskUpdateCommand('T-201', { setPairs: ['waitReason=guess'], json: true } as never), /invalid-wait-reason/);
    taskUpdateCommand('T-201', { setPairs: ['waitReason=null'], json: true } as never);
    assert.doesNotMatch(fs.readFileSync(path.join('tasks', 'T-201.md'), 'utf8'), /waitReason:/);

    mapctxValidateCliCommand({ json: true } as never);

    assert.throws(() => taskUpdateCommand('T-201', { setPairs: ['planningState=done'], json: true } as never), /unknown-field/);
  } finally {
    restore();
  }
});

test('task update CLI clears estimatedEffort=null and claim refuses the missing plan', () => {
  const { restore } = setupCutoverRepo();
  try {
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'import', '--commit'], { stdio: 'ignore' });
    taskUpdateCommand('T-201', { setPairs: ['detail.estimatedEffort=2d'], json: true } as never);
    taskUpdateCommand('T-201', { setPairs: ['detail.estimatedEffort=null'], json: true } as never);
    const detail = fs.readFileSync(path.join('tasks', 'T-201.md'), 'utf8');
    assert.match(detail, /estimatedEffort: 1d/);
    assert.throws(() => taskClaimCommand('T-201', { json: true } as never), /missing-workload-or-estimate/);
    mapctxValidateCliCommand({ json: true } as never);
  } finally {
    restore();
  }
});

test('task create: auto id, create its Git-authored detail only, validate canonical store', () => {
  const { restore } = setupCutoverRepo();
  try {
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'import', '--commit'], { stdio: 'ignore' });
    const mirrorBefore = readTasksMd();

    taskCreateCommand({
      title: 'Created by the CLI test',
      priority: 'low',
      domains: 'CORE',
      dependsOn: 'T-201',
      effort: '2d',
      description: 'Prose block that only lives in the file.',
      json: true
    } as never);

    assert.equal(readTasksMd(), mirrorBefore, 'task create leaves TASKS.md for an explicit checkpoint');

    const detail = fs.readFileSync(path.join('tasks', 'T-202.md'), 'utf8');
    assert.ok(detail.includes('- estimatedEffort: 2d'));
    assert.ok(detail.includes('- prerequisites: [T-201]'));
    assert.ok(detail.includes('Prose block that only lives in the file.'));

    mapctxValidateCliCommand({ json: true } as never);

    assert.throws(() => taskCreateCommand({ title: 'dup', id: 'T-202', json: true } as never), /duplicate-id/);
    assert.throws(() => taskCreateCommand({ json: true } as never), /--title/);
  } finally {
    restore();
  }
});

test('dispatch create: fresh dispatch then attempt+1 on the same dispatch id', () => {
  const { restore } = setupCutoverRepo();
  try {
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'import', '--commit'], { stdio: 'ignore' });
    assert.throws(() => dispatchCreateCommand('T-201', { json: true } as never), /mapctx task start T-201/);
    taskClaimCommand('T-201', { json: true } as never);

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

test('R10: dispatch receipt updates canonical store without regenerating the board', () => {
  const { restore } = setupCutoverRepo();
  try {
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'import', '--commit'], { stdio: 'ignore' });

    // Orchestrator flow: claim, dispatch create, receipt. Mirrors stay stale until checkpoint.
    taskClaimCommand('T-201', { json: true } as never);
    assert.match(readTasksMd(), /- status: backlog/);

    // A fresh dispatch generates its own id; capture the JSON output to learn it.
    let captured = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { captured += String(chunk); return true; }) as typeof process.stdout.write;
    try {
      dispatchCreateCommand('T-201', { executor: 'test', json: true } as never);
    } finally {
      process.stdout.write = originalWrite;
    }
    const dispatchId = (JSON.parse(captured) as { dispatchId: string }).dispatchId;
    assert.ok(dispatchId, 'dispatch create must report the new dispatch id');

    const receiptPath = path.join(process.cwd(), 'receipt.json');
    fs.writeFileSync(receiptPath, JSON.stringify({
      schemaVersion: 1,
      dispatchId,
      attempt: 1,
      outcome: 'completed',
      startedAt: '2026-09-08T12:00:00.000Z',
      endedAt: '2026-09-08T12:10:00.000Z',
      changedFiles: ['tasks/T-201.md'],
      usageEvents: [],
      evidence: [],
      failure: null
    }), 'utf8');

    const transcriptPath = path.join(process.cwd(), 'claude.jsonl');
    fs.writeFileSync(transcriptPath, [
      { timestamp: '2026-09-08T12:00:00.000Z', sessionId: 's1', type: 'user', uuid: 'a', message: { content: 'secret prompt' } },
      { timestamp: '2026-09-08T12:05:00.000Z', sessionId: 's1', type: 'assistant', uuid: 'b', message: { content: 'secret answer', stop_reason: 'end_turn' } },
      { timestamp: '2026-09-08T12:10:00.000Z', sessionId: 's1', type: 'user', uuid: 'c', message: { content: 'next prompt' } }
    ].map(line => JSON.stringify(line)).join('\n'), 'utf8');

    dispatchReceiptCommand(dispatchId, { receiptPath, claudeTranscriptPath: transcriptPath, json: true } as never);
    captured = '';
    process.stdout.write = ((chunk: unknown) => { captured += String(chunk); return true; }) as typeof process.stdout.write;
    try { mapctxGanttCommand({ json: true } as never); } finally { process.stdout.write = originalWrite; }
    const measuredTask = (JSON.parse(captured) as { tasks: Array<{ id: string; actual?: { activeTimeCoverage: string; durationMs: number; humanTimeMs: number } }> }).tasks.find(task => task.id === 'T-201');
    assert.equal(measuredTask?.actual?.activeTimeCoverage, 'measured');
    assert.equal(measuredTask?.actual?.durationMs, 300_000);
    assert.equal(measuredTask?.actual?.humanTimeMs, 300_000);
    assert.equal(captured.includes('secret prompt'), false);

    assert.match(readTasksMd(), /- status: backlog/, 'receipt does not rewrite TASKS.md');

    // A reviewed task with a completed execution can now admit a second
    // attempt on the same dispatch without discarding attempt 1.
    captured = '';
    process.stdout.write = ((chunk: unknown) => { captured += String(chunk); return true; }) as typeof process.stdout.write;
    try {
      dispatchCreateCommand('T-201', { dispatchId, executor: 'test', json: true } as never);
    } finally {
      process.stdout.write = originalWrite;
    }
    const retry = JSON.parse(captured) as { dispatchId: string; attempt: number };
    assert.equal(retry.dispatchId, dispatchId);
    assert.equal(retry.attempt, 2, 'reviewed completed execution must admit attempt 2');

    mapctxValidateCliCommand({ json: true } as never);
    assert.throws(() => mapctxValidateCliCommand({ json: true, snapshots: true } as never), /validate failed/);
  } finally {
    restore();
  }
});

test('task start CLI returns lease and dispatch without exporting, and rejects a second start', () => {
  const { restore } = setupCutoverRepo();
  try {
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'import', '--commit'], { stdio: 'ignore' });
    const output = execFileSync('node', [require.resolve('./mapctx-cli.js'), 'task', 'start', 'T-201', '--status', 'running', '--executor', 'traycer', '--holder', '{"provider":"traycer"}', '--json'], { encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.ok, true);
    assert.match(result.claimId, /^[0-9a-f-]{36}$/);
    assert.match(result.leaseToken, /^[0-9a-f]{48}$/);
    assert.equal(result.claim.holder.provider, 'traycer');
    assert.equal(result.attempt, 1);
    assert.equal(result.dispatch.executorKind, 'traycer');
    assert.equal(result.status, 'running');
    assert.match(readTasksMd(), /status: backlog/);
    assert.match(result.next, new RegExp(result.dispatchId));
    assert.throws(() => taskStartCommand('T-201', { json: true } as never), /active-claim-held/);
    const validation = JSON.parse(execFileSync('node', [require.resolve('./mapctx-cli.js'), 'validate', '--json'], { encoding: 'utf8' }));
    assert.equal(validation.store.status, 'store-authority');
    assert.equal(validation.store.canonical.errors, 0);
    assert.equal('snapshots' in validation, false);
  } finally { restore(); }
});

test('public validate CLI gives same canonical result when second worktree has no snapshots', () => {
  const { restore, repoDir } = setupCutoverRepo();
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-cli-empty-worktree-'));
  try {
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'import', '--commit'], { stdio: 'ignore' });
    fs.copyFileSync(path.join(repoDir, 'mapctx.toml'), path.join(second, 'mapctx.toml'));
    const firstResult = JSON.parse(execFileSync('node', [require.resolve('./mapctx-cli.js'), 'validate', '--json'], { cwd: repoDir, encoding: 'utf8' }));
    const secondResult = JSON.parse(execFileSync('node', [require.resolve('./mapctx-cli.js'), 'validate', '--json'], { cwd: second, encoding: 'utf8' }));
    assert.deepEqual(secondResult.store, firstResult.store);
    assert.equal(fs.existsSync(path.join(second, 'TASKS.md')), false);
    assert.equal(fs.existsSync(path.join(second, 'tasks')), false);
  } finally {
    fs.rmSync(second, { recursive: true, force: true });
    restore();
  }
});

test('finish publishes checkpoint last; partial publication keeps done and retry skips duplicate move', () => {
  const { restore, repoDir } = setupCutoverRepo();
  let handle: StoreHandle | undefined;
  try {
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'import', '--commit'], { stdio: 'ignore' });
    const acceptancePlan = JSON.parse(execFileSync('node', [require.resolve('./mapctx-cli.js'), 'acceptance', 'import', '--json'], { encoding: 'utf8' })) as { mode: string; entries: Array<{ taskId: string; action: string; pendingCount: number }> };
    assert.equal(acceptancePlan.mode, 'dry-run');
    assert.ok(acceptancePlan.entries.some(entry => entry.taskId === 'T-201' && entry.action === 'import' && entry.pendingCount === 1));
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'acceptance', 'import', '--commit', '--json'], { stdio: 'ignore' });
    const importedAcceptance = JSON.parse(execFileSync('node', [require.resolve('./mapctx-cli.js'), 'task', 'acceptance', 'show', 'T-201', '--json'], { encoding: 'utf8' })) as { acceptance: { revision: number; criteria: Array<{ state: string }> } };
    assert.equal(importedAcceptance.acceptance.revision, 1);
    assert.equal(importedAcceptance.acceptance.criteria[0].state, 'pending');
    taskMoveCommand('T-201', { status: 'ready-for-do' } as never);
    taskMoveCommand('T-201', { status: 'doing' } as never);
    taskMoveCommand('T-201', { status: 'review' } as never);
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'task', 'acceptance', 'approve', 'T-201', '--index', '0', '--expect-revision', '1', '--json'], { stdio: 'ignore' });
    const detailPath = path.join(repoDir, 'tasks', 'T-201.md');
    fs.writeFileSync(detailPath, DETAIL_T201.replace('CLI completion gate test.', 'Revised CLI completion gate test.'), 'utf8');
    const revised = JSON.parse(execFileSync('node', [require.resolve('./mapctx-cli.js'), 'task', 'acceptance', 'revise', 'T-201', '--from-file', 'tasks/T-201.md', '--expect-revision', '1', '--json'], { encoding: 'utf8' })) as { revision: number; criteria: Array<{ state: string }> };
    assert.equal(revised.revision, 2);
    assert.equal(revised.criteria[0].state, 'pending', 'revision does not inherit previous approval');
    assert.throws(() => execFileSync('node', [require.resolve('./mapctx-cli.js'), 'task', 'acceptance', 'approve', 'T-201', '--index', '0', '--expect-revision', '1', '--json'], { encoding: 'utf8' }), /revision drifted|revision conflict/i);
    execFileSync('node', [require.resolve('./mapctx-cli.js'), 'task', 'acceptance', 'approve', 'T-201', '--index', '0', '--expect-revision', '2', '--json'], { stdio: 'ignore' });

    const toml = resolveMapctxToml(repoDir)!;
    handle = StoreHandle.open(resolveProjectStoreDir(toml.config.projectId));
    const checkpointsBefore = listExportCheckpoints(handle.db).length;
    const fsModule = require('fs') as typeof fs;
    const originalRename = fsModule.renameSync;
    let renameCount = 0;
    fsModule.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      renameCount += 1;
      if (renameCount === 3) throw new Error('injected second-file rename failure');
      return originalRename(from, to);
    }) as typeof fs.renameSync;
    let failed: ReturnType<typeof finishTask>;
    try { failed = finishTask(handle, repoDir, { taskId: 'T-201', actor: 'test' }); }
    finally { fsModule.renameSync = originalRename; }

    assert.equal(failed.ok, false);
    if (failed.ok) return;
    assert.equal(failed.stage, 'checkpoint');
    if (failed.stage === 'checkpoint') {
      assert.equal(failed.checkpoint.stage, 'publish', failed.checkpoint.error);
      assert.equal(failed.move.performed, true, 'canonical done mutation remains accepted');
      assert.equal(failed.checkpoint.publishedFiles.length, 1);
    }
    assert.equal(listExportCheckpoints(handle.db).length, checkpointsBefore, 'partial publication records no false checkpoint');

    const taskEventsBeforeRetry = handle.listEvents().filter(event => event.eventType === 'task.patched' && (event.payload as { taskId?: string }).taskId === 'T-201').length;
    const retry = finishTask(handle, repoDir, { taskId: 'T-201', actor: 'test' });
    assert.equal(retry.ok, true);
    if (!retry.ok) return;
    assert.equal(retry.move.performed, false, 'retry publishes only; it does not repeat completion move');
    assert.equal(handle.listEvents().filter(event => event.eventType === 'task.patched' && (event.payload as { taskId?: string }).taskId === 'T-201').length, taskEventsBeforeRetry);
    const checkpoints = listExportCheckpoints(handle.db);
    const checkpoint = checkpoints[checkpoints.length - 1];
    assert.equal(checkpoint.reason, 'task-end');
    assert.deepEqual((checkpoint.sourceState as { acceptanceRevisions: Record<string, number> }).acceptanceRevisions['T-201'], 2);
    const events = handle.listEvents();
    assert.equal(checkpoint.eventCursor.sequence, events[events.length - 1].sequence - 1);
    const cliRetry = JSON.parse(execFileSync('node', [require.resolve('./mapctx-cli.js'), 'task', 'finish', 'T-201', '--json'], { encoding: 'utf8' })) as { ok: boolean; move: { performed: boolean } };
    assert.equal(cliRetry.ok, true);
    assert.equal(cliRetry.move.performed, false);
    mapctxValidateCliCommand({ json: true } as never);
  } finally {
    handle?.close();
    restore();
  }
});

test('acceptance approve forwards --evidence pairs into show and the durable event; malformed/stale pairs mutate nothing', () => {
  const { restore, repoDir } = setupCutoverRepo();
  const cli = require.resolve('./mapctx-cli.js');
  let handle: StoreHandle | undefined;
  try {
    execFileSync('node', [cli, 'import', '--commit'], { stdio: 'ignore' });
    execFileSync('node', [cli, 'acceptance', 'import', '--commit', '--json'], { stdio: 'ignore' });

    // Multiple pairs, one value containing '='.
    const approved = JSON.parse(execFileSync('node', [cli, 'task', 'acceptance', 'approve', 'T-201', '--index', '0', '--expect-revision', '1', '--evidence', 'uri=proof://cli-evidence', '--evidence', 'verifier=agent-7=trial', '--json'], { encoding: 'utf8' })) as { ok: boolean };
    assert.equal(approved.ok, true);

    const shown = JSON.parse(execFileSync('node', [cli, 'task', 'acceptance', 'show', 'T-201', '--json'], { encoding: 'utf8' })) as { acceptance: { revision: number; criteria: Array<{ evidence: Record<string, string> | null }> } };
    assert.deepEqual(shown.acceptance.criteria[0].evidence, { uri: 'proof://cli-evidence', verifier: 'agent-7=trial' });

    const toml = resolveMapctxToml(repoDir)!;
    handle = StoreHandle.open(resolveProjectStoreDir(toml.config.projectId));
    const approvedEvents = handle.listEvents().filter(event => event.eventType === 'acceptance.approved');
    assert.equal(approvedEvents.length, 1);
    assert.deepEqual((approvedEvents[0].payload as { evidence: Record<string, string> }).evidence, { uri: 'proof://cli-evidence', verifier: 'agent-7=trial' });
    const eventsAfterApproval = handle.listEvents().length;

    // Malformed pair (no '='): refused before any mutation.
    assert.throws(() => execFileSync('node', [cli, 'task', 'acceptance', 'approve', 'T-201', '--index', '1', '--expect-revision', '1', '--evidence', 'no-separator', '--json'], { stdio: 'pipe' }), /key=value/);
    // Malformed pair (empty key): refused before any mutation.
    assert.throws(() => execFileSync('node', [cli, 'task', 'acceptance', 'approve', 'T-201', '--index', '1', '--expect-revision', '1', '--evidence', '=value', '--json'], { stdio: 'pipe' }), /key=value/);
    assert.equal(handle.listEvents().length, eventsAfterApproval, 'malformed pairs write zero events');

    // Stale revision with well-formed evidence: still zero mutation.
    assert.throws(() => execFileSync('node', [cli, 'task', 'acceptance', 'approve', 'T-201', '--index', '1', '--expect-revision', '99', '--evidence', 'uri=proof://stale', '--json'], { stdio: 'pipe' }), /drift|conflict/i);
    assert.equal(handle.listEvents().length, eventsAfterApproval, 'stale approval writes zero events');

    // A new revision resets evidence: approval state never survives a revise.
    const revised = JSON.parse(execFileSync('node', [cli, 'task', 'acceptance', 'revise', 'T-201', '--from-file', 'tasks/T-201.md', '--expect-revision', '1', '--json'], { encoding: 'utf8' })) as { ok: boolean; revision: number };
    assert.equal(revised.ok, true);
    assert.equal(revised.revision, 2);
    const shownAfterRevise = JSON.parse(execFileSync('node', [cli, 'task', 'acceptance', 'show', 'T-201', '--json'], { encoding: 'utf8' })) as { acceptance: { criteria: Array<{ state: string; evidence: Record<string, string> | null }> } };
    assert.equal(shownAfterRevise.acceptance.criteria[0].state, 'pending');
    assert.equal(shownAfterRevise.acceptance.criteria[0].evidence, null);

    // unapprove refuses --evidence instead of silently dropping it.
    assert.throws(() => execFileSync('node', [cli, 'task', 'acceptance', 'unapprove', 'T-201', '--index', '0', '--expect-revision', '2', '--evidence', 'uri=proof://x', '--json'], { stdio: 'pipe' }), /does not take --evidence/);
  } finally {
    handle?.close();
    restore();
  }
});

test('attempt6: approve without --evidence keeps null semantics; prototype-unsafe keys survive show and event', () => {
  const { restore, repoDir } = setupCutoverRepo();
  const cli = require.resolve('./mapctx-cli.js');
  let handle: StoreHandle | undefined;
  try {
    execFileSync('node', [cli, 'import', '--commit'], { stdio: 'ignore' });
    execFileSync('node', [cli, 'acceptance', 'import', '--commit', '--json'], { stdio: 'ignore' });

    // (1) NO flag: prior null/omitted semantics, never an invented {}.
    const approved = JSON.parse(execFileSync('node', [cli, 'task', 'acceptance', 'approve', 'T-201', '--index', '0', '--expect-revision', '1', '--json'], { encoding: 'utf8' })) as { ok: boolean };
    assert.equal(approved.ok, true);
    const shown = JSON.parse(execFileSync('node', [cli, 'task', 'acceptance', 'show', 'T-201', '--json'], { encoding: 'utf8' })) as { acceptance: { criteria: Array<{ evidence: Record<string, string> | null }> } };
    assert.equal(shown.acceptance.criteria[0].evidence, null, 'absent flag keeps evidence null');

    // (2) Prototype-unsafe keys become own properties and survive exactly.
    assert.equal(JSON.parse(execFileSync('node', [cli, 'task', 'acceptance', 'revise', 'T-201', '--from-file', 'tasks/T-201.md', '--expect-revision', '1', '--json'], { encoding: 'utf8' })).revision, 2);
    const protoApproved = JSON.parse(execFileSync('node', [cli, 'task', 'acceptance', 'approve', 'T-201', '--index', '0', '--expect-revision', '2', '--evidence', '__proto__=proof', '--evidence', 'constructor=ctor-value', '--evidence', 'toString=str-value', '--json'], { encoding: 'utf8' })) as { ok: boolean };
    assert.equal(protoApproved.ok, true);
    const shownProto = JSON.parse(execFileSync('node', [cli, 'task', 'acceptance', 'show', 'T-201', '--json'], { encoding: 'utf8' })) as { acceptance: { criteria: Array<{ evidence: Record<string, string> | null }> } };
    const evidence = shownProto.acceptance.criteria[0].evidence;
    assert.ok(evidence, 'evidence present');
    assert.deepEqual(evidence, { ['__proto__']: 'proof', constructor: 'ctor-value', toString: 'str-value' });
    assert.ok(Object.prototype.hasOwnProperty.call(evidence, '__proto__'), '__proto__ is an own property');

    const toml = resolveMapctxToml(repoDir)!;
    handle = StoreHandle.open(resolveProjectStoreDir(toml.config.projectId));
    const events = handle.listEvents().filter(event => event.eventType === 'acceptance.approved');
    const lastPayload = JSON.parse(JSON.stringify(events[events.length - 1].payload)) as { evidence: Record<string, string> };
    assert.deepEqual(lastPayload.evidence, { ['__proto__']: 'proof', constructor: 'ctor-value', toString: 'str-value' }, 'event payload preserves the exact keys');
  } finally {
    handle?.close();
    restore();
  }
});

test('attempt6: malformed/unsupported evidence refuses BEFORE the writable open -- schema-9 pending-journal store stays byte-identical', () => {
  const { restore, repoDir } = setupCutoverRepo();
  const cli = require.resolve('./mapctx-cli.js');
  try {
    execFileSync('node', [cli, 'import', '--commit'], { stdio: 'ignore' });
    const toml = resolveMapctxToml(repoDir)!;
    const storeDir = resolveProjectStoreDir(toml.config.projectId);

    // Downgrade to a TRUE schema-9 shape: migration 10 is fully
    // IF NOT EXISTS, so dropping its tables + row makes this store
    // re-migratable exactly like the live schema-9 stores.
    {
      const db = new DatabaseSync(path.join(storeDir, 'mapctx.db'));
      db.exec('DROP TABLE IF EXISTS acceptance_criterion_projection');
      db.exec('DROP TABLE IF EXISTS acceptance_revision_projection');
      // Migration 10 also ALTERs export_checkpoint; DROP COLUMN makes the
      // downgrade a genuine schema-9 shape that migration 10 can re-apply.
      db.exec('ALTER TABLE export_checkpoint DROP COLUMN source_state_json');
      db.prepare('DELETE FROM schema_migrations WHERE version = 10').run();
      db.close();
    }
    // Append an UNREPLAYED pending journal entry: a writable open would
    // replay it (and bump the watermark); a parse-first refusal must not.
    const last = (() => {
      const db = new DatabaseSync(path.join(storeDir, 'mapctx.db'));
      const row = db.prepare('SELECT node_id, sequence, logical_clock FROM event_log ORDER BY logical_clock DESC LIMIT 1').get() as { node_id: string; sequence: number; logical_clock: number };
      db.close();
      return row;
    })();
    const pendingPayload = { taskId: 'T-201', patch: { title: 'Pending journal title' } };
    writeJournalEntrySync(storeDir, {
      nodeId: last.node_id,
      sequence: last.sequence + 1,
      logicalClock: last.logical_clock + 1,
      eventType: 'task.patched',
      occurredAt: '2026-10-05T00:00:00.000Z',
      actor: 'fixture',
      payload: pendingPayload,
      payloadSha256: payloadSha256(pendingPayload)
    } as never);

    const snapshot = (): Record<string, string> => {
      const out: Record<string, string> = {};
      const hash = (p: string) => { out[path.relative(storeDir, p)] = require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex'); };
      hash(path.join(storeDir, 'mapctx.db'));
      hash(path.join(storeDir, 'store-meta.json'));
      for (const entry of fs.readdirSync(path.join(storeDir, 'events'), { recursive: true }) as unknown as string[]) {
        const p = path.join(storeDir, 'events', entry);
        if (fs.statSync(p).isFile()) hash(p);
      }
      return out;
    };
    const before = snapshot();

    // Malformed pair: refused before any handle; nothing migrates/replays.
    assert.throws(() => execFileSync('node', [cli, 'task', 'acceptance', 'approve', 'T-201', '--index', '0', '--expect-revision', '1', '--evidence', 'bad-pair', '--json'], { stdio: 'pipe' }), /key=value/);
    assert.deepEqual(snapshot(), before, 'malformed refusal leaves DB/meta/journals byte-identical');
    {
      const db = new DatabaseSync(path.join(storeDir, 'mapctx.db'));
      assert.equal((db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version = 10').get() as { n: number }).n, 0, 'schema still 9: no migration ran');
      assert.throws(() => db.prepare('SELECT * FROM acceptance_revision_projection').all(), /no such table/, 'acceptance tables still absent');
      db.close();
    }

    // Unsupported evidence on unapprove: also refused pre-open.
    assert.throws(() => execFileSync('node', [cli, 'task', 'acceptance', 'unapprove', 'T-201', '--index', '0', '--expect-revision', '1', '--evidence', 'uri=proof://x', '--json'], { stdio: 'pipe' }), /does not take --evidence/);
    assert.deepEqual(snapshot(), before, 'unapprove-evidence refusal also leaves the store untouched');

    // Missing --expect-revision: refused pre-open as well.
    assert.throws(() => execFileSync('node', [cli, 'task', 'acceptance', 'approve', 'T-201', '--index', '0', '--json'], { stdio: 'pipe' }), /--expect-revision/);
    assert.deepEqual(snapshot(), before, 'shape refusal leaves the store untouched');

    // Control: the SAME store, once opened by a WRITABLE command (this one
    // then fails on missing revisioning — irrelevant), DOES migrate +
    // replay, proving the fixture really was a pending schema-9 store and
    // that the refusals above genuinely skipped the open.
    assert.throws(() => execFileSync('node', [cli, 'task', 'acceptance', 'approve', 'T-201', '--index', '0', '--expect-revision', '1', '--json'], { stdio: 'pipe' }));
    {
      const db = new DatabaseSync(path.join(storeDir, 'mapctx.db'));
      assert.equal((db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version = 10').get() as { n: number }).n, 1, 'control: writable open migrates to 10');
      db.close();
    }
  } finally {
    restore();
  }
});
