import type { DurationCoverage, DurationInput, MeasuredDurations, Session, SessionInterval, Timestamp } from "./types"
import type { RunEvent } from "@mapctx/protocol"

export const DEFAULT_IDLE_THRESHOLD_MS = 10 * 60 * 1000

export function timestampMs(value: Timestamp): number {
  const result = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value)
  if (!Number.isFinite(result)) throw new Error(`Invalid timestamp: ${String(value)}`)
  return result
}

function orderedTimestamps(values: Timestamp[]): number[] {
  return values.map(timestampMs).sort((a, b) => a - b)
}

/** First-to-last elapsed time for one dispatch/session. */
export function sessionWallClockMs(timestamps: Timestamp[]): number {
  const ordered = orderedTimestamps(timestamps)
  return ordered.length < 2 ? 0 : Math.max(0, ordered[ordered.length - 1] - ordered[0])
}

/** Sum only inter-event gaps below idle threshold. */
export function activeTimeMs(timestamps: Timestamp[], idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS): number {
  if (!Number.isInteger(idleThresholdMs) || idleThresholdMs <= 0) {
    throw new Error("idleThresholdMs must be a positive integer")
  }
  const ordered = orderedTimestamps(timestamps)
  let active = 0
  for (let i = 1; i < ordered.length; i += 1) {
    const gap = ordered[i] - ordered[i - 1]
    if (gap >= 0 && gap < idleThresholdMs) active += gap
  }
  return active
}

export function intervalDurationMs(interval: SessionInterval): number {
  return Math.max(0, timestampMs(interval.endedAt) - timestampMs(interval.startedAt))
}

/** Duration of union of intervals; overlapping sessions count once. */
export function unionDurationMs(intervals: SessionInterval[]): number {
  const ordered = intervals
    .map(interval => ({ start: timestampMs(interval.startedAt), end: timestampMs(interval.endedAt) }))
    .filter(interval => interval.end >= interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  let total = 0
  let current: { start: number; end: number } | undefined
  for (const interval of ordered) {
    if (!current) {
      current = interval
    } else if (interval.start <= current.end) {
      current.end = Math.max(current.end, interval.end)
    } else {
      total += current.end - current.start
      current = interval
    }
  }
  if (current) total += current.end - current.start
  return total
}

function sessionInterval(session: Session): SessionInterval | undefined {
  const values = session.timestamps.length > 0 ? orderedTimestamps(session.timestamps) : []
  const start = session.startedAt === undefined ? values[0] : timestampMs(session.startedAt)
  const end = session.endedAt === undefined ? values[values.length - 1] : timestampMs(session.endedAt)
  if (start === undefined || end === undefined) return undefined
  return { startedAt: start, endedAt: end }
}

/**
 * Compute all four ADR measures. Task duration is interval union, never max-min.
 *
 * `activeTimeCoverage` reports whether idle subtraction actually happened. A
 * session that supplies only its two boundaries cannot have gaps subtracted, so
 * its active time degenerates to wall clock; that is reported as `substituted`
 * rather than passed off as a measurement.
 */
export function measureDurations(input: DurationInput): MeasuredDurations {
  const idleThresholdMs = input.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS
  if (!Number.isInteger(idleThresholdMs) || idleThresholdMs <= 0) {
    throw new Error("idleThresholdMs must be a positive integer")
  }
  const intervals: SessionInterval[] = []
  let sessionWallClock = 0
  let activeTime = 0
  let observedAny = false
  let interiorAny = false
  for (const session of input.sessions) {
    const observedTimestamps = session.timestamps.length > 0
      ? session.timestamps
      : session.startedAt !== undefined && session.endedAt !== undefined
        ? [session.startedAt, session.endedAt]
        : []
    if (observedTimestamps.length > 0) observedAny = true
    // More than two timestamps means real intra-run events exist, so the gaps
    // between them are meaningful and idle time can genuinely be excluded.
    if (session.timestamps.length > 2) interiorAny = true
    sessionWallClock += sessionWallClockMs(observedTimestamps)
    activeTime += activeTimeMs(observedTimestamps, idleThresholdMs)
    const interval = sessionInterval(session)
    if (interval) intervals.push(interval)
  }
  const leadTime = input.readyAt === undefined || input.doneAt === undefined
    ? 0
    : Math.max(0, timestampMs(input.doneAt) - timestampMs(input.readyAt))
  const activeTimeCoverage: DurationCoverage = !observedAny
    ? "none"
    : interiorAny
      ? "measured"
      : "substituted"
  return {
    sessionWallClockMs: Math.round(sessionWallClock),
    activeTimeMs: Math.round(activeTime),
    taskDurationMs: Math.round(unionDurationMs(intervals)),
    leadTimeMs: Math.round(leadTime),
    idleThresholdMs,
    activeTimeCoverage
  }
}

/**
 * Durations for a `RunReceipt`, which carries only `startedAt`/`endedAt`.
 *
 * With no interior timestamps there are no gaps to subtract, so active time
 * equals wall clock. This is always reported as `activeTimeCoverage:
 * "substituted"` — the value is a stand-in, and a consumer forecasting on it is
 * inheriting whatever idle time the run contained. T-064 persists `RunEvent`
 * timestamps so this path can report `measured` instead.
 */
export function durationMeasuresFromReceipt(
  startedAt: Timestamp,
  endedAt: Timestamp,
  options: { readyAt?: Timestamp; idleThresholdMs?: number; events?: readonly Pick<RunEvent, "timestamp">[] } = {}
): MeasuredDurations {
  const startedMs = timestampMs(startedAt)
  const endedMs = timestampMs(endedAt)
  // Receipt boundaries define run scope. Boundary and late/out-of-range
  // events cannot prove intra-run activity and must not alter wall clock.
  const interiorEvents = (options.events ?? []).filter(event => {
    const eventMs = timestampMs(event.timestamp)
    return eventMs > startedMs && eventMs < endedMs
  })
  const session: Session = {
    timestamps: [startedAt, ...interiorEvents.map(event => event.timestamp), endedAt]
  }
  const measured = measureDurations({
    sessions: [session],
    readyAt: options.readyAt,
    doneAt: endedAt,
    idleThresholdMs: options.idleThresholdMs
  })
  return interiorEvents.length > 0
    ? measured
    : { ...measured, activeTimeMs: measured.sessionWallClockMs, activeTimeCoverage: "substituted" }
}

export const computeDurationMeasures = measureDurations
export const calculateActiveTimeMs = activeTimeMs
export const calculateTaskDurationMs = unionDurationMs
