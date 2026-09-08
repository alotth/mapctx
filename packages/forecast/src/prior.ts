import type { ForecastPrior, Workload } from "./types"

/**
 * Workload-aware duration priors (T-065).
 *
 * This file is DATA, deliberately kept out of `estimate.ts`: recalibrating the
 * prior must not require touching the estimator, so a future rerun of the
 * calibration replaces this table without a code change.
 *
 * DERIVATION (written down because an undocumented guess presented as a
 * baseline is the defect this table replaces):
 *
 * Measured evidence — dogfood wave1 produced the first real actuals for this
 * repository, agent-assisted wall-clock durations from run receipts:
 *
 *   T-067  312,830 ms  (4 files changed, docs)
 *   T-068  116,387 ms  (2 files changed, skills)
 *
 * Neither task declared a workload (`workload: null`), and both are the
 * smallest task shape the board has measured — focused single-area edits. They
 * are treated as `historical-baseline` evidence with LOW confidence (n=2,
 * one task shape, substituted wall clock): they anchor `Easy`, they do not
 * prove the whole scale.
 *
 * `Easy` P50 is the arithmetic mean of the two actuals (214,608.5 ms,
 * rounded). Each step up in declared workload is a documented guess of ~4x
 * more scope of change (focused edit -> routine feature -> cross-package
 * feature -> architectural change), NOT a measurement. The P90 = 2x P50 ratio
 * is retained from the human-era prior as within-class spread. As actuals
 * accumulate, `workloadBaselines()` computes per-workload quantiles from
 * history and this table stops mattering — which is the real fix.
 *
 * Token and shadow-cost priors stay flat across workloads: wave1 produced no
 * measured token actuals to calibrate them against, and inventing per-workload
 * token numbers would be an undocumented guess of exactly the kind this table
 * exists to delete.
 */

const HOUR_MS = 60 * 60 * 1000
/** Arithmetic mean of the two wave1 actuals: (312,830 + 116,387) / 2. */
export const MEASURED_ANCHOR_P50_MS = 214_609

const WORKLOAD_STEP_MULTIPLIER = 4

const MEASURED_EVIDENCE_ASSUMPTION =
  "Easy prior anchored to dogfood wave1 actuals: T-067 312830ms (docs, 4 files) + T-068 116387ms (skills, 2 files), mean 214609ms; n=2, LOW confidence"

const GUESS_ASSUMPTION =
  "Normal/Hard/Extreme priors are a documented guess (x4 scope per workload step), not measured; workload-grouped baselines replace them as actuals accumulate"

const FLAT_TOKEN_ASSUMPTION =
  "token and shadow-cost priors remain flat across workloads: no measured token actuals yet"

function priorFor(durationP50Ms: number, extraAssumptions: string[]): ForecastPrior {
  return {
    durationP50Ms,
    durationP90Ms: 2 * durationP50Ms,
    inputTokensP50: 8_000,
    inputTokensP90: 16_000,
    outputTokensP50: 4_000,
    outputTokensP90: 8_000,
    cacheTokensP50: 1_000,
    cacheTokensP90: 2_000,
    shadowMicrosP50: 4_000_000,
    shadowMicrosP90: 8_000_000,
    assumptions: [MEASURED_EVIDENCE_ASSUMPTION, GUESS_ASSUMPTION, FLAT_TOKEN_ASSUMPTION, ...extraAssumptions]
  }
}

export const WORKLOAD_PRIORS: Record<Workload, ForecastPrior> = {
  Easy: priorFor(MEASURED_ANCHOR_P50_MS, ["Easy: measured anchor (wave1 mean), no multiplier applied"]),
  Normal: priorFor(MEASURED_ANCHOR_P50_MS * WORKLOAD_STEP_MULTIPLIER, ["Normal: measured anchor x4 (documented guess)"]),
  Hard: priorFor(MEASURED_ANCHOR_P50_MS * WORKLOAD_STEP_MULTIPLIER ** 2, ["Hard: measured anchor x16 (documented guess)"]),
  Extreme: priorFor(MEASURED_ANCHOR_P50_MS * WORKLOAD_STEP_MULTIPLIER ** 3, ["Extreme: measured anchor x64 (documented guess)"])
}

/** Workload assumed when a task declares none. */
export const DEFAULT_WORKLOAD: Workload = "Normal"

/**
 * Back-compat alias: the historical flat prior, now meaning "the Normal
 * workload prior". Consumers that imported `DEFAULT_PRIOR` keep working and
 * automatically pick up recalibration of the table.
 */
export const DEFAULT_PRIOR: ForecastPrior = WORKLOAD_PRIORS[DEFAULT_WORKLOAD]

const WORKLOAD_VALUES: readonly Workload[] = ["Easy", "Normal", "Hard", "Extreme"]

/**
 * Pick the prior for a declared workload. `undefined` (no declaration) falls
 * back to the default workload; an unrecognized string throws so a typo in a
 * caller cannot silently forecast with the wrong anchor.
 */
export function priorForWorkload(workload?: string | null): ForecastPrior {
  if (workload === undefined || workload === null) return WORKLOAD_PRIORS[DEFAULT_WORKLOAD]
  if ((WORKLOAD_VALUES as readonly string[]).includes(workload)) return WORKLOAD_PRIORS[workload as Workload]
  throw new Error(`Unknown workload: ${String(workload)}`)
}
