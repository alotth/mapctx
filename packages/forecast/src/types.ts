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

export type MeasuredDurations = DurationMeasures & {
  activeTimeCoverage: DurationCoverage
}

export type ForecastSample = {
  duration: DurationMeasures | MeasuredDurations
  usageEvents?: UsageEvent[]
  costEvents?: CostEvent[]
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
  prior?: Partial<ForecastPrior>
  assumptions?: string[]
}

export type EstimateBuildResult = EstimateSnapshot
