/**
 * Pins the small pure helpers in `results.ts` directly, without a fixture:
 * `isRetryableKind` is the single source of truth every provider must agree
 * on (decision 6 in docs/engineering/provider-contract-decisions.md), and
 * `summariseBatch`/`page` are the building blocks the contract suite trusts
 * to report batch and paging state honestly.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { isRetryableKind, page, summariseBatch } from "./results"
import type { FieldWrite, FieldWriteOutcome } from "./types"

test("isRetryableKind: rate-limited and transient are retryable, everything else is not", () => {
  assert.equal(isRetryableKind("rate-limited"), true)
  assert.equal(isRetryableKind("transient"), true)
  assert.equal(isRetryableKind("auth"), false)
  assert.equal(isRetryableKind("not-found"), false)
  assert.equal(isRetryableKind("unsupported"), false)
  assert.equal(isRetryableKind("conflict"), false)
  assert.equal(isRetryableKind("invalid"), false)
})

const write: FieldWrite = {
  item: { provider: "local", workItem: { id: "T-1", key: "T-1" } },
  field: { semantic: "title", surface: "work-item" },
  value: "x"
}

function outcome(status: FieldWriteOutcome["status"]): FieldWriteOutcome {
  if (status === "failed" || status === "unknown") {
    return { status, write, error: { kind: "invalid", message: "x", retryable: false } }
  }
  return { status, write }
}

test("summariseBatch: partiallyApplied is true only when something applied AND something failed/unknown", () => {
  const mixed = summariseBatch([outcome("applied"), outcome("failed")], false)
  assert.equal(mixed.partiallyApplied, true)
  assert.equal(mixed.applied, 1)
  assert.equal(mixed.failed, 1)

  const mixedWithUnknown = summariseBatch([outcome("applied"), outcome("unknown")], false)
  assert.equal(mixedWithUnknown.partiallyApplied, true)
})

test("summariseBatch: all applied is not partiallyApplied", () => {
  const allApplied = summariseBatch([outcome("applied"), outcome("cleared"), outcome("unchanged")], false)
  assert.equal(allApplied.partiallyApplied, false)
  assert.equal(allApplied.applied, 3)
  assert.equal(allApplied.failed, 0)
  assert.equal(allApplied.unknown, 0)
})

test("summariseBatch: all failed is not partiallyApplied", () => {
  const allFailed = summariseBatch([outcome("failed"), outcome("failed")], false)
  assert.equal(allFailed.partiallyApplied, false)
  assert.equal(allFailed.applied, 0)
  assert.equal(allFailed.failed, 2)
})

test("summariseBatch: counts sum to outcomes.length", () => {
  const outcomes = [outcome("applied"), outcome("cleared"), outcome("unchanged"), outcome("failed"), outcome("unknown")]
  const result = summariseBatch(outcomes, true)
  assert.equal(result.applied + result.failed + result.unknown, outcomes.length)
  assert.equal(result.verified, true)
})

test("page(): freshness.partial mirrors the presence of a cursor", () => {
  const withoutCursor = page(["a", "b"])
  assert.equal(withoutCursor.freshness.partial, false)
  assert.equal(withoutCursor.nextCursor, undefined)

  const withCursor = page(["a"], "cursor-1")
  assert.equal(withCursor.freshness.partial, true)
  assert.equal(withCursor.nextCursor, "cursor-1")
})
