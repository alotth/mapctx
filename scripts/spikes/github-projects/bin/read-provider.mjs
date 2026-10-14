#!/usr/bin/env node
// T-135 step 2: the provider READ path -- project fields, project items with
// their field values, and repository issues with their real dependency and
// sub-issue edges.
//
// The dependency read is parameterised. Pointing it at seeded issues in another
// repository is a flag change:
//
//   node scripts/spikes/github-projects/bin/read-provider.mjs \
//     --owner alotth --repo mapctx --dep-repos mapctx,kanban-sync-engine,markdown-kanban-roadmap \
//     --project-number 3 --first 2 --out measurements/02-read.json

import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '../lib/gh.mjs'
import { createGithubProvider } from '../lib/provider.mjs'
import { SPIKE_DIR, parseArgs, redactArgs } from '../lib/config.mjs'

async function main() {
  const args = parseArgs()
  const client = createClient({ account: args.account })
  const provider = createGithubProvider(client)
  const out = { startedAt: new Date().toISOString(), args: redactArgs(args) }

  const project = await provider.getProject({ owner: args.owner, number: args.projectNumber })
  if (!project.ok) throw new Error(`getProject failed: ${JSON.stringify(project.error)}`)
  out.project = {
    id: project.value.id,
    number: project.value.number,
    title: project.value.title,
    public: project.value.public,
    itemCountReported: project.value.itemCount,
    fieldCount: project.value.fieldCount,
    fieldsHasNextPage: project.value.fieldsHasNextPage,
    fields: project.value.fields.map((f) => ({ id: f.id, name: f.name, dataType: f.dataType, optionCount: f.options?.length })),
  }

  // Pagination, measured rather than assumed: walk the item connection with a
  // deliberately small page size and record cost per page.
  const pageSize = args.first ?? 2
  const pages = []
  let cursor = null
  let itemsSeen = []
  do {
    const page = await provider.listItems({ projectId: project.value.id, first: pageSize, cursor })
    if (!page.ok) throw new Error(`listItems failed: ${JSON.stringify(page.error)}`)
    pages.push({
      pageSize,
      returned: page.value.items.length,
      totalCount: page.value.totalCount,
      hasNext: Boolean(page.value.nextCursor),
      freshness: page.value.freshness,
    })
    itemsSeen = itemsSeen.concat(page.value.items)
    cursor = page.value.nextCursor ?? null
  } while (cursor)
  out.itemPagination = { pageSize, pageCount: pages.length, itemsWalked: itemsSeen.length, pages }
  out.items = itemsSeen.map((i) => ({
    itemId: i.ref.projectItem?.itemId,
    workItemId: i.ref.workItem.id,
    key: i.ref.workItem.key,
    contentKind: i.contentKind,
    title: i.fields.title,
    revision: i.revision,
    fieldValues: i.projectFieldValues,
  }))

  // Dependency + sub-issue reads against real issues. Every repository named
  // here is read-only for this spike.
  const depRepos = (args.depRepos ?? args.repo).split(',').map((s) => s.trim()).filter(Boolean)
  out.dependencyReads = []
  for (const repo of depRepos) {
    const res = await provider.listRepoItemsWithDependencies({ owner: args.owner, repo, first: 50 })
    if (!res.ok) {
      out.dependencyReads.push({ repo, ok: false, error: res.error })
      continue
    }
    const v = res.value
    out.dependencyReads.push({
      repo,
      ok: true,
      repository: v.repository,
      issueCount: v.totalCount,
      dependencyEdges: v.dependencies.length,
      subIssueEdges: v.subIssueEdges.length,
      freshness: v.freshness,
      // Keep the real shape so the doc can show what a non-empty read returns.
      dependencies: v.dependencies.map((d) => ({ from: d.from.workItem.key, to: d.to.workItem.key, kind: d.kind })),
      subIssues: v.subIssueEdges,
      perIssue: v.items.map((i) => ({
        key: i.ref.workItem.key,
        state: i.fields.planningState,
        summary: i.dependencySummary,
        subIssues: i.subIssuesSummary,
        parent: i.fields.parent,
        issueType: i.fields.type,
      })),
    })
  }

  // The REST half, for cost and shape comparison on one issue per repo.
  out.restDependencyProbe = []
  for (const read of out.dependencyReads) {
    if (!read.ok || read.perIssue.length === 0) continue
    const number = Number(read.perIssue[0].key.split('#')[1])
    const res = await provider.getDependenciesRest({ owner: args.owner, repo: read.repo, number })
    out.restDependencyProbe.push(res.ok ? { repo: read.repo, number, ...res.value } : { repo: read.repo, number, ok: false, error: res.error })
  }

  out.capabilitiesObserved = provider.capabilities
  out.endedAt = new Date().toISOString()
  out.metrics = client.metrics
  out.metricsSummary = client.summary()

  const outPath = path.resolve(SPIKE_DIR, args.out ?? 'measurements/02-read.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`)
  process.stdout.write(
    `${JSON.stringify(
      {
        project: { number: out.project.number, itemCountReported: out.project.itemCountReported, fieldCount: out.project.fieldCount },
        itemsWalked: out.itemPagination.itemsWalked,
        pageCount: out.itemPagination.pageCount,
        dependencyReads: out.dependencyReads.map((d) => ({ repo: d.repo, issues: d.issueCount, deps: d.dependencyEdges, subIssues: d.subIssueEdges })),
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
