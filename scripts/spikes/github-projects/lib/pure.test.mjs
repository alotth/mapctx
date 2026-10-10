// T-135 spike: unit tests for the pure logic in gh.mjs and derive.mjs.
// No network, no `gh` CLI, no MapCtx store -- classifyError, taskIdFromTitle,
// statusFromProvider and wavesFromProvider's edge handling only.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyError } from './gh.mjs'
import { taskIdFromTitle, statusFromProvider, wavesFromProvider } from './derive.mjs'

// ---- classifyError -----------------------------------------------------

test('classifyError: 401 -> auth', () => {
  const err = classifyError({ status: 401, headers: new Headers(), body: null })
  assert.equal(err.kind, 'auth')
})

test('classifyError: 403 with exhausted primary rate limit -> rate-limited', () => {
  const err = classifyError({
    status: 403,
    headers: new Headers({ 'x-ratelimit-remaining': '0' }),
    body: null,
  })
  assert.equal(err.kind, 'rate-limited')
})

test('classifyError: 403 otherwise -> auth', () => {
  const err = classifyError({
    status: 403,
    headers: new Headers({ 'x-ratelimit-remaining': '42' }),
    body: null,
  })
  assert.equal(err.kind, 'auth')
})

test('classifyError: 404 -> not-found', () => {
  const err = classifyError({ status: 404, headers: new Headers(), body: null })
  assert.equal(err.kind, 'not-found')
})

test('classifyError: 422 -> conflict', () => {
  const err = classifyError({ status: 422, headers: new Headers(), body: null })
  assert.equal(err.kind, 'conflict')
})

test('classifyError: 409 -> conflict', () => {
  const err = classifyError({ status: 409, headers: new Headers(), body: null })
  assert.equal(err.kind, 'conflict')
})

test('classifyError: 500 -> transient', () => {
  const err = classifyError({ status: 500, headers: new Headers(), body: null })
  assert.equal(err.kind, 'transient')
})

test('classifyError: GraphQL RATE_LIMITED error -> rate-limited', () => {
  const err = classifyError({
    status: 200,
    headers: new Headers(),
    body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
  })
  assert.equal(err.kind, 'rate-limited')
})

// HTTP 200 with an untyped GraphQL `errors` array is how GitHub reports a
// schema-level write rejection (field/mutation unsupported for this project
// type). The adapter needs the raw message to tell capabilities apart, so it
// must survive classification verbatim.
test('classifyError: HTTP 200 with untyped errors array -> unsupported, message preserved', () => {
  const err = classifyError({
    status: 200,
    headers: new Headers(),
    body: { errors: [{ message: 'Roadmap views do not support visible fields.' }] },
  })
  assert.equal(err.kind, 'unsupported')
  assert.equal(err.message, 'Roadmap views do not support visible fields.')
})

test('classifyError: HTTP 200 with untyped errors array -> field-count message preserved', () => {
  const err = classifyError({
    status: 200,
    headers: new Headers(),
    body: { errors: [{ message: 'Projects cannot have more than 50 fields.' }] },
  })
  assert.equal(err.kind, 'unsupported')
  assert.equal(err.message, 'Projects cannot have more than 50 fields.')
})

// ---- taskIdFromTitle ----------------------------------------------------

test('taskIdFromTitle: [T-135] prefix', () => {
  assert.equal(taskIdFromTitle('[T-135] Spike: provider adapter'), 'T-135')
})

test('taskIdFromTitle: [E-018] prefix', () => {
  assert.equal(taskIdFromTitle('[E-018] GitHub Projects spike'), 'E-018')
})

test('taskIdFromTitle: no bracketed id -> null', () => {
  assert.equal(taskIdFromTitle('Just a draft title'), null)
})

test('taskIdFromTitle: undefined/empty -> null', () => {
  assert.equal(taskIdFromTitle(undefined), null)
  assert.equal(taskIdFromTitle(''), null)
})

test('taskIdFromTitle: bracketed id not at start -> null', () => {
  assert.equal(taskIdFromTitle('Spike: [T-135] provider adapter'), null)
})

// ---- statusFromProvider ---------------------------------------------------

test('statusFromProvider: CLOSED -> done', () => {
  const item = { fields: { planningState: 'CLOSED' } }
  assert.equal(statusFromProvider(item, 'doing', 'provider'), 'done')
})

test('statusFromProvider: OPEN -> ready-for-do', () => {
  const item = { fields: { planningState: 'OPEN' } }
  assert.equal(statusFromProvider(item, 'blocked', 'provider'), 'ready-for-do')
})

// A draft has no planningState at all. statusMode: 'provider' is the honest
// provider reading -- a two-state provider cannot see paused/review/done, so
// it reads every draft as schedulable regardless of what the store says.
test('statusFromProvider: draft under statusMode "provider" -> ready-for-do regardless of store status', () => {
  const draft = { fields: {} }
  assert.equal(statusFromProvider(draft, 'doing', 'provider'), 'ready-for-do')
  assert.equal(statusFromProvider(draft, 'review', 'provider'), 'ready-for-do')
})

test('statusFromProvider: draft under statusMode "store" -> store status', () => {
  const draft = { fields: {} }
  assert.equal(statusFromProvider(draft, 'doing', 'store'), 'doing')
})

test('statusFromProvider: draft under statusMode "store" with no store status -> ready-for-do', () => {
  const draft = { fields: {} }
  assert.equal(statusFromProvider(draft, undefined, 'store'), 'ready-for-do')
})

// ---- wavesFromProvider: edge handling --------------------------------------

function item(key, taskId, planningState = 'OPEN') {
  return {
    ref: { provider: 'github', workItem: { id: `gid-${key}`, key, url: `https://github.com/issues/${key}` } },
    fields: { title: `[${taskId}] a`, planningState },
  }
}

test('wavesFromProvider: provider "blocked-by" edge -- blocker in an earlier wave', () => {
  const providerItems = [item('itemA', 'T-001'), item('itemB', 'T-002')]
  // A is blocked-by B: A cannot start before B finishes.
  const providerDependencies = [
    { from: { workItem: { key: 'itemA' } }, to: { workItem: { key: 'itemB' } }, kind: 'blocked-by' },
  ]
  const result = wavesFromProvider({
    providerItems,
    providerDependencies,
    storeEdges: [],
    storeTasks: new Map(),
  })
  assert.equal(result.edgeSource, 'provider')
  assert.equal(result.providerEdgeCount, 1)
  assert.ok(result.report.waveByTaskId['T-002'] < result.report.waveByTaskId['T-001'])
})

test('wavesFromProvider: provider "blocks" edge is inverted relative to "blocked-by"', () => {
  const providerItems = [item('itemA', 'T-001'), item('itemB', 'T-002')]
  // A blocks B: B cannot start before A finishes.
  const providerDependencies = [
    { from: { workItem: { key: 'itemA' } }, to: { workItem: { key: 'itemB' } }, kind: 'blocks' },
  ]
  const result = wavesFromProvider({
    providerItems,
    providerDependencies,
    storeEdges: [],
    storeTasks: new Map(),
  })
  assert.equal(result.edgeSource, 'provider')
  assert.ok(result.report.waveByTaskId['T-001'] < result.report.waveByTaskId['T-002'])
})

test('wavesFromProvider: no provider dependencies falls back to store edges, dropping out-of-corpus ends', () => {
  const providerItems = [item('itemA', 'T-001'), item('itemB', 'T-002')]
  const storeEdges = [
    { fromTaskId: 'T-001', toTaskId: 'T-002', kind: 'depends-on' },
    // T-999 is not in this corpus; this edge must be dropped, not counted.
    { fromTaskId: 'T-001', toTaskId: 'T-999', kind: 'depends-on' },
  ]
  const result = wavesFromProvider({
    providerItems,
    providerDependencies: [],
    storeEdges,
    storeTasks: new Map(),
  })
  assert.equal(result.edgeSource, 'store-fallback')
  assert.equal(result.providerEdgeCount, 0)
  assert.equal(result.fallbackEdgeCount, 1)
  assert.ok(result.report.waveByTaskId['T-002'] < result.report.waveByTaskId['T-001'])
})

// storeTasks is keyed by taskId (as parsed from the title), not by provider
// item key -- confirm fields merge through when a title carries a MapCtx id.
test('wavesFromProvider: merges type/filesAffected/domains from storeTasks by parsed taskId', () => {
  const providerItems = [item('itemA', 'T-001')]
  const storeTasks = new Map([
    ['T-001', { status: 'doing', type: 'bug', parentId: 'E-018', filesAffected: ['a.ts'], domains: ['STORE'] }],
  ])
  const result = wavesFromProvider({
    providerItems,
    providerDependencies: [],
    storeEdges: [],
    storeTasks,
  })
  const task = result.report.waves.flatMap((w) => w.tasks).find((t) => t.id === 'T-001')
  assert.equal(task.type, 'bug')
})
