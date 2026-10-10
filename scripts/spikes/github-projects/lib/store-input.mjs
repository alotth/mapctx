// T-135 spike: every store read goes through the PREBUILT CLI from main.
//
// The worktree's own build must never open ~/.mapctx -- the e-017 integration
// branch carries migration 11 and opening the shared store with it would
// migrate a database other sessions are using. Reading through the pinned CLI
// keeps the store untouched by construction, which is also acceptance
// criterion 1 ("sem alterar a store").

import { execFileSync } from 'node:child_process'

/**
 * The only mapctx subcommands this spike is allowed to run. The guard is the
 * real protection, not the choice of binary: a read-only command cannot move
 * planning state, create a dispatch, or publish a snapshot, whichever build
 * executes it.
 */
const READ_ONLY_COMMANDS = [
  ['plan'],
  ['gantt'],
  ['board'],
  ['task', 'show'],
  ['task', 'context'],
  ['task', 'acceptance', 'show'],
]

function assertReadOnly(args) {
  const allowed = READ_ONLY_COMMANDS.some((cmd) => cmd.every((part, i) => args[i] === part))
  if (!allowed) {
    throw new Error(
      `spike refuses to run a non-read-only mapctx command: ${args.join(' ')}. ` +
        `Allowed: ${READ_ONLY_COMMANDS.map((c) => c.join(' ')).join(', ')}.`,
    )
  }
}

export function cliJson({ cli, cwd, args }) {
  assertReadOnly(args)
  const out = execFileSync('node', [cli, ...args], { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(out)
}

/**
 * Task rows plus the dependency edges the planner needs, for a fixed corpus.
 * `prerequisites` is the store's own edge surface: task depends-on prerequisite.
 */
export function readCorpus({ cli, cwd, taskIds }) {
  const tasks = new Map()
  const edges = []
  for (const taskId of taskIds) {
    const res = cliJson({ cli, cwd, args: ['task', 'show', taskId, '--json'] })
    const t = res.task
    const d = res.detail ?? {}
    tasks.set(taskId, {
      id: taskId,
      title: t.title,
      status: t.planningState,
      executionState: t.executionState,
      type: t.type,
      parentId: t.parentTaskId ?? null,
      workload: t.workload ?? null,
      domains: t.domains ?? [],
      filesAffected: d.filesAffected ?? [],
      estimatedEffort: d.estimatedEffort ?? null,
      summary: d.summary ?? null,
    })
    for (const prereq of d.prerequisites ?? []) {
      edges.push({ fromTaskId: taskId, toTaskId: prereq, kind: 'depends-on' })
    }
    for (const blocked of d.blocking ?? []) {
      edges.push({ fromTaskId: blocked, toTaskId: taskId, kind: 'depends-on' })
    }
  }
  // Deduplicate: prerequisites and blocking describe the same edge from both ends.
  const seen = new Set()
  const dedup = edges.filter((e) => {
    const k = `${e.fromTaskId}->${e.toTaskId}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { tasks, edges: dedup }
}
