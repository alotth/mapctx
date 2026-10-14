#!/usr/bin/env node
// T-135 step 3: compute the six derived fields with the real MapCtx packages
// and write them to the test Project, then measure what writing actually costs
// and whether repeating it is safe.
//
//   node scripts/spikes/github-projects/bin/write-derived.mjs \
//     --project-number 3 --out measurements/03-write.json [--usd-per-active-hour 0]

import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '../lib/gh.mjs'
import { createGithubProvider } from '../lib/provider.mjs'
import { readCorpus } from '../lib/store-input.mjs'
import { DERIVED_FIELDS, REPO_ROOT, SPIKE_DIR, parseArgs, redactArgs } from '../lib/config.mjs'
import { costForTask, forecastForTask, readStoreSnapshot, taskIdFromTitle, wavesFromProvider } from '../lib/derive.mjs'

/**
 * Usage rows for the cost path. The committed fixture is a `{note, rows}`
 * object holding shape-preserving synthetic rows; a bare array is accepted too,
 * so a run against a locally dumped file needs no reshaping.
 */
function loadUsageEvents(file) {
  if (!file) return []
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  return Array.isArray(parsed) ? parsed : (parsed.rows ?? [])
}

/**
 * Several field writes in ONE GraphQL document, via aliases. This is the batch
 * question for the rate-limit risk: N agents each writing 6 fields.
 */
async function batchSetFields(client, writes) {
  const varDefs = []
  const bodies = []
  const variables = {}
  writes.forEach((w, i) => {
    varDefs.push(`$p${i}: ID!, $i${i}: ID!, $f${i}: ID!, $v${i}: ProjectV2FieldValue!`)
    bodies.push(
      `  w${i}: updateProjectV2ItemFieldValue(input: { projectId: $p${i}, itemId: $i${i}, fieldId: $f${i}, value: $v${i}, clientMutationId: "t135-batch-${i}" }) { projectV2Item { id updatedAt } }`,
    )
    variables[`p${i}`] = w.projectId
    variables[`i${i}`] = w.itemId
    variables[`f${i}`] = w.fieldId
    variables[`v${i}`] = w.value
  })
  const doc = `mutation(${varDefs.join(', ')}) {\n${bodies.join('\n')}\n}`
  return client.graphql(doc, variables, { label: `batchSetFields(${writes.length} aliases)`, mutation: true })
}

function graphqlValueFor(dataType, value, optionId) {
  if (value === null || value === undefined) return null
  if (dataType === 'NUMBER') return { number: Number(value) }
  if (dataType === 'DATE') return { date: value }
  if (dataType === 'TEXT') return { text: String(value) }
  if (dataType === 'SINGLE_SELECT') return optionId ? { singleSelectOptionId: optionId } : null
  return null
}

async function main() {
  const args = parseArgs()
  const client = createClient({ account: args.account, dryRun: Boolean(args.dryRun) })
  const provider = createGithubProvider(client)
  const today = new Date().toISOString().slice(0, 10)
  const out = { startedAt: new Date().toISOString(), args: redactArgs(args), today }

  const project = await provider.getProject({ owner: args.owner, number: args.projectNumber })
  if (!project.ok) throw new Error(`getProject failed: ${JSON.stringify(project.error)}`)
  const fieldByKey = {}
  for (const spec of DERIVED_FIELDS) {
    const f = project.value.fields.find((x) => x.name === spec.name)
    if (!f) throw new Error(`field ${spec.name} missing -- run setup-project.mjs first`)
    fieldByKey[spec.key] = { ...spec, id: f.id, options: f.options ?? null }
  }

  const page = await provider.listItems({ projectId: project.value.id, first: 100 })
  if (!page.ok) throw new Error(`listItems failed: ${JSON.stringify(page.error)}`)
  const providerItems = page.value.items.filter((i) => taskIdFromTitle(i.fields.title))
  const taskIds = providerItems.map((i) => taskIdFromTitle(i.fields.title))

  // MapCtx side: store read-only through the pinned CLI, planner over
  // provider-shaped input, forecast and cost from the store's own numbers.
  const corpus = readCorpus({ cli: args.cli, cwd: REPO_ROOT, taskIds })
  const snapshot = readStoreSnapshot({ cli: args.cli, cwd: REPO_ROOT })
  const waves = wavesFromProvider({
    providerItems,
    providerDependencies: [],
    storeEdges: corpus.edges,
    storeTasks: corpus.tasks,
    statusMode: 'provider',
  })
  // Same graph, store statuses: the difference between the two is exactly what
  // GitHub's two-state model costs the planner.
  const wavesStoreStatus = wavesFromProvider({
    providerItems,
    providerDependencies: [],
    storeEdges: corpus.edges,
    storeTasks: corpus.tasks,
    statusMode: 'store',
  })
  const usageEvents = loadUsageEvents(args.usageFile)

  out.derivation = {
    statusMode: waves.statusMode,
    edgeSource: waves.edgeSource,
    providerEdgeCount: waves.providerEdgeCount,
    fallbackEdgeCount: waves.fallbackEdgeCount,
    plannerWaves: waves.report.waves.map((w) => ({ wave: w.wave, taskIds: w.taskIds })),
    plannerBlocked: waves.report.blockedReasons,
    serializedPairs: waves.report.serializedPairs.map((p) => ({ a: p.taskAId, b: p.taskBId, domains: p.domains })),
    storeWaveByTaskId: Object.fromEntries(
      taskIds.map((id) => [id, snapshot.gantt.waveByTaskId?.[id] ?? null]),
    ),
    plannerWavesWithStoreStatus: wavesStoreStatus.report.waves.map((w) => ({ wave: w.wave, taskIds: w.taskIds })),
    statusModeDivergence: taskIds
      .map((id) => ({
        taskId: id,
        storeStatus: corpus.tasks.get(id)?.status ?? null,
        waveProviderStatus: waves.report.waveByTaskId[id] ?? null,
        waveStoreStatus: wavesStoreStatus.report.waveByTaskId[id] ?? null,
      }))
      .filter((r) => r.waveProviderStatus !== r.waveStoreStatus),
    usageEventCount: usageEvents.length,
  }

  // Values per item.
  const plan = []
  for (const item of providerItems) {
    const taskId = taskIdFromTitle(item.fields.title)
    const wave = waves.report.waveByTaskId[taskId] ?? null
    const forecast = forecastForTask({ gantt: snapshot.gantt, taskId, today })
    const cost = costForTask({
      taskId,
      usageEvents,
      p50Hours: forecast?.p50Hours ?? null,
      usdPerActiveHour: args.usdPerActiveHour ?? 0,
    })
    const waveOption = wave === null ? null : (fieldByKey.wave.options ?? []).find((o) => o.name === String(wave))
    plan.push({
      taskId,
      itemId: item.ref.projectItem.itemId,
      wave,
      waveOptionId: waveOption?.id ?? null,
      forecast,
      cost,
      writes: [
        { key: 'wave', dataType: 'SINGLE_SELECT', value: wave, optionId: waveOption?.id ?? null },
        { key: 'p50', dataType: 'NUMBER', value: forecast?.p50Hours ?? null },
        { key: 'p90', dataType: 'NUMBER', value: forecast?.p90Hours ?? null },
        { key: 'endP90', dataType: 'DATE', value: forecast?.endP90 ?? null },
        { key: 'estCost', dataType: 'NUMBER', value: cost.estimateUsd },
        { key: 'realCost', dataType: 'NUMBER', value: cost.actualUsd },
      ],
    })
  }
  out.plannedValues = plan

  // ---- Pass 1: one mutation per field, the simple adapter shape.
  const pass1 = []
  for (const row of plan) {
    for (const w of row.writes) {
      const res = await provider.setField({
        fieldRef: {
          semantic: w.key,
          surface: 'project-item',
          projectId: project.value.id,
          projectItemId: row.itemId,
          providerFieldId: fieldByKey[w.key].id,
          dataType: w.dataType,
          optionId: w.optionId ?? undefined,
        },
        value: w.value,
        clientOperationId: `t135-${row.taskId}-${w.key}`,
      })
      pass1.push({
        taskId: row.taskId,
        field: w.key,
        value: w.value,
        cleared: Boolean(res.cleared),
        ok: res.ok,
        error: res.ok ? undefined : res.error,
        itemUpdatedAt: res.ok ? res.value?.updatedAt : undefined,
        echoedClientMutationId: res.echoedClientMutationId,
      })
    }
  }
  out.pass1 = { writes: pass1.length, failures: pass1.filter((w) => !w.ok) }

  // ---- Read back: the retry-safety primitive the study specifies instead of
  // trusting clientMutationId.
  const verify = await provider.listItems({ projectId: project.value.id, first: 100 })
  if (!verify.ok) throw new Error(`verify listItems failed: ${JSON.stringify(verify.error)}`)
  const readBack = new Map()
  for (const it of verify.value.items) {
    const id = taskIdFromTitle(it.fields.title)
    if (id) readBack.set(id, { updatedAt: it.revision, values: it.projectFieldValues })
  }
  out.readBack = [...readBack.entries()].map(([taskId, v]) => ({
    taskId,
    updatedAt: v.updatedAt,
    derived: Object.fromEntries(
      DERIVED_FIELDS.map((spec) => {
        const got = v.values.find((x) => x.fieldName === spec.name)
        return [spec.name, got ? got.value : null]
      }),
    ),
  }))
  out.verification = plan.map((row) => {
    const got = readBack.get(row.taskId)
    const mismatches = []
    for (const w of row.writes) {
      const spec = DERIVED_FIELDS.find((s) => s.key === w.key)
      const found = got?.values.find((x) => x.fieldName === spec.name)
      const expected = w.key === 'wave' ? (w.value === null ? null : String(w.value)) : w.value
      const actual = found ? found.value : null
      const same = expected === null ? actual === null : String(actual) === String(expected)
      if (!same) mismatches.push({ field: spec.name, expected, actual })
    }
    return { taskId: row.taskId, ok: mismatches.length === 0, mismatches }
  })

  // ---- Pass 2: repeat the identical write with the identical
  // clientMutationId and see whether the item revision moves anyway.
  const sample = plan[0]
  const beforeRepeat = readBack.get(sample.taskId)?.updatedAt ?? null
  const repeatResults = []
  for (const w of sample.writes) {
    const res = await provider.setField({
      fieldRef: {
        semantic: w.key,
        surface: 'project-item',
        projectId: project.value.id,
        projectItemId: sample.itemId,
        providerFieldId: fieldByKey[w.key].id,
        dataType: w.dataType,
        optionId: w.optionId ?? undefined,
      },
      value: w.value,
      clientOperationId: `t135-${sample.taskId}-${w.key}`,
    })
    repeatResults.push({ field: w.key, ok: res.ok, itemUpdatedAt: res.ok ? res.value?.updatedAt : undefined })
  }
  out.idempotence = {
    taskId: sample.taskId,
    itemUpdatedAtBeforeRepeat: beforeRepeat,
    repeats: repeatResults,
    sameValueRepeatChangedRevision: repeatResults.some((r) => r.itemUpdatedAt && r.itemUpdatedAt !== beforeRepeat),
  }

  // ---- clientMutationId is an echo, not a de-duplication key: same id, new
  // value. If the second value lands, retry safety cannot rely on it.
  const probeField = fieldByKey.p50
  const probeValue = (sample.forecast?.p50Hours ?? 1) + 11
  const probe1 = await provider.setField({
    fieldRef: { semantic: 'p50', surface: 'project-item', projectId: project.value.id, projectItemId: sample.itemId, providerFieldId: probeField.id, dataType: 'NUMBER' },
    value: probeValue,
    clientOperationId: 't135-dedup-probe',
  })
  const probe2 = await provider.setField({
    fieldRef: { semantic: 'p50', surface: 'project-item', projectId: project.value.id, projectItemId: sample.itemId, providerFieldId: probeField.id, dataType: 'NUMBER' },
    value: probeValue + 1,
    clientOperationId: 't135-dedup-probe',
  })
  const afterProbe = await provider.listItems({ projectId: project.value.id, first: 100 })
  const probeItem = afterProbe.ok
    ? afterProbe.value.items.find((i) => taskIdFromTitle(i.fields.title) === sample.taskId)
    : null
  const probeRead = probeItem?.projectFieldValues.find((v) => v.fieldName === probeField.name)?.value ?? null
  out.clientMutationIdProbe = {
    taskId: sample.taskId,
    sentFirst: probeValue,
    sentSecond: probeValue + 1,
    readBack: probeRead,
    deduplicated: probeRead === probeValue,
    note: 'both mutations carried the same clientMutationId',
  }

  // Restore the probed field to its computed value.
  await provider.setField({
    fieldRef: { semantic: 'p50', surface: 'project-item', projectId: project.value.id, projectItemId: sample.itemId, providerFieldId: probeField.id, dataType: 'NUMBER' },
    value: sample.forecast?.p50Hours ?? null,
    clientOperationId: 't135-dedup-restore',
  })

  // ---- Batch: six field writes for one item in a single GraphQL document.
  const batchRow = plan[1] ?? plan[0]
  const batchWrites = batchRow.writes
    .map((w) => ({
      projectId: project.value.id,
      itemId: batchRow.itemId,
      fieldId: fieldByKey[w.key].id,
      value: graphqlValueFor(w.dataType, w.value, w.optionId),
    }))
    .filter((w) => w.value !== null)
  const batch = await batchSetFields(client, batchWrites)
  out.batchWrite = {
    taskId: batchRow.taskId,
    aliases: batchWrites.length,
    ok: batch.ok,
    error: batch.ok ? undefined : batch.error,
    metric: batch.metric,
  }

  out.capabilitiesObserved = provider.capabilities
  out.endedAt = new Date().toISOString()
  out.metrics = client.metrics
  out.metricsSummary = client.summary()

  const outPath = path.resolve(SPIKE_DIR, args.out ?? 'measurements/03-write.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`)
  process.stdout.write(
    `${JSON.stringify(
      {
        edgeSource: out.derivation.edgeSource,
        waves: out.derivation.plannerWaves,
        writes: out.pass1.writes,
        failures: out.pass1.failures.length,
        verificationFailures: out.verification.filter((v) => !v.ok),
        idempotence: out.idempotence.sameValueRepeatChangedRevision,
        clientMutationIdDeduplicated: out.clientMutationIdProbe.deduplicated,
        batchOk: out.batchWrite.ok,
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
