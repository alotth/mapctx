import { randomUUID } from "node:crypto"
import { estimateSnapshotSchema, type EstimateSnapshot, type UsageEvent } from "@mapctx/protocol"
import { DEFAULT_WORKLOAD, priorForWorkload, WORKLOAD_PRIORS } from "./prior"
import type {
  DurationCoverage,
  EstimateBuildResult,
  EstimateOptions,
  ForecastPrior,
  ForecastSample,
  Workload,
  WorkloadBaseline
} from "./types"

export { DEFAULT_PRIOR, DEFAULT_WORKLOAD, priorForWorkload, WORKLOAD_PRIORS } from "./prior"

const DURATION_COVERAGE_PREFIX = "duration coverage: "

function quantile(values: number[], percentile: 0.5 | 0.9): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1)
  return Math.round(sorted[index])
}

function mergedPrior(options: EstimateOptions): ForecastPrior {
  const workloadPrior = priorForWorkload(options.workload)
  return {
    ...workloadPrior,
    ...options.prior,
    assumptions: options.prior?.assumptions ?? workloadPrior.assumptions
  }
}

function coverageOf(samples: readonly ForecastSample[]): UsageEvent["coverage"] {
  const events = samples.flatMap(sample => sample.usageEvents ?? [])
  if (events.length === 0) return "none"
  if (events.every(event => event.coverage === "full")) return "full"
  return "partial"
}

/**
 * Weakest-link coverage across the samples the forecast actually read. Any
 * substituted sample downgrades the whole estimate: one wall-clock stand-in is
 * enough to make the aggregate not a measurement.
 */
function durationCoverageOf(samples: readonly ForecastSample[]): DurationCoverage {
  if (samples.length === 0) return "none"
  const marks = samples.map(sample =>
    "activeTimeCoverage" in sample.duration ? sample.duration.activeTimeCoverage : "substituted"
  )
  if (marks.some(mark => mark === "none")) return "none"
  return marks.every(mark => mark === "measured") ? "measured" : "substituted"
}

function tokenValues(samples: readonly ForecastSample[], key: "inputTokens" | "outputTokens" | "cacheTokens"): number[] {
  return samples.map(sample => (sample.usageEvents ?? []).reduce((sum, event) => sum + event[key], 0)).filter(value => value > 0)
}

function shadowValues(samples: readonly ForecastSample[]): number[] {
  return samples
    .filter(sample => (sample.costEvents ?? []).length > 0)
    .map(sample => (sample.costEvents ?? []).reduce((sum, event) => sum + event.shadowMicros, 0))
    .filter(value => value >= 0)
}

function p50p90(values: number[], prior50: number, prior90: number): [number, number] {
  return values.length === 0 ? [prior50, prior90] : [quantile(values, 0.5), quantile(values, 0.9)]
}

/** Build immutable, provenance-rich P50/P90 snapshot. No ML; fallback is explicit prior. */
export function buildEstimateSnapshot(
  taskId: string,
  samples: readonly ForecastSample[] = [],
  options: EstimateOptions = {}
): EstimateBuildResult {
  const prior = mergedPrior(options)
  const minSamples = options.minHistoricalSamples ?? 1
  const useHistory = samples.length >= minSamples && samples.length > 0
  const historical = useHistory ? samples : []
  // Workload grouping: when a workload is declared, prefer same-workload
  // samples. An Extreme task must not silently inherit an Easy task's
  // actuals; if none match, fall back to the full pool and say so.
  const sameWorkload = options.workload === undefined
    ? historical
    : historical.filter(sample => sample.workload === options.workload)
  const pool = sameWorkload.length > 0 ? sameWorkload : historical
  const durations = p50p90(pool.map(sample => sample.duration.activeTimeMs), prior.durationP50Ms, prior.durationP90Ms)
  const inputs = p50p90(tokenValues(pool, "inputTokens"), prior.inputTokensP50, prior.inputTokensP90)
  const outputs = p50p90(tokenValues(pool, "outputTokens"), prior.outputTokensP50, prior.outputTokensP90)
  const caches = p50p90(tokenValues(pool, "cacheTokens"), prior.cacheTokensP50, prior.cacheTokensP90)
  const shadows = p50p90(shadowValues(pool), prior.shadowMicrosP50, prior.shadowMicrosP90)
  // Forecast reads activeTimeMs by ADR decision. If the samples it read were
  // themselves substituted wall clock (receipt-only, no interior timestamps),
  // the estimate silently inherits idle time — so say so on the snapshot rather
  // than leave it indistinguishable from a measured forecast. See T-064.
  const durationCoverage = durationCoverageOf(pool)
  const assumptions = [
    ...(!useHistory ? [
      `prior: workload-aware ${options.workload ?? DEFAULT_WORKLOAD} prior (durationP50 ${prior.durationP50Ms}ms, durationP90 ${prior.durationP90Ms}ms); a declared starting guess, not a measurement`,
      "historical actuals unavailable or below minimum sample count; conservative prior used"
    ] : []),
    ...(useHistory && options.workload !== undefined && sameWorkload.length === 0
      ? [`no samples declared workload ${options.workload}; all ${historical.length} sample(s) used ungrouped`]
      : []),
    `forecast input: activeTimeMs; idle threshold ${options.idleThresholdMs ?? 600_000}ms`,
    `duration coverage: ${durationCoverage}${durationCoverage === "substituted"
      ? " (activeTime stood in for wall clock; idle time not excluded)"
      : ""}`,
    "cost forecast uses shadowMicros; allocatedMicros excluded",
    ...prior.assumptions,
    ...(options.assumptions ?? [])
  ]
  const snapshot = estimateSnapshotSchema.parse({
    estimateId: options.estimateId ?? randomUUID(),
    taskId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    method: useHistory ? "historical-baseline" : "expert-guess",
    confidence: useHistory && pool.length >= 3 ? "medium" : "low",
    estimatorVersion: options.estimatorVersion ?? "forecast-v1",
    idleThresholdMs: options.idleThresholdMs ?? 600_000,
    costCoverage: coverageOf(historical),
    durationCoverage,
    durationP50Ms: durations[0],
    durationP90Ms: durations[1],
    inputTokensP50: inputs[0],
    inputTokensP90: inputs[1],
    outputTokensP50: outputs[0],
    outputTokensP90: outputs[1],
    cacheTokensP50: caches[0],
    cacheTokensP90: caches[1],
    shadowMicrosP50: shadows[0],
    shadowMicrosP90: shadows[1],
    assumptions
  })
  return Object.freeze({
    ...snapshot,
    assumptions: Object.freeze([...snapshot.assumptions])
  }) as EstimateBuildResult
}

export const createEstimateSnapshot = buildEstimateSnapshot
export const percentile = quantile

/**
 * Legacy helper for snapshots written before explicit `durationCoverage` was
 * added. New consumers should read `snapshot.durationCoverage` directly.
 */
export function durationCoverageFromAssumptions(assumptions: readonly string[]): DurationCoverage {
  const line = assumptions.find(assumption => assumption.startsWith(DURATION_COVERAGE_PREFIX))
  const value = line?.slice(DURATION_COVERAGE_PREFIX.length).split(" ")[0]
  return value === "measured" || value === "substituted" || value === "none" ? value : "none"
}

/** True when the snapshot fell back to the conservative prior for lack of historical samples. */
export function isPriorFallbackEstimate(snapshot: Pick<EstimateSnapshot, "method">): boolean {
  return snapshot.method === "expert-guess"
}

/**
 * History-derived duration baselines, grouped by declared workload, so
 * "how long does an Extreme task take here" is answerable instead of averaging
 * across all difficulties. Samples without a declared workload are excluded —
 * a baseline without its workload class is exactly the workload-blind average
 * this replaces. Workloads with no samples are absent from the result.
 */
export function workloadBaselines(samples: readonly ForecastSample[]): WorkloadBaseline[] {
  const byWorkload = new Map<Workload, number[]>()
  for (const sample of samples) {
    if (sample.workload === undefined) continue
    const durations = byWorkload.get(sample.workload) ?? []
    durations.push(sample.duration.activeTimeMs)
    byWorkload.set(sample.workload, durations)
  }
  return [...byWorkload.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([workload, durations]) => ({
      workload,
      sampleCount: durations.length,
      durationP50Ms: quantile(durations, 0.5),
      durationP90Ms: quantile(durations, 0.9)
    }))
}
