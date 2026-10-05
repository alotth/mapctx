import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import { resolveProjectStoreDir, StoreHandle } from '@mapctx/store';

/**
 * T-119 end-to-end: the real CLI path (draft -> approve -> repair) on a
 * copied store home, proving the subcommand wiring, the approval token flow,
 * and that repair replays the attested DB-only row instead of refusing.
 */
const ORPHAN_NODE = '23224427-9da8-458b-ab90-18ebadbb8613';
const PROJECT_ID = '9176b907-4a73-4a03-bfdb-bb20eff306f6';

function cli(args: string[], cwd: string): string {
  return execFileSync('node', [require.resolve('./mapctx-cli.js'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MAPCTX_HOME: process.env.MAPCTX_HOME }
  });
}

test('store attest-orphan CLI: draft, approve, then repair replays the attested row', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-attest-e2e-repo-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-attest-e2e-home-'));
  const previousHome = process.env.MAPCTX_HOME;
  const previousCwd = process.cwd();
  process.env.MAPCTX_HOME = home;
  process.chdir(repoDir);

  try {
    fs.writeFileSync(path.join(repoDir, 'mapctx.toml'), [
      'schemaVersion = 1',
      `projectId = "${PROJECT_ID}"`,
      'plansAuthority = "store"',
      ''
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(repoDir, 'TASKS.md'), [
      '# Tasks - attest e2e',
      '',
      '## Work Domains',
      '',
      '- STORE: store domain',
      '',
      '## Tasks',
      '',
      '## Notes',
      ''
    ].join('\n'), 'utf8');

    // Seed a live store with one normal event plus one DB-only orphan row
    // (compact-legacy payload hash, journal_path "") like the real Sep-27 rows.
    const storeDir = resolveProjectStoreDir(PROJECT_ID);
    const handle = StoreHandle.open(storeDir);
    handle.appendEvent({
      eventType: 'project.initialized',
      actor: 'test',
      payload: { projectId: PROJECT_ID, boardTitle: 'T', workDomains: [], notesMarkdown: '', plansAuthority: 'store' }
    });
    handle.appendEvent({
      eventType: 'task.upserted',
      actor: 'test',
      payload: {
        task: {
          taskId: 'T-001',
          positionKey: 1,
          title: 'task 1',
          planningState: 'backlog',
          executionState: 'unclaimed',
          tags: [],
          domains: [],
          externalLinks: [],
          assignees: []
        }
      }
    });
    handle.close();
    {
      const { openDatabase } = require('@mapctx/store') as typeof import('@mapctx/store');
      const payload = { taskId: 'T-001', patch: { planningState: 'in-progress', updatedOn: '2026-09-27' }, source: 'reopen' };
      const payloadJson = JSON.stringify(payload);
      const { createHash } = require('crypto') as typeof import('crypto');
      const compactHash = createHash('sha256').update(payloadJson, 'utf8').digest('hex');
      const db = openDatabase(StoreHandle.dbPathFor(storeDir));
      try {
        db.prepare(`
          INSERT INTO event_log (node_id, sequence, logical_clock, event_type, schema_version, occurred_at,
            actor, causation_json, payload_json, payload_sha256, journal_path)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(ORPHAN_NODE, 3, 3, 'task.patched', 1, '2026-09-27T18:51:48.242Z', 'traycer', '[]', payloadJson, compactHash, '');
      } finally {
        db.close();
      }
    }

    // Repair refuses before the attestation exists.
    assert.throws(() => cli(['store', 'repair', '--json'], repoDir), /gap\(s\) found/);

    // Draft (writes nothing) -> approval token.
    const reasonFile = path.join(repoDir, 'attestation-reason.txt');
    fs.writeFileSync(reasonFile, 'e2e: DB-only node reviewed for T-119\n', 'utf8');
    const draft = JSON.parse(cli(['store', 'attest-orphan', ORPHAN_NODE, '--reason-file', 'attestation-reason.txt', '--evidence', 'verifier=agent-7=trial', '--json'], repoDir));
    assert.equal(draft.status, 'draft');
    assert.equal(draft.attestation.rows.length, 1);
    assert.deepEqual(draft.attestation.evidence, { verifier: 'agent-7=trial' }, 'shared evidence parser preserves values containing =');
    assert.equal(fs.existsSync(path.join(storeDir, 'node-attestations.json')), false);

    // Approval with a mismatched token is refused and writes nothing.
    assert.throws(
      () => cli(['store', 'attest-orphan', ORPHAN_NODE, '--reason-file', 'attestation-reason.txt', '--evidence', 'verifier=agent-7=trial', '--approve-hash', '0'.repeat(64), '--json'], repoDir),
      /Approval hash mismatch/
    );

    // Correct token writes the attestation; repair then succeeds.
    const attested = JSON.parse(cli(['store', 'attest-orphan', ORPHAN_NODE, '--reason-file', 'attestation-reason.txt', '--evidence', 'verifier=agent-7=trial', '--approve-hash', draft.contentSha256, '--json'], repoDir));
    assert.equal(attested.status, 'attested');
    assert.equal(attested.contentSha256, draft.contentSha256);

    const repair = JSON.parse(cli(['store', 'repair', '--json'], repoDir));
    assert.equal(repair.status, 'ok');
    assert.equal(repair.eventsReplayed, 3);

    // The rebuilt row is byte-identical, journal-less as before.
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(StoreHandle.dbPathFor(storeDir), { readOnly: true });
    try {
      const row = db.prepare('SELECT * FROM event_log WHERE node_id = ?').all(ORPHAN_NODE) as Array<Record<string, unknown>>;
      assert.equal(row.length, 1);
      assert.equal(row[0].journal_path, '');
      assert.equal(row[0].payload_sha256, draft.attestation.rows[0].payload_sha256);
    } finally {
      db.close();
    }

    // Duplicate DRAFT is read-only and allowed (re-confirmation remedy); a
    // divergent-content APPROVAL still refuses with zero writes.
    const dupDraft = JSON.parse(cli(['store', 'attest-orphan', ORPHAN_NODE, '--reason-file', 'attestation-reason.txt', '--evidence', 'verifier=agent-7=trial', '--json'], repoDir));
    assert.equal(dupDraft.status, 'draft');
    fs.writeFileSync(path.join(repoDir, 'other-reason.txt'), 'a different reviewed reason\n', 'utf8');
    const otherDraft = JSON.parse(cli(['store', 'attest-orphan', ORPHAN_NODE, '--reason-file', 'other-reason.txt', '--json'], repoDir));
    assert.notEqual(otherDraft.contentSha256, draft.contentSha256);
    assert.throws(
      () => cli(['store', 'attest-orphan', ORPHAN_NODE, '--reason-file', 'other-reason.txt', '--approve-hash', otherDraft.contentSha256, '--json'], repoDir),
      /different reviewed content/
    );
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.MAPCTX_HOME;
    else process.env.MAPCTX_HOME = previousHome;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('store attest-orphan CLI: blank/whitespace reason is refused before any draft, witness, or file', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-attest-blank-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-attest-blank-home-'));
  const previousHome = process.env.MAPCTX_HOME;
  const previousCwd = process.cwd();
  process.env.MAPCTX_HOME = home;
  process.chdir(repoDir);

  try {
    fs.writeFileSync(path.join(repoDir, 'mapctx.toml'), [
      'schemaVersion = 1',
      `projectId = "${PROJECT_ID}"`,
      'plansAuthority = "store"',
      ''
    ].join('\n'), 'utf8');
    const storeDir = resolveProjectStoreDir(PROJECT_ID);
    const handle = StoreHandle.open(storeDir);
    handle.appendEvent({
      eventType: 'project.initialized',
      actor: 'test',
      payload: { projectId: PROJECT_ID, boardTitle: 'T', workDomains: [], notesMarkdown: '', plansAuthority: 'store' }
    });
    handle.close();
    fs.writeFileSync(path.join(repoDir, 'blank.txt'), ' \n\t', 'utf8');

    let refused: any;
    try {
      execFileSync('node', [require.resolve('./mapctx-cli.js'), 'store', 'attest-orphan', ORPHAN_NODE, '--reason-file', 'blank.txt', '--json'], {
        cwd: repoDir,
        encoding: 'utf8',
        env: { ...process.env, MAPCTX_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      assert.fail('blank reason must be refused');
    } catch (error) {
      refused = error;
    }
    assert.match(String(refused.stderr), /whitespace-only/);
    assert.equal(fs.existsSync(path.join(storeDir, 'node-attestations.json')), false);
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const meta = JSON.parse(fs.readFileSync(path.join(storeDir, 'store-meta.json'), 'utf8'));
    assert.equal(meta.sequenceWatermarks[ORPHAN_NODE], undefined);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.MAPCTX_HOME;
    else process.env.MAPCTX_HOME = previousHome;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('store attest-orphan CLI end-to-end: approval, witness loss, named gap, re-confirmation, repair', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-attest-wit-e2e-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-attest-wit-home-'));
  const previousHome = process.env.MAPCTX_HOME;
  const previousCwd = process.cwd();
  process.env.MAPCTX_HOME = home;
  process.chdir(repoDir);

  try {
    fs.writeFileSync(path.join(repoDir, 'mapctx.toml'), [
      'schemaVersion = 1',
      `projectId = "${PROJECT_ID}"`,
      'plansAuthority = "store"',
      ''
    ].join('\n'), 'utf8');
    const storeDir = resolveProjectStoreDir(PROJECT_ID);
    const handle = StoreHandle.open(storeDir);
    handle.appendEvent({
      eventType: 'project.initialized',
      actor: 'test',
      payload: { projectId: PROJECT_ID, boardTitle: 'T', workDomains: [], notesMarkdown: '', plansAuthority: 'store' }
    });
    handle.appendEvent({
      eventType: 'task.upserted',
      actor: 'test',
      payload: {
        task: {
          taskId: 'T-001', positionKey: 1, title: 'task 1', planningState: 'backlog', executionState: 'unclaimed',
          tags: [], domains: [], externalLinks: [], assignees: []
        }
      }
    });
    handle.close();
    {
      const { openDatabase } = require('@mapctx/store') as typeof import('@mapctx/store');
      const payload = { taskId: 'T-001', patch: { planningState: 'in-progress', updatedOn: '2026-09-27' }, source: 'reopen' };
      const payloadJson = JSON.stringify(payload);
      const { createHash } = require('crypto') as typeof import('crypto');
      const compactHash = createHash('sha256').update(payloadJson, 'utf8').digest('hex');
      const db = openDatabase(StoreHandle.dbPathFor(storeDir));
      try {
        db.prepare(`
          INSERT INTO event_log (node_id, sequence, logical_clock, event_type, schema_version, occurred_at,
            actor, causation_json, payload_json, payload_sha256, journal_path)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(ORPHAN_NODE, 3, 3, 'task.patched', 1, '2026-09-27T18:51:48.242Z', 'traycer', '[]', payloadJson, compactHash, '');
      } finally {
        db.close();
      }
    }
    const reasonFile = path.join(repoDir, 'reason.txt');
    fs.writeFileSync(reasonFile, 'witness e2e: recovered rows only\n', 'utf8');
    const metaPath = path.join(storeDir, 'store-meta.json');
    const readMeta = () => JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    // approve -> witness + file both durable
    const draft = JSON.parse(execFileSync('node', [require.resolve('./mapctx-cli.js'), 'store', 'attest-orphan', ORPHAN_NODE, '--reason-file', 'reason.txt', '--json'], { cwd: repoDir, encoding: 'utf8', env: { ...process.env, MAPCTX_HOME: home } }));
    const approved = JSON.parse(execFileSync('node', [require.resolve('./mapctx-cli.js'), 'store', 'attest-orphan', ORPHAN_NODE, '--reason-file', 'reason.txt', '--approve-hash', draft.contentSha256, '--json'], { cwd: repoDir, encoding: 'utf8', env: { ...process.env, MAPCTX_HOME: home } }));
    assert.equal(approved.status, 'attested');
    assert.equal(readMeta().sequenceWatermarks[ORPHAN_NODE], 3);
    const originalAttestedAt = approved.attestedAt;

    // first repair ok
    assert.equal(JSON.parse(execFileSync('node', [require.resolve('./mapctx-cli.js'), 'store', 'repair', '--json'], { cwd: repoDir, encoding: 'utf8', env: { ...process.env, MAPCTX_HOME: home } })).status, 'ok');

    // witness lost (file survives): repair names the executable remedy
    const meta = readMeta();
    delete meta.sequenceWatermarks[ORPHAN_NODE];
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    let gap: any;
    try {
      execFileSync('node', [require.resolve('./mapctx-cli.js'), 'store', 'repair', '--json'], { cwd: repoDir, encoding: 'utf8', env: { ...process.env, MAPCTX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.fail('repair must refuse without witness');
    } catch (error) { gap = error; }
    assert.match(String(gap.stdout), /lacks its approval witness/);

    // draft no longer pre-refuses attested nodes; same-pin approve re-confirms
    const redraft = JSON.parse(execFileSync('node', [require.resolve('./mapctx-cli.js'), 'store', 'attest-orphan', ORPHAN_NODE, '--reason-file', 'reason.txt', '--json'], { cwd: repoDir, encoding: 'utf8', env: { ...process.env, MAPCTX_HOME: home } }));
    assert.equal(redraft.contentSha256, draft.contentSha256);
    const reconfirmed = JSON.parse(execFileSync('node', [require.resolve('./mapctx-cli.js'), 'store', 'attest-orphan', ORPHAN_NODE, '--reason-file', 'reason.txt', '--approve-hash', draft.contentSha256, '--json'], { cwd: repoDir, encoding: 'utf8', env: { ...process.env, MAPCTX_HOME: home } }));
    assert.equal(reconfirmed.status, 'attested');
    assert.equal(reconfirmed.attestedAt, originalAttestedAt, 'original approval metadata must be conserved');
    assert.equal(readMeta().sequenceWatermarks[ORPHAN_NODE], 3);

    // repair ok again; repeat stable
    assert.equal(JSON.parse(execFileSync('node', [require.resolve('./mapctx-cli.js'), 'store', 'repair', '--json'], { cwd: repoDir, encoding: 'utf8', env: { ...process.env, MAPCTX_HOME: home } })).status, 'ok');
    const reconfirmed2 = JSON.parse(execFileSync('node', [require.resolve('./mapctx-cli.js'), 'store', 'attest-orphan', ORPHAN_NODE, '--reason-file', 'reason.txt', '--approve-hash', draft.contentSha256, '--json'], { cwd: repoDir, encoding: 'utf8', env: { ...process.env, MAPCTX_HOME: home } }));
    assert.equal(reconfirmed2.attestedAt, originalAttestedAt);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.MAPCTX_HOME;
    else process.env.MAPCTX_HOME = previousHome;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
