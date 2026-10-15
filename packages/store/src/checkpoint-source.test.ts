import assert from "node:assert/strict"
import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"
import test from "node:test"
import { importCommit, recoverStoreFromCheckpoint } from "./cutover"
import { cleanupDir, setupGoldenRepo } from "./__test-helpers__"

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" })
}

/**
 * T-138 criterion 4: `recoverStoreFromCheckpoint` must actually read from Git
 * when asked to, not from the working copy under a different label. The
 * discriminating setup: delete a task block from the WORKING COPY only (git
 * HEAD still has it committed), then recover twice -- once from disk
 * (default, sees 2 tasks) and once `--from-git HEAD` (sees 3, from the
 * commit). A test that reads the same count on both paths proves nothing;
 * this is deliberately NOT realpath-normalized on the test's side -- the
 * golden fixture already lives under a symlinked tmp root on macOS
 * (/var/folders), so passing it through unmodified is what exercises the
 * confinement check's own realpath resolution.
 */
function removeT102FromWorkingCopy(repoDir: string): void {
  const tasksPath = path.join(repoDir, "TASKS.md")
  const original = fs.readFileSync(tasksPath, "utf8")
  const withoutT102 = original.replace(/### \[T-102\][\s\S]*?(?=## Notes)/, "")
  assert.notEqual(withoutT102, original, "sanity: the T-102 block must actually have been found and removed")
  fs.writeFileSync(tasksPath, withoutT102, "utf8")
}

test("recoverStoreFromCheckpoint discriminates disk vs git: disk sees a working-copy deletion, git reads the committed blob and does not", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo()
  try {
    const imported = importCommit({ cwd: repoDir, actor: "test" })
    fs.rmSync(imported.storeDir, { recursive: true, force: true })
    removeT102FromWorkingCopy(repoDir)

    const diskRecovered = recoverStoreFromCheckpoint({
      tasksFilePath: path.join(repoDir, "TASKS.md"),
      tasksRoot: repoDir,
      projectId: imported.projectId,
      storeDir: imported.storeDir,
      actor: "recovery"
    })
    assert.equal(diskRecovered.taskCount, 2, "disk must see the working-copy deletion")
    assert.equal(diskRecovered.source.kind, "disk")
    assert.equal(diskRecovered.source.ref, null)
    assert.equal(diskRecovered.source.commit, null)
    assert.match(diskRecovered.source.describedAs, /NOT necessarily committed/)

    fs.rmSync(imported.storeDir, { recursive: true, force: true })
    const gitRecovered = recoverStoreFromCheckpoint({
      tasksFilePath: path.join(repoDir, "TASKS.md"),
      tasksRoot: repoDir,
      projectId: imported.projectId,
      storeDir: imported.storeDir,
      actor: "recovery",
      source: { kind: "git", ref: "HEAD" }
    })
    assert.equal(gitRecovered.taskCount, 3, "git must read the committed blob, where T-102 still exists")
    assert.equal(gitRecovered.source.kind, "git")
    assert.equal(gitRecovered.source.ref, "HEAD")
    const expectedCommit = git(repoDir, ["rev-parse", "HEAD"]).trim()
    assert.equal(gitRecovered.source.commit, expectedCommit)
    assert.match(gitRecovered.source.describedAs, /HEAD/)
    assert.match(gitRecovered.source.describedAs, new RegExp(expectedCommit.slice(0, 12)))
  } finally {
    restoreEnv()
    cleanupDir(repoDir)
  }
})

test("recoverStoreFromCheckpoint --from-git refuses a ref that does not resolve to a commit", () => {
  const { repoDir, restoreEnv } = setupGoldenRepo()
  try {
    const imported = importCommit({ cwd: repoDir, actor: "test" })
    fs.rmSync(imported.storeDir, { recursive: true, force: true })

    assert.throws(
      () => recoverStoreFromCheckpoint({
        tasksFilePath: path.join(repoDir, "TASKS.md"),
        tasksRoot: repoDir,
        projectId: imported.projectId,
        storeDir: imported.storeDir,
        actor: "recovery",
        source: { kind: "git", ref: "not-a-real-ref-at-all" }
      }),
      /is not a commit/
    )
    assert.equal(fs.existsSync(imported.storeDir), false, "a refused recovery must not materialize a store")
  } finally {
    restoreEnv()
    cleanupDir(repoDir)
  }
})

test("MUTATION GUARD: the git source path must read the committed blob, not the working copy", () => {
  // Re-affirms the discriminator in isolation, phrased as a guard: if the
  // `git` source path were ever changed to read `options.tasksFilePath` off
  // disk (the exact bug T-128 found), this is the test that catches it --
  // the working copy is missing a task the commit still has.
  const { repoDir, restoreEnv } = setupGoldenRepo()
  try {
    const imported = importCommit({ cwd: repoDir, actor: "test" })
    fs.rmSync(imported.storeDir, { recursive: true, force: true })
    removeT102FromWorkingCopy(repoDir)

    const gitRecovered = recoverStoreFromCheckpoint({
      tasksFilePath: path.join(repoDir, "TASKS.md"),
      tasksRoot: repoDir,
      projectId: imported.projectId,
      storeDir: imported.storeDir,
      actor: "recovery",
      source: { kind: "git", ref: "HEAD" }
    })
    assert.equal(gitRecovered.taskCount, 3, "a git recovery reading disk instead of git would see only 2 (the deleted-on-disk count)")
  } finally {
    restoreEnv()
    cleanupDir(repoDir)
  }
})
