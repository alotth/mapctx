// T-135 spike: the MapCtx-side half of the Option B picture -- the derived
// fields that stay MapCtx's job even when task authority moves to a provider.
//
// Waves come from @mapctx/planner run over PROVIDER-SHAPED input, which is the
// claim this spike exists to test. Forecast and cost come from the store,
// read only through the prebuilt CLI from main (`gantt --json`): the spike
// never opens ~/.mapctx itself, so "store intact" is structural, not a promise.

import { createRequire } from 'node:module'
import { cliJson } from './store-input.mjs'

const require = createRequire(import.meta.url)
const { planExecution } = require('@mapctx/planner')
const { costEventFromUsage } = require('@mapctx/forecast')

const MS_PER_HOUR = 3_600_000

/** `[T-135] title` -> `T-135`. The draft-issue title is the only binding a draft can carry. */
export function taskIdFromTitle(title) {
  const m = /^\[((?:T|E)-\d{3,})\]/.exec(title ?? '')
  return m ? m[1] : null
}

/** Store snapshot through the CLI's read-only subcommands only (see store-input.mjs). */
export function readStoreSnapshot({ cli, cwd }) {
  const gantt = cliJson({ cli, cwd, args: ['gantt', '--json'] })
  const plan = cliJson({ cli, cwd, args: ['plan', '--json'] })
  return { gantt, plan, cli }
}

/**
 * GitHub issue state -> a planner-legible status.
 *
 * A draft issue has no state at all: GitHub's own model treats it as open, so
 * `statusMode: 'provider'` reads every draft as schedulable. That is the honest
 * provider reading, and it is also the measurement that matters -- a provider
 * with two states cannot express paused / review / done, so its wave answer
 * diverges from the store's. `statusMode: 'store'` reproduces today's answer
 * for comparison.
 */
export function statusFromProvider(item, storeStatus, statusMode) {
  const state = item.fields?.planningState
  if (state === 'CLOSED') return 'done'
  if (state === 'OPEN') return 'ready-for-do'
  return statusMode === 'store' ? (storeStatus ?? 'ready-for-do') : 'ready-for-do'
}

/**
 * Waves from provider-shaped input.
 *
 * `edgeSource` is explicit on purpose. GitHub carries dependency edges on
 * issues only, so a project of draft issues yields zero edges and a
 * provider-only plan degenerates to one wave. The adapter has the same problem
 * during migration, so the spike models the same fallback and labels it.
 */
export function wavesFromProvider({ providerItems, providerDependencies, storeEdges, storeTasks, statusMode = 'provider' }) {
  const tasks = []
  const idByItemKey = new Map()

  for (const item of providerItems) {
    const taskId = taskIdFromTitle(item.fields?.title)
    const id = taskId ?? item.ref.workItem.key
    idByItemKey.set(item.ref.workItem.key, id)
    const storeTask = taskId ? storeTasks.get(taskId) : undefined
    tasks.push({
      id,
      title: item.fields?.title ?? id,
      status: statusFromProvider(item, storeTask?.status, statusMode),
      type: storeTask?.type ?? 'task',
      parent: item.fields?.parent ?? storeTask?.parentId ?? null,
      // Resource claims are MapCtx-side; GitHub has no filesAffected field, so
      // the collision model has no provider representation at all.
      filesAffected: storeTask?.filesAffected ?? [],
      domains: storeTask?.domains ?? [],
    })
  }

  const providerEdges = []
  for (const dep of providerDependencies) {
    const from = idByItemKey.get(dep.from.workItem.key)
    const to = idByItemKey.get(dep.to.workItem.key)
    if (!from || !to) continue
    if (dep.kind === 'blocked-by') providerEdges.push({ fromTaskId: from, toTaskId: to, kind: 'depends-on' })
    else if (dep.kind === 'blocks') providerEdges.push({ fromTaskId: to, toTaskId: from, kind: 'depends-on' })
  }

  const ids = new Set(tasks.map((t) => t.id))
  const fallbackEdges = storeEdges
    .filter((e) => ids.has(e.fromTaskId) && ids.has(e.toTaskId))
    .map((e) => ({ fromTaskId: e.fromTaskId, toTaskId: e.toTaskId, kind: e.kind }))

  const edgeSource = providerEdges.length > 0 ? 'provider' : 'store-fallback'
  const dependencyEdges = providerEdges.length > 0 ? providerEdges : fallbackEdges

  const report = planExecution({ tasks, dependencyEdges })
  return {
    statusMode,
    edgeSource,
    providerEdgeCount: providerEdges.length,
    fallbackEdgeCount: fallbackEdges.length,
    report,
    taskIdByItemKey: idByItemKey,
  }
}

/**
 * P50/P90 in hours plus a P90 end date.
 *
 * The store has no `predicted` window for these tasks (no start dates), so the
 * end date is derived: gantt's own approximate start date, or today, plus the
 * P90 duration. The method travels with the value.
 */
export function forecastForTask({ gantt, taskId, today }) {
  const row = (gantt.tasks ?? []).find((t) => t.id === taskId)
  if (!row?.forecast) return null
  const p50Ms = row.forecast.durationP50Ms ?? null
  const p90Ms = row.forecast.durationP90Ms ?? null
  const startBasis = row.predicted?.start ?? row.approximateDate?.date ?? today
  const startMs = Date.parse(startBasis.length === 10 ? `${startBasis}T00:00:00Z` : startBasis)
  const endP90 = p90Ms !== null && Number.isFinite(startMs)
    ? new Date(startMs + p90Ms).toISOString().slice(0, 10)
    : null
  return {
    p50Hours: p50Ms === null ? null : Number((p50Ms / MS_PER_HOUR).toFixed(2)),
    p90Hours: p90Ms === null ? null : Number((p90Ms / MS_PER_HOUR).toFixed(2)),
    endP90,
    endP90Basis: row.predicted?.start ? 'predicted.start' : row.approximateDate?.date ? `approximateDate(${row.approximateDate.method})` : 'today',
    method: row.forecast.method,
    confidence: row.forecast.confidence,
    isPriorFallback: row.forecast.isPriorFallback,
    durationCoverage: row.forecast.durationCoverage,
    storeWave: row.wave ?? null,
    storeStatus: row.status,
    plannedDurationHours: row.planned?.durationMs ? Number((row.planned.durationMs / MS_PER_HOUR).toFixed(2)) : null,
  }
}

/**
 * Cost through the real @mapctx/forecast chain.
 *
 * `usageEvents` are the store's own rows. Every one of them currently has
 * coverage 'none' and zero tokens, so the chain is exercised end to end and
 * legitimately produces zero -- no rate is invented to make the number look
 * measured. `usdPerActiveHour` stays an explicit operator input; at its default
 * of 0 the estimate is 0 too, and the gap is reported rather than papered over.
 */
export function costForTask({ taskId, usageEvents, p50Hours, usdPerActiveHour }) {
  const mine = usageEvents.filter((u) => u.taskId === taskId)
  const costEvents = mine.map((u) =>
    costEventFromUsage({
      usageEventId: u.usageEventId,
      dispatchId: u.dispatchId,
      provider: u.provider,
      model: u.model,
      inputTokens: u.inputTokens,
      cacheTokens: u.cacheTokens,
      outputTokens: u.outputTokens,
      source: u.source,
      coverage: u.coverage,
    }),
  )
  const shadowMicros = costEvents.reduce((s, c) => s + (c.shadowMicros ?? 0), 0)
  const hasBasis = mine.length > 0 && mine.some((u) => u.coverage !== 'none')
  return {
    estimateUsd: usdPerActiveHour > 0 && p50Hours !== null ? Number((p50Hours * usdPerActiveHour).toFixed(2)) : 0,
    estimateBasis: usdPerActiveHour > 0 ? `p50Hours * ${usdPerActiveHour} usd/active-hour` : 'no rate supplied (store has no plan period or budget)',
    actualUsd: mine.length === 0 ? null : Number((shadowMicros / 1_000_000).toFixed(2)),
    actualBasis: mine.length === 0
      ? 'no usage event for this task -- field cleared'
      : hasBasis
        ? `${mine.length} usage event(s) through costEventFromUsage`
        : `${mine.length} usage event(s), all coverage=none/0 tokens -> shadow cost 0`,
    usageEventCount: mine.length,
    shadowMicros,
  }
}
