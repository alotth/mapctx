#!/usr/bin/env node
// T-135: re-derive every table the spike report publishes, straight from the
// committed captures in measurements/.
//
// This exists because the report's first version quoted figures from runs that
// were never committed. The numbers in docs/engineering/github-projects-spike.md
// are this script's output, so anyone can check them:
//
//   node scripts/spikes/github-projects/bin/aggregate-metrics.mjs
//
// Statistics are stated rather than implied: median is the mean of the two
// middle values for an even sample, and p90 is nearest-rank (no interpolation).

import fs from 'node:fs'
import path from 'node:path'
import { SPIKE_DIR, parseArgs } from '../lib/config.mjs'

function median(sorted) {
  const n = sorted.length
  if (n === 0) return null
  const mid = Math.floor(n / 2)
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function nearestRankP90(sorted) {
  if (sorted.length === 0) return null
  // Nearest-rank: smallest value at or above the 90th percentile position.
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)]
}

function fmt(v) {
  if (v === null) return '—'
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

function main() {
  const args = parseArgs()
  const dir = path.resolve(SPIKE_DIR, args.measurements ?? 'measurements')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()

  const byLabel = new Map()
  let metricRows = 0
  let measuredCalls = 0
  let skipped = 0
  const captures = {}

  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    captures[f] = doc
    for (const m of doc.metrics ?? []) {
      metricRows += 1
      if (m.skipped || m.latencyMs === undefined) {
        skipped += 1
        continue
      }
      measuredCalls += 1
      const agg = byLabel.get(m.label) ?? { label: m.label, api: m.api, mutation: Boolean(m.mutation), lat: [], points: [], files: new Set() }
      agg.lat.push(m.latencyMs)
      if (typeof m.pointsCost === 'number') agg.points.push(m.pointsCost)
      agg.files.add(f)
      byLabel.set(m.label, agg)
    }
  }

  const rows = [...byLabel.values()]
    .map((a) => {
      const sorted = [...a.lat].sort((x, y) => x - y)
      const pointSet = new Set(a.points)
      return {
        label: a.label,
        kind: a.mutation ? 'mutation' : a.api === 'rest' ? 'REST' : 'query',
        n: sorted.length,
        points: pointSet.size === 1 ? [...pointSet][0] : pointSet.size === 0 ? null : 'varies',
        min: sorted[0],
        med: median(sorted),
        p90: nearestRankP90(sorted),
        max: sorted[sorted.length - 1],
        files: [...a.files].join(' '),
      }
    })
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))

  const out = []
  out.push(`# Re-derived from ${files.length} captures: ${files.join(', ')}`)
  out.push(`# metric rows: ${metricRows}; measured calls (with latency): ${measuredCalls}; skipped/dry-run: ${skipped}`)
  out.push('')
  out.push('| Operation | kind | n | points | min | median | p90 | max |')
  out.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const r of rows) {
    out.push(`| \`${r.label}\` | ${r.kind} | ${r.n} | ${r.points ?? '—'} | ${fmt(r.min)} | ${fmt(r.med)} | ${fmt(r.p90)} | ${fmt(r.max)} |`)
  }

  // Mutations cannot select `rateLimit`, so their cost is the step in
  // `x-ratelimit-used` between consecutive calls in the same capture. The
  // counter resets when the hourly window rolls, so negative steps are
  // discarded rather than averaged in.
  const mutationSteps = new Map()
  let discardedResets = 0
  for (const f of files) {
    let prev = null
    for (const m of captures[f].metrics ?? []) {
      const used = m.headerUsed === undefined || m.headerUsed === null ? null : Number(m.headerUsed)
      if (used === null) continue
      if (prev !== null && m.mutation) {
        const step = used - prev
        if (step < 0) discardedResets += 1
        else mutationSteps.set(step, (mutationSteps.get(step) ?? 0) + 1)
      }
      prev = used
    }
  }
  out.push('')
  out.push('## Mutation cost, from the `x-ratelimit-used` step')
  out.push(`- observed steps: ${JSON.stringify(Object.fromEntries([...mutationSteps.entries()].sort((a, b) => a[0] - b[0])))}`)
  out.push(`- window resets discarded: ${discardedResets}`)

  const write = captures['03-write.json']
  const limits = captures['04-limits.json']
  out.push('')
  out.push('## Single-source figures')
  if (limits) {
    out.push(`- concurrencyProbe: ${JSON.stringify(limits.concurrencyProbe)}`)
    out.push(`- idempotenceProbe.number: ${JSON.stringify(limits.idempotenceProbe?.number)}`)
    out.push(`- idempotenceProbe.single-select: ${JSON.stringify(limits.idempotenceProbe?.['single-select'])}`)
    out.push(`- batchProbe: ${JSON.stringify((limits.batchProbe ?? []).map((b) => ({ aliases: b.aliasCount, ok: b.ok, ms: b.latencyMs })))}`)
    out.push(`- batchPartialFailureProbe: ${JSON.stringify(limits.batchPartialFailureProbe)}`)
    out.push(`- fieldLimitProbe: ${JSON.stringify(limits.fieldLimitProbe)}`)
    out.push(`- projectAfter.fieldCount: ${limits.projectAfter?.fieldCount}`)
  }
  if (write) {
    out.push(`- pass1: writes=${write.pass1?.writes} failures=${write.pass1?.failures?.length}`)
    out.push(`- verification failures: ${write.verification?.filter((v) => !v.ok).length}`)
    out.push(`- plannerWaves (provider statuses): ${JSON.stringify(write.derivation?.plannerWaves)}`)
    out.push(`- plannerWavesWithStoreStatus: ${JSON.stringify(write.derivation?.plannerWavesWithStoreStatus)}`)
    out.push(`- statusModeDivergence count: ${write.derivation?.statusModeDivergence?.length}`)
    out.push(`- edgeSource=${write.derivation?.edgeSource} providerEdges=${write.derivation?.providerEdgeCount} fallbackEdges=${write.derivation?.fallbackEdgeCount}`)
    out.push(`- serializedPairs: ${write.derivation?.serializedPairs?.length}`)
    out.push(`- clientMutationIdProbe: ${JSON.stringify(write.clientMutationIdProbe)}`)
  }

  process.stdout.write(`${out.join('\n')}\n`)
}

main()
