// T-135 spike transport: GitHub GraphQL + REST with per-operation cost and
// latency capture. Isolated from packages/ on purpose -- this is measurement
// code for the E-018 adapter decision, not production code.
//
// Token resolution is per-account on purpose: the spike must run as `alotth`
// (the only account with the `project` scope) without switching the active
// `gh` account, which other sessions depend on.

import { execFileSync } from 'node:child_process'

const GRAPHQL_URL = 'https://api.github.com/graphql'
const REST_BASE = 'https://api.github.com'

/** Resolve a token for one named gh account without changing the active one. */
export function tokenForAccount(account) {
  const out = execFileSync('gh', ['auth', 'token', '-u', account], { encoding: 'utf8' })
  const token = out.trim()
  if (!token) throw new Error(`gh auth token -u ${account} returned nothing`)
  return token
}

/**
 * Map a transport outcome onto the study's ProviderError kinds
 * (docs/engineering/provider-authority-study.md). The spike reports which
 * kinds it could actually observe; unobserved kinds stay unproven.
 */
export function classifyError({ status, headers, body }) {
  const h = headers ?? new Headers()
  const retryAfter = h.get?.('retry-after') ?? undefined
  const remaining = h.get?.('x-ratelimit-remaining')
  const reset = h.get?.('x-ratelimit-reset') ?? undefined
  const graphqlTypes = (body?.errors ?? []).map((e) => e.type).filter(Boolean)

  if (graphqlTypes.includes('RATE_LIMITED')) {
    return { kind: 'rate-limited', message: 'GraphQL RATE_LIMITED', retryAfter: reset }
  }
  if (status === 401) return { kind: 'auth', message: 'unauthenticated' }
  if (status === 403 && remaining === '0') {
    return { kind: 'rate-limited', message: 'REST primary rate limit', retryAfter: reset }
  }
  if (status === 403 && /secondary rate limit|abuse/i.test(JSON.stringify(body ?? ''))) {
    return { kind: 'rate-limited', message: 'REST secondary rate limit', retryAfter }
  }
  if (status === 403) return { kind: 'auth', message: 'forbidden (scope or permission)' }
  if (status === 404) return { kind: 'not-found', message: 'not found' }
  if (status === 409) return { kind: 'conflict', message: 'conflict' }
  if (status === 422) return { kind: 'conflict', message: 'unprocessable' }
  if (status >= 500) return { kind: 'transient', message: `server error ${status}` }
  if (graphqlTypes.includes('NOT_FOUND')) return { kind: 'not-found', message: 'GraphQL NOT_FOUND' }
  if (graphqlTypes.includes('FORBIDDEN')) return { kind: 'auth', message: 'GraphQL FORBIDDEN' }
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    // Unknown field / unsupported argument / schema violation shows up here,
    // untyped and with HTTP 200. The adapter needs the message to discover a
    // capability at write time, so it is never swallowed.
    return {
      kind: 'unsupported',
      message: body.errors.map((e) => e.message).join(' | ').slice(0, 500),
      graphqlTypes,
    }
  }
  return { kind: 'transient', message: `unclassified status ${status}` }
}

export function createClient({ account = 'alotth', dryRun = false } = {}) {
  const token = tokenForAccount(account)
  /** @type {Array<Record<string, unknown>>} */
  const metrics = []

  async function graphql(query, variables = {}, { label = 'graphql', mutation = false } = {}) {
    if (dryRun && mutation) {
      metrics.push({ label, api: 'graphql', skipped: 'dry-run' })
      return { ok: true, value: undefined, skipped: true }
    }
    const startedAt = performance.now()
    let res
    let body
    try {
      res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          authorization: `bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'mapctx-t135-spike',
        },
        body: JSON.stringify({ query, variables }),
      })
      body = await res.json()
    } catch (cause) {
      const latencyMs = Math.round(performance.now() - startedAt)
      metrics.push({ label, api: 'graphql', mutation, latencyMs, error: 'network' })
      return { ok: false, error: { kind: 'transient', message: String(cause?.message ?? cause) } }
    }
    const latencyMs = Math.round(performance.now() - startedAt)
    const rl = body?.data?.rateLimit ?? null
    const record = {
      label,
      api: 'graphql',
      mutation,
      status: res.status,
      latencyMs,
      pointsCost: rl?.cost ?? null,
      pointsRemaining: rl?.remaining ?? null,
      // GraphQL mutations do not accept a rateLimit selection, so their cost is
      // read from the response header instead of the payload.
      headerUsed: res.headers.get('x-ratelimit-used'),
      headerRemaining: res.headers.get('x-ratelimit-remaining'),
      requestId: res.headers.get('x-github-request-id'),
    }
    metrics.push(record)
    if (!res.ok || body?.errors) {
      return { ok: false, error: classifyError({ status: res.status, headers: res.headers, body }), metric: record }
    }
    return { ok: true, value: body.data, metric: record }
  }

  async function rest(method, path, { body: payload, label = `rest ${method} ${path}`, mutation = false } = {}) {
    if (dryRun && mutation) {
      metrics.push({ label, api: 'rest', skipped: 'dry-run' })
      return { ok: true, value: undefined, skipped: true }
    }
    const startedAt = performance.now()
    let res
    let body
    try {
      res = await fetch(`${REST_BASE}${path}`, {
        method,
        headers: {
          authorization: `bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'mapctx-t135-spike',
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      })
      const text = await res.text()
      body = text ? JSON.parse(text) : null
    } catch (cause) {
      const latencyMs = Math.round(performance.now() - startedAt)
      metrics.push({ label, api: 'rest', mutation, latencyMs, error: 'network' })
      return { ok: false, error: { kind: 'transient', message: String(cause?.message ?? cause) } }
    }
    const latencyMs = Math.round(performance.now() - startedAt)
    const record = {
      label,
      api: 'rest',
      mutation,
      status: res.status,
      latencyMs,
      // REST has no points model: it spends one unit of the 5000/h REST budget,
      // a budget separate from the 5000 points/h GraphQL budget.
      restUsed: res.headers.get('x-ratelimit-used'),
      restRemaining: res.headers.get('x-ratelimit-remaining'),
      restResource: res.headers.get('x-ratelimit-resource'),
      link: res.headers.get('link'),
      requestId: res.headers.get('x-github-request-id'),
    }
    metrics.push(record)
    if (!res.ok) {
      return { ok: false, error: classifyError({ status: res.status, headers: res.headers, body }), metric: record }
    }
    return { ok: true, value: body, metric: record }
  }

  return {
    account,
    dryRun,
    graphql,
    rest,
    metrics,
    summary() {
      const byLabel = new Map()
      for (const m of metrics) {
        if (m.skipped || m.latencyMs === undefined) continue
        const agg = byLabel.get(m.label) ?? { label: m.label, api: m.api, calls: 0, latencyMs: [], points: 0 }
        agg.calls += 1
        agg.latencyMs.push(m.latencyMs)
        if (typeof m.pointsCost === 'number') agg.points += m.pointsCost
        byLabel.set(m.label, agg)
      }
      return [...byLabel.values()].map((a) => ({
        label: a.label,
        api: a.api,
        calls: a.calls,
        pointsTotal: a.points,
        latencyMinMs: Math.min(...a.latencyMs),
        latencyMaxMs: Math.max(...a.latencyMs),
        latencyMeanMs: Math.round(a.latencyMs.reduce((s, v) => s + v, 0) / a.latencyMs.length),
      }))
    },
  }
}

/** `rateLimit { cost remaining limit }` tail every measured query carries. */
export const RATE_LIMIT_SELECTION = 'rateLimit { cost remaining limit resetAt }'
