/**
 * The `TaskProvider` contract: task authority behind one interface, so the
 * store and GitHub Projects are two implementations of the same thing.
 *
 * Two documents constrain every shape here.
 *
 * `docs/engineering/provider-authority-study.md` (T-123) fixed the vocabulary:
 * the P fields a provider owns, the item/field addressing GitHub forces, and
 * the fourteen operations. Those names are kept deliberately so the study and
 * the code can be read side by side.
 *
 * `docs/engineering/github-projects-spike.md` (T-135) measured the provider
 * the first adapter has to live with, and four of its findings changed the
 * contract rather than being left as prose:
 *
 *   1. There is no write precondition on GitHub at all, and ten concurrent
 *      writes to one field all succeeded last-write-wins. So `expectedRevision`
 *      is NOT a parameter every write carries. It is a `precondition` a caller
 *      may pass only when `capabilities.preconditions.revision` is true, and a
 *      provider that cannot honour it must REFUSE with `unsupported` instead of
 *      ignoring it. Silently dropping a precondition is the one failure mode
 *      that turns a safety mechanism into a lie.
 *   2. A batch of 50 aliased field writes cost one rate-limit point, and a
 *      failing batch still applied its valid writes. So the batch is the
 *      primitive (`applyFieldWrites`), its result is per-write, and
 *      `partiallyApplied` is an explicit state rather than something a caller
 *      infers.
 *   3. Re-sending an identical value was a no-op for one field type and moved
 *      the revision for another. So idempotence is declared per field, not
 *      assumed, and `clientOperationId` is documented as correlation only.
 *   4. A capability can be discovered at write time ("Roadmap views do not
 *      support visible fields", HTTP 200). So `discoveredAtWrite` is part of
 *      the capability record.
 *
 * Nothing in this module performs I/O or imports a provider implementation.
 */

/** Implementations that exist or are compiled against this contract. */
export type ProviderKind = "local" | "github" | "linear" | "jira"

/**
 * Opaque provider-side version marker. Never parsed, never ordered: on GitHub
 * it is a second-granularity `updatedAt` that moves for unrelated reasons, so
 * comparing two revisions for anything but equality is not meaningful.
 */
export type Revision = string

export type ProviderRelationKind = "blocks" | "blocked-by" | "relates-to"

/** Planning fields a provider owns under ADR 0005 option B. */
export type ProviderOwnedField =
  | "title"
  | "body"
  | "planningState"
  | "type"
  | "parent"
  | "priority"
  | "tags"
  | "startDate"
  | "dueDate"
  | "completedOn"
  | "iteration"
  | "assignees"
  | "milestone"
  | "summary"
  | "role"
  | "impact"

export const PROVIDER_OWNED_FIELDS: readonly ProviderOwnedField[] = [
  "title",
  "body",
  "planningState",
  "type",
  "parent",
  "priority",
  "tags",
  "startDate",
  "dueDate",
  "completedOn",
  "iteration",
  "assignees",
  "milestone",
  "summary",
  "role",
  "impact"
]

/**
 * What kind of thing an item is, inside one provider.
 *
 * Provider-defined, because the distinction is provider-specific: GitHub has
 * `issue` and `draft-issue` on the same board, and a draft has no dependency
 * edges, no sub-issues, no comments, no timeline and no open/closed state,
 * while an issue has all of them. One static capability record cannot describe
 * both, and a caller that plans a dependency write against "GitHub" rather than
 * against "this item" plans against a provider that does not exist.
 *
 * `capabilities` describes the PRIMARY species (`capabilities.primarySpecies`).
 * `capabilitiesForItem` is authoritative for one item, and a non-primary
 * species may only NARROW the primary record — never widen it, or the primary
 * record would be a floor nobody declared.
 */
export type ProviderItemSpecies = string

/**
 * Item identity.
 *
 * `workItem` is the thing that owns title and body — a store task, a GitHub
 * issue, a Linear issue. `projectItem` is a separate identity that exists only
 * when the item also sits on a board: on GitHub a Project V2 item id is not the
 * issue id, and the spike confirmed a field write needs the project id and the
 * item id as well as the field id.
 *
 * `species` is optional on a ref because a caller holding only an id should not
 * have to know. A provider that distinguishes species must be able to infer it
 * from the ref it issued, and uses this field only when it cannot.
 */
export type ProviderItemRef = {
  provider: ProviderKind
  workItem: { id: string; key: string; url?: string }
  projectItem?: { projectId: string; itemId: string }
  species?: ProviderItemSpecies
}

/**
 * A resolved address for one field write.
 *
 * `work-item` fields live on the item itself. `project-item` fields live on a
 * board and need the four distinct identities GitHub requires, including the
 * option id for a single select — which cannot be derived from the value, only
 * looked up. The adapter resolves these; the contract refuses to pretend a
 * field name is an address.
 */
export type FieldRef =
  | {
      semantic: ProviderOwnedField
      surface: "work-item"
      providerFieldId?: string
    }
  | {
      semantic: ProviderOwnedField
      surface: "project-item"
      projectId: string
      projectItemId: string
      providerFieldId: string
      optionId?: string
    }

export type ProviderItem = {
  ref: ProviderItemRef
  revision: Revision
  fields: Partial<Record<ProviderOwnedField, unknown>>
  /** Which species this item is. A single-species provider reports its own. */
  species: ProviderItemSpecies
}

/**
 * One option of an enumerated provider field.
 *
 * The spike's load-bearing finding for addressing: a GitHub single-select write
 * needs the OPTION id, and an option id cannot be derived from the value — only
 * looked up. `Status` is the field the adapter owns and the one the mirror has
 * to write, so if the contract cannot hand back option ids, every caller has to
 * reach around it with provider-specific code.
 */
export type ProviderFieldOption = { id: string; name: string; description?: string }

export type ProviderFieldDataType =
  | "text"
  | "number"
  | "date"
  /** Enumerated: one of a fixed option set, and a write needs the option id. */
  | "single-select"
  /** Enumerated: several of a fixed option set. GitHub's `Labels` is one. */
  | "multi-select"
  /**
   * An open-ended list of strings with no option set at all. Distinct from
   * `multi-select` on purpose: the store's `tags` accept any text, so demanding
   * an option id for them would be demanding one that cannot exist.
   */
  | "text-list"
  | "iteration"
  /** A provider built-in with no contract-visible value shape (GitHub's `Repository`, `Linked pull requests`). */
  | "native"

/**
 * A provider field as the provider itself describes it.
 *
 * `semantic` is absent when the field carries no contract meaning. That is not
 * noise: the count of descriptors against `capabilities.fieldBudget` is how a
 * caller knows how much room is left on a board, and GitHub's 13 built-ins
 * spend that budget whether MapCtx uses them or not.
 */
export type ProviderFieldDescriptor = {
  semantic?: ProviderOwnedField
  /** The provider's own name for the field, as a person sees it. */
  name: string
  providerFieldId: string
  surface: "work-item" | "project-item"
  dataType: ProviderFieldDataType
  options?: readonly ProviderFieldOption[]
  /** Present for `project-item`, where the field belongs to a board. */
  projectId?: string
}

/**
 * Remaining provider budget before a large batch, read rather than guessed.
 *
 * GitHub bills GraphQL in points (5,000/hour) and a batch of 50 aliased writes
 * cost one, so a mirror pushing 136 tasks is cheap — but only if it can check.
 * A provider that cannot report this declares `reportable: false` and callers
 * must not infer a balance from a failed write.
 */
export type ProviderRateLimit = {
  limit: number
  remaining: number
  /** ISO timestamp when `remaining` returns to `limit`. */
  resetAt: string
  unit: "points" | "requests"
  /** Cost of the operation that produced this reading, when the provider says. */
  costOfLastOperation?: number
}

export type ProviderDependency = {
  from: ProviderItemRef
  to: ProviderItemRef
  kind: ProviderRelationKind
  revision?: Revision
}

export type ProviderCriterionState = "pending" | "complete"

export type ProviderCriterion = {
  id: string
  item: ProviderItemRef
  text: string
  state: ProviderCriterionState
  position?: number
  revision?: Revision
}

export type ProviderComment = {
  id: string
  item: ProviderItemRef
  body: string
  author?: string
  createdAt: string
}

export type ProviderTimelineEventKind = "created" | "field-changed" | "comment" | "relation-changed"

export type ProviderTimelineEvent = {
  id: string
  item: ProviderItemRef
  occurredAt: string
  actor?: string
  kind: ProviderTimelineEventKind
  revision?: Revision
  payload?: Record<string, unknown>
}

export type ProviderErrorKind =
  | "rate-limited"
  | "auth"
  | "not-found"
  | "unsupported"
  | "conflict"
  | "transient"
  | "invalid"

/**
 * `retryable` travels with the error so callers do not re-derive it per kind
 * and disagree. `unsupported` is never retryable: the provider cannot do this,
 * and trying again will not change that.
 */
export type ProviderError = {
  kind: ProviderErrorKind
  message: string
  retryable: boolean
  /** Which capability was missing, for `unsupported`. */
  capability?: string
  /** Provider-reported wait hint, for `rate-limited` and `transient`. */
  retryAfter?: string
  /** The revision the provider actually holds, for `conflict`. */
  currentRevision?: Revision
}

export type ProviderResult<T> = { ok: true; value: T } | { ok: false; error: ProviderError }

/**
 * Page freshness is reported, not assumed.
 *
 * `partial` means this page is known to be incomplete — a next cursor exists,
 * or a nested connection was truncated. The spike's read path hit exactly that:
 * a cut-off `blockedBy` list must never read as "no dependencies", so a
 * truncated nested collection sets `partial` and names what was dropped.
 *
 * `source` and `stale` are **advisory and unverified**. Nothing outside the
 * provider can tell whether a page came from a cache or how old that cache is,
 * so the contract suite does not check them and a caller must not build a
 * cache-invalidation policy on them. `partial` and `fetchedAt` are checked;
 * these two are a provider's self-report.
 */
export type PageFreshness = {
  fetchedAt: string
  source: "live" | "cache"
  stale: boolean
  partial: boolean
  omitted?: string[]
}

export type Page<T> = {
  items: T[]
  nextCursor?: string
  freshness: PageFreshness
}

/** Per-field capability. Absent field = not supported at all. */
export type FieldCapability = {
  read: boolean
  write: boolean
  /**
   * The provider accepts the write and may still refuse it at execution time
   * for reasons the schema does not express. Callers must treat an
   * `unsupported` result on this field as information, not as a bug.
   */
  discoveredAtWrite?: boolean
  /**
   * Re-sending the value the field already holds is recognised as a no-op and
   * reported as `unchanged`.
   *
   * This is about the reported outcome, not about the revision: a provider's
   * revision marker can be too coarse to show a write (the local provider's is
   * a date), so "the revision did not move" proves nothing either way. The
   * spike measured this as differing per field type on GitHub, so it is
   * declared rather than assumed.
   */
  idempotentRewrite?: boolean
}

export type RelationCapability = { read: boolean; write: boolean }

/**
 * How one non-primary species differs from the primary record.
 *
 * Narrowing only. Every `true` here must be `true` in the primary record too,
 * and the contract suite checks that — otherwise `capabilities` would silently
 * become a floor, and a caller reading it would under-use the provider while
 * believing it was reading the truth.
 */
export type SpeciesCapabilities = {
  fields?: Partial<Record<ProviderOwnedField, FieldCapability>>
  relations?: Partial<Record<ProviderRelationKind, RelationCapability>>
  comments?: { read: boolean; write: boolean }
  criteria?: { read: boolean; write: boolean }
  timeline?: { read: boolean }
  lifecycle?: { create?: boolean; closeOrReopen?: boolean }
  /** Why this species is narrower, for the error message a caller will see. */
  note?: string
}

/**
 * How many fields a board can hold at all.
 *
 * Measured, not quoted: the spike reached 49 observable fields on a GitHub
 * Project and the 50th was refused, while GitHub's own message says 50 — so the
 * number a caller must budget against is the one that was observable. Count
 * `describeFields` against `maxFieldsPerProject` to know what is left; the
 * descriptor list is the live truth and this is only the ceiling.
 */
export type FieldBudget = {
  maxFieldsPerProject: number
  /** True when this ceiling was observed against the provider, not read off documentation. */
  measured: boolean
  note?: string
}

export type ProviderCapabilities = {
  fields: Partial<Record<ProviderOwnedField, FieldCapability>>
  relations: Partial<Record<ProviderRelationKind, RelationCapability>>
  comments: { read: boolean; write: boolean }
  criteria: { read: boolean; write: boolean }
  timeline: { read: boolean }
  lifecycle: { create: boolean; closeOrReopen: boolean }
  /**
   * The species this whole record describes. A single-species provider names
   * its only one; `species` then carries the narrower ones.
   */
  primarySpecies: ProviderItemSpecies
  species?: Record<ProviderItemSpecies, SpeciesCapabilities>
  /** Absent when the provider imposes no board-wide field ceiling. */
  fieldBudget?: FieldBudget
  /**
   * Whether `rateLimit()` returns a real reading. False means the method must
   * refuse with `unsupported` rather than invent a balance.
   */
  rateLimit: { reportable: boolean; unit?: ProviderRateLimit["unit"]; costPerOperation?: number }
  /**
   * Compare-and-swap support. `revision: false` means a caller may not pass a
   * precondition at all; passing one is refused rather than dropped.
   */
  preconditions: { revision: boolean }
  batch: {
    /**
     * `applyFieldWrites` reaches the provider as ONE operation, so a batch is
     * cheaper than the same writes sent singly — on GitHub, 50 aliased writes
     * cost one rate-limit point. False means the method still works but is
     * emulated write-by-write locally, with no cost win. It never means the
     * method is unavailable.
     */
    singleOperation: boolean
    /** Upper bound on writes per batch, when the provider states one. */
    maxWritesPerBatch?: number
    /**
     * A failed batch can leave some of its writes applied. False means the
     * batch is all-or-nothing. GitHub measured false here, and so is a
     * sequential local emulation.
     */
    atomic: boolean
  }
}

/**
 * A caller-supplied precondition. Accepted only when
 * `capabilities.preconditions.revision` is true; otherwise the operation must
 * fail with `unsupported`.
 */
export type WritePrecondition = { expectedRevision: Revision }

/**
 * Correlation id for one logical write.
 *
 * Not a de-duplication key. The spike sent two different values under one
 * GitHub `clientMutationId` and both applied, so retry safety is
 * read-after-write comparison, never "the provider will recognise this id".
 */
export type ClientOperationId = string

export type WriteOptions = {
  clientOperationId: ClientOperationId
  precondition?: WritePrecondition
}

export type FieldWrite = {
  item: ProviderItemRef
  field: FieldRef
  /** `null` clears the field. */
  value: unknown
}

export type FieldWriteOutcome =
  | { status: "applied"; write: FieldWrite; revision?: Revision }
  | { status: "cleared"; write: FieldWrite; revision?: Revision }
  | { status: "unchanged"; write: FieldWrite; revision?: Revision }
  | { status: "failed"; write: FieldWrite; error: ProviderError }
  /** The provider could not say whether this write landed. Read it back. */
  | { status: "unknown"; write: FieldWrite; error: ProviderError }
  /**
   * Never attempted, because an earlier write in the batch failed. Reported
   * explicitly rather than left out: see `BatchOutcome.outcomes`.
   */
  | { status: "skipped"; write: FieldWrite }

/**
 * The result of one batch.
 *
 * `partiallyApplied` is explicit because the spike proved a provider can
 * return a top-level error while some writes have already landed. A caller
 * seeing it must re-read the affected fields; it may not resend the batch.
 *
 * `outcomes` carries **one entry per submitted write, in order** — a provider
 * may not shorten the array. Two providers would otherwise mean opposite
 * things by a short array: the local provider stops at the first failure, while
 * GitHub applies every valid alias and reports the failure at the top, so
 * "fewer outcomes than writes" would be an inference the caller has to make
 * per provider. `status: "skipped"` says it instead.
 */
export type BatchOutcome = {
  outcomes: FieldWriteOutcome[]
  applied: number
  failed: number
  unknown: number
  skipped: number
  partiallyApplied: boolean
  /**
   * True only when the provider re-read the values after writing them.
   *
   * Claiming it without reading back is a contract violation the suite checks
   * by writing values only the batch could have produced and reading them.
   */
  verified: boolean
}

export type ListItemsInput = {
  /** Provider-specific collection: a project id, a repository, a store path. */
  project: string
  cursor?: string
  first?: number
  updatedAfter?: string
  includeClosed?: boolean
  fields?: readonly ProviderOwnedField[]
}

export type CreateItemInput = {
  project: string
  initialFields: Partial<Record<ProviderOwnedField, unknown>>
} & WriteOptions

export type CloseOrReopenInput = {
  item: ProviderItemRef
  state: "open" | "closed"
  reason?: "completed" | "not-planned" | "cancelled" | "archived"
} & WriteOptions

export type DependencyWriteInput = {
  from: ProviderItemRef
  to: ProviderItemRef
  kind: ProviderRelationKind
} & WriteOptions

export type SetCriterionStateInput = {
  criterion: ProviderCriterion
  state: ProviderCriterionState
} & WriteOptions

export type AddCommentInput = {
  item: ProviderItemRef
  body: string
} & WriteOptions

export type ProviderProject = {
  id: string
  title?: string
  notes?: string
  revision?: Revision
}

export type SetProjectFieldInput = {
  project: string
  field: "title" | "notes"
  value: string
} & WriteOptions

/**
 * The fourteen operations from the study, plus `applyFieldWrites` and
 * `listComments`.
 *
 * `applyFieldWrites` is the batch primitive the spike's cost model demands;
 * `setField` stays as the single-write convenience and must behave exactly like
 * a one-write batch. `listComments` exists because the study specified writing
 * comments but never reading them back, which makes a comment unverifiable.
 *
 * There is intentionally NO delete. A migration mistake is closed or archived
 * with an audit trail; a contract that can destroy a person's issue is a
 * contract that will.
 */
export type TaskProvider = {
  readonly kind: ProviderKind
  readonly capabilities: ProviderCapabilities

  /**
   * Capabilities for one specific item, resolving its species.
   *
   * Absent on a single-species provider. Present means `capabilities` describes
   * `primarySpecies` and this is the per-item truth; a caller about to write
   * must ask this, not the static record.
   */
  capabilitiesForItem?(ref: ProviderItemRef): ProviderCapabilities

  listItems(input: ListItemsInput): Promise<ProviderResult<Page<ProviderItem>>>
  getItem(input: { ref: ProviderItemRef }): Promise<ProviderResult<ProviderItem>>

  /**
   * Resolve caller-side keys to provider items in one call.
   *
   * The mirror (T-152) reconciles 136 tasks against a board it does not own the
   * ids of. Without this it has to walk `listItems` on every pass and match on
   * a convention, which is both a full-board read per reconciliation and a
   * silent breakage the day the convention changes. A key with no match is
   * simply ABSENT from the page — not an error, because "this task is not on
   * the board yet" is the normal state during a migration.
   */
  findByKey(input: { project: string; keys: readonly string[] }): Promise<ProviderResult<Page<ProviderItem>>>

  /**
   * The provider's own fields, with the option ids an enumerated write needs.
   *
   * This is what makes `FieldRef.optionId` resolvable inside the contract
   * instead of through provider-specific code in every caller.
   */
  describeFields(input: { project: string }): Promise<ProviderResult<ProviderFieldDescriptor[]>>

  /**
   * Remaining budget, for deciding whether a large batch fits.
   *
   * Must refuse with `unsupported` when `capabilities.rateLimit.reportable` is
   * false. Omitting the method entirely is also legal.
   */
  rateLimit?(): Promise<ProviderResult<ProviderRateLimit>>

  getProject(input: { project: string }): Promise<ProviderResult<ProviderProject>>
  setProjectField(input: SetProjectFieldInput): Promise<ProviderResult<ProviderProject>>

  createItem(input: CreateItemInput): Promise<ProviderResult<ProviderItem>>
  closeOrReopen(input: CloseOrReopenInput): Promise<ProviderResult<ProviderItem>>

  getDependencies(input: { items: readonly ProviderItemRef[] }): Promise<ProviderResult<Page<ProviderDependency>>>
  addDependency(input: DependencyWriteInput): Promise<ProviderResult<ProviderDependency>>
  removeDependency(input: DependencyWriteInput): Promise<ProviderResult<void>>

  setField(input: FieldWrite & WriteOptions): Promise<ProviderResult<FieldWriteOutcome>>
  applyFieldWrites(input: { writes: readonly FieldWrite[] } & WriteOptions): Promise<ProviderResult<BatchOutcome>>

  listCriteria(input: { item: ProviderItemRef; cursor?: string; first?: number }): Promise<ProviderResult<Page<ProviderCriterion>>>
  setCriterionState(input: SetCriterionStateInput): Promise<ProviderResult<ProviderCriterion>>

  listComments(input: { item: ProviderItemRef; cursor?: string; first?: number }): Promise<ProviderResult<Page<ProviderComment>>>
  addComment(input: AddCommentInput): Promise<ProviderResult<{ commentId: string; revision?: Revision }>>

  timeline(input: { item: ProviderItemRef; cursor?: string; since?: string }): Promise<ProviderResult<Page<ProviderTimelineEvent>>>
}
