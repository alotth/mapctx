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
};

export type ReviseAcceptanceResult =
  | { ok: true; changed: boolean; revision: number; criteria: AcceptanceCriterionRecord[] }
  | { ok: false; reason: "unknown-task" | "revision-conflict"; message: string };

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
};

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
export function planAcceptanceImport(db: StoreHandle["db"], tasksRoot: string): AcceptanceImportPlan {
  const entries: AcceptanceImportPlanEntry[] = [];
  for (const task of listTasks(db)) {
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
    skippedExisting: entries.filter(entry => entry.action === "skip-existing").length
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
export function commitAcceptanceImport(store: StoreHandle, tasksRoot: string, options: { actor: string; now?: () => Date }): AcceptanceImportCommitResult {
  const now = options.now ?? (() => new Date());
  const plan = planAcceptanceImport(store.db, tasksRoot);
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
