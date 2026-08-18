import assert from "node:assert/strict"
import test from "node:test"
import { allocateMicros, costEventFromUsage } from "./cost"
import { activeTimeMs, durationMeasuresFromReceipt, measureDurations } from "./duration"
import { buildEstimateSnapshot } from "./estimate"

const usage = {
  usageEventId: "11111111-2222-4333-8444-555555555555",
  dispatchId: "9b2e4d71-6c18-4a0f-b3d5-11aa22bb33cc",
  provider: "anthropic",
  model: "claude-sonnet",
  inputTokens: 100,
  cacheTokens: 20,
  outputTokens: 80,
  source: "harness-transcript" as const,
  coverage: "full" as const
}

test("active time excludes idle gaps and task duration unions sessions", () => {
  assert.equal(activeTimeMs([
    "2026-08-17T10:00:00.000Z",
    "2026-08-17T10:05:00.000Z",
    "2026-08-17T12:00:00.000Z",
    "2026-08-17T12:05:00.000Z"
  ]), 10 * 60 * 1000)
  const duration = measureDurations({
    sessions: [
      { timestamps: ["2026-08-17T10:00:00.000Z", "2026-08-17T10:05:00.000Z"] },
      { timestamps: ["2026-08-17T10:03:00.000Z", "2026-08-17T10:10:00.000Z"] }
    ],
    readyAt: "2026-08-17T09:00:00.000Z",
    doneAt: "2026-08-17T12:00:00.000Z"
  })
  assert.equal(duration.taskDurationMs, 10 * 60 * 1000)
  assert.equal(duration.leadTimeMs, 3 * 60 * 60 * 1000)
})

test("shadow cost is priced independently from cash billing and allocation", () => {
  const cost = costEventFromUsage(usage, { billingType: "subscription_included", cashCents: 0 })
  assert.equal(cost.shadowMicros, 60_000)
  assert.equal(cost.cashCents, 0)
  const allocated = allocateMicros([cost], {
    planPeriodId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    biller: "anthropic",
    planName: "pro",
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
    fixedCents: 1000,
    seats: 1,
    status: "open"
  })
  assert.equal(allocated[0].allocatedMicros, 10_000_000)
  assert.equal(allocated[0].costStatus, "allocated")
})

test("estimate fallback declares low confidence and uses active time prior", () => {
  const estimate = buildEstimateSnapshot("T-054", [], {
    estimateId: "12345678-90ab-4cde-8f01-23456789abcd",
    createdAt: "2026-08-17T00:00:00.000Z"
  })
  assert.equal(estimate.method, "expert-guess")
  assert.equal(estimate.confidence, "low")
  assert.equal(estimate.costCoverage, "none")
  assert.match(estimate.assumptions[0], /prior/)
  assert.ok(Object.isFrozen(estimate))
  assert.ok(Object.isFrozen(estimate.assumptions))
})

test("receipt-only durations report substituted coverage, never measured", () => {
  // A RunReceipt carries only startedAt/endedAt. Two hours elapsed with no
  // interior timestamps: there is nothing to subtract, so active time equals
  // wall clock and must say so.
  const measures = durationMeasuresFromReceipt(
    "2026-08-17T09:00:00.000Z",
    "2026-08-17T11:00:00.000Z"
  )
  assert.equal(measures.activeTimeCoverage, "substituted")
  assert.equal(measures.activeTimeMs, measures.sessionWallClockMs)
  assert.equal(measures.activeTimeMs, 2 * 60 * 60 * 1000)
})

test("interior timestamps yield measured coverage and exclude the idle gap", () => {
  // Five minutes of work, an eight-hour overnight gap, five more minutes. Wall
  // clock says 8h10m; active time must say 10m. Gaps are held below the
  // 10-minute threshold, which is exclusive (`gap < threshold`).
  const measures = measureDurations({
    sessions: [{
      timestamps: [
        "2026-08-17T17:00:00.000Z",
        "2026-08-17T17:05:00.000Z",
        "2026-08-18T01:05:00.000Z",
        "2026-08-18T01:10:00.000Z"
      ]
    }]
  })
  assert.equal(measures.activeTimeCoverage, "measured")
  assert.equal(measures.activeTimeMs, 10 * 60 * 1000)
  assert.equal(measures.sessionWallClockMs, (8 * 60 + 10) * 60 * 1000)
  assert.ok(measures.activeTimeMs < measures.sessionWallClockMs)
})

test("idle threshold is exclusive: a gap exactly at the threshold is idle", () => {
  const measures = measureDurations({
    sessions: [{ timestamps: [
      "2026-08-17T09:00:00.000Z",
      "2026-08-17T09:10:00.000Z",
      "2026-08-17T09:19:00.000Z"
    ] }]
  })
  // First gap is exactly 10 minutes and is excluded; second is 9 and counts.
  assert.equal(measures.activeTimeMs, 9 * 60 * 1000)
})

test("no usable timestamps report coverage none", () => {
  assert.equal(measureDurations({ sessions: [] }).activeTimeCoverage, "none")
})

test("estimate built on substituted samples says so in assumptions", () => {
  const estimate = buildEstimateSnapshot(
    "T-054",
    [{ duration: durationMeasuresFromReceipt("2026-08-17T09:00:00.000Z", "2026-08-17T11:00:00.000Z") }],
    { estimateId: "22345678-90ab-4cde-8f01-23456789abcd", createdAt: "2026-08-17T00:00:00.000Z" }
  )
  const coverage = estimate.assumptions.find(line => line.startsWith("duration coverage:"))
  assert.ok(coverage, "estimate must state its duration coverage")
  assert.match(coverage, /substituted/)
  assert.match(coverage, /idle time not excluded/)
})

test("one substituted sample downgrades an otherwise measured estimate", () => {
  const measured = measureDurations({
    sessions: [{ timestamps: [
      "2026-08-17T09:00:00.000Z",
      "2026-08-17T09:05:00.000Z",
      "2026-08-17T09:10:00.000Z"
    ] }]
  })
  const substituted = durationMeasuresFromReceipt("2026-08-17T09:00:00.000Z", "2026-08-17T11:00:00.000Z")
  const estimate = buildEstimateSnapshot(
    "T-054",
    [{ duration: measured }, { duration: substituted }],
    { estimateId: "32345678-90ab-4cde-8f01-23456789abcd", createdAt: "2026-08-17T00:00:00.000Z" }
  )
  const coverage = estimate.assumptions.find(line => line.startsWith("duration coverage:"))
  assert.match(coverage ?? "", /substituted/)
})
