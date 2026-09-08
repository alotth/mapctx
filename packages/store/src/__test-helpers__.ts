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
    }
  };
}

export function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
