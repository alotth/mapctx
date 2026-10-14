// Shared defaults and argv parsing for the T-135 spike bins.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SPIKE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = path.resolve(SPIKE_DIR, '..', '..', '..')

export const DEFAULTS = {
  account: 'alotth',
  owner: 'alotth',
  repo: 'mapctx',
  projectTitle: 'MapCtx provider spike (test)',
  // The mapctx CLI used for store reads. Prefer a build from `main`
  // (`MAPCTX_CLI=/path/to/main/packages/sync-engine/dist/mapctx-cli.js` or
  // `--cli`): a worktree build whose branch carries an unreleased migration
  // would migrate the shared store on open. `lib/store-input.mjs` also refuses
  // anything but read-only subcommands, so the fallback below is safe even
  // when it is the worktree's own build.
  cli: process.env.MAPCTX_CLI ?? path.resolve(REPO_ROOT, 'packages/sync-engine/dist/mapctx-cli.js'),
  // Corpus with real store dependency edges and a depth-4 chain, so the
  // planner has something to prove: 117/118 -> 116, 119 -> 118, 120 -> 119,
  // 128 -> 127, 129 -> 126/127, 131 -> 126, 133 -> 131.
  tasks: ['T-116', 'T-117', 'T-118', 'T-119', 'T-120', 'T-126', 'T-127', 'T-128', 'T-129', 'T-131', 'T-133', 'T-134'],
  usdPerActiveHour: 0,
}

/** The six derived fields E-018 wants a provider to carry. */
export const DERIVED_FIELDS = [
  {
    key: 'wave',
    name: 'Wave',
    dataType: 'SINGLE_SELECT',
    // Single select on purpose: it is the only one of the six that forces the
    // adapter to resolve an OPTION id, the fourth identity in FieldRef.
    options: ['1', '2', '3', '4', '5', '6', '7', '8'].map((n) => ({
      name: n,
      color: 'GRAY',
      description: `Planner wave ${n}`,
    })),
  },
  { key: 'p50', name: 'Forecast P50 (h)', dataType: 'NUMBER' },
  { key: 'p90', name: 'Forecast P90 (h)', dataType: 'NUMBER' },
  { key: 'endP90', name: 'Forecast end P90', dataType: 'DATE' },
  { key: 'estCost', name: 'Est. custo', dataType: 'NUMBER' },
  { key: 'realCost', name: 'Custo real', dataType: 'NUMBER' },
]

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { ...DEFAULTS, _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--json') out.json = true
    else if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      const value = argv[i + 1]
      i += 1
      if (key === 'tasks') out.tasks = value.split(',').map((s) => s.trim()).filter(Boolean)
      else if (key === 'usdPerActiveHour' || key === 'first' || key === 'projectNumber' || key === 'repeat') out[key] = Number(value)
      else out[key] = value
    } else out._.push(a)
  }
  return out
}

/**
 * Strip local filesystem paths out of the args snapshot before it is persisted.
 *
 * The measurement files are committed to a public repository, so a resolved
 * `--cli` or `--usage-file` would publish the operator's home directory and
 * username. The placeholder keeps the capture self-describing without
 * disclosing the machine it ran on.
 */
export function redactArgs(args) {
  const out = {}
  for (const [key, value] of Object.entries(args)) {
    if (key === '_') continue
    if (key === 'cli') out[key] = '<MAPCTX_CLI>'
    else if (typeof value === 'string' && value.startsWith('/')) out[key] = `<ABS_PATH:${path.basename(value)}>`
    else out[key] = value
  }
  return out
}

export function writeJson(file, value) {
  return { file, body: `${JSON.stringify(value, null, 2)}\n` }
}
