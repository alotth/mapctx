/**
 * The GitHub read adapter (T-150).
 *
 * Reads only. Every write refuses with `unsupported` and names the capability
 * it lacks, which is not a placeholder: the spike (T-135) measured that GitHub
 * has no dependency-write mutation at all, no write precondition of any kind,
 * and batches that partially apply on failure. Declaring those writable before
 * the REST dependency path is validated (T-152) would be the exact failure the
 * contract suite exists to catch — a capability a caller plans around and the
 * provider cannot honour.
 *
 * The collection (`ListItemsInput.project`) takes two forms, because the mirror
 * needs both and they are genuinely different collections:
 *
 *   `project:<owner>/<number>`  a Project V2 board, where draft issues live
 *   `repo:<owner>/<name>`       a repository's issues, where dependencies live
 */

import {
  dependenciesFromIssue,
  fieldDescriptorsFromProject,
  GITHUB_SPECIES_DRAFT,
  GITHUB_SPECIES_ISSUE,
  GITHUB_SPECIES_PULL_REQUEST,
  GITHUB_SPECIES_UNKNOWN,
  githubFreshness,
  itemFromDraft,
  itemFromIssue,
  keyFromTitle,
  projectFieldValues,
  speciesFromRef,
  speciesFromTypename,
  type RawDraftIssue,
  type RawIssue
} from "./mapping"
import {
  Q_ISSUE_COMMENTS,
  Q_ISSUE_TIMELINE,
  Q_NODE,
  Q_PROJECT,
  Q_PROJECT_FIELDS,
  Q_PROJECT_ITEMS,
  Q_RATE_LIMIT,
  Q_REPO_ISSUES,
  Q_SEARCH_KEYS
} from "./queries"
import type { GitHubTransport } from "./transport"
import { capabilitiesForSpecies } from "../capabilities"
import { err, ok, unsupported } from "../results"
import type {
  AddCommentInput,
  BatchOutcome,
  CloseOrReopenInput,
  CreateItemInput,
  DependencyWriteInput,
  FieldWrite,
  FieldWriteOutcome,
  ListItemsInput,
  Page,
  ProviderCapabilities,
  ProviderComment,
  ProviderCriterion,
  ProviderDependency,
  ProviderFieldDescriptor,
  ProviderItem,
  ProviderItemRef,
  ProviderProject,
  ProviderRateLimit,
  ProviderResult,
  ProviderTimelineEvent,
  SetCriterionStateInput,
  SetProjectFieldInput,
  TaskProvider,
  WriteOptions
} from "../types"

const DEFAULT_PAGE_SIZE = 50
/** GitHub refuses `first` above this on every connection (measured, T-135). */
export const GITHUB_MAX_PAGE_SIZE = 100

/**
 * The capability record for an ISSUE, which is this adapter's primary species.
 *
 * Read-only by design in T-150. The write flags are not pessimism: dependency
 * writes have no GraphQL mutation, and the rest wait on T-152 validating the
 * REST path against a writable repository.
 */
export const GITHUB_ISSUE_CAPABILITIES: ProviderCapabilities = {
  fields: {
    title: { read: true, write: false },
    body: { read: true, write: false },
    // The board's `Status` option name, or the issue's own open/closed when the
    // board carries no value. Not translated to a MapCtx state by the adapter.
    planningState: { read: true, write: false },
    type: { read: true, write: false },
    parent: { read: true, write: false },
    tags: { read: true, write: false },
    assignees: { read: true, write: false },
    milestone: { read: true, write: false },
    completedOn: { read: true, write: false },
    // Project fields exist for these on a MapCtx-owned board, but no field on
    // GitHub carries them for an issue, so claiming `read` would mean returning
    // null and calling it a value.
    priority: { read: false, write: false },
    startDate: { read: false, write: false },
    dueDate: { read: false, write: false },
    iteration: { read: false, write: false },
    summary: { read: false, write: false },
    role: { read: false, write: false },
    impact: { read: false, write: false }
  },
  relations: {
    // Real connections, measured: cheap to read (3 points for 50 issues with
    // every relation kind) and impossible to write over GraphQL.
    "blocked-by": { read: true, write: false },
    blocks: { read: true, write: false },
    "relates-to": { read: true, write: false }
  },
  comments: { read: true, write: false },
  // GitHub has no criteria object. Task-list checkboxes in the body are a
  // candidate (T-152), not a surface this adapter pretends to have.
  criteria: { read: false, write: false },
  timeline: { read: true },
  lifecycle: { create: false, closeOrReopen: false },
  // Measured: `UpdateProjectV2ItemFieldValueInput` has no expected-revision
  // field, and ten concurrent writes to one field all applied, last wins.
  preconditions: { revision: false },
  batch: {
    // 50 aliased writes cost one rate-limit point.
    singleOperation: true,
    maxWritesPerBatch: 50,
    // Measured: a failing batch left its valid writes applied.
    atomic: false
  },
  primarySpecies: GITHUB_SPECIES_ISSUE,
  species: {
    /**
     * A draft issue is a board row with a title and a body and nothing else.
     * There is no `Issue` object behind it, so dependency edges, sub-issues,
     * comments, a timeline and an open/closed state do not exist for it — which
     * is why the contract grew per-species capabilities at all (T-150).
     */
    [GITHUB_SPECIES_DRAFT]: {
      fields: {
        title: { read: true, write: false },
        body: { read: true, write: false },
        planningState: { read: true, write: false }
      },
      relations: {},
      comments: { read: false, write: false },
      criteria: { read: false, write: false },
      timeline: { read: false },
      lifecycle: { create: false, closeOrReopen: false },
      note: "a draft issue has no Issue object behind it: no relations, comments, timeline or state"
    },
    /** A pull request on a board is readable as an item and nothing more. */
    [GITHUB_SPECIES_PULL_REQUEST]: {
      fields: { title: { read: true, write: false } },
      relations: {},
      comments: { read: false, write: false },
      criteria: { read: false, write: false },
      timeline: { read: false },
      note: "a pull request is out of scope for the task mirror; only its title is read"
    },
    [GITHUB_SPECIES_UNKNOWN]: {
      fields: {},
      relations: {},
      comments: { read: false, write: false },
      criteria: { read: false, write: false },
      timeline: { read: false },
      note: "species could not be determined from the node id, so nothing is claimed"
    }
  },
  fieldBudget: {
    // 49, not the 50 GitHub's refusal message names: the spike never saw more
    // than 49 through `fields(first: 100)`, so 49 is what a caller can budget.
    maxFieldsPerProject: 49,
    measured: true,
    note: "T-135 reached 49 observable fields; the 50th was refused. 13 are GitHub built-ins."
  },
  rateLimit: { reportable: true, unit: "points", costPerOperation: 1 }
}

export type GitHubCollection =
  | { kind: "project"; owner: string; number: number }
  | { kind: "repo"; owner: string; repo: string }

/**
 * Parse a collection identifier.
 *
 * Strict rather than forgiving: a typo that silently resolved to the wrong
 * board would mirror 136 tasks into someone else's project.
 */
export function parseCollection(project: string): GitHubCollection | undefined {
  const projectMatch = /^project:([A-Za-z0-9-]+)\/(\d+)$/.exec(project)
  if (projectMatch) {
    return { kind: "project", owner: projectMatch[1] as string, number: Number(projectMatch[2]) }
  }
  const repoMatch = /^repo:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(project)
  if (repoMatch) return { kind: "repo", owner: repoMatch[1] as string, repo: repoMatch[2] as string }
  return undefined
}

export type GitHubProviderOptions = {
  transport: GitHubTransport
  /** The collection this instance serves, e.g. `project:alotth/3`. */
  collection: string
  now?: () => Date
}

type RawProjectItem = {
  id: string
  type?: string
  updatedAt?: string
  isArchived?: boolean
  content?: (RawIssue & RawDraftIssue) | null
  fieldValues?: { totalCount?: number; nodes?: unknown[] }
}

export class GitHubProvider implements TaskProvider {
  readonly kind = "github" as const
  readonly capabilities = GITHUB_ISSUE_CAPABILITIES

  private readonly transport: GitHubTransport
  private readonly collectionId: string
  private readonly collection: GitHubCollection | undefined
  private readonly now: () => Date
  /** Resolved once per instance: a board's node id, needed by item queries. */
  private projectNodeId: string | undefined

  constructor(options: GitHubProviderOptions) {
    this.transport = options.transport
    this.collectionId = options.collection
    this.collection = parseCollection(options.collection)
    this.now = options.now ?? (() => new Date())
  }

  capabilitiesForItem(ref: ProviderItemRef): ProviderCapabilities {
    return capabilitiesForSpecies(this.capabilities, speciesFromRef(ref))
  }

  // ---- helpers ----------------------------------------------------------

  private fetchedAt(): string {
    return this.now().toISOString()
  }

  private wrongCollection(project: string): ProviderResult<never> {
    return err("not-found", `this provider serves ${this.collectionId}, not ${project}`)
  }

  private badCollection(): ProviderResult<never> {
    return err(
      "invalid",
      `collection must be project:<owner>/<number> or repo:<owner>/<name>, got ${this.collectionId}`
    )
  }

  private async resolveProjectNodeId(): Promise<ProviderResult<string>> {
    if (this.collection?.kind !== "project") return err("invalid", "not a project collection")
    if (this.projectNodeId !== undefined) return ok(this.projectNodeId)
    const result = await this.transport.execute({
      label: Q_PROJECT.label,
      document: Q_PROJECT.document,
      variables: { owner: this.collection.owner, number: this.collection.number }
    })
    if (!result.ok) return result
    const node = (result.value.data as { user?: { projectV2?: { id?: string } | null } }).user?.projectV2
    if (node?.id === undefined) return err("not-found", `no project ${this.collectionId}`)
    this.projectNodeId = node.id
    return ok(node.id)
  }

  private rejectPageSize(first: number | undefined): ProviderResult<never> | undefined {
    if (first !== undefined && first > GITHUB_MAX_PAGE_SIZE) {
      return err("invalid", `first must be at most ${GITHUB_MAX_PAGE_SIZE}, got ${first}`)
    }
    return undefined
  }

  /** One board row to a `ProviderItem`, dispatching on its content species. */
  private itemFromProjectRow(row: RawProjectItem, projectId: string): ProviderItem | undefined {
    const species = speciesFromTypename(row.content?.__typename)
    const values = projectFieldValues((row.fieldValues?.nodes ?? []) as never)
    if (species === GITHUB_SPECIES_DRAFT && row.content) {
      return itemFromDraft({
        draft: row.content as RawDraftIssue,
        projectId,
        projectItemId: row.id,
        values
      })
    }
    if (species === GITHUB_SPECIES_ISSUE && row.content) {
      return itemFromIssue({ issue: row.content as RawIssue, boundProjectId: projectId })
    }
    // A pull request or an unresolvable row is skipped rather than mapped into
    // a shape it does not have. The page reports itself partial for it.
    return undefined
  }

  // ---- reads ------------------------------------------------------------

  async getProject(input: { project: string }): Promise<ProviderResult<ProviderProject>> {
    if (input.project !== this.collectionId) return this.wrongCollection(input.project)
    if (this.collection === undefined) return this.badCollection()

    if (this.collection.kind === "repo") {
      const result = await this.transport.execute({
        label: Q_REPO_ISSUES.label,
        document: Q_REPO_ISSUES.document,
        variables: { owner: this.collection.owner, repo: this.collection.repo, first: 1, cursor: null, states: ["OPEN", "CLOSED"] }
      })
      if (!result.ok) return result
      const repo = (result.value.data as { repository?: { id?: string; nameWithOwner?: string } | null }).repository
      if (repo?.id === undefined) return err("not-found", `no repository ${this.collectionId}`)
      return ok({ id: repo.id, title: repo.nameWithOwner })
    }

    const result = await this.transport.execute({
      label: Q_PROJECT.label,
      document: Q_PROJECT.document,
      variables: { owner: this.collection.owner, number: this.collection.number }
    })
    if (!result.ok) return result
    const node = (
      result.value.data as {
        user?: { projectV2?: { id?: string; title?: string; shortDescription?: string | null; updatedAt?: string } | null }
      }
    ).user?.projectV2
    if (node?.id === undefined) return err("not-found", `no project ${this.collectionId}`)
    this.projectNodeId = node.id
    return ok({
      id: node.id,
      ...(node.title ? { title: node.title } : {}),
      ...(node.shortDescription ? { notes: node.shortDescription } : {}),
      ...(node.updatedAt ? { revision: node.updatedAt } : {})
    })
  }

  async listItems(input: ListItemsInput): Promise<ProviderResult<Page<ProviderItem>>> {
    if (input.project !== this.collectionId) return this.wrongCollection(input.project)
    if (this.collection === undefined) return this.badCollection()
    const tooBig = this.rejectPageSize(input.first)
    if (tooBig) return tooBig
    const first = input.first ?? DEFAULT_PAGE_SIZE

    if (this.collection.kind === "repo") {
      const result = await this.transport.execute({
        label: Q_REPO_ISSUES.label,
        document: Q_REPO_ISSUES.document,
        variables: {
          owner: this.collection.owner,
          repo: this.collection.repo,
          first,
          cursor: input.cursor ?? null,
          states: input.includeClosed === false ? ["OPEN"] : ["OPEN", "CLOSED"]
        }
      })
      if (!result.ok) return result
      const repo = (
        result.value.data as {
          repository?: { nameWithOwner?: string; issues?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: RawIssue[] } } | null
        }
      ).repository
      if (repo?.issues === undefined) return err("not-found", `no repository ${this.collectionId}`)
      const nodes = (repo.issues.nodes ?? []).filter((node): node is RawIssue => node?.id !== undefined)
      const items = nodes
        .filter((node) => (input.updatedAfter === undefined ? true : (node.updatedAt ?? "") > input.updatedAfter))
        .map((issue) => itemFromIssue({ issue, repoNameWithOwner: repo.nameWithOwner }))
      const hasNext = repo.issues.pageInfo?.hasNextPage === true
      return ok({
        items,
        ...(hasNext && repo.issues.pageInfo?.endCursor ? { nextCursor: repo.issues.pageInfo.endCursor } : {}),
        freshness: githubFreshness({ hasNextPage: hasNext, fetchedAt: this.fetchedAt() })
      })
    }

    const projectId = await this.resolveProjectNodeId()
    if (!projectId.ok) return projectId
    const result = await this.transport.execute({
      label: Q_PROJECT_ITEMS.label,
      document: Q_PROJECT_ITEMS.document,
      variables: { projectId: projectId.value, first, cursor: input.cursor ?? null }
    })
    if (!result.ok) return result
    const connection = (
      result.value.data as {
        node?: { items?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: RawProjectItem[] } } | null
      }
    ).node?.items
    if (connection === undefined) return err("not-found", `no project items for ${this.collectionId}`)

    const rows = (connection.nodes ?? []).filter((row): row is RawProjectItem => row?.id !== undefined)
    const mapped: ProviderItem[] = []
    const skipped: string[] = []
    for (const row of rows) {
      const item = this.itemFromProjectRow(row, projectId.value)
      if (item === undefined) {
        skipped.push(`${row.id} (${row.content?.__typename ?? row.type ?? "unknown"})`)
        continue
      }
      if (input.updatedAfter !== undefined && (item.revision ?? "") <= input.updatedAfter) continue
      mapped.push(item)
    }
    const hasNext = connection.pageInfo?.hasNextPage === true
    return ok({
      items: mapped,
      ...(hasNext && connection.pageInfo?.endCursor ? { nextCursor: connection.pageInfo.endCursor } : {}),
      freshness: githubFreshness({
        hasNextPage: hasNext,
        truncated: skipped.length > 0 ? [`rows this adapter does not map: ${skipped.join(", ")}`] : [],
        fetchedAt: this.fetchedAt()
      })
    })
  }

  async getItem(input: { ref: ProviderItemRef }): Promise<ProviderResult<ProviderItem>> {
    const result = await this.transport.execute({
      label: Q_NODE.label,
      document: Q_NODE.document,
      variables: { id: input.ref.workItem.id }
    })
    if (!result.ok) return result
    const node = (result.value.data as { node?: (RawIssue & RawDraftIssue & { __typename?: string }) | null }).node
    if (node === null || node === undefined) return err("not-found", `unknown node ${input.ref.workItem.id}`)
    const species = speciesFromTypename(node.__typename)
    if (species === GITHUB_SPECIES_ISSUE) {
      return ok(itemFromIssue({ issue: node as RawIssue, boundProjectId: this.projectNodeId }))
    }
    if (species === GITHUB_SPECIES_DRAFT) {
      return ok(itemFromDraft({ draft: node as RawDraftIssue }))
    }
    return err("not-found", `node ${input.ref.workItem.id} is a ${node.__typename ?? "unknown type"}, which this adapter does not map`)
  }

  /**
   * Resolve `[T-150]`-style keys through search.
   *
   * Search is a separate index with its own lag, so a key that exists but has
   * not been indexed is reported as absent — the same as a key that does not
   * exist. That is the honest answer this adapter can give, and the reason the
   * mirror must treat an absent key as "not on the board yet" rather than "gone".
   */
  async findByKey(input: { project: string; keys: readonly string[] }): Promise<ProviderResult<Page<ProviderItem>>> {
    if (input.project !== this.collectionId) return this.wrongCollection(input.project)
    if (this.collection === undefined) return this.badCollection()
    if (input.keys.length === 0) return ok({ items: [], freshness: githubFreshness({ hasNextPage: false, fetchedAt: this.fetchedAt() }) })

    const wanted = new Set(input.keys)

    // A repository is indexed, so search answers without a walk. This is the
    // path that matters: the mirror creates issues in a repository and has to
    // find them again by key on every reconciliation.
    if (this.collection.kind === "repo") {
      const terms = input.keys.map((key) => `"[${key}]"`).join(" OR ")
      const result = await this.transport.execute({
        label: Q_SEARCH_KEYS.label,
        document: Q_SEARCH_KEYS.document,
        variables: {
          query: `repo:${this.collection.owner}/${this.collection.repo} in:title ${terms}`,
          first: Math.min(GITHUB_MAX_PAGE_SIZE, Math.max(10, input.keys.length))
        }
      })
      if (!result.ok) return result
      const search = (result.value.data as { search?: { pageInfo?: { hasNextPage?: boolean }; nodes?: RawIssue[] } }).search
      const items = (search?.nodes ?? [])
        .filter((node): node is RawIssue => node?.id !== undefined)
        // Search matches words, so an exact key check is still required: a
        // query for `[T-15]` must not resolve to `[T-150]`.
        .filter((node) => wanted.has(keyFromTitle(node.title, "")))
        .map((issue) => itemFromIssue({ issue, boundProjectId: this.projectNodeId }))
      return ok({
        items,
        freshness: githubFreshness({ hasNextPage: search?.pageInfo?.hasNextPage === true, fetchedAt: this.fetchedAt() })
      })
    }

    // A Project V2 board is NOT searchable by key: GitHub's `project:`
    // qualifier addresses classic projects, and there is no issue-search
    // qualifier for a V2 board. So this path walks the board, which is bounded
    // by the board's own size and is the collection being reconciled anyway.
    // It costs one point per page of 100 -- stated here because a caller
    // choosing a collection is choosing this cost.
    const found: ProviderItem[] = []
    let cursor: string | undefined
    let partial = false
    for (let guard = 0; guard < 200; guard += 1) {
      const pageResult = await this.listItems({ project: input.project, first: GITHUB_MAX_PAGE_SIZE, ...(cursor ? { cursor } : {}) })
      if (!pageResult.ok) return pageResult
      for (const item of pageResult.value.items) {
        if (wanted.has(item.ref.workItem.key)) found.push(item)
      }
      if (pageResult.value.freshness.omitted !== undefined) partial = true
      cursor = pageResult.value.nextCursor
      if (cursor === undefined) break
    }
    return ok({
      items: found,
      freshness: githubFreshness({ hasNextPage: false, truncated: partial ? ["some board rows are not mappable to items"] : [], fetchedAt: this.fetchedAt() })
    })
  }

  async describeFields(input: { project: string }): Promise<ProviderResult<ProviderFieldDescriptor[]>> {
    if (input.project !== this.collectionId) return this.wrongCollection(input.project)
    if (this.collection === undefined) return this.badCollection()
    if (this.collection.kind === "repo") {
      // A repository has no field layer at all; the fields an issue carries are
      // intrinsic and have no ids to address.
      return unsupported("github.describeFields.repo", "a repository collection has no project fields; bind a project to describe fields")
    }
    const result = await this.transport.execute({
      label: Q_PROJECT_FIELDS.label,
      document: Q_PROJECT_FIELDS.document,
      variables: { owner: this.collection.owner, number: this.collection.number }
    })
    if (!result.ok) return result
    const project = (
      result.value.data as {
        user?: { projectV2?: { id?: string; fields?: { nodes?: unknown[] } } | null }
      }
    ).user?.projectV2
    if (project?.id === undefined) return err("not-found", `no project ${this.collectionId}`)
    this.projectNodeId = project.id
    return ok(fieldDescriptorsFromProject(project.id, (project.fields?.nodes ?? []) as never))
  }

  async getDependencies(input: { items: readonly ProviderItemRef[] }): Promise<ProviderResult<Page<ProviderDependency>>> {
    // Species first: a draft has no edges, and answering "no dependencies" for
    // it would be a measurement the caller cannot distinguish from a real empty.
    for (const ref of input.items) {
      const species = speciesFromRef(ref)
      const caps = capabilitiesForSpecies(this.capabilities, species)
      const readable = (["blocks", "blocked-by", "relates-to"] as const).some((kind) => caps.relations[kind]?.read === true)
      if (!readable) {
        return unsupported(
          `github.relations.${species}`,
          `${ref.workItem.key} is a ${species}, which has no dependency edges: ${
            this.capabilities.species?.[species]?.note ?? "no relations are readable for this species"
          }`
        )
      }
    }

    const dependencies: ProviderDependency[] = []
    const truncated: string[] = []
    for (const ref of input.items) {
      const result = await this.transport.execute({
        label: Q_NODE.label,
        document: Q_NODE.document,
        variables: { id: ref.workItem.id }
      })
      if (!result.ok) return result
      const node = (result.value.data as { node?: (RawIssue & { __typename?: string }) | null }).node
      if (node === null || node === undefined) return err("not-found", `unknown node ${ref.workItem.id}`)
      if (speciesFromTypename(node.__typename) !== GITHUB_SPECIES_ISSUE) {
        return unsupported("github.relations.unknown", `node ${ref.workItem.id} is not an issue`)
      }
      const extracted = dependenciesFromIssue(node)
      dependencies.push(...extracted.dependencies, ...extracted.subIssueEdges)
      truncated.push(...extracted.truncated)
    }
    return ok({
      items: dependencies,
      freshness: githubFreshness({ hasNextPage: false, truncated, fetchedAt: this.fetchedAt() })
    })
  }

  async listCriteria(): Promise<ProviderResult<Page<ProviderCriterion>>> {
    return unsupported(
      "github.criteria",
      "GitHub has no criteria object; body task-lists are a candidate surface, not one this adapter claims"
    )
  }

  async listComments(input: { item: ProviderItemRef; cursor?: string; first?: number }): Promise<ProviderResult<Page<ProviderComment>>> {
    const species = speciesFromRef(input.item)
    const caps = capabilitiesForSpecies(this.capabilities, species)
    if (!caps.comments.read) {
      return unsupported(
        `github.comments.${species}`,
        `${input.item.workItem.key} is a ${species}: ${this.capabilities.species?.[species]?.note ?? "comments are not readable for this species"}`
      )
    }
    const tooBig = this.rejectPageSize(input.first)
    if (tooBig) return tooBig
    const result = await this.transport.execute({
      label: Q_ISSUE_COMMENTS.label,
      document: Q_ISSUE_COMMENTS.document,
      variables: { id: input.item.workItem.id, first: input.first ?? DEFAULT_PAGE_SIZE, cursor: input.cursor ?? null }
    })
    if (!result.ok) return result
    const connection = (
      result.value.data as {
        node?: { comments?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: { id: string; body?: string; createdAt?: string; author?: { login?: string } | null }[] } } | null
      }
    ).node?.comments
    if (connection === undefined) return err("not-found", `no comments for ${input.item.workItem.id}`)
    const hasNext = connection.pageInfo?.hasNextPage === true
    return ok({
      items: (connection.nodes ?? []).map((comment) => ({
        id: comment.id,
        item: input.item,
        body: comment.body ?? "",
        ...(comment.author?.login ? { author: comment.author.login } : {}),
        createdAt: comment.createdAt ?? ""
      })),
      ...(hasNext && connection.pageInfo?.endCursor ? { nextCursor: connection.pageInfo.endCursor } : {}),
      freshness: githubFreshness({ hasNextPage: hasNext, fetchedAt: this.fetchedAt() })
    })
  }

  async timeline(input: { item: ProviderItemRef; cursor?: string; since?: string }): Promise<ProviderResult<Page<ProviderTimelineEvent>>> {
    const species = speciesFromRef(input.item)
    const caps = capabilitiesForSpecies(this.capabilities, species)
    if (!caps.timeline.read) {
      return unsupported(
        `github.timeline.${species}`,
        `${input.item.workItem.key} is a ${species}: ${this.capabilities.species?.[species]?.note ?? "no timeline is readable for this species"}`
      )
    }
    const result = await this.transport.execute({
      label: Q_ISSUE_TIMELINE.label,
      document: Q_ISSUE_TIMELINE.document,
      variables: { id: input.item.workItem.id, first: DEFAULT_PAGE_SIZE, cursor: input.cursor ?? null }
    })
    if (!result.ok) return result
    const connection = (
      result.value.data as {
        node?: { timelineItems?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: RawTimelineNode[] } } | null
      }
    ).node?.timelineItems
    if (connection === undefined) return err("not-found", `no timeline for ${input.item.workItem.id}`)
    const hasNext = connection.pageInfo?.hasNextPage === true
    const events: ProviderTimelineEvent[] = []
    for (const node of connection.nodes ?? []) {
      if (node?.id === undefined || node.createdAt === undefined) continue
      if (input.since !== undefined && node.createdAt <= input.since) continue
      events.push({
        id: node.id,
        item: input.item,
        occurredAt: node.createdAt,
        ...(node.actor?.login ?? node.author?.login ? { actor: (node.actor?.login ?? node.author?.login) as string } : {}),
        kind: timelineKind(node.__typename),
        payload: { githubType: node.__typename ?? "unknown" }
      })
    }
    return ok({
      items: events,
      ...(hasNext && connection.pageInfo?.endCursor ? { nextCursor: connection.pageInfo.endCursor } : {}),
      freshness: githubFreshness({ hasNextPage: hasNext, fetchedAt: this.fetchedAt() })
    })
  }

  async rateLimit(): Promise<ProviderResult<ProviderRateLimit>> {
    const cached = this.transport.lastRateLimit()
    const result = await this.transport.execute({
      label: Q_RATE_LIMIT.label,
      document: Q_RATE_LIMIT.document,
      variables: {}
    })
    if (result.ok && result.value.rateLimit !== undefined) return ok(result.value.rateLimit)
    // A reading from the last successful call is still a real measurement, and
    // better than refusing when the balance is exactly what the caller needs.
    if (cached !== undefined) return ok(cached)
    return result.ok ? err("transient", "the provider returned no rateLimit block") : result
  }

  // ---- writes: refused, with the reason -----------------------------------

  async setProjectField(_input: SetProjectFieldInput): Promise<ProviderResult<ProviderProject>> {
    return unsupported("github.setProjectField", READ_ONLY_NOTE)
  }

  async createItem(_input: CreateItemInput): Promise<ProviderResult<ProviderItem>> {
    return unsupported("github.lifecycle.create", READ_ONLY_NOTE)
  }

  async closeOrReopen(_input: CloseOrReopenInput): Promise<ProviderResult<ProviderItem>> {
    return unsupported("github.lifecycle.closeOrReopen", READ_ONLY_NOTE)
  }

  /**
   * No GraphQL mutation for dependencies exists at all (measured, T-135): the
   * surface has `addSubIssue`, `removeSubIssue` and `reprioritizeSubIssue` and
   * nothing else for relations. The REST endpoints are a candidate T-152 must
   * validate against a writable repository before this can change.
   */
  async addDependency(_input: DependencyWriteInput): Promise<ProviderResult<ProviderDependency>> {
    return unsupported("github.relations.write", DEPENDENCY_WRITE_NOTE)
  }

  async removeDependency(_input: DependencyWriteInput): Promise<ProviderResult<void>> {
    return unsupported("github.relations.write", DEPENDENCY_WRITE_NOTE)
  }

  async setField(input: FieldWrite & WriteOptions): Promise<ProviderResult<FieldWriteOutcome>> {
    if (input.precondition !== undefined) {
      return unsupported(
        "github.preconditions.revision",
        "GitHub has no write precondition: UpdateProjectV2ItemFieldValueInput takes no expected revision, and dropping one silently would tell the caller its write was guarded"
      )
    }
    return unsupported(`github.fields.${input.field.semantic}.write`, READ_ONLY_NOTE)
  }

  async applyFieldWrites(
    input: { writes: readonly FieldWrite[] } & WriteOptions
  ): Promise<ProviderResult<BatchOutcome>> {
    // Empty first: an empty batch is a caller mistake whichever provider it is.
    if (input.writes.length === 0) return err("invalid", "an empty batch has nothing to apply")
    if (input.precondition !== undefined) {
      return unsupported("github.preconditions.revision", "GitHub has no write precondition")
    }
    return unsupported("github.fields.write", READ_ONLY_NOTE)
  }

  async setCriterionState(_input: SetCriterionStateInput): Promise<ProviderResult<ProviderCriterion>> {
    return unsupported("github.criteria", "GitHub has no criteria object to set state on")
  }

  async addComment(_input: AddCommentInput): Promise<ProviderResult<{ commentId: string; revision?: string }>> {
    return unsupported("github.comments.write", READ_ONLY_NOTE)
  }
}

const READ_ONLY_NOTE =
  "this adapter is read-only (T-150); the write path is T-152, which must first validate it against a writable repository"

const DEPENDENCY_WRITE_NOTE =
  "GitHub has no GraphQL mutation for issue dependencies (T-135); the REST endpoints are unvalidated, so this stays unsupported rather than becoming a silent no-op"

type RawTimelineNode = {
  __typename?: string
  id?: string
  createdAt?: string
  actor?: { login?: string } | null
  author?: { login?: string } | null
}

function timelineKind(typename: string | undefined): ProviderTimelineEvent["kind"] {
  if (typename === "IssueComment") return "comment"
  if (typename === "ParentIssueAddedEvent" || typename === "SubIssueAddedEvent") return "relation-changed"
  if (typename === undefined) return "field-changed"
  // Closed, reopened, labeled, assigned, renamed, milestoned are all a field
  // changing; the GitHub type travels in the payload so nothing is lost.
  return "field-changed"
}
