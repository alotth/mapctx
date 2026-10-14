import * as fs from "fs"
import * as path from "path"
import * as TOML from "smol-toml"
import { plansAuthoritySchema, uuidSchema } from "@mapctx/protocol"
import { getMapctxHome } from "@mapctx/core/workspace"

export type PlansAuthority = "markdown" | "store"

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

/**
 * T-126: optional sensitive-content patterns. Advisory only -- the lint that
 * reads these warns and never blocks (see privacy.ts), so a malformed entry
 * degrades to "one pattern skipped", never to an unusable board. Absent
 * table, absent key and empty list all mean "lint disabled".
 */
export type PrivacyBinding = {
  patterns: string[]
}

export type MapctxTomlConfig = {
  schemaVersion: 1
  projectId: string
  plansAuthority: PlansAuthority
  github?: GithubBinding
  privacy?: PrivacyBinding
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

  // The ONE structural rule that is worth refusing on: `patterns` must be a
  // list of strings. Anything else is a misunderstanding of the key rather
  // than a bad pattern, and silently reading it as "lint disabled" would hide
  // a privacy control the operator believes is on. Individual patterns that
  // do not compile stay non-fatal and are reported by the lint itself.
  let privacy: PrivacyBinding | undefined;
  if (raw.privacy !== undefined) {
    const p = raw.privacy as Record<string, unknown>;
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      throw new Error(`Invalid ${MAPCTX_TOML_FILENAME} at ${sourcePath}: [privacy] must be a table.`);
    }
    if (p.patterns !== undefined) {
      if (!Array.isArray(p.patterns) || !p.patterns.every(item => typeof item === "string")) {
        throw new Error(`Invalid ${MAPCTX_TOML_FILENAME} at ${sourcePath}: [privacy] patterns must be an array of regex strings.`);
      }
    }
    privacy = { patterns: (p.patterns as string[] | undefined) ?? [] };
  }

  return {
    schemaVersion: 1,
    projectId: projectIdResult.data,
    plansAuthority: plansAuthorityResult.data,
    github,
    privacy
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
  if (config.privacy) {
    table.privacy = config.privacy;
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

/**
 * T-151: a SECOND, unversioned source for `[privacy] patterns`.
 *
 * `mapctx.toml` is committed, and for this project it is about to be
 * committed to a PUBLIC repository. That makes it the wrong place for the
 * patterns that matter most: the name of a third party, the operator's
 * machine hostname, a customer identifier. Writing those into the public
 * config in order to keep them out of public issues publishes them on the
 * way in -- the control would leak exactly what it exists to hide.
 *
 * So patterns may also live in `<storeDir>/privacy.toml`, beside the store
 * and outside every repository, or in a file named by
 * MAPCTX_PRIVACY_PATTERNS_FILE. Both carry the same `[privacy] patterns`
 * shape as mapctx.toml. The three sources are UNIONED, not overridden: a
 * pattern list is a set of things to look for, and dropping the public ones
 * because a private file exists would be a silent downgrade of coverage.
 * Unversioned sources come first so their indices stay stable in reports as
 * the public list grows.
 */
export const LOCAL_PRIVACY_FILENAME = "privacy.toml"
export const PRIVACY_PATTERNS_FILE_ENV = "MAPCTX_PRIVACY_PATTERNS_FILE"

export type PrivacyPatternOrigin = "local-file" | "env-file" | "mapctx.toml"

export type ResolvedPrivacyPatterns = {
  /** Deduplicated union, unversioned sources first. */
  patterns: string[]
  origins: Array<{ origin: PrivacyPatternOrigin; path?: string; count: number }>
  /** True when at least one pattern came from a source that is not committed. */
  hasUnversionedSource: boolean
}

/**
 * Same structural rule as `[privacy]` in mapctx.toml: `patterns` must be an
 * array of strings or the file is refused. A privacy file that silently reads
 * as "no patterns" is the failure this whole mechanism exists to prevent.
 */
function readPrivacyPatternsFile(filePath: string): string[] {
  const parsed = TOML.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  const table = parsed.privacy;
  if (table === undefined) return [];
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    throw new Error(`Invalid privacy patterns file at ${filePath}: [privacy] must be a table.`);
  }
  const patterns = (table as Record<string, unknown>).patterns;
  if (patterns === undefined) return [];
  if (!Array.isArray(patterns) || !patterns.every(item => typeof item === "string")) {
    throw new Error(`Invalid privacy patterns file at ${filePath}: [privacy] patterns must be an array of regex strings.`);
  }
  return patterns as string[];
}

export function resolvePrivacyPatterns(
  projectId: string,
  configPatterns: readonly string[] = [],
  options: { storeDir?: string; env?: NodeJS.ProcessEnv } = {}
): ResolvedPrivacyPatterns {
  const env = options.env ?? process.env;
  const storeDir = options.storeDir ?? resolveProjectStoreDir(projectId);
  const origins: ResolvedPrivacyPatterns["origins"] = [];
  const patterns: string[] = [];
  const seen = new Set<string>();
  const take = (source: readonly string[], origin: PrivacyPatternOrigin, sourcePath?: string): void => {
    let added = 0;
    for (const pattern of source) {
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      patterns.push(pattern);
      added++;
    }
    if (source.length > 0) origins.push({ origin, ...(sourcePath ? { path: sourcePath } : {}), count: added });
  };

  const localPath = path.join(storeDir, LOCAL_PRIVACY_FILENAME);
  if (fs.existsSync(localPath)) take(readPrivacyPatternsFile(localPath), "local-file", localPath);
  const envPath = env[PRIVACY_PATTERNS_FILE_ENV];
  if (envPath && fs.existsSync(envPath)) take(readPrivacyPatternsFile(envPath), "env-file", envPath);
  take(configPatterns, "mapctx.toml");

  return {
    patterns,
    origins,
    hasUnversionedSource: origins.some(entry => entry.origin !== "mapctx.toml")
  };
}
