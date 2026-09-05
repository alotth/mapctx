import type {
  CostEvent,
  DurationMeasures,
  EstimateSnapshot,
  UsageEvent
} from "@mapctx/protocol"

export type Timestamp = string | number | Date

export type Session = {
  timestamps: Timestamp[]
  startedAt?: Timestamp
  endedAt?: Timestamp
}

export type SessionInterval = {
  startedAt: Timestamp
  endedAt: Timestamp
}

export type DurationInput = {
  sessions: Session[]
  /** Optional calendar boundaries. If absent, lead time is zero. */
  readyAt?: Timestamp
  doneAt?: Timestamp
  idleThresholdMs?: number
}

/**
 * Whether `activeTimeMs` was derived from real intra-run timestamps or stood in
 * for them. `RunReceipt` carries only `startedAt`/`endedAt`, so a receipt-only
 * measurement cannot subtract idle gaps and reports wall clock instead. Callers
 * must be able to tell the two apart: an unlabeled substituted value would let a
 * forecast inherit overnight idle time while claiming to exclude it.
 *
 * - `measured`    — at least one session supplied timestamps beyond its boundaries.
 * - `substituted` — only boundaries were available; `activeTimeMs === sessionWallClockMs`.
 * - `none`        — no usable timestamps at all; durations are zero.
 *
 * See T-064 for persisting `RunEvent` timestamps so `measured` becomes reachable.
 */
export type DurationCoverage = "measured" | "substituted" | "none"

/**
 * Declared task difficulty, mirroring the protocol's `workload` enum. The one
 * signal available before any history exists for a task.
 */
export type Workload = "Easy" | "Normal" | "Hard" | "Extreme"

export type MeasuredDurations = DurationMeasures & {
  activeTimeCoverage: DurationCoverage
}

export type ForecastSample = {
  duration: DurationMeasures | MeasuredDurations
  usageEvents?: UsageEvent[]
  costEvents?: CostEvent[]
  /** Declared workload of the task this sample came from, when known. */
  workload?: Workload
}

export type ForecastPrior = {
  durationP50Ms: number
  durationP90Ms: number
  inputTokensP50: number
  inputTokensP90: number
  outputTokensP50: number
  outputTokensP90: number
  cacheTokensP50: number
  cacheTokensP90: number
  shadowMicrosP50: number
  shadowMicrosP90: number
  assumptions: string[]
}

export type EstimateOptions = {
  estimateId?: string
  createdAt?: string
  estimatorVersion?: string
  idleThresholdMs?: number
  minHistoricalSamples?: number
  /** Declared task difficulty; picks the workload-aware prior. */
  workload?: Workload
  prior?: Partial<ForecastPrior>
  assumptions?: string[]
}

/**
 * History-derived duration quantiles for one workload class, the calibrated
 * replacement for the vendored prior table once actuals accumulate.
 */
export type WorkloadBaseline = {
  workload: Workload
  sampleCount: number
  durationP50Ms: number
  durationP90Ms: number
}

export type EstimateBuildResult = EstimateSnapshot
