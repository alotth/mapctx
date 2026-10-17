import assert from "node:assert/strict"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import test from "node:test"
import { importCommit } from "./cutover"
import { resolveProjectStoreDir } from "./config"
import { backupsRootFor, createBackup } from "./backup"
import { cleanupDir, setupGoldenRepo } from "./__test-helpers__"

// T-169: `setupGoldenRepo` materializes a whole store -- database, journal,
// backups -- inside a fresh MAPCTX_HOME. `restoreEnv` used to put the env var
// back and leave that directory, so every store test leaked its store into
// os.tmpdir() for good (191 abandoned homes measured in one run). This file
// is the helper's own hygiene test, not a backup test, so it lives apart from
// backup.test.ts.

test("MUTATION GUARD: setupGoldenRepo's restoreEnv removes the populated MAPCTX_HOME it created, not just the env var", () => {
  const previousEnv = process.env.MAPCTX_HOME
  const fixture = setupGoldenRepo()
  try {
    // Populate BOTH halves of what a real test run leaves behind -- the
    // store directory itself and its backups root -- so a shallow or
    // non-recursive remove of just one of them would still fail this test.
    const imported = importCommit({ cwd: fixture.repoDir, actor: "test" })
    const storeDir = resolveProjectStoreDir(imported.projectId)
    createBackup({ storeDir, projectId: imported.projectId, reason: "pre-repair" })

    assert.ok(fs.existsSync(storeDir), "sanity: the store must exist before teardown")
    assert.ok(fs.existsSync(backupsRootFor(imported.projectId)), "sanity: the backups root must exist before teardown")

    fixture.restoreEnv()

    // MUTATION GUARD: this is the assertion the T-169 fix exists for. Pointing
    // `cleanupDir` at a path that is not `mapctxHome` (the mutation below)
    // leaves this directory on disk and turns this assertion red.
    assert.equal(fs.existsSync(fixture.mapctxHome), false, "restoreEnv must remove the MAPCTX_HOME directory it created")
    assert.ok(
      path.resolve(fixture.mapctxHome).startsWith(path.resolve(os.tmpdir())),
      "sanity: the home being checked must actually be one of the helper's own tmpdir homes"
    )
    assert.equal(process.env.MAPCTX_HOME, previousEnv, "restoreEnv must also put the env var back exactly as it was (including undefined)")
  } finally {
    cleanupDir(fixture.repoDir) // the home is already gone (or was meant to be)
  }
})

test("the store test helper leaves none of its own temporary homes in os.tmpdir()", () => {
  const previousEnv = process.env.MAPCTX_HOME
  const fixtures = [setupGoldenRepo(), setupGoldenRepo(), setupGoldenRepo()]
  const homes = fixtures.map(f => f.mapctxHome)
  try {
    // Teardown is LIFO, because each setup saved the env var as it found it:
    // fixture[1] remembers fixture[0]'s home. Restoring in creation order
    // would leave MAPCTX_HOME pointing at a home that has just been removed,
    // which is a trap for whatever test runs next in this process.
    for (const fixture of [...fixtures].reverse()) fixture.restoreEnv()
    assert.equal(process.env.MAPCTX_HOME, previousEnv, "nested fixtures torn down in reverse must leave the env exactly as it was")

    for (const home of homes) {
      assert.equal(fs.existsSync(home), false, `restoreEnv must remove ${home}`)
    }

    // Idempotency: the sync-engine CLI fixtures call restoreEnv() and then
    // cleanupDir(mapctxHome) themselves on top of it. A second teardown of
    // an already-removed directory must stay a no-op, not throw.
    assert.doesNotThrow(() => fixtures[0].restoreEnv())
  } finally {
    for (const fixture of fixtures) cleanupDir(fixture.repoDir)
  }
})
