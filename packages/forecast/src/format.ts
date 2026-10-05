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

// Re-export canonical planning parser from protocol so Forecast, Store, and
// CLI validate the exact same positive agent-active unit contract.
export {
  AGENT_ACTIVE_HOUR_MS,
  AGENT_ACTIVE_DAY_MS,
  AGENT_ACTIVE_WEEK_MS,
  parseEstimatedEffortMs
} from "@mapctx/protocol"
