/**
 * `LocalStoreProvider` — the SQLite store behind the `TaskProvider` contract.
 *
 * ADR 0005's operator direction keeps the store as a first-class local
 * provider for solo and offline work, so it is not a stub: reads are complete,
 * and writes go through the store's own operations (`tasks.ts`,
 * `acceptance.ts`) with their gates intact. This provider never reaches into
 * the schema behind those functions, because the gates are the point — the
 * `done` transition checks acceptance, and bypassing it to satisfy an
 * interface would make the contract a way around the store's own rules.
 *
 * Where the store genuinely cannot do something it returns `unsupported` and
 * says so in `capabilities`. The two must agree, and the contract suite checks
 * that they do. Pretending — accepting a write and dropping it, or reporting a
 * capability the store lacks — is the failure this class is written to avoid.
 */

import {
  approveAcceptanceCriterion,
  createTask,
  getAcceptance,
  getTask,
  getTaskDetail,
  listDependencies,
  listTasks,
  moveTask,
  reopenTask,
  unapproveAcceptanceCriterion,
  updateTask,
  type StoreHandle,
  type TaskDetailRecord,
  type TaskRecord
} from "@mapctx/store"

import { err, ok, page, preconditionUnsupported, skippedOutcome, summariseBatch, unsupported } from "./results"
import type {
  AddCommentInput,
  ProviderError,
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
  ProviderItem,
  ProviderItemRef,
  ProviderOwnedField,
  ProviderProject,
  ProviderResult,
  ProviderTimelineEvent,
  SetCriterionStateInput,
  SetProjectFieldInput,
  TaskProvider,
  WriteOptions
} from "./types"

/** Task-record fields the store's `updateTask` patch accepts, by contract name. */
const TASK_PATCH_FIELD: Partial<Record<ProviderOwnedField, keyof TaskRecord>> = {
  title: "title",
  type: "type",
  parent: "parentTaskId",
  priority: "priority",
  tags: "tags",
  startDate: "startDate",
  dueDate: "dueDate",
  iteration: "iteration",
  assignees: "assignees",
  milestone: "milestone"
}

/** Detail-record fields the store's `updateTask` detailPatch accepts. */
const DETAIL_PATCH_FIELD: Partial<Record<ProviderOwnedField, keyof TaskDetailRecord>> = {
  summary: "summary",
  role: "role",
  impact: "impact"
}

const DEFAULT_PAGE_SIZE = 100

/**
 * Fields `createTask` can carry in the creating transaction.
 *
 * Deliberately smaller than the set of writable fields: `iteration`,
 * `assignees` and `milestone` are patchable later but have no `createTask`
 * parameter, so accepting them at creation would mean discarding them.
 */
const CREATE_SETTABLE_FIELDS = new Set<ProviderOwnedField>([
  "title",
  "type",
  "parent",
  "planningState",
  "priority",
  "tags",
  "startDate",
  "dueDate",
  "summary",
  "role",
  "impact"
])

/** Planning states that mean the item is closed, for `includeClosed: false`. */
const CLOSED_PLANNING_STATES = new Set(["done", "cancelled", "archived"])

export const LOCAL_STORE_CAPABILITIES: ProviderCapabilities = {
  fields: {
    // Writable through updateTask's whitelist. A store write is a journalled
    // event, so re-writing the same value is NOT a no-op: it records that the
    // board was told again, which is information the event log should keep.
    title: { read: true, write: true, idempotentRewrite: false },
    type: { read: true, write: true, idempotentRewrite: false },
    parent: { read: true, write: true, idempotentRewrite: false },
    priority: { read: true, write: true, idempotentRewrite: false },
    tags: { read: true, write: true, idempotentRewrite: false },
    startDate: { read: true, write: true, idempotentRewrite: false },
    dueDate: { read: true, write: true, idempotentRewrite: false },
    iteration: { read: true, write: true, idempotentRewrite: false },
    assignees: { read: true, write: true, idempotentRewrite: false },
    milestone: { read: true, write: true, idempotentRewrite: false },
    summary: { read: true, write: true, idempotentRewrite: false },
    role: { read: true, write: true, idempotentRewrite: false },
    impact: { read: true, write: true, idempotentRewrite: false },
    // Only a legal transition can move it, so the write can be refused for a
    // reason the schema does not express: an illegal hop, or the `done` gate
    // finding unapproved acceptance.
    planningState: { read: true, write: true, discoveredAtWrite: true, idempotentRewrite: false },
    // The description prose stays Git-authored (ADR 0003/0004): the store holds
    // only `descriptionGitHash`, so it can neither return the body nor write it.
    body: { read: false, write: false },
    // Stamped by the `done` gate, never set directly. A provider that let a
    // caller write it would be inventing a completion date.
    completedOn: { read: true, write: false }
  },
  relations: {
    // Both map onto the store's dependency edges, but as a read-modify-write of
    // the whole edge set, since `updateTask` replaces rather than appends.
    "blocked-by": { read: true, write: true },
    blocks: { read: true, write: true },
    // The store has no undirected relation kind. Nothing to map it onto.
    "relates-to": { read: false, write: false }
  },
  comments: { read: false, write: false },
  criteria: { read: true, write: true },
  // The event log exists, but there is no per-task projection of it, so there
  // is nothing to page over without reaching past the public surface.
  timeline: { read: false },
  lifecycle: { create: true, closeOrReopen: true },
  // `updateTask` takes no expected revision. The store's acceptance revision is
  // a different concept and is used internally by setCriterionState; exposing
  // it as a general write precondition would promise more than it covers.
  preconditions: { revision: false },
  batch: { singleOperation: false, atomic: false }
}

export type LocalStoreProviderOptions = {
  store: StoreHandle
  actor: string
  /** Identifier reported as the project id; defaults to the store directory. */
  projectId?: string
  now?: () => Date
}

function refFor(taskId: string): ProviderItemRef {
  return { provider: "local", workItem: { id: taskId, key: taskId } }
}

/**
 * The revision marker reported for a local item.
 *
 * `updatedOn` is a date, so two edits on the same day are indistinguishable.
 * That is acceptable only because this provider declares
 * `preconditions.revision: false` — nothing may use this value for
 * compare-and-swap, and the refusal in `preconditionUnsupported` is what keeps
 * a caller from trying. A finer marker exists in the projection's event
 * sequence, but reading it means reaching past the store's public API into its
 * schema, which this provider does not do.
 */
function revisionFor(task: TaskRecord): string {
  return task.updatedOn ?? "0"
}

function itemFor(task: TaskRecord, detail: TaskDetailRecord | undefined): ProviderItem {
  return {
    ref: refFor(task.taskId),
    revision: revisionFor(task),
    fields: {
      title: task.title,
      planningState: task.planningState,
      type: task.type ?? null,
      parent: task.parentTaskId ?? null,
      priority: task.priority ?? null,
      tags: task.tags,
      startDate: task.startDate ?? null,
      dueDate: task.dueDate ?? null,
      completedOn: task.completedOn ?? null,
      iteration: task.iteration ?? null,
      assignees: task.assignees,
      milestone: task.milestone ?? null,
      summary: detail?.summary ?? null,
      role: detail?.role ?? null,
      impact: detail?.impact ?? null
    }
  }
}

/**
 * Store write failures mapped onto contract errors.
 *
 * `unknown-task` and `unknown-dependency` are `not-found`. Everything the store
 * rejects for a reason a caller could fix by sending something else is
 * `invalid`. The two gate refusals -- an illegal transition and incomplete
 * acceptance -- are `conflict`: the request is well-formed and the board's
 * current state is what refuses it.
 */
function storeFailureError(reason: string, message?: string): ProviderError {
  const text = message ?? reason
  if (reason === "unknown-task" || reason === "unknown-dependency" || reason === "unknown-parent" || reason === "unknown-criterion") {
    return { kind: "not-found", message: text, retryable: false }
  }
  if (
    reason === "illegal-transition" ||
    reason === "acceptance-incomplete" ||
    reason === "unknown-state" ||
    reason === "revision-conflict"
  ) {
    return { kind: "conflict", message: text, retryable: false }
  }
  return { kind: "invalid", message: text, retryable: false }
}

function storeFailureToError(reason: string, message?: string): ProviderResult<never> {
  return { ok: false, error: storeFailureError(reason, message) }
}

export class LocalStoreProvider implements TaskProvider {
  readonly kind = "local" as const
  readonly capabilities = LOCAL_STORE_CAPABILITIES

  private readonly store: StoreHandle
  private readonly actor: string
  private readonly projectId: string
  private readonly now: () => Date

  constructor(options: LocalStoreProviderOptions) {
    this.store = options.store
    this.actor = options.actor
    this.projectId = options.projectId ?? options.store.storeDir
    this.now = options.now ?? (() => new Date())
  }

  // ---- reads ------------------------------------------------------------

  async listItems(input: ListItemsInput): Promise<ProviderResult<Page<ProviderItem>>> {
    if (input.project !== this.projectId) {
      return err("not-found", `this provider serves project ${this.projectId}, not ${input.project}`)
    }
    const all = listTasks(this.store.db)
      .filter((task) => (input.includeClosed === false ? !CLOSED_PLANNING_STATES.has(task.planningState) : true))
      .filter((task) => (input.updatedAfter === undefined ? true : (task.updatedOn ?? "") > input.updatedAfter))
      .sort((a, b) => a.positionKey - b.positionKey || a.taskId.localeCompare(b.taskId))

    const size = input.first ?? DEFAULT_PAGE_SIZE
    // The cursor is the taskId after which to resume: stable under insertion,
    // unlike an offset, and meaningless to the caller by design.
    const start = input.cursor === undefined ? 0 : all.findIndex((task) => task.taskId === input.cursor) + 1
    if (input.cursor !== undefined && start === 0) {
      return err("invalid", `unknown cursor ${input.cursor}`)
    }
    const slice = all.slice(start, start + size)
    const last = slice[slice.length - 1]
    const more = start + slice.length < all.length
    const items = slice.map((task) => itemFor(task, getTaskDetail(this.store.db, task.taskId)))
    return ok(page(items, more && last ? last.taskId : undefined))
  }

  async getItem(input: { ref: ProviderItemRef }): Promise<ProviderResult<ProviderItem>> {
    const task = getTask(this.store.db, input.ref.workItem.id)
    if (!task) return err("not-found", `unknown task ${input.ref.workItem.id}`)
    return ok(itemFor(task, getTaskDetail(this.store.db, task.taskId)))
  }

  async getProject(input: { project: string }): Promise<ProviderResult<ProviderProject>> {
    if (input.project !== this.projectId) {
      return err("not-found", `this provider serves project ${this.projectId}, not ${input.project}`)
    }
    return ok({ id: this.projectId })
  }

  async getDependencies(input: {
    items: readonly ProviderItemRef[]
  }): Promise<ProviderResult<Page<ProviderDependency>>> {
    const wanted = new Set(input.items.map((ref) => ref.workItem.id))
    const edges = listDependencies(this.store.db)
      .filter((edge) => wanted.has(edge.fromTaskId) || wanted.has(edge.toTaskId))
      .map<ProviderDependency>((edge) => ({
        from: refFor(edge.fromTaskId),
        to: refFor(edge.toTaskId),
        // The store says "A depends-on B"; the contract says "A blocked-by B".
        // Same edge, same direction, different vocabulary.
        kind: edge.kind === "depends-on" ? "blocked-by" : "blocks"
      }))
      .sort((a, b) =>
        a.from.workItem.id.localeCompare(b.from.workItem.id) ||
        a.to.workItem.id.localeCompare(b.to.workItem.id) ||
        a.kind.localeCompare(b.kind)
      )
    return ok(page(edges))
  }

  async listCriteria(input: {
    item: ProviderItemRef
    cursor?: string
    first?: number
  }): Promise<ProviderResult<Page<ProviderCriterion>>> {
    const taskId = input.item.workItem.id
    if (!getTask(this.store.db, taskId)) return err("not-found", `unknown task ${taskId}`)
    const acceptance = getAcceptance(this.store.db, taskId)
    const criteria = (acceptance?.criteria ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map<ProviderCriterion>((criterion) => ({
        id: criterion.criterionId,
        item: input.item,
        text: criterion.text,
        state: criterion.state === "approved" ? "complete" : "pending",
        position: criterion.position,
        revision: String(criterion.revision)
      }))

    const size = input.first ?? DEFAULT_PAGE_SIZE
    const start = input.cursor === undefined ? 0 : criteria.findIndex((c) => c.id === input.cursor) + 1
    if (input.cursor !== undefined && start === 0) return err("invalid", `unknown cursor ${input.cursor}`)
    const slice = criteria.slice(start, start + size)
    const last = slice[slice.length - 1]
    const more = start + slice.length < criteria.length
    return ok(page(slice, more && last ? last.id : undefined))
  }

  async listComments(): Promise<ProviderResult<Page<ProviderComment>>> {
    return unsupported("comments.read", "the store has no comment surface")
  }

  async timeline(): Promise<ProviderResult<Page<ProviderTimelineEvent>>> {
    return unsupported("timeline.read", "the store's event log has no per-task projection to page over")
  }

  // ---- writes -----------------------------------------------------------

  async setProjectField(_input: SetProjectFieldInput): Promise<ProviderResult<ProviderProject>> {
    return unsupported("setProjectField", "the store has no project title or notes")
  }

  async createItem(input: CreateItemInput): Promise<ProviderResult<ProviderItem>> {
    if (input.precondition) return preconditionUnsupported()
    if (input.project !== this.projectId) {
      return err("not-found", `this provider serves project ${this.projectId}, not ${input.project}`)
    }
    const fields = input.initialFields
    const title = fields.title
    if (typeof title !== "string" || title.trim() === "") {
      return err("invalid", "createItem needs a non-empty title")
    }
    // `createTask` carries a narrower set of fields than `updateTask` accepts,
    // so a field that is writable in general is not necessarily settable AT
    // CREATION. Anything outside the set is refused rather than dropped: a
    // create that returns ok while quietly discarding `iteration` is the
    // accept-and-drop lie this contract exists to prevent, and the caller can
    // follow the create with setField.
    const unsupportedField = (Object.keys(fields) as ProviderOwnedField[]).find(
      (field) => !CREATE_SETTABLE_FIELDS.has(field)
    )
    if (unsupportedField) {
      return unsupported(
        `createItem.initialFields.${unsupportedField}`,
        `the store cannot set ${unsupportedField} at creation; create the item and then write the field`
      )
    }

    const created = createTask(this.store, {
      title,
      type: typeof fields.type === "string" ? fields.type : undefined,
      parent: typeof fields.parent === "string" ? fields.parent : undefined,
      status: typeof fields.planningState === "string" ? fields.planningState : undefined,
      priority: typeof fields.priority === "string" ? fields.priority : undefined,
      tags: Array.isArray(fields.tags) ? (fields.tags as string[]) : undefined,
      startDate: typeof fields.startDate === "string" ? fields.startDate : undefined,
      dueDate: typeof fields.dueDate === "string" ? fields.dueDate : undefined,
      detail: {
        ...(typeof fields.summary === "string" ? { summary: fields.summary } : {}),
        ...(typeof fields.role === "string" ? { role: fields.role } : {}),
        ...(typeof fields.impact === "string" ? { impact: fields.impact } : {})
      },
      actor: this.actor,
      now: this.now
    })
    if (!created.ok) return storeFailureToError(created.reason, created.message)
    const task = getTask(this.store.db, created.taskId)
    if (!task) return err("transient", `created ${created.taskId} but could not read it back`)
    return ok(itemFor(task, getTaskDetail(this.store.db, created.taskId)))
  }

  async closeOrReopen(input: CloseOrReopenInput): Promise<ProviderResult<ProviderItem>> {
    if (input.precondition) return preconditionUnsupported()
    const taskId = input.item.workItem.id
    if (!getTask(this.store.db, taskId)) return err("not-found", `unknown task ${taskId}`)

    if (input.state === "closed") {
      const to = input.reason === "cancelled" ? "cancelled" : input.reason === "archived" ? "archived" : "done"
      const moved = moveTask(this.store, { taskId, to, actor: this.actor, now: this.now })
      if (!moved.ok) return storeFailureToError(moved.reason, moved.message)
    } else {
      // Reopen is its own store operation: it clears completedOn and journals
      // an audit event, which a plain move out of a terminal state cannot do.
      const reopened = reopenTask(this.store, { taskId, to: "review", actor: this.actor, now: this.now })
      if (!reopened.ok) return storeFailureToError(reopened.reason, reopened.message)
    }
    const task = getTask(this.store.db, taskId)
    if (!task) return err("transient", `moved ${taskId} but could not read it back`)
    return ok(itemFor(task, getTaskDetail(this.store.db, taskId)))
  }

  async setField(input: FieldWrite & WriteOptions): Promise<ProviderResult<FieldWriteOutcome>> {
    if (input.precondition) return preconditionUnsupported()
    const single = await this.applyFieldWrites({
      writes: [{ item: input.item, field: input.field, value: input.value }],
      clientOperationId: input.clientOperationId
    })
    if (!single.ok) return single
    const outcome = single.value.outcomes[0]
    if (!outcome) return err("transient", "batch returned no outcome for a single write")
    // A single write reports its own failure as a failed result, not as a
    // successful batch containing a failure: callers of setField expect the
    // error at the top level.
    if (outcome.status === "failed" || outcome.status === "unknown") return { ok: false, error: outcome.error }
    if (outcome.status === "skipped") return err("transient", "single-write batch reported its only write as skipped")
    return ok(outcome)
  }

  /**
   * Sequential emulation, declared as such (`batch.singleOperation: false`).
   *
   * It stops at the first failure rather than pressing on: the store is
   * transactional per operation, so continuing would widen a partial
   * application for no gain. The outcomes already applied are returned with
   * `partiallyApplied` set, which is the signal to read back rather than
   * resend.
   *
   * Every submitted write gets an outcome, including the ones never attempted,
   * which are reported as `skipped`. Shortening the array would make the
   * caller infer what happened from its length, and that inference differs by
   * provider — GitHub applies every valid alias and fails at the top, which is
   * the opposite shape from stopping at the first failure.
   */
  async applyFieldWrites(
    input: { writes: readonly FieldWrite[] } & WriteOptions
  ): Promise<ProviderResult<BatchOutcome>> {
    if (input.precondition) return preconditionUnsupported()
    if (input.writes.length === 0) return err("invalid", "applyFieldWrites needs at least one write")

    const outcomes: FieldWriteOutcome[] = []
    let stopped = false
    for (const write of input.writes) {
      if (stopped) {
        outcomes.push(skippedOutcome(write))
        continue
      }
      const outcome = this.applyOne(write)
      outcomes.push(outcome)
      if (outcome.status === "failed" || outcome.status === "unknown") stopped = true
    }
    // `verified: false` is the truth here: the store's own write result is
    // trusted, and nothing is read back. A provider that sets this true owes
    // the caller an actual re-read.
    return ok(summariseBatch(outcomes, false))
  }

  private applyOne(write: FieldWrite): FieldWriteOutcome {
    const taskId = write.item.workItem.id
    const semantic = write.field.semantic

    if (write.field.surface === "project-item") {
      return {
        status: "failed",
        write,
        error: {
          kind: "unsupported",
          message: "the store has no board-item surface; every field lives on the task itself",
          retryable: false,
          capability: "FieldRef.surface=project-item"
        }
      }
    }
    if (!getTask(this.store.db, taskId)) {
      return { status: "failed", write, error: { kind: "not-found", message: `unknown task ${taskId}`, retryable: false } }
    }
    if (this.capabilities.fields[semantic]?.write !== true) {
      return {
        status: "failed",
        write,
        error: {
          kind: "unsupported",
          message: `the store does not accept writes to ${semantic}`,
          retryable: false,
          capability: `fields.${semantic}.write`
        }
      }
    }

    if (semantic === "planningState") {
      if (typeof write.value !== "string") {
        return { status: "failed", write, error: { kind: "invalid", message: "planningState must be a string", retryable: false } }
      }
      const moved = moveTask(this.store, { taskId, to: write.value, actor: this.actor, now: this.now })
      if (!moved.ok) {
        return { status: "failed", write, error: storeFailureError(moved.reason, moved.message) }
      }
      const task = getTask(this.store.db, taskId)
      return { status: "applied", write, ...(task ? { revision: revisionFor(task) } : {}) }
    }

    const taskField = TASK_PATCH_FIELD[semantic]
    const detailField = DETAIL_PATCH_FIELD[semantic]
    // A field declared writable that neither patch map knows how to route is a
    // capability record that has drifted from the code. Refusing says so;
    // building a patch around an undefined key would write to a field named
    // "undefined" and report success.
    if (taskField === undefined && detailField === undefined) {
      return {
        status: "failed",
        write,
        error: {
          kind: "unsupported",
          message: `${semantic} is declared writable but has no store mapping; the capability record is wrong`,
          retryable: false,
          capability: `fields.${semantic}.write`
        }
      }
    }
    const options =
      taskField !== undefined
        ? { taskId, patch: { [taskField]: write.value } as Partial<TaskRecord>, actor: this.actor, now: this.now }
        : { taskId, detailPatch: { [detailField as keyof TaskDetailRecord]: write.value } as Partial<TaskDetailRecord>, actor: this.actor, now: this.now }

    const updated = updateTask(this.store, options)
    if (!updated.ok) {
      // "no-changes" is the store declining to journal a no-op write. That is
      // not a failure: the field already holds this value.
      if (updated.reason === "no-changes") {
        const task = getTask(this.store.db, taskId)
        return { status: "unchanged", write, ...(task ? { revision: revisionFor(task) } : {}) }
      }
      return { status: "failed", write, error: storeFailureError(updated.reason, updated.message) }
    }
    const task = getTask(this.store.db, taskId)
    const cleared = write.value === null || write.value === undefined
    return { status: cleared ? "cleared" : "applied", write, ...(task ? { revision: revisionFor(task) } : {}) }
  }

  async addDependency(input: DependencyWriteInput): Promise<ProviderResult<ProviderDependency>> {
    return this.writeDependency(input, "add")
  }

  async removeDependency(input: DependencyWriteInput): Promise<ProviderResult<void>> {
    const result = await this.writeDependency(input, "remove")
    return result.ok ? ok(undefined) : result
  }

  /**
   * Read-modify-write over the whole edge set.
   *
   * `updateTask` replaces a task's `dependsOn`/`blocking` lists rather than
   * appending, so adding one edge means reading the current list, changing it,
   * and writing it back. That is a lost-update window the store offers no
   * precondition to close, and it is exactly why
   * `capabilities.preconditions.revision` is false rather than quietly true.
   *
   * Both lists are always sent, even when only one changed. The store rebuilds
   * a task's edges from whichever lists the patch carries and drops the other
   * kind, so sending `dependsOn` alone would silently delete every `blocks`
   * edge the task had. One edge added, the rest preserved explicitly.
   */
  private async writeDependency(
    input: DependencyWriteInput,
    mode: "add" | "remove"
  ): Promise<ProviderResult<ProviderDependency>> {
    if (input.precondition) return preconditionUnsupported()
    if (this.capabilities.relations[input.kind]?.write !== true) {
      return unsupported(`relations.${input.kind}.write`, `the store has no ${input.kind} relation`)
    }
    const fromId = input.from.workItem.id
    const toId = input.to.workItem.id
    if (fromId === toId) return err("invalid", "a task cannot depend on itself")

    const detail = getTaskDetail(this.store.db, fromId)
    if (!detail) return err("not-found", `unknown task ${fromId}`)
    if (!getTask(this.store.db, toId)) return err("not-found", `unknown task ${toId}`)

    const current = input.kind === "blocked-by" ? detail.prerequisites : detail.blocking
    const has = current.includes(toId)
    if (mode === "add" && has) {
      return ok({ from: input.from, to: input.to, kind: input.kind })
    }
    if (mode === "remove" && !has) {
      return err("not-found", `${fromId} has no ${input.kind} edge to ${toId}`)
    }
    const next = mode === "add" ? [...current, toId].sort() : current.filter((id) => id !== toId)

    const updated = updateTask(this.store, {
      taskId: fromId,
      dependsOn: input.kind === "blocked-by" ? next : [...detail.prerequisites],
      blocking: input.kind === "blocked-by" ? [...detail.blocking] : next,
      actor: this.actor,
      now: this.now
    })
    if (!updated.ok) return storeFailureToError(updated.reason, updated.message)
    return ok({ from: input.from, to: input.to, kind: input.kind })
  }

  async setCriterionState(input: SetCriterionStateInput): Promise<ProviderResult<ProviderCriterion>> {
    if (input.precondition) return preconditionUnsupported()
    const taskId = input.criterion.item.workItem.id
    const acceptance = getAcceptance(this.store.db, taskId)
    if (!acceptance) return err("not-found", `task ${taskId} has no acceptance revision`)
    const target = acceptance.criteria.find((c) => c.criterionId === input.criterion.id)
    if (!target) return err("not-found", `unknown criterion ${input.criterion.id} on ${taskId}`)

    // The store's acceptance revision is read here rather than taken from the
    // caller: it is the store's own concurrency check, not the general write
    // precondition this provider declares it lacks.
    const common = { taskId, criterionId: target.criterionId, actor: this.actor, expectRevision: acceptance.revision, now: this.now }
    const result =
      input.state === "complete"
        ? approveAcceptanceCriterion(this.store, common)
        : unapproveAcceptanceCriterion(this.store, common)
    // The store refuses a redundant approve/unapprove by name. The requested
    // end state already holds, so reporting an error would make an idempotent
    // call look like a failure.
    const redundant = !result.ok && (result.reason === "already-approved" || result.reason === "not-approved")
    if (!result.ok && !redundant) return storeFailureToError(result.reason, result.message)

    const after = getAcceptance(this.store.db, taskId)
    const updated = after?.criteria.find((c) => c.criterionId === target.criterionId)
    return ok({
      id: target.criterionId,
      item: input.criterion.item,
      text: updated?.text ?? target.text,
      state: (updated?.state ?? target.state) === "approved" ? "complete" : "pending",
      position: updated?.position ?? target.position,
      revision: String(after?.revision ?? acceptance.revision)
    })
  }

  async addComment(_input: AddCommentInput): Promise<ProviderResult<{ commentId: string; revision?: string }>> {
    return unsupported("comments.write", "the store has no comment surface")
  }
}
