import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { parseAcceptanceChecklist } from "@mapctx/core"
import { getAcceptance, getTask, listTasks } from "./projections"
import type { StoreHandle } from "./store-handle"
import type { AcceptanceCondition, AcceptanceCriterionRecord } from "./types"

export type AcceptanceReadResult =
  | { condition: "absent" }
  | { condition: "empty" }
  | { condition: "criteria"; items: Array<{ text: string; completed: boolean }> }
  | { condition: "unreadable"; message: string }

/**
 * Reads the observed acceptance condition from Git-authored detail content.
 * Absent / empty-prose-only / checklisted are distinct honest states; a
 * plain bullet is an incomplete observation, never an approval.
 */
export function parseAcceptanceRead(content: string): Exclude<AcceptanceReadResult, { condition: "unreadable" }> {
  const checklist = parseAcceptanceChecklist(content)
  if (!checklist.found) return { condition: "absent" }
  if (checklist.items.length === 0) return { condition: "empty" }
  return { condition: "criteria", items: checklist.items }
}

export function readAcceptanceFromDetailFile(detailFilePath: string): AcceptanceReadResult {
  let content: string
  try {
    content = fs.readFileSync(detailFilePath, "utf8")
  } catch (error) {
    return { condition: "unreadable", message: String(error) }
  }
  return parseAcceptanceRead(content)
}

function newCriterionId(): string {
  return crypto.randomUUID()
}

function criteriaFromTexts(texts: string[], source: string): AcceptanceCriterionRecord[] {
  return texts.map((text, position) => ({
    criterionId: newCriterionId(),
    revision: 0,
    position,
    text,
    state: "pending" as const,
    source
  }))
}

function sameCriteriaTexts(a: AcceptanceCriterionRecord[], texts: string[]): boolean {
  return a.length === texts.length && a.every((criterion, index) => criterion.text === texts[index])
}

/**
 * T-129: the `acceptance.revised` payload for a first revision, shared with
 * `createTask` so a task can be created WITH its criteria in one transaction
 * (criterion 0) without either side re-deriving the criterion shape.
 */
export function buildFirstAcceptanceRevision(
  taskId: string,
  condition: AcceptanceCondition,
  texts: string[]
): { taskId: string; revision: number; condition: AcceptanceCondition; criteria: AcceptanceCriterionRecord[] } {
  const criteria = criteriaFromTexts(texts, "authored").map(criterion => ({ ...criterion, revision: 1 }))
  return { taskId, revision: 1, condition, criteria }
}

/**
 * T-129 (criterion 2): the reported incident was criteria landing on the
 * WRONG task -- `create` returned T-178, `revise` ran against T-177, and
 * `--expect-revision 0` was satisfied there too, so nothing caught it. An id
 * typo is invisible to a revision check; a title is the thing the caller
 * actually knows.
 *
 * Matched against both the stored title and the same title with its `[T-xxx]`
 * id prefix removed, trimmed and case-insensitively, because the prefix is
 * added by the store and no caller types it.
 */
function normalizeTitle(value: string): string {
  // Review F2: NFC first. Without it an NFD argument (which macOS input
  // sources and filesystem reads hand over routinely) never matches an NFC
  // stored title, and the refusal prints two strings that LOOK identical --
  // telling the operator the id is wrong in the one guard whose whole job is
  // to tell them the id is wrong. This board's titles are accented Portuguese.
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()
}

function titleMatches(storedTitle: string, expectTitle: string): boolean {
  const stripped = storedTitle.replace(/^\s*\[[^\]]+\]\s*/, "")
  const wanted = normalizeTitle(expectTitle)
  return normalizeTitle(storedTitle) === wanted || normalizeTitle(stripped) === wanted
}

/**
 * Review F2 asked for a special message when the two sides differ only by
 * Unicode normalization. With NFC applied in `normalizeTitle` that case now
 * MATCHES and never reaches a refusal, so the remaining hazard is the general
 * one: a genuine mismatch whose two strings still RENDER identically (a
 * zero-width character, a look-alike glyph). Then, and only then, the message
 * gains escaped code points, because repeating two identical-looking strings
 * explains nothing.
 */
function titleMismatchDetail(storedTitle: string, expectTitle: string): string {
  const stripped = storedTitle.replace(/^\s*\[[^\]]+\]\s*/, "").trim();
  if (stripped !== expectTitle.trim()) return "";
  const escape = (value: string) => [...value.trim()]
    .map(char => (/[\x20-\x7e]/.test(char) ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`))
    .join("");
  return ` The two render identically but differ in code points: stored ${JSON.stringify(escape(stripped))} vs expected ${JSON.stringify(escape(expectTitle))}.`;
}

export type ReviseAcceptanceOptions = {
  taskId: string;
  condition: AcceptanceCondition;
  /** Criterion texts in order; ignored (must be empty) when condition is "empty". */
  texts: string[];
  actor: string;
  now?: () => Date;
  /**
   * REQUIRED. Refuse unless the store's current revision equals this value.
   * Protects an actor who read the revision earlier against clobbering a
   * revision another writer created in between (drift protection). There is
   * no silent "latest" default: callers act on the revision they read.
   */
  expectRevision: number;
  /**
   * T-129: optional guard against revising the WRONG task. Checked inside the
   * same transaction as the revision check, so an id typo cannot slip between
   * the two.
   */
  expectTitle?: string;
};

export type ReviseAcceptanceResult =
  | { ok: true; changed: boolean; revision: number; criteria: AcceptanceCriterionRecord[] }
  | { ok: false; reason: "unknown-task" | "revision-conflict" | "title-mismatch"; message: string };

/**
 * Replaces the task's acceptance list under a new revision. EVERY criterion
 * lands pending: a revision never inherits approval or evidence -- re-approval
 * is always an explicit approve event. Identical content with nothing approved
 * is a no-op that preserves the current revision (no event, no number bump).
 */
export function reviseAcceptance(store: StoreHandle, options: ReviseAcceptanceOptions): ReviseAcceptanceResult {
  const now = options.now ?? (() => new Date());
  if (options.expectRevision === undefined) {
    return { ok: false, reason: "revision-conflict", message: "expectRevision is required: read the current acceptance revision and act on it; there is no silent latest-revision default." };
  }
  if (options.condition === "empty" && options.texts.length > 0) {
    return { ok: false, reason: "revision-conflict", message: 'condition "empty" forbids criterion texts.' };
  }
  if (options.condition === "criteria" && options.texts.length === 0) {
    return { ok: false, reason: "revision-conflict", message: 'condition "criteria" requires at least one criterion text.' };
  }
  return store.runInWriteTransaction(append => {
    const task = getTask(store.db, options.taskId);
    if (!task) return { ok: false, reason: "unknown-task", message: `Unknown task: ${options.taskId}` };
    if (options.expectTitle !== undefined && !titleMatches(task.title, options.expectTitle)) {
      return {
        ok: false,
        reason: "title-mismatch",
        message: `${options.taskId} is titled ${JSON.stringify(task.title)}, not ${JSON.stringify(options.expectTitle)}. Nothing was revised -- check the task id.${titleMismatchDetail(task.title, options.expectTitle)}`
      };
    }
    const current = getAcceptance(store.db, options.taskId);
    if (options.expectRevision !== undefined && (current?.revision ?? 0) !== options.expectRevision) {
      return {
        ok: false,
        reason: "revision-conflict",
        message: `Acceptance revision drifted: store holds ${current?.revision ?? 0}, caller expected ${options.expectRevision}. Re-read and retry.`
      };
    }
    if (current && current.condition === options.condition && sameCriteriaTexts(current.criteria, options.texts) && current.criteria.every(criterion => criterion.state === "pending")) {
      return { ok: true, changed: false, revision: current.revision, criteria: current.criteria };
    }
    const revision = (current?.revision ?? 0) + 1;
    const criteria = criteriaFromTexts(options.texts, "authored");
    append({
      eventType: "acceptance.revised",
      actor: options.actor,
      occurredAt: now().toISOString(),
      payload: {
        taskId: options.taskId,
        revision,
        condition: options.condition,
        criteria: criteria.map(criterion => ({ ...criterion, revision }))
      }
    });
    return { ok: true, changed: true, revision, criteria: criteria.map(criterion => ({ ...criterion, revision })) };
  });
}

function resolveCriterion(store: StoreHandle, taskId: string, selector: { criterionId?: string; index?: number }): { criterionId: string; error?: undefined } | { criterionId?: never; error: string } {
  const acceptance = getAcceptance(store.db, taskId);
  if (!acceptance) return { error: `No acceptance revision exists for ${taskId}.` };
  if (selector.criterionId) {
    if (!acceptance.criteria.some(criterion => criterion.criterionId === selector.criterionId)) {
      return { error: `Criterion ${selector.criterionId} does not exist at revision ${acceptance.revision}.` };
    }
    return { criterionId: selector.criterionId };
  }
  if (selector.index !== undefined) {
    const criterion = acceptance.criteria[selector.index];
    if (!criterion) return { error: `Index ${selector.index} is out of range: revision ${acceptance.revision} holds ${acceptance.criteria.length} criterion/criteria.` };
    return { criterionId: criterion.criterionId };
  }
  return { error: "Provide either criterionId or index." };
}

export type ApproveCriterionOptions = {
  taskId: string;
  /** Convenience selector resolved under the write transaction. */
  index?: number;
  criterionId?: string;
  evidence?: Record<string, string>;
  actor: string;
  now?: () => Date;
  /** REQUIRED. The revision the caller read; refuses on drift. */
  expectRevision: number;
};

export type ApproveCriterionResult =
  | { ok: true; revision: number; criterionId: string; state: "approved" }
  | { ok: false; reason: "unknown-task" | "unknown-criterion" | "revision-conflict" | "already-approved"; message: string };

export function approveAcceptanceCriterion(store: StoreHandle, options: ApproveCriterionOptions): ApproveCriterionResult {
  const now = options.now ?? (() => new Date());
  if (options.expectRevision === undefined) {
    return { ok: false, reason: "revision-conflict", message: "expectRevision is required: read the current acceptance revision and act on it; there is no silent latest-revision default." };
  }
  return store.runInWriteTransaction(append => {
    const task = getTask(store.db, options.taskId);
    if (!task) return { ok: false, reason: "unknown-task", message: `Unknown task: ${options.taskId}` };
    const acceptance = getAcceptance(store.db, options.taskId);
    if ((acceptance?.revision ?? 0) !== options.expectRevision) {
      return { ok: false, reason: "revision-conflict", message: `Acceptance revision drifted: store holds ${acceptance?.revision ?? 0}, caller expected ${options.expectRevision}.` };
    }
    if (!acceptance) return { ok: false, reason: "unknown-criterion", message: `No acceptance revision exists for ${options.taskId}.` };
    const resolved = resolveCriterion(store, options.taskId, { criterionId: options.criterionId, index: options.index });
    if (resolved.error) return { ok: false, reason: "unknown-criterion", message: resolved.error };
    const criterion = acceptance.criteria.find(item => item.criterionId === resolved.criterionId) as AcceptanceCriterionRecord;
    if (criterion.state === "approved") {
      return { ok: false, reason: "already-approved", message: `Criterion ${criterion.criterionId} is already approved; unapprove first if this is intentional.` };
    }
    append({
      eventType: "acceptance.approved",
      actor: options.actor,
      occurredAt: now().toISOString(),
      payload: {
        taskId: options.taskId,
        revision: acceptance.revision,
        criterionId: criterion.criterionId,
        evidence: options.evidence ?? null,
        approvedAt: now().toISOString()
      }
    });
    return { ok: true, revision: acceptance.revision, criterionId: criterion.criterionId, state: "approved" };
  });
}

export type ApproveCriteriaBatchOptions = {
  taskId: string;
  /** Zero-based positions to approve. Mutually exclusive with `all`. */
  indices?: number[];
  criterionIds?: string[];
  /** Approve every criterion that is still pending. */
  all?: boolean;
  /** ONE evidence set, recorded on every criterion this call approves. */
  evidence?: Record<string, string>;
  actor: string;
  now?: () => Date;
  /** REQUIRED. The revision the caller read; refuses on drift. */
  expectRevision: number;
};

export type ApproveCriteriaBatchResult =
  | {
      ok: true;
      revision: number;
      /** Criteria this call moved to approved. */
      approved: string[];
      /**
       * Criteria `--all` passed over because they were already approved.
       * Always empty for an explicit selection, which refuses instead.
       */
      alreadyApproved: string[];
    }
  | { ok: false; reason: "unknown-task" | "unknown-criterion" | "revision-conflict" | "already-approved" | "nothing-to-approve" | "invalid-selection"; message: string };

/**
 * T-129 (criterion 1): approves several criteria in ONE write transaction,
 * under one revision check, with one evidence set -- the reported friction
 * (A1.4) was approving a seven-criterion task one command at a time, each
 * repeating `--expect-revision` and its own `--evidence`.
 *
 * A mid-batch refusal rolls the whole batch back, so the store never holds
 * half an approval set and the caller never has to work out where it stopped.
 *
 * `all` and an explicit selection differ deliberately on already-approved
 * criteria: `all` means "bring this task to fully approved", so it skips them
 * and reports them; naming an index or id is a specific claim about a specific
 * criterion, so it refuses exactly as the single-criterion path does.
 */
export function approveAcceptanceCriteria(store: StoreHandle, options: ApproveCriteriaBatchOptions): ApproveCriteriaBatchResult {
  const now = options.now ?? (() => new Date());
  const indices = options.indices ?? [];
  const criterionIds = options.criterionIds ?? [];
  const explicit = indices.length > 0 || criterionIds.length > 0;
  if (options.all && explicit) {
    return { ok: false, reason: "invalid-selection", message: "--all cannot be combined with --index or --criterion-id." };
  }
  if (!options.all && !explicit) {
    return { ok: false, reason: "invalid-selection", message: "Provide --all, --index <n[,n...]> or --criterion-id <id>." };
  }
  const duplicateIndex = indices.find((value, position) => indices.indexOf(value) !== position);
  if (duplicateIndex !== undefined) {
    return { ok: false, reason: "invalid-selection", message: `--index lists ${duplicateIndex} more than once.` };
  }
  const duplicateId = criterionIds.find((value, position) => criterionIds.indexOf(value) !== position);
  if (duplicateId !== undefined) {
    return { ok: false, reason: "invalid-selection", message: `--criterion-id lists ${duplicateId} more than once.` };
  }

  return store.runInWriteTransaction(append => {
    const task = getTask(store.db, options.taskId);
    if (!task) return { ok: false, reason: "unknown-task", message: `Unknown task: ${options.taskId}` };
    const acceptance = getAcceptance(store.db, options.taskId);
    if ((acceptance?.revision ?? 0) !== options.expectRevision) {
      return { ok: false, reason: "revision-conflict", message: `Acceptance revision drifted: store holds ${acceptance?.revision ?? 0}, caller expected ${options.expectRevision}.` };
    }
    if (!acceptance) return { ok: false, reason: "unknown-criterion", message: `No acceptance revision exists for ${options.taskId}.` };

    const selected: AcceptanceCriterionRecord[] = [];
    if (options.all) {
      selected.push(...acceptance.criteria);
    } else {
      for (const index of indices) {
        const criterion = acceptance.criteria[index];
        if (!criterion) {
          return { ok: false, reason: "unknown-criterion", message: `Index ${index} is out of range: revision ${acceptance.revision} holds ${acceptance.criteria.length} criterion/criteria. Nothing was approved.` };
        }
        selected.push(criterion);
      }
      for (const criterionId of criterionIds) {
        const criterion = acceptance.criteria.find(item => item.criterionId === criterionId);
        if (!criterion) {
          return { ok: false, reason: "unknown-criterion", message: `Criterion ${criterionId} does not exist at revision ${acceptance.revision}. Nothing was approved.` };
        }
        if (selected.some(item => item.criterionId === criterion.criterionId)) {
          return { ok: false, reason: "invalid-selection", message: `Criterion ${criterionId} is selected twice (by index and by id).` };
        }
        selected.push(criterion);
      }
    }

    const alreadyApproved = selected.filter(criterion => criterion.state === "approved");
    if (!options.all && alreadyApproved.length > 0) {
      return {
        ok: false,
        reason: "already-approved",
        message: `Criterion ${alreadyApproved[0].criterionId} is already approved; unapprove first if this is intentional, or use --all to skip the approved ones. Nothing was approved.`
      };
    }
    const pending = selected.filter(criterion => criterion.state !== "approved");
    if (pending.length === 0) {
      return {
        ok: false,
        reason: "nothing-to-approve",
        message: `Every selected criterion of ${options.taskId} is already approved at revision ${acceptance.revision}.`
      };
    }

    const occurredAt = now().toISOString();
    for (const criterion of pending) {
      append({
        eventType: "acceptance.approved",
        actor: options.actor,
        occurredAt,
        payload: {
          taskId: options.taskId,
          revision: acceptance.revision,
          criterionId: criterion.criterionId,
          evidence: options.evidence ?? null,
          approvedAt: occurredAt
        }
      });
    }
    return {
      ok: true,
      revision: acceptance.revision,
      approved: pending.map(criterion => criterion.criterionId),
      alreadyApproved: alreadyApproved.map(criterion => criterion.criterionId)
    };
  });
}

export type UnapproveCriterionOptions = {
  taskId: string;
  index?: number;
  criterionId?: string;
  actor: string;
  now?: () => Date;
  /** REQUIRED. The revision the caller read; refuses on drift. */
  expectRevision: number;
};

export type UnapproveCriterionResult =
  | { ok: true; revision: number; criterionId: string; state: "pending" }
  | { ok: false; reason: "unknown-task" | "unknown-criterion" | "revision-conflict" | "not-approved"; message: string };

export function unapproveAcceptanceCriterion(store: StoreHandle, options: UnapproveCriterionOptions): UnapproveCriterionResult {
  const now = options.now ?? (() => new Date());
  if (options.expectRevision === undefined) {
    return { ok: false, reason: "revision-conflict", message: "expectRevision is required: read the current acceptance revision and act on it; there is no silent latest-revision default." };
  }
  return store.runInWriteTransaction(append => {
    const task = getTask(store.db, options.taskId);
    if (!task) return { ok: false, reason: "unknown-task", message: `Unknown task: ${options.taskId}` };
    const acceptance = getAcceptance(store.db, options.taskId);
    if ((acceptance?.revision ?? 0) !== options.expectRevision) {
      return { ok: false, reason: "revision-conflict", message: `Acceptance revision drifted: store holds ${acceptance?.revision ?? 0}, caller expected ${options.expectRevision}.` };
    }
    if (!acceptance) return { ok: false, reason: "unknown-criterion", message: `No acceptance revision exists for ${options.taskId}.` };
    const resolved = resolveCriterion(store, options.taskId, { criterionId: options.criterionId, index: options.index });
    if (resolved.error) return { ok: false, reason: "unknown-criterion", message: resolved.error };
    const criterion = acceptance.criteria.find(item => item.criterionId === resolved.criterionId) as AcceptanceCriterionRecord;
    if (criterion.state !== "approved") {
      return { ok: false, reason: "not-approved", message: `Criterion ${criterion.criterionId} is not approved.` };
    }
    append({
      eventType: "acceptance.unapproved",
      actor: options.actor,
      occurredAt: now().toISOString(),
      payload: { taskId: options.taskId, revision: acceptance.revision, criterionId: criterion.criterionId }
    });
    return { ok: true, revision: acceptance.revision, criterionId: criterion.criterionId, state: "pending" };
  });
}

// ---- T-120 cutover import: observed markdown -> store, explicitly ----

export type AcceptanceImportAction = "import" | "skip-existing" | "absent" | "empty" | "unreadable";

export type AcceptanceImportPlanEntry = {
  taskId: string;
  detailPath: string | null;
  action: AcceptanceImportAction;
  approvedCount: number;
  pendingCount: number;
  /** sha256 of the file BYTES actually read (dirty checkout may diverge from git HEAD). */
  sourceSha256: string | null;
  message?: string;
};

export type AcceptanceImportPlan = {
  entries: AcceptanceImportPlanEntry[];
  importable: number;
  skippedExisting: number;
  /** T-129: the `--task` scope this plan was built for, or null for the whole project. */
  taskFilter: string[] | null;
};

export type AcceptanceImportScope = {
  /**
   * T-129 (criterion 3): restrict the import to these task ids. An id that
   * does not exist THROWS rather than importing a smaller set in silence --
   * the reported friction was an import that could only ever run project-wide,
   * and a filter that quietly matched nothing would be worse than no filter.
   */
  taskIds?: string[];
};

function scopedTasks(db: StoreHandle["db"], scope: AcceptanceImportScope | undefined) {
  const all = listTasks(db);
  const wanted = scope?.taskIds;
  if (!wanted || wanted.length === 0) return { tasks: all, taskFilter: null as string[] | null };
  const known = new Set(all.map(task => task.taskId));
  const unknown = wanted.filter(taskId => !known.has(taskId));
  if (unknown.length > 0) {
    throw new Error(`acceptance import --task names unknown task(s): ${unknown.join(", ")}. Nothing was planned or imported.`);
  }
  const scoped = new Set(wanted);
  return { tasks: all.filter(task => scoped.has(task.taskId)), taskFilter: [...new Set(wanted)] };
}

/**
 * Dry-run plan of the cutover acceptance import over the checkout mirrors.
 * Observed [x] maps to approved with source "import-observed" -- an observed
 * prior checkmark, never a claim of independent verification and never an
 * inference from planning=done. [ ] stays pending; an absent section stays
 * absent; a prose-only/blank section imports as an explicit empty revision.
 * No header row is touched for tasks that already carry canonical
 * revisioning (skip-existing), so re-running with the same source can never
 * overwrite later revisions.
 */
export function planAcceptanceImport(db: StoreHandle["db"], tasksRoot: string, scope?: AcceptanceImportScope): AcceptanceImportPlan {
  const entries: AcceptanceImportPlanEntry[] = [];
  const { tasks, taskFilter } = scopedTasks(db, scope);
  for (const task of tasks) {
    if (!task.detailPath) {
      entries.push({ taskId: task.taskId, detailPath: null, action: "absent", approvedCount: 0, pendingCount: 0, sourceSha256: null });
      continue;
    }
    const detailFilePath = path.resolve(tasksRoot, task.detailPath);
    const existing = getAcceptance(db, task.taskId);
    if (existing) {
      entries.push({ taskId: task.taskId, detailPath: task.detailPath, action: "skip-existing", approvedCount: 0, pendingCount: 0, sourceSha256: null });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(detailFilePath);
    } catch (error) {
      entries.push({ taskId: task.taskId, detailPath: task.detailPath, action: "unreadable", approvedCount: 0, pendingCount: 0, sourceSha256: null, message: String(error) });
      continue;
    }
    const sourceSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    // Parse exactly the bytes whose hash is pinned below. A second read could
    // otherwise import criteria from bytes different from the audited hash.
    const observed = parseAcceptanceRead(bytes.toString("utf8"));
    if (observed.condition === "absent") {
      entries.push({ taskId: task.taskId, detailPath: task.detailPath, action: "absent", approvedCount: 0, pendingCount: 0, sourceSha256 });
      continue;
    }
    if (observed.condition === "empty") {
      entries.push({ taskId: task.taskId, detailPath: task.detailPath, action: "empty", approvedCount: 0, pendingCount: 0, sourceSha256 });
      continue;
    }
    const approvedCount = observed.items.filter(item => item.completed).length;
    entries.push({
      taskId: task.taskId,
      detailPath: task.detailPath,
      action: "import",
      approvedCount,
      pendingCount: observed.items.length - approvedCount,
      sourceSha256
    });
  }
  return {
    entries,
    importable: entries.filter(entry => entry.action === "import" || entry.action === "empty").length,
    skippedExisting: entries.filter(entry => entry.action === "skip-existing").length,
    taskFilter
  };
}

export type AcceptanceImportCommitResult =
  | ({
      ok: true;
      imported: number;
      emptyImported: number;
      skippedExisting: number;
      absent: number;
      unreadable: number;
      entries: AcceptanceImportPlanEntry[];
      revision: { node: string; sequence: number } | null;
    })
  | { ok: false; reason: "plan-changed"; message: string };

/**
 * Commits the planned import as one atomic batch of acceptance.imported
 * events (single write transaction): a mid-batch refusal rolls the whole
 * batch back, so the store never holds a partially applied import. Each
 * event pins the sha256 of the bytes actually read plus the relative source
 * path. Tasks whose section is absent get NO event -- absent stays an
 * absence of revisioning, not an empty revision.
 */
export function commitAcceptanceImport(store: StoreHandle, tasksRoot: string, options: { actor: string; now?: () => Date } & AcceptanceImportScope): AcceptanceImportCommitResult {
  const now = options.now ?? (() => new Date());
  const plan = planAcceptanceImport(store.db, tasksRoot, { taskIds: options.taskIds });
  let revisionRef: { node: string; sequence: number } | null = null;
  return store.runInWriteTransaction(append => {
    const sourceBytes = new Map<string, Buffer>();
    // Re-verify every importable task inside the transaction: another
    // writer may have revised acceptance between plan and commit; the
    // admission guard would refuse mid-batch and roll the batch back, but
    // the explicit preflight keeps the refusal before any staging.
    for (const entry of plan.entries) {
      if (entry.action !== "import" && entry.action !== "empty") continue;
      const current = getAcceptance(store.db, entry.taskId);
      if (current) {
        return {
          ok: false,
          reason: "plan-changed",
          message: `Acceptance for ${entry.taskId} gained revision ${current.revision} after planning; re-plan and retry. Nothing was applied.`
        };
      }
      // The commit re-reads the source bytes and refuses unless they are
      // byte-identical to the planned read, so the pinned sourceSha256 is
      // provably the bytes the criteria were observed in.
      const detailFilePath = path.resolve(tasksRoot, entry.detailPath as string);
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(detailFilePath);
      } catch (error) {
        return { ok: false, reason: "plan-changed", message: `Source for ${entry.taskId} became unreadable (${String(error)}); re-plan and retry. Nothing was applied.` };
      }
      const commitSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      if (commitSha256 !== entry.sourceSha256) {
        return { ok: false, reason: "plan-changed", message: `Source for ${entry.taskId} changed after planning (sha256 mismatch); re-plan and retry. Nothing was applied.` };
      }
      sourceBytes.set(entry.taskId, bytes);
    }
    for (const entry of plan.entries) {
      if (entry.action === "import") {
        const bytes = sourceBytes.get(entry.taskId);
        if (!bytes) return { ok: false, reason: "plan-changed", message: `Source bytes for ${entry.taskId} were not captured; re-plan and retry. Nothing was applied.` };
        const observed = parseAcceptanceRead(bytes.toString("utf8"));
        if (observed.condition !== "criteria") {
          return { ok: false, reason: "plan-changed", message: `Source for ${entry.taskId} changed under us (${observed.condition}); re-plan and retry. Nothing was applied.` };
        }
        const occurredAt = now().toISOString();
        const criteria: AcceptanceCriterionRecord[] = observed.items.map((item, position) => ({
          criterionId: newCriterionId(),
          revision: 1,
          position,
          text: item.text,
          state: item.completed ? "approved" : "pending",
          source: item.completed ? "import-observed" : "import-observed-unchecked",
          approvedAt: item.completed ? occurredAt : null,
          approvedBy: item.completed ? options.actor : null
        }));
        const event = append({
          eventType: "acceptance.imported",
          actor: options.actor,
          occurredAt,
          payload: {
            taskId: entry.taskId,
            revision: 1,
            condition: "criteria",
            criteria,
            sourcePath: entry.detailPath,
            sourceSha256: entry.sourceSha256
          }
        });
        revisionRef = { node: event.nodeId, sequence: event.sequence };
      } else if (entry.action === "empty") {
        const event = append({
          eventType: "acceptance.imported",
          actor: options.actor,
          occurredAt: now().toISOString(),
          payload: {
            taskId: entry.taskId,
            revision: 1,
            condition: "empty",
            criteria: [],
            sourcePath: entry.detailPath,
            sourceSha256: entry.sourceSha256
          }
        });
        revisionRef = { node: event.nodeId, sequence: event.sequence };
      }
    }
    return {
      ok: true,
      imported: plan.entries.filter(entry => entry.action === "import").length,
      emptyImported: plan.entries.filter(entry => entry.action === "empty").length,
      skippedExisting: plan.skippedExisting,
      absent: plan.entries.filter(entry => entry.action === "absent").length,
      unreadable: plan.entries.filter(entry => entry.action === "unreadable").length,
      entries: plan.entries,
      revision: revisionRef
    };
  });
}
