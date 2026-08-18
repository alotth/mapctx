import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"
import {
  findMapctxToml,
  resolveProjectStoreDir,
  writeMapctxToml,
  type GithubBinding,
  type MapctxTomlConfig
} from "./config"
import { buildExport } from "./export"
import { planImport, type ImportPlan } from "./import"
import { StoreHandle } from "./store-handle"
import type { ProjectMetadata } from "./types"

export type LegacySyncConfig = {
  owner: string;
  repo: string;
  projectId?: string;
  statusFieldId?: string;
  startDateFieldId?: string;
  dueDateFieldId?: string;
  completedDateFieldId?: string;
  statusMap?: Record<string, string>;
  tasksFile?: string;
};

export type ImportDryRunOptions = {
  tasksFilePath: string;
};

export type ImportDryRunResult = {
  plan: ImportPlan;
  wouldCommit: boolean;
};

export function importDryRun(options: ImportDryRunOptions): ImportDryRunResult {
  const plan = planImport(options.tasksFilePath);
  return { plan, wouldCommit: plan.errors === 0 };
}

export type RecoverStoreOptions = {
  tasksFilePath: string;
  tasksRoot: string;
  projectId: string;
  storeDir: string;
  actor: string;
  now?: () => Date;
};

export type RecoverStoreResult = {
  projectId: string;
  storeDir: string;
  nodeId: string;
  incarnationId: string;
  taskCount: number;
};

/**
 * ADR 0003 "Durability and rollback" corruption tier 3: losing the entire
 * `~/.mapctx/projects/<id>/` directory recovers only back to the last
 * git-committed Markdown checkpoint -- which, under plansAuthority: store,
 * is exactly the current TASKS.md/tasks/*.md on disk (the last thing
 * `mapctx export` wrote). This materializes a fresh store (new node +
 * incarnation, same projectId, per "State locality") and reimports that
 * checkpoint as its first event, so history strictly older than it is
 * permanently gone -- callers must say so, this function does not.
 */
export function recoverStoreFromCheckpoint(options: RecoverStoreOptions): RecoverStoreResult {
  const now = options.now ?? (() => new Date());
  const plan = planImport(options.tasksFilePath);
  if (plan.errors > 0) {
    const messages = plan.issues.filter(i => i.severity === "error").map(i => `[${i.code}]${i.taskId ? ` ${i.taskId}` : ""}: ${i.message}`);
    throw new Error(
      `Cannot recover store: the last git-committed checkpoint (${options.tasksFilePath}) fails validation with ${plan.errors} error(s):\n${messages.join("\n")}\nFix the checkout or restore an earlier commit before retrying.`
    );
  }

  const handle = StoreHandle.open(options.storeDir);
  try {
    const projectMeta: ProjectMetadata = {
      ...plan.project,
      projectId: options.projectId,
      plansAuthority: "store",
      sourceSnapshotHash: plan.inputHash
    };
    handle.appendEvent({
      eventType: "project.initialized",
      actor: options.actor,
      occurredAt: now().toISOString(),
      payload: projectMeta as unknown as Record<string, unknown>
    });
    for (const item of plan.tasks) {
      handle.appendEvent({
        eventType: "task.upserted",
        actor: options.actor,
        occurredAt: now().toISOString(),
        payload: {
          task: item.task,
          detail: item.detail,
          outgoingEdges: item.outgoingEdges,
          externalRefs: item.externalRefs
        }
      });
    }
    return {
      projectId: options.projectId,
      storeDir: options.storeDir,
      nodeId: handle.nodeId,
      incarnationId: handle.incarnationId,
      taskCount: plan.taskCount
    };
  } finally {
    handle.close();
  }
}

export type ImportCommitOptions = {
  cwd: string;
  tasksFilePath?: string;
  legacyConfigPath?: string;
  mapctxTomlPath?: string;
  actor: string;
  now?: () => Date;
};

export type ImportCommitResult = {
  projectId: string;
  storeDir: string;
  tasksMdPath: string;
  taskDetailPaths: string[];
  mapctxTomlPath: string;
  commitSha: string;
  githubBinding: GithubBinding;
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).toString();
}

function assertPathClean(cwd: string, relativePath: string): void {
  const status = git(cwd, ["status", "--porcelain", "--", relativePath]).trim();
  if (status !== "") {
    throw new Error(`Cannot cut over: ${relativePath} has pending uncommitted changes (${status}). Commit or discard them first.`);
  }
}

function readLegacyConfig(legacyConfigPath: string): LegacySyncConfig {
  const raw = fs.readFileSync(legacyConfigPath, "utf8");
  return JSON.parse(raw) as LegacySyncConfig;
}

function githubBindingFromLegacyConfig(legacy: LegacySyncConfig): GithubBinding {
  return {
    owner: legacy.owner,
    repo: legacy.repo,
    projectId: legacy.projectId,
    statusFieldId: legacy.statusFieldId,
    startDateFieldId: legacy.startDateFieldId,
    dueDateFieldId: legacy.dueDateFieldId,
    completedDateFieldId: legacy.completedDateFieldId,
    statusMap: legacy.statusMap,
    // Never set true by import: T-049 does not contact GitHub. Only a
    // successful authenticated read (mapctx sync status) may flip this.
    verified: false
  };
}

/**
 * `mapctx import --commit`: the cutover transaction described in ADR 0003
 * "Authority and cutover". Builds the store and generated snapshot in a
 * temporary location first; only on a successful, single git commit that
 * touches exactly {mapctx.toml, TASKS.md, tasks/*.md, deleted mapcs.config.json}
 * does the temp store become the real `~/.mapctx/projects/<id>` store and
 * does plansAuthority flip to "store". A failed commit restores the working
 * tree and discards the temp store; nothing partial is ever published.
 */
export function importCommit(options: ImportCommitOptions): ImportCommitResult {
  const cwd = options.cwd;
  const tasksFilePath = options.tasksFilePath ?? path.join(cwd, "TASKS.md");
  const legacyConfigPath = options.legacyConfigPath ?? path.join(cwd, "mapcs.config.json");
  const mapctxTomlPath = options.mapctxTomlPath ?? path.join(cwd, "mapctx.toml");
  const now = options.now ?? (() => new Date());

  if (fs.existsSync(mapctxTomlPath)) {
    throw new Error(`${mapctxTomlPath} already exists. A repository holding both mapcs.config.json and mapctx.toml is an error, not a preference; this project has already been imported.`);
  }
  const existingToml = findMapctxToml(cwd);
  if (existingToml && existingToml !== mapctxTomlPath) {
    throw new Error(`Found an unrelated mapctx.toml at ${existingToml}; refusing to import a second project store under it.`);
  }
  if (!fs.existsSync(legacyConfigPath)) {
    throw new Error(`mapctx import requires exactly one pre-cutover config at ${legacyConfigPath}; none found.`);
  }

  const legacyConfig = readLegacyConfig(legacyConfigPath);

  const plan = planImport(tasksFilePath);
  if (plan.errors > 0) {
    const messages = plan.issues.filter(i => i.severity === "error").map(i => `[${i.code}]${i.taskId ? ` ${i.taskId}` : ""}: ${i.message}`);
    throw new Error(`Import validation failed with ${plan.errors} error(s):\n${messages.join("\n")}`);
  }

  const relTasksFile = path.relative(cwd, tasksFilePath);
  assertPathClean(cwd, relTasksFile);
  for (const item of plan.tasks) {
    assertPathClean(cwd, path.relative(cwd, path.resolve(plan.tasksRoot, item.task.detailPath!)));
  }

  const projectId = crypto.randomUUID();
  const tempStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-import-"));

  let handle: StoreHandle | undefined;
  try {
    handle = StoreHandle.open(tempStoreDir);
    const projectMeta: ProjectMetadata = {
      ...plan.project,
      projectId,
      plansAuthority: "markdown",
      sourceSnapshotHash: plan.inputHash
    };
    handle.appendEvent({
      eventType: "project.initialized",
      actor: options.actor,
      occurredAt: now().toISOString(),
      payload: projectMeta as unknown as Record<string, unknown>
    });
    for (const item of plan.tasks) {
      handle.appendEvent({
        eventType: "task.upserted",
        actor: options.actor,
        occurredAt: now().toISOString(),
        payload: {
          task: item.task,
          detail: item.detail,
          outgoingEdges: item.outgoingEdges,
          externalRefs: item.externalRefs
        }
      });
    }

    const exported = buildExport(handle.db, { tasksRoot: cwd });
    handle.close();
    handle = undefined;

    fs.writeFileSync(exported.tasksMd.path, exported.tasksMd.content, "utf8");
    for (const file of exported.taskDetailFiles) {
      fs.writeFileSync(file.path, file.content, "utf8");
    }

    const githubBinding = githubBindingFromLegacyConfig(legacyConfig);
    const tomlConfig: MapctxTomlConfig = {
      schemaVersion: 1,
      projectId,
      plansAuthority: "store",
      github: githubBinding
    };
    writeMapctxToml(mapctxTomlPath, tomlConfig);

    try {
      git(cwd, ["add", "--", relTasksFile, path.relative(cwd, mapctxTomlPath)]);
      for (const file of exported.taskDetailFiles) {
        git(cwd, ["add", "--", path.relative(cwd, file.path)]);
      }
      git(cwd, ["rm", "--quiet", "--", path.relative(cwd, legacyConfigPath)]);
      git(cwd, [
        "commit",
        "-m",
        `mapctx: cutover to external store\n\nprojectId: ${projectId}\nplansAuthority: markdown -> store`
      ]);
    } catch (commitError) {
      git(cwd, ["checkout", "--", relTasksFile]);
      for (const file of exported.taskDetailFiles) {
        git(cwd, ["checkout", "--", path.relative(cwd, file.path)]);
      }
      git(cwd, ["checkout", "HEAD", "--", path.relative(cwd, legacyConfigPath)]);
      fs.rmSync(mapctxTomlPath, { force: true });
      throw commitError;
    }

    const finalStoreDir = resolveProjectStoreDir(projectId);
    fs.mkdirSync(path.dirname(finalStoreDir), { recursive: true });
    fs.renameSync(tempStoreDir, finalStoreDir);

    const commitSha = git(cwd, ["rev-parse", "HEAD"]).trim();

    return {
      projectId,
      storeDir: finalStoreDir,
      tasksMdPath: tasksFilePath,
      taskDetailPaths: exported.taskDetailFiles.map(f => f.path),
      mapctxTomlPath,
      commitSha,
      githubBinding
    };
  } finally {
    handle?.close();
    if (fs.existsSync(tempStoreDir)) {
      fs.rmSync(tempStoreDir, { recursive: true, force: true });
    }
  }
}
