/**
 * Canonical `estimatedEffort` convention (T-099).
 *
 * New values declare agent active time, excluding human waits, review queues,
 * and other wall/lead time. Historic values without an explicit source stay
 * legacy-human; this parser only validates and converts the textual duration.
 */
export const AGENT_ACTIVE_HOUR_MS = 60 * 60 * 1000
export const AGENT_ACTIVE_DAY_MS = 8 * AGENT_ACTIVE_HOUR_MS
export const AGENT_ACTIVE_WEEK_MS = 5 * AGENT_ACTIVE_DAY_MS

const EFFORT_PATTERN = /^(\d+(?:\.\d+)?)\s*(w|d|h|m)$/i

/** Parse a strictly positive agent-active duration, or null when invalid. */
export function parseEstimatedEffortMs(value: string): number | null {
  const match = EFFORT_PATTERN.exec(value.trim())
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null
  const unitMs = {
    w: AGENT_ACTIVE_WEEK_MS,
    d: AGENT_ACTIVE_DAY_MS,
    h: AGENT_ACTIVE_HOUR_MS,
    m: 60 * 1000
  }[match[2].toLowerCase()]
  if (!unitMs) return null
  const durationMs = Math.round(amount * unitMs)
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null
}
