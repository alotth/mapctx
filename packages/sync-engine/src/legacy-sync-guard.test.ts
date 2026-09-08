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

// T-075 P3#6: a legacy config kept OUTSIDE the repo whose tasksFile points
// absolutely into a store-authority repository must still be refused -- the
// authority check follows the target board, not just the invocation point.
test('R13 P3#6: out-of-repo config with absolute tasksFile into a store-authority repo is refused', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-r13-target-repo-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-r13-config-home-'));
  const previousCwd = process.cwd();
  try {
    fs.writeFileSync(
      path.join(repoDir, 'mapctx.toml'),
      'schemaVersion = 1\nprojectId = "44444444-4444-4444-8444-444444444444"\nplansAuthority = "store"\n',
      'utf8'
    );
    fs.writeFileSync(path.join(repoDir, 'TASKS.md'), '# board\n', 'utf8');
    const outsideConfig = path.join(configDir, 'mapcs.config.json');
    fs.writeFileSync(outsideConfig, JSON.stringify({ ...LEGACY_CONFIG, tasksFile: path.join(repoDir, 'TASKS.md') }, null, 2), 'utf8');

    process.chdir(configDir);
    assert.throws(
      () => pullCommand({ configPath: outsideConfig }),
      /plansAuthority=store/,
      'an out-of-repo config must not bypass the guard via its absolute tasksFile'
    );
    assert.equal(fs.readFileSync(path.join(repoDir, 'TASKS.md'), 'utf8'), '# board\n', 'no write happened before the refusal');
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// T-075 review P2: --tasks-file overrides the config-declared path, so a
// markdown-authority cwd invoking pull against a store-authority repo's
// TASKS.md through the override must also be refused.
test('R13 review P2: --tasks-file override into a store-authority repo is refused from anywhere', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-r13-override-repo-'));
  const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapctx-r13-override-cwd-'));
  const previousCwd = process.cwd();
  try {
    fs.writeFileSync(
      path.join(repoDir, 'mapctx.toml'),
      'schemaVersion = 1\nprojectId = "55555555-5555-4555-8555-555555555555"\nplansAuthority = "store"\n',
      'utf8'
    );
    fs.writeFileSync(path.join(repoDir, 'TASKS.md'), '# board\n', 'utf8');
    process.chdir(cwdDir);
    assert.throws(
      () => pullCommand({ tasksFileOverride: path.join(repoDir, 'TASKS.md') }),
      /plansAuthority=store/,
      'the override must be authority-checked exactly like the config-declared tasksFile'
    );
    assert.equal(fs.readFileSync(path.join(repoDir, 'TASKS.md'), 'utf8'), '# board\n');
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(cwdDir, { recursive: true, force: true });
  }
});
