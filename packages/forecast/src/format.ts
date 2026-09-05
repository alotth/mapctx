/**
 * Unit-honest duration presentation (T-065).
 *
 * Storage is milliseconds everywhere; the unit question is presentation only.
 * The unit is picked from the magnitude: minutes below an hour, hours below a
 * day, days beyond that. A 20-minute task never renders as "0.04d" and a
 * 3-day task never renders as "4320m".
 *
 * Deliberately NOT solved here: a Gantt axis that spans mixed magnitudes on
 * one scale (non-linear axis / grouping / zoom / per-wave scaling is a
 * documented open design problem). These are the formatting helpers only.
 */

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
/** Elapsed-time day (24h), because durations measure wall/active time, not working days. */
const DAY_MS = 24 * HOUR_MS

function compact(value: number): string {
  if (value >= 10) return String(Math.round(value))
  const fixed = value.toFixed(1)
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed
}

export function formatDurationMs(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "no data"
  if (value < MINUTE_MS) return "<1m"
  const minutes = value / MINUTE_MS
  if (minutes < 60) return `${compact(minutes)}m`
  const hours = value / HOUR_MS
  if (hours < 24) return `${compact(hours)}h`
  return `${compact(value / DAY_MS)}d`
}

/**
 * Disposition of authored `estimatedEffort` (T-065): it is parsed into
 * milliseconds and treated as a DECLARED PRIOR — a human-pace guess recorded
 * in human units, expected to overestimate agent-assisted work by roughly an
 * order of magnitude (this board measured ~28x). It is input for comparison
 * against actuals, never a measurement.
 *
 * Human working-day convention: 1d = 8h, 1w = 5d (the convention the authors
 * of "1w"/"3d" were reasoning in). Returns null for anything unparsable;
 * `estimatedEffort` is free text and junk must surface as null, not as a
 * fabricated duration.
 */
const HUMAN_HOUR_MS = 60 * 60 * 1000
const HUMAN_WORKING_DAY_MS = 8 * HUMAN_HOUR_MS
const HUMAN_WORKING_WEEK_MS = 5 * HUMAN_WORKING_DAY_MS

const EFFORT_PATTERN = /^(\d+(?:\.\d+)?)\s*(w|d|h|m)$/i

export function parseEstimatedEffortMs(value: string): number | null {
  const match = EFFORT_PATTERN.exec(value.trim())
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount < 0) return null
  switch (match[2].toLowerCase()) {
    case "w": return Math.round(amount * HUMAN_WORKING_WEEK_MS)
    case "d": return Math.round(amount * HUMAN_WORKING_DAY_MS)
    case "h": return Math.round(amount * HUMAN_HOUR_MS)
    case "m": return Math.round(amount * 60 * 1000)
    default: return null
  }
}
