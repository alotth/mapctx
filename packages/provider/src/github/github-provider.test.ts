/**
 * The GitHub adapter against recorded fixtures (T-150).
 *
 * No network: `npm test` must pass offline, so everything here replays bytes
 * captured read-only from the live API by
 * `packages/provider/scripts/record-github-fixtures.mjs`. The recorder drives
 * this same adapter and this same suite, so a drift between the queries and the
 * fixtures shows up as a missing-fixture error rather than as a silent pass.
 */

import assert from "node:assert/strict"
import test from "node:test"

import { checkProviderContract, formatContractFailures, type ContractContext } from "../contract-suite"
import { capabilitiesForSpecies, resolveOptionId, widenedSpeciesClaims } from "../capabilities"
import { loadRecordedFixture, loadSyntheticFixture } from "./fixtures"
import { GitHubProvider, GITHUB_ISSUE_CAPABILITIES, GITHUB_MAX_PAGE_SIZE, parseCollection } from "./github-provider"
import {
  dependenciesFromIssue,
  GITHUB_SPECIES_DRAFT,
  GITHUB_SPECIES_ISSUE,
  GITHUB_SPECIES_UNKNOWN,
  GITHUB_STATUS_TO_PLANNING,
  itemFromIssue,
  keyFromTitle,
  planningStateFromStatus,
  PLANNING_TO_GITHUB_STATUS,
  speciesFromRef
} from "./mapping"
import { fixtureTransport } from "./transport"
import type { ProviderItemRef } from "../types"

function buildProvider() {
  const recorded = loadRecordedFixture()
  const transport = fixtureTransport([recorded, loadSyntheticFixture()])
  const provider = new GitHubProvider({ transport, collection: recorded.context.project })
  return { provider, recorded, transport }
}

function buildContext(): ContractContext {
  const { provider, recorded } = buildProvider()
  const ctx = recorded.context
  return {
    provider,
    project: ctx.project,
    writableItem: ctx.writableItem as ProviderItemRef,
    secondWritableItem: ctx.secondWritableItem as ProviderItemRef,
    missingItem: ctx.missingItem as ProviderItemRef,
    narrowedSpeciesItem: ctx.narrowedSpeciesItem as ProviderItemRef,
    // Nothing on this adapter is writable, so there is no sample to supply. The
    // suite reads that as "check every refusal", which is the whole point.
    sampleValues: {},
    expectedItemCount: ctx.expectedItemCount
  }
}

/**
 * The skips a read-only provider cannot avoid.
 *
 * Enumerated rather than tolerated in bulk: each one is a group the suite can
 * only exercise against a writable field, and a new skip appearing outside this
 * list means something stopped being checked.
 */
const EXPECTED_SKIPS: readonly string[] = [
  // Needs a writable field whose sample a distinct batch value can be derived from.
  "batch.all-applied",
  // Needs one writable and one unwritable field to mix in a batch.
  "batch.partial-flag",
  // Needs planningState to be writable to attempt a legal transition.
  "planningState.write"
]

test("GitHubProvider passes the contract suite against recorded fixtures", async () => {
  const report = await checkProviderContract(buildContext())
  assert.equal(report.failed, 0, formatContractFailures(report))
  assert.deepEqual(
    report.checks
      .filter((check) => check.skipped)
      .map((check) => check.id)
      .sort(),
    [...EXPECTED_SKIPS].sort(),
    "the set of skipped checks changed; a read-only provider skips exactly the write-sampled groups"
  )
  assert.ok(report.passed > 100, `expected more than 100 passed checks, got ${report.passed}`)
})

test("the recorded fixture is what the suite actually ran against", async () => {
  const { recorded } = buildProvider()
  // Provenance is load-bearing: a reader must be able to tell a measurement
  // from a construction, and the synthetic file exists precisely because the
  // recorded one cannot prove the dependency mapping.
  assert.equal(recorded.provenance, "recorded")
  assert.equal(loadSyntheticFixture().provenance, "synthetic")
  assert.ok(recorded.entries.length > 0, "the recorded fixture must hold entries")
  // No absolute path and no token can reach a public repository through these.
  const bytes = JSON.stringify(recorded)
  assert.ok(!/\/Users\/|\/home\//.test(bytes), "recorded fixtures must carry no absolute filesystem path")
  assert.ok(!/gh[pousr]_[A-Za-z0-9]{20,}/.test(bytes), "recorded fixtures must carry no token")
})

test("an unrecorded request fails loudly instead of looking empty", async () => {
  const { provider } = buildProvider()
  const result = await provider.getItem({
    ref: { provider: "github", workItem: { id: "I_kwDOnotRecorded", key: "nope" }, species: GITHUB_SPECIES_ISSUE }
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.kind, "not-found")
  assert.match(result.error.message, /no fixture recorded/)
})

test("page size above GitHub's ceiling is refused before a request is made", async () => {
  const { provider, recorded } = buildProvider()
  const result = await provider.listItems({ project: recorded.context.project, first: GITHUB_MAX_PAGE_SIZE + 1 })
  assert.equal(result.ok, false)
  if (result.ok) return
  // `invalid`, not `unsupported`: the provider can page, the caller asked for
  // too much. Reporting it as a missing capability would be unrecoverable.
  assert.equal(result.error.kind, "invalid")
  assert.equal(result.error.retryable, false)
})

test("collection parsing refuses anything it does not fully recognise", () => {
  assert.deepEqual(parseCollection("project:alotth/3"), { kind: "project", owner: "alotth", number: 3 })
  assert.deepEqual(parseCollection("repo:alotth/mapctx"), { kind: "repo", owner: "alotth", repo: "mapctx" })
  // A forgiving parser here would mirror 136 tasks into the wrong board.
  assert.equal(parseCollection("alotth/3"), undefined)
  assert.equal(parseCollection("project:alotth"), undefined)
  assert.equal(parseCollection("project:alotth/notanumber"), undefined)
  assert.equal(parseCollection(""), undefined)
})

test("species is inferred from the node id prefix, and an unknown id claims nothing", () => {
  const issue = { workItem: { id: "I_kwDOabc", key: "x" } }
  const draft = { workItem: { id: "DI_lAHOabc", key: "y" } }
  const mystery = { workItem: { id: "XYZ_abc", key: "z" } }
  assert.equal(speciesFromRef(issue), GITHUB_SPECIES_ISSUE)
  assert.equal(speciesFromRef(draft), GITHUB_SPECIES_DRAFT)
  // Never optimistically an issue: assuming the richer species is what produces
  // an `unsupported` the caller had no way to anticipate.
  assert.equal(speciesFromRef(mystery), GITHUB_SPECIES_UNKNOWN)
  // A caller that knows is not second-guessed.
  assert.equal(speciesFromRef({ ...mystery, species: GITHUB_SPECIES_ISSUE }), GITHUB_SPECIES_ISSUE)
})

test("the draft species narrows the issue record and never widens it", () => {
  assert.deepEqual(widenedSpeciesClaims(GITHUB_ISSUE_CAPABILITIES), [])
  const draft = capabilitiesForSpecies(GITHUB_ISSUE_CAPABILITIES, GITHUB_SPECIES_DRAFT)
  assert.equal(draft.relations["blocked-by"], undefined, "a draft has no Issue object, so no relation is readable")
  assert.equal(draft.comments.read, false)
  assert.equal(draft.timeline.read, false)
  // Title and body survive: a draft really does have those.
  assert.equal(draft.fields.title?.read, true)
  assert.equal(draft.fields.body?.read, true)
})

test("a draft issue refuses relations, comments and timeline, naming its species", async () => {
  const { provider, recorded } = buildProvider()
  const draft = recorded.context.narrowedSpeciesItem as ProviderItemRef
  assert.equal(speciesFromRef(draft), GITHUB_SPECIES_DRAFT)

  for (const [label, call] of [
    ["relations", () => provider.getDependencies({ items: [draft] })],
    ["comments", () => provider.listComments({ item: draft })],
    ["timeline", () => provider.timeline({ item: draft })]
  ] as const) {
    const result = await call()
    assert.equal(result.ok, false, `${label} must refuse for a draft`)
    if (result.ok) continue
    assert.equal(result.error.kind, "unsupported")
    assert.equal(result.error.retryable, false)
    assert.match(String(result.error.capability), new RegExp(GITHUB_SPECIES_DRAFT))
    assert.match(result.error.message, /draft-issue/)
  }
})

test("writes refuse with the reason, and a precondition refuses before the field does", async () => {
  const { provider, recorded } = buildProvider()
  const item = recorded.context.writableItem as ProviderItemRef

  const write = await provider.setField({
    item,
    field: { semantic: "title", surface: "work-item" },
    value: "nope",
    clientOperationId: "test-write"
  })
  assert.equal(write.ok, false)
  if (!write.ok) {
    assert.equal(write.error.kind, "unsupported")
    assert.equal(write.error.capability, "github.fields.title.write")
  }

  // The precondition is refused for being a precondition, not for the field:
  // a caller must learn that compare-and-swap does not exist here, which is a
  // different fact from "this field is read-only".
  const guarded = await provider.setField({
    item,
    field: { semantic: "title", surface: "work-item" },
    value: "nope",
    clientOperationId: "test-precondition",
    precondition: { expectedRevision: "stale" }
  })
  assert.equal(guarded.ok, false)
  if (!guarded.ok) assert.equal(guarded.error.capability, "github.preconditions.revision")

  // Dependency writes have no GraphQL mutation at all, so they are refused on a
  // stronger ground than "not yet implemented".
  const dep = await provider.addDependency({
    from: item,
    to: recorded.context.secondWritableItem as ProviderItemRef,
    kind: "blocked-by",
    clientOperationId: "test-dep"
  })
  assert.equal(dep.ok, false)
  if (!dep.ok) {
    assert.equal(dep.error.capability, "github.relations.write")
    assert.match(dep.error.message, /no GraphQL mutation/)
  }

  // An empty batch is a caller mistake, checked before the read-only refusal so
  // the message is about the batch rather than about the fields.
  const empty = await provider.applyFieldWrites({ writes: [], clientOperationId: "test-empty" })
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.equal(empty.error.kind, "invalid")
})

test("Status maps to planning states in both directions, including cancelled", () => {
  // The operator's 2026-10-14 decision publishes every task, terminal ones
  // included, and the old mapctx.toml statusMap covered neither `cancelled` nor
  // `blocked`. A mirror that cannot express them has to drop or mislabel those
  // tasks, so both directions are pinned here.
  assert.equal(planningStateFromStatus("Cancelled"), "cancelled")
  assert.equal(planningStateFromStatus("canceled"), "cancelled")
  assert.equal(planningStateFromStatus("Blocked"), "blocked")
  assert.equal(planningStateFromStatus("Ready for Do"), "ready")
  assert.equal(planningStateFromStatus("Doing"), "in-progress")
  assert.equal(planningStateFromStatus("  DONE  "), "done")
  assert.equal(planningStateFromStatus("Archived"), "archived")
  // Never a guess: an unmapped column stays unmapped.
  assert.equal(planningStateFromStatus("Icebox"), undefined)
  assert.equal(planningStateFromStatus(null), undefined)

  // Every state the write side can emit must be understood by the read side,
  // or a mirror would write a column it cannot read back.
  for (const [state, label] of Object.entries(PLANNING_TO_GITHUB_STATUS)) {
    assert.equal(planningStateFromStatus(label), state, `${label} must read back as ${state}`)
  }
  // And every state the read side knows must have a label to write.
  for (const state of new Set(Object.values(GITHUB_STATUS_TO_PLANNING))) {
    assert.ok(PLANNING_TO_GITHUB_STATUS[state] !== undefined, `${state} has no label to write`)
  }
})

test("a key comes from the title prefix, and falls back rather than being invented", () => {
  assert.equal(keyFromTitle("[T-150] adapter", "fallback"), "T-150")
  assert.equal(keyFromTitle("[E-018] epic", "fallback"), "E-018")
  assert.equal(keyFromTitle("no prefix here", "alotth/mapctx#7"), "alotth/mapctx#7")
  assert.equal(keyFromTitle(undefined, "fallback"), "fallback")
  // Not at the start is not a key: a title mentioning [T-150] in passing must
  // not resolve as that task.
  assert.equal(keyFromTitle("about [T-150]", "fallback"), "fallback")
})

test("findByKey resolves known keys, omits unknown ones, and never partially matches", async () => {
  const { provider, recorded } = buildProvider()
  const known = recorded.context.writableItem.workItem.key
  const found = await provider.findByKey({ project: recorded.context.project, keys: [known] })
  assert.equal(found.ok, true)
  if (found.ok) {
    assert.equal(found.value.items.length, 1)
    assert.equal(found.value.items[0]?.ref.workItem.key, known)
  }

  const absent = await provider.findByKey({ project: recorded.context.project, keys: ["T-999"] })
  assert.equal(absent.ok, true)
  // Absent, not an error: during a migration most keys are not on the board yet.
  if (absent.ok) assert.equal(absent.value.items.length, 0)

  const none = await provider.findByKey({ project: recorded.context.project, keys: [] })
  assert.equal(none.ok, true)
  if (none.ok) assert.equal(none.value.items.length, 0)
})

test("describeFields carries the Status options a single-select write needs", async () => {
  const { provider, recorded } = buildProvider()
  const described = await provider.describeFields({ project: recorded.context.project })
  assert.equal(described.ok, true)
  if (!described.ok) return

  const status = described.value.find((field) => field.semantic === "planningState")
  assert.ok(status !== undefined, "the board's Status field must map to planningState")
  assert.equal(status?.dataType, "single-select")
  assert.ok((status?.options?.length ?? 0) > 0, "an option id cannot be derived from a value, so options must be listed")
  assert.equal(status?.surface, "project-item")
  assert.ok(status?.projectId, "a project-item field must carry the project id a write needs")

  // Round trip through the value the provider itself reports.
  const item = await provider.getItem({ ref: recorded.context.writableItem as ProviderItemRef })
  assert.equal(item.ok, true)
  if (!item.ok) return
  const current = item.value.fields.planningState
  assert.equal(typeof current, "string")
  assert.ok(
    resolveOptionId(described.value, "planningState", String(current)) !== undefined,
    `the item's own planningState ${String(current)} must resolve to an option id`
  )
  // Case-insensitive by name, and nothing is guessed.
  assert.equal(resolveOptionId(described.value, "planningState", "definitely not a column"), undefined)
})

test("describeFields is refused on a repository, which has no field layer", async () => {
  const transport = fixtureTransport([loadRecordedFixture(), loadSyntheticFixture()])
  const recorded = loadRecordedFixture()
  const provider = new GitHubProvider({ transport, collection: recorded.context.repoCollection })
  const described = await provider.describeFields({ project: recorded.context.repoCollection })
  assert.equal(described.ok, false)
  if (described.ok) return
  assert.equal(described.error.kind, "unsupported")
  assert.equal(described.error.capability, "github.describeFields.repo")
})

test("the field budget is the measured ceiling, and the board fits inside it", async () => {
  const { provider, recorded } = buildProvider()
  const budget = GITHUB_ISSUE_CAPABILITIES.fieldBudget
  assert.ok(budget !== undefined)
  // 49, not the 50 GitHub's own refusal message names: T-135 never saw more
  // than 49 through `fields(first: 100)`.
  assert.equal(budget?.maxFieldsPerProject, 49)
  assert.equal(budget?.measured, true)

  const described = await provider.describeFields({ project: recorded.context.project })
  assert.equal(described.ok, true)
  if (!described.ok) return
  assert.ok(described.value.length <= (budget?.maxFieldsPerProject ?? 0))
})

test("rate limit is reported from the payload, which is the only trustworthy meter", async () => {
  const { provider } = buildProvider()
  assert.equal(GITHUB_ISSUE_CAPABILITIES.rateLimit.reportable, true)
  const reading = await provider.rateLimit()
  assert.equal(reading.ok, true)
  if (!reading.ok) return
  assert.equal(reading.value.unit, "points")
  assert.ok(reading.value.limit > 0)
  assert.ok(reading.value.remaining >= 0 && reading.value.remaining <= reading.value.limit)
  assert.ok(!Number.isNaN(Date.parse(reading.value.resetAt)))
})

test("a rate-limited response is classified retryable with the provider's hint", async () => {
  const transport = fixtureTransport([loadSyntheticFixture()])
  const provider = new GitHubProvider({ transport, collection: "project:alotth/99" })
  const result = await provider.getItem({
    ref: { provider: "github", workItem: { id: "I_kwDOSYNTHETIClimit", key: "limit" }, species: GITHUB_SPECIES_ISSUE }
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.kind, "rate-limited")
  assert.equal(result.error.retryable, true)
})

// ---- the mapping, against the synthetic edges ------------------------------
//
// These run on hand-built payloads because every issue reachable for this work
// has zero dependency edges. The recorded fixture proves the query and the
// cost; only these prove the mapping.

function syntheticIssue(id: string): Record<string, unknown> {
  const file = loadSyntheticFixture()
  const entry = file.entries.find((candidate) => candidate.key === `node?id="${id}"`)
  assert.ok(entry?.data !== undefined, `no synthetic entry for ${id}`)
  return (entry?.data as { node: Record<string, unknown> }).node
}

test("dependencies map to all three relation kinds, in the right direction", () => {
  const extracted = dependenciesFromIssue(syntheticIssue("I_kwDOSYNTHETIC0000A") as never, "alotth/synthetic")
  const kinds = extracted.dependencies.map((edge) => `${edge.kind}:${edge.to.workItem.id}`).sort()
  assert.deepEqual(kinds, [
    "blocked-by:I_kwDOSYNTHETIC0000B",
    "blocks:I_kwDOSYNTHETIC0000C",
    "relates-to:I_kwDOSYNTHETIC0000C"
  ])
  // Direction matters and is easy to invert: `blockedBy` means THIS item is
  // blocked, so the edge runs from this item to the blocker.
  const blockedBy = extracted.dependencies.find((edge) => edge.kind === "blocked-by")
  assert.equal(blockedBy?.from.workItem.id, "I_kwDOSYNTHETIC0000A")
  assert.equal(blockedBy?.to.workItem.id, "I_kwDOSYNTHETIC0000B")
  assert.equal(blockedBy?.revision, "2026-10-10T12:00:00Z")
  assert.equal(extracted.truncated.length, 0)
})

test("sub-issues map to blocks, child before parent, and stay separable", () => {
  const extracted = dependenciesFromIssue(syntheticIssue("I_kwDOSYNTHETIC0000A") as never, "alotth/synthetic")
  assert.equal(extracted.subIssueEdges.length, 1)
  const edge = extracted.subIssueEdges[0]
  // A parent cannot be done while a child is open, so the child blocks the
  // parent. Returned separately so a caller wanting hierarchy without
  // scheduling edges can drop them.
  assert.equal(edge?.kind, "blocks")
  assert.equal(edge?.from.workItem.id, "I_kwDOSYNTHETIC0child")
  assert.equal(edge?.to.workItem.id, "I_kwDOSYNTHETIC0000A")
  assert.ok(!extracted.dependencies.some((dep) => dep.from.workItem.id === "I_kwDOSYNTHETIC0child"))
})

test("a truncated edge list is reported, never read as no dependencies", () => {
  const extracted = dependenciesFromIssue(syntheticIssue("I_kwDOSYNTHETICtrunc") as never, "alotth/synthetic")
  // Two of five blockers and one of three sub-issues came back.
  assert.equal(extracted.dependencies.filter((edge) => edge.kind === "blocked-by").length, 2)
  assert.equal(extracted.truncated.length, 2)
  assert.ok(extracted.truncated.some((entry) => entry.includes("blockedBy") && entry.includes("2 of 5")))
  assert.ok(extracted.truncated.some((entry) => entry.includes("subIssues") && entry.includes("1 of 3")))
})

test("getDependencies folds truncation into a partial page with omitted named", async () => {
  const transport = fixtureTransport([loadSyntheticFixture()])
  const provider = new GitHubProvider({ transport, collection: "project:alotth/99" })
  const result = await provider.getDependencies({
    items: [{ provider: "github", workItem: { id: "I_kwDOSYNTHETICtrunc", key: "T-905" }, species: GITHUB_SPECIES_ISSUE }]
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.freshness.partial, true, "a truncated nested connection makes the page partial")
  assert.ok((result.value.freshness.omitted?.length ?? 0) >= 2, "omitted must name what was cut")
})

test("an item reads its Status from the bound board, not from whichever came first", () => {
  const raw = syntheticIssue("I_kwDOSYNTHETIC0000C") as never
  const onBoard = itemFromIssue({ issue: raw, boundProjectId: "PVT_kwHOSYNTHETIC00000" })
  // The provider's own value, untranslated: `Cancelled` is the column name.
  assert.equal(onBoard.fields.planningState, "Cancelled")
  assert.equal(planningStateFromStatus(String(onBoard.fields.planningState)), "cancelled")
  assert.equal(onBoard.ref.projectItem?.projectId, "PVT_kwHOSYNTHETIC00000")
  assert.equal(onBoard.species, GITHUB_SPECIES_ISSUE)

  // Bound to a different board, the Status of this one must not leak in: the
  // fallback is the issue's own state.
  const offBoard = itemFromIssue({ issue: raw, boundProjectId: "PVT_kwHOsomeOtherBoard" })
  assert.equal(offBoard.fields.planningState, "closed")
  assert.equal(offBoard.ref.projectItem, undefined)
})
