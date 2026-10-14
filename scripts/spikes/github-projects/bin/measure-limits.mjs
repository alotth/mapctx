#!/usr/bin/env node
// T-135 step 4: the limits an adapter has to live inside, measured rather than
// quoted -- field count per project, page sizes, alias batching, concurrency,
// and a clean idempotence probe (one field, one item, nothing else moving).
//
//   node scripts/spikes/github-projects/bin/measure-limits.mjs \
//     --project-number 3 --max-field-probe 60 --out measurements/04-limits.json
//
// Probe fields are deleted again at the end; the six derived fields are never
// touched.

import fs from 'node:fs'
import path from 'node:path'
import { createClient, RATE_LIMIT_SELECTION } from '../lib/gh.mjs'
import { createGithubProvider } from '../lib/provider.mjs'
import { DERIVED_FIELDS, SPIKE_DIR, parseArgs, redactArgs } from '../lib/config.mjs'
import { taskIdFromTitle } from '../lib/derive.mjs'

const PROBE_PREFIX = 'zz-probe-'

async function readItemUpdatedAt(client, itemId) {
  const res = await client.graphql(
    `query($itemId: ID!) { node(id: $itemId) { ... on ProjectV2Item { id updatedAt } } ${RATE_LIMIT_SELECTION} }`,
    { itemId },
    { label: 'read item updatedAt' },
  )
  return res.ok ? res.value.node.updatedAt : null
}

async function readFieldValue(client, itemId, fieldId) {
  const res = await client.graphql(
    `query($itemId: ID!) {
       node(id: $itemId) { ... on ProjectV2Item {
         fieldValues(first: 30) { nodes {
           __typename
           ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { id } } }
           ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2FieldCommon { id } } }
         } } } }
       ${RATE_LIMIT_SELECTION}
     }`,
    { itemId },
    { label: 'read one field value' },
  )
  if (!res.ok) return null
  const hit = (res.value.node.fieldValues.nodes ?? []).find((v) => v?.field?.id === fieldId)
  return hit ? (hit.number ?? hit.optionId ?? null) : null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const args = parseArgs()
  const client = createClient({ account: args.account })
  const provider = createGithubProvider(client)
  const out = { startedAt: new Date().toISOString(), args: redactArgs(args) }

  const project = await provider.getProject({ owner: args.owner, number: args.projectNumber })
  if (!project.ok) throw new Error(`getProject failed: ${JSON.stringify(project.error)}`)
  const projectId = project.value.id
  out.projectBefore = { fieldCount: project.value.fieldCount, itemCount: project.value.itemCount }

  const page = await provider.listItems({ projectId, first: 100 })
  if (!page.ok) throw new Error(`listItems failed: ${JSON.stringify(page.error)}`)
  const sample = page.value.items.find((i) => taskIdFromTitle(i.fields.title))
  const itemId = sample.ref.projectItem.itemId
  const numberField = project.value.fields.find((f) => f.name === 'Forecast P50 (h)')
  const selectField = project.value.fields.find((f) => f.name === 'Wave')

  // ---- 1. Page-size ceilings. Connections reject `first` above 100.
  out.pageSizeProbe = []
  for (const first of [100, 101]) {
    const res = await client.graphql(
      `query($projectId: ID!, $first: Int!) { node(id: $projectId) { ... on ProjectV2 { items(first: $first) { totalCount } } } ${RATE_LIMIT_SELECTION} }`,
      { projectId, first },
      { label: `items(first=${first})` },
    )
    out.pageSizeProbe.push({ first, ok: res.ok, error: res.ok ? undefined : res.error })
  }

  // ---- 2. Idempotence, measured in isolation: read revision, re-send the
  // identical value, read revision again. Nothing else writes in between.
  out.idempotenceProbe = {}
  for (const [label, field, value] of [
    ['number', numberField, await readFieldValue(client, itemId, numberField.id)],
    ['single-select', selectField, await readFieldValue(client, itemId, selectField.id)],
  ]) {
    const before = await readItemUpdatedAt(client, itemId)
    await sleep(2000)
    const write = await provider.setField({
      fieldRef: {
        semantic: label,
        surface: 'project-item',
        projectId,
        projectItemId: itemId,
        providerFieldId: field.id,
        dataType: field.dataType,
        optionId: field.dataType === 'SINGLE_SELECT' ? value : undefined,
      },
      value: field.dataType === 'SINGLE_SELECT' ? value : value,
      clientOperationId: `t135-idem-${label}`,
    })
    const after = await readItemUpdatedAt(client, itemId)
    out.idempotenceProbe[label] = {
      field: field.name,
      dataType: field.dataType,
      valueResent: value,
      ok: write.ok,
      updatedAtBefore: before,
      updatedAtAfter: after,
      revisionMoved: before !== after,
    }
  }

  // ---- 3. Alias batching: how many field writes fit in one request, and what
  // the request costs compared with the same writes sent one at a time.
  out.batchProbe = []
  for (const aliasCount of [1, 5, 10, 25, 50]) {
    const varDefs = []
    const bodies = []
    const variables = {}
    for (let i = 0; i < aliasCount; i += 1) {
      varDefs.push(`$v${i}: ProjectV2FieldValue!`)
      bodies.push(
        `  w${i}: updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $v${i} }) { projectV2Item { id } }`,
      )
      variables[`v${i}`] = { number: 3 + i }
    }
    const doc = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, ${varDefs.join(', ')}) {\n${bodies.join('\n')}\n}`
    const res = await client.graphql(
      doc,
      { projectId, itemId, fieldId: numberField.id, ...variables },
      { label: `batch(${aliasCount} aliases)`, mutation: true },
    )
    out.batchProbe.push({
      aliasCount,
      ok: res.ok,
      error: res.ok ? undefined : res.error,
      latencyMs: res.metric?.latencyMs,
      headerUsedAfter: res.metric?.headerUsed,
      headerRemainingAfter: res.metric?.headerRemaining,
    })
  }

  // ---- 3b. Partial failure in a batch: three aliases, the middle one invalid.
  // A GraphQL document is not a transaction, so the question is what survives.
  {
    const marker = 777
    const doc = `mutation($projectId: ID!, $itemId: ID!, $numberField: ID!, $selectField: ID!, $good: ProjectV2FieldValue!, $bad: ProjectV2FieldValue!) {
      w0: updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $numberField, value: $good }) { projectV2Item { id } }
      w1: updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $selectField, value: $bad }) { projectV2Item { id } }
      w2: updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $numberField, value: $good }) { projectV2Item { id } }
    }`
    const res = await client.graphql(
      doc,
      {
        projectId,
        itemId,
        numberField: numberField.id,
        selectField: selectField.id,
        good: { number: marker },
        // A number value aimed at a single-select column: rejected by the column,
        // not by the schema, so it fails at execution rather than validation.
        bad: { number: marker },
      },
      { label: 'batch with one invalid alias', mutation: true },
    )
    const readAfter = await readFieldValue(client, itemId, numberField.id)
    out.batchPartialFailureProbe = {
      aliases: 3,
      invalidAlias: 'w1 (number value written to a SINGLE_SELECT column)',
      requestOk: res.ok,
      error: res.ok ? undefined : res.error,
      validAliasMarker: marker,
      numberFieldAfter: readAfter,
      validAliasesApplied: readAfter === marker,
    }
  }

  // ---- 4. Concurrency: ten writes in flight at once, which is roughly what N
  // agents each flushing their derived fields would look like.
  const concurrency = 10
  const startedConcurrentAt = performance.now()
  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, i) =>
      provider.setField({
        fieldRef: { semantic: 'p50', surface: 'project-item', projectId, projectItemId: itemId, providerFieldId: numberField.id, dataType: 'NUMBER' },
        value: 2 + i / 100,
        clientOperationId: `t135-concurrent-${i}`,
      }),
    ),
  )
  out.concurrencyProbe = {
    requests: concurrency,
    wallClockMs: Math.round(performance.now() - startedConcurrentAt),
    ok: results.filter((r) => r.ok).length,
    errors: results.filter((r) => !r.ok).map((r) => r.error),
  }

  // ---- 5. Field-count ceiling. Create probe fields until the API refuses.
  const maxProbe = Number(args.maxFieldProbe ?? 60)
  const probeFieldIds = []
  let fieldLimitError = null
  let created = 0
  for (let i = 0; i < maxProbe; i += 1) {
    const res = await provider.createField({
      projectId,
      name: `${PROBE_PREFIX}${String(i).padStart(3, '0')}`,
      dataType: 'TEXT',
      clientOperationId: `t135-probe-field-${i}`,
    })
    if (!res.ok) {
      fieldLimitError = res.error
      break
    }
    probeFieldIds.push(res.value.id)
    created += 1
  }
  const afterProbe = await provider.getProject({ owner: args.owner, number: args.projectNumber })
  out.fieldLimitProbe = {
    probeFieldsAttempted: maxProbe,
    probeFieldsCreated: created,
    fieldCountReached: afterProbe.ok ? afterProbe.value.fieldCount : null,
    fieldsPageHasNextAt100: afterProbe.ok ? afterProbe.value.fieldsHasNextPage : null,
    stoppedBy: fieldLimitError ?? 'probe budget exhausted (no API refusal observed)',
  }

  // Clean up every probe field; the six derived fields stay.
  const deleted = []
  for (const id of probeFieldIds) {
    const res = await client.graphql(
      `mutation($fieldId: ID!) { deleteProjectV2Field(input: { fieldId: $fieldId }) { projectV2Field { ... on ProjectV2FieldCommon { id name } } } }`,
      { fieldId: id },
      { label: 'deleteProjectV2Field', mutation: true },
    )
    deleted.push({ id, ok: res.ok, error: res.ok ? undefined : res.error })
  }
  out.probeCleanup = { attempted: probeFieldIds.length, failed: deleted.filter((d) => !d.ok) }

  // Restore the probed number field to the value write-derived.mjs computed.
  out.restoreNote = 'rerun write-derived.mjs to restore Forecast P50 (h) on the probed item'

  const finalProject = await provider.getProject({ owner: args.owner, number: args.projectNumber })
  out.projectAfter = finalProject.ok
    ? { fieldCount: finalProject.value.fieldCount, fieldNames: finalProject.value.fields.map((f) => f.name) }
    : null
  out.derivedFieldsIntact = finalProject.ok
    ? DERIVED_FIELDS.every((s) => finalProject.value.fields.some((f) => f.name === s.name))
    : null

  out.endedAt = new Date().toISOString()
  out.metrics = client.metrics
  out.metricsSummary = client.summary()

  const outPath = path.resolve(SPIKE_DIR, args.out ?? 'measurements/04-limits.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`)
  process.stdout.write(
    `${JSON.stringify(
      {
        pageSizeProbe: out.pageSizeProbe,
        idempotenceProbe: out.idempotenceProbe,
        batchProbe: out.batchProbe,
        batchPartialFailureProbe: out.batchPartialFailureProbe,
        concurrencyProbe: out.concurrencyProbe,
        fieldLimitProbe: out.fieldLimitProbe,
        derivedFieldsIntact: out.derivedFieldsIntact,
        wrote: outPath,
      },
      null,
      2,
    )}\n`,
  )
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`)
  process.exitCode = 1
})
