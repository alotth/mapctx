import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { StoreHandle, recordDispatchAttempt, recordRunEvent, recordRunReceipt } from "@mapctx/store"
import { buildEstimateFromStore } from "./store"
import { durationMeasuresFromReceipt } from "./duration"

/**
 * T-143 (C4): `durationMeasuresFromReceipt` must exclude liveness run events
 * (`heartbeat`, `progress`) from interior-event measurement -- otherwise a
 * four-hour run heartbeating every 20 minutes measures ~0 active time AND
 * loses the honest `substituted` coverage label, which makes the corrupted
 * sample look MORE trustworthy than the one it replaced.
 */

const STARTED_AT = "2026-10-01T00:00:00.000Z"
const ENDED_AT = "2026-10-01T04:00:00.000Z" // 4h run
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000

/** Interior timestamps every 20 minutes, strictly between startedAt and endedAt (11 events across a 4h run). */
function everyTwentyMinutes(): string[] {
  const startMs = new Date(STARTED_AT).getTime()
  const timestamps: string[] = []
  for (let minutes = 20; minutes < 240; minutes += 20) {
    timestamps.push(new Date(startMs + minutes * 60 * 1000).toISOString())
  }
  return timestamps
}

// ---------------------------------------------------------------------------
// 1. Parity: measured WITH liveness events and WITHOUT any events must be
// identical -- for both heartbeat and progress, spaced 20 minutes apart
// across a ~4h run.
// ---------------------------------------------------------------------------

for (const livenessType of ["heartbeat", "progress"] as const) {
  test(`${livenessType} events every 20 minutes across a 4h run are fully excluded: activeTimeMs, sessionWallClockMs and activeTimeCoverage match the no-events case exactly`, () => {
    const withoutEvents = durationMeasuresFromReceipt(STARTED_AT, ENDED_AT)

    const withLivenessEvents = durationMeasuresFromReceipt(STARTED_AT, ENDED_AT, {
      events: everyTwentyMinutes().map(timestamp => ({ timestamp, type: livenessType }))
    })

    assert.deepEqual(withLivenessEvents, withoutEvents, `${livenessType}: measured result must be byte-identical to the no-events case`);

    // Pin the actual values too, so a change to measureDurations's defaults
    // cannot make both sides drift together and still pass the deepEqual
    // above -- this is exactly the corruption the filter prevents.
    assert.equal(withLivenessEvents.activeTimeCoverage, "substituted", `${livenessType}: must stay substituted, not silently become "measured"`);
    assert.equal(withLivenessEvents.activeTimeMs, FOUR_HOURS_MS, `${livenessType}: must report the full 4h as active (substituted = wall clock), not ~0 from gap-subtraction`);
    assert.equal(withLivenessEvents.sessionWallClockMs, FOUR_HOURS_MS);
  });
}

// ---------------------------------------------------------------------------
// 2. Counterproof: a non-liveness interior event (e.g. "question") still
// counts as interior -- the filter targets the liveness vocabulary, not
// every event.
// ---------------------------------------------------------------------------

test("a non-liveness interior event (type: question) still counts as interior: coverage is measured, not substituted", () => {
  const measures = durationMeasuresFromReceipt(STARTED_AT, ENDED_AT, {
    events: [{ timestamp: "2026-10-01T02:00:00.000Z", type: "question" }]
  });
  assert.equal(measures.activeTimeCoverage, "measured", "a single non-liveness interior event must still establish measured coverage");
  assert.notEqual(measures.activeTimeCoverage, "substituted");
});

// ---------------------------------------------------------------------------
// 3. An event with no `type` at all (an older caller, timestamp only) still
// counts as interior -- "no type" is not read as "liveness".
// ---------------------------------------------------------------------------

test("an interior event with no type field at all still counts as interior (an untyped event is not treated as liveness)", () => {
  const measures = durationMeasuresFromReceipt(STARTED_AT, ENDED_AT, {
    events: [{ timestamp: "2026-10-01T02:00:00.000Z" }]
  });
  assert.equal(measures.activeTimeCoverage, "measured");
  assert.notEqual(measures.activeTimeCoverage, "substituted");
});

// ---------------------------------------------------------------------------
// 4. The semantic change, proved explicitly, not just by the absence of the
// old expectation elsewhere. Pair of store.test.ts's fixture edit (18dfe51):
// that test moved its interior marker from `progress` to `question` because
// `progress` is now a liveness type and D3 excludes it. Here the ORIGINAL
// fixture -- `progress` at 17:05, same receipt/dispatch -- proves the new
// number.
//
// `started`@17:00 sits exactly on startedAt, so it was never an interior
// event either before or after T-143 (boundary events don't count). Before
// T-143 the interior events were [progress@17:05, completed@01:05]: the
// 17:00-17:05 gap (5 min, active) plus the 01:05-01:10 gap (5 min, active) =
// 600000ms, the pre-T-143 expectation. With `progress` now excluded as
// liveness, only completed@01:05 remains interior: the 17:00-17:05 gap
// disappears along with it (there is no longer an event there to close it),
// and only the 01:05-01:10 gap survives -- 300000ms. Coverage stays
// "measured" rather than falling to "substituted" because completed@01:05 is
// still one real interior event.
//
// Minimal duplicate of store.test.ts's setup, by design: exporting helpers
// across test files was judged worse than repeating this little.
// ---------------------------------------------------------------------------

const DISPATCH_ID = "9b2e4d71-6c18-4a0f-b3d5-11aa22bb33cd"

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

function receiptAcrossIdleGap(dispatchId = DISPATCH_ID) {
  return {
    schemaVersion: 1 as const,
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

function idleGapRunEvent(dispatchId: string, sequence: number, timestamp: string, type: "started" | "progress" | "completed") {
  return { schemaVersion: 1 as const, dispatchId, attempt: 1, sequence, type, timestamp, payload: {} };
}

test("D3 proved explicitly: the SAME fixture that used to measure 600000ms with a progress marker now measures 300000ms, with coverage still measured (the started marker alone is enough)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapctx-forecast-liveness-exclusion-"))
  try {
    const handle = StoreHandle.open(dir)
    seedDispatch(handle)
    for (const event of [
      idleGapRunEvent(DISPATCH_ID, 0, "2026-08-16T17:00:00.000Z", "started"),
      idleGapRunEvent(DISPATCH_ID, 1, "2026-08-16T17:05:00.000Z", "progress"), // the ORIGINAL marker, pre-T-143
      idleGapRunEvent(DISPATCH_ID, 2, "2026-08-17T01:05:00.000Z", "completed")
    ]) {
      assert.equal(recordRunEvent(handle, event, "test").ok, true)
    }
    assert.equal(recordRunReceipt(handle, receiptAcrossIdleGap(), "test").ok, true)

    const estimate = buildEstimateFromStore(handle.db, "T-001")
    assert.equal(estimate.durationCoverage, "measured", "completed@01:05 alone still establishes measured coverage -- it never drops to substituted");
    assert.equal(estimate.durationP50Ms, 5 * 60 * 1000, "D3: with progress excluded, only the 01:05-01:10 gap survives -- 300000ms, down from the pre-T-143 600000ms");
    handle.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
});
