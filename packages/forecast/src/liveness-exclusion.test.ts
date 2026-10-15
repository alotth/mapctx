import assert from "node:assert/strict"
import test from "node:test"
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
