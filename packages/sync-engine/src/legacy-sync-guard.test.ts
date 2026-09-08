import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import { assertLegacySyncWriterAllowed } from './legacy-sync-guard';
import { bootstrapCommand, pullCommand, pushCommand, reconcileCommand } from './sync';

const LEGACY_CONFIG = {
  owner: 'octocat',
  repo: 'r13-guard-test',
  projectId: 'PVT_r13',
  statusFieldId: 'PVTSSF_r13',
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

function setupStoreAuthorityRepo(): { repoDir: string; restore: () => void } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-r13-guard-'));
  fs.writeFileSync(
    path.join(repoDir, 'mapctx.toml'),
    'schemaVersion = 1\nprojectId = "11111111-1111-4111-8111-111111111111"\nplansAuthority = "store"\n',
    'utf8'
  );
  fs.writeFileSync(path.join(repoDir, 'mapcs.config.json'), `${JSON.stringify(LEGACY_CONFIG, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(repoDir, 'TASKS.md'), '# board\n', 'utf8');

  const previousCwd = process.cwd();
  process.chdir(repoDir);
  return {
    repoDir,
    restore: () => {
      process.chdir(previousCwd);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  };
}

test('R13: legacy sync mutation commands fail closed under store authority, before any write or API call', () => {
  const { restore } = setupStoreAuthorityRepo();
  try {
    const legacyConfig = path.resolve(process.cwd(), 'mapcs.config.json');
    const expected = /plansAuthority=store/;

    assert.throws(() => pullCommand({ configPath: legacyConfig }), expected, 'pull must refuse under store authority');
    assert.throws(() => pushCommand({ configPath: legacyConfig }), expected, 'push must refuse under store authority');
    assert.throws(() => bootstrapCommand('local', { configPath: legacyConfig }), expected, 'bootstrap must refuse under store authority');
    assert.throws(() => reconcileCommand('T-001', { configPath: legacyConfig, accept: 'local' }), expected, 'reconcile must refuse under store authority');

    // Refusal happens before any Markdown or sync-state write.
    assert.equal(fs.readFileSync(path.join(process.cwd(), 'TASKS.md'), 'utf8'), '# board\n');
    assert.equal(fs.existsSync(path.join(process.cwd(), '.mapcs')), false, 'no sync-state directory may appear');
  } finally {
    restore();
  }
});

test('R13: the guard only triggers on store authority; markdown authority stays a legacy-writer regime', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-r13-open-'));
  const previousCwd = process.cwd();
  try {
    // No mapctx.toml anywhere: legacy sync is the legitimate writer regime.
    process.chdir(tmp);
    assert.doesNotThrow(() => assertLegacySyncWriterAllowed('pull'));

    // Markdown authority declared explicitly: still legacy-writer territory.
    fs.writeFileSync(
      path.join(tmp, 'mapctx.toml'),
      'schemaVersion = 1\nprojectId = "22222222-2222-4222-8222-222222222222"\nplansAuthority = "markdown"\n',
      'utf8'
    );
    assert.doesNotThrow(() => assertLegacySyncWriterAllowed('push'));
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
