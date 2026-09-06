import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import { parseTaskDetailFile } from '@mapctx/core';
import { resolveProjectStoreDir, StoreHandle } from '@mapctx/store';
import { accountAddCommand, accountListCommand, budgetHistoryCommand, budgetSetCommand, budgetStatusCommand, planPeriodRecordCommand } from './budget-cli';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function seedStoreAuthorityRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = makeTempDir('mapctx-budget-cli-repo-');
  const homeDir = makeTempDir('mapctx-budget-cli-home-');
  // MAPCTX_HOME must be set BEFORE touching resolveProjectStoreDir, or the
  // seed lands in the developer's real ~/.mapctx.
  const previousHome = process.env.MAPCTX_HOME;
  process.env.MAPCTX_HOME = homeDir;
  const projectId = crypto.randomUUID();
  fs.writeFileSync(path.join(repoDir, 'mapctx.toml'), [
    'schemaVersion = 1',
    `projectId = "${projectId}"`,
    'plansAuthority = "store"',
    ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(repoDir, 'TASKS.md'), '# seed\n', 'utf8');
  fs.mkdirSync(path.join(repoDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'tasks', 'E-001.md'), [
    '# E-001',
    '',
    '  - role: coordination',
    '  - impact: high',
    '  - estimatedEffort: 2w',
    '  - prerequisites: []',
    '  - blocking: []',
    '  - filesAffected: []',
    '  - testsRequired: []',
    '  - summary: epic',
    '  - description: |',
    '      Seed prose.',
    ''
  ].join('\n'), 'utf8');

  const handle = StoreHandle.open(resolveProjectStoreDir(projectId));
  handle.appendEvent({
    eventType: 'project.initialized',
    actor: 'test',
    payload: {
      projectId,
      boardTitle: 'budget cli test',
      workDomains: [],
      notesMarkdown: '',
      plansAuthority: 'store'
    }
  });
  handle.appendEvent({
    eventType: 'task.upserted',
    actor: 'test',
    payload: {
      task: {
        taskId: 'E-001',
        positionKey: 1,
        title: 'Epic one',
        planningState: 'in-progress',
        executionState: 'unclaimed',
        type: 'epic',
        parentTaskId: null,
        tags: [],
        domains: [],
        externalLinks: [],
        assignees: [],
        detailPath: './tasks/E-001.md',
        updatedOn: '2026-09-06'
      },
      detail: {
        taskId: 'E-001',
        role: 'coordination',
        impact: 'high',
        estimatedEffort: '2w',
        prerequisites: [],
        blocking: [],
        filesAffected: [],
        testsRequired: [],
        summary: 'epic'
      }
    }
  });
  handle.close();

  return {
    repoDir,
    cleanup: () => {
      if (previousHome === undefined) delete process.env.MAPCTX_HOME;
      else process.env.MAPCTX_HOME = previousHome;
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  };
}

test('budget CLI end-to-end: account, plan period, budget set/status through the store', () => {
  const { repoDir, cleanup } = seedStoreAuthorityRepo();
  const previousCwd = process.cwd();
  process.chdir(repoDir);
  try {
    const added = captureJson(() => accountAddCommand('Codex Pro', { json: true, currency: 'USD', note: 'paguei $200 em 05/09' } as never)) as { ok: boolean; account: { accountId: string; currency: string } };
    assert.equal(added.ok, true);
    assert.equal(added.account.currency, 'USD');

    const listed = captureJson(() => accountListCommand({ json: true } as never)) as { accounts: Array<{ name: string; planPeriods: number }> };
    assert.equal(listed.accounts.length, 1);
    assert.equal(listed.accounts[0].planPeriods, 0);

    const period = captureJson(() => planPeriodRecordCommand({
      json: true,
      account: added.account.accountId,
      amount: '200.00',
      start: '2026-09-01',
      end: '2026-09-30'
    } as never)) as { ok: boolean; period: { accountId: string; fixedCents: number; periodStart: string; periodEnd: string } };
    assert.equal(period.ok, true);
    assert.equal(period.period.accountId, added.account.accountId);
    assert.equal(period.period.fixedCents, 20_000);
    assert.equal(period.period.periodStart, '2026-09-01T00:00:00.000Z');
    assert.equal(period.period.periodEnd, '2026-09-30T23:59:59.000Z');

    const setStatus = captureJson(() => budgetSetCommand('E-001', { json: true, amount: '500.00' } as never)) as { ok: boolean; budget: { unit: string; money: { amountMinor: number } }; regenerated: { detailFiles: number } };
    assert.equal(setStatus.ok, true);
    assert.equal(setStatus.budget.money.amountMinor, 50_000);
    assert.ok(setStatus.regenerated.detailFiles >= 1, 'budget set regenerates canonical files');

    const detail = parseTaskDetailFile(fs.readFileSync(path.join(repoDir, 'tasks', 'E-001.md'), 'utf8'));
    assert.equal(detail.description, 'Seed prose.', 'budget section must not leak into the description');
    const rawDetail = fs.readFileSync(path.join(repoDir, 'tasks', 'E-001.md'), 'utf8');
    assert.ok(rawDetail.includes('  - budgetPlanned: 500.00 USD'), 'epic detail carries the generated budget projection');
    assert.ok(rawDetail.includes('  - budgetCoverage: no-data'), 'scope with no cost chain data says no-data');

    const status = captureJson(() => budgetStatusCommand('E-001', { json: true } as never)) as {
      ok: boolean;
      status: {
        hasBudget: boolean;
        plannedMoney: { amountMinor: number; currency: string; decimals: number };
        consumed: { coverage: string; reason: string | null; consumedMinor: number };
        remainingMinor: number;
        spentBp: number;
      };
    };
    assert.equal(status.ok, true);
    assert.equal(status.status.hasBudget, true);
    assert.deepEqual(status.status.plannedMoney, { amountMinor: 50_000, currency: 'USD', decimals: 2 });
    assert.equal(status.status.consumed.coverage, 'no-data');
    assert.equal(status.status.consumed.reason, 'no-dispatches');
    assert.equal(status.status.remainingMinor, 50_000 * 10 ** 4, 'remaining computed in the micros grid');
    assert.equal(status.status.spentBp, 0);

    const history = captureJson(() => budgetHistoryCommand('E-001', { json: true } as never)) as { budgets: unknown[] };
    assert.equal(history.budgets.length, 1);
  } finally {
    process.chdir(previousCwd);
    cleanup();
  }
});

test('budget commands fail closed outside store authority', () => {
  const markdownRepo = makeTempDir('mapctx-budget-cli-markdown-');
  const previousCwd = process.cwd();
  process.chdir(markdownRepo);
  try {
    assert.throws(() => accountAddCommand('X', { json: true } as never), /mapctx\.toml/);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(markdownRepo, { recursive: true, force: true });
  }
});
