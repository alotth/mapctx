import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import { buildExport, createTask, listTasks, resolveProjectStoreDir, StoreHandle, updateTask, upsertProject } from '@mapctx/store';
import { setGhRunnerForTests } from './github';
import {
  buildStoreIssueBody,
  labelsFromTaskRecord,
  planForTask,
  planningStateToBoardStatus,
  pushStoreCommand,
  remoteIssueSnapshot,
  type RemoteIssueSnapshot,
  type TaskConflict,
  type TaskPlan
} from './push-store';
import type { GitHubIssue } from './types';

const PROJECT_ID = '00000000-0000-0000-0000-0000000000a1';
const OWNER = 'alotth';
const REPO = 'mapctx';

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function issueFixture(number: number, overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number,
    node_id: `NODE_${number}`,
    title: `issue ${number}`,
    body: null,
    state: 'open',
    labels: [],
    milestone: null,
    html_url: `https://github.com/${OWNER}/${REPO}/issues/${number}`,
    closed_at: null,
    updated_at: '2026-09-08T00:00:00Z',
    ...overrides
  };
}

function writeRepoFiles(repoDir: string, store: StoreHandle): void {
  const exported = buildExport(store.db, { tasksRoot: repoDir });
  fs.mkdirSync(path.join(repoDir, 'tasks'), { recursive: true });
  fs.writeFileSync(exported.tasksMd.path, exported.tasksMd.content, 'utf8');
  for (const file of exported.taskDetailFiles) {
    fs.writeFileSync(file.path, file.content, 'utf8');
  }
}

type Fixture = {
  repoDir: string;
  storeDir: string;
  cleanup: () => void;
};

function setupStore(tasks: Array<{ title: string; planningState?: string; externalId?: string | null }>): Fixture {
  const repoDir = mkTmp('mapctx-push-repo-');
  const mapctxHome = mkTmp('mapctx-push-home-');
  const previousHome = process.env.MAPCTX_HOME;
  process.env.MAPCTX_HOME = mapctxHome;
  const storeDir = path.join(mapctxHome, 'projects', PROJECT_ID);
  fs.writeFileSync(path.join(repoDir, 'mapctx.toml'), [
    'schemaVersion = 1',
    `projectId = "${PROJECT_ID}"`,
    'plansAuthority = "store"',
    '',
    '[github]',
    `owner = "${OWNER}"`,
    `repo = "${REPO}"`,
    'projectId = "PVT_test"',
    'statusFieldId = "PVTSSF_test"',
    '',
    '[github.statusMap]',
    'backlog = "Backlog"',
    'ready-for-do = "Ready for Do"',
    'doing = "Doing"',
    'review = "Review"',
    'done = "Done"',
    'paused = "Paused"',
    ''
  ].join('\n'), 'utf8');

  const store = StoreHandle.open(storeDir);
  try {
    upsertProject(store.db, {
      projectId: PROJECT_ID,
      boardTitle: 'Push test board',
      workDomains: [{ key: 'SYNC', description: 'sync domain' }],
      notesMarkdown: '',
      plansAuthority: 'store',
      sourceSnapshotHash: null
    });
    for (const task of tasks) {
      const result = createTask(store, { title: task.title, actor: 'test' });
      assert.equal(result.ok, true);
      if (task.externalId && result.ok) {
        const handle = StoreHandle.open(storeDir);
        try {
          const update = updateTask(handle, { taskId: result.taskId, patch: { externalId: task.externalId }, actor: 'test' });
          assert.equal(update.ok, true);
        } finally {
          handle.close();
        }
      }
    }
  } finally {
    store.close();
  }
  const reloaded = StoreHandle.open(storeDir);
  try {
    writeRepoFiles(repoDir, reloaded);
  } finally {
    reloaded.close();
  }

  return {
    repoDir,
    storeDir,
    cleanup: () => {
      if (previousHome === undefined) delete process.env.MAPCTX_HOME;
      else process.env.MAPCTX_HOME = previousHome;
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(mapctxHome, { recursive: true, force: true });
    }
  };
}

function runInDir<T>(dir: string, run: () => T): T {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return run();
  } finally {
    process.chdir(previous);
  }
}

test('planningStateToBoardStatus maps canonical states to board vocabulary and passes the rest through', () => {
  assert.equal(planningStateToBoardStatus('ready'), 'ready-for-do');
  assert.equal(planningStateToBoardStatus('in-progress'), 'doing');
  assert.equal(planningStateToBoardStatus('backlog'), 'backlog');
  assert.equal(planningStateToBoardStatus('review'), 'review');
  assert.equal(planningStateToBoardStatus('done'), 'done');
  assert.equal(planningStateToBoardStatus('paused'), 'paused');
});

test('labelsFromTaskRecord builds type/priority/workload/tag labels', () => {
  assert.deepEqual(
    labelsFromTaskRecord({
      taskId: 'T-001', positionKey: 0, title: 't', planningState: 'ready', executionState: 'pending',
      type: 'feature', parentTaskId: null, priority: 'high', workload: 'Normal', tags: ['x'],
      domains: [], startDate: null, dueDate: null, completedOn: null, externalId: null,
      externalLinks: [], iteration: null, assignees: [], milestone: null, specMode: null,
      detailPath: null, updatedOn: null
    }),
    ['type:feature', 'priority:high', 'workload:normal', 'tag:x']
  );
});

function taskRecordFor(overrides: Partial<Parameters<typeof labelsFromTaskRecord>[0]> & { taskId: string; title: string; planningState: string }): Parameters<typeof planForTask>[0]['task'] {
  return {
    taskId: overrides.taskId, positionKey: 0, title: overrides.title, planningState: overrides.planningState,
    executionState: 'pending', type: 'task', parentTaskId: null, priority: null, workload: null,
    tags: [], domains: [], startDate: null, dueDate: null, completedOn: null, externalId: overrides.externalId ?? null,
    externalLinks: [], iteration: null, assignees: [], milestone: null, specMode: null,
    detailPath: null, updatedOn: null
  } as never;
}

const FULL_STATUS_MAP = {
  backlog: 'Backlog', 'ready-for-do': 'Ready for Do', doing: 'Doing',
  review: 'Review', done: 'Done', paused: 'Paused'
};

function remoteOf(issue: GitHubIssue): RemoteIssueSnapshot {
  return remoteIssueSnapshot(issue);
}

test('planForTask: create / skip / update fields / conflicts', () => {
  const today = '2026-09-08';
  const base = { deps: [] as string[], detailDescription: null, statusMap: FULL_STATUS_MAP, today };

  const noExternal = taskRecordFor({ taskId: 'T-001', title: 'new task', planningState: 'ready' });
  const createPlan = planForTask({ task: noExternal, ...base, remote: null });
  assert.equal((createPlan as TaskPlan).action, 'create');

  const done = taskRecordFor({ taskId: 'T-002', title: 'done task', planningState: 'done', externalId: 'github:issue:7' });
  const expectedBody = `${[
    'Synced from store projection (mapctx) on ' + today + '.',
    '',
    '## Task Metadata',
    '- id: T-002',
    '- status: done',
    '- type: task',
    '- dependsOn: []',
    '- completed: null'
  ].join('\n')}\n`;
  const matching: RemoteIssueSnapshot = {
    number: 7,
    title: 'done task',
    body: expectedBody,
    state: 'closed',
    labelNames: ['type:task']
  };
  assert.deepEqual(planForTask({ task: done, ...base, remote: matching }), { action: 'skip', taskId: 'T-002', issueNumber: 7 });

  const driftedTitle: RemoteIssueSnapshot = { ...matching, title: 'renamed remotely' };
  const update = planForTask({ task: done, ...base, remote: driftedTitle }) as Extract<TaskPlan, { action: 'update' }>;
  assert.deepEqual(update.fields, ['title']);
  assert.equal(update.title, 'done task');

  const stale: RemoteIssueSnapshot = { ...matching, state: 'open' };
  const reopened = planForTask({ task: done, ...base, remote: stale }) as Extract<TaskPlan, { action: 'update' }>;
  assert.ok(reopened.fields.includes('state'));

  const missingRemote = planForTask({ task: done, ...base, remote: null }) as TaskConflict;
  assert.ok(missingRemote.reason.includes('#7'));

  const unmapped = planForTask({ task: done, ...base, statusMap: {}, remote: matching }) as TaskConflict;
  assert.ok(unmapped.reason.includes('statusMap'));
});

test('buildStoreIssueBody embeds metadata and description, deterministic output', () => {
  const task = taskRecordFor({ taskId: 'T-003', title: 'body task', planningState: 'in-progress', externalId: 'github:issue:3' });
  const body = buildStoreIssueBody(task, ['T-001', 'T-002'], 'Description prose.', '2026-09-08');
  assert.ok(body.includes('- id: T-003'));
  assert.ok(body.includes('- status: in-progress'));
  assert.ok(body.includes('- dependsOn: [T-001, T-002]'));
  assert.ok(body.includes('## Detail'));
  assert.ok(body.includes('Description prose.'));
  assert.equal(body, buildStoreIssueBody(task, ['T-001', 'T-002'], 'Description prose.', '2026-09-08'));
});

type GhCall = { args: string[] };

function fakeGh(options: {
  issues: GitHubIssue[];
  projectItems: Array<{ id: string; issueNumber: number; statusName?: string; dates?: { start?: string; due?: string; completed?: string } }>;
  optionIds?: Record<string, string>;
  calls: GhCall[];
  nextIssueNumber: number;
}): (args: string[]) => string {
  let created = options.nextIssueNumber;
  return (args: string[]): string => {
    options.calls.push({ args });
    if (args[0] === 'api' && typeof args[1] === 'string' && args[1].startsWith(`repos/${OWNER}/${REPO}/issues?state=all`)) {
      const list = options.issues.map(issue => ({
        ...issue,
        labels: issue.labels
      }));
      return JSON.stringify(list);
    }
    if (args[0] === 'api' && args[1] === `repos/${OWNER}/${REPO}/issues` && args.includes('-X') && args.includes('POST')) {
      const title = args.find(a => a.startsWith('title='))?.slice('title='.length) ?? 'untitled';
      const number = ++created;
      const body = args.find(a => a.startsWith('body='))?.slice('body='.length) ?? '';
      const labels = args.filter(a => a.startsWith('labels[]=')).map(a => ({ name: a.slice('labels[]='.length) }));
      const issue = issueFixture(number, { title, body: body || null, labels });
      options.issues.push(issue);
      return JSON.stringify(issue);
    }
    if (args[0] === 'api' && /\/issues\/\d+$/.test(String(args[1])) && args.includes('-X') && args.includes('PATCH')) {
      const number = Number(String(args[1]).split('/').pop());
      const issue = options.issues.find(i => i.number === number);
      if (!issue) throw new Error(`fake gh: update of unknown issue #${number}`);
      const titleIdx = args.findIndex(a => a.startsWith('title='));
      if (titleIdx !== -1) issue.title = args[titleIdx].slice('title='.length);
      const stateIdx = args.findIndex(a => a.startsWith('state='));
      if (stateIdx !== -1) issue.state = args[stateIdx].slice('state='.length) as 'open' | 'closed';
      const bodyIdx = args.findIndex(a => a.startsWith('body='));
      if (bodyIdx !== -1) issue.body = args[bodyIdx].slice('body='.length);
      const labelArgs = args.filter(a => a.startsWith('labels[]='));
      if (labelArgs.length > 0) {
        issue.labels = labelArgs.map(a => ({ name: a.slice('labels[]='.length) }));
      } else if (args.includes('labels[]')) {
        issue.labels = [];
      }
      return JSON.stringify(issue);
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      const queryIdx = args.findIndex(a => a.startsWith('query='));
      const query = args[queryIdx] ?? '';
      if (query.includes('fields(first: 50)')) {
        const optionMap = options.optionIds ?? { Backlog: 'OPT_backlog', 'Ready for Do': 'OPT_ready', Doing: 'OPT_doing', Review: 'OPT_review', Done: 'OPT_done', Paused: 'OPT_paused' };
        return JSON.stringify({
          data: {
            node: {
              fields: {
                nodes: [{ id: 'PVTSSF_test', name: 'Status', options: Object.entries(optionMap).map(([name, id]) => ({ id, name })) }]
              }
            }
          }
        });
      }
      if (query.includes('addProjectV2ItemById')) {
        return JSON.stringify({ data: { addProjectV2ItemById: { item: { id: `ITEM_${options.projectItems.length + 1}` } } } });
      }
      if (query.includes('updateProjectV2ItemFieldValue') || query.includes('clearProjectV2ItemFieldValue')) {
        return JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM' } } } });
      }
      // project item listing (statuses or dates): respond with both shapes.
      const nodes = options.projectItems.map(entry => ({
        id: `PROJ_${entry.id}`,
        content: { number: entry.issueNumber, repository: { name: REPO, owner: { login: OWNER } } },
        fieldValues: {
          nodes: [
            ...(entry.statusName ? [{ name: entry.statusName, field: { id: 'PVTSSF_test' } }] : []),
            ...(entry.dates?.start ? [{ date: entry.dates.start, field: { id: 'PVT_start' } }] : []),
            ...(entry.dates?.due ? [{ date: entry.dates.due, field: { id: 'PVT_due' } }] : []),
            ...(entry.dates?.completed ? [{ date: entry.dates.completed, field: { id: 'PVT_completed' } }] : [])
          ]
        }
      }));
      return JSON.stringify({ data: { node: { items: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } });
    }
    throw new Error(`fake gh: unexpected command: ${args.join(' ')}`);
  };
}

function setupPushFixture(): { fixture: Fixture; calls: GhCall[]; issues: GitHubIssue[] } {
  const fixture = setupStore([
    { title: 'first', planningState: 'done', externalId: 'github:issue:7' },
    { title: 'second', planningState: 'in-progress', externalId: 'github:issue:8' },
    { title: 'third', planningState: 'ready' }
  ]);
  return { fixture, calls: [], issues: [] };
}

test('pushStoreCommand dry-run plans without mutating', () => {
  const { fixture, calls, issues } = setupPushFixture();
  try {
    issues.push(
      issueFixture(7, { title: 'first', state: 'closed' }),
      issueFixture(8, { title: 'DRIFTED TITLE' })
    );
    setGhRunnerForTests(fakeGh({ issues, projectItems: [{ id: 'a', issueNumber: 7, statusName: 'Done' }], calls, nextIssueNumber: 8 }));
    const beforeMutations = calls.filter(c => c.args.includes('-X')).length;
    runInDir(fixture.repoDir, () => {
      const report = pushStoreCommand({ dryRun: true, json: true });
      assert.equal(report.conflicts.length, 0);
      // dry-run reports the PLAN: one create (T-003), two updates, no skips
      assert.deepEqual(report.created.map(c => c.taskId), ['T-003']);
      assert.deepEqual(report.updated.map(u => u.taskId).sort(), ['T-001', 'T-002']);
      assert.equal(report.skipped, 0);
    });
    assert.equal(calls.filter(c => c.args.includes('-X')).length, beforeMutations);
    // remote issues list must have been read (state=all)
    assert.ok(calls.some(c => String(c.args[1]).includes('issues?state=all')));
  } finally {
    setGhRunnerForTests(null);
    fixture.cleanup();
  }
});

test('pushStoreCommand end-to-end: skip/update/create with externalId writeback', () => {
  const { fixture, calls, issues } = setupPushFixture();
  try {
    issues.push(
      issueFixture(7, { title: 'first', state: 'closed' }),
      issueFixture(8, { title: 'DRIFTED TITLE' })
    );
    const projectItems = [{ id: 'a', issueNumber: 7, statusName: 'Done' }];
    setGhRunnerForTests(fakeGh({ issues, projectItems, calls, nextIssueNumber: 8 }));

    let first: Awaited<ReturnType<typeof pushStoreCommand>>;
    let second: Awaited<ReturnType<typeof pushStoreCommand>>;
    runInDir(fixture.repoDir, () => {
      first = pushStoreCommand({ json: true, actor: 'traycer' });
      second = pushStoreCommand({ json: true, actor: 'traycer' });
    });
    assert.equal(first!.conflicts.length, 0);
    assert.deepEqual(first!.created.map(c => c.taskId), ['T-003']);
    assert.deepEqual(first!.updated.map(u => u.taskId).sort(), ['T-001', 'T-002']);
    assert.equal(first!.skipped, 0);

    // idempotency: a second push right after is a full projection match
    assert.equal(second!.conflicts.length, 0);
    assert.equal(second!.created.length, 0);
    assert.equal(second!.updated.length, 0);
    assert.equal(second!.skipped, 3);

    // externalId writeback persisted in the store
    const store = StoreHandle.open(fixture.storeDir);
    try {
      const tasks = listTasks(store.db);
      const third = tasks.find(t => t.taskId === 'T-003');
      assert.ok(third?.externalId?.startsWith('github:issue:'));
    } finally {
      store.close();
    }

    // issue #8 was patched exactly once across both runs (title from store)
    const patchCalls = calls.filter(c => String(c.args[1]).endsWith('/issues/8'));
    assert.equal(patchCalls.length, 1);
  } finally {
    setGhRunnerForTests(null);
    fixture.cleanup();
  }
});

test('pushStoreCommand refuses to run on board drift (fail-closed)', () => {
  const { fixture, calls, issues } = setupPushFixture();
  try {
    issues.push(issueFixture(7, { title: 'first', state: 'closed' }));
    setGhRunnerForTests(fakeGh({ issues, projectItems: [], calls, nextIssueNumber: 7 }));
    fs.writeFileSync(path.join(fixture.repoDir, 'TASKS.md'), '# Tasks - tampered\n', 'utf8');
    runInDir(fixture.repoDir, () => {
      assert.throws(() => pushStoreCommand({ json: true }), /Refusing to push: board drift/);
    });
  } finally {
    setGhRunnerForTests(null);
    fixture.cleanup();
  }
});

test('pushStoreCommand refuses store-missing binding and non-store authority', () => {
  const noGithubDir = mkTmp('mapctx-push-nogithub-');
  try {
    fs.writeFileSync(path.join(noGithubDir, 'mapctx.toml'), [
      'schemaVersion = 1',
      `projectId = "${PROJECT_ID}"`,
      'plansAuthority = "store"',
      ''
    ].join('\n'), 'utf8');
    runInDir(noGithubDir, () => {
      assert.throws(() => pushStoreCommand({ json: true }), /\[github\]/);
    });
  } finally {
    fs.rmSync(noGithubDir, { recursive: true, force: true });
  }
});

test('remoteIssueSnapshot normalizes labels', () => {
  const snapshot = remoteIssueSnapshot(issueFixture(1, { labels: [{ name: 'a' } as never, { name: 'b' } as never] }));
  assert.deepEqual(snapshot.labelNames, ['a', 'b']);
});
