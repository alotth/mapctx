import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import { loadConfig } from './config';
import { parseTasksFile, writeBoard } from './markdown';
import { bootstrapCommand, pullCommand, pushCommand, statusCommand } from './sync';
import { SyncConfig, TaskBoard } from './types';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-sync-engine-'));
}

function writeConfig(tempDir: string, config: Partial<SyncConfig>): string {
  const merged: SyncConfig = {
    owner: 'acme',
    repo: 'roadmap',
    tasksFile: './TASKS.md',
    statusMap: {
      backlog: 'Backlog',
      doing: 'Doing',
      review: 'Review',
      done: 'Done',
      paused: 'Paused'
    },
    ...config
  };
  const configPath = path.resolve(tempDir, 'kanban-sync-engine.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return configPath;
}

function writeTasks(tempDir: string, board: TaskBoard): string {
  const tasksFilePath = path.resolve(tempDir, 'TASKS.md');
  writeBoard(tasksFilePath, board);
  return tasksFilePath;
}

function stubGitHub(stubs: Record<string, any>): () => void {
  const github = require('./github') as Record<string, any>;
  const original: Record<string, any> = {};
  for (const [key, value] of Object.entries(stubs)) {
    original[key] = github[key];
    github[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(original)) {
      github[key] = value;
    }
  };
}

test('default config keeps legacy status behavior', () => {
  const tempDir = makeTempDir();
  const configPath = writeConfig(tempDir, {});
  const { config } = loadConfig({ configPath });
  assert.deepEqual(config.allowedStatuses, ['backlog', 'doing', 'review', 'done', 'paused']);
  assert.deepEqual(config.completionStatuses, ['done']);
});

test('custom partial workflow accepts extra status', () => {
  const tempDir = makeTempDir();
  const configPath = writeConfig(tempDir, {
    allowedStatuses: ['backlog', 'doing', 'review', 'done', 'paused', 'design'],
    statusMap: {
      backlog: 'Backlog',
      doing: 'Doing',
      review: 'Review',
      done: 'Done',
      paused: 'Paused',
      design: 'Design'
    }
  });
  writeTasks(tempDir, {
    title: 'Tasks',
    componentsSection: [],
    notesSection: [],
    tasks: [{ id: 'T-001', title: 'UX pass', status: 'design', completed: null, externalId: null }]
  });

  const restore = stubGitHub({ getIssues: () => [] });
  try {
    const report = statusCommand({ configPath });
    assert.equal(report.localTasks, 1);
    assert.equal(report.linkedTasks, 0);
  } finally {
    restore();
  }
});

test('custom full replacement works without default statuses', () => {
  const tempDir = makeTempDir();
  const configPath = writeConfig(tempDir, {
    allowedStatuses: ['inbox', 'design', 'build', 'qa', 'released'],
    completionStatuses: ['released'],
    statusMap: {
      inbox: 'Inbox',
      design: 'Design',
      build: 'Build',
      qa: 'QA',
      released: 'Released'
    }
  });
  writeTasks(tempDir, {
    title: 'Tasks',
    componentsSection: [],
    notesSection: [],
    tasks: [{ id: 'T-010', title: 'Ship v1', status: 'qa', completed: null, externalId: null }]
  });

  const restore = stubGitHub({ getIssues: () => [] });
  try {
    const report = statusCommand({ configPath });
    assert.equal(report.localTasks, 1);
  } finally {
    restore();
  }
});

test('custom completionStatuses drive completed semantics on pull', () => {
  const tempDir = makeTempDir();
  const configPath = writeConfig(tempDir, {
    projectId: 'PVT_1',
    statusFieldId: 'FIELD_STATUS',
    completedDateFieldId: 'FIELD_COMPLETED',
    allowedStatuses: ['inbox', 'design', 'build', 'qa', 'released'],
    completionStatuses: ['released'],
    statusMap: {
      inbox: 'Inbox',
      design: 'Design',
      build: 'Build',
      qa: 'QA',
      released: 'Released'
    }
  });
  const tasksFilePath = writeTasks(tempDir, {
    title: 'Tasks',
    componentsSection: [],
    notesSection: [],
    tasks: [
      { id: 'T-001', title: 'Release train', status: 'released', completed: null, externalId: 'github:issue:1' },
      { id: 'T-002', title: 'Backend build', status: 'build', completed: '2026-01-01', externalId: 'github:issue:2' }
    ]
  });

  const restore = stubGitHub({
    getIssues: () => [
      {
        number: 1,
        node_id: 'I_1',
        title: 'Release train',
        body: '',
        state: 'closed',
        labels: [],
        milestone: null,
        html_url: 'https://example.test/1',
        closed_at: '2026-02-01T00:00:00Z',
        updated_at: '2026-02-01T00:00:00Z'
      },
      {
        number: 2,
        node_id: 'I_2',
        title: 'Backend build',
        body: '',
        state: 'open',
        labels: [],
        milestone: null,
        html_url: 'https://example.test/2',
        closed_at: null,
        updated_at: '2026-02-02T00:00:00Z'
      }
    ],
    getProjectStatuses: () => [
      { issueNumber: 1, itemId: 'PI_1', statusName: 'Released' },
      { issueNumber: 2, itemId: 'PI_2', statusName: 'Build' }
    ],
    getProjectDates: () => [
      { issueNumber: 1, itemId: 'PI_1' },
      { issueNumber: 2, itemId: 'PI_2' }
    ]
  });

  try {
    pullCommand({ configPath });
    const parsed = parseTasksFile(tasksFilePath);
    const released = parsed.tasks.find(task => task.id === 'T-001');
    const build = parsed.tasks.find(task => task.id === 'T-002');
    assert.equal(released?.completed, '2026-02-01');
    assert.equal(build?.completed, null);
  } finally {
    restore();
  }
});

test('fails when statusMap does not cover all allowedStatuses', () => {
  const tempDir = makeTempDir();
  const configPath = writeConfig(tempDir, {
    allowedStatuses: ['backlog', 'doing', 'review', 'done', 'paused', 'design'],
    statusMap: {
      backlog: 'Backlog',
      doing: 'Doing',
      review: 'Review',
      done: 'Done',
      paused: 'Paused'
    }
  });

  assert.throws(() => loadConfig({ configPath }), /statusMap is missing allowed statuses: design/);
});

test('fails when completionStatuses has values outside allowedStatuses', () => {
  const tempDir = makeTempDir();
  const configPath = writeConfig(tempDir, {
    allowedStatuses: ['inbox', 'design', 'build'],
    completionStatuses: ['released'],
    statusMap: {
      inbox: 'Inbox',
      design: 'Design',
      build: 'Build'
    }
  });

  assert.throws(() => loadConfig({ configPath }), /completionStatuses must be a subset/);
});

test('roundtrip pull/push/bootstrap preserves custom statuses', () => {
  const tempDir = makeTempDir();
  const configPath = writeConfig(tempDir, {
    projectId: 'PVT_2',
    statusFieldId: 'FIELD_STATUS',
    allowedStatuses: ['inbox', 'design', 'build', 'qa', 'released'],
    completionStatuses: ['released'],
    statusMap: {
      inbox: 'Inbox',
      design: 'Design',
      build: 'Build',
      qa: 'QA',
      released: 'Released'
    },
    bootstrap: {
      defaultStatusForImportedIssues: 'inbox'
    }
  });
  const tasksFilePath = writeTasks(tempDir, {
    title: 'Tasks',
    componentsSection: [],
    notesSection: [],
    tasks: [
      { id: 'T-001', title: 'Design API', status: 'design', completed: null, externalId: 'github:issue:11' }
    ]
  });

  const issues = [
    {
      number: 11,
      node_id: 'I_11',
      title: 'Design API',
      body: 'body',
      state: 'open',
      labels: [],
      milestone: null,
      html_url: 'https://example.test/11',
      closed_at: null,
      updated_at: '2026-02-03T00:00:00Z'
    },
    {
      number: 12,
      node_id: 'I_12',
      title: 'QA pass',
      body: 'body',
      state: 'open',
      labels: [],
      milestone: null,
      html_url: 'https://example.test/12',
      closed_at: null,
      updated_at: '2026-02-03T00:00:00Z'
    }
  ];

  const restore = stubGitHub({
    getIssues: () => issues,
    getProjectStatuses: () => [
      { issueNumber: 11, itemId: 'PI_11', statusName: 'Design' },
      { issueNumber: 12, itemId: 'PI_12', statusName: 'QA' }
    ],
    getProjectDates: () => [],
    getStatusOptionIds: () => ({ Design: 'OPT_DESIGN', QA: 'OPT_QA' }),
    getProjectIssueItems: () => [
      { issueNumber: 11, itemId: 'PI_11' },
      { issueNumber: 12, itemId: 'PI_12' }
    ]
  });

  try {
    pullCommand({ configPath });
    pushCommand({ configPath, dryRun: true });
    bootstrapCommand('github', { configPath });

    const parsed = parseTasksFile(tasksFilePath);
    const byId = new Map(parsed.tasks.map(task => [task.id, task.status]));
    assert.equal(byId.get('T-001'), 'design');
    assert.ok(Array.from(byId.values()).includes('qa'));
  } finally {
    restore();
  }
});

test('fails when TASKS.md contains invalid status', () => {
  const tempDir = makeTempDir();
  const configPath = writeConfig(tempDir, {
    allowedStatuses: ['backlog', 'doing', 'review', 'done', 'paused'],
    statusMap: {
      backlog: 'Backlog',
      doing: 'Doing',
      review: 'Review',
      done: 'Done',
      paused: 'Paused'
    }
  });
  writeTasks(tempDir, {
    title: 'Tasks',
    componentsSection: [],
    notesSection: [],
    tasks: [{ id: 'T-999', title: 'Unknown status', status: 'design', completed: null, externalId: null }]
  });

  const restore = stubGitHub({ getIssues: () => [] });
  try {
    assert.throws(() => statusCommand({ configPath }), /TASKS.md contains invalid statuses: design/);
  } finally {
    restore();
  }
});
