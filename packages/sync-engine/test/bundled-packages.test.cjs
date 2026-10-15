const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// T-164: the packing scripts live at the repo root, outside any workspace,
// and are plain ESM. A .cjs test keeps the path to them stable -- a compiled
// src/*.test.ts would sit one directory deeper in dist/ and resolve this
// relative path differently from its source.
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'prepare-sync-engine-bundled-core.mjs');
const packageJsonPath = path.join(repoRoot, 'packages', 'sync-engine', 'package.json');
const loadScript = () => import(scriptPath);

test('T-164: prepack and postpack read ONE list -- every path the bundler creates is a path the cleaner removes', async () => {
  const { bundledPaths, bundledNames, vendoredRuntime, syncEngineDir } = await loadScript();

  // The bundler writes @mapctx/<name> and <vendored> under the sync-engine's
  // own node_modules; bundledPaths is what the cleaner walks. Equality of the
  // two sets is the single-source property, so a sixth bundled package cannot
  // be added without the cleaner learning about it.
  const expected = [
    ...bundledNames.map(name => path.join(syncEngineDir, 'node_modules', '@mapctx', name)),
    ...vendoredRuntime.map(name => path.join(syncEngineDir, 'node_modules', name))
  ].sort();
  assert.deepEqual([...bundledPaths()].sort(), expected);
  assert.ok(bundledNames.length >= 5, `expected the five workspace packages, got ${JSON.stringify(bundledNames)}`);

  // The narrower build-time scope drops the third-party copies and keeps
  // every workspace copy, which are the ones that shadow a live build.
  const workspaceOnly = bundledPaths({ includeVendored: false });
  assert.deepEqual(
    [...workspaceOnly].sort(),
    bundledNames.map(name => path.join(syncEngineDir, 'node_modules', '@mapctx', name)).sort()
  );
});

test('T-164: postpack runs the shared cleaner, so no hand-maintained package list survives in the scripts', async () => {
  const scripts = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).scripts;
  // The bug: `postpack: rm -rf node_modules/@mapctx/core` removed one of the
  // eight directories prepack creates. Any script that names a single package
  // by hand is that bug returning, whatever it is spelled like.
  for (const name of ['postpack', 'build', 'bundle:clean']) {
    assert.doesNotMatch(
      scripts[name],
      /node_modules\/@mapctx\/[a-z]/,
      `${name} must delegate to the shared cleaner instead of naming a package: ${scripts[name]}`
    );
  }
  assert.match(scripts.postpack, /bundle:clean/);
  assert.match(scripts['bundle:clean'], /prepare-sync-engine-bundled-core\.mjs --clean$/);
});

test('T-164: the cleaner removes every bundled directory and prunes the tree back to a fresh-install shape', async t => {
  const { cleanSyncEngineBundles, bundledPaths, syncEngineDir } = await loadScript();
  const nodeModules = path.join(syncEngineDir, 'node_modules');
  // A fresh `npm ci` leaves the sync-engine with no node_modules of its own
  // (everything hoists to the root), so this test only runs on that shape --
  // it must never delete a real install, and it creates nothing it does not
  // then remove.
  if (fs.existsSync(nodeModules)) {
    t.skip('packages/sync-engine/node_modules exists; refusing to touch a populated install');
    return;
  }

  for (const dir of bundledPaths()) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fake"}\n');
  }
  const removed = cleanSyncEngineBundles();

  assert.equal(removed.length, bundledPaths().length, `expected every fake bundle removed, got ${JSON.stringify(removed)}`);
  for (const dir of bundledPaths()) assert.equal(fs.existsSync(dir), false, `${dir} survived the cleaner`);
  assert.equal(fs.existsSync(nodeModules), false, 'the emptied node_modules directory is pruned, matching a fresh install');
});
