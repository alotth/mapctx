import type { TimeEvidence, TimeInterval } from "@mapctx/protocol"

export type IntervalPolicy = TimeEvidence["policy"]
export type OtherSessionActivity = { start: string; end: string; sessionId: string }
export const DEFAULT_INTERVAL_POLICY: IntervalPolicy = {
  idleThresholdMs: 10 * 60_000,
  reviewThresholdMs: 15 * 60_000,
  parkedThresholdMs: 2 * 60 * 60_000,
  timeZone: "UTC"
}

type Event = { at: number; id: string; kind: "prompt" | "tool" | "assistant" | "end" }

function humanPrompt(row: Record<string, unknown>): boolean {
  if (row.type !== "user") return false
  const message = row.message as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content === "string") return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some(block => block && typeof block === "object" && (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string" && ((block as { text: string }).text).trim().length > 0)
}

function dayKey(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
}

function classifyWait(start: number, end: number, policy: IntervalPolicy): TimeInterval["kind"] {
  if (dayKey(start, policy.timeZone) !== dayKey(end, policy.timeZone) || end - start > policy.parkedThresholdMs) return "parked"
  return end - start <= policy.reviewThresholdMs ? "review" : "human"
}

/** Claude JSONL -> timestamp-only evidence. Never returns message content. */
export function extractClaudeIntervals(jsonl: string, overrides: Partial<IntervalPolicy> = {}, otherActivity: readonly OtherSessionActivity[] = []): TimeEvidence {
  const policy = { ...DEFAULT_INTERVAL_POLICY, ...overrides }
  if (![policy.idleThresholdMs, policy.reviewThresholdMs, policy.parkedThresholdMs].every(value => Number.isInteger(value) && value > 0) ||
      policy.reviewThresholdMs >= policy.parkedThresholdMs) throw new Error("invalid interval thresholds")
  dayKey(0, policy.timeZone) // Validate zone once, even when transcript is empty.
  const sessions = new Map<string, Event[]>()
  const seen = new Set<string>()
  for (const [lineNumber, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try { row = JSON.parse(line) as Record<string, unknown> } catch { throw new Error(`invalid Claude JSONL line ${lineNumber + 1}`) }
    if (typeof row.sessionId !== "string" || !row.sessionId || typeof row.uuid !== "string" || !row.uuid || typeof row.timestamp !== "string") continue
    const at = Date.parse(row.timestamp)
    if (!Number.isFinite(at)) continue
    const key = `${row.sessionId}/${row.uuid}`
    if (seen.has(key)) continue
    seen.add(key)
    const message = row.message as { stop_reason?: unknown } | undefined
    const kind: Event["kind"] | null = humanPrompt(row) ? "prompt"
      : row.type === "user" ? "tool"
      : row.type === "assistant" && message?.stop_reason === "end_turn" ? "end"
      : row.type === "assistant" ? "assistant" : null
    if (!kind) continue
    const events = sessions.get(row.sessionId) ?? []
    events.push({ at, id: row.uuid, kind })
    sessions.set(row.sessionId, events)
  }
  const intervals: TimeInterval[] = []
  const sessionSpans: NonNullable<TimeEvidence["sessionSpans"]> = []
  for (const [sessionId, events] of sessions) {
    events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    if (events.length > 1 && events.at(-1)!.at > events[0].at) {
      sessionSpans.push({ start: new Date(events[0].at).toISOString(), end: new Date(events.at(-1)!.at).toISOString(), sessionId })
    }
    let owner: "agent" | "human" | null = null
    let prior: Event | null = null
    let humanStart: number | null = null
    for (const event of events) {
      if (prior && event.at > prior.at) {
        if (owner === "agent" && event.at - prior.at < policy.idleThresholdMs) {
          intervals.push({ start: new Date(prior.at).toISOString(), end: new Date(event.at).toISOString(), owner, kind: "active", sessionId })
        }
      }
      if (event.kind === "prompt") {
        if (humanStart !== null && event.at > humanStart) {
          const waitStart = humanStart
          const kind = classifyWait(waitStart, event.at, policy)
          const corroborated = kind === "parked" && otherActivity.some(activity => activity.sessionId !== sessionId &&
            Number.isFinite(Date.parse(activity.start)) && Number.isFinite(Date.parse(activity.end)) &&
            Date.parse(activity.end) > Date.parse(activity.start) &&
            Date.parse(activity.start) < event.at && Date.parse(activity.end) > waitStart)
          intervals.push({ start: new Date(waitStart).toISOString(), end: new Date(event.at).toISOString(), owner: "human", kind,
            confidence: corroborated ? "corroborated" : "inferred", sessionId })
        }
        humanStart = null
        owner = "agent"
      }
      if (event.kind === "end") { owner = "human"; humanStart = event.at }
      prior = event
    }
  }
  return { schemaVersion: 1, source: "claude-jsonl", policy, intervals, sessionSpans }
}
