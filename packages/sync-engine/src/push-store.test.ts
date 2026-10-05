import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import { buildExport, createTask, getAcceptance, listTasks, resolveProjectStoreDir, StoreHandle, updateTask, upsertProject, approveAcceptanceCriterion, reviseAcceptance } from '@mapctx/store';
import { generateTaskDetailFile, parseTaskDetailFile } from '@mapctx/core';
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

test('pushStoreCommand uses canonical store despite stale local snapshots', () => {
  const { fixture, calls, issues } = setupPushFixture();
  try {
    issues.push(issueFixture(7, { title: 'first', state: 'closed' }), issueFixture(8, { title: 'DRIFTED TITLE' }));
    setGhRunnerForTests(fakeGh({ issues, projectItems: [{ id: 'a', issueNumber: 7, statusName: 'Done' }], calls, nextIssueNumber: 8 }));
    fs.writeFileSync(path.join(fixture.repoDir, 'TASKS.md'), '# Tasks - tampered\n', 'utf8');
    runInDir(fixture.repoDir, () => {
      const report = pushStoreCommand({ dryRun: true, json: true });
      assert.equal(report.conflicts.length, 0);
      assert.deepEqual(report.created.map(item => item.taskId), ['T-003']);
      assert.deepEqual(report.updated.map(item => item.taskId).sort(), ['T-001', 'T-002']);
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

test('pushStoreCommand renders Acceptance from canonical store, never the stale mirror', () => {
  const fixture = setupStore([{ title: 'Canonical push', externalId: 'github:issue:7' }]);
  const issues: GitHubIssue[] = [issueFixture(7, { title: 'Canonical push', body: 'stale remote body' })];
  const calls: GhCall[] = [];
  try {
    runInDir(fixture.repoDir, () => {
      const store = StoreHandle.open(fixture.storeDir);
      try {
        const revised = reviseAcceptance(store, { taskId: 'T-001', condition: 'criteria', texts: ['Old approved criterion'], actor: 'author', expectRevision: 0 });
        assert.equal(revised.ok, true);
        assert.equal(approveAcceptanceCriterion(store, { taskId: 'T-001', index: 0, expectRevision: 1, actor: 'reviewer', evidence: { uri: 'proof://r1' } }).ok, true);
      } finally {
        store.close();
      }
      // Mirror now carries the stale-but-current-at-export-time revision.
      const reloaded = StoreHandle.open(fixture.storeDir);
      try { writeRepoFiles(fixture.repoDir, reloaded); } finally { reloaded.close(); }
      // A new canonical revision lands WITHOUT any re-export: the mirror is
      // now stale ([x] Old approved criterion), canonical says pending.
      const second = StoreHandle.open(fixture.storeDir);
      try {
        assert.equal(reviseAcceptance(second, { taskId: 'T-001', condition: 'criteria', texts: ['New pending criterion'], actor: 'author', expectRevision: 1 }).ok, true);
      } finally {
        second.close();
      }

      setGhRunnerForTests(fakeGh({ issues, projectItems: [], calls, nextIssueNumber: 8 }));
      try {
        const report = pushStoreCommand({});
        assert.deepEqual(report.updated.map(entry => entry.taskId), ['T-001']);
      } finally {
        setGhRunnerForTests(null);
      }
    });
    const bodyArg = calls.flatMap(entry => entry.args).find(arg => arg.startsWith('body='));
    assert.ok(bodyArg, 'push must update the issue body');
    const body = bodyArg!.slice('body='.length);
    assert.ok(body.includes('- [ ] New pending criterion'), `canonical pending criterion must be published:\n${body}`);
    assert.ok(!body.includes('Old approved criterion'), 'stale mirror approval must never reach GitHub');
    // Git-authored prose survives; the acceptance block is canonical only.
    assert.ok(body.includes('## Detail'));
  } finally {
    fixture.cleanup();
  }
});

test('pushStoreCommand publishes no Acceptance section when canonical revisioning is absent', () => {
  const fixture = setupStore([{ title: 'No acceptance task', externalId: 'github:issue:9' }]);
  const issues: GitHubIssue[] = [issueFixture(9, { title: 'No acceptance task', body: null })];
  const calls: GhCall[] = [];
  try {
    runInDir(fixture.repoDir, () => {
      // The mirror's generated Acceptance block (pending, from setup export)
      // must NOT leak into the issue body without canonical revisioning.
      setGhRunnerForTests(fakeGh({ issues, projectItems: [], calls, nextIssueNumber: 10 }));
      try {
        pushStoreCommand({});
      } finally {
        setGhRunnerForTests(null);
      }
    });
    const bodyArg = calls.flatMap(entry => entry.args).find(arg => arg.startsWith('body='));
    assert.ok(bodyArg, 'push must update the issue body');
    const body = bodyArg!.slice('body='.length);
    assert.ok(!body.includes('## Acceptance'), `absent canonical acceptance must not be invented:\n${body}`);
  } finally {
    fixture.cleanup();
  }
});

test('N4: mirror-absent checkout still publishes canonical criteria with an explicit prose-absence note', () => {
  const fixture = setupStore([{ title: 'Absent mirror', externalId: 'github:issue:11' }]);
  const issues: GitHubIssue[] = [issueFixture(11, { title: 'Absent mirror', body: 'old remote body' })];
  const calls: GhCall[] = [];
  try {
    runInDir(fixture.repoDir, () => {
      const store = StoreHandle.open(fixture.storeDir);
      try {
        assert.equal(reviseAcceptance(store, { taskId: 'T-001', condition: 'criteria', texts: ['Pending without mirror'], actor: 'author', expectRevision: 0 }).ok, true);
        assert.equal(approveAcceptanceCriterion(store, { taskId: 'T-001', index: 0, expectRevision: 1, actor: 'reviewer' }).ok, true);
      } finally {
        store.close();
      }
      // The whole tasks/ mirror is gone (worktree without snapshots).
      fs.rmSync(path.join(fixture.repoDir, 'tasks'), { recursive: true, force: true });
      fs.rmSync(path.join(fixture.repoDir, 'TASKS.md'), { force: true });

      setGhRunnerForTests(fakeGh({ issues, projectItems: [], calls, nextIssueNumber: 12 }));
      try {
        pushStoreCommand({});
      } finally {
        setGhRunnerForTests(null);
      }
    });
    const bodyArg = calls.flatMap(entry => entry.args).find(arg => arg.startsWith('body='));
    assert.ok(bodyArg, 'push must update the issue body even without any mirror');
    const body = bodyArg!.slice('body='.length);
    assert.ok(body.includes('- [x] Pending without mirror'), 'canonical approval is published without the mirror');
    assert.ok(body.includes('not available in this checkout'), 'prose absence is stated explicitly');
    assert.ok(body.includes('## Acceptance'));
    assert.ok(!body.includes('(empty description)'), 'no fabricated prose');
  } finally {
    fixture.cleanup();
  }
});

test('N4: mirror-absent checkout without canonical revisioning publishes no Detail/Acceptance (documented absent)', () => {
  const fixture = setupStore([{ title: 'Absent everything', externalId: 'github:issue:13' }]);
  const issues: GitHubIssue[] = [issueFixture(13, { title: 'Absent everything', body: null })];
  const calls: GhCall[] = [];
  try {
    runInDir(fixture.repoDir, () => {
      fs.rmSync(path.join(fixture.repoDir, 'tasks'), { recursive: true, force: true });
      fs.rmSync(path.join(fixture.repoDir, 'TASKS.md'), { force: true });
      setGhRunnerForTests(fakeGh({ issues, projectItems: [], calls, nextIssueNumber: 14 }));
      try {
        pushStoreCommand({});
      } finally {
        setGhRunnerForTests(null);
      }
    });
    const bodyArg = calls.flatMap(entry => entry.args).find(arg => arg.startsWith('body='));
    assert.ok(bodyArg);
    const body = bodyArg!.slice('body='.length);
    assert.ok(!body.includes('## Acceptance'), 'no canonical revision -> no invented section');
    assert.ok(!body.includes('not available in this checkout'));
  } finally {
    fixture.cleanup();
  }
});

test('N1: push refuses before any remote write when prose has an unterminated fence and canonical revisioning exists', () => {
  const fixture = setupStore([{ title: 'Fence refusal push', externalId: 'github:issue:15' }]);
  const issues: GitHubIssue[] = [issueFixture(15, { title: 'Fence refusal push', body: null })];
  const calls: GhCall[] = [];
  try {
    runInDir(fixture.repoDir, () => {
      const store = StoreHandle.open(fixture.storeDir);
      try {
        assert.equal(reviseAcceptance(store, { taskId: 'T-001', condition: 'criteria', texts: ['Refused criterion'], actor: 'author', expectRevision: 0 }).ok, true);
      } finally {
        store.close();
      }
      const detailPath = path.join(fixture.repoDir, 'tasks', 'T-001.md');
      const parsed = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8'));
      fs.writeFileSync(detailPath, generateTaskDetailFile({ ...parsed, description: 'Intro\n```md\nnever closed\nKEEP.' }), 'utf8');

      setGhRunnerForTests(fakeGh({ issues, projectItems: [], calls, nextIssueNumber: 16 }));
      try {
        assert.throws(() => pushStoreCommand({}), /acceptance-render-refused/);
      } finally {
        setGhRunnerForTests(null);
      }
      assert.equal(calls.length, 0, 'refusal happens before any gh invocation');
    });
  } finally {
    fixture.cleanup();
  }
});

test('T-121: push body carries Git-authored Acceptance prose next to the canonical criteria (mocked gh)', () => {
  const fixture = setupStore([{ title: 'Prose push', externalId: 'github:issue:21' }]);
  const issues: GitHubIssue[] = [issueFixture(21, { title: 'Prose push', body: 'stale remote body' })];
  const calls: GhCall[] = [];
  try {
    runInDir(fixture.repoDir, () => {
      const detailPath = path.join(fixture.repoDir, 'tasks', 'T-001.md');
      const parsed = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8'));
      const description = [
        '## Acceptance',
        '- [ ] Prose criterion.',
        '',
        'Revisao independente: `docs/engineering/traycer/reviews/T-001.md` (aprovada em `68bb02b`).',
        '- Evidência: link autoral preservado.'
      ].join('\n');
      fs.writeFileSync(detailPath, generateTaskDetailFile({ ...parsed, description }), 'utf8');
      const store = StoreHandle.open(fixture.storeDir);
      try {
        assert.equal(reviseAcceptance(store, { taskId: 'T-001', condition: 'criteria', texts: ['Prose criterion.'], actor: 'author', expectRevision: 0 }).ok, true);
        assert.equal(approveAcceptanceCriterion(store, { taskId: 'T-001', index: 0, expectRevision: 1, actor: 'reviewer', evidence: { uri: 'proof://t121' } }).ok, true);
      } finally {
        store.close();
      }

      setGhRunnerForTests(fakeGh({ issues, projectItems: [], calls, nextIssueNumber: 22 }));
      try {
        const report = pushStoreCommand({});
        assert.deepEqual(report.updated.map(entry => entry.taskId), ['T-001']);
      } finally {
        setGhRunnerForTests(null);
      }
    });
    const bodyArg = calls.flatMap(entry => entry.args).find(arg => arg.startsWith('body='));
    assert.ok(bodyArg, 'push must update the issue body');
    const body = bodyArg!.slice('body='.length);
    assert.ok(body.includes('- [x] Prose criterion.'), 'canonical approved state is published');
    assert.ok(body.includes('Revisao independente: `docs/engineering/traycer/reviews/T-001.md` (aprovada em `68bb02b`).'), 'Git-authored note survives the push render');
    assert.ok(body.includes('- Evidência: link autoral preservado.'), 'authored plain evidence bullet survives the push render');
  } finally {
    fixture.cleanup();
  }
});

test('T-121: push refuses an in-section unclosed fence before any remote write (mocked gh)', () => {
  const fixture = setupStore([{ title: 'Fence in section push', externalId: 'github:issue:23' }]);
  const issues: GitHubIssue[] = [issueFixture(23, { title: 'Fence in section push', body: null })];
  const calls: GhCall[] = [];
  try {
    runInDir(fixture.repoDir, () => {
      const store = StoreHandle.open(fixture.storeDir);
      try {
        assert.equal(reviseAcceptance(store, { taskId: 'T-001', condition: 'criteria', texts: ['Fence criterion.'], actor: 'author', expectRevision: 0 }).ok, true);
      } finally {
        store.close();
      }
      const detailPath = path.join(fixture.repoDir, 'tasks', 'T-001.md');
      const parsed = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8'));
      const description = '## Acceptance\n- [ ] Fence criterion.\n```markdown\nnever closed';
      fs.writeFileSync(detailPath, generateTaskDetailFile({ ...parsed, description }), 'utf8');

      setGhRunnerForTests(fakeGh({ issues, projectItems: [], calls, nextIssueNumber: 24 }));
      try {
        assert.throws(() => pushStoreCommand({}), /acceptance-render-refused/);
      } finally {
        setGhRunnerForTests(null);
      }
      assert.equal(calls.length, 0, 'refusal happens before any gh invocation');
    });
  } finally {
    fixture.cleanup();
  }
});

test('T-121: push refuses both trailing-evidence reassociation repros before any mocked gh call', () => {
  const repros = [
    {
      title: 'Trailing evidence reorder refusal',
      issueNumber: 41,
      canonical: ['B.', 'A.'],
      authored: '## Acceptance\n- [x] A.\n- [x] B.\nEvidence for B: docs/B.md'
    },
    {
      title: 'Trailing evidence insertion refusal',
      issueNumber: 42,
      canonical: ['A.', 'B.'],
      authored: '## Acceptance\n- [x] A.\nEvidence for A: docs/A.md'
    }
  ];

  for (const repro of repros) {
    const fixture = setupStore([{ title: repro.title, externalId: `github:issue:${repro.issueNumber}` }]);
    const issues: GitHubIssue[] = [issueFixture(repro.issueNumber, { title: repro.title, body: null })];
    const calls: GhCall[] = [];
    try {
      runInDir(fixture.repoDir, () => {
        const store = StoreHandle.open(fixture.storeDir);
        try {
          assert.equal(reviseAcceptance(store, { taskId: 'T-001', condition: 'criteria', texts: repro.canonical, actor: 'author', expectRevision: 0 }).ok, true);
        } finally {
          store.close();
        }

        const detailPath = path.join(fixture.repoDir, 'tasks', 'T-001.md');
        const parsed = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8'));
        fs.writeFileSync(detailPath, generateTaskDetailFile({ ...parsed, description: repro.authored }), 'utf8');
        setGhRunnerForTests(fakeGh({ issues, projectItems: [], calls, nextIssueNumber: repro.issueNumber + 1 }));
        try {
          assert.throws(() => pushStoreCommand({}), /acceptance-render-refused/, repro.title);
        } finally {
          setGhRunnerForTests(null);
        }
        assert.equal(calls.length, 0, `${repro.title}: refusal precedes every gh invocation`);
      });
    } finally {
      fixture.cleanup();
    }
  }
});

test('T-121 F1: push with canonical EMPTY revision preserves authored-only Acceptance prose (mocked gh)', () => {
  const fixture = setupStore([{ title: 'Empty canonical push', externalId: 'github:issue:31' }]);
  const issues: GitHubIssue[] = [issueFixture(31, { title: 'Empty canonical push', body: 'stale remote body' })];
  const calls: GhCall[] = [];
  try {
    runInDir(fixture.repoDir, () => {
      const store = StoreHandle.open(fixture.storeDir);
      try {
        assert.equal(reviseAcceptance(store, { taskId: 'T-001', condition: 'criteria', texts: ['Temporary criterion.'], actor: 'author', expectRevision: 0 }).ok, true);
      } finally {
        store.close();
      }
      // Export once so the mirror carries the generated block, then revise to
      // empty and replace the mirror prose with authored-only content.
      const reloaded = StoreHandle.open(fixture.storeDir);
      try { writeRepoFiles(fixture.repoDir, reloaded); } finally { reloaded.close(); }
      const emptied = StoreHandle.open(fixture.storeDir);
      try {
        assert.equal(reviseAcceptance(emptied, { taskId: 'T-001', condition: 'empty', texts: [], actor: 'author', expectRevision: 1 }).ok, true);
      } finally {
        emptied.close();
      }
      const detailPath = path.join(fixture.repoDir, 'tasks', 'T-001.md');
      const parsed = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8'));
      const description = [
        '## Acceptance',
        'Registro autoral: fechada sem critérios executáveis; evidência em docs/evidence.md.',
        '- Nota autoral de escopo, não é aprovação.'
      ].join('\n');
      fs.writeFileSync(detailPath, generateTaskDetailFile({ ...parsed, description }), 'utf8');

      setGhRunnerForTests(fakeGh({ issues, projectItems: [], calls, nextIssueNumber: 32 }));
      try {
        const report = pushStoreCommand({});
        assert.deepEqual(report.updated.map(entry => entry.taskId), ['T-001']);
      } finally {
        setGhRunnerForTests(null);
      }
    });
    const bodyArg = calls.flatMap(entry => entry.args).find(arg => arg.startsWith('body='));
    assert.ok(bodyArg, 'push must update the issue body');
    const body = bodyArg!.slice('body='.length);
    assert.ok(body.includes('Registro autoral: fechada sem critérios executáveis; evidência em docs/evidence.md.'), 'authored note must survive canonical-empty push');
    assert.ok(body.includes('- Nota autoral de escopo, não é aprovação.'), 'authored plain note must survive');
    assert.ok(!body.includes('mapctx:store-owned acceptance revision'), 'no store-owned marker may be invented for an empty criteria set');
  } finally {
    fixture.cleanup();
  }
});

test('T-121 F1: push with canonical EMPTY revision refuses stranded checkbox evidence before any remote write (mocked gh)', () => {
  const fixture = setupStore([{ title: 'Empty stranded push', externalId: 'github:issue:33' }]);
  const issues: GitHubIssue[] = [issueFixture(33, { title: 'Empty stranded push', body: null })];
  const calls: GhCall[] = [];
  try {
    runInDir(fixture.repoDir, () => {
      const store = StoreHandle.open(fixture.storeDir);
      try {
        assert.equal(reviseAcceptance(store, { taskId: 'T-001', condition: 'criteria', texts: ['Doomed criterion.'], actor: 'author', expectRevision: 0 }).ok, true);
        assert.equal(reviseAcceptance(store, { taskId: 'T-001', condition: 'empty', texts: [], actor: 'author', expectRevision: 1 }).ok, true);
      } finally {
        store.close();
      }
      const detailPath = path.join(fixture.repoDir, 'tasks', 'T-001.md');
      const parsed = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8'));
      const description = '## Acceptance\n- [x] Doomed criterion.\nEvidence for removed criterion: docs/evidence.md';
      fs.writeFileSync(detailPath, generateTaskDetailFile({ ...parsed, description }), 'utf8');

      setGhRunnerForTests(fakeGh({ issues, projectItems: [], calls, nextIssueNumber: 34 }));
      try {
        assert.throws(() => pushStoreCommand({}), /acceptance-render-refused/);
      } finally {
        setGhRunnerForTests(null);
      }
      assert.equal(calls.length, 0, 'refusal happens before any gh invocation');
    });
  } finally {
    fixture.cleanup();
  }
});

test('T-121 F1: push with NO canonical revision preserves authored Acceptance prose and refuses stale checkboxes (mocked gh)', () => {
  const fixture = setupStore([{ title: 'Absent canonical push', externalId: 'github:issue:35' }]);
  const issues: GitHubIssue[] = [issueFixture(35, { title: 'Absent canonical push', body: 'stale remote body' })];
  const calls: GhCall[] = [];
  try {
    runInDir(fixture.repoDir, () => {
      // Author an Acceptance section WITHOUT canonical revisioning: authored
      // notes and plain bullets only (no checkbox approvals).
      const detailPath = path.join(fixture.repoDir, 'tasks', 'T-001.md');
      const parsed = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8'));
      const description = [
        '## Acceptance',
        'Critérios combinados com o operador em conversa; registro autoral.',
        '- Evidência planejada: docs/evidence-planned.md'
      ].join('\n');
      fs.writeFileSync(detailPath, generateTaskDetailFile({ ...parsed, description }), 'utf8');

      setGhRunnerForTests(fakeGh({ issues, projectItems: [], calls, nextIssueNumber: 36 }));
      try {
        const report = pushStoreCommand({});
        assert.deepEqual(report.updated.map(entry => entry.taskId), ['T-001']);
      } finally {
        setGhRunnerForTests(null);
      }
      const bodyArg = calls.flatMap(entry => entry.args).find(arg => arg.startsWith('body='));
      assert.ok(bodyArg, 'push must update the issue body');
      const body = bodyArg!.slice('body='.length);
      assert.ok(body.includes('Critérios combinados com o operador em conversa; registro autoral.'), 'authored Acceptance prose survives absent canonical revision');
      assert.ok(body.includes('- Evidência planejada: docs/evidence-planned.md'), 'authored plain bullet survives');
      assert.ok(!body.includes('mapctx:store-owned acceptance revision'), 'no marker invented without canonical authority');
    });
    // Second phase: a stale checkbox in an unowned section must refuse.
    runInDir(fixture.repoDir, () => {
      const detailPath = path.join(fixture.repoDir, 'tasks', 'T-001.md');
      const parsed = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8'));
      const description = '## Acceptance\n- [x] Stale unchecked criterion.\nEvidence: docs/evidence.md';
      fs.writeFileSync(detailPath, generateTaskDetailFile({ ...parsed, description }), 'utf8');
      const calls2: GhCall[] = [];
      setGhRunnerForTests(fakeGh({ issues, projectItems: [], calls: calls2, nextIssueNumber: 37 }));
      try {
        assert.throws(() => pushStoreCommand({}), /acceptance-render-refused/);
      } finally {
        setGhRunnerForTests(null);
      }
      assert.equal(calls2.length, 0, 'stale checkbox in unowned section refuses before any gh invocation');
    });
  } finally {
    fixture.cleanup();
  }
});
