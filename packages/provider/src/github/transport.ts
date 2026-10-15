/**
 * GraphQL transport for the GitHub adapter.
 *
 * Two implementations, one interface, because the adapter must be testable
 * without a network and auditable with one:
 *
 *   - `liveTransport` talks to api.github.com. It owns error classification and
 *     rate-limit capture, so no mapping code has to know about HTTP.
 *   - `fixtureTransport` replays recorded responses and REFUSES an unrecorded
 *     request. Returning an empty response for an unknown key would let a test
 *     pass while exercising nothing, which is the failure mode recorded
 *     fixtures exist to prevent.
 *
 * The error classification is the spike's measurement, not a guess: GitHub
 * reports a schema-level write refusal as HTTP 200 with an untyped `errors`
 * array (`"Roadmap views do not support visible fields."`), so a transport that
 * only looked at the status code would read a refusal as success.
 */

import { err } from "../results"
import type { ProviderError, ProviderRateLimit, ProviderResult } from "../types"

const GRAPHQL_URL = "https://api.github.com/graphql"

export type GraphQLRequest = {
  /** Stable name for this query shape, used as part of the fixture key. */
  label: string
  document: string
  variables: Record<string, unknown>
}

export type GraphQLResponse = {
  data: Record<string, unknown>
  rateLimit?: ProviderRateLimit
}

export type GitHubTransport = {
  readonly mode: "live" | "fixture"
  execute(request: GraphQLRequest): Promise<ProviderResult<GraphQLResponse>>
  /** The most recent rate-limit reading, when one has been seen. */
  lastRateLimit(): ProviderRateLimit | undefined
}

/**
 * The fixture key.
 *
 * Label plus canonically ordered variables: readable in the recorded file, and
 * stable across runs because key order in a literal is not.
 */
export function fixtureKey(request: Pick<GraphQLRequest, "label" | "variables">): string {
  const ordered = Object.keys(request.variables)
    .sort()
    .map((name) => `${name}=${JSON.stringify(request.variables[name] ?? null)}`)
    .join("&")
  return ordered.length === 0 ? request.label : `${request.label}?${ordered}`
}

type GraphQLErrorEntry = { type?: string; message?: string }

/** Map one transport outcome onto a `ProviderError`. */
export function classifyGitHubFailure(input: {
  status: number
  headers?: { get(name: string): string | null }
  body?: { errors?: GraphQLErrorEntry[] } | null
}): ProviderError {
  const { status, headers, body } = input
  const resetAt = headers?.get("x-ratelimit-reset") ?? undefined
  const retryAfter = headers?.get("retry-after") ?? resetAt
  const remaining = headers?.get("x-ratelimit-remaining")
  const entries = body?.errors ?? []
  const types = entries.map((entry) => entry.type).filter((type): type is string => typeof type === "string")
  const messages = entries
    .map((entry) => entry.message)
    .filter((message): message is string => typeof message === "string")
  const joined = messages.join(" | ").slice(0, 500)

  if (types.includes("RATE_LIMITED")) {
    return { kind: "rate-limited", message: joined || "GraphQL RATE_LIMITED", retryable: true, ...(retryAfter ? { retryAfter } : {}) }
  }
  if (status === 401) return { kind: "auth", message: joined || "unauthenticated", retryable: false }
  if (status === 403 && remaining === "0") {
    return { kind: "rate-limited", message: joined || "primary rate limit exhausted", retryable: true, ...(retryAfter ? { retryAfter } : {}) }
  }
  if (status === 403 && /secondary rate limit|abuse/i.test(joined)) {
    return { kind: "rate-limited", message: joined, retryable: true, ...(retryAfter ? { retryAfter } : {}) }
  }
  if (status === 403) return { kind: "auth", message: joined || "forbidden: check the token's scopes", retryable: false }
  if (status === 404 || types.includes("NOT_FOUND")) return { kind: "not-found", message: joined || "not found", retryable: false }
  if (status >= 500) return { kind: "transient", message: joined || `server error ${status}`, retryable: true }
  if (types.includes("FORBIDDEN")) return { kind: "auth", message: joined, retryable: false }
  // `EXCESSIVE_PAGINATION` is the `first: 101` refusal the spike measured: a
  // well-formed request the provider will not serve, which is the caller's
  // mistake rather than a missing capability.
  if (types.includes("EXCESSIVE_PAGINATION") || types.includes("ARGUMENT_LIMIT")) {
    return { kind: "invalid", message: joined, retryable: false }
  }
  if (types.includes("VALIDATION") || types.includes("UNPROCESSABLE")) {
    return { kind: "unsupported", message: joined, retryable: false, capability: "github.graphql" }
  }
  if (entries.length > 0) {
    // Untyped errors under HTTP 200. Treated as `invalid` rather than
    // `unsupported` because `unsupported` must name a capability, and a bad
    // argument is not a missing capability.
    return { kind: "invalid", message: joined, retryable: false }
  }
  return { kind: "transient", message: `unclassified status ${status}`, retryable: true }
}

function rateLimitFrom(data: Record<string, unknown>): ProviderRateLimit | undefined {
  const raw = data.rateLimit as Record<string, unknown> | undefined
  if (raw === undefined || raw === null) return undefined
  const limit = Number(raw.limit)
  const remaining = Number(raw.remaining)
  const resetAt = typeof raw.resetAt === "string" ? raw.resetAt : undefined
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || resetAt === undefined) return undefined
  return {
    limit,
    remaining,
    resetAt,
    unit: "points",
    ...(Number.isFinite(Number(raw.cost)) ? { costOfLastOperation: Number(raw.cost) } : {})
  }
}

export type LiveTransportOptions = {
  token: string
  /** Injected for tests; defaults to the global. */
  fetchImpl?: typeof fetch
  userAgent?: string
}

export function liveTransport(options: LiveTransportOptions): GitHubTransport {
  const doFetch = options.fetchImpl ?? fetch
  let seen: ProviderRateLimit | undefined

  return {
    mode: "live",
    lastRateLimit: () => seen,
    async execute(request) {
      let response: Awaited<ReturnType<typeof fetch>>
      let body: { data?: Record<string, unknown>; errors?: GraphQLErrorEntry[] } | null
      try {
        response = await doFetch(GRAPHQL_URL, {
          method: "POST",
          headers: {
            authorization: `bearer ${options.token}`,
            "content-type": "application/json",
            "user-agent": options.userAgent ?? "mapctx-github-provider"
          },
          body: JSON.stringify({ query: request.document, variables: request.variables })
        })
        body = (await response.json()) as typeof body
      } catch (cause) {
        return err("transient", `graphql request failed: ${String((cause as Error)?.message ?? cause)}`)
      }
      if (!response.ok || body?.errors !== undefined) {
        return { ok: false, error: classifyGitHubFailure({ status: response.status, headers: response.headers, body }) }
      }
      const data = body?.data ?? {}
      const rateLimit = rateLimitFrom(data)
      if (rateLimit !== undefined) seen = rateLimit
      return { ok: true, value: { data, ...(rateLimit ? { rateLimit } : {}) } }
    }
  }
}

export type FixtureEntry = {
  key: string
  label: string
  variables: Record<string, unknown>
  /** A recorded success. Exactly one of `data` or `errors` is present. */
  data?: Record<string, unknown>
  /** A recorded failure, replayed through the same classification as a live one. */
  errors?: GraphQLErrorEntry[]
  status?: number
}

export type FixtureFile = {
  /** Whether these bytes came off the live API or were written by hand. */
  provenance: "recorded" | "synthetic" | "recorded+synthetic"
  note?: string
  recordedAt?: string
  entries: FixtureEntry[]
}

export function fixtureTransport(files: readonly FixtureFile[]): GitHubTransport {
  const byKey = new Map<string, FixtureEntry>()
  for (const file of files) {
    for (const entry of file.entries) byKey.set(entry.key, entry)
  }
  let seen: ProviderRateLimit | undefined

  return {
    mode: "fixture",
    lastRateLimit: () => seen,
    async execute(request) {
      const key = fixtureKey(request)
      const entry = byKey.get(key)
      if (entry === undefined) {
        // Loud on purpose. A fixture transport that invented an empty response
        // would let the contract suite pass against nothing at all.
        return err("not-found", `no fixture recorded for ${key}`)
      }
      if (entry.errors !== undefined) {
        return { ok: false, error: classifyGitHubFailure({ status: entry.status ?? 200, body: { errors: entry.errors } }) }
      }
      const data = entry.data ?? {}
      const rateLimit = rateLimitFrom(data)
      if (rateLimit !== undefined) seen = rateLimit
      return { ok: true, value: { data, ...(rateLimit ? { rateLimit } : {}) } }
    }
  }
}
