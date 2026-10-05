import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import {
  buildExport,
  checkTaskAcceptance,
  createTask,
  listExportCheckpoints,
  moveTask,
  StoreHandle,
  approveAcceptanceCriterion,
  reviseAcceptance,
  upsertProject
} from '@mapctx/store';
import { generateTaskDetailFile, parseAcceptanceChecklist, parseTaskDetailFile } from '@mapctx/core';
import { finishTask, publishCheckpoint, sha256Hex } from './checkpoint';

const PROJECT_ID = '00000000-0000-0000-0000-0000000000c1';

type Fixture = {
  repoDir: string;
  storeDir: string;
  handle: StoreHandle;
  taskId: string;
  exportAndWrite: () => void;
  close: () => void;
};

function openFixture(taskStatus: string): Fixture {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-checkpoint-repo-'));
  const mapctxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-checkpoint-home-'));
  const previousHome = process.env.MAPCTX_HOME;
  process.env.MAPCTX_HOME = mapctxHome;
  const storeDir = path.join(mapctxHome, 'projects', PROJECT_ID);
  fs.writeFileSync(path.join(repoDir, 'mapctx.toml'), [
    'schemaVersion = 1',
    `projectId = "${PROJECT_ID}"`,
    'plansAuthority = "store"',
    ''
  ].join('\n'), 'utf8');
  const handle = StoreHandle.open(storeDir);
  upsertProject(handle.db, {
    projectId: PROJECT_ID,
    boardTitle: 'Checkpoint fixture',
    workDomains: [{ key: 'CORE', description: 'core' }],
    notesMarkdown: '',
    plansAuthority: 'store',
    sourceSnapshotHash: null
  });
  const created = createTask(handle, { id: 'T-001', title: 'Checkpoint task', actor: 'test', status: taskStatus, workload: 'Normal' });
  assert.equal(created.ok, true);
  const taskId = created.ok ? created.taskId : 'T-001';
  const exportAndWrite = () => {
    const exported = buildExport(handle.db, { tasksRoot: repoDir });
    fs.mkdirSync(path.join(repoDir, 'tasks'), { recursive: true });
    fs.writeFileSync(exported.tasksMd.path, exported.tasksMd.content, 'utf8');
    for (const file of exported.taskDetailFiles) fs.writeFileSync(file.path, file.content, 'utf8');
  };
  exportAndWrite();
  return {
    repoDir,
    storeDir,
    handle,
    taskId,
    exportAndWrite,
    close: () => {
      handle.close();
      if (previousHome === undefined) delete process.env.MAPCTX_HOME;
      else process.env.MAPCTX_HOME = previousHome;
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(mapctxHome, { recursive: true, force: true });
    }
  };
}

function hashTree(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else hashes[path.relative(root, absolute)] = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    }
  };
  visit(root);
  return hashes;
}

function checkpointStoreFacts(handle: StoreHandle): { meta: unknown[]; eventCount: number; checkpointCount: number } {
  return {
    meta: handle.db.prepare('SELECT key, value_json FROM store_meta ORDER BY key').all(),
    eventCount: (handle.db.prepare('SELECT COUNT(*) AS count FROM event_log').get() as { count: number }).count,
    checkpointCount: (handle.db.prepare('SELECT COUNT(*) AS count FROM export_checkpoint').get() as { count: number }).count
  };
}

const FENCED_PROSE = [
  '## Design',
  '',
  'KEEP THIS DESIGN PARAGRAPH.',
  '',
  'Example syntax:',
  '```markdown',
  '## Acceptance',
  '- [x] Example ONLY',
  '```',
  '',
  '## Acceptance',
  '- [ ] Canonical actual criterion',
  '',
  '## Notes',
  'KEEP NOTES.'
].join('\n');

test('export strips only the real Acceptance section: fenced Git-authored prose survives byte-for-byte', () => {
  const fixture = openFixture('review');
  try {
    const detailPath = path.join(fixture.repoDir, 'tasks', 'T-001.md');
    const detail = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8'));
    fs.writeFileSync(detailPath, generateTaskDetailFile({ ...detail, description: FENCED_PROSE }), 'utf8');
    // The parser agrees with itself: only the real section is a checklist.
    const observed = parseAcceptanceChecklist(fs.readFileSync(detailPath, 'utf8'));
    assert.deepEqual(observed.items, [{ text: 'Canonical actual criterion', completed: false }]);

    const revised = reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: 'criteria', texts: ['Canonical actual criterion'], actor: 'author', expectRevision: 0 });
    assert.equal(revised.ok, true);

    const exported = buildExport(fixture.handle.db, { tasksRoot: fixture.repoDir });
    const detailFile = exported.taskDetailFiles.find(file => file.path === detailPath)!;
    assert.ok(detailFile.content.includes('KEEP THIS DESIGN PARAGRAPH'), 'design prose must survive export');
    assert.ok(detailFile.content.includes('Example ONLY'), 'fenced Acceptance-like example must survive export');
    assert.ok(detailFile.content.includes('KEEP NOTES'), 'sibling sections must survive export');
    const after = parseAcceptanceChecklist(detailFile.content);
    assert.deepEqual(after.items, [{ text: 'Canonical actual criterion', completed: false }], 'exactly the canonical checklist remains parseable');

    // Replay/determinism: same DB + same prose bytes -> byte-identical export.
    const second = buildExport(fixture.handle.db, { tasksRoot: fixture.repoDir });
    assert.equal(second.taskDetailFiles.find(file => file.path === detailPath)!.content, detailFile.content);

    // Checkpoint publishes the same bytes and pins their hashes.
    const published = publishCheckpoint(fixture.handle, fixture.repoDir, { reason: 'manual', actor: 'test' });
    assert.ok(published.ok, JSON.stringify(published));
    assert.deepEqual(fs.readFileSync(detailPath, 'utf8'), detailFile.content, 'checkpoint writes exactly the built bytes');
    const checkpoints = listExportCheckpoints(fixture.handle.db);
    const checkpoint = checkpoints[checkpoints.length - 1]!;
    assert.equal(checkpoint.filesHash[path.relative(fixture.repoDir, detailPath)], sha256Hex(detailFile.content));
  } finally {
    fixture.close();
  }
});

test('T-121 public export CLI refuses both trailing-evidence reassociation repros before publication', () => {
  const repros = [
    {
      name: 'reordered B,A criteria',
      canonical: ['B.', 'A.'],
      authored: '## Acceptance\n- [x] A.\n- [x] B.\nEvidence for B: docs/B.md'
    },
    {
      name: 'added B criterion',
      canonical: ['A.', 'B.'],
      authored: '## Acceptance\n- [x] A.\nEvidence for A: docs/A.md'
    }
  ];

  for (const repro of repros) {
    const fixture = openFixture('review');
    try {
      assert.equal(reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: 'criteria', texts: repro.canonical, actor: 'author', expectRevision: 0 }).ok, true, repro.name);
      fixture.exportAndWrite();
      const detailPath = path.join(fixture.repoDir, 'tasks', `${fixture.taskId}.md`);
      const parsed = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8'));
      fs.writeFileSync(detailPath, generateTaskDetailFile({ ...parsed, description: repro.authored }), 'utf8');

      const filesBefore = hashTree(fixture.repoDir);
      const storeBefore = checkpointStoreFacts(fixture.handle);
      const cliPath = path.resolve(__dirname, 'mapctx-cli.js');
      const run = spawnSync(process.execPath, [cliPath, 'export', '--reason', 'manual', '--json'], {
        cwd: fixture.repoDir,
        env: process.env,
        encoding: 'utf8'
      });

      assert.notEqual(run.status, 0, `${repro.name}: public export must refuse`);
      const result = JSON.parse(run.stdout) as { ok: boolean; stage?: string; error?: string; publishedFiles?: string[] };
      assert.equal(result.ok, false, `${repro.name}: ${run.stdout}`);
      assert.equal(result.stage, 'build', `${repro.name}: refusal must precede publication`);
      assert.match(result.error ?? '', /acceptance-render-refused/);
      assert.deepEqual(result.publishedFiles, [], `${repro.name}: no files reported as published`);
      assert.deepEqual(hashTree(fixture.repoDir), filesBefore, `${repro.name}: task files and metadata unchanged`);
      assert.deepEqual(checkpointStoreFacts(fixture.handle), storeBefore, `${repro.name}: no events, checkpoint, clock, or store metadata drift`);
    } finally {
      fixture.close();
    }
  }
});

test('finish refuses a task-end checkpoint when acceptance is revised in the gate-to-publication gap', () => {
  const fixture = openFixture('review');
  try {
    const revised = reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: 'criteria', texts: ['Race criterion'], actor: 'author', expectRevision: 0 });
    assert.equal(revised.ok, true);
    const approved = approveAcceptanceCriterion(fixture.handle, { taskId: fixture.taskId, index: 0, expectRevision: 1, actor: 'reviewer' });
    assert.equal(approved.ok, true);
    // The move itself happens (and passes its gate) in its own transaction;
    // the race window is between that and the publication transaction.
    assert.equal(moveTask(fixture.handle, { taskId: fixture.taskId, to: 'done', actor: 'finisher' }).ok, true);

    const originalTx = fixture.handle.runInWriteTransaction.bind(fixture.handle);
    let injected = false;
    (fixture.handle as unknown as { runInWriteTransaction: typeof fixture.handle.runInWriteTransaction }).runInWriteTransaction = (fn) => {
      if (!injected) {
        injected = true;
        // Another writer revises between the gate/move transaction and the
        // publication transaction -- the exact race from review F6/R7.
        const second = StoreHandle.open(fixture.storeDir);
        try {
          const gap = reviseAcceptance(second, { taskId: fixture.taskId, condition: 'criteria', texts: ['Gap pending criterion'], expectRevision: 1, actor: 'other-writer' });
          assert.equal(gap.ok, true);
        } finally {
          second.close();
        }
      }
      return originalTx(fn);
    };

    const result = finishTask(fixture.handle, fixture.repoDir, { taskId: fixture.taskId, actor: 'finisher' });
    assert.equal(result.ok, false, 'a pending gap revision must refuse the task-end checkpoint');
    if (result.ok) return;
    assert.equal(result.stage, 'checkpoint');
    if (result.stage === 'checkpoint') {
      assert.equal(result.checkpoint.stage, 'precondition', JSON.stringify(result.checkpoint));
      assert.match(result.checkpoint.error, /revised in a concurrent gap/);
      assert.deepEqual(result.checkpoint.publishedFiles, [], 'precondition refuses before any filesystem write');
      assert.equal(result.move.performed, false, 'the done move happened before the race window; finish retries only the checkpoint');
    }
    assert.equal(listExportCheckpoints(fixture.handle.db).length, 0, 'no false checkpoint is recorded');
    assert.equal(checkTaskAcceptance(fixture.handle.db, fixture.taskId).ok, false, 'criteria are pending again');
    assert.equal((fixture.handle.db.prepare("SELECT planning_state FROM task_projection WHERE task_id = ?").get(fixture.taskId) as { planning_state: string }).planning_state, 'done', 'the canonical done mutation remains durable');
    assert.ok(!fs.readdirSync(fixture.repoDir).some(entry => entry.endsWith('.mapctx-tmp')), 'no temp files leak');

    // Recovery: re-approve explicitly, then the retry publishes under the
    // same lock without repeating the move.
    const reApproved = approveAcceptanceCriterion(fixture.handle, { taskId: fixture.taskId, index: 0, expectRevision: 2, actor: 'reviewer' });
    assert.equal(reApproved.ok, true);
    const retry = finishTask(fixture.handle, fixture.repoDir, { taskId: fixture.taskId, actor: 'finisher' });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    if (retry.ok) {
      assert.equal(retry.move.performed, false);
      assert.equal(retry.checkpoint.reason, 'task-end');
    }
    assert.equal(listExportCheckpoints(fixture.handle.db).length, 1);
  } finally {
    fixture.close();
  }
});

test('finish refuses a task-end checkpoint when the task is reopened in the gap', () => {
  const fixture = openFixture('review');
  try {
    const revised = reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: 'criteria', texts: ['Reopen criterion'], actor: 'author', expectRevision: 0 });
    assert.equal(revised.ok, true);
    assert.equal(approveAcceptanceCriterion(fixture.handle, { taskId: fixture.taskId, index: 0, expectRevision: 1, actor: 'reviewer' }).ok, true);
    assert.equal(moveTask(fixture.handle, { taskId: fixture.taskId, to: 'done', actor: 'finisher' }).ok, true);

    const originalTx = fixture.handle.runInWriteTransaction.bind(fixture.handle);
    let injected = false;
    (fixture.handle as unknown as { runInWriteTransaction: typeof fixture.handle.runInWriteTransaction }).runInWriteTransaction = (fn) => {
      if (!injected) {
        injected = true;
        fixture.handle.appendEvent({ eventType: 'task.patched', actor: 'gap-writer', payload: { taskId: fixture.taskId, patch: { planningState: 'review' } } });
      }
      return originalTx(fn);
    };

    const result = finishTask(fixture.handle, fixture.repoDir, { taskId: fixture.taskId, actor: 'finisher' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.stage, 'checkpoint');
    if (result.stage === 'checkpoint') {
      assert.equal(result.checkpoint.stage, 'precondition');
      assert.match(result.checkpoint.error, /reopened or moved/);
    }
    assert.equal(listExportCheckpoints(fixture.handle.db).length, 0);
  } finally {
    fixture.close();
  }
});

test('finish retry with pending acceptance classifies at the move stage; manual export never requires done', () => {
  const fixture = openFixture('review');
  try {
    const revised = reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: 'criteria', texts: ['Retry criterion'], actor: 'author', expectRevision: 0 });
    assert.equal(revised.ok, true);
    assert.equal(approveAcceptanceCriterion(fixture.handle, { taskId: fixture.taskId, index: 0, expectRevision: 1, actor: 'reviewer' }).ok, true);

    const first = finishTask(fixture.handle, fixture.repoDir, { taskId: fixture.taskId, actor: 'finisher' });
    assert.equal(first.ok, true);

    // A later revision makes acceptance pending: the retry's gate classifies
    // at the move stage -- finish never publishes over pending criteria.
    assert.equal(reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: 'criteria', texts: ['Pending again'], expectRevision: 1, actor: 'author' }).ok, true);
    const retry = finishTask(fixture.handle, fixture.repoDir, { taskId: fixture.taskId, actor: 'finisher' });
    assert.equal(retry.ok, false);
    if (!retry.ok && retry.stage === 'move') assert.equal(retry.move.reason, 'acceptance-incomplete');

    // The checkpoints from the successful finish stay durable and manual
    // export keeps working on a board with non-done tasks.
    assert.ok(listExportCheckpoints(fixture.handle.db).length >= 1);
    const manual = publishCheckpoint(fixture.handle, fixture.repoDir, { reason: 'manual', actor: 'test' });
    assert.ok(manual.ok, 'manual export must not require every task to be done');
  } finally {
    fixture.close();
  }
});

const BT3 = '```';
const BT4 = '````';

test('N1: tilde and four-backtick fenced prose survives checkpoints byte-for-byte; inline spans never grow the mirror', () => {
  const cases: Array<[string, string]> = [
    ['tilde', 'Intro\n~~~md\n## Acceptance\n- [ ] tilde example\n~~~\nKEEP TILDE TAIL.\n\n## Acceptance\n- [ ] Canonical actual criterion'],
    ['fourBacktick', 'Intro\n' + BT4 + 'md\n' + BT3 + '\n## Acceptance\n' + BT3 + '\n' + BT4 + '\nKEEP FOUR TAIL.\n\n## Acceptance\n- [ ] Canonical actual criterion'],
    ['inlineSpan', 'Use it like:\n' + BT3 + 'npm test' + BT3 + '\nKEEP AFTER INLINE.\n\n## Acceptance\n- [ ] Canonical actual criterion']
  ];
  for (const [name, prose] of cases) {
    const fixture = openFixture('review');
    try {
      const detailPath = path.join(fixture.repoDir, 'tasks', 'T-001.md');
      const detail = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8'));
      fs.writeFileSync(detailPath, generateTaskDetailFile({ ...detail, description: prose }), 'utf8');
      const revised = reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: 'criteria', texts: ['Canonical actual criterion'], actor: 'author', expectRevision: 0 });
      assert.equal(revised.ok, true);
      const sizes: number[] = [];
      const hashes: string[] = [];
      for (let i = 0; i < 4; i++) {
        const published = publishCheckpoint(fixture.handle, fixture.repoDir, { reason: 'manual', actor: 'test' });
        assert.ok(published.ok, name + ' export ' + i + ': ' + JSON.stringify(published));
        sizes.push(fs.statSync(detailPath).size);
        hashes.push(sha256Hex(fs.readFileSync(detailPath, 'utf8')));
      }
      assert.equal(new Set(hashes).size, 1, name + ': four exports are byte-identical (no growth)');
      const finalProse = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8')).description;
      assert.ok(finalProse.includes('Canonical actual criterion'), name + ': canonical section present');
      if (name === 'tilde') assert.ok(finalProse.includes('KEEP TILDE TAIL.') && finalProse.includes('tilde example'));
      if (name === 'fourBacktick') assert.ok(finalProse.includes('KEEP FOUR TAIL.'));
      if (name === 'inlineSpan') assert.ok(finalProse.includes('KEEP AFTER INLINE.'));
      assert.equal((finalProse.match(/mapctx:store-owned acceptance revision/g) || []).length, 1, name + ': exactly one generated section');
    } finally {
      fixture.close();
    }
  }
});

test('N1: unterminated fence with canonical Acceptance refuses export BEFORE any write, consistently, with zero growth', () => {
  const fixture = openFixture('review');
  try {
    const detailPath = path.join(fixture.repoDir, 'tasks', 'T-001.md');
    const detail = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8'));
    const prose = 'Intro\n' + BT3 + 'md\nunclosed example\n\n## Acceptance\n- [ ] Canonical actual criterion\n\n## Notes\nKEEP NOTES.';
    fs.writeFileSync(detailPath, generateTaskDetailFile({ ...detail, description: prose }), 'utf8');
    assert.equal(reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: 'criteria', texts: ['Canonical actual criterion'], actor: 'author', expectRevision: 0 }).ok, true);
    const originalBytes = fs.readFileSync(detailPath);
    const checkpointsBefore = listExportCheckpoints(fixture.handle.db).length;

    for (let i = 0; i < 4; i++) {
      const refused = publishCheckpoint(fixture.handle, fixture.repoDir, { reason: 'manual', actor: 'test' });
      assert.equal(refused.ok, false, 'refusal ' + i);
      if (!refused.ok) {
        assert.equal(refused.stage, 'build', 'refusal happens while building, before any publication');
        assert.match(refused.error, /acceptance-render-refused/);
        assert.match(refused.error, /unterminated|never closed|no safe insertion/i);
        assert.deepEqual(refused.publishedFiles, []);
      }
      assert.deepEqual(fs.readFileSync(detailPath), originalBytes, 'prose bytes untouched by the refusal');
      assert.equal(listExportCheckpoints(fixture.handle.db).length, checkpointsBefore, 'no checkpoint is recorded');
      assert.ok(!fs.readdirSync(fixture.repoDir).some(entry => entry.endsWith('.mapctx-tmp')));
    }

    // Once the fence is closed, the same store exports cleanly.
    const fixedProse = 'Intro\n' + BT3 + 'md\nunclosed example\n' + BT3 + '\nKEEP NOTES.\n\n## Acceptance\n- [ ] Canonical actual criterion';
    fs.writeFileSync(detailPath, generateTaskDetailFile({ ...detail, description: fixedProse }), 'utf8');
    const ok = publishCheckpoint(fixture.handle, fixture.repoDir, { reason: 'manual', actor: 'test' });
    assert.ok(ok.ok, JSON.stringify(ok));
    const finalProse = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8')).description;
    assert.ok(finalProse.includes('KEEP NOTES.'));
    assert.ok(finalProse.includes('Canonical actual criterion'));
  } finally {
    fixture.close();
  }
});

test('N1: unterminated fence prose without canonical revisioning exports untouched; validate --snapshots reports refusal honestly', () => {
  const fixture = openFixture('review');
  try {
    const detailPath = path.join(fixture.repoDir, 'tasks', 'T-001.md');
    const detail = parseTaskDetailFile(fs.readFileSync(detailPath, 'utf8'));
    const prose = 'Intro\n' + BT3 + 'md\nunclosed, never revised\nKEEP.';
    fs.writeFileSync(detailPath, generateTaskDetailFile({ ...detail, description: prose }), 'utf8');
    const before = fs.readFileSync(detailPath);
    const published = publishCheckpoint(fixture.handle, fixture.repoDir, { reason: 'manual', actor: 'test' });
    assert.ok(published.ok, 'no canonical revision -> nothing to render -> no refusal');
    assert.deepEqual(fs.readFileSync(detailPath), before, 'pre-adoption prose stays byte-compatible');

    // With canonical revisioning, the explicit snapshot check reports the
    // refusal as a drift issue instead of crashing.
    assert.equal(reviseAcceptance(fixture.handle, { taskId: fixture.taskId, condition: 'criteria', texts: ['Now canonical'], actor: 'author', expectRevision: 0 }).ok, true);
    const report = checkDriftReport(fixture);
    assert.equal(report.hasDrift, true);
    assert.ok(report.issues.some(issue => issue.reason.includes('acceptance-render-refused')), JSON.stringify(report.issues));
  } finally {
    fixture.close();
  }
});

function checkDriftReport(fixture: Fixture): { hasDrift: boolean; issues: Array<{ taskId: string; file: string; reason: string }> } {
  // Imported through the store barrel to keep this file's imports small.
  const { checkDrift } = require('@mapctx/store') as { checkDrift: (db: Fixture['handle']['db'], tasksRoot: string) => { hasDrift: boolean; issues: Array<{ taskId: string; file: string; reason: string }> } };
  return checkDrift(fixture.handle.db, fixture.repoDir);
}
