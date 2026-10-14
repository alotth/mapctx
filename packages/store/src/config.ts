import * as fs from "fs"
import * as path from "path"
import * as TOML from "smol-toml"
import { parseEstimatedEffortMs, plansAuthoritySchema, uuidSchema } from "@mapctx/protocol"
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

/**
 * T-141 (C2 / D3, D10): lease tuning. All three keys are optional, and an
 * absent table, an absent key and an absent file all mean the figures below,
 * so a project that never heard of this block behaves as before for any task
 * whose derived lease lands inside the clamp.
 *
 * - `leaseFactor`  multiplier on `estimatedEffort` (D10 starting point: 0.5)
 * - `defaultLease` the clamp's floor, and the whole lease for a task with no
 *   parseable estimate -- which is what the fixed 30-minute lease used to be
 * - `maxLease`     the clamp's ceiling
 *
 * Unlike `[privacy]`, a malformed value here REFUSES at read time instead of
 * degrading to the default. A lease is an exclusivity window: an operator who
 * wrote `maxLease = "2h"` and silently got 8 h because of a typo would be
 * misled about the one number this block exists to control.
 */
export type CoordinationBinding = {
  leaseFactor?: number
  defaultLease?: string
  maxLease?: string
}

/** Resolved `[coordination]`, in milliseconds, with the D10 defaults applied. */
export type CoordinationSettings = {
  leaseFactor: number
  defaultLeaseMs: number
  maxLeaseMs: number
}

/** D10, approved as a starting point and to be re-derived after C4. */
export const DEFAULT_LEASE_FACTOR = 0.5;
export const DEFAULT_LEASE_DURATION = "30m";
export const DEFAULT_MAX_LEASE_DURATION = "8h";

export type MapctxTomlConfig = {
  schemaVersion: 1
  projectId: string
  plansAuthority: PlansAuthority
  github?: GithubBinding
  privacy?: PrivacyBinding
  coordination?: CoordinationBinding
}

function requireDuration(value: unknown, key: string, context: string): number {
  const parsed = typeof value === "string" ? parseEstimatedEffortMs(value) : null;
  if (parsed === null) {
    throw new Error(`Invalid ${context}: [coordination] ${key} must be a positive duration like "30m", "4h" or "1d" (got ${JSON.stringify(value)}).`);
  }
  return parsed;
}

/**
 * The ONE place `[coordination]` is judged, so the read-time refusal and a
 * programmatically built binding cannot drift apart on what counts as valid.
 * `context` is the mapctx.toml path when a file is being read, and a bare
 * label otherwise.
 */
export function resolveCoordinationSettings(
  binding: CoordinationBinding | undefined,
  context = MAPCTX_TOML_FILENAME
): CoordinationSettings {
  const leaseFactor = binding?.leaseFactor ?? DEFAULT_LEASE_FACTOR;
  if (typeof leaseFactor !== "number" || !Number.isFinite(leaseFactor) || leaseFactor <= 0) {
    throw new Error(`Invalid ${context}: [coordination] leaseFactor must be a positive number (got ${JSON.stringify(binding?.leaseFactor)}).`);
  }

  const defaultLeaseMs = requireDuration(binding?.defaultLease ?? DEFAULT_LEASE_DURATION, "defaultLease", context);
  const maxLeaseMs = requireDuration(binding?.maxLease ?? DEFAULT_MAX_LEASE_DURATION, "maxLease", context);
  if (defaultLeaseMs > maxLeaseMs) {
    throw new Error(
      `Invalid ${context}: [coordination] defaultLease (${binding?.defaultLease ?? DEFAULT_LEASE_DURATION}) must not exceed maxLease (${binding?.maxLease ?? DEFAULT_MAX_LEASE_DURATION}); `
      + `the clamp has no room. Raise maxLease or lower defaultLease.`
    );
  }

  return { leaseFactor, defaultLeaseMs, maxLeaseMs };
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

  // T-141: judged here, at read time, so a typo in a lease figure is refused
  // by the first command that opens the project rather than discovered as a
  // task that held its lane for eight hours.
  let coordination: CoordinationBinding | undefined;
  if (raw.coordination !== undefined) {
    const c = raw.coordination;
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      throw new Error(`Invalid ${MAPCTX_TOML_FILENAME} at ${sourcePath}: [coordination] must be a table.`);
    }
    const binding = c as CoordinationBinding;
    resolveCoordinationSettings(binding, `${MAPCTX_TOML_FILENAME} at ${sourcePath}`);
    coordination = {
      ...(binding.leaseFactor !== undefined ? { leaseFactor: binding.leaseFactor } : {}),
      ...(binding.defaultLease !== undefined ? { defaultLease: binding.defaultLease } : {}),
      ...(binding.maxLease !== undefined ? { maxLease: binding.maxLease } : {})
    };
  }

  return {
    schemaVersion: 1,
    projectId: projectIdResult.data,
    plansAuthority: plansAuthorityResult.data,
    github,
    privacy,
    coordination
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
  // Round-trips so `mapctx import`/`store init` rewriting the file cannot
  // silently drop an operator's lease tuning.
  if (config.coordination && Object.keys(config.coordination).length > 0) {
    table.coordination = config.coordination;
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
