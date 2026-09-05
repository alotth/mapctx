import assert from "node:assert/strict"
import test from "node:test"
import { allocateMicros, costEventFromUsage } from "./cost"
import { activeTimeMs, durationMeasuresFromReceipt, measureDurations } from "./duration"
import { buildEstimateSnapshot, durationCoverageFromAssumptions, isPriorFallbackEstimate, workloadBaselines } from "./estimate"
import { MEASURED_ANCHOR_P50_MS, WORKLOAD_PRIORS } from "./prior"

/** Measured sample with `minutes` of active time, gaps kept under a 3h idle threshold. */
function measuredDurations(minutes: number) {
  const base = Date.parse("2026-08-17T09:00:00.000Z")
  const at = (offset: number) => new Date(base + offset * 60_000).toISOString()
  return measureDurations({
    sessions: [{ timestamps: [at(0), at(minutes / 2), at(minutes)] }],
    idleThresholdMs: 3 * 60 * 60 * 1000
  })
}

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

test("only strictly interior run events establish measured coverage", () => {
  const measures = durationMeasuresFromReceipt(
    "2026-08-17T09:00:00.000Z",
    "2026-08-17T11:00:00.000Z",
    { events: [
      { timestamp: "2026-08-17T08:59:59.000Z" },
      { timestamp: "2026-08-17T09:00:00.000Z" },
      { timestamp: "2026-08-17T09:05:00.000Z" },
      { timestamp: "2026-08-17T11:00:00.000Z" },
      { timestamp: "2026-08-17T11:00:01.000Z" }
    ] }
  )
  assert.equal(measures.activeTimeCoverage, "measured")
  assert.equal(measures.activeTimeMs, 5 * 60 * 1000)
  assert.equal(measures.sessionWallClockMs, 2 * 60 * 60 * 1000)
})

test("boundary-only and out-of-range run events remain wall-clock substitution", () => {
  const measures = durationMeasuresFromReceipt(
    "2026-08-17T09:00:00.000Z",
    "2026-08-17T11:00:00.000Z",
    { events: [
      { timestamp: "2026-08-17T08:59:59.000Z" },
      { timestamp: "2026-08-17T09:00:00.000Z" },
      { timestamp: "2026-08-17T11:00:00.000Z" },
      { timestamp: "2026-08-17T11:00:01.000Z" }
    ] }
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

test("durationCoverageFromAssumptions reads the coverage back out of a real snapshot", () => {
  const noSamples = buildEstimateSnapshot("T-055", [], {
    estimateId: "42345678-90ab-4cde-8f01-23456789abcd",
    createdAt: "2026-08-17T00:00:00.000Z"
  })
  assert.equal(durationCoverageFromAssumptions(noSamples.assumptions), "none")

  const substitutedSamples = buildEstimateSnapshot(
    "T-055",
    [{ duration: durationMeasuresFromReceipt("2026-08-17T09:00:00.000Z", "2026-08-17T11:00:00.000Z") }],
    { estimateId: "52345678-90ab-4cde-8f01-23456789abcd", createdAt: "2026-08-17T00:00:00.000Z" }
  )
  assert.equal(durationCoverageFromAssumptions(substitutedSamples.assumptions), "substituted")

  const measuredSamples = buildEstimateSnapshot(
    "T-055",
    [{ duration: measureDurations({ sessions: [{ timestamps: ["2026-08-17T09:00:00.000Z", "2026-08-17T09:05:00.000Z", "2026-08-17T09:10:00.000Z"] }] }) }],
    { estimateId: "62345678-90ab-4cde-8f01-23456789abcd", createdAt: "2026-08-17T00:00:00.000Z" }
  )
  assert.equal(durationCoverageFromAssumptions(measuredSamples.assumptions), "measured")
})

test("durationCoverageFromAssumptions defaults to none for missing or malformed assumptions", () => {
  assert.equal(durationCoverageFromAssumptions([]), "none")
  assert.equal(durationCoverageFromAssumptions(["unrelated assumption"]), "none")
})

test("isPriorFallbackEstimate flags estimates with no historical samples", () => {
  const fallback = buildEstimateSnapshot("T-055", [], {
    estimateId: "72345678-90ab-4cde-8f01-23456789abcd",
    createdAt: "2026-08-17T00:00:00.000Z"
  })
  assert.equal(isPriorFallbackEstimate(fallback), true)

  const historical = buildEstimateSnapshot(
    "T-055",
    [{ duration: measureDurations({ sessions: [{ timestamps: ["2026-08-17T09:00:00.000Z", "2026-08-17T09:05:00.000Z", "2026-08-17T09:10:00.000Z"] }] }) }],
    { estimateId: "82345678-90ab-4cde-8f01-23456789abcd", createdAt: "2026-08-17T00:00:00.000Z" }
  )
  assert.equal(isPriorFallbackEstimate(historical), false)
})

test("prior-derived estimates vary by declared workload", () => {
  const base = {
    estimateId: "a2345678-90ab-4cde-8f01-23456789abcd",
    createdAt: "2026-09-05T00:00:00.000Z"
  }
  const easy = buildEstimateSnapshot("T-001", [], { ...base, workload: "Easy" })
  const extreme = buildEstimateSnapshot("T-001", [], { ...base, workload: "Extreme" })
  assert.equal(easy.durationP50Ms, WORKLOAD_PRIORS.Easy.durationP50Ms)
  assert.equal(extreme.durationP50Ms, WORKLOAD_PRIORS.Extreme.durationP50Ms)
  assert.notEqual(easy.durationP50Ms, extreme.durationP50Ms)
  // The Easy prior is the measured anchor, minutes-scale — not a human day.
  assert.equal(easy.durationP50Ms, MEASURED_ANCHOR_P50_MS)
  assert.ok(easy.durationP50Ms < 60 * 60 * 1000)
})

test("a prior-derived estimate names the prior it used and stays low confidence", () => {
  const estimate = buildEstimateSnapshot("T-001", [], {
    estimateId: "b2345678-90ab-4cde-8f01-23456789abcd",
    createdAt: "2026-09-05T00:00:00.000Z",
    workload: "Extreme"
  })
  assert.equal(estimate.confidence, "low")
  assert.equal(estimate.method, "expert-guess")
  const priorLine = estimate.assumptions.find(line => line.startsWith("prior: workload-aware"))
  assert.ok(priorLine, "assumptions must state which prior was used")
  assert.match(priorLine, /Extreme/)
  assert.match(priorLine, new RegExp(String(WORKLOAD_PRIORS.Extreme.durationP50Ms)))
  assert.match(priorLine, /not a measurement/, "a prior must be distinguishable from a history-derived estimate")
})

test("expert-guess transitions to historical-baseline once real actuals exist", () => {
  const estimateId = "c2345678-90ab-4cde-8f01-23456789abcd"
  const before = buildEstimateSnapshot("T-001", [], {
    estimateId,
    createdAt: "2026-09-05T00:00:00.000Z",
    workload: "Normal"
  })
  assert.equal(before.method, "expert-guess")
  assert.equal(before.confidence, "low")

  const after = buildEstimateSnapshot("T-001", [{ duration: measuredDurations(10), workload: "Normal" }], {
    estimateId,
    createdAt: "2026-09-05T00:00:00.000Z",
    workload: "Normal"
  })
  assert.equal(after.method, "historical-baseline")
  assert.equal(after.durationP50Ms, 10 * 60 * 1000)
  // One sample is history, but not enough to claim medium confidence.
  assert.equal(after.confidence, "low")
})

test("historical baselines prefer same-workload samples and say so when ungrouped", () => {
  const estimateId = "d2345678-90ab-4cde-8f01-23456789abcd"
  const createdAt = "2026-09-05T00:00:00.000Z"
  const easySample = { duration: measuredDurations(2), workload: "Easy" as const }
  const extremeSample = { duration: measuredDurations(60), workload: "Extreme" as const }

  const easy = buildEstimateSnapshot("T-001", [easySample, extremeSample], { estimateId, createdAt, workload: "Easy" })
  assert.equal(easy.durationP50Ms, 2 * 60 * 1000, "an Easy task must not inherit an Extreme sample")
  assert.equal(easy.durationCoverage, "measured")

  const untagged = buildEstimateSnapshot("T-001", [easySample], {
    estimateId: "e2345678-90ab-4cde-8f01-23456789abcd",
    createdAt,
    workload: "Extreme"
  })
  assert.equal(untagged.durationP50Ms, 2 * 60 * 1000, "falls back to the full pool when no sample matches")
  const fallbackNote = untagged.assumptions.find(line => line.startsWith("no samples declared workload"))
  assert.ok(fallbackNote, "the ungrouped fallback must be visible in assumptions")
  assert.match(fallbackNote, /Extreme/)
})

test("workloadBaselines answers per-workload questions and excludes untagged samples", () => {
  const baselines = workloadBaselines([
    { duration: measuredDurations(10), workload: "Easy" },
    { duration: measuredDurations(20), workload: "Easy" },
    { duration: measuredDurations(120), workload: "Hard" },
    { duration: measuredDurations(30) }
  ])
  assert.equal(baselines.length, 2)
  const easy = baselines.find(baseline => baseline.workload === "Easy")
  const hard = baselines.find(baseline => baseline.workload === "Hard")
  assert.equal(easy?.sampleCount, 2)
  assert.equal(easy?.durationP50Ms, 10 * 60 * 1000)
  assert.equal(easy?.durationP90Ms, 20 * 60 * 1000)
  assert.equal(hard?.sampleCount, 1)
  assert.equal(hard?.durationP50Ms, 120 * 60 * 1000)
})
