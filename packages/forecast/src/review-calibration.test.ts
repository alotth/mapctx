import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { StoreHandle, recordDispatchAttempt, recordHistoryCorrection, recordRunReceipt } from "@mapctx/store"
import { buildEstimateFromStore, workloadDeltaSamplesFromStore } from "./store"

/**
 * T-145 (C6 / §3): calibration is implement-only, unconditionally. Every
 * receipt the forecast reads becomes a workload-duration sample, so a review
 * receipt mixed into the same pool as an implement one would corrupt the
 * estimate `estimatedEffort` leases are derived from. `implementLaneOnly` and
 * the shared `calibrationSamples` helper are the policy under test, at BOTH
 * entry points -- `buildEstimateFromStore` and `workloadDeltaSamplesFromStore`
 * independently, since each one calling the shared helper is exactly the
 * property that keeps the two calibration exclusions (lane + invalidated)
 * from drifting apart.
 */

const IMPLEMENT_DISPATCH = "40000000-0000-4000-8000-000000000004"
const REVIEW_DISPATCH = "50000000-0000-4000-8000-000000000005"

function mkDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function seedTask(handle: StoreHandle, taskId: string, workload: string | null = "Normal"): void {
  handle.appendEvent({
    eventType: "task.upserted",
    actor: "test",
    payload: {
      task: {
        taskId, positionKey: 0, title: "x", workload, planningState: "in-progress", executionState: "claimed",
        tags: [], domains: [], externalLinks: [], assignees: []
      }
    }
  })
}

function materialize(dir: string): StoreHandle {
  const handle = StoreHandle.open(dir)
  handle.appendEvent({
    eventType: "project.initialized",
    actor: "test",
    payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" }
  })
  return handle
}

function dispatch(dispatchId: string, taskId: string, kind: "implement" | "review") {
  return { dispatchId, taskId, executorKind: "test", attempt: 1, contextHash: "hash", status: "claimed" as const, kind, actor: "test" }
}

function receiptFor(dispatchId: string, startedAt: string, endedAt: string) {
  return {
    schemaVersion: 1 as const,
    dispatchId,
    attempt: 1,
    outcome: "completed" as const,
    startedAt,
    endedAt,
    changedFiles: [],
    usageEvents: [],
    evidence: [],
    failure: null
  }
}

// A ten-minute review receipt beside an eight-hour implement receipt: if the
// review receipt ever entered the pool, the measured duration would be
// nowhere near 8h (it would be dragged toward 10m, or counted as a second
// sample and change the sample-derived figure some other visible way).
const IMPLEMENT_START = "2026-10-17T08:00:00.000Z"
const IMPLEMENT_END = "2026-10-17T16:00:00.000Z" // 8h
const IMPLEMENT_MS = Date.parse(IMPLEMENT_END) - Date.parse(IMPLEMENT_START)
const REVIEW_START = "2026-10-17T09:00:00.000Z"
const REVIEW_END = "2026-10-17T09:10:00.000Z" // 10m

test("buildEstimateFromStore sees ONLY the implement receipt: duration matches the 8h implement receipt exactly, unmoved by the 10m review one", () => {
  const dir = mkDir("mapctx-forecast-review-calib-1-")
  try {
    const handle = materialize(dir)
    seedTask(handle, "T-200")
    assert.equal(recordDispatchAttempt(handle, dispatch(IMPLEMENT_DISPATCH, "T-200", "implement")).ok, true)
    assert.equal(recordDispatchAttempt(handle, dispatch(REVIEW_DISPATCH, "T-200", "review")).ok, true)
    assert.equal(recordRunReceipt(handle, receiptFor(IMPLEMENT_DISPATCH, IMPLEMENT_START, IMPLEMENT_END), "worker").ok, true)
    assert.equal(recordRunReceipt(handle, receiptFor(REVIEW_DISPATCH, REVIEW_START, REVIEW_END), "reviewer").ok, true)

    const estimate = buildEstimateFromStore(handle.db, "T-200")
    // No run events recorded, so coverage is "substituted" (whole-receipt wall
    // clock) rather than "measured" (active-time-from-events) -- the point
    // here is which RECEIPT it is substituted from, not the coverage label.
    assert.equal(estimate.durationCoverage, "substituted")
    assert.equal(estimate.durationP50Ms, IMPLEMENT_MS, "must be exactly the implement receipt's 8h, not a figure dragged by the review receipt's 10m");
    handle.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("workloadDeltaSamplesFromStore returns exactly ONE sample (the implement receipt) out of the two receipts in the store", () => {
  const dir = mkDir("mapctx-forecast-review-calib-2-")
  try {
    const handle = materialize(dir)
    seedTask(handle, "T-201")
    assert.equal(recordDispatchAttempt(handle, dispatch(IMPLEMENT_DISPATCH, "T-201", "implement")).ok, true)
    assert.equal(recordDispatchAttempt(handle, dispatch(REVIEW_DISPATCH, "T-201", "review")).ok, true)
    assert.equal(recordRunReceipt(handle, receiptFor(IMPLEMENT_DISPATCH, IMPLEMENT_START, IMPLEMENT_END), "worker").ok, true)
    assert.equal(recordRunReceipt(handle, receiptFor(REVIEW_DISPATCH, REVIEW_START, REVIEW_END), "reviewer").ok, true)

    const samples = workloadDeltaSamplesFromStore(handle.db, "T-201")
    assert.equal(samples.length, 1, "two receipts in the store, exactly one calibration sample");
    assert.equal(samples[0].duration.sessionWallClockMs, IMPLEMENT_MS);
    handle.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("the lane exclusion and the history-correction exclusion are independent and both apply: across three tasks (one clean implement, one invalidated implement, one review), only the clean implement receipt survives", () => {
  const dir = mkDir("mapctx-forecast-review-calib-3-")
  try {
    const handle = materialize(dir)
    // Three separate tasks, because a single task's executionState cannot
    // land two completed implement receipts without the retry-admission
    // reset this test has no reason to exercise -- the property under test
    // (two independent exclusions, both applying, over the WHOLE store) does
    // not require them on one task.
    seedTask(handle, "T-204")
    seedTask(handle, "T-205")
    seedTask(handle, "T-206")

    const goodDispatch = "60000000-0000-4000-8000-000000000006"
    const invalidDispatch = "70000000-0000-4000-8000-000000000007"
    const goodStart = "2026-10-17T10:00:00.000Z"
    const goodEnd = "2026-10-17T11:00:00.000Z" // 1h
    const goodMs = Date.parse(goodEnd) - Date.parse(goodStart)

    assert.equal(recordDispatchAttempt(handle, dispatch(goodDispatch, "T-204", "implement")).ok, true)
    assert.equal(recordRunReceipt(handle, receiptFor(goodDispatch, goodStart, goodEnd), "worker").ok, true)

    assert.equal(recordDispatchAttempt(handle, dispatch(invalidDispatch, "T-205", "implement")).ok, true)
    assert.equal(recordRunReceipt(handle, receiptFor(invalidDispatch, IMPLEMENT_START, IMPLEMENT_END), "worker").ok, true)
    const correction = recordHistoryCorrection(handle, {
      correctionId: "cor-review-calib",
      taskId: "T-205",
      targetKind: "receipt",
      targetId: `${invalidDispatch}/1`,
      verdict: "invalid",
      reason: "wrong attempt attributed",
      recordedAt: "2026-10-17T12:00:00.000Z"
    }, "auditor")
    assert.equal(correction.ok, true, JSON.stringify(correction))

    assert.equal(recordDispatchAttempt(handle, dispatch(REVIEW_DISPATCH, "T-206", "review")).ok, true)
    assert.equal(recordRunReceipt(handle, receiptFor(REVIEW_DISPATCH, REVIEW_START, REVIEW_END), "reviewer").ok, true)

    // Over the WHOLE store (no taskId filter): three receipts, two
    // independent exclusions, exactly one surviving sample.
    const samples = workloadDeltaSamplesFromStore(handle.db)
    assert.equal(samples.length, 1, `three receipts, two independent exclusions, one sample: ${JSON.stringify(samples)}`);
    assert.equal(samples[0].duration.sessionWallClockMs, goodMs);

    handle.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a task with no review receipt at all calibrates exactly as before T-145: no regression from the new lane filter", () => {
  const dir = mkDir("mapctx-forecast-review-calib-4-")
  try {
    const handle = materialize(dir)
    seedTask(handle, "T-203")
    assert.equal(recordDispatchAttempt(handle, dispatch(IMPLEMENT_DISPATCH, "T-203", "implement")).ok, true)
    assert.equal(recordRunReceipt(handle, receiptFor(IMPLEMENT_DISPATCH, IMPLEMENT_START, IMPLEMENT_END), "worker").ok, true)

    const estimate = buildEstimateFromStore(handle.db, "T-203")
    assert.equal(estimate.durationCoverage, "substituted")
    assert.equal(estimate.durationP50Ms, IMPLEMENT_MS)

    const samples = workloadDeltaSamplesFromStore(handle.db, "T-203")
    assert.equal(samples.length, 1)
    handle.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
