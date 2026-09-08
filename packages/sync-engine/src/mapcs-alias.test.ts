import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as path from 'path';
import test from 'node:test';

const cliPath = path.join(__dirname, 'cli.js');

function runAlias(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('mapcs alias still executes commands but prints a deprecation notice on stderr', () => {
  const result = runAlias(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /`mapcs` is deprecated/);
  assert.match(result.stderr, /`mapctx`/);
  assert.match(result.stderr, /migration-mapcs-to-mapctx/);
  assert.match(result.stdout, /mapcs CLI/);
});

test('mapcs alias deprecation notice goes to stderr, never stdout', () => {
  const result = runAlias(['validate', '--help']);
  assert.equal(result.status, 0);
  assert.ok(!result.stdout.includes('deprecated'));
  assert.match(result.stderr, /deprecated/);
});
