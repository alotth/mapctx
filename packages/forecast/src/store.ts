import { getTask, listCostEvents, listDispatchAttempts, listInvalidatedReceiptKeys, listNonImplementAttemptKeys, listRunEvents, listRunReceipts, listWorkloadDeltaRows } from "@mapctx/store"
import type { EstimateSnapshot } from "@mapctx/protocol"
import { durationMeasuresFromReceipt } from "./duration"
import { buildEstimateSnapshot, estimationErrorByPlannedWorkload } from "./estimate"
import type { EstimateOptions, ForecastSample, Workload, WorkloadEstimationError } from "./types"

type StoreDatabase = Parameters<typeof listRunReceipts>[0]

const WORKLOAD_VALUES: readonly Workload[] = ["Easy", "Normal", "Hard", "Extreme"]

/**
 * T-116: receipts invalidated by an accepted history correction are excluded
 * from every duration/accuracy path. The original rows stay queryable in the
 * store; they simply never calibrate or display as actuals again.
 */
function withoutInvalidated<T extends { dispatchId: string; attempt: number }>(items: readonly T[], db: StoreDatabase): T[] {
  const invalidated = listInvalidatedReceiptKeys(db)
  if (invalidated.size === 0) return [...items]
  return items.filter(item => !invalidated.has(`${item.dispatchId}/${item.attempt}`))
}

/**
 * T-145 (C6 / §3): calibration is IMPLEMENT-ONLY, unconditionally.
 *
 * Review time and implementation time are different populations. Every
 * receipt reaching this package becomes a workload-duration sample, so a
 * ten-minute review receipt on a `Hard` task would otherwise teach the prior
 * that `Hard` tasks finish in ten minutes -- and since T-141 the lease is
 * derived from `estimatedEffort`, that corruption feeds straight back into
 * how long an agent is given to do the work.
 *
 * Unconditional, with no option to include them: there is no caller who wants
 * review durations pooled with implementation durations, and an option would
 * only be a way to get it wrong. A review lane's own duration statistics, if
 * anyone ever wants them, are a separate population that would need its own
 * pool rather than a flag on this one.
 *
 * `withoutInvalidated`'s twin by design -- same signature, same place in the
 * pipeline, applied at the same two entry points -- so the two calibration
 * exclusions read as one idea with two reasons rather than as two mechanisms.
 * This is the shared helper both calibration paths go through; adding a third
 * entry point means calling it there too, and the review-receipt test is what
 * notices if you do not.
 *
 * NOT applied to display. `gantt.ts` reads receipts to draw the roadmap, and
 * a review that happened should be visible as a thing that happened; what it
 * must not do is calibrate. Lane-aware display is C8's.
 */
function implementLaneOnly<T extends { dispatchId: string; attempt: number }>(items: readonly T[], db: StoreDatabase): T[] {
  const nonImplement = listNonImplementAttemptKeys(db)
  if (nonImplement.size === 0) return [...items]
  return items.filter(item => !nonImplement.has(`${item.dispatchId}/${item.attempt}`))
}

/**
 * The two calibration exclusions, in one place so an entry point cannot pick
 * up one and miss the other.
 */
function calibrationSamples<T extends { dispatchId: string; attempt: number }>(items: readonly T[], db: StoreDatabase): T[] {
  return implementLaneOnly(withoutInvalidated(items, db), db)
}

/**
 * Canonical-workload coercion. Store rows carry free strings; the forecast
 * pools speak the four-value enum. Anything else (typos, future values)
 * degrades to untagged rather than poisoning a pool with a class nothing
 * else matches -- untagged is never guessed (T-071).
 */
function toWorkload(value: string | null | undefined): Workload | undefined {
  if (value === null || value === undefined) return undefined
  return (WORKLOAD_VALUES as readonly string[]).includes(value) ? (value as Workload) : undefined
}

/** Build forecast from the store's lossless receipt/usage and cost projections. */
export function buildEstimateFromStore(
  db: StoreDatabase,
  taskId: string,
  options: EstimateOptions = {}
): EstimateSnapshot {
  const receipts = calibrationSamples(listRunReceipts(db, undefined, taskId), db)
  // T-071: dispatch attempts carry the planned workload frozen at hand-off.
  const plannedByAttempt = new Map(
    listDispatchAttempts(db, undefined, taskId).map(
      attempt => [`${attempt.dispatchId}/${attempt.attempt}`, attempt.workloadAtDispatch ?? null]
    )
  )
  // T-071: pools key on the DISCOVERED workload -- the task's current (latest)
  // declared value. A re-classification therefore re-attributes the actual to
  // the new pool even after the receipt landed (last-wins).
  const task = getTask(db, taskId)
  const discovered = toWorkload(task?.workload)
  const samples = receipts.map(receipt => ({
    duration: durationMeasuresFromReceipt(receipt.startedAt, receipt.endedAt, {
      idleThresholdMs: options.idleThresholdMs,
      timeEvidence: receipt.timeEvidence,
      events: listRunEvents(db, receipt.dispatchId, receipt.attempt)
    }),
    usageEvents: receipt.usageEvents,
    timePolicy: receipt.timeEvidence?.policy,
    costEvents: listCostEvents(db, receipt.dispatchId),
    historyTier: receipt.historyTier,
    workload: discovered,
    workloadPlanned: toWorkload(plannedByAttempt.get(`${receipt.dispatchId}/${receipt.attempt}`)) ?? null
  }))
  return buildEstimateSnapshot(taskId, samples, options)
}

export const forecastTaskFromStore = buildEstimateFromStore

/**
 * T-071: all receipt samples with their planned/discovered workload pair,
 * straight from the stamped projections. `workload` is the task's CURRENT
 * workload (last-wins pooling key), `workloadPlanned` the dispatch-time
 * stamp; both undefined when untagged.
 */
export function workloadDeltaSamplesFromStore(db: StoreDatabase, taskId?: string): ForecastSample[] {
  // T-145: through the shared pair rather than re-filtering `invalidated`
  // inline, which is how this entry point would have kept the history
  // exclusion and silently missed the lane one.
  return calibrationSamples(listWorkloadDeltaRows(db, taskId), db)
    .map(row => ({
    duration: durationMeasuresFromReceipt(row.startedAt, row.endedAt, { timeEvidence: listRunReceipts(db, row.dispatchId).find(receipt => receipt.attempt === row.attempt)?.timeEvidence }),
    historyTier: listRunReceipts(db, row.dispatchId).find(receipt => receipt.attempt === row.attempt)?.historyTier,
    workload: toWorkload(row.currentWorkload),
    workloadPlanned: toWorkload(row.plannedWorkload) ?? null
  }))
}

/**
 * T-071 estimation-error aggregate over the whole store (or one task):
 * per planned workload, count + median actual/prior-P50 ratio + transition
 * counts for re-classified samples. Deterministic. Executor tier is NOT a
 * key here in v1 (D5): raw executorModel ids ride on the delta rows, so
 * tier-sliced variants later need no recapture.
 */
export function estimationErrorFromStore(db: StoreDatabase, taskId?: string): WorkloadEstimationError[] {
  return estimationErrorByPlannedWorkload(workloadDeltaSamplesFromStore(db, taskId))
}
