import { getTask, listCostEvents, listDispatchAttempts, listRunEvents, listRunReceipts, listWorkloadDeltaRows } from "@mapctx/store"
import type { EstimateSnapshot } from "@mapctx/protocol"
import { durationMeasuresFromReceipt } from "./duration"
import { buildEstimateSnapshot, estimationErrorByPlannedWorkload } from "./estimate"
import type { EstimateOptions, ForecastSample, Workload, WorkloadEstimationError } from "./types"

type StoreDatabase = Parameters<typeof listRunReceipts>[0]

const WORKLOAD_VALUES: readonly Workload[] = ["Easy", "Normal", "Hard", "Extreme"]

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
  const receipts = listRunReceipts(db, undefined, taskId)
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
      events: listRunEvents(db, receipt.dispatchId, receipt.attempt)
    }),
    usageEvents: receipt.usageEvents,
    costEvents: listCostEvents(db, receipt.dispatchId),
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
  return listWorkloadDeltaRows(db, taskId).map(row => ({
    duration: durationMeasuresFromReceipt(row.startedAt, row.endedAt),
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
