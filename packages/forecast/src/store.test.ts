import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { StoreHandle, recordDispatchAttempt, recordRunEvent, recordRunReceipt } from "@mapctx/store"
import { buildEstimateFromStore } from "./store"

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
