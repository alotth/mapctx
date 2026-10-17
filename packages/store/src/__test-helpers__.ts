import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"
import { GOLDEN_FILES, GOLDEN_LEGACY_CONFIG } from "./__test-fixtures__"

export function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/**
 * Materializes the golden fixture board as a real git repo (import --commit
 * needs git status/add/commit to work against real paths), with a fresh
 * MAPCTX_HOME so tests never touch the developer's real ~/.mapctx.
 *
 * `restoreEnv` undoes BOTH halves of that isolation: the environment variable
 * and the directory it pointed at (T-169). The directory was the leak. Every
 * store test paired this helper with `restoreEnv` in a `finally` and then
 * cleaned only `repoDir`, so each materialized store -- database, journal and
 * its backups -- stayed in `os.tmpdir()` for good. One full `npm test`
 * measured 191 abandoned homes; a Linux host had accumulated 8030 of them,
 * ~3 GB of a 5.8 GB tmpfs, and an agent hit ENOSPC mid-run.
 *
 * Teardown belongs here and not at the ~20 call sites for the reason the leak
 * happened in the first place: a caller that has to remember two cleanups
 * eventually remembers one. (The sync-engine CLI fixtures already call
 * `cleanupDir(f.mapctxHome)` themselves; that stays correct and harmless,
 * because removing an absent path is a no-op.)
 */
export function setupGoldenRepo(): { repoDir: string; mapctxHome: string; restoreEnv: () => void } {
  const repoDir = mkTmpDir("mapctx-store-test-repo-");
  fs.mkdirSync(path.join(repoDir, "tasks"), { recursive: true });
  for (const [relPath, content] of Object.entries(GOLDEN_FILES)) {
    fs.writeFileSync(path.join(repoDir, relPath), content, "utf8");
  }
  fs.writeFileSync(path.join(repoDir, "mapcs.config.json"), `${JSON.stringify(GOLDEN_LEGACY_CONFIG, null, 2)}\n`, "utf8");

  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "-m", "initial board"]);

  const mapctxHome = mkTmpDir("mapctx-store-test-home-");
  const previous = process.env.MAPCTX_HOME;
  process.env.MAPCTX_HOME = mapctxHome;

  return {
    repoDir,
    mapctxHome,
    restoreEnv: () => {
      if (previous === undefined) delete process.env.MAPCTX_HOME;
      else process.env.MAPCTX_HOME = previous;
      // The env var is restored FIRST: after this line nothing can resolve a
      // store inside the directory about to be removed, so a test that keeps
      // reading backups after teardown fails loudly against the restored home
      // instead of reading half-deleted files.
      cleanupDir(mapctxHome);
    }
  };
}

export function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
