#!/usr/bin/env node
// T-135 step 1: make the private test Project exist, with the six derived
// fields and one draft item per corpus task. Idempotent -- re-running finds
// what is already there and reports it instead of creating duplicates.
//
//   node scripts/spikes/github-projects/bin/setup-project.mjs \
//     --owner alotth --repo mapctx --out measurements/01-setup.json

import fs from 'node:fs'
import path from 'node:path'
import { createClient, RATE_LIMIT_SELECTION } from '../lib/gh.mjs'
import { createGithubProvider } from '../lib/provider.mjs'
import { readCorpus } from '../lib/store-input.mjs'
import { DEFAULTS, DERIVED_FIELDS, REPO_ROOT, SPIKE_DIR, parseArgs, redactArgs } from '../lib/config.mjs'
import { taskIdFromTitle } from '../lib/derive.mjs'

const SHORT_DESCRIPTION =
  'T-135 spike (E-018). Derived fields are written by MapCtx; cost fields are 0 because the store has no cost basis yet. Not a planning board.'

async function main() {
  const args = parseArgs()
  const client = createClient({ account: args.account, dryRun: Boolean(args.dryRun) })
  const provider = createGithubProvider(client)
  const log = { startedAt: new Date().toISOString(), args: redactArgs(args), steps: [] }

  // Owner + repository node ids, and the project if a previous run made it.
  const ids = await client.graphql(
    `query($owner: String!, $repo: String!) {
       user(login: $owner) { id login }
       repository(owner: $owner, name: $repo) { id nameWithOwner isPrivate }
       ${RATE_LIMIT_SELECTION}
     }`,
    { owner: args.owner, repo: args.repo },
    { label: 'resolve owner+repo ids' },
  )
  if (!ids.ok) throw new Error(`owner/repo lookup failed: ${JSON.stringify(ids.error)}`)
  const ownerId = ids.value.user.id
  const repositoryId = ids.value.repository.id
  log.steps.push({ step: 'resolve-ids', ownerId, repositoryId, repo: ids.value.repository.nameWithOwner, repoIsPrivate: ids.value.repository.isPrivate })

  const found = await provider.findProjectByTitle({ owner: args.owner, title: args.projectTitle })
  if (!found.ok) throw new Error(`project lookup failed: ${JSON.stringify(found.error)}`)

  let projectNumber
  if (found.value) {
    projectNumber = found.value.number
    log.steps.push({ step: 'project', action: 'reused', number: projectNumber, id: found.value.id })
  } else {
    const created = await provider.createProject({ ownerId, title: args.projectTitle, repositoryId })
    if (!created.ok) throw new Error(`createProjectV2 failed: ${JSON.stringify(created.error)}`)
    projectNumber = created.value.number
    log.steps.push({
      step: 'project',
      action: 'created',
      number: projectNumber,
      id: created.value.id,
      url: created.value.url,
      publicAtCreation: created.value.public,
      echoedClientMutationId: created.echoedClientMutationId,
    })
  }

  let project = await provider.getProject({ owner: args.owner, number: projectNumber })
  if (!project.ok) throw new Error(`getProject failed: ${JSON.stringify(project.error)}`)

  // Private and labelled. `public: false` is asserted even on reuse: a test
  // project holding MapCtx numbers must not become visible by accident.
  const meta = await provider.setProjectMeta({
    projectId: project.value.id,
    patch: { public: false, shortDescription: SHORT_DESCRIPTION },
    clientOperationId: 't135-project-meta',
  })
  if (!meta.ok) throw new Error(`updateProjectV2 failed: ${JSON.stringify(meta.error)}`)
  log.steps.push({ step: 'project-meta', public: meta.value.public, shortDescription: meta.value.shortDescription })

  // Six derived fields.
  const fieldByKey = {}
  for (const spec of DERIVED_FIELDS) {
    const existing = project.value.fields.find((f) => f.name === spec.name)
    if (existing) {
      fieldByKey[spec.key] = { ...spec, id: existing.id, options: existing.options ?? null, action: 'reused' }
      continue
    }
    const created = await provider.createField({
      projectId: project.value.id,
      name: spec.name,
      dataType: spec.dataType,
      singleSelectOptions: spec.options ?? undefined,
      clientOperationId: `t135-field-${spec.key}`,
    })
    if (!created.ok) throw new Error(`createProjectV2Field ${spec.name} failed: ${JSON.stringify(created.error)}`)
    fieldByKey[spec.key] = { ...spec, id: created.value.id, options: created.value.options ?? null, action: 'created' }
  }
  log.steps.push({
    step: 'fields',
    fields: Object.values(fieldByKey).map((f) => ({ name: f.name, dataType: f.dataType, id: f.id, action: f.action, optionCount: f.options?.length ?? 0 })),
  })

  // One draft item per corpus task, titled with the MapCtx id so the binding
  // survives a round trip. A draft issue is the only item kind this spike may
  // create: the bound repository is public and seeding real issues there was
  // not authorised.
  const corpus = readCorpus({ cli: args.cli, cwd: REPO_ROOT, taskIds: args.tasks })
  const items = await provider.listItems({ projectId: project.value.id, first: 100 })
  if (!items.ok) throw new Error(`listItems failed: ${JSON.stringify(items.error)}`)
  const existingByTaskId = new Map()
  for (const it of items.value.items) {
    const id = taskIdFromTitle(it.fields.title)
    if (id) existingByTaskId.set(id, it)
  }

  const itemLog = []
  for (const taskId of args.tasks) {
    const task = corpus.tasks.get(taskId)
    if (!task) throw new Error(`task ${taskId} not in store`)
    if (existingByTaskId.has(taskId)) {
      itemLog.push({ taskId, action: 'reused', itemId: existingByTaskId.get(taskId).ref.projectItem.itemId })
      continue
    }
    const body = [
      `MapCtx task: ${taskId}`,
      `status: ${task.status} / execution: ${task.executionState}`,
      `workload: ${task.workload ?? 'n/a'} - estimatedEffort: ${task.estimatedEffort ?? 'n/a'}`,
      '',
      'Spike item for T-135. Planning authority stays in the MapCtx store.',
    ].join('\n')
    const created = await provider.createDraftItem({
      projectId: project.value.id,
      title: task.title,
      body,
      clientOperationId: `t135-draft-${taskId}`,
    })
    if (!created.ok) throw new Error(`addProjectV2DraftIssue ${taskId} failed: ${JSON.stringify(created.error)}`)
    itemLog.push({ taskId, action: 'created', itemId: created.value.ref.projectItem.itemId, echoedClientMutationId: created.echoedClientMutationId })
  }
  log.steps.push({ step: 'items', items: itemLog })

  project = await provider.getProject({ owner: args.owner, number: projectNumber })
  if (!project.ok) throw new Error(`getProject (final) failed: ${JSON.stringify(project.error)}`)

  log.project = {
    id: project.value.id,
    number: project.value.number,
    title: project.value.title,
    url: project.value.url,
    public: project.value.public,
    itemCount: project.value.itemCount,
    fieldCount: project.value.fieldCount,
    fields: project.value.fields.map((f) => ({ id: f.id, name: f.name, dataType: f.dataType, options: f.options ?? undefined })),
  }
  log.endedAt = new Date().toISOString()
  log.metrics = client.metrics
  log.metricsSummary = client.summary()

  const outPath = path.resolve(SPIKE_DIR, args.out ?? 'measurements/01-setup.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify(log, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ project: log.project, wrote: outPath }, null, 2)}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`)
  process.exitCode = 1
})

export { DEFAULTS }
