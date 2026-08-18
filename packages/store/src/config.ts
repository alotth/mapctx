import * as fs from "fs"
import * as path from "path"
import * as TOML from "smol-toml"
import { plansAuthoritySchema, uuidSchema } from "@mapctx/protocol"
import { getMapctxHome } from "@mapctx/core/workspace"

type PlansAuthority = "markdown" | "store"

export const MAPCTX_TOML_FILENAME = "mapctx.toml"

export type GithubBinding = {
  owner: string
  repo: string
  projectId?: string
  statusFieldId?: string
  startDateFieldId?: string
  dueDateFieldId?: string
  completedDateFieldId?: string
  statusMap?: Record<string, string>
  /**
   * Never set true by import: the inherited binding has not been confirmed
   * against GitHub (no `read:project` scope at import time). Only a
   * successful authenticated read may flip this.
   */
  verified: boolean
}

export type MapctxTomlConfig = {
  schemaVersion: 1
  projectId: string
  plansAuthority: PlansAuthority
  github?: GithubBinding
}

export type ResolvedMapctxToml = {
  config: MapctxTomlConfig
  path: string
  dir: string
}

function assertValidConfig(value: unknown, sourcePath: string): MapctxTomlConfig {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid ${MAPCTX_TOML_FILENAME} at ${sourcePath}: not a table.`);
  }
  const raw = value as Record<string, unknown>;

  if (raw.schemaVersion !== 1) {
    throw new Error(`Invalid ${MAPCTX_TOML_FILENAME} at ${sourcePath}: schemaVersion must be 1.`);
  }

  const projectIdResult = uuidSchema.safeParse(raw.projectId);
  if (!projectIdResult.success) {
    throw new Error(`Invalid ${MAPCTX_TOML_FILENAME} at ${sourcePath}: projectId must be a UUID.`);
  }

  const plansAuthorityResult = plansAuthoritySchema.safeParse(raw.plansAuthority ?? "markdown");
  if (!plansAuthorityResult.success) {
    throw new Error(`Invalid ${MAPCTX_TOML_FILENAME} at ${sourcePath}: plansAuthority must be "markdown" or "store".`);
  }

  let github: GithubBinding | undefined;
  if (raw.github !== undefined) {
    const g = raw.github as Record<string, unknown>;
    if (typeof g.owner !== "string" || typeof g.repo !== "string") {
      throw new Error(`Invalid ${MAPCTX_TOML_FILENAME} at ${sourcePath}: [github] requires owner and repo.`);
    }
    github = {
      owner: g.owner,
      repo: g.repo,
      projectId: typeof g.projectId === "string" ? g.projectId : undefined,
      statusFieldId: typeof g.statusFieldId === "string" ? g.statusFieldId : undefined,
      startDateFieldId: typeof g.startDateFieldId === "string" ? g.startDateFieldId : undefined,
      dueDateFieldId: typeof g.dueDateFieldId === "string" ? g.dueDateFieldId : undefined,
      completedDateFieldId: typeof g.completedDateFieldId === "string" ? g.completedDateFieldId : undefined,
      statusMap: typeof g.statusMap === "object" && g.statusMap !== null ? g.statusMap as Record<string, string> : undefined,
      verified: g.verified === true
    };
  }

  return {
    schemaVersion: 1,
    projectId: projectIdResult.data,
    plansAuthority: plansAuthorityResult.data,
    github
  };
}

export function findMapctxToml(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, MAPCTX_TOML_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function readMapctxToml(tomlPath: string): MapctxTomlConfig {
  const raw = fs.readFileSync(tomlPath, "utf8");
  const parsed = TOML.parse(raw);
  return assertValidConfig(parsed, tomlPath);
}

export function resolveMapctxToml(startDir: string = process.cwd()): ResolvedMapctxToml | undefined {
  const tomlPath = findMapctxToml(startDir);
  if (!tomlPath) return undefined;
  return {
    config: readMapctxToml(tomlPath),
    path: tomlPath,
    dir: path.dirname(tomlPath)
  };
}

export function serializeMapctxToml(config: MapctxTomlConfig): string {
  const table: Record<string, unknown> = {
    schemaVersion: config.schemaVersion,
    projectId: config.projectId,
    plansAuthority: config.plansAuthority
  };
  if (config.github) {
    table.github = config.github;
  }
  return `${TOML.stringify(table)}\n`.replace(/\n\n+$/, "\n");
}

export function writeMapctxToml(tomlPath: string, config: MapctxTomlConfig): void {
  fs.writeFileSync(tomlPath, serializeMapctxToml(config), "utf8");
}

export function resolveProjectStoreDir(projectId: string): string {
  return path.join(getMapctxHome(), "projects", projectId);
}

export function isStoreMaterialized(storeDir: string): boolean {
  return fs.existsSync(path.join(storeDir, "mapctx.db"));
}
