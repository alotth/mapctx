import * as crypto from "crypto"
import { parseEstimatedEffortMs, predictedStartSchema, STATUS_TO_PLANNING, transitionPlanning, workloadSchema } from "@mapctx/protocol"
import { getAcceptance, getActiveClaimForTask, getTask, getTaskDetail } from "./projections"
import type { StoreHandle } from "./store-handle"
import type { DependencyRecord, TaskDetailRecord, TaskRecord } from "./types"

/**
 * Planning states the canonical Markdown export can represent. `blocked` has
 * no TASKS.md status vocabulary yet (STATUS_TO_PLANNING only maps six board
 * statuses), so moving there would make the store unexportable and the drift
 * check would fail closed on every subsequent validate. Rejected here,
 * fail-early, until the board vocabulary grows.
 */
const EXPORTABLE_PLANNING_STATES = new Set(["backlog", "ready", "in-progress", "review", "done", "paused", "cancelled", "archived"]);

export type MoveTaskOptions = {
  taskId: string;
  to: string;
  actor: string;
  now?: () => Date;
};

export type MoveTaskResult =
  | { ok: true; from: string; to: string; releasedClaimId?: string }
  | {
      ok: false;
      reason: "unknown-task" | "illegal-transition" | "unknown-state" | "state-not-exportable" | "acceptance-incomplete";
      from?: string;
      to: string;
      message?: string;
    };

/**
 * Planning-state transition under store authority. The board `status:` field
 * is generated output, so this is the honest way to change it: a legal
 * transition recorded as an event. The `done` gate reads the canonical
 * acceptance revision from the store (T-120) -- never the markdown mirror.
 * Terminal states have no outgoing edges by design --
 * reopening is a reconcile decision, never a silent move.
 */
export function moveTask(store: StoreHandle, options: MoveTaskOptions): MoveTaskResult {
  const now = options.now ?? (() => new Date());

  return store.runInWriteTransaction(append => {
    const task = getTask(store.db, options.taskId);
    if (!task) return { ok: false, reason: "unknown-task", to: options.to };

    if (!EXPORTABLE_PLANNING_STATES.has(options.to)) {
      return {
        ok: false,
        reason: "state-not-exportable",
        from: task.planningState,
        to: options.to,
        message: `planningState "${options.to}" has no TASKS.md status mapping; the board vocabulary must grow before this state is movable.`
      };
    }

    const transition = transitionPlanning(task.planningState as never, options.to as never);
    if (!transition.ok) {
      return {
        ok: false,
        reason: transition.reason === "unknown-state" ? "unknown-state" : "illegal-transition",
        from: task.planningState,
        to: options.to,
        message: `${task.planningState} -> ${options.to} is not a legal planning transition.`
      };
    }

    if (options.to === "done") {
      const acceptance = acceptanceGate(store.db, options.taskId, task.planningState);
      if (!acceptance.ok) return acceptance;
    }

    let releasedClaimId: string | undefined;
    if (options.to === "done" || options.to === "cancelled" || options.to === "archived") {
      const active = getActiveClaimForTask(store.db, options.taskId);
      if (active) {
        append({
          eventType: "task.claim-released",
          actor: options.actor,
          occurredAt: now().toISOString(),
          payload: { claimId: active.claimId, taskId: options.taskId }
        });
        releasedClaimId = active.claimId;
      }
    }

    const completedOn = options.to === "done" ? now().toISOString().slice(0, 10) : undefined;
    append({
      eventType: "task.patched",
      actor: options.actor,
      occurredAt: now().toISOString(),
      payload: {
        taskId: options.taskId,
        patch: {
          planningState: options.to,
          updatedOn: now().toISOString().slice(0, 10),
          ...(completedOn ? { completedOn } : {})
        },
        source: options.actor
      }
    });

    return { ok: true, from: task.planningState, to: options.to, releasedClaimId };
  });
}

export type ReopenTaskOptions = {
  taskId: string;
  to: string;
  actor: string;
  now?: () => Date;
};

export type ReopenTaskResult =
  | { ok: true; from: "done" | "cancelled" | "archived"; to: "review" }
  | {
      ok: false;
      reason: "unknown-task" | "not-done" | "unsupported-target";
      from?: string;
      to: string;
      message?: string;
    };

/**
 * Reopens a completed, cancelled, or archived task through an explicit, auditable
 * exception to the terminal planning-state machine. Reopening only returns a
 * task to review; any completion date is cleared because the task is no longer
 * complete.
 */
export function reopenTask(store: StoreHandle, options: ReopenTaskOptions): ReopenTaskResult {
  const now = options.now ?? (() => new Date());

  return store.runInWriteTransaction(append => {
    const task = getTask(store.db, options.taskId);
    if (!task) return { ok: false, reason: "unknown-task", to: options.to };
    if (options.to !== "review") {
      return {
        ok: false,
        reason: "unsupported-target",
        from: task.planningState,
        to: options.to,
        message: `task reopen only supports target status "review".`
      };
    }
    if (task.planningState !== "done" && task.planningState !== "cancelled" && task.planningState !== "archived") {
      return {
        ok: false,
        reason: "not-done",
        from: task.planningState,
        to: options.to,
        message: `task ${options.taskId} is "${task.planningState}"; only done, cancelled or archived tasks can be reopened.`
      };
    }

    const nowDate = now();
    append({
      eventType: "task.patched",
      actor: options.actor,
      occurredAt: nowDate.toISOString(),
      payload: {
        taskId: options.taskId,
        patch: {
          planningState: "review",
          completedOn: null,
          updatedOn: nowDate.toISOString().slice(0, 10)
        },
        source: "task-reopen"
      }
    });

    return { ok: true, from: task.planningState, to: "review" };
  });
}

export type AcceptanceCheckResult =
  | { ok: true }
  | { ok: false; reason: "acceptance-incomplete"; message: string };

/**
 * T-120: the done gate reads ONLY the canonical acceptance revision in the
 * store. A missing revision (never imported / never revised), an empty
 * revision, or any pending criterion blocks `done`; the local markdown
 * mirror is never consulted and can never open the gate.
 */
export function checkTaskAcceptance(db: StoreHandle["db"], taskId: string): AcceptanceCheckResult {
  const acceptance = getAcceptance(db, taskId);
  if (!acceptance) {
    return {
      ok: false,
      reason: "acceptance-incomplete",
      message: `task ${taskId} cannot move to done: no acceptance revision exists in the store. Author one with \`mapctx task acceptance revise ${taskId} --from-file <detail.md>\`, then approve every criterion.`
    };
  }
  if (acceptance.condition === "empty" || acceptance.criteria.length === 0) {
    return {
      ok: false,
      reason: "acceptance-incomplete",
      message: `task ${taskId} cannot move to done: acceptance revision ${acceptance.revision} in the store is empty. Revise with criteria, then approve them.`
    };
  }
  const pending = acceptance.criteria.filter(criterion => criterion.state !== "approved").length;
  if (pending > 0) {
    return {
      ok: false,
      reason: "acceptance-incomplete",
      message: `task ${taskId} cannot move to done: ${pending} acceptance criterion/criteria are pending approval in the store. Approve with \`mapctx task acceptance approve ${taskId} --index <n>\`.`
    };
  }
  return { ok: true };
}

function acceptanceGate(db: StoreHandle["db"], taskId: string, planningState: string): { ok: true } | Extract<MoveTaskResult, { ok: false }> {
  const result = checkTaskAcceptance(db, taskId);
  if (result.ok) return result;
  return { ...result, from: planningState, to: "done" };
}

/**
 * Task fields a CLI caller may patch. taskId never changes, edges have their
 * own surface (dependsOn/blocking below), and status belongs to moveTask --
 * patching planningState directly would bypass the transition machine.
 */
const PATCHABLE_TASK_FIELDS = new Set([
  "title",
  "type",
  "parentTaskId",
  "priority",
  "workload",
  "tags",
  "domains",
  "startDate",
  "dueDate",
  "predictedStart",
  "externalId",
  "externalLinks",
  "specMode",
  "assignees",
  "iteration",
  "milestone"
]);

const PATCHABLE_DETAIL_FIELDS = new Set([
  "role",
  "impact",
  "estimatedEffort",
  "waitReason",
  "filesAffected",
  "testsRequired",
  "summary",
  "prerequisites",
  "blocking"
]);

/**
 * T-127 (R4): the unknown-field refusal used to list only the half of the
 * surface the caller happened to miss, so `--set filesAffected=a,b` answered
 * with the task-field list and never mentioned that the field exists behind
 * the `detail.` prefix. Both halves are always named now, and a field that
 * lives on the other side is called out by name.
 */
function unknownFieldMessage(field: string, side: "task" | "detail"): string {
  const taskFields = [...PATCHABLE_TASK_FIELDS].join(", ");
  const detailFields = [...PATCHABLE_DETAIL_FIELDS].join(", ");
  const hint = side === "task" && PATCHABLE_DETAIL_FIELDS.has(field)
    ? ` It is a detail field: use \`--set detail.${field}=...\`.`
    : side === "detail" && PATCHABLE_TASK_FIELDS.has(field)
      ? ` It is a task field: use \`--set ${field}=...\` without the \`detail.\` prefix.`
      : "";
  return `${side} field "${field}" is not patchable.${hint}`
    + ` Task fields: ${taskFields}.`
    + ` Detail fields (prefix each with \`detail.\`): ${detailFields}.`
    + ` \`waitReason\` is also accepted unprefixed as a shorthand for \`detail.waitReason\`.`
    + ` Prose lives in the Git-authored \`description:\` block of tasks/<ID>.md and is never patchable here.`;
}

/**
 * The `provider:entity:id` form the importer already derives external refs
 * from (import.ts externalRefFromId). The id tail may itself contain colons.
 */
/**
 * Review B6: matched case-insensitively, like the http(s) scheme already was.
 * `HTTPS://x/a` was accepted while `GitHub:issue:42` was refused, and nothing
 * documented the asymmetry.
 *
 * Review B7: this is deliberately a SHAPE, not a closed provider list --
 * `scheme:word:rest` -- which matches what the importer does with an unknown
 * provider (`externalRefFromId` maps it to "other"). The help and the skill
 * say so explicitly now, so a mistyped scheme is a documented pass-through
 * rather than a silent surprise.
 */
const PROVIDER_REF_RE = /^[a-z][a-z0-9-]*:[A-Za-z0-9_-]+:.+$/i;

/** Review B7: links are versioned content; 5 KB of URL was storable. */
const MAX_EXTERNAL_LINK_LENGTH = 2048;

/**
 * Schemes that must never be stored, even spelled as a three-part ref
 * (`javascript:a:b` matches the provider shape). `externalLinks` becomes
 * versioned content in TASKS.md and an `ExternalRefRecord` with the raw value
 * as its `uri`; nothing renders it today, so this is not a live XSS, but the
 * value is clickable the moment anything does. Review A4.
 */
const FORBIDDEN_LINK_SCHEMES = new Set(["javascript", "data", "file", "vbscript", "blob"]);

/**
 * T-127: `externalLinks` became CLI-patchable, so the store is the gate that
 * keeps the column holding URIs.
 *
 * Review A4: the first version only required *a* scheme plus `new URL()` not
 * throwing, which admits every opaque URL -- `javascript:alert(1)`,
 * `file:///etc/passwd`, `data:text/html,<script>` all parse. The help and the
 * skill promise "https://… or provider:entity:id", so that promise is now the
 * actual rule: an allowlisted http(s) URL with a host, or the three-part
 * provider ref, and never a dangerous scheme.
 */
function invalidExternalLink(value: unknown): string | null {
  const shape = "expected https://host/... (http is also accepted) or provider:entity:id";
  if (typeof value !== "string") return `every externalLinks entry must be a string; got ${JSON.stringify(value)}`;
  const trimmed = value.trim();
  if (trimmed === "") return "externalLinks entries cannot be blank";
  // Unreachable from the CLI, which trims each element in both spellings; it
  // guards programmatic callers of updateTask.
  if (trimmed !== value) return `externalLinks entry has surrounding whitespace: ${JSON.stringify(value)}`;
  if (/\s/.test(trimmed)) return `externalLinks entry contains whitespace: ${JSON.stringify(value)}`;
  if (trimmed.length > MAX_EXTERNAL_LINK_LENGTH) {
    return `externalLinks entry is ${trimmed.length} characters; the limit is ${MAX_EXTERNAL_LINK_LENGTH}. These links are versioned content, not a place for a payload.`;
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.\-]*):/.exec(trimmed)?.[1];
  if (!scheme) return `externalLinks entry needs an explicit URI scheme (${shape}): ${JSON.stringify(value)}`;
  if (FORBIDDEN_LINK_SCHEMES.has(scheme.toLowerCase())) {
    return `externalLinks entry uses the forbidden scheme "${scheme}": ${JSON.stringify(value)}. These links become versioned content and external refs, so only ${shape} is accepted.`;
  }
  if (scheme.toLowerCase() === "http" || scheme.toLowerCase() === "https") {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return `externalLinks entry is not a parseable URL: ${JSON.stringify(value)}`;
    }
    if (!url.hostname) return `externalLinks entry has no host: ${JSON.stringify(value)}`;
    // Review B5: credentials in a link would become versioned content in
    // TASKS.md and the `uri` of an ExternalRefRecord -- in a CLI whose own
    // help asks you to keep secrets out of the append-only log.
    if (url.username || url.password) {
      return `externalLinks entry carries userinfo credentials: ${JSON.stringify(value.replace(/\/\/[^@/]*@/, "//***@"))}. Strip the user:password and use a token out of band.`;
    }
    return null;
  }
  if (PROVIDER_REF_RE.test(trimmed) && !trimmed.includes("//")) return null;
  return `externalLinks entry is not an accepted URI (${shape}): ${JSON.stringify(value)}`;
}

/** List-valued fields whose elements end up in a comma-joined snapshot line. */
const SNAPSHOT_LIST_TASK_FIELDS = ["tags", "domains", "assignees", "externalLinks"] as const;
const SNAPSHOT_LIST_DETAIL_FIELDS = ["filesAffected", "testsRequired", "prerequisites", "blocking"] as const;

/**
 * Review A2, pushed down from the CLI to the store so EVERY caller is covered.
 *
 * `buildExport` renders these fields as `[a, b, c]` and `parseArray` reads
 * them back by splitting on ",". An element containing a comma therefore does
 * not survive the round trip: the store holds one value, the regenerated
 * snapshot parses as two, and the drift does not converge because
 * `reconcile --accept` would write the split value back into the store.
 *
 * Worth noting, because it looks like a contradiction and is not: for such a
 * state `checkStoreSnapshots` reports no drift while `reconcile`'s differ
 * reports drift. They ask different questions -- `checkDrift` byte-compares
 * the mirror against a fresh regeneration (which matches, the store wrote it),
 * while the reconcile differ compares PARSED mirror values against store
 * values (which differ). Neither is wrong; the defect was that `export` could
 * emit a line that does not parse back to its own input. Refusing the comma
 * here makes that unreachable, so the two can no longer disagree.
 */
function commaInListElement(fields: readonly string[], patch: Record<string, unknown> | undefined): string | null {
  for (const field of fields) {
    const value = patch?.[field];
    if (!Array.isArray(value)) continue;
    for (const element of value) {
      if (typeof element === "string" && element.includes(",")) {
        return `${field} element ${JSON.stringify(element)} contains a comma, which the generated snapshots cannot represent:`
          + ` they render the list as "[a, b]" and read it back by splitting on ",", so this value would round-trip as two entries.`
          + ` Use a comma-free value (a glob like \`src/*.ts\`) or separate entries.`;
      }
    }
  }
  return null;
}

export type UpdateTaskOptions = {
  taskId: string;
  patch?: Partial<TaskRecord>;
  detailPatch?: Partial<TaskDetailRecord>;
  /** Replaces the task's depends-on edges AND the detail prerequisites so the board and the detail file never diverge. */
  dependsOn?: string[];
  /** Replaces the task's blocks edges AND the detail blocking list. */
  blocking?: string[];
  actor: string;
  now?: () => Date;
};

export type UpdateTaskResult =
  | { ok: true; applied: { fields: string[]; detailFields: string[]; edges: boolean } }
  | {
      ok: false;
      reason: "unknown-task" | "no-changes" | "unknown-field" | "unknown-dependency" | "invalid-workload" | "invalid-estimated-effort" | "invalid-wait-reason" | "invalid-predicted-start" | "invalid-external-links" | "comma-in-list-element";
      to: string;
      message?: string;
    };

export function updateTask(store: StoreHandle, options: UpdateTaskOptions): UpdateTaskResult {
  const now = options.now ?? (() => new Date());
  const to = options.taskId;

  for (const field of Object.keys(options.patch ?? {})) {
    if (!PATCHABLE_TASK_FIELDS.has(field)) {
      return { ok: false, reason: "unknown-field", to, message: unknownFieldMessage(field, "task") };
    }
  }
  for (const field of Object.keys(options.detailPatch ?? {})) {
    if (!PATCHABLE_DETAIL_FIELDS.has(field)) {
      return { ok: false, reason: "unknown-field", to, message: unknownFieldMessage(field, "detail") };
    }
  }

  const suppliedWorkload = options.patch?.workload;
  if (typeof suppliedWorkload === "string" && suppliedWorkload.trim() !== "" && !workloadSchema.safeParse(suppliedWorkload.trim()).success) {
    return {
      ok: false,
      reason: "invalid-workload",
      to,
      message: `workload must be one of ${workloadSchema.options.join("|")}; got "${suppliedWorkload}"`
    };
  }
  const commaProblem = commaInListElement(SNAPSHOT_LIST_TASK_FIELDS, options.patch as Record<string, unknown> | undefined)
    ?? commaInListElement(SNAPSHOT_LIST_DETAIL_FIELDS, options.detailPatch as Record<string, unknown> | undefined);
  if (commaProblem) return { ok: false, reason: "comma-in-list-element", to, message: commaProblem };
  // T-127: validated before the write transaction opens, like every other
  // enum/format gate here -- a malformed link must never reach the journal.
  // `null` clears the list; anything else must be an array of URIs.
  const suppliedLinks: unknown = options.patch?.externalLinks;
  if (suppliedLinks !== undefined) {
    if (suppliedLinks !== null && !Array.isArray(suppliedLinks)) {
      return { ok: false, reason: "invalid-external-links", to, message: "externalLinks must be an array of URIs (or null to clear)" };
    }
    for (const link of (suppliedLinks as unknown[] | null) ?? []) {
      const problem = invalidExternalLink(link);
      if (problem) return { ok: false, reason: "invalid-external-links", to, message: problem };
    }
  }
  const suppliedEffort = options.detailPatch?.estimatedEffort as string | null | undefined;
  const suppliedWaitReason = options.detailPatch?.waitReason;
  if (suppliedWaitReason !== undefined && suppliedWaitReason !== null &&
      !["review", "decision", "parked", "blocked-external"].includes(suppliedWaitReason)) {
    return { ok: false, reason: "invalid-wait-reason", to, message: "waitReason must be review|decision|parked|blocked-external or empty" };
  }
  // T-102 predictedStart: schema only. Null clears; object must validate
  // (YYYY-MM-DD start, method, confidence). Never auto-derived here.
  const suppliedPredicted = options.patch?.predictedStart;
  if (suppliedPredicted !== undefined && suppliedPredicted !== null &&
      !predictedStartSchema.safeParse(suppliedPredicted).success) {
    return {
      ok: false,
      reason: "invalid-predicted-start",
      to,
      message: `predictedStart must be null or {start: YYYY-MM-DD, method: manual|heuristic|model, confidence: low|medium|high}`
    };
  }
  if (suppliedEffort !== undefined && suppliedEffort !== null &&
      (typeof suppliedEffort !== "string" || (suppliedEffort.trim() !== "" && parseEstimatedEffortMs(suppliedEffort) === null))) {
    return {
      ok: false,
      reason: "invalid-estimated-effort",
      to,
      message: `estimatedEffort must be a positive m|h|d|w duration; got "${suppliedEffort}"`
    };
  }

  return store.runInWriteTransaction(append => {
    const task = getTask(store.db, to);
    if (!task) return { ok: false, reason: "unknown-task", to };

    const detail = getTaskDetail(store.db, to);
    const needsDetail = Boolean(
      options.detailPatch || options.dependsOn !== undefined || options.blocking !== undefined
    );
    if (needsDetail && !detail) {
      return { ok: false, reason: "unknown-task", to, message: `no detail record for ${to}` };
    }

    const patch: Partial<TaskRecord> = { ...(options.patch ?? {}) };
    const detailPatch: Partial<TaskDetailRecord> = { ...(options.detailPatch ?? {}) };
    if (typeof patch.workload === "string") {
      patch.workload = patch.workload.trim() || null;
    }
    // T-127: the column is a JSON array, never null -- `--set externalLinks=null`
    // means "no links", so it normalizes to [] before the event is journaled
    // instead of leaving a null for the projection to coerce silently.
    if ((patch as { externalLinks?: unknown }).externalLinks === null) {
      patch.externalLinks = [];
    }
    // Editing an estimate after the T-099 convention is an explicit new
    // declaration, not a reinterpretation of the legacy value it replaces.
    if (detailPatch.estimatedEffort !== undefined) {
      detailPatch.estimatedEffort = (detailPatch.estimatedEffort as string | null)?.trim() ?? "";
      // Persist a clearing marker in the event. `undefined` would disappear
      // during JSON serialization and leave the prior active provenance set.
      detailPatch.estimatedEffortSource = detailPatch.estimatedEffort ? "agent-active" : "legacy-human";
    }

    let edges: DependencyRecord[] | undefined;
    if (options.dependsOn !== undefined || options.blocking !== undefined) {
      edges = listOutgoingEdges(store, to).filter(edge => edge.kind !== "depends-on" && edge.kind !== "blocks");
      if (options.dependsOn !== undefined) {
        for (const target of options.dependsOn) {
          if (!getTask(store.db, target)) {
            return { ok: false, reason: "unknown-dependency", to, message: `dependsOn target not found: ${target}` };
          }
          edges.push({ fromTaskId: to, toTaskId: target, kind: "depends-on" });
        }
        detailPatch.prerequisites = [...options.dependsOn];
      }
      if (options.blocking !== undefined) {
        for (const target of options.blocking) {
          if (!getTask(store.db, target)) {
            return { ok: false, reason: "unknown-dependency", to, message: `blocking target not found: ${target}` };
          }
          edges.push({ fromTaskId: to, toTaskId: target, kind: "blocks" });
        }
        detailPatch.blocking = [...options.blocking];
      }
    }

    if (Object.keys(patch).length === 0 && Object.keys(detailPatch).length === 0) {
      return { ok: false, reason: "no-changes", to };
    }

    patch.updatedOn = now().toISOString().slice(0, 10);
    const payload: Record<string, unknown> = {
      taskId: to,
      patch,
      source: options.actor
    };
    if (Object.keys(detailPatch).length > 0) payload.detailPatch = detailPatch;
    if (edges) payload.outgoingEdges = edges;

    append({
      eventType: "task.patched",
      actor: options.actor,
      occurredAt: now().toISOString(),
      payload
    });

    return {
      ok: true,
      applied: {
        fields: Object.keys(patch).filter(field => field !== "updatedOn"),
        detailFields: Object.keys(detailPatch),
        edges: Boolean(edges)
      }
    };
  });
}

function listOutgoingEdges(store: StoreHandle, taskId: string): DependencyRecord[] {
  return (
    store.db
      .prepare("SELECT from_task_id, to_task_id, kind FROM dependency_projection WHERE from_task_id = ? ORDER BY kind, to_task_id")
      .all(taskId) as Record<string, unknown>[]
  ).map(row => ({
    fromTaskId: row.from_task_id as string,
    toTaskId: row.to_task_id as string,
    kind: row.kind as DependencyRecord["kind"]
  }));
}

/** Maps a board status (backlog/ready-for-do/doing/...) to its planning state; passthrough for canonical states. */
export function toPlanningState(status: string): string {
  return STATUS_TO_PLANNING[status] ?? status;
}

export function newDispatchId(): string {
  return crypto.randomUUID();
}

const TASK_TYPES = new Set(["epic", "feature", "task", "bug", "chore"]);
const TASK_ID_PATTERN = /^(T|E)-\d{3,}$/;

export type CreateTaskOptions = {
  title: string;
  id?: string;
  type?: string;
  parent?: string | null;
  status?: string;
  priority?: string | null;
  workload?: string | null;
  tags?: string[];
  domains?: string[];
  dependsOn?: string[];
  blocking?: string[];
  startDate?: string | null;
  dueDate?: string | null;
  /** Initial detail-file fields. `description` prose is Git-authored: it is written to the new detail file, never stored. */
  detail?: Partial<TaskDetailRecord> & { description?: string };
  actor: string;
  now?: () => Date;
};

export type CreateTaskResult =
  | { ok: true; taskId: string; detailPath: string; warnings: string[] }
  | {
      ok: false;
      reason:
        | "missing-title"
        | "invalid-id"
        | "duplicate-id"
        | "invalid-type"
        | "unknown-parent"
        | "unknown-dependency"
        | "invalid-workload"
        | "invalid-estimated-effort"
        | "invalid-wait-reason"
        | "state-not-exportable"
        | "comma-in-list-element";
      message?: string;
      taskId?: string;
    };

/**
 * Registers a new task under store authority: a `task.upserted` event with a
 * complete TaskRecord, a detail record (structured fields only -- the
 * description prose is written straight to the new detail file and stays
 * Git-authored), and the initial dependency edges. The board position is the
 * end of the current board; the id is `--id` or the next free sequential
 * number for the prefix implied by the type (E for epic, T otherwise).
 */
export function createTask(store: StoreHandle, options: CreateTaskOptions): CreateTaskResult {
  const now = options.now ?? (() => new Date());

  if (!options.title || options.title.trim() === "") {
    return { ok: false, reason: "missing-title" };
  }
  const type = options.type ?? "task";
  if (!TASK_TYPES.has(type)) {
    return { ok: false, reason: "invalid-type", message: `type "${type}" is not in epic|feature|task|bug|chore` };
  }
  const status = options.status ?? "backlog";
  if (!EXPORTABLE_PLANNING_STATES.has(status)) {
    return {
      ok: false,
      reason: "state-not-exportable",
      message: `planningState "${status}" has no TASKS.md status mapping; the board vocabulary must grow before this state is creatable.`
    };
  }

  const requested = options.detail ?? {};
  // Review B2: `createTask` is a caller too, and the invariant was stated as
  // absolute while only `updateTask` enforced it -- the reviewer reproduced
  // the non-convergent drift through `createTask({tags:['a,b']})`. The CLI
  // cannot reach it (parseListInput refuses both spellings on `task create`),
  // but @mapctx/store is a published package and createTask is exported.
  const createCommaProblem =
    commaInListElement(SNAPSHOT_LIST_TASK_FIELDS, { tags: options.tags, domains: options.domains, assignees: undefined, externalLinks: undefined })
    ?? commaInListElement(SNAPSHOT_LIST_DETAIL_FIELDS, requested as unknown as Record<string, unknown>)
    ?? commaInListElement(["dependsOn", "blocking"], { dependsOn: options.dependsOn, blocking: options.blocking });
  if (createCommaProblem) return { ok: false, reason: "comma-in-list-element", message: createCommaProblem };
  const normalizedWorkload = options.workload?.trim() ?? "";
  if (normalizedWorkload && !workloadSchema.safeParse(normalizedWorkload).success) {
    return {
      ok: false,
      reason: "invalid-workload",
      message: `workload must be one of ${workloadSchema.options.join("|")}; got "${options.workload}"`
    };
  }
  const normalizedEffort = requested.estimatedEffort?.trim() ?? "";
  if (requested.waitReason !== undefined && requested.waitReason !== null &&
      !["review", "decision", "parked", "blocked-external"].includes(requested.waitReason)) {
    return { ok: false, reason: "invalid-wait-reason", message: "waitReason must be review|decision|parked|blocked-external" };
  }
  if (normalizedEffort && parseEstimatedEffortMs(normalizedEffort) === null) {
    return {
      ok: false,
      reason: "invalid-estimated-effort",
      message: `estimatedEffort must be a positive m|h|d|w duration; got "${requested.estimatedEffort}"`
    };
  }

  return store.runInWriteTransaction(append => {
    const tasks = listAllTasks(store);
    const prefix = type === "epic" ? "E" : "T";
    let taskId = options.id;
    if (taskId) {
      if (!TASK_ID_PATTERN.test(taskId) || (taskId.startsWith("E-") && type !== "epic") || (taskId.startsWith("T-") && type === "epic")) {
        return { ok: false, reason: "invalid-id", message: `id "${taskId}" must match ${prefix}-### for type ${type}` };
      }
      if (tasks.some(t => t.taskId === taskId)) {
        return { ok: false, reason: "duplicate-id", taskId };
      }
    } else {
      const next = tasks
        .map(t => t.taskId)
        .filter(id => id.startsWith(`${prefix}-`))
        .map(id => Number(id.slice(prefix.length + 1)))
        .filter(n => Number.isFinite(n));
      taskId = `${prefix}-${String((next.length > 0 ? Math.max(...next) : 0) + 1).padStart(3, "0")}`;
      while (tasks.some(t => t.taskId === taskId)) {
        const n: number = Number(taskId.slice(prefix.length + 1));
        taskId = `${prefix}-${String(n + 1).padStart(3, "0")}`;
      }
    }

    if (options.parent && !getTask(store.db, options.parent)) {
      return { ok: false, reason: "unknown-parent", message: `parent not found: ${options.parent}` };
    }
    for (const target of [...(options.dependsOn ?? []), ...(options.blocking ?? [])]) {
      if (!getTask(store.db, target)) {
        return { ok: false, reason: "unknown-dependency", message: `dependency target not found: ${target}` };
      }
    }

    const positionKey = tasks.length > 0 ? Math.max(...tasks.map(t => t.positionKey)) + 1 : 0;
    const detailPath = `./tasks/${taskId}.md`;
    const record: TaskRecord = {
      taskId,
      positionKey,
      // Board convention: the heading is "### [ID] Title", so the stored
      // title carries the bracketed id -- same as the importer reads it.
      title: `[${taskId}] ${options.title.trim()}`,
      planningState: status,
      executionState: "unclaimed",
      type,
      parentTaskId: options.parent ?? null,
      priority: options.priority ?? null,
      workload: normalizedWorkload || null,
      tags: [...(options.tags ?? [])],
      domains: [...(options.domains ?? [])],
      startDate: options.startDate ?? null,
      dueDate: options.dueDate ?? null,
      completedOn: null,
      externalId: null,
      externalLinks: [],
      assignees: [],
      detailPath
    };

    const outgoingEdges: DependencyRecord[] = [
      ...(options.dependsOn ?? []).map(toTaskId => ({ fromTaskId: taskId, toTaskId, kind: "depends-on" as const })),
      ...(options.blocking ?? []).map(toTaskId => ({ fromTaskId: taskId, toTaskId, kind: "blocks" as const }))
    ];

    const detail: TaskDetailRecord = {
      taskId,
      role: requested.role ?? "implementation",
      impact: requested.impact ?? "medium",
      // Do not silently invent a plan. The CLI returns a warning and claim
      // refuses executable work until an operator supplies this value.
      estimatedEffort: normalizedEffort,
      // The convention attaches to a value, not to an intentionally blank
      // field that the claim gate will make the operator fill later.
      estimatedEffortSource: normalizedEffort ? "agent-active" : undefined,
      waitReason: requested.waitReason,
      prerequisites: requested.prerequisites ?? [...(options.dependsOn ?? [])],
      blocking: requested.blocking ?? [...(options.blocking ?? [])],
      filesAffected: requested.filesAffected ?? [],
      testsRequired: requested.testsRequired ?? [],
      summary: requested.summary ?? options.title.trim()
    };

    append({
      eventType: "task.upserted",
      actor: options.actor,
      occurredAt: now().toISOString(),
      payload: {
        task: record,
        createOnly: true,
        detail,
        outgoingEdges
      }
    });

    const warnings: string[] = [];
    if (type !== "epic") {
      if (!record.workload) warnings.push(`Missing workload. Set it before claim: mapctx task update ${taskId} --set workload=Normal`);
      if (!detail.estimatedEffort.trim()) warnings.push(`Missing estimatedEffort. Set it before claim: mapctx task update ${taskId} --set detail.estimatedEffort=1d`);
    }
    return { ok: true, taskId, detailPath, warnings };
  });
}

function listAllTasks(store: StoreHandle): { taskId: string; positionKey: number }[] {
  return (
    store.db
      .prepare("SELECT task_id, position_key FROM task_projection ORDER BY position_key ASC, task_id ASC")
      .all() as Record<string, unknown>[]
  ).map(row => ({
    taskId: row.task_id as string,
    positionKey: row.position_key as number
  }));
}
