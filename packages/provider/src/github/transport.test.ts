/**
 * `classifyGitHubFailure` is the adapter's whole retry policy.
 *
 * Callers never re-derive retryability per kind -- `ProviderError.retryable`
 * travels with the error precisely so two callers cannot disagree -- which
 * makes this function the single place a permission error can become an
 * infinite retry loop against a rate-limited API. The T-150 review flipped 403
 * from `auth` to `transient` + `retryable` and the whole suite stayed green,
 * because nothing sampled this dimension.
 *
 * So: one row per branch, asserting `kind` AND `retryable`, plus the
 * `retryAfter` hint where the branch promises one. The rows are the shapes T-135
 * measured against the live API, including GitHub answering HTTP 200 with typed
 * GraphQL errors.
 */

import assert from "node:assert/strict"
import test from "node:test"

import { isRetryableKind } from "../results"
import type { ProviderErrorKind } from "../types"
import { classifyGitHubFailure, fixtureKey, fixtureTransport, type FixtureFile } from "./transport"

type Row = {
  name: string
  status: number
  headers?: Record<string, string>
  errors?: { type?: string; message?: string }[]
  expect: ProviderErrorKind
  /** `true` demands a hint, `false` demands its absence, omitted means either. */
  retryAfter?: boolean
  /** Substring the message must carry, when the branch is meant to explain itself. */
  message?: RegExp
}

const ROWS: readonly Row[] = [
  {
    // The hint GitHub sends on the throttling path, preferred over resetAt.
    name: "GraphQL RATE_LIMITED with a retry-after header",
    status: 200,
    headers: { "retry-after": "60" },
    errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1." }],
    expect: "rate-limited",
    retryAfter: true
  },
  {
    // No retry-after, so the window reset is the only hint available. Falling
    // back matters: without it a caller has a retryable error and no idea when.
    name: "GraphQL RATE_LIMITED falls back to the rate-limit reset",
    status: 200,
    headers: { "x-ratelimit-reset": "1792029094" },
    errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded." }],
    expect: "rate-limited",
    retryAfter: true
  },
  {
    name: "401 is auth and never retried",
    status: 401,
    expect: "auth",
    retryAfter: false
  },
  {
    // The primary limit arrives as a 403 with the budget at zero, not as a
    // typed GraphQL error, so the header is what distinguishes it from a
    // permission failure.
    name: "403 with an exhausted primary budget is rate-limited",
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1792029094" },
    expect: "rate-limited",
    retryAfter: true
  },
  {
    name: "403 naming the secondary rate limit is rate-limited",
    status: 403,
    headers: { "retry-after": "120" },
    errors: [{ message: "You have exceeded a secondary rate limit. Please wait a few minutes." }],
    expect: "rate-limited",
    retryAfter: true
  },
  {
    name: "403 for abuse detection is rate-limited",
    status: 403,
    errors: [{ message: "You have triggered an abuse detection mechanism." }],
    expect: "rate-limited"
  },
  {
    // Everything else at 403 is a permission or scope problem. This is the row
    // the review's mutation broke: retrying it forever helps nobody and costs
    // the budget the other rows are trying to protect.
    name: "403 otherwise is auth, with a scopes hint, and is never retried",
    status: 403,
    headers: { "x-ratelimit-remaining": "4999" },
    expect: "auth",
    retryAfter: false,
    message: /scope/i
  },
  {
    name: "404 is not-found",
    status: 404,
    expect: "not-found",
    retryAfter: false
  },
  {
    // GitHub answers 200 and puts the absence in a typed GraphQL error, so the
    // status code alone would read this as success.
    name: "a typed NOT_FOUND under HTTP 200 is not-found",
    status: 200,
    errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node with the global id of 'x'." }],
    expect: "not-found",
    retryAfter: false
  },
  {
    name: "a typed FORBIDDEN is auth",
    status: 200,
    errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
    expect: "auth",
    retryAfter: false
  }
]

function headersOf(values?: Record<string, string>) {
  return new Headers(values ?? {})
}

for (const row of ROWS) {
  test(`classifyGitHubFailure: ${row.name}`, () => {
    const error = classifyGitHubFailure({
      status: row.status,
      headers: headersOf(row.headers),
      ...(row.errors ? { body: { errors: row.errors } } : {})
    })
    assert.equal(error.kind, row.expect, `expected kind ${row.expect}, got ${error.kind}: ${error.message}`)
    // Asserted against the single derivation in `results.ts` rather than a
    // literal, so the two can never drift apart silently.
    assert.equal(
      error.retryable,
      isRetryableKind(row.expect),
      `kind ${row.expect} must report retryable=${isRetryableKind(row.expect)}`
    )
    if (row.retryAfter === true) {
      assert.ok(typeof error.retryAfter === "string" && error.retryAfter.length > 0, "this branch must carry a wait hint")
    }
    if (row.retryAfter === false) {
      assert.equal(error.retryAfter, undefined, "a non-retryable error must not suggest a wait")
    }
    if (row.message) assert.match(error.message, row.message)
  })
}

test("classifyGitHubFailure: every branch agrees with the one retryability derivation", () => {
  for (const row of ROWS) {
    const error = classifyGitHubFailure({
      status: row.status,
      headers: headersOf(row.headers),
      ...(row.errors ? { body: { errors: row.errors } } : {})
    })
    assert.equal(error.retryable, isRetryableKind(error.kind), `${row.name} disagrees with isRetryableKind`)
  }
})

test("classifyGitHubFailure: 5xx is transient and an unclassifiable 2xx is not silently fine", () => {
  const server = classifyGitHubFailure({ status: 502, headers: headersOf() })
  assert.equal(server.kind, "transient")
  assert.equal(server.retryable, true)

  // No errors array and a status nothing matches: the function must still
  // produce a failure, because it is only ever called on a failure path.
  const unclassified = classifyGitHubFailure({ status: 418, headers: headersOf() })
  assert.equal(unclassified.kind, "transient")
  assert.match(unclassified.message, /418/)
})

test("classifyGitHubFailure: an untyped errors array under 200 is invalid, not unsupported", () => {
  // `unsupported` must name a capability, and a malformed argument is not a
  // missing capability -- mapping it there would tell a caller to stop asking
  // for something the provider can actually do.
  const error = classifyGitHubFailure({
    status: 200,
    headers: headersOf(),
    body: { errors: [{ message: "Argument 'first' on Field 'items' has an invalid value." }] }
  })
  assert.equal(error.kind, "invalid")
  assert.equal(error.retryable, false)
  assert.equal(error.capability, undefined)
})

test("classifyGitHubFailure: a schema-level refusal is unsupported and names a capability", () => {
  // The T-135 shape: HTTP 200, typed VALIDATION, a refusal the schema does not
  // express up front. `unsupported` is required to name what it lacks.
  const error = classifyGitHubFailure({
    status: 200,
    headers: headersOf(),
    body: { errors: [{ type: "VALIDATION", message: "Roadmap views do not support visible fields." }] }
  })
  assert.equal(error.kind, "unsupported")
  assert.equal(error.retryable, false)
  assert.ok(typeof error.capability === "string" && error.capability.length > 0)
})

test("classifyGitHubFailure: an over-large page request is the caller's mistake, not a missing capability", () => {
  const error = classifyGitHubFailure({
    status: 200,
    headers: headersOf(),
    body: { errors: [{ type: "EXCESSIVE_PAGINATION", message: "Requesting 101 records exceeds the first limit of 100." }] }
  })
  assert.equal(error.kind, "invalid")
  assert.equal(error.retryable, false)
})

test("classifyGitHubFailure: headers are optional", () => {
  // The fixture transport replays recorded failures with no headers at all, so
  // every branch has to survive their absence rather than throwing.
  const error = classifyGitHubFailure({ status: 200, body: { errors: [{ type: "RATE_LIMITED", message: "slow down" }] } })
  assert.equal(error.kind, "rate-limited")
  assert.equal(error.retryable, true)
})

// ---- the fixture key, which decides whether a replay matches at all --------

test("fixtureKey is stable under key order and distinguishes variable values", () => {
  const a = fixtureKey({ label: "node", variables: { id: "X", first: 1 } })
  const b = fixtureKey({ label: "node", variables: { first: 1, id: "X" } })
  // Literal key order is not meaningful, so a recorded key must not depend on it.
  assert.equal(a, b)
  assert.notEqual(a, fixtureKey({ label: "node", variables: { id: "Y", first: 1 } }))
  assert.notEqual(a, fixtureKey({ label: "other", variables: { id: "X", first: 1 } }))
  // No variables at all is the bare label, which is what `rate-limit` records.
  assert.equal(fixtureKey({ label: "rate-limit", variables: {} }), "rate-limit")
  // undefined and null collapse to the same recorded form, because a cursor
  // passed as undefined and one passed as null are the same request.
  assert.equal(
    fixtureKey({ label: "q", variables: { cursor: undefined } }),
    fixtureKey({ label: "q", variables: { cursor: null } })
  )
})

test("fixtureTransport replays a recorded failure through the live classification", async () => {
  const file: FixtureFile = {
    provenance: "synthetic",
    entries: [
      {
        key: 'node?id="X"',
        label: "node",
        variables: { id: "X" },
        errors: [{ type: "RATE_LIMITED", message: "slow down" }]
      }
    ]
  }
  const transport = fixtureTransport([file])
  const replayed = await transport.execute({ label: "node", document: "query", variables: { id: "X" } })
  assert.equal(replayed.ok, false)
  if (!replayed.ok) {
    // Same function as the live path: a recorded failure must not be softer
    // than the real one it stands in for.
    assert.equal(replayed.error.kind, "rate-limited")
    assert.equal(replayed.error.retryable, true)
  }

  const missing = await transport.execute({ label: "node", document: "query", variables: { id: "absent" } })
  assert.equal(missing.ok, false)
  if (!missing.ok) {
    // Loud, not empty: an invented empty response would let a test pass having
    // exercised nothing, which is the whole hazard recorded fixtures exist for.
    assert.equal(missing.error.kind, "not-found")
    assert.match(missing.error.message, /no fixture recorded/)
  }
})

test("fixtureTransport surfaces a rate-limit reading from a replayed payload", async () => {
  const file: FixtureFile = {
    provenance: "synthetic",
    entries: [
      {
        key: "rate-limit",
        label: "rate-limit",
        variables: {},
        data: { rateLimit: { limit: 5000, cost: 1, remaining: 4321, resetAt: "2026-10-15T02:00:00Z" } }
      }
    ]
  }
  const transport = fixtureTransport([file])
  assert.equal(transport.lastRateLimit(), undefined, "nothing has been read yet")
  const result = await transport.execute({ label: "rate-limit", document: "query", variables: {} })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.rateLimit?.remaining, 4321)
  assert.equal(result.value.rateLimit?.unit, "points")
  assert.equal(result.value.rateLimit?.costOfLastOperation, 1)
  assert.equal(transport.lastRateLimit()?.remaining, 4321)
})
