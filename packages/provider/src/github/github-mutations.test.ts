/**
 * Mutation tests for the contract suite against the GitHub read adapter.
 *
 * Same shape as `../contract-suite-mutations.test.ts`: wrap the real
 * `GitHubProvider` in a thin object that delegates every method to it except
 * the one line that introduces a single named defect, run
 * `checkProviderContract`, and assert both that the suite fails AND that the
 * specific check id the defect should trip is among `report.failures`. If the
 * suite could not catch these against the GitHub adapter, it would not catch
 * the equivalent lie from any future adapter either.
 *
 * `wrapProvider` delegates by calling `inner.method(...)` directly rather than
 * via `Object.create`/`Proxy`, so there is no ambiguity about what `this`
 * means inside a delegated call -- every override is a plain function closing
 * over `inner`. It also forwards `capabilitiesForItem` and `rateLimit`, which
 * `GitHubProvider` defines and `../contract-suite-mutations.test.ts`'s
 * `LocalStoreProvider`-only wrapper does not need to: omitting
 * `capabilitiesForItem` here would fail `species.resolver-present` as noise on
 * every test, not just the one mutation meant to fail it.
 */

import assert from "node:assert/strict"
import test from "node:test"

import { checkProviderContract, formatContractFailures, type ContractContext } from "../contract-suite"
import { GITHUB_SPECIES_DRAFT } from "./mapping"
import { loadRecordedFixture, loadSyntheticFixture } from "./fixtures"
import { GitHubProvider } from "./github-provider"
import { fixtureTransport } from "./transport"
import { ok, page } from "../results"
import type {
  ListItemsInput,
  ProviderFieldDescriptor,
  ProviderItemRef,
  TaskProvider
} from "../types"

function wrapProvider(inner: TaskProvider, overrides: Partial<TaskProvider>): TaskProvider {
  return {
    kind: inner.kind,
    capabilities: overrides.capabilities ?? inner.capabilities,
    capabilitiesForItem:
      overrides.capabilitiesForItem ??
      (inner.capabilitiesForItem ? (ref: ProviderItemRef) => inner.capabilitiesForItem!(ref) : undefined),
    listItems: overrides.listItems ?? inner.listItems.bind(inner),
    getItem: overrides.getItem ?? inner.getItem.bind(inner),
    findByKey: overrides.findByKey ?? inner.findByKey.bind(inner),
    describeFields: overrides.describeFields ?? inner.describeFields.bind(inner),
    rateLimit: overrides.rateLimit ?? (inner.rateLimit ? () => inner.rateLimit!() : undefined),
    getProject: overrides.getProject ?? inner.getProject.bind(inner),
    setProjectField: overrides.setProjectField ?? inner.setProjectField.bind(inner),
    createItem: overrides.createItem ?? inner.createItem.bind(inner),
    closeOrReopen: overrides.closeOrReopen ?? inner.closeOrReopen.bind(inner),
    getDependencies: overrides.getDependencies ?? inner.getDependencies.bind(inner),
    addDependency: overrides.addDependency ?? inner.addDependency.bind(inner),
    removeDependency: overrides.removeDependency ?? inner.removeDependency.bind(inner),
    setField: overrides.setField ?? inner.setField.bind(inner),
    applyFieldWrites: overrides.applyFieldWrites ?? inner.applyFieldWrites.bind(inner),
    listCriteria: overrides.listCriteria ?? inner.listCriteria.bind(inner),
    setCriterionState: overrides.setCriterionState ?? inner.setCriterionState.bind(inner),
    listComments: overrides.listComments ?? inner.listComments.bind(inner),
    addComment: overrides.addComment ?? inner.addComment.bind(inner),
    timeline: overrides.timeline ?? inner.timeline.bind(inner)
  }
}

/**
 * One fresh fixture-backed provider per test, same as the local-store mutation
 * suite: `GitHubProvider` caches a resolved project node id per instance, and
 * sharing one across tests would make a later test's resolution depend on an
 * earlier test's call order.
 */
function buildContext(): { ctx: ContractContext; provider: GitHubProvider } {
  const recorded = loadRecordedFixture()
  const synthetic = loadSyntheticFixture()
  const transport = fixtureTransport([recorded, synthetic])
  const provider = new GitHubProvider({ transport, collection: recorded.context.project })
  const ctx: ContractContext = {
    provider,
    project: recorded.context.project,
    writableItem: recorded.context.writableItem,
    secondWritableItem: recorded.context.secondWritableItem,
    missingItem: recorded.context.missingItem,
    narrowedSpeciesItem: recorded.context.narrowedSpeciesItem,
    expectedItemCount: recorded.context.expectedItemCount,
    // Nothing is writable on this read adapter, so no sample value can be
    // honoured -- the suite's own skip logic for an un-sampled writable field
    // is exactly what "nothing to sample" means here.
    sampleValues: {}
  }
  return { ctx, provider }
}

test("baseline: the unmutated GitHub adapter passes its own contract", async () => {
  const { ctx } = buildContext()
  const report = await checkProviderContract(ctx)
  assert.equal(
    report.failed,
    0,
    `the clean adapter must not fail its own contract:\n${formatContractFailures(report)}`
  )
})

test("mutation: a capability that lies -- priority claims write:true but the adapter still refuses it", async () => {
  const { ctx, provider } = buildContext()
  const liar = wrapProvider(provider, {
    capabilities: {
      ...provider.capabilities,
      fields: {
        ...provider.capabilities.fields,
        // The lie: `priority` is genuinely unwritable on this read adapter
        // (setField refuses every field unconditionally), so delegating still
        // returns `unsupported`, but the declaration now claims it is accepted.
        priority: { ...provider.capabilities.fields.priority!, write: true }
      }
    }
  })

  const report = await checkProviderContract({ ...ctx, provider: liar, sampleValues: { priority: "high" } })
  assert.ok(report.failed > 0, "a provider lying about write:true must fail the suite")
  assert.ok(
    report.failures.some((f) => f.id === "write.accepted.priority"),
    `expected write.accepted.priority among failures:\n${formatContractFailures(report)}`
  )

  // The real adapter, asked the same question, must not trip this check: it
  // honestly declares priority unwritable, so the suite takes the
  // write.refused.* branch instead and never reaches write.accepted.priority.
  const baseline = await checkProviderContract({ ...ctx, sampleValues: { priority: "high" } })
  assert.ok(
    !baseline.failures.some((f) => f.id === "write.accepted.priority"),
    `the real adapter must not fail write.accepted.priority:\n${formatContractFailures(baseline)}`
  )
})

test("mutation: a page without a cursor silently drops one item", async () => {
  const { ctx, provider } = buildContext()
  const liar = wrapProvider(provider, {
    listItems: async (input: ListItemsInput) => {
      const result = await provider.listItems(input)
      if (!result.ok) return result
      // Only truncate the unpaged, uncursored read -- the cursor walk
      // (first:1 + cursor) is left alone so the two reads disagree, which is
      // exactly the bug this check exists to catch: a page reporting fewer
      // items than actually exist, with no cursor and no `partial: true` to
      // say so.
      if (input.cursor === undefined && input.first === undefined && result.value.nextCursor === undefined) {
        return ok(page(result.value.items.slice(0, -1)))
      }
      return result
    }
  })

  const report = await checkProviderContract({ ...ctx, provider: liar })
  assert.ok(report.failed > 0, "a provider that drops items without a cursor must fail the suite")
  const caught = report.failures.some((f) => f.id === "listItems.count" || f.id === "paging.same-total")
  assert.ok(caught, `expected listItems.count or paging.same-total among failures:\n${formatContractFailures(report)}`)
})

test("mutation: describeFields hands back option ids that do not match the item's own value", async () => {
  const { ctx, provider } = buildContext()
  const liar = wrapProvider(provider, {
    describeFields: async (input) => {
      const result = await provider.describeFields(input)
      if (!result.ok) return result
      const mutated: ProviderFieldDescriptor[] = result.value.map((entry) => {
        if (entry.semantic !== "planningState" || entry.options === undefined) return entry
        // The lie: every option's id AND name are rewritten, so the round trip
        // from the item's own planningState value to an option id -- which
        // matches on name -- cannot land on anything.
        return {
          ...entry,
          options: entry.options.map((option) => ({ ...option, id: `wrong-${option.id}`, name: `wrong-${option.name}` }))
        }
      })
      return ok(mutated)
    }
  })

  const report = await checkProviderContract({ ...ctx, provider: liar })
  assert.ok(report.failed > 0, "a provider that corrupts enumerated option ids must fail the suite")
  assert.ok(
    report.failures.some((f) => f.id === "describeFields.option-roundtrip"),
    `expected describeFields.option-roundtrip among failures:\n${formatContractFailures(report)}`
  )
})

test("mutation: rateLimit declares itself unreportable but still returns a reading", async () => {
  const { ctx, provider } = buildContext()
  const liar = wrapProvider(provider, {
    capabilities: { ...provider.capabilities, rateLimit: { reportable: false } }
  })

  const report = await checkProviderContract({ ...ctx, provider: liar })
  assert.ok(report.failed > 0, "a provider declaring rateLimit unreportable while still answering must fail the suite")
  assert.ok(
    report.failures.some((f) => f.id === "rateLimit.refused-when-unsupported"),
    `expected rateLimit.refused-when-unsupported among failures:\n${formatContractFailures(report)}`
  )
})

test("mutation: rateLimit reports more remaining than the limit allows", async () => {
  const { ctx, provider } = buildContext()
  const liar = wrapProvider(provider, {
    rateLimit: async () => {
      const result = await provider.rateLimit!()
      if (!result.ok) return result
      return ok({ ...result.value, remaining: result.value.limit + 1000 })
    }
  })

  const report = await checkProviderContract({ ...ctx, provider: liar })
  assert.ok(report.failed > 0, "a provider reporting remaining > limit must fail the suite")
  assert.ok(
    report.failures.some((f) => f.id === "rateLimit.sane"),
    `expected rateLimit.sane among failures:\n${formatContractFailures(report)}`
  )
})

test("mutation: the draft-issue species widens comments beyond the primary record", async () => {
  const { ctx, provider } = buildContext()
  // `widenedSpeciesClaims` (capabilities.ts) flags a per-species claim that is
  // `true` where the primary record is not. The primary record's
  // `comments: { read: true, write: false }` already allows `read`, so
  // widening `read` on the draft would not be a lie the checker could see.
  // `write` is the claim the primary genuinely denies, so that is the one
  // mutated here -- a draft issue claiming it can be commented on when the
  // primary species cannot.
  const liar = wrapProvider(provider, {
    capabilities: {
      ...provider.capabilities,
      species: {
        ...provider.capabilities.species,
        [GITHUB_SPECIES_DRAFT]: {
          ...provider.capabilities.species![GITHUB_SPECIES_DRAFT],
          comments: { read: true, write: true }
        }
      }
    }
  })

  const report = await checkProviderContract({ ...ctx, provider: liar })
  assert.ok(report.failed > 0, "a species that widens the primary record must fail the suite")
  assert.ok(
    report.failures.some((f) => f.id === "species.narrowing-only"),
    `expected species.narrowing-only among failures:\n${formatContractFailures(report)}`
  )
})
