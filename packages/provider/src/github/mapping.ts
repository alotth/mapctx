/**
 * GitHub payloads to contract shapes.
 *
 * Pure functions, no transport: everything here is testable against a recorded
 * payload, which is where the interesting mistakes live. Three decisions are
 * worth reading before the code.
 *
 * **Species comes from the node id prefix.** GitHub's global ids are typed —
 * `I_` an issue, `DI_` a draft issue, `PVTI_` a project item, `PR_` a pull
 * request — so the adapter can tell what it holds from a ref it issued, without
 * a round trip. A ref whose species cannot be determined is reported as
 * `unknown` rather than assumed to be an issue, because assuming the richer
 * species is what produces an `unsupported` the caller could not anticipate.
 *
 * **`planningState` carries the PROVIDER's value, not a MapCtx state.** It is
 * the `Status` option name when the board has one, otherwise the issue's
 * `open`/`closed`. Translating silently would mean this adapter decided that
 * "In progress" is `in-progress`, and the day a board renames a column the
 * adapter would be inventing states. `GITHUB_STATUS_TO_PLANNING` is exported
 * for callers that want the translation, and it is deliberately separate.
 *
 * **A truncated nested connection is a partial page.** GitHub returns at most
 * the `first` asked for, and a cut-off `blockedBy` list read as "no
 * dependencies" would flatten a plan without any error anywhere.
 */

import type {
  PageFreshness,
  ProviderDependency,
  ProviderFieldDataType,
  ProviderFieldDescriptor,
  ProviderItem,
  ProviderItemRef,
  ProviderItemSpecies,
  ProviderOwnedField,
  ProviderRelationKind
} from "../types"

export const GITHUB_SPECIES_ISSUE = "issue"
export const GITHUB_SPECIES_DRAFT = "draft-issue"
export const GITHUB_SPECIES_PULL_REQUEST = "pull-request"
export const GITHUB_SPECIES_UNKNOWN = "unknown"

/** GitHub's typed global-id prefixes, as the API issues them. */
const SPECIES_BY_PREFIX: ReadonlyArray<[string, ProviderItemSpecies]> = [
  ["DI_", GITHUB_SPECIES_DRAFT],
  ["I_", GITHUB_SPECIES_ISSUE],
  ["PR_", GITHUB_SPECIES_PULL_REQUEST]
]

export function speciesFromTypename(typename: string | undefined): ProviderItemSpecies {
  if (typename === "Issue") return GITHUB_SPECIES_ISSUE
  if (typename === "DraftIssue") return GITHUB_SPECIES_DRAFT
  if (typename === "PullRequest") return GITHUB_SPECIES_PULL_REQUEST
  return GITHUB_SPECIES_UNKNOWN
}

/**
 * Species of a ref, without a round trip.
 *
 * A caller-declared `species` wins, because a caller that knows should not be
 * second-guessed. Otherwise the id prefix decides, and an id the adapter does
 * not recognise is `unknown` — never optimistically an issue.
 */
export function speciesFromRef(ref: Pick<ProviderItemRef, "workItem" | "species">): ProviderItemSpecies {
  if (ref.species !== undefined) return ref.species
  const id = ref.workItem?.id ?? ""
  for (const [prefix, species] of SPECIES_BY_PREFIX) {
    if (id.startsWith(prefix)) return species
  }
  return GITHUB_SPECIES_UNKNOWN
}

/**
 * `Status` option name to MapCtx planning state.
 *
 * Both the legacy labels in `mapctx.toml [github.statusMap]` and the canonical
 * state names are accepted, because a board may already carry either. The
 * operator's 2026-10-14 decision is to publish every task including the
 * terminal ones, so `cancelled` and `archived` are mapped here — the old
 * statusMap covered neither `cancelled` nor `blocked`, and a mirror that cannot
 * express them would have to drop or mislabel those tasks.
 */
export const GITHUB_STATUS_TO_PLANNING: Readonly<Record<string, string>> = {
  backlog: "backlog",
  ready: "ready",
  "ready for do": "ready",
  "ready for dev": "ready",
  blocked: "blocked",
  doing: "in-progress",
  "in progress": "in-progress",
  "in-progress": "in-progress",
  review: "review",
  "in review": "review",
  paused: "paused",
  "on hold": "paused",
  done: "done",
  cancelled: "cancelled",
  canceled: "cancelled",
  archived: "archived"
}

/**
 * The label a mirror should write for each planning state.
 *
 * Read-only here, exported for T-152 so the write side cannot pick a different
 * spelling than the read side understands.
 */
export const PLANNING_TO_GITHUB_STATUS: Readonly<Record<string, string>> = {
  backlog: "Backlog",
  ready: "Ready",
  blocked: "Blocked",
  "in-progress": "In progress",
  review: "Review",
  paused: "Paused",
  done: "Done",
  cancelled: "Cancelled",
  archived: "Archived"
}

/** `undefined` when the option name has no known meaning — never a guess. */
export function planningStateFromStatus(optionName: string | null | undefined): string | undefined {
  if (typeof optionName !== "string") return undefined
  return GITHUB_STATUS_TO_PLANNING[optionName.trim().toLowerCase()]
}

const FIELD_DATA_TYPE: Readonly<Record<string, ProviderFieldDataType>> = {
  TEXT: "text",
  NUMBER: "number",
  DATE: "date",
  SINGLE_SELECT: "single-select",
  ITERATION: "iteration",
  TITLE: "text",
  // A GitHub built-in whose values are the REPOSITORY's labels, not a project
  // option set: `ProjectV2FieldCommon` exposes no options for it, so calling it
  // enumerated would promise option ids that do not exist at this layer.
  LABELS: "native",
  ASSIGNEES: "native",
  LINKED_PULL_REQUESTS: "native",
  MILESTONE: "native",
  REPOSITORY: "native",
  REVIEWERS: "native",
  PARENT_ISSUE: "native",
  SUB_ISSUES_PROGRESS: "native",
  CREATED: "date",
  UPDATED: "date",
  CLOSED: "date"
}

/**
 * Project field names that carry a contract meaning.
 *
 * Only `Status` and `Title` are claimed. Everything else on a board is either a
 * GitHub built-in with no contract-visible value shape or a field MapCtx itself
 * added for derived data (`Wave`, `Forecast P50 (h)`) — which the contract has
 * no vocabulary for and must not pretend to.
 */
const SEMANTIC_BY_PROJECT_FIELD: Readonly<Record<string, ProviderOwnedField>> = {
  status: "planningState",
  title: "title"
}

type RawField = {
  __typename?: string
  id?: string
  name?: string
  dataType?: string
  options?: { id: string; name: string; description?: string }[]
}

export function fieldDescriptorsFromProject(
  projectId: string,
  fields: readonly RawField[]
): ProviderFieldDescriptor[] {
  const descriptors: ProviderFieldDescriptor[] = []
  for (const field of fields) {
    if (field?.id === undefined || field.name === undefined) continue
    const semantic = SEMANTIC_BY_PROJECT_FIELD[field.name.trim().toLowerCase()]
    descriptors.push({
      ...(semantic ? { semantic } : {}),
      name: field.name,
      providerFieldId: field.id,
      surface: "project-item",
      dataType: FIELD_DATA_TYPE[field.dataType ?? ""] ?? "native",
      projectId,
      ...(field.options !== undefined && field.options.length > 0
        ? {
            options: field.options.map((option) => ({
              id: option.id,
              name: option.name,
              ...(option.description ? { description: option.description } : {})
            }))
          }
        : {})
    })
  }
  return descriptors
}

type RawFieldValue = {
  __typename?: string
  text?: string
  number?: number
  date?: string
  optionId?: string
  name?: string
  title?: string
  iterationId?: string
  field?: { id?: string; name?: string }
}

export type ProjectFieldValue = {
  fieldId: string
  fieldName: string
  optionId?: string
  value: string | number | null
}

export function projectFieldValues(nodes: readonly RawFieldValue[] | undefined): ProjectFieldValue[] {
  const values: ProjectFieldValue[] = []
  for (const node of nodes ?? []) {
    const fieldId = node?.field?.id
    const fieldName = node?.field?.name
    if (fieldId === undefined || fieldName === undefined) continue
    values.push({
      fieldId,
      fieldName,
      ...(node.optionId !== undefined ? { optionId: node.optionId } : {}),
      value: node.text ?? node.number ?? node.date ?? node.name ?? node.title ?? null
    })
  }
  return values
}

function statusValue(values: readonly ProjectFieldValue[]): ProjectFieldValue | undefined {
  return values.find((value) => value.fieldName.trim().toLowerCase() === "status")
}

export type RawIssue = {
  __typename?: string
  id: string
  number?: number
  title?: string
  url?: string
  state?: string
  stateReason?: string | null
  createdAt?: string
  updatedAt?: string
  closedAt?: string | null
  body?: string | null
  milestone?: { title?: string } | null
  labels?: { totalCount?: number; nodes?: { name: string }[] }
  assignees?: { totalCount?: number; nodes?: { login: string }[] }
  issueType?: { name?: string } | null
  parent?: { id: string; number?: number; url?: string } | null
  subIssuesSummary?: { total?: number; completed?: number }
  subIssues?: { totalCount?: number; nodes?: { id: string; number?: number; url?: string }[] }
  issueDependenciesSummary?: { blockedBy?: number; blocking?: number; totalBlockedBy?: number; totalBlocking?: number }
  blockedBy?: { totalCount?: number; nodes?: RawRelated[] }
  blocking?: { totalCount?: number; nodes?: RawRelated[] }
  relatesTo?: { totalCount?: number; nodes?: RawRelated[] }
  projectItems?: { totalCount?: number; nodes?: RawProjectItemOfIssue[] }
}

type RawRelated = { id: string; number?: number; url?: string; repository?: { nameWithOwner?: string } }

type RawProjectItemOfIssue = {
  id: string
  project?: { id?: string; number?: number; title?: string }
  fieldValues?: { totalCount?: number; nodes?: RawFieldValue[] }
}

export type RawDraftIssue = {
  __typename?: string
  id: string
  title?: string
  body?: string | null
  createdAt?: string
  updatedAt?: string
}

/**
 * The key a MapCtx caller resolves by: the `[T-150]` prefix a mirrored title
 * carries. Returns the raw title when there is no prefix, so a key is never
 * fabricated and `findByKey` simply does not match.
 */
export function keyFromTitle(title: string | undefined, fallback: string): string {
  const match = /^\[((?:T|E)-\d{3,})\]/.exec(title ?? "")
  return match ? (match[1] as string) : fallback
}

export function refForIssue(issue: RawIssue, repoNameWithOwner?: string): ProviderItemRef {
  const number = issue.number
  const key = keyFromTitle(issue.title, repoNameWithOwner && number ? `${repoNameWithOwner}#${number}` : issue.id)
  return {
    provider: "github",
    workItem: { id: issue.id, key, ...(issue.url ? { url: issue.url } : {}) },
    species: GITHUB_SPECIES_ISSUE
  }
}

export function refForDraft(draft: RawDraftIssue, projectId?: string, projectItemId?: string): ProviderItemRef {
  return {
    provider: "github",
    workItem: { id: draft.id, key: keyFromTitle(draft.title, draft.id) },
    ...(projectId && projectItemId ? { projectItem: { projectId, itemId: projectItemId } } : {}),
    species: GITHUB_SPECIES_DRAFT
  }
}

/**
 * An issue to a `ProviderItem`.
 *
 * `boundProjectId` selects which board's field values count: an issue can sit
 * on several projects, and reading `Status` off whichever came back first would
 * make the value depend on GitHub's ordering.
 */
export function itemFromIssue(input: {
  issue: RawIssue
  repoNameWithOwner?: string
  boundProjectId?: string
}): ProviderItem {
  const { issue, repoNameWithOwner, boundProjectId } = input
  const onBoard =
    boundProjectId === undefined
      ? undefined
      : (issue.projectItems?.nodes ?? []).find((entry) => entry?.project?.id === boundProjectId)
  const values = projectFieldValues(onBoard?.fieldValues?.nodes)
  const status = statusValue(values)
  const ref = refForIssue(issue, repoNameWithOwner)

  return {
    ref: {
      ...ref,
      ...(onBoard !== undefined && boundProjectId !== undefined
        ? { projectItem: { projectId: boundProjectId, itemId: onBoard.id } }
        : {})
    },
    revision: issue.updatedAt ?? "",
    species: GITHUB_SPECIES_ISSUE,
    fields: {
      title: issue.title ?? null,
      body: issue.body ?? null,
      // The board's own column name when there is one; the issue's intrinsic
      // state otherwise. Never translated here -- see the module comment.
      planningState: status?.value ?? (issue.state ? issue.state.toLowerCase() : null),
      type: issue.issueType?.name ?? null,
      parent: issue.parent?.id ?? null,
      tags: (issue.labels?.nodes ?? []).map((label) => label.name),
      assignees: (issue.assignees?.nodes ?? []).map((user) => user.login),
      milestone: issue.milestone?.title ?? null,
      completedOn: issue.closedAt ?? null
    }
  }
}

/**
 * A draft issue to a `ProviderItem`.
 *
 * Deliberately thin, because a draft is thin: no state, no labels, no
 * assignees, no milestone, no parent. Reporting `null` for them would say "this
 * draft has no labels" when the truth is that the concept does not exist for
 * it, so those keys are ABSENT and the narrowed capability record is what says
 * why.
 */
export function itemFromDraft(input: {
  draft: RawDraftIssue
  projectId?: string
  projectItemId?: string
  /** Project field values, which a draft does have: it is a board row. */
  values?: readonly ProjectFieldValue[]
}): ProviderItem {
  const status = statusValue(input.values ?? [])
  return {
    ref: refForDraft(input.draft, input.projectId, input.projectItemId),
    revision: input.draft.updatedAt ?? "",
    species: GITHUB_SPECIES_DRAFT,
    fields: {
      title: input.draft.title ?? null,
      body: input.draft.body ?? null,
      // Always present, `null` when the board carries no `Status` column or no
      // value in it. A draft has no intrinsic state to fall back to -- unlike an
      // issue, which still has open/closed -- and `null` says that, where an
      // absent key would say the concept does not exist. The capability record
      // declares this readable because it is: a board WITH a Status column gives
      // a draft a state, and whether this board has one is a board fact, not a
      // species fact.
      planningState: status?.value ?? null
    }
  }
}

const RELATION_SOURCES: ReadonlyArray<[keyof RawIssue, ProviderRelationKind]> = [
  ["blockedBy", "blocked-by"],
  ["blocking", "blocks"],
  ["relatesTo", "relates-to"]
]

export type DependencyExtraction = {
  dependencies: ProviderDependency[]
  /** Sub-issue edges, mapped onto `blocks`: a parent cannot finish before its children. */
  subIssueEdges: ProviderDependency[]
  /** Nested connections GitHub cut off, named so a page can report itself partial. */
  truncated: string[]
}

/**
 * Dependency and sub-issue edges from one issue.
 *
 * Sub-issues are mapped to `blocks` rather than invented as a fourth kind: the
 * contract has three relation kinds, and a parent issue genuinely cannot be
 * done while a child is open. The parent link itself stays on
 * `fields.parent` so the hierarchy is not lost, and `subIssueEdges` is returned
 * separately so a caller that wants hierarchy without scheduling edges can drop
 * them.
 */
export function dependenciesFromIssue(issue: RawIssue, repoNameWithOwner?: string): DependencyExtraction {
  const from = refForIssue(issue, repoNameWithOwner)
  const dependencies: ProviderDependency[] = []
  const truncated: string[] = []

  for (const [key, kind] of RELATION_SOURCES) {
    const connection = issue[key] as { totalCount?: number; nodes?: RawRelated[] } | undefined
    const nodes = connection?.nodes ?? []
    for (const node of nodes) {
      if (node?.id === undefined) continue
      dependencies.push({
        from,
        to: {
          provider: "github",
          workItem: {
            id: node.id,
            key:
              node.repository?.nameWithOwner && node.number
                ? `${node.repository.nameWithOwner}#${node.number}`
                : node.id,
            ...(node.url ? { url: node.url } : {})
          },
          species: GITHUB_SPECIES_ISSUE
        },
        kind,
        ...(issue.updatedAt ? { revision: issue.updatedAt } : {})
      })
    }
    if ((connection?.totalCount ?? 0) > nodes.length) {
      truncated.push(`${from.workItem.key}.${String(key)} (${nodes.length} of ${connection?.totalCount})`)
    }
  }

  const subIssueEdges: ProviderDependency[] = []
  const subNodes = issue.subIssues?.nodes ?? []
  for (const node of subNodes) {
    if (node?.id === undefined) continue
    subIssueEdges.push({
      from: {
        provider: "github",
        workItem: { id: node.id, key: node.number ? `#${node.number}` : node.id, ...(node.url ? { url: node.url } : {}) },
        species: GITHUB_SPECIES_ISSUE
      },
      to: from,
      kind: "blocks",
      ...(issue.updatedAt ? { revision: issue.updatedAt } : {})
    })
  }
  if ((issue.subIssues?.totalCount ?? 0) > subNodes.length) {
    truncated.push(`${from.workItem.key}.subIssues (${subNodes.length} of ${issue.subIssues?.totalCount})`)
  }

  return { dependencies, subIssueEdges, truncated }
}

/** Freshness for a page, with truncated nested collections folded in. */
export function githubFreshness(input: {
  hasNextPage: boolean
  truncated?: readonly string[]
  fetchedAt?: string
}): PageFreshness {
  const truncated = input.truncated ?? []
  return {
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    source: "live",
    stale: false,
    partial: input.hasNextPage || truncated.length > 0,
    ...(truncated.length > 0 ? { omitted: [...truncated] } : {})
  }
}
