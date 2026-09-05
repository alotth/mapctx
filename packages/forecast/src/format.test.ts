import assert from "node:assert/strict"
import test from "node:test"
import { formatDurationMs, parseEstimatedEffortMs } from "./format"

test("duration display picks its unit from magnitude", () => {
  assert.equal(formatDurationMs(45_000), "<1m")
  assert.equal(formatDurationMs(20 * 60 * 1000), "20m")
  assert.equal(formatDurationMs(1.5 * 60 * 1000), "1.5m")
  assert.equal(formatDurationMs(90 * 60 * 1000), "1.5h")
  assert.equal(formatDurationMs(8 * 60 * 60 * 1000), "8h")
  assert.equal(formatDurationMs(3 * 24 * 60 * 60 * 1000), "3d")
  assert.equal(formatDurationMs(2.5 * 24 * 60 * 60 * 1000), "2.5d")
})

test("no fixed unit: hours never render as days, days never render as minutes", () => {
  assert.notEqual(formatDurationMs(60 * 60 * 1000), "0.04d")
  assert.notEqual(formatDurationMs(3 * 24 * 60 * 60 * 1000), "4320m")
  assert.equal(formatDurationMs(60 * 60 * 1000), "1h")
  assert.equal(formatDurationMs(3 * 24 * 60 * 60 * 1000), "3d")
})

test("invalid durations render as no data", () => {
  assert.equal(formatDurationMs(-1), "no data")
  assert.equal(formatDurationMs(Number.NaN), "no data")
  assert.equal(formatDurationMs(Number.POSITIVE_INFINITY), "no data")
})

test("parseEstimatedEffortMs parses human-unit free text into milliseconds", () => {
  const hour = 60 * 60 * 1000
  assert.equal(parseEstimatedEffortMs("3d"), 24 * hour)
  assert.equal(parseEstimatedEffortMs("1w"), 5 * 8 * hour)
  assert.equal(parseEstimatedEffortMs("2.5w"), 2.5 * 5 * 8 * hour)
  assert.equal(parseEstimatedEffortMs("4d"), 32 * hour)
  assert.equal(parseEstimatedEffortMs("8h"), 8 * hour)
  assert.equal(parseEstimatedEffortMs("30m"), 30 * 60 * 1000)
  assert.equal(parseEstimatedEffortMs(" 2d "), 16 * hour)
})

test("parseEstimatedEffortMs uses the human working-day convention the authors meant", () => {
  // "1w" was authored as five working days, not seven calendar days.
  const week = parseEstimatedEffortMs("1w")
  const day = parseEstimatedEffortMs("1d")
  assert.ok(week !== null && day !== null)
  assert.equal(week, 5 * day)
})

test("parseEstimatedEffortMs returns null for junk instead of fabricating a duration", () => {
  assert.equal(parseEstimatedEffortMs(""), null)
  assert.equal(parseEstimatedEffortMs("soon"), null)
  assert.equal(parseEstimatedEffortMs("3x"), null)
  assert.equal(parseEstimatedEffortMs("d3"), null)
})
