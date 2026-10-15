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
 * - `reviewLeaseFactor` (T-144 / D11) how much longer a review lease is than
 *   the implement lease the same plan derives
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
  /**
   * T-144 (C5 / D11): how much longer a REVIEW lease is than the implement
   * lease derived from the same plan. See `DEFAULT_REVIEW_LEASE_FACTOR`.
   */
  reviewLeaseFactor?: number
}

/** Resolved `[coordination]`, in milliseconds, with the D10 defaults applied. */
export type CoordinationSettings = {
  leaseFactor: number
  defaultLeaseMs: number
  maxLeaseMs: number
  reviewLeaseFactor: number
}

/** D10, approved as a starting point and to be re-derived after C4. */
export const DEFAULT_LEASE_FACTOR = 0.5;

/**
 * T-144 (C5 / D11, decided by the operator 2026-10-15): a review lease is
 * LONGER than the implement lease the same plan derives, by this factor.
 *
 * D11 chose (b) "longer" over (a) "same schedule" and (c) "no expiry": an idle
 * reviewer is less harmful than a stalled implementer, which rules out (a),
 * while (c) would accumulate ghosts in a lane the C9 sweeper would then have to
 * special-case. So a review claim still expires -- it just gets more room.
 *
 * 2x is this task's proposal, recorded in §10/D11 of the design. It is the
 * smallest factor that is unambiguously "longer", and it is one number in one
 * place for the re-derivation D10 already schedules after C4.
 *
 * The factor scales the whole derivation INCLUDING the clamp's ceiling --
 * `clamp(effort x leaseFactor x reviewLeaseFactor, defaultLease,
 * min(maxLease x reviewLeaseFactor, ABSOLUTE_LEASE_CEILING_MS))`. Scaling only
 * the multiplier would leave review leases pinned at `maxLease`, so on a
 * `Hard`/`2w` task the review lease would come out at exactly 8 h -- the same
 * as the implement lease -- and D11's decision would have no effect on the big
 * tasks where it matters most. Scaling the multiplier and ignoring `maxLease`
 * would do the opposite and overrun the one lease figure the operator
 * configures. Scaling both keeps the operator's proportion, keeps "review >=
 * implement" true even at saturation, and leaves the 24 h ceiling as the bound
 * that actually bites (`maxLease = "24h"` would derive 48 h and is cut to 24).
 */
export const DEFAULT_REVIEW_LEASE_FACTOR = 2;
/**
 * D4's absolute ceiling on a lease: 24 hours.
 *
 * Declared here, beside the lease settings it bounds, rather than in
 * `claims.ts` where T-141 first put it (`claims.ts` re-exports it, so every
 * importer is unaffected). The move is what F1 of T-143's review asks for:
 * the ceiling has to be readable by `resolveCoordinationSettings`, and
 * `claims.ts` already imports this module, so the dependency only goes this
 * way.
 *
 * It bounds BOTH halves now, which is the point of the single number: how
 * long a lease may be minted for (`maxLease`, and the derived lease the clamp
 * produces from it) and how long any renewal may keep it alive (measured from
 * the original `claimedAt`). Before this, `maxLease = "30h"` minted a 30 h
 * claim through the derived path while `task start --lease 30h` was refused by
 * name -- a constant called ABSOLUTE that limited only renewals.
 */
export const ABSOLUTE_LEASE_CEILING_MS = 24 * 60 * 60 * 1000;

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

  // T-144: judged exactly like its sibling, and for the same reason -- a lease
  // is an exclusivity window, so an operator who typed a figure the policy
  // cannot honour is told rather than silently given the default. Only
  // positivity is required: a value below 1 inverts D11 (shorter review
  // leases), which is a choice this file lets the operator make deliberately
  // and does not make for them.
  const reviewLeaseFactor = binding?.reviewLeaseFactor ?? DEFAULT_REVIEW_LEASE_FACTOR;
  if (typeof reviewLeaseFactor !== "number" || !Number.isFinite(reviewLeaseFactor) || reviewLeaseFactor <= 0) {
    throw new Error(`Invalid ${context}: [coordination] reviewLeaseFactor must be a positive number (got ${JSON.stringify(binding?.reviewLeaseFactor)}).`);
  }

  const defaultLeaseMs = requireDuration(binding?.defaultLease ?? DEFAULT_LEASE_DURATION, "defaultLease", context);
  const maxLeaseMs = requireDuration(binding?.maxLease ?? DEFAULT_MAX_LEASE_DURATION, "maxLease", context);
  // T-143 (review F1): REFUSED, not clamped. A silent clamp would answer a
  // configured 30 h with a 24 h claim and no word about why, and this file
  // already refuses a malformed `[coordination]` outright (C2) -- the operator
  // who wrote a number the policy cannot honour should be told, in the same
  // voice `task start --lease 30h` already uses.
  if (maxLeaseMs > ABSOLUTE_LEASE_CEILING_MS) {
    throw new Error(
      `Invalid ${context}: [coordination] maxLease (${binding?.maxLease ?? DEFAULT_MAX_LEASE_DURATION}) exceeds the absolute lease ceiling of `
      + `${ABSOLUTE_LEASE_CEILING_MS / (60 * 60 * 1000)}h. No claim may be held longer than that without being re-opened, `
      + `and --lease is refused above it for the same reason. Lower maxLease to 24h or less.`
    );
  }
  if (defaultLeaseMs > maxLeaseMs) {
    throw new Error(
      `Invalid ${context}: [coordination] defaultLease (${binding?.defaultLease ?? DEFAULT_LEASE_DURATION}) must not exceed maxLease (${binding?.maxLease ?? DEFAULT_MAX_LEASE_DURATION}); `
      + `the clamp has no room. Raise maxLease or lower defaultLease.`
    );
  }

  return { leaseFactor, defaultLeaseMs, maxLeaseMs, reviewLeaseFactor };
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
      ...(binding.maxLease !== undefined ? { maxLease: binding.maxLease } : {}),
      ...(binding.reviewLeaseFactor !== undefined ? { reviewLeaseFactor: binding.reviewLeaseFactor } : {})
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
  // A typo is the failure mode this file cannot afford. `pattern = [...]`
  // parses fine and yields nothing, and "nothing" is indistinguishable from
  // "no secrets here" at every later layer (review MEDIA-2). Refuse the key
  // we do not know instead.
  for (const key of Object.keys(table as Record<string, unknown>)) {
    if (key !== "patterns") {
      throw new Error(`Invalid privacy patterns file at ${filePath}: unknown key "${key}" under [privacy]; the only supported key is "patterns". A typo here reads as "no patterns configured", which is exactly what this file exists to prevent.`);
    }
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
  // `report` is separate from `source.length > 0` on purpose (review
  // MEDIA-2): a file that EXISTS and yields nothing must still appear in
  // `origins`, with count 0. Otherwise an empty or mis-keyed privacy file is
  // indistinguishable from no file at all, and the operator reads silence as
  // "configured and clean".
  const take = (source: readonly string[], origin: PrivacyPatternOrigin, options: { report: boolean; path?: string }): void => {
    let added = 0;
    for (const pattern of source) {
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      patterns.push(pattern);
      added++;
    }
    if (options.report) origins.push({ origin, ...(options.path ? { path: options.path } : {}), count: added });
  };

  const localPath = path.join(storeDir, LOCAL_PRIVACY_FILENAME);
  if (fs.existsSync(localPath)) take(readPrivacyPatternsFile(localPath), "local-file", { report: true, path: localPath });

  // An env var that is SET is an intention. Pointing it at nothing is a
  // broken intention -- a typo in a path, or a file that moved -- and
  // ignoring it silently would disarm the control the operator thought they
  // had turned on. An unset variable is simply not using this source.
  const envPath = env[PRIVACY_PATTERNS_FILE_ENV];
  if (envPath !== undefined) {
    if (envPath.trim() === "") {
      throw new Error(`${PRIVACY_PATTERNS_FILE_ENV} is set but empty. Unset it, or point it at a privacy patterns file.`);
    }
    if (!fs.existsSync(envPath)) {
      throw new Error(`${PRIVACY_PATTERNS_FILE_ENV} points at ${envPath}, which does not exist. Refusing to continue with a privacy source the operator asked for and the filesystem does not have.`);
    }
    take(readPrivacyPatternsFile(envPath), "env-file", { report: true, path: envPath });
  }

  take(configPatterns, "mapctx.toml", { report: configPatterns.length > 0 });

  return {
    patterns,
    origins,
    hasUnversionedSource: origins.some(entry => entry.origin !== "mapctx.toml")
  };
}
