#!/usr/bin/env node
// T-135 step 5: can the Roadmap view that would carry `Forecast end P90` be
// built through the API at all?
//
//   node scripts/spikes/github-projects/bin/make-roadmap-view.mjs \
//     --project-number 3 --out measurements/05-view.json

import fs from 'node:fs'
import path from 'node:path'
import { createClient, RATE_LIMIT_SELECTION } from '../lib/gh.mjs'
import { createGithubProvider } from '../lib/provider.mjs'
import { DERIVED_FIELDS, SPIKE_DIR, parseArgs } from '../lib/config.mjs'

const VIEW_NAME = 'Forecast roadmap (T-135)'

async function main() {
  const args = parseArgs()
  const client = createClient({ account: args.account })
  const provider = createGithubProvider(client)
  const out = { startedAt: new Date().toISOString(), args: { ...args, _: undefined } }

  const project = await provider.getProject({ owner: args.owner, number: args.projectNumber })
  if (!project.ok) throw new Error(`getProject failed: ${JSON.stringify(project.error)}`)
  const byName = new Map(project.value.fields.map((f) => [f.name, f]))
  const visibleFieldIds = ['Title', ...DERIVED_FIELDS.map((s) => s.name)]
    .map((n) => byName.get(n)?.id)
    .filter(Boolean)

  const existing = await client.graphql(
    `query($owner: String!, $number: Int!) {
       user(login: $owner) { projectV2(number: $number) { views(first: 20) { totalCount nodes {
         id name number layout filter
         configuration { visibleFields(first: 30) { nodes { ... on ProjectV2FieldCommon { id name dataType } } } }
       } } } }
       ${RATE_LIMIT_SELECTION}
     }`,
    { owner: args.owner, number: args.projectNumber },
    { label: 'list views' },
  )
  if (!existing.ok) throw new Error(`list views failed: ${JSON.stringify(existing.error)}`)
  const views = existing.value.user.projectV2.views.nodes
  out.viewsBefore = views.map((v) => ({ id: v.id, name: v.name, number: v.number, layout: v.layout }))

  const CREATE_VIEW = `mutation($projectId: ID!, $name: String!, $layout: ProjectV2ViewLayout!, $config: ProjectV2ViewConfigurationInput) {
    createProjectV2View(input: { projectId: $projectId, name: $name, layout: $layout, configuration: $config }) {
      clientMutationId
      projectV2View { id name number layout }
    }
  }`

  // Capability discovered at write time, which is exactly the case the study's
  // `discoveredAtWrite` flag exists for: a roadmap view refuses
  // visibleFieldIds, and nothing in the schema says so up front.
  let view = views.find((v) => v.name === VIEW_NAME)
  if (!view) {
    const withFields = await client.graphql(
      CREATE_VIEW,
      { projectId: project.value.id, name: VIEW_NAME, layout: 'ROADMAP_LAYOUT', config: { visibleFieldIds } },
      { label: 'createProjectV2View(ROADMAP+visibleFields)', mutation: true },
    )
    out.roadmapWithVisibleFields = withFields.ok
      ? { ok: true, view: withFields.value.createProjectV2View.projectV2View }
      : { ok: false, error: withFields.error, discoveredAtWrite: true }
    if (withFields.ok) {
      view = withFields.value.createProjectV2View.projectV2View
    } else {
      const plain = await client.graphql(
        CREATE_VIEW,
        { projectId: project.value.id, name: VIEW_NAME, layout: 'ROADMAP_LAYOUT', config: null },
        { label: 'createProjectV2View(ROADMAP_LAYOUT)', mutation: true },
      )
      if (!plain.ok) out.createViewError = plain.error
      else {
        view = plain.value.createProjectV2View.projectV2View
        out.createdView = view
      }
    }
  } else {
    out.reusedView = { id: view.id, number: view.number }
  }

  // A table view does accept visibleFieldIds, so the six derived fields can at
  // least be made visible somewhere through the API.
  const TABLE_VIEW_NAME = 'Derived fields (T-135)'
  let tableView = views.find((v) => v.name === TABLE_VIEW_NAME)
  if (!tableView) {
    const created = await client.graphql(
      CREATE_VIEW,
      { projectId: project.value.id, name: TABLE_VIEW_NAME, layout: 'TABLE_LAYOUT', config: { visibleFieldIds } },
      { label: 'createProjectV2View(TABLE+visibleFields)', mutation: true },
    )
    out.tableView = created.ok
      ? { ok: true, view: created.value.createProjectV2View.projectV2View, visibleFieldCount: visibleFieldIds.length }
      : { ok: false, error: created.error }
    if (created.ok) tableView = created.value.createProjectV2View.projectV2View
  } else {
    out.tableView = { ok: true, reused: true, view: { id: tableView.id, number: tableView.number } }
  }
  if (tableView) out.tableViewUrl = `https://github.com/users/${args.owner}/projects/${args.projectNumber}/views/${tableView.number}`

  // What the API lets us read back about the roadmap's own configuration. The
  // date-field pair a roadmap draws from is NOT in ProjectV2ViewConfiguration,
  // so this read is the evidence for that gap.
  if (view) {
    const after = await client.graphql(
      `query($viewId: ID!) {
         node(id: $viewId) { ... on ProjectV2View {
           id name number layout filter createdAt updatedAt
           configuration { visibleFields(first: 30) { nodes { ... on ProjectV2FieldCommon { id name dataType } } } }
           sortByFields(first: 10) { nodes { direction field { ... on ProjectV2FieldCommon { name } } } }
           groupByFields(first: 10) { nodes { ... on ProjectV2FieldCommon { name } } }
         } }
         ${RATE_LIMIT_SELECTION}
       }`,
      { viewId: view.id },
      { label: 'read view configuration' },
    )
    out.viewAfter = after.ok ? after.value.node : { error: after.error }
    out.roadmapDateFieldConfigurable = false
    out.roadmapDateFieldNote =
      'ProjectV2ViewConfigurationInput exposes visibleFieldIds only. A roadmap view\'s start/target date fields are not in the public schema, so the Forecast end P90 axis has to be picked in the web UI.'
    out.url = `https://github.com/users/${args.owner}/projects/${args.projectNumber}/views/${view.number}`
  }

  out.endedAt = new Date().toISOString()
  out.metrics = client.metrics
  out.metricsSummary = client.summary()

  const outPath = path.resolve(SPIKE_DIR, args.out ?? 'measurements/05-view.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ view: out.createdView ?? out.reusedView, url: out.url, createViewError: out.createViewError, wrote: outPath }, null, 2)}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`)
  process.exitCode = 1
})
