/**
 * Mutation tests for the contract suite itself.
 *
 * Each test wraps the real `LocalStoreProvider` in a thin object that
 * delegates every method to it except the one line that introduces a single
 * named defect, runs `checkProviderContract`, and asserts both that the
 * suite fails AND that the specific check id the defect should trip is among
 * `report.failures`. A suite that failed to catch any of these would not
 * catch the equivalent bug in the GitHub adapter either -- that is the whole
 * reason this suite exists (decisions 9 and 10 in
 * docs/engineering/provider-contract-decisions.md).
 *
 * `wrapProvider` delegates by calling `inner.method(...)` directly rather
 * than via `Object.create`/`Proxy`, so there is no ambiguity about what
 * `this` means inside a delegated call -- every override is a plain function
 * closing over `inner`.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { checkProviderContract, formatContractFailures, type ContractContext } from "./contract-suite"
import { LocalStoreProvider } from "./local-store-provider"
import { ok, page } from "./results"
import { createProviderFixture, FIXTURE_EPIC, FIXTURE_MISSING, FIXTURE_SECOND, FIXTURE_WRITABLE } from "./__test-helpers__"
import type { FieldWrite, FieldWriteOutcome, ListItemsInput, ProviderItemRef, TaskProvider } from "./types"

const ref = (id: string): ProviderItemRef => ({ provider: "local", workItem: { id, key: id } })

// Deliberately duplicated from contract-suite-binding.test.ts rather than
// imported: each mutation test needs its own fixture and provider instance,
// and importing a sibling .test.ts file would re-register its tests here too.
function buildContractContext(fixture: ReturnType<typeof createProviderFixture>): ContractContext {
  const provider = new LocalStoreProvider({ store: fixture.handle, actor: "contract", projectId: fixture.storeDir })
  return {
    provider,
    project: fixture.storeDir,
    writableItem: ref(FIXTURE_WRITABLE),
    secondWritableItem: ref(FIXTURE_SECOND),
    missingItem: ref(FIXTURE_MISSING),
    sampleValues: {
      title: "Contract suite title",
      type: "chore",
      parent: FIXTURE_EPIC,
      priority: "low",
      tags: ["contract"],
      startDate: "2026-02-01",
      dueDate: "2026-03-01",
      iteration: "sprint-1",
      assignees: ["someone"],
      milestone: "m1",
      summary: "Contract suite summary.",
      role: "implementation",
      impact: "medium"
    },
    legalPlanningStateMove: "ready",
    illegalPlanningStateMove: "done",
    expectedItemCount: 4
  }
}

function wrapProvider(inner: TaskProvider, overrides: Partial<TaskProvider>): TaskProvider {
  return {
    kind: inner.kind,
    capabilities: overrides.capabilities ?? inner.capabilities,
    listItems: overrides.listItems ?? inner.listItems.bind(inner),
    getItem: overrides.getItem ?? inner.getItem.bind(inner),
    findByKey: overrides.findByKey ?? inner.findByKey.bind(inner),
    describeFields: overrides.describeFields ?? inner.describeFields.bind(inner),
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

test("mutation: declares a field write:false but accepts the write anyway", async () => {
  const fixture = createProviderFixture()
  try {
    const ctx = buildContractContext(fixture)
    const inner = ctx.provider
    const liar = wrapProvider(inner, {
      capabilities: {
        ...inner.capabilities,
        fields: {
          ...inner.capabilities.fields,
          // The lie: the real provider still accepts a title write (inner's
          // own capabilities, which setField actually consults, are
          // untouched), but the declaration callers see says it is refused.
          title: { ...inner.capabilities.fields.title!, write: false }
        }
      }
    })

    const report = await checkProviderContract({ ...ctx, provider: liar })
    assert.ok(report.failed > 0, "a provider lying about write:false must fail the suite")
    assert.ok(
      report.failures.some((f) => f.id === "write.refused.title"),
      `expected write.refused.title among failures:\n${formatContractFailures(report)}`
    )
  } finally {
    fixture.teardown()
  }
})

test("mutation: declares a field write:true but returns unsupported", async () => {
  const fixture = createProviderFixture()
  try {
    const ctx = buildContractContext(fixture)
    const inner = ctx.provider
    const liar = wrapProvider(inner, {
      capabilities: {
        ...inner.capabilities,
        fields: {
          ...inner.capabilities.fields,
          // The lie: `body` is genuinely unwritable in the real provider (it
          // stays Git-authored), so delegating still returns `unsupported`,
          // but the declaration now claims the write is accepted.
          body: { ...(inner.capabilities.fields.body ?? { read: false, write: false }), write: true }
        }
      }
    })

    const report = await checkProviderContract({
      ...ctx,
      provider: liar,
      sampleValues: { ...ctx.sampleValues, body: "mutation-test body value" }
    })
    assert.ok(report.failed > 0, "a provider lying about write:true must fail the suite")
    assert.ok(
      report.failures.some((f) => f.id === "write.accepted.body"),
      `expected write.accepted.body among failures:\n${formatContractFailures(report)}`
    )
  } finally {
    fixture.teardown()
  }
})

test("mutation: a refusal turned into a fabricated success (listComments)", async () => {
  const fixture = createProviderFixture()
  try {
    const ctx = buildContractContext(fixture)
    const inner = ctx.provider
    // capabilities.comments.read stays false (truthful), but the method
    // itself returns ok instead of the unsupported refusal the real store
    // provider gives. This is the "error turned into success" shape: nothing
    // about the capability record lies, only the behaviour does.
    const liar = wrapProvider(inner, {
      listComments: async () => ok(page([]))
    })

    const report = await checkProviderContract({ ...ctx, provider: liar })
    assert.ok(report.failed > 0, "a provider that fabricates success where it should refuse must fail the suite")
    assert.ok(
      report.failures.some((f) => f.id === "comments.read-refused"),
      `expected comments.read-refused among failures:\n${formatContractFailures(report)}`
    )
  } finally {
    fixture.teardown()
  }
})

test("mutation: a page without a cursor silently drops items", async () => {
  const fixture = createProviderFixture()
  try {
    const ctx = buildContractContext(fixture)
    const inner = ctx.provider
    const liar = wrapProvider(inner, {
      listItems: async (input: ListItemsInput) => {
        const result = await inner.listItems(input)
        if (!result.ok) return result
        // Only truncate the unpaged, uncursored read -- the cursor walk
        // (first:1 + cursor) is left alone so the two reads disagree, which
        // is exactly the bug this check exists to catch: a page reporting
        // fewer items than actually exist, with no cursor and no
        // `partial: true` to say so.
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
  } finally {
    fixture.teardown()
  }
})

test("mutation: a dropped precondition succeeds instead of refusing", async () => {
  const fixture = createProviderFixture()
  try {
    const ctx = buildContractContext(fixture)
    const inner = ctx.provider
    // capabilities.preconditions.revision stays false (truthful: the real
    // store provider has no compare-and-swap). The defect is that a caller's
    // precondition is silently stripped before delegating, so the write
    // succeeds instead of being refused as unsupported -- the exact failure
    // mode decision 2 in the decisions doc exists to prevent.
    const liar = wrapProvider(inner, {
      setField: async (input) => {
        if (input.precondition) {
          const { precondition, ...rest } = input
          return inner.setField(rest)
        }
        return inner.setField(input)
      }
    })

    const report = await checkProviderContract({ ...ctx, provider: liar })
    assert.ok(report.failed > 0, "a provider that silently drops a precondition must fail the suite")
    assert.ok(
      report.failures.some((f) => f.id === "precondition.refused-when-unsupported"),
      `expected precondition.refused-when-unsupported among failures:\n${formatContractFailures(report)}`
    )
  } finally {
    fixture.teardown()
  }
})

test("mutation: applyFieldWrites claims verified:true without writing anything", async () => {
  const fixture = createProviderFixture()
  try {
    const ctx = buildContractContext(fixture)
    const inner = ctx.provider
    // The bug `batch.verified-claim` exists to catch: every write reports
    // "applied" and the batch claims `verified: true`, but nothing actually
    // lands in the store. Delegate the empty-batch case honestly so
    // `batch.rejects-empty` stays clean noise-free.
    const liar = wrapProvider(inner, {
      applyFieldWrites: async (input) => {
        if (input.writes.length === 0) return inner.applyFieldWrites(input)
        const outcomes: FieldWriteOutcome[] = input.writes.map((write) => ({ status: "applied", write }))
        return ok({
          outcomes,
          applied: outcomes.length,
          failed: 0,
          unknown: 0,
          skipped: 0,
          partiallyApplied: false,
          verified: true
        })
      }
    })

    const report = await checkProviderContract({ ...ctx, provider: liar })
    assert.ok(report.failed > 0, "a batch that applies nothing but claims verified:true must fail the suite")
    assert.ok(
      report.failures.some((f) => f.id === "batch.verified-claim"),
      `expected batch.verified-claim among failures:\n${formatContractFailures(report)}`
    )
    const readbackFailures = report.failures.filter((f) => f.id.startsWith("batch.readback."))
    assert.ok(
      readbackFailures.length >= 3,
      `expected at least three batch.readback.* failures, got ${readbackFailures.length}:\n${formatContractFailures(report)}`
    )
  } finally {
    fixture.teardown()
  }
})

test("mutation: applyFieldWrites applies every value into the wrong field", async () => {
  const fixture = createProviderFixture()
  try {
    const ctx = buildContractContext(fixture)
    const inner = ctx.provider
    // The bug: every write that is declared writable lands on `summary`
    // instead of the field actually requested, while the outcome reported
    // back still names the original write. `applyFieldWrites` is checked only
    // for internal self-consistency elsewhere, so this passes everywhere
    // except the batch readback -- the one place that actually looks at what
    // the store ended up holding.
    const liar = wrapProvider(inner, {
      applyFieldWrites: async (input) => {
        if (input.writes.length === 0) return inner.applyFieldWrites(input)
        const outcomes: FieldWriteOutcome[] = []
        for (const write of input.writes) {
          if (inner.capabilities.fields[write.field.semantic]?.write !== true) {
            // Declared unwritable: delegate honestly so this stays reported
            // as `failed`, same as the real provider -- otherwise
            // `batch.mixed-reports-failure` would fire as noise alongside
            // the readback failures this mutation is meant to trip.
            const single = await inner.setField({ ...write, clientOperationId: input.clientOperationId })
            outcomes.push(single.ok ? single.value : { status: "failed", write, error: single.error })
            continue
          }
          const misdirected = await inner.setField({
            item: write.item,
            field: { semantic: "summary", surface: "work-item" },
            value: write.value,
            clientOperationId: input.clientOperationId
          })
          if (!misdirected.ok) {
            outcomes.push({ status: "failed", write, error: misdirected.error })
            continue
          }
          // Report success against the ORIGINAL write even though the value
          // landed in `summary` instead.
          const status = misdirected.value.status === "cleared" ? "cleared" : "applied"
          outcomes.push({ status, write, ...("revision" in misdirected.value ? { revision: misdirected.value.revision } : {}) } as FieldWriteOutcome)
        }
        const failed = outcomes.filter((o) => o.status === "failed").length
        const unknown = outcomes.filter((o) => o.status === "unknown").length
        const applied = outcomes.length - failed - unknown
        return ok({
          outcomes,
          applied,
          failed,
          unknown,
          skipped: 0,
          partiallyApplied: applied > 0 && failed + unknown > 0,
          verified: false
        })
      }
    })

    const report = await checkProviderContract({ ...ctx, provider: liar })
    assert.ok(report.failed > 0, "a batch that writes every value to the wrong field must fail the suite")
    const readbackFailures = report.failures.filter((f) => f.id.startsWith("batch.readback."))
    assert.ok(
      readbackFailures.length >= 3,
      `expected at least three batch.readback.* failures, got ${readbackFailures.length}:\n${formatContractFailures(report)}`
    )
  } finally {
    fixture.teardown()
  }
})

test("mutation: applyFieldWrites strips skipped outcomes from a failing batch", async () => {
  const fixture = createProviderFixture()
  try {
    const ctx = buildContractContext(fixture)
    const inner = ctx.provider
    // The bug (F4): outcomes the honest provider reported as "skipped" are
    // filtered out of the array and the skipped count zeroed, so a batch that
    // stopped early after a failure looks like it reported one outcome per
    // write when it did not. Only fires on the MIXED batch -- the all-valid
    // batch never produces a skipped outcome to strip.
    const liar = wrapProvider(inner, {
      applyFieldWrites: async (input) => {
        const result = await inner.applyFieldWrites(input)
        if (!result.ok) return result
        const outcome = result.value
        const outcomes = outcome.outcomes.filter((o) => o.status !== "skipped")
        return ok({ ...outcome, outcomes, skipped: 0 })
      }
    })

    const report = await checkProviderContract({ ...ctx, provider: liar })
    assert.ok(report.failed > 0, "a batch that strips skipped outcomes must fail the suite")
    assert.ok(
      report.failures.some((f) => f.id === "batch.mixed-outcome-per-write"),
      `expected batch.mixed-outcome-per-write among failures:\n${formatContractFailures(report)}`
    )
  } finally {
    fixture.teardown()
  }
})
