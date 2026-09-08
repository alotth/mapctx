import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import { GhCommandError, getIssues, getProjectIssueItems, setGhRunnerForTests } from './github';
import { loadConfig, resolveGithubSourceMode } from './config';
import { pullCommand, pushCommand } from './sync';
import { SyncConfig } from './types';

const OWNER = 'o';
const REPO = 'r';
const PROJECT_ID = 'PVT_test';
const STATUS_FIELD_ID = 'PVTSSF_test';

function fixtureIssue(n: number) {
  const closed = n % 50 === 0;
  return {
    number: n,
    node_id: `ISSUE_node_${n}`,
    title: `issue ${n}`,
    body: null,
    state: closed ? 'closed' : 'open',
    labels: [],
    milestone: null,
    html_url: `https://github.com/${OWNER}/${REPO}/issues/${n}`,
    closed_at: closed ? '2026-08-01T00:00:00Z' : null,
    updated_at: '2026-09-01T00:00:00Z'
  };
}

type FixtureOptions = {
  issueCount: number;
  projectItemCount: number;
  authScopes?: string;
  fail?: { stderr: string };
};

function makeFixtureRunner(options: FixtureOptions) {
  const calls: string[][] = [];

  const itemsPage = (kind: 'items' | 'statuses', cursor: string | undefined): unknown => {
    const pageSize = 100;
    const start = cursor ? pageSize : 0;
    const end = Math.min(options.projectItemCount, start + pageSize);
    const nodes = [];
    for (let n = start + 1; n <= end; n++) {
      const fieldValues = kind === 'statuses'
        ? {
            nodes: [{
              name: n % 50 === 0 ? 'Done' : 'Backlog',
              field: { id: STATUS_FIELD_ID }
            }]
          }
        : { nodes: [] };
      nodes.push({
        id: `PVTI_${n}`,
        content: {
          number: n,
          repository: { name: REPO, owner: { login: OWNER } }
        },
        fieldValues
      });
    }
    return {
      data: {
        node: {
          items: {
            pageInfo: {
              hasNextPage: end < options.projectItemCount,
              endCursor: end < options.projectItemCount ? 'cursor-page-2' : null
            },
            nodes
          }
        }
      }
    };
  };

  const fieldsResponse = {
    data: {
      node: {
        fields: {
          nodes: [{
            id: STATUS_FIELD_ID,
            name: 'Status',
            options: [
              { id: 'OPT_backlog', name: 'Backlog' },
              { id: 'OPT_done', name: 'Done' }
            ]
          }]
        }
      }
    }
  };

  const runner = (args: string[]): string => {
    calls.push(args);
    if (options.fail && args[0] === 'api') {
      throw new Error(options.fail.stderr);
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      return [
        'github.com',
        '  ✓ Logged in to github.com account tester',
        '  - Token: ghp_****',
        `  - Token scopes: ${options.authScopes ?? "'read:project', 'repo'"}`
      ].join('\n');
    }
    if (args[0] !== 'api') throw new Error(`unexpected gh invocation: ${args.join(' ')}`);

    const endpoint = args[1] ?? '';
    const kv = new Map<string, string>();
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '-f') {
        const pair = args[++i];
        const eq = pair.indexOf('=');
        kv.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    }

    if (endpoint === 'graphql') {
      const query = kv.get('query') ?? '';
      const cursor = kv.get('cursor');
      if (query.includes('fields(first: 50)')) return JSON.stringify(fieldsResponse);
      if (query.includes('SingleSelectValue')) return JSON.stringify(itemsPage('statuses', cursor));
      if (query.includes('DateValue')) return JSON.stringify(itemsPage('items', cursor));
      return JSON.stringify(itemsPage('items', cursor));
    }

    if (endpoint.startsWith(`repos/${OWNER}/${REPO}/issues`)) {
      const page = Number(new URLSearchParams(endpoint.split('?')[1] ?? '').get('page') ?? '1');
      const start = (page - 1) * 100;
      const batch = [];
      for (let n = start + 1; n <= Math.min(options.issueCount, start + 100); n++) {
        batch.push(fixtureIssue(n));
      }
      return JSON.stringify(batch);
    }

    throw new Error(`unexpected gh api endpoint: ${endpoint}`);
  };

  return { runner, calls };
}

function writeBoardFile(tempDir: string, taskCount: number, linked: boolean): string {
  const lines = [
    '# Tasks - fixture',
    '',
    '## Work Domains',
    '',
    '- SYNC: sync domain',
    '',
    '## Tasks',
    ''
  ];
  for (let i = 1; i <= taskCount; i++) {
    const id = `T-${String(i).padStart(3, '0')}`;
    const externalId = linked ? `github:issue:${i}` : 'null';
    lines.push(
      `### [${id}] task ${i}`,
      '',
      `  - id: ${id}`,
      '  - status: backlog',
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
      `  - externalId: ${externalId}`,
      '  - updated: 2026-08-17',
      '  - detail: null',
      ''
    );
  }
  lines.push('## Notes', '');
  const tasksFilePath = path.resolve(tempDir, 'TASKS.md');
  fs.writeFileSync(tasksFilePath, lines.join('\n'), 'utf8');
  return tasksFilePath;
}

function writeConfigFile(tempDir: string, github: SyncConfig['github']): string {
  const config = {
    owner: OWNER,
    repo: REPO,
    projectId: PROJECT_ID,
    statusFieldId: STATUS_FIELD_ID,
    tasksFile: './TASKS.md',
    allowedStatuses: ['backlog', 'ready-for-do', 'doing', 'review', 'done', 'paused'],
    completionStatuses: ['done'],
    statusMap: {
      backlog: 'Backlog',
      'ready-for-do': 'Ready for Do',
      doing: 'Doing',
      review: 'Review',
      done: 'Done',
      paused: 'Paused'
    },
    github
  };
  const configPath = path.resolve(tempDir, 'mapcs.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return configPath;
}

function captureOutputs(run: () => void): { stdout: string; stderr: string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    outChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    errChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { stdout: outChunks.join(''), stderr: errChunks.join('') };
}

test('getIssues paginates beyond the first 100 results', () => {
  const fixture = makeFixtureRunner({ issueCount: 150, projectItemCount: 0 });
  setGhRunnerForTests(fixture.runner);
  try {
    const issues = getIssues({ owner: OWNER, repo: REPO } as SyncConfig);
    assert.equal(issues.length, 150);
    assert.equal(issues[0].number, 1);
    assert.equal(issues[149].number, 150);
    assert.equal(fixture.calls.filter(c => c[1]?.startsWith(`repos/${OWNER}/${REPO}/issues`)).length, 2);
  } finally {
    setGhRunnerForTests(null);
  }
});

test('getProjectIssueItems paginates via GraphQL cursor beyond 100 items', () => {
  const fixture = makeFixtureRunner({ issueCount: 0, projectItemCount: 150 });
  setGhRunnerForTests(fixture.runner);
  try {
    const items = getProjectIssueItems({ owner: OWNER, repo: REPO, projectId: PROJECT_ID } as SyncConfig);
    assert.equal(items.length, 150);
    assert.equal(items[149].itemId, 'PVTI_150');
    const graphqlCalls = fixture.calls.filter(c => c[1] === 'graphql');
    assert.equal(graphqlCalls.length, 2);
    assert.ok(graphqlCalls[0].some(a => a === '-f' || a.startsWith('query=')));
    assert.ok(graphqlCalls[1].includes('-f'));
    assert.ok(graphqlCalls[1].some(a => a === 'cursor=cursor-page-2'));
  } finally {
    setGhRunnerForTests(null);
  }
});

test('scope failures surface the missing scope by name with the remedy', () => {
  const fixture = makeFixtureRunner({
    issueCount: 0,
    projectItemCount: 0,
    authScopes: "'gist', 'repo'",
    fail: { stderr: 'gh: Resource not accessible by integration (HTTP 403)' }
  });
  setGhRunnerForTests(fixture.runner);
  try {
    assert.throws(
      () => getProjectIssueItems({ owner: OWNER, repo: REPO, projectId: PROJECT_ID } as SyncConfig),
      (error: unknown) => {
        assert.ok(error instanceof GhCommandError);
        assert.equal(error.missingScope, 'read:project');
        assert.match(error.message, /missing the required scope 'read:project'/);
        assert.match(error.message, /gh auth refresh -h github\.com -s read:project/);
        return true;
      }
    );
  } finally {
    setGhRunnerForTests(null);
  }
});

test('a 403 with all scopes present stays a generic error, not a fake scope diagnosis', () => {
  const fixture = makeFixtureRunner({
    issueCount: 0,
    projectItemCount: 0,
    authScopes: "'read:project', 'repo'",
    fail: { stderr: 'gh: Resource not accessible by integration (HTTP 403)' }
  });
  setGhRunnerForTests(fixture.runner);
  try {
    assert.throws(
      () => getProjectIssueItems({ owner: OWNER, repo: REPO, projectId: PROJECT_ID } as SyncConfig),
      (error: unknown) => {
        assert.ok(error instanceof GhCommandError);
        assert.equal(error.missingScope, null);
        assert.match(error.message, /HTTP 403/);
        return true;
      }
    );
  } finally {
    setGhRunnerForTests(null);
  }
});

test('github.sourceMode canonical fails closed and invalid values are rejected', () => {
  assert.equal(resolveGithubSourceMode({ owner: 'o', repo: 'r' } as SyncConfig), 'projection');
  assert.equal(resolveGithubSourceMode({ owner: 'o', repo: 'r', github: { sourceMode: 'projection' } } as SyncConfig), 'projection');

  assert.throws(
    () => loadConfigFor({ sourceMode: 'canonical' }),
    /github\.sourceMode "canonical" is not implemented/
  );
  assert.throws(
    () => loadConfigFor({ sourceMode: 'bidirectional' as never }),
    /github\.sourceMode must be "projection" or "canonical"/
  );
});

function loadConfigFor(github: SyncConfig['github']): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-source-mode-'));
  try {
    writeConfigFile(tempDir, github);
    fs.writeFileSync(path.resolve(tempDir, 'TASKS.md'), '# Tasks\n', 'utf8');
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      loadConfig({});
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('>100-item round trip: pull imports 150 fixture issues, push dry-run replays them without writes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-roundtrip-'));
  const fixture = makeFixtureRunner({ issueCount: 150, projectItemCount: 150 });
  setGhRunnerForTests(fixture.runner);
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  try {
    writeConfigFile(tempDir, { sourceMode: 'projection' });
    writeBoardFile(tempDir, 150, true);

    const pullOutput = captureOutputs(() => pullCommand({}));
    assert.match(pullOutput.stdout, /explicit one-off import/);
    assert.match(pullOutput.stdout, /pull completed/);

    const pulled = fs.readFileSync(path.resolve(tempDir, 'TASKS.md'), 'utf8');
    assert.equal((pulled.match(/- status: done/g) ?? []).length, 3, 'issues #50/#100/#150 map to done');
    assert.equal((pulled.match(/- status: backlog/g) ?? []).length, 147);

    const pushOutput = captureOutputs(() => pushCommand({ dryRun: true, json: true }));
    const summary = JSON.parse(pushOutput.stdout) as { dryRun: boolean; sourceMode: string; created: number; updated: number; conflicts: string[] };
    assert.equal(summary.dryRun, true);
    assert.equal(summary.sourceMode, 'projection');
    assert.equal(summary.created, 0);
    assert.equal(summary.updated, 150);
    assert.deepEqual(summary.conflicts, []);

    const mutationCalls = fixture.calls.filter(c => {
      const query = c.find(a => typeof a === 'string' && a.startsWith('query=')) ?? '';
      return /mutation/.test(query) || /-X, (POST|PATCH)/.test(c.join(' ')) || c.includes('-X');
    });
    assert.equal(mutationCalls.length, 0, 'dry-run must never mutate the remote');

    const boardAfterPush = fs.readFileSync(path.resolve(tempDir, 'TASKS.md'), 'utf8');
    assert.equal(boardAfterPush, pulled, 'dry-run push must not rewrite the board');
  } finally {
    process.chdir(previousCwd);
    setGhRunnerForTests(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('>100-item round trip: unlinked tasks are reported as creates in dry-run, not written', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-roundtrip-create-'));
  const fixture = makeFixtureRunner({ issueCount: 150, projectItemCount: 150 });
  setGhRunnerForTests(fixture.runner);
  const previousCwd = process.cwd();
  process.chdir(tempDir);
  try {
    writeConfigFile(tempDir, { sourceMode: 'projection' });
    writeBoardFile(tempDir, 150, true);
    pullCommand({});

    writeBoardFile(tempDir, 151, true);
    const board = fs.readFileSync(path.resolve(tempDir, 'TASKS.md'), 'utf8');
    fs.writeFileSync(
      path.resolve(tempDir, 'TASKS.md'),
      board.replace(/  - externalId: github:issue:151/, '  - externalId: null'),
      'utf8'
    );

    const pushOutput = captureOutputs(() => pushCommand({ dryRun: true, json: true }));
    const summary = JSON.parse(pushOutput.stdout) as { created: number; updated: number };
    assert.equal(summary.created, 1);
    assert.equal(summary.updated, 150);
    assert.ok(!fixture.calls.some(c => c.includes('-X')), 'no POST/PATCH in dry-run');
  } finally {
    process.chdir(previousCwd);
    setGhRunnerForTests(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
