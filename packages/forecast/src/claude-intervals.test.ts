import assert from "node:assert/strict"
import test from "node:test"
import { runReceiptSchema } from "@mapctx/protocol"
import { extractClaudeIntervals } from "./claude-intervals"
import { durationMeasuresFromReceipt, measureDurations } from "./duration"
import { buildEstimateSnapshot } from "./estimate"

const at = (day: number, hour: number, minute: number) => `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`
const row = (sessionId: string, uuid: string, timestamp: string, type: string, content: unknown, stop_reason?: string) =>
  JSON.stringify({ sessionId, uuid, timestamp, type, message: { content, stop_reason } })

const receipt = {
  schemaVersion: 1, dispatchId: "d864832b-b91c-4199-b90d-489899ce526f", attempt: 1,
  outcome: "completed" as const, startedAt: at(1, 9, 0), endedAt: at(2, 9, 0),
  changedFiles: [], usageEvents: [], evidence: [], failure: null
}

test("Claude prompt/end ownership, tool results, overnight parking, privacy", () => {
  const jsonl = [
    row("s1", "a", at(1, 9, 0), "user", "private prompt"),
    row("s1", "b", at(1, 9, 2), "assistant", [{ type: "text", text: "private answer" }]),
    row("s1", "c", at(1, 9, 3), "user", [{ type: "tool_result", content: "private tool" }]),
    row("s1", "d", at(1, 9, 5), "assistant", [], "end_turn"),
    row("s1", "e", at(1, 9, 6), "user", [{ type: "tool_result", content: "late tool" }]),
    row("s1", "f", at(2, 9, 0), "user", [{ type: "text", text: "private next prompt" }])
  ].join("\n")
  const evidence = extractClaudeIntervals(jsonl)
  assert.equal(evidence.intervals.filter(item => item.owner === "agent").length, 3)
  assert.equal(evidence.intervals.filter(item => item.owner === "human").length, 1)
  assert.equal(evidence.intervals.at(-1)?.kind, "parked")
  assert.equal(evidence.intervals.at(-1)?.confidence, "inferred")
  const corroborated = extractClaudeIntervals(jsonl, {}, [{ start: at(1, 10, 0), end: at(1, 11, 0), sessionId: "s2" }])
  assert.equal(corroborated.intervals.at(-1)?.confidence, "corroborated")
  assert.equal(JSON.stringify(evidence).includes("private"), false)
  const parsed = runReceiptSchema.parse({ ...receipt, timeEvidence: evidence })
  const measured = durationMeasuresFromReceipt(parsed.startedAt, parsed.endedAt, { timeEvidence: parsed.timeEvidence })
  assert.equal(measured.activeTimeMs, 5 * 60_000)
  assert.equal(measured.parkedTimeMs, (23 * 60 + 55) * 60_000)
  assert.equal(measured.activeTimeCoverage, "measured")
})

test("overlapping sessions union once with agent ownership priority", () => {
  const jsonl = [
    row("s1", "a", at(1, 9, 0), "user", "A"),
    row("s1", "b", at(1, 9, 5), "assistant", "", "end_turn"),
    row("s1", "c", at(1, 9, 15), "user", "B"),
    row("s2", "d", at(1, 9, 3), "user", "C"),
    row("s2", "e", at(1, 9, 8), "assistant", "", "end_turn")
  ].join("\n")
  const evidence = extractClaudeIntervals(jsonl)
  const measured = measureDurations({ sessions: [{ timestamps: [at(1, 9, 0), at(1, 9, 15)] }], timeEvidence: evidence })
  assert.equal(measured.activeTimeMs, 8 * 60_000)
  assert.equal(measured.humanTimeMs, 7 * 60_000)
  assert.equal(measured.taskDurationMs, 15 * 60_000)
})

test("human-only evidence measures human wait but cannot calibrate agent time", () => {
  const evidence = extractClaudeIntervals([
    row("s1", "a", at(1, 9, 0), "assistant", "", "end_turn"),
    row("s1", "b", at(1, 9, 30), "user", "next prompt")
  ].join("\n"))
  const duration = durationMeasuresFromReceipt(at(1, 9, 0), at(1, 9, 30), { timeEvidence: evidence, readyAt: at(1, 9, 0) })
  assert.equal(duration.activeTimeMs, 0)
  assert.equal(duration.activeTimeCoverage, "none")
  assert.equal(duration.humanTimeMs, 30 * 60_000)
  assert.equal(duration.taskDurationMs, 30 * 60_000)
  assert.equal(duration.leadTimeMs, 30 * 60_000)
  const forecast = buildEstimateSnapshot("T-100", [{ duration, workload: "Hard" }], {
    workload: "Hard", estimateId: "f2345678-90ab-4cde-8f01-23456789abcd", createdAt: at(1, 12, 0)
  })
  assert.equal(forecast.method, "expert-guess")
  assert.equal(forecast.durationCoverage, "none")
  assert.ok(forecast.durationP50Ms > 0)
})

test("session spans retain idle gap; task duration unions disjoint and overlapping sessions", () => {
  const evidence = extractClaudeIntervals([
    row("s1", "a", at(1, 9, 0), "user", "prompt"),
    row("s1", "b", at(1, 9, 5), "assistant", "working"),
    row("s1", "c", at(1, 10, 0), "assistant", "resumed"),
    row("s1", "d", at(1, 10, 5), "assistant", "done", "end_turn"),
    row("s2", "e", at(1, 9, 2), "user", "overlap"),
    row("s2", "f", at(1, 9, 7), "assistant", "done", "end_turn"),
    row("s3", "g", at(1, 11, 0), "user", "later"),
    row("s3", "h", at(1, 11, 5), "assistant", "done", "end_turn")
  ].join("\n"))
  const duration = durationMeasuresFromReceipt(at(1, 9, 0), at(1, 11, 5), { timeEvidence: evidence })
  assert.equal(duration.activeTimeMs, 17 * 60_000)
  assert.equal(duration.sessionWallClockMs, 75 * 60_000)
  assert.equal(duration.taskDurationMs, 70 * 60_000)
  assert.equal(duration.activeTimeCoverage, "measured")
  // Receipt bounds (Oct 1 09:00 - Oct 2 09:00) encompass all session spans (latest 11:05),
  // so schema validation correctly succeeds.
  assert.equal(runReceiptSchema.safeParse({ ...receipt, timeEvidence: evidence }).success, true)
})

test("reversed or invalid other-session activity never corroborates parked time", () => {
  const jsonl = [
    row("s1", "a", at(1, 9, 0), "assistant", "", "end_turn"),
    row("s1", "b", at(1, 12, 0), "user", "next")
  ].join("\n")
  for (const activity of [
    { start: at(1, 11, 0), end: at(1, 10, 0), sessionId: "s2" },
    { start: at(1, 10, 0), end: at(1, 10, 0), sessionId: "s2" },
    { start: "bad", end: at(1, 10, 0), sessionId: "s2" },
    { start: at(1, 13, 0), end: at(1, 14, 0), sessionId: "s2" }
  ]) assert.equal(extractClaudeIntervals(jsonl, {}, [activity]).intervals[0].confidence, "inferred")
  assert.equal(extractClaudeIntervals(jsonl, {}, [{ start: at(1, 10, 0), end: at(1, 11, 0), sessionId: "s2" }]).intervals[0].confidence, "corroborated")
})

test("old, empty, malformed, and out-of-bounds evidence never claims measurement", () => {
  const old = runReceiptSchema.parse(receipt)
  assert.equal(durationMeasuresFromReceipt(old.startedAt, old.endedAt).activeTimeCoverage, "substituted")
  const empty = extractClaudeIntervals("")
  assert.equal(durationMeasuresFromReceipt(receipt.startedAt, receipt.endedAt, { timeEvidence: empty }).activeTimeCoverage, "substituted")
  assert.equal(runReceiptSchema.safeParse({ ...receipt, timeEvidence: { ...empty, intervals: [{ start: at(1, 8, 0), end: at(1, 8, 1), owner: "agent", kind: "active" }] } }).success, false)
  assert.equal(runReceiptSchema.safeParse({ ...receipt, timeEvidence: { ...empty, policy: { ...empty.policy, timeZone: "not-a-zone" } } }).success, false)
  assert.equal(durationMeasuresFromReceipt(receipt.startedAt, receipt.endedAt, { timeEvidence: { ...empty, intervals: [{ start: "bad", end: "bad", owner: "agent", kind: "active" }] } as never }).activeTimeCoverage, "substituted")
})
