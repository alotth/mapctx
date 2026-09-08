import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { StoreHandle, recordDispatchAttempt, recordRunEvent, recordRunReceipt } from "@mapctx/store"
import { WORKLOAD_PRIORS } from "./prior"
import { buildEstimateFromStore, estimationErrorFromStore, workloadDeltaSamplesFromStore } from "./store"

const DISPATCH_ID = "9b2e4d71-6c18-4a0f-b3d5-11aa22bb33cc"

function seedDispatch(handle: StoreHandle, dispatchId = DISPATCH_ID): void {
  handle.appendEvent({
    eventType: "project.initialized",
    actor: "test",
    payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" }
  })
  handle.appendEvent({
    eventType: "task.upserted",
    actor: "test",
    payload: {
      task: {
        taskId: "T-001",
        positionKey: 0,
        title: "x",
        planningState: "in-progress",
        executionState: "claimed",
        tags: [],
        domains: [],
        externalLinks: [],
        assignees: []
      }
    }
  })
  assert.equal(recordDispatchAttempt(handle, {
    dispatchId,
    taskId: "T-001",
    executorKind: "test",
    attempt: 1,
    contextHash: "hash",
    status: "claimed",
    actor: "test"
  }).ok, true)
}

function receipt(dispatchId = DISPATCH_ID) {
  return {
    schemaVersion: 1,
    dispatchId,
    attempt: 1,
    outcome: "completed" as const,
    startedAt: "2026-08-16T17:00:00.000Z",
    endedAt: "2026-08-17T01:10:00.000Z",
    changedFiles: [],
    usageEvents: [],
    evidence: [],
    failure: null
  }
}

function runEvent(dispatchId: string, sequence: number, timestamp: string, type: "started" | "progress" | "completed") {
  return {
    schemaVersion: 1,
    dispatchId,
    attempt: 1,
    sequence,
    type,
    timestamp,
    payload: {}
  }
}

test("store forecast measures active time from persisted events across idle gap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-forecast-store-events-"))
  try {
    const handle = StoreHandle.open(dir)
    seedDispatch(handle)
    for (const event of [
      runEvent(DISPATCH_ID, 0, "2026-08-16T17:00:00.000Z", "started"),
      runEvent(DISPATCH_ID, 1, "2026-08-16T17:05:00.000Z", "progress"),
      runEvent(DISPATCH_ID, 2, "2026-08-17T01:05:00.000Z", "completed")
    ]) {
      assert.equal(recordRunEvent(handle, event, "test").ok, true)
    }
    assert.equal(recordRunReceipt(handle, receipt(), "test").ok, true)

    const estimate = buildEstimateFromStore(handle.db, "T-001")
    assert.equal(estimate.durationCoverage, "measured")
    assert.equal(estimate.durationP50Ms, 10 * 60 * 1000)
    assert.ok(estimate.durationP50Ms < 8 * 60 * 60 * 1000 + 10 * 60 * 1000)
    handle.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("store forecast labels receipt-only duration as substituted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-forecast-store-no-events-"))
  try {
    const handle = StoreHandle.open(dir)
    seedDispatch(handle)
    assert.equal(recordRunReceipt(handle, receipt(), "test").ok, true)
    const estimate = buildEstimateFromStore(handle.db, "T-001")
    assert.equal(estimate.durationCoverage, "substituted")
    assert.equal(estimate.durationP50Ms, 8 * 60 * 60 * 1000 + 10 * 60 * 1000)
    handle.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---- T-071: planned-vs-discovered delta through the real store ----

test("store bridge pools by discovered workload and reports estimation error per planned", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-forecast-workload-delta-"))
  try {
    const handle = StoreHandle.open(dir)
    // Self-contained seed: plan Easy, hand off, discover Hard, finish.
    handle.appendEvent({
      eventType: "project.initialized",
      actor: "test",
      payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" }
    })
    handle.appendEvent({
      eventType: "task.upserted",
      actor: "test",
      payload: {
        task: {
          taskId: "T-009",
          positionKey: 0,
          title: "x",
          workload: "Easy",
          planningState: "in-progress",
          executionState: "claimed",
          tags: [],
          domains: [],
          externalLinks: [],
          assignees: []
        }
      }
    })
    assert.equal(recordDispatchAttempt(handle, {
      dispatchId: DISPATCH_ID,
      taskId: "T-009",
      executorKind: "test",
      attempt: 1,
      contextHash: "hash",
      status: "claimed",
      actor: "test",
      executorModel: "glm-4.7"
    }).ok, true)
    handle.appendEvent({
      eventType: "task.patched",
      actor: "operator",
      payload: { taskId: "T-009", patch: { workload: "Hard" }, source: "operator" }
    })
    assert.equal(recordRunReceipt(handle, receipt(), "test").ok, true)

    const samples = workloadDeltaSamplesFromStore(handle.db)
    assert.equal(samples.length, 1)
    assert.equal(samples[0].workload, "Hard", "pool key is the discovered (current) workload")
    assert.equal(samples[0].workloadPlanned, "Easy", "planned stays frozen at the dispatch stamp")

    const aggregate = estimationErrorFromStore(handle.db)
    assert.equal(aggregate.length, 1)
    assert.equal(aggregate[0].planned, "Easy")
    assert.equal(aggregate[0].reclassifiedCount, 1)
    assert.deepEqual(aggregate[0].transitions, [{ discovered: "Hard", count: 1 }])
    const wallClockMs = Date.parse("2026-08-17T01:10:00.000Z") - Date.parse("2026-08-16T17:00:00.000Z")
    assert.equal(aggregate[0].medianRatioToPriorP50, Math.round(wallClockMs / WORKLOAD_PRIORS.Easy.durationP50Ms * 100) / 100)

    // Pooled forecast for a Hard task reads the re-attributed actual...
    const hardEstimate = buildEstimateFromStore(handle.db, "T-009", { workload: "Hard" })
    assert.equal(hardEstimate.durationP50Ms, wallClockMs)
    assert.ok(hardEstimate.assumptions.some(line => line.includes("re-attributed")))
    // ...and the Easy pool no longer contains it.
    const easyEstimate = buildEstimateFromStore(handle.db, "T-009", { workload: "Easy" })
    assert.ok(easyEstimate.assumptions.some(line => line.startsWith("no samples declared workload Easy")))
    handle.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
