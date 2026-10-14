/**
 * The reusable provider contract suite.
 *
 * Any `TaskProvider` must pass this, and the point of it is narrower and
 * harsher than "the methods work": **a provider may not lie about itself**.
 * Capabilities are a declaration callers plan around, so the suite checks the
 * provider against its own record in both directions — a declared `write:
 * false` must actually refuse, and a declared `write: true` must not refuse as
 * `unsupported`. A provider that quietly swallowed a write, or reported a
 * capability it lacks, would pass a suite that only exercised happy paths.
 *
 * It reports rather than asserts: `checkProviderContract` returns a list of
 * named checks with outcomes. That keeps it independent of any test runner (so
 * the same suite can run against a fake or against GitHub), and it makes
 * mutation testing possible — mutate a provider, run the suite, and assert that
 * the specific check which should catch it is the one that fails.
 */

import { isRetryableKind } from "./results"
import type {
  FieldWrite,
  ProviderError,
  ProviderErrorKind,
  ProviderItemRef,
  ProviderOwnedField,
  ProviderRelationKind,
  ProviderResult,
  TaskProvider
} from "./types"

const ERROR_KINDS: readonly ProviderErrorKind[] = [
  "rate-limited",
  "auth",
  "not-found",
  "unsupported",
  "conflict",
  "transient",
  "invalid"
]

export type ContractCheck = {
  /** Stable id, so a mutation test can name the check it expects to fail. */
  id: string
  group: string
  ok: boolean
  detail: string
  /** Set when the provider's own declaration made this check inapplicable. */
  skipped?: boolean
}

export type ContractReport = {
  provider: string
  checks: ContractCheck[]
  passed: number
  failed: number
  skipped: number
  failures: ContractCheck[]
}

export type ContractContext = {
  provider: TaskProvider
  /** Project identifier this provider serves. */
  project: string
  /** An item the suite may freely mutate. */
  writableItem: ProviderItemRef
  /** A second mutable item, needed to write a dependency edge between two. */
  secondWritableItem: ProviderItemRef
  /** A reference guaranteed not to resolve. */
  missingItem: ProviderItemRef
  /**
   * One acceptable value per writable field. The suite never guesses a
   * provider's accepted format — a rejected guess would look like a capability
   * failure.
   */
  sampleValues: Partial<Record<ProviderOwnedField, unknown>>
  /** A planning state that is a legal move for `writableItem` right now. */
  legalPlanningStateMove?: string
  /** A planning state that is NOT a legal move, to check the refusal shape. */
  illegalPlanningStateMove?: string
  /** Total items the provider should report for `project`, when known. */
  expectedItemCount?: number
}

function check(id: string, group: string, ok: boolean, detail: string): ContractCheck {
  return { id, group, ok, detail }
}

function skip(id: string, group: string, detail: string): ContractCheck {
  return { id, group, ok: true, detail, skipped: true }
}

function errorOf<T>(result: ProviderResult<T>): ProviderError | undefined {
  return result.ok ? undefined : result.error
}

function describe<T>(result: ProviderResult<T>): string {
  return result.ok ? "ok" : `${result.error.kind}: ${result.error.message}`
}

/** Every error a provider returns is inspected for internal consistency. */
function auditError(checks: ContractCheck[], id: string, group: string, error: ProviderError): void {
  checks.push(
    check(
      `${id}.error-kind`,
      group,
      ERROR_KINDS.includes(error.kind),
      `kind ${error.kind} must be one of ${ERROR_KINDS.join("|")}`
    )
  )
  checks.push(
    check(
      `${id}.error-retryable`,
      group,
      error.retryable === isRetryableKind(error.kind),
      `kind ${error.kind} must report retryable=${isRetryableKind(error.kind)}, got ${error.retryable}`
    )
  )
  if (error.kind === "unsupported") {
    checks.push(
      check(`${id}.error-capability`, group, typeof error.capability === "string" && error.capability.length > 0, "an unsupported error must name the capability it lacks")
    )
  }
}

function fieldWriteFor(ctx: ContractContext, field: ProviderOwnedField, value: unknown): FieldWrite {
  return { item: ctx.writableItem, field: { semantic: field, surface: "work-item" }, value }
}

// ---- groups ---------------------------------------------------------------

async function checkReads(ctx: ContractContext, checks: ContractCheck[]): Promise<void> {
  const group = "reads"
  const { provider } = ctx

  const project = await provider.getProject({ project: ctx.project })
  checks.push(check("getProject.ok", group, project.ok, `getProject(${ctx.project}) -> ${describe(project)}`))

  const first = await provider.listItems({ project: ctx.project })
  checks.push(check("listItems.ok", group, first.ok, `listItems -> ${describe(first)}`))
  if (first.ok) {
    const { freshness, nextCursor, items } = first.value
    checks.push(
      check(
        "listItems.freshness-partial",
        group,
        freshness.partial === (nextCursor !== undefined),
        `partial must mirror the presence of a cursor: partial=${freshness.partial}, nextCursor=${String(nextCursor)}`
      )
    )
    checks.push(
      check("listItems.freshness-fetchedAt", group, !Number.isNaN(Date.parse(freshness.fetchedAt)), `fetchedAt must be a timestamp, got ${freshness.fetchedAt}`)
    )
    if (ctx.expectedItemCount !== undefined && nextCursor === undefined) {
      checks.push(
        check("listItems.count", group, items.length === ctx.expectedItemCount, `expected ${ctx.expectedItemCount} items, got ${items.length}`)
      )
    }
  }

  // Declared readable fields must actually come back on an item.
  const item = await provider.getItem({ ref: ctx.writableItem })
  checks.push(check("getItem.ok", group, item.ok, `getItem -> ${describe(item)}`))
  if (item.ok) {
    for (const field of Object.keys(provider.capabilities.fields) as ProviderOwnedField[]) {
      const declared = provider.capabilities.fields[field]
      if (declared?.read !== true) continue
      checks.push(
        check(
          `getItem.readable.${field}`,
          group,
          field in item.value.fields,
          `capabilities declare ${field} readable, so getItem must return it`
        )
      )
    }
    checks.push(check("getItem.revision", group, typeof item.value.revision === "string", "an item must carry a revision marker"))
  }

  const missing = await provider.getItem({ ref: ctx.missingItem })
  const missingError = errorOf(missing)
  checks.push(
    check("getItem.missing-not-found", group, missingError?.kind === "not-found", `an unknown item must be not-found, got ${describe(missing)}`)
  )
  if (missingError) auditError(checks, "getItem.missing", group, missingError)
}

async function checkPaging(ctx: ContractContext, checks: ContractCheck[]): Promise<void> {
  const group = "paging"
  const { provider } = ctx

  // Walk one item at a time: a cursor that repeats or never ends is a bug a
  // single unpaged read cannot reveal.
  const seen: string[] = []
  let cursor: string | undefined
  let pages = 0
  let looped = false
  do {
    const result = await provider.listItems({ project: ctx.project, first: 1, cursor })
    if (!result.ok) {
      checks.push(check("paging.walk", group, false, `page ${pages} failed: ${describe(result)}`))
      return
    }
    pages += 1
    for (const entry of result.value.items) {
      if (seen.includes(entry.ref.workItem.id)) looped = true
      seen.push(entry.ref.workItem.id)
    }
    cursor = result.value.nextCursor
    if (pages > 500) {
      checks.push(check("paging.terminates", group, false, "cursor walk did not terminate within 500 pages"))
      return
    }
  } while (cursor !== undefined)

  checks.push(check("paging.terminates", group, true, `cursor walk finished in ${pages} pages`))
  checks.push(check("paging.no-repeats", group, !looped, `cursor walk returned a duplicate item: ${seen.join(",")}`))

  const unpaged = await provider.listItems({ project: ctx.project })
  if (unpaged.ok && unpaged.value.nextCursor === undefined) {
    checks.push(
      check(
        "paging.same-total",
        group,
        seen.length === unpaged.value.items.length,
        `paged walk saw ${seen.length} items, unpaged read saw ${unpaged.value.items.length}`
      )
    )
  }

  // A cursor the provider never issued must be refused, not treated as "start
  // from the beginning" or "no more results".
  const bogus = await provider.listItems({ project: ctx.project, first: 1, cursor: "contract-suite-bogus-cursor" })
  checks.push(
    check(
      "paging.rejects-unknown-cursor",
      group,
      !bogus.ok,
      `an unknown cursor must be refused, got ${describe(bogus)}`
    )
  )
  const bogusError = errorOf(bogus)
  if (bogusError) auditError(checks, "paging.unknown-cursor", group, bogusError)
}

async function checkFieldCapabilities(ctx: ContractContext, checks: ContractCheck[]): Promise<void> {
  const group = "field-capabilities"
  const { provider } = ctx

  for (const field of Object.keys(provider.capabilities.fields) as ProviderOwnedField[]) {
    const declared = provider.capabilities.fields[field]
    if (!declared) continue

    // planningState is exercised separately: it needs a legal transition, and a
    // refusal there means "not from this state", not "not supported".
    if (field === "planningState") continue

    if (declared.write !== true) {
      const result = await provider.setField({
        ...fieldWriteFor(ctx, field, ctx.sampleValues[field] ?? "contract-suite"),
        clientOperationId: `contract-${field}-refusal`
      })
      const error = errorOf(result)
      checks.push(
        check(
          `write.refused.${field}`,
          group,
          error?.kind === "unsupported",
          `capabilities declare ${field} unwritable, so the write must be refused as unsupported, got ${describe(result)}`
        )
      )
      if (error) auditError(checks, `write.refused.${field}`, group, error)
      continue
    }

    const sample = ctx.sampleValues[field]
    if (sample === undefined) {
      checks.push(skip(`write.accepted.${field}`, group, `no sample value supplied for writable field ${field}`))
      continue
    }
    const result = await provider.setField({
      ...fieldWriteFor(ctx, field, sample),
      clientOperationId: `contract-${field}-write`
    })
    const error = errorOf(result)
    checks.push(
      check(
        `write.accepted.${field}`,
        group,
        result.ok || error?.kind !== "unsupported",
        `capabilities declare ${field} writable, so the write must not be refused as unsupported, got ${describe(result)}`
      )
    )
    if (!result.ok) {
      if (error) auditError(checks, `write.accepted.${field}`, group, error)
      continue
    }

    // Read-after-write is the only verification this contract has, so a field
    // that claims to be readable and writable must show the value it accepted.
    if (declared.read === true) {
      const after = await provider.getItem({ ref: ctx.writableItem })
      if (after.ok) {
        const got = after.value.fields[field]
        checks.push(
          check(
            `write.readback.${field}`,
            group,
            JSON.stringify(got) === JSON.stringify(sample),
            `wrote ${JSON.stringify(sample)} to ${field} and read back ${JSON.stringify(got)}`
          )
        )
      }
    }

    // Idempotence is whatever the provider declared, checked against what it
    // reports for a rewrite of the value it already holds.
    const rewrite = await provider.setField({
      ...fieldWriteFor(ctx, field, sample),
      clientOperationId: `contract-${field}-rewrite`
    })
    if (rewrite.ok) {
      const unchanged = rewrite.value.status === "unchanged"
      if (declared.idempotentRewrite === true) {
        checks.push(
          check(`write.idempotent.${field}`, group, unchanged, `${field} declares idempotentRewrite, so a rewrite must report unchanged, got ${rewrite.value.status}`)
        )
      } else if (declared.idempotentRewrite === false) {
        checks.push(
          check(`write.not-idempotent.${field}`, group, !unchanged, `${field} declares idempotentRewrite=false, so a rewrite must not claim unchanged`)
        )
      }
    }
  }
}

async function checkPlanningState(ctx: ContractContext, checks: ContractCheck[]): Promise<void> {
  const group = "planning-state"
  const { provider } = ctx
  const declared = provider.capabilities.fields.planningState

  if (declared?.write !== true) {
    checks.push(skip("planningState.write", group, "planningState is not declared writable"))
    return
  }
  if (ctx.legalPlanningStateMove === undefined) {
    checks.push(skip("planningState.legal-move", group, "no legal planning-state move supplied"))
  } else {
    const result = await provider.setField({
      ...fieldWriteFor(ctx, "planningState", ctx.legalPlanningStateMove),
      clientOperationId: "contract-planningState-legal"
    })
    checks.push(check("planningState.legal-move", group, result.ok, `a legal move to ${ctx.legalPlanningStateMove} must succeed, got ${describe(result)}`))
  }

  if (ctx.illegalPlanningStateMove === undefined) {
    checks.push(skip("planningState.illegal-move", group, "no illegal planning-state move supplied"))
    return
  }
  const refused = await provider.setField({
    ...fieldWriteFor(ctx, "planningState", ctx.illegalPlanningStateMove),
    clientOperationId: "contract-planningState-illegal"
  })
  const error = errorOf(refused)
  // An illegal transition is the board refusing a well-formed request, which is
  // a conflict. Reporting it as `unsupported` would tell the caller the field
  // cannot be written at all, which is false and unrecoverable.
  checks.push(
    check(
      "planningState.illegal-move",
      group,
      error?.kind === "conflict" || error?.kind === "invalid",
      `an illegal move to ${ctx.illegalPlanningStateMove} must be conflict or invalid, not ${describe(refused)}`
    )
  )
  if (error) auditError(checks, "planningState.illegal", group, error)
}

async function checkPreconditions(ctx: ContractContext, checks: ContractCheck[]): Promise<void> {
  const group = "preconditions"
  const { provider } = ctx
  const field = (Object.keys(provider.capabilities.fields) as ProviderOwnedField[]).find(
    (candidate) => candidate !== "planningState" && provider.capabilities.fields[candidate]?.write === true && ctx.sampleValues[candidate] !== undefined
  )
  if (field === undefined) {
    checks.push(skip("precondition.handling", group, "no writable field with a sample value to test a precondition against"))
    return
  }

  const result = await provider.setField({
    ...fieldWriteFor(ctx, field, ctx.sampleValues[field]),
    clientOperationId: "contract-precondition",
    precondition: { expectedRevision: "contract-suite-stale-revision" }
  })

  if (provider.capabilities.preconditions.revision) {
    // A provider that supports preconditions must detect a revision it never
    // issued as a conflict.
    const error = errorOf(result)
    checks.push(
      check(
        "precondition.stale-conflicts",
        group,
        error?.kind === "conflict",
        `preconditions are declared supported, so a stale revision must conflict, got ${describe(result)}`
      )
    )
    if (error) auditError(checks, "precondition.stale", group, error)
    return
  }

  // The rule the spike's measurements forced into the contract: a provider
  // without compare-and-swap must REFUSE a precondition. Succeeding would mean
  // the caller believes its write was guarded when it was not.
  const error = errorOf(result)
  checks.push(
    check(
      "precondition.refused-when-unsupported",
      group,
      error?.kind === "unsupported",
      `preconditions are declared unsupported, so passing one must be refused as unsupported (never silently dropped), got ${describe(result)}`
    )
  )
  if (error) auditError(checks, "precondition.refused", group, error)
}

async function checkBatch(ctx: ContractContext, checks: ContractCheck[]): Promise<void> {
  const group = "batch"
  const { provider } = ctx

  const empty = await provider.applyFieldWrites({ writes: [], clientOperationId: "contract-batch-empty" })
  checks.push(check("batch.rejects-empty", group, !empty.ok, `an empty batch must be refused, got ${describe(empty)}`))
  const emptyError = errorOf(empty)
  if (emptyError) auditError(checks, "batch.empty", group, emptyError)

  const writable = (Object.keys(provider.capabilities.fields) as ProviderOwnedField[]).filter(
    (field) => field !== "planningState" && provider.capabilities.fields[field]?.write === true && ctx.sampleValues[field] !== undefined
  )
  const unwritable = (Object.keys(provider.capabilities.fields) as ProviderOwnedField[]).find(
    (field) => provider.capabilities.fields[field]?.write === false
  )

  if (writable.length < 1) {
    checks.push(skip("batch.all-applied", group, "no writable fields with sample values"))
  } else {
    const writes = writable.slice(0, 3).map((field) => fieldWriteFor(ctx, field, ctx.sampleValues[field]))
    const result = await provider.applyFieldWrites({ writes, clientOperationId: "contract-batch-valid" })
    checks.push(check("batch.all-applied", group, result.ok, `a batch of valid writes must succeed, got ${describe(result)}`))
    if (result.ok) {
      const outcome = result.value
      checks.push(
        check(
          "batch.counts-consistent",
          group,
          outcome.applied + outcome.failed + outcome.unknown === outcome.outcomes.length,
          `applied+failed+unknown (${outcome.applied}+${outcome.failed}+${outcome.unknown}) must equal the ${outcome.outcomes.length} reported outcomes`
        )
      )
      checks.push(
        check(
          "batch.not-partial-when-clean",
          group,
          outcome.partiallyApplied === false,
          "a batch where nothing failed must not report partiallyApplied"
        )
      )
      checks.push(
        check(
          "batch.failed-count",
          group,
          outcome.failed === 0 && outcome.unknown === 0,
          `a batch of valid writes must report no failures, got failed=${outcome.failed} unknown=${outcome.unknown}`
        )
      )
    }
  }

  // Mixed batch: one valid write, then one the provider has declared it cannot
  // do. The interesting part is not that it fails -- it is whether the provider
  // tells the caller that something landed anyway.
  if (writable.length >= 1 && unwritable !== undefined) {
    const writes = [
      fieldWriteFor(ctx, writable[0] as ProviderOwnedField, ctx.sampleValues[writable[0] as ProviderOwnedField]),
      fieldWriteFor(ctx, unwritable, ctx.sampleValues[unwritable] ?? "contract-suite")
    ]
    const result = await provider.applyFieldWrites({ writes, clientOperationId: "contract-batch-mixed" })
    if (result.ok) {
      const outcome = result.value
      const landed = outcome.applied > 0
      const broke = outcome.failed + outcome.unknown > 0
      checks.push(
        check(
          "batch.mixed-reports-failure",
          group,
          broke,
          "a batch containing a write the provider declared unsupported must report it as failed"
        )
      )
      checks.push(
        check(
          "batch.partial-flag",
          group,
          outcome.partiallyApplied === (landed && broke),
          `partiallyApplied must be ${landed && broke} when applied=${outcome.applied} and failed+unknown=${outcome.failed + outcome.unknown}`
        )
      )
      if (provider.capabilities.batch.atomic) {
        checks.push(
          check(
            "batch.atomic-rolls-back",
            group,
            outcome.applied === 0,
            "an atomic provider must leave nothing applied when a batch fails"
          )
        )
      }
    } else {
      // A top-level failure is legal, but then the provider is telling the
      // caller nothing about what landed, which an atomic provider may do and a
      // non-atomic one may not.
      checks.push(
        check(
          "batch.mixed-top-level-error",
          group,
          provider.capabilities.batch.atomic,
          `a non-atomic provider must report per-write outcomes rather than a top-level error, got ${describe(result)}`
        )
      )
    }
  } else {
    checks.push(skip("batch.partial-flag", group, "needs one writable and one unwritable field"))
  }

  // setField must be exactly a one-write batch, including how it reports a
  // refusal: at the top level, not buried in a successful batch.
  if (unwritable !== undefined) {
    const single = await provider.setField({
      ...fieldWriteFor(ctx, unwritable, ctx.sampleValues[unwritable] ?? "contract-suite"),
      clientOperationId: "contract-setfield-refusal"
    })
    checks.push(
      check(
        "setField.surfaces-error",
        group,
        !single.ok,
        `setField on an unwritable field must fail at the top level, got ${describe(single)}`
      )
    )
  }
}

async function checkRelations(ctx: ContractContext, checks: ContractCheck[]): Promise<void> {
  const group = "relations"
  const { provider } = ctx
  const kinds: readonly ProviderRelationKind[] = ["blocks", "blocked-by", "relates-to"]

  const deps = await provider.getDependencies({ items: [ctx.writableItem, ctx.secondWritableItem] })
  const anyReadable = kinds.some((kind) => provider.capabilities.relations[kind]?.read === true)
  if (anyReadable) {
    checks.push(check("getDependencies.ok", group, deps.ok, `getDependencies -> ${describe(deps)}`))
    if (deps.ok) {
      checks.push(
        check(
          "getDependencies.declared-kinds-only",
          group,
          deps.value.items.every((edge) => provider.capabilities.relations[edge.kind]?.read === true),
          "every returned relation kind must be one the provider declares readable"
        )
      )
      checks.push(
        check(
          "getDependencies.freshness",
          group,
          deps.value.freshness.partial === (deps.value.nextCursor !== undefined),
          "partial must mirror the presence of a cursor"
        )
      )
    }
  } else {
    const error = errorOf(deps)
    checks.push(
      check("getDependencies.refused", group, error?.kind === "unsupported", `no relation kind is readable, so getDependencies must be unsupported, got ${describe(deps)}`)
    )
  }

  for (const kind of kinds) {
    const declared = provider.capabilities.relations[kind]
    const input = {
      from: ctx.writableItem,
      to: ctx.secondWritableItem,
      kind,
      clientOperationId: `contract-relation-${kind}`
    }

    if (declared?.write !== true) {
      const result = await provider.addDependency(input)
      const error = errorOf(result)
      checks.push(
        check(
          `relation.refused.${kind}`,
          group,
          error?.kind === "unsupported",
          `${kind} is not declared writable, so addDependency must be unsupported, got ${describe(result)}`
        )
      )
      if (error) auditError(checks, `relation.refused.${kind}`, group, error)
      continue
    }

    const added = await provider.addDependency(input)
    checks.push(check(`relation.add.${kind}`, group, added.ok, `addDependency(${kind}) -> ${describe(added)}`))
    if (!added.ok) continue

    if (declared.read === true) {
      const after = await provider.getDependencies({ items: [ctx.writableItem] })
      const present =
        after.ok &&
        after.value.items.some(
          (edge) =>
            edge.kind === kind &&
            edge.from.workItem.id === ctx.writableItem.workItem.id &&
            edge.to.workItem.id === ctx.secondWritableItem.workItem.id
        )
      checks.push(check(`relation.readback.${kind}`, group, present, `a written ${kind} edge must be readable back`))
    }

    const removed = await provider.removeDependency(input)
    checks.push(check(`relation.remove.${kind}`, group, removed.ok, `removeDependency(${kind}) -> ${describe(removed)}`))
    if (removed.ok && declared.read === true) {
      const after = await provider.getDependencies({ items: [ctx.writableItem] })
      const gone =
        after.ok &&
        !after.value.items.some(
          (edge) =>
            edge.kind === kind &&
            edge.from.workItem.id === ctx.writableItem.workItem.id &&
            edge.to.workItem.id === ctx.secondWritableItem.workItem.id
        )
      checks.push(check(`relation.removed-readback.${kind}`, group, gone, `a removed ${kind} edge must be gone on the next read`))
    }
  }
}

async function checkCriteria(ctx: ContractContext, checks: ContractCheck[]): Promise<void> {
  const group = "criteria"
  const { provider } = ctx
  const declared = provider.capabilities.criteria

  const listed = await provider.listCriteria({ item: ctx.writableItem })
  if (!declared.read) {
    const error = errorOf(listed)
    checks.push(check("criteria.read-refused", group, error?.kind === "unsupported", `criteria.read is false, so listCriteria must be unsupported, got ${describe(listed)}`))
    return
  }
  checks.push(check("criteria.read", group, listed.ok, `listCriteria -> ${describe(listed)}`))
  if (!listed.ok) return

  checks.push(
    check(
      "criteria.freshness",
      group,
      listed.value.freshness.partial === (listed.value.nextCursor !== undefined),
      "partial must mirror the presence of a cursor"
    )
  )
  checks.push(
    check(
      "criteria.states-valid",
      group,
      listed.value.items.every((criterion) => criterion.state === "pending" || criterion.state === "complete"),
      "every criterion state must be pending or complete"
    )
  )

  // Cursor behaviour, same rule as items: walking one at a time must terminate
  // and cover the same set.
  if (listed.value.items.length > 1) {
    const seen: string[] = []
    let cursor: string | undefined
    let guard = 0
    do {
      const page = await provider.listCriteria({ item: ctx.writableItem, first: 1, cursor })
      if (!page.ok) {
        checks.push(check("criteria.paging", group, false, `criteria paging failed: ${describe(page)}`))
        return
      }
      seen.push(...page.value.items.map((criterion) => criterion.id))
      cursor = page.value.nextCursor
      guard += 1
    } while (cursor !== undefined && guard < 200)
    checks.push(
      check(
        "criteria.paging",
        group,
        seen.length === listed.value.items.length && new Set(seen).size === seen.length,
        `paged criteria walk saw ${seen.length} unique=${new Set(seen).size}, unpaged saw ${listed.value.items.length}`
      )
    )
  } else {
    checks.push(skip("criteria.paging", group, "needs at least two criteria"))
  }

  const target = listed.value.items[0]
  if (target === undefined) {
    checks.push(skip("criteria.write", group, "the writable item has no criteria"))
    return
  }
  const desired = target.state === "complete" ? "pending" : "complete"
  const result = await provider.setCriterionState({
    criterion: target,
    state: desired,
    clientOperationId: "contract-criterion"
  })
  if (!declared.write) {
    const error = errorOf(result)
    checks.push(check("criteria.write-refused", group, error?.kind === "unsupported", `criteria.write is false, so setCriterionState must be unsupported, got ${describe(result)}`))
    return
  }
  checks.push(check("criteria.write", group, result.ok, `setCriterionState(${desired}) -> ${describe(result)}`))
  if (result.ok) {
    checks.push(check("criteria.write-state", group, result.value.state === desired, `setCriterionState must report the requested state, got ${result.value.state}`))
    // Idempotent by intent: asking for the state it already holds is not an
    // error, because the end state the caller asked for is the end state.
    const again = await provider.setCriterionState({
      criterion: result.value,
      state: desired,
      clientOperationId: "contract-criterion-repeat"
    })
    checks.push(
      check("criteria.write-repeat", group, again.ok && again.value.state === desired, `repeating setCriterionState(${desired}) must stay successful, got ${describe(again)}`)
    )
  }
}

async function checkCommentsAndTimeline(ctx: ContractContext, checks: ContractCheck[]): Promise<void> {
  const group = "comments-timeline"
  const { provider } = ctx

  const listed = await provider.listComments({ item: ctx.writableItem })
  if (provider.capabilities.comments.read) {
    checks.push(check("comments.read", group, listed.ok, `listComments -> ${describe(listed)}`))
  } else {
    const error = errorOf(listed)
    checks.push(check("comments.read-refused", group, error?.kind === "unsupported", `comments.read is false, so listComments must be unsupported, got ${describe(listed)}`))
    if (error) auditError(checks, "comments.read-refused", group, error)
  }

  const added = await provider.addComment({ item: ctx.writableItem, body: "contract suite", clientOperationId: "contract-comment" })
  if (provider.capabilities.comments.write) {
    checks.push(check("comments.write", group, added.ok, `addComment -> ${describe(added)}`))
  } else {
    const error = errorOf(added)
    checks.push(check("comments.write-refused", group, error?.kind === "unsupported", `comments.write is false, so addComment must be unsupported, got ${describe(added)}`))
    if (error) auditError(checks, "comments.write-refused", group, error)
  }

  const timeline = await provider.timeline({ item: ctx.writableItem })
  if (provider.capabilities.timeline.read) {
    checks.push(check("timeline.read", group, timeline.ok, `timeline -> ${describe(timeline)}`))
  } else {
    const error = errorOf(timeline)
    checks.push(check("timeline.read-refused", group, error?.kind === "unsupported", `timeline.read is false, so timeline must be unsupported, got ${describe(timeline)}`))
    if (error) auditError(checks, "timeline.read-refused", group, error)
  }
}

async function checkLifecycle(ctx: ContractContext, checks: ContractCheck[]): Promise<void> {
  const group = "lifecycle"
  const { provider } = ctx

  const created = await provider.createItem({
    project: ctx.project,
    initialFields: { title: "Contract suite item" },
    clientOperationId: "contract-create"
  })
  if (!provider.capabilities.lifecycle.create) {
    const error = errorOf(created)
    checks.push(check("lifecycle.create-refused", group, error?.kind === "unsupported", `lifecycle.create is false, so createItem must be unsupported, got ${describe(created)}`))
    return
  }
  checks.push(check("lifecycle.create", group, created.ok, `createItem -> ${describe(created)}`))
  if (!created.ok) return

  // A provider may canonicalise a title -- the store prefixes it with the id it
  // assigned -- so the contract does not demand the input back verbatim. It
  // demands two weaker things that actually matter: the requested text must
  // still be in there, and what create reported must match what a later read
  // shows. A create that reports one title and stores another is the bug this
  // catches.
  const reportedTitle = String(created.value.fields.title ?? "")
  checks.push(
    check(
      "lifecycle.create-keeps-title",
      group,
      reportedTitle.includes("Contract suite item"),
      `a provider may decorate a title but must not lose it, got ${reportedTitle}`
    )
  )
  const readBack = await provider.getItem({ ref: created.value.ref })
  checks.push(
    check(
      "lifecycle.create-readable",
      group,
      readBack.ok && String(readBack.value.fields.title ?? "") === reportedTitle,
      `createItem reported title ${reportedTitle}; a read of the same ref must agree, got ${readBack.ok ? String(readBack.value.fields.title) : describe(readBack)}`
    )
  )

  // Creation is narrower than patching on some providers -- the local store can
  // patch `iteration` but has no way to set it in the creating transaction. The
  // rule is not "create must accept every writable field"; it is that create
  // must never accept a field and then discard it. Stored, or refused. Never
  // swallowed.
  for (const field of Object.keys(provider.capabilities.fields) as ProviderOwnedField[]) {
    // `title` is canonicalised by design and covered above; `planningState` is
    // a state machine whose initial value a provider may normalise.
    if (field === "title" || field === "planningState") continue
    if (provider.capabilities.fields[field]?.write !== true) continue
    const sample = ctx.sampleValues[field]
    if (sample === undefined) {
      checks.push(skip(`lifecycle.create-honours.${field}`, group, `no sample value supplied for ${field}`))
      continue
    }
    const attempt = await provider.createItem({
      project: ctx.project,
      initialFields: { title: `Contract suite create ${field}`, [field]: sample },
      clientOperationId: `contract-create-${field}`
    })
    if (!attempt.ok) {
      checks.push(
        check(
          `lifecycle.create-honours.${field}`,
          group,
          attempt.error.kind === "unsupported",
          `createItem refused ${field}; a refusal is fine but it must be unsupported, got ${describe(attempt)}`
        )
      )
      auditError(checks, `lifecycle.create-honours.${field}`, group, attempt.error)
      continue
    }
    const stored = attempt.value.fields[field]
    checks.push(
      check(
        `lifecycle.create-honours.${field}`,
        group,
        JSON.stringify(stored) === JSON.stringify(sample),
        `createItem accepted ${field}=${JSON.stringify(sample)} but the created item holds ${JSON.stringify(stored)}; accept it or refuse it, never drop it`
      )
    )
  }

  const closed = await provider.closeOrReopen({
    item: created.value.ref,
    state: "closed",
    reason: "cancelled",
    clientOperationId: "contract-close"
  })
  if (!provider.capabilities.lifecycle.closeOrReopen) {
    const error = errorOf(closed)
    checks.push(check("lifecycle.close-refused", group, error?.kind === "unsupported", `lifecycle.closeOrReopen is false, so closeOrReopen must be unsupported, got ${describe(closed)}`))
    return
  }
  checks.push(check("lifecycle.close", group, closed.ok, `closeOrReopen(closed) -> ${describe(closed)}`))

  // No hard delete exists on purpose, and nothing in the contract should grow
  // one by accident.
  checks.push(
    check(
      "lifecycle.no-delete",
      group,
      !("deleteItem" in (provider as unknown as Record<string, unknown>)),
      "a provider must not expose a hard delete: migration mistakes are closed, not destroyed"
    )
  )
}

// ---- entry point ----------------------------------------------------------

/**
 * Run every contract group and report. Never throws for a contract failure:
 * a failure is data, so a caller can assert on it, print it, or compare two
 * providers.
 */
export async function checkProviderContract(ctx: ContractContext): Promise<ContractReport> {
  const checks: ContractCheck[] = []

  // Order matters: reads and paging run against the untouched fixture, before
  // the write groups start changing it.
  await checkReads(ctx, checks)
  await checkPaging(ctx, checks)
  await checkCriteria(ctx, checks)
  await checkCommentsAndTimeline(ctx, checks)
  await checkPreconditions(ctx, checks)
  await checkFieldCapabilities(ctx, checks)
  await checkRelations(ctx, checks)
  await checkBatch(ctx, checks)
  await checkPlanningState(ctx, checks)
  await checkLifecycle(ctx, checks)

  const failures = checks.filter((entry) => !entry.ok)
  return {
    provider: ctx.provider.kind,
    checks,
    passed: checks.filter((entry) => entry.ok && !entry.skipped).length,
    failed: failures.length,
    skipped: checks.filter((entry) => entry.skipped).length,
    failures
  }
}

/** One-line-per-failure rendering, for a test runner's assertion message. */
export function formatContractFailures(report: ContractReport): string {
  if (report.failures.length === 0) return "no contract failures"
  return report.failures.map((entry) => `[${entry.group}] ${entry.id}: ${entry.detail}`).join("\n")
}
