#!/usr/bin/env node
/**
 * Record the GraphQL fixtures the GitHub adapter's tests replay (T-150).
 *
 *   node packages/provider/scripts/record-github-fixtures.mjs \
 *     --account alotth --project project:alotth/2 --draft-project project:alotth/3 \
 *     --repo repo:alotth/kanban-sync-engine
 *
 * Read-only. It drives the real adapter and the real contract suite against the
 * live API through a transport that logs every request/response pair, so the
 * recorded keys are exactly the keys the tests will ask for -- a hand-written
 * fixture set drifts from the queries the moment either changes.
 *
 * Nothing is written to GitHub: every write on the adapter refuses locally,
 * before the transport is reached. That is asserted here rather than assumed,
 * and the run aborts if a mutation document ever shows up.
 *
 * Sanitisation, because these fixtures are committed to a public repository:
 *   - the token never enters a fixture (it lives only in the request header,
 *     which is not recorded);
 *   - bodies are truncated, since the mapping only needs their shape;
 *   - any absolute filesystem path is replaced, the same rule the T-135 spike's
 *     `redactArgs` applies to its measurement captures;
 *   - the recorded argv is redacted the same way.
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(HERE, "..", "dist")

const { GitHubProvider } = require(path.join(DIST, "github/github-provider.js"))
const { liveTransport, fixtureKey } = require(path.join(DIST, "github/transport.js"))
const { checkProviderContract } = require(path.join(DIST, "contract-suite.js"))

const BODY_LIMIT = 120

function parseArgs(argv) {
  const out = { account: "alotth" }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith("--")) continue
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    out[key] = argv[i + 1]
    i += 1
  }
  return out
}

/** Same rule as the T-135 spike: no resolved local path reaches a committed file. */
function redactArgs(args) {
  const out = {}
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === "string" && value.startsWith("/") ? `<ABS_PATH:${path.basename(value)}>` : value
  }
  return out
}

/** Recursively truncate `body` strings and scrub absolute paths. */
function sanitise(value) {
  if (typeof value === "string") {
    return value.replace(/\/(Users|home)\/[^\s"']+/g, "<PATH>")
  }
  if (Array.isArray(value)) return value.map(sanitise)
  if (value !== null && typeof value === "object") {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (key === "body" && typeof entry === "string") {
        out[key] = entry.length > BODY_LIMIT ? `${sanitise(entry.slice(0, BODY_LIMIT))} […truncated for the fixture]` : sanitise(entry)
        continue
      }
      out[key] = sanitise(entry)
    }
    return out
  }
  return value
}

function recordingTransport(inner, entries) {
  return {
    mode: "live",
    lastRateLimit: () => inner.lastRateLimit(),
    async execute(request) {
      if (/\bmutation\b/.test(request.document)) {
        throw new Error(`refusing to record a mutation: ${request.label}. This task is read-only.`)
      }
      const result = await inner.execute(request)
      const key = fixtureKey(request)
      const base = { key, label: request.label, variables: request.variables }
      if (result.ok) {
        entries.set(key, { ...base, data: sanitise(result.value.data) })
      } else {
        // A recorded failure replays through the same classification as a live
        // one, so the error-shape checks exercise real provider messages.
        entries.set(key, { ...base, errors: [{ type: errorTypeFor(result.error), message: sanitise(result.error.message) }] })
      }
      return result
    }
  }
}

/** Map a classified error back to the GraphQL `type` that produced it. */
function errorTypeFor(error) {
  if (error.kind === "not-found") return "NOT_FOUND"
  if (error.kind === "rate-limited") return "RATE_LIMITED"
  if (error.kind === "auth") return "FORBIDDEN"
  if (error.kind === "invalid") return "EXCESSIVE_PAGINATION"
  return "VALIDATION"
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const projectCollection = args.project ?? "project:alotth/2"
  const draftCollection = args.draftProject ?? "project:alotth/3"
  const repoCollection = args.repo ?? "repo:alotth/kanban-sync-engine"

  const token = execFileSync("gh", ["auth", "token", "-u", args.account], { encoding: "utf8" }).trim()
  if (token.length === 0) throw new Error(`gh auth token -u ${args.account} returned nothing`)

  const entries = new Map()
  const live = liveTransport({ token, userAgent: "mapctx-provider-fixture-recorder" })
  const transport = recordingTransport(live, entries)

  // ---- the board the contract suite binds to -------------------------------
  const provider = new GitHubProvider({ transport, collection: projectCollection })
  const page = await provider.listItems({ project: projectCollection, first: 50 })
  if (!page.ok) throw new Error(`listItems failed: ${JSON.stringify(page.error)}`)
  const issues = page.value.items.filter((item) => item.species === "issue")
  if (issues.length < 2) {
    throw new Error(`need at least two issue-backed items on ${projectCollection}, found ${issues.length}`)
  }

  // ---- an item of the narrower species, from the drafts board --------------
  const draftProvider = new GitHubProvider({ transport, collection: draftCollection })
  const draftPage = await draftProvider.listItems({ project: draftCollection, first: 50 })
  if (!draftPage.ok) throw new Error(`draft listItems failed: ${JSON.stringify(draftPage.error)}`)
  const draft = draftPage.value.items.find((item) => item.species === "draft-issue")
  if (draft === undefined) throw new Error(`no draft issue on ${draftCollection}`)

  const ctx = {
    provider,
    project: projectCollection,
    writableItem: issues[0].ref,
    secondWritableItem: issues[1].ref,
    // A node id that is well formed for GitHub and resolves to nothing.
    missingItem: { provider: "github", workItem: { id: "I_kwDOAAAAAAAAAAA", key: "missing#0" }, species: "issue" },
    narrowedSpeciesItem: draft.ref,
    sampleValues: {},
    expectedItemCount: page.value.items.length
  }

  const report = await checkProviderContract(ctx)
  process.stdout.write(
    `contract suite against ${projectCollection}: passed=${report.passed} failed=${report.failed} skipped=${report.skipped}\n`
  )
  for (const failure of report.failures) process.stdout.write(`  FAIL [${failure.group}] ${failure.id}: ${failure.detail}\n`)
  for (const entry of report.checks.filter((check) => check.skipped)) {
    process.stdout.write(`  skip [${entry.group}] ${entry.id}: ${entry.detail}\n`)
  }

  // ---- the repository collection: where dependency edges actually live -----
  const repoProvider = new GitHubProvider({ transport, collection: repoCollection })
  const repoPage = await repoProvider.listItems({ project: repoCollection, first: 50 })
  if (!repoPage.ok) throw new Error(`repo listItems failed: ${JSON.stringify(repoPage.error)}`)
  await repoProvider.getProject({ project: repoCollection })
  await repoProvider.listItems({ project: repoCollection, first: 1 })
  if (repoPage.value.items.length > 0) {
    await repoProvider.getDependencies({ items: repoPage.value.items.slice(0, 2).map((item) => item.ref) })
    await repoProvider.findByKey({ project: repoCollection, keys: ["T-001", "contract-suite-absent-key"] })
  }
  await repoProvider.describeFields({ project: repoCollection })

  // ---- the ceiling the spike measured, re-checked against this board -------
  await provider.listItems({ project: projectCollection, first: 101 })

  const outDir = path.resolve(HERE, "..", "src", "github", "fixtures")
  fs.mkdirSync(outDir, { recursive: true })
  const file = {
    provenance: "recorded",
    note:
      "Recorded read-only from the live GitHub GraphQL API by packages/provider/scripts/record-github-fixtures.mjs. " +
      `Issue and draft bodies are truncated to ${BODY_LIMIT} characters and absolute paths replaced, because these bytes are committed to a public repository. ` +
      "No mutation was recorded: the recorder aborts on one, and every write on the adapter refuses before the transport.",
    recordedAt: new Date().toISOString(),
    recordedWith: redactArgs({ ...args, project: projectCollection, draftProject: draftCollection, repo: repoCollection }),
    contractReport: { passed: report.passed, failed: report.failed, skipped: report.skipped },
    context: {
      project: projectCollection,
      writableItem: ctx.writableItem,
      secondWritableItem: ctx.secondWritableItem,
      missingItem: ctx.missingItem,
      narrowedSpeciesItem: ctx.narrowedSpeciesItem,
      expectedItemCount: ctx.expectedItemCount,
      repoCollection,
      repoItemRefs: repoPage.value.items.slice(0, 2).map((item) => item.ref)
    },
    entries: [...entries.values()].sort((a, b) => a.key.localeCompare(b.key))
  }
  const outPath = path.join(outDir, "github-recorded.json")
  fs.writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`)
  process.stdout.write(`wrote ${file.entries.length} entries to ${path.relative(process.cwd(), outPath)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
