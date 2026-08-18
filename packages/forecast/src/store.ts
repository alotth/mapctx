import { listCostEvents, listRunReceipts } from "@mapctx/store"
import type { EstimateSnapshot } from "@mapctx/protocol"
import { durationMeasuresFromReceipt } from "./duration"
import { buildEstimateSnapshot } from "./estimate"
import type { EstimateOptions } from "./types"

type StoreDatabase = Parameters<typeof listRunReceipts>[0]

/** Build forecast from the store's lossless receipt/usage and cost projections. */
export function buildEstimateFromStore(
  db: StoreDatabase,
  taskId: string,
  options: EstimateOptions = {}
): EstimateSnapshot {
  const receipts = listRunReceipts(db, undefined, taskId)
  const samples = receipts.map(receipt => ({
    duration: durationMeasuresFromReceipt(receipt.startedAt, receipt.endedAt, { idleThresholdMs: options.idleThresholdMs }),
    usageEvents: receipt.usageEvents,
    costEvents: listCostEvents(db, receipt.dispatchId)
  }))
  return buildEstimateSnapshot(taskId, samples, options)
}

export const forecastTaskFromStore = buildEstimateFromStore
