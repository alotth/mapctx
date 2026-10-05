import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { buildExport, checkTaskAcceptance, moveTask, type StoreHandle } from "@mapctx/store"

export type CheckpointReason = "manual" | "wave-end" | "epic-end" | "task-end"

export type CheckpointCursor = { node: string; sequence: number }

export type PublishedCheckpoint = {
  ok: true;
  exportId: string;
  reason: CheckpointReason;
  eventCursor: CheckpointCursor;
  files: Array<{ path: string; sha256: string }>;
};

export type FailedCheckpoint = {
  ok: false;
  stage: "build" | "publish" | "journal" | "precondition";
  error: string;
  /** Files already renamed into place before the failure (partial mirror set -- declared limit, never claimed atomic). */
  publishedFiles: string[];
};

/**
 * Finish-specific gate re-checked INSIDE the publication transaction (T-120
 * review F6): another writer can move acceptance back to pending or reopen
 * the task between the finish gate/move transaction and the checkpoint
 * transaction. The precondition runs under the same BEGIN IMMEDIATE, before
 * any filesystem write, so no task-end/epic-end checkpoint can materialize
 * over criteria that a concurrent revise made pending, or over a reopened
 * task. A manual export passes no precondition and is unaffected.
 */
export type FinishPrecondition = {
  taskId: string;
  requirePlanningState: "done";
  /** Acceptance revision observed at gate time; any drift refuses. */
  expectAcceptanceRevision: number;
};

const TMP_SUFFIX = ".mapctx-tmp"

/**
 * Publishes a deterministic local checkpoint (TASKS.md + task detail
 * mirrors) and records the checkpoint.exported event -- in that order, as
 * one store write transaction. The export content and the recorded source
 * cursor come from the SAME consistent read (the BEGIN IMMEDIATE lock keeps
 * other writers out), so the cursor can never run ahead of the exported
 * bytes. Files are published per-file via tmp+rename; a mid-publication
 * failure aborts the transaction (no checkpoint event is recorded), cleans
 * up temp files, and reports the files already renamed -- the store keeps
 * every previously accepted mutation and the partial mirror set is
 * re-detectable via `mapctx validate --snapshots`.
 */
export function publishCheckpoint(
  handle: StoreHandle,
  tasksRoot: string,
  options: { reason: CheckpointReason; now?: () => Date; actor?: string; precondition?: FinishPrecondition }
): PublishedCheckpoint | FailedCheckpoint {
  const tmpFiles: string[] = [];
  const publishedFiles: string[] = [];
  let totalFiles = 0;
  try {
    return handle.runInWriteTransaction(append => {
      // Finish precondition: same transaction, before any filesystem write.
      // Refusal commits an empty transaction -- no event, no files, no
      // checkpoint, and any previously accepted canonical mutation stays.
      if (options.precondition) {
        const failure = checkFinishPrecondition(handle, options.precondition);
        if (failure) return { ok: false, stage: "precondition" as const, error: failure, publishedFiles };
      }
      const exported = buildExport(handle.db, { tasksRoot });
      const events = handle.listEvents();
      const last = events[events.length - 1];
      const eventCursor: CheckpointCursor = last ? { node: last.nodeId, sequence: last.sequence } : { node: handle.nodeId, sequence: 0 };
      // T-120: pin the acceptance revision source the exported mirrors were
      // rendered from, so a checkpoint is queryable down to which criterion
      // revisions it materialized.
      const acceptanceRevisions = readAcceptanceRevisions(handle);

      const files: Array<{ path: string; content: string; sha256: string }> = [
        { path: exported.tasksMd.path, content: exported.tasksMd.content, sha256: sha256Hex(exported.tasksMd.content) },
        ...exported.taskDetailFiles.map(file => ({ path: file.path, content: file.content, sha256: sha256Hex(file.content) }))
      ];
      totalFiles = files.length;

      for (const file of files) {
        const tmpPath = `${file.path}${TMP_SUFFIX}`;
        tmpFiles.push(tmpPath);
        fs.writeFileSync(tmpPath, file.content);
        fs.renameSync(tmpPath, file.path);
        tmpFiles.pop();
        publishedFiles.push(file.path);
      }

      const exportId = crypto.randomUUID();
      append({
        eventType: "checkpoint.exported",
        actor: options.actor ?? "mapctx-export",
        occurredAt: (options.now ?? (() => new Date()))().toISOString(),
        payload: {
          exportId,
          eventCursor,
          filesHash: Object.fromEntries(files.map(file => [path.relative(tasksRoot, file.path), file.sha256])),
          reason: options.reason,
          exportSchemaVersion: 1,
          acceptanceRevisions
        }
      });

      return {
        ok: true,
        exportId,
        reason: options.reason,
        eventCursor,
        files: files.map(file => ({ path: file.path, sha256: file.sha256 }))
      };
    });
  } catch (error) {
    for (const tmpPath of tmpFiles) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort temp cleanup */ }
    }
    const message = error instanceof Error ? error.message : String(error);
    // Stage honesty: nothing published -> the export itself failed; a
    // partial set -> publication failed mid-way; the full set -> the
    // failure was in the durable journal write / transaction commit.
    const stage: FailedCheckpoint["stage"] = totalFiles === 0 ? "build"
      : publishedFiles.length === totalFiles ? "journal"
        : "publish";
    return { ok: false, stage, error: message, publishedFiles };
  }
}

function readAcceptanceRevisions(handle: StoreHandle): Record<string, number> {
  try {
    const rows = handle.db.prepare("SELECT task_id, revision FROM acceptance_revision_projection").all() as Array<{ task_id: string; revision: number }>;
    return Object.fromEntries(rows.map(row => [row.task_id, row.revision]));
  } catch {
    // Pre-migration-10 stores never reach a write transaction in practice
    // (open migrates first); keep the checkpoint payload honest if a future
    // read-only path ever lands here.
    return {};
  }
}

/** Current canonical acceptance revision for one task (0 when never revised). */
function readAcceptanceRevision(db: StoreHandle["db"], taskId: string): number {
  try {
    const row = db.prepare("SELECT revision FROM acceptance_revision_projection WHERE task_id = ?").get(taskId) as { revision: number } | undefined;
    return row?.revision ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Returns a refusal message when the finish precondition no longer holds,
 * observed state included, or null when it holds. Runs inside the caller's
 * write transaction. Declares, never guesses: planning state and acceptance
 * revision are read fresh under the lock.
 */
function checkFinishPrecondition(handle: StoreHandle, precondition: FinishPrecondition): string | null {
  const row = handle.db.prepare("SELECT planning_state FROM task_projection WHERE task_id = ?").get(precondition.taskId) as { planning_state: string } | undefined;
  if (!row || row.planning_state !== precondition.requirePlanningState) {
    return (
      `finish precondition failed: task ${precondition.taskId} is "${row?.planning_state ?? "missing"}", ` +
      `expected "${precondition.requirePlanningState}" -- the task was reopened or moved in a concurrent gap. ` +
      `No checkpoint was recorded; any previously accepted canonical mutation remains durable.`
    );
  }
  const currentRevision = readAcceptanceRevision(handle.db, precondition.taskId);
  if (currentRevision !== precondition.expectAcceptanceRevision) {
    return (
      `finish precondition failed: acceptance for ${precondition.taskId} was revised in a concurrent gap ` +
      `(store revision ${currentRevision}, gated revision ${precondition.expectAcceptanceRevision}). ` +
      `No checkpoint was recorded; re-approve the criteria and retry finish.`
    );
  }
  const acceptance = checkTaskAcceptance(handle.db, precondition.taskId);
  if (!acceptance.ok) {
    return `finish precondition failed: ${acceptance.message} No checkpoint was recorded; the canonical done move (if any) remains accepted.`;
  }
  return null;
}

export function sha256Hex(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export type FinishTaskResult =
  | {
      ok: true;
      taskId: string;
      move: { performed: boolean; from: string; to: string; releasedClaimId?: string };
      checkpoint: PublishedCheckpoint;
    }
  | { ok: false; stage: "move"; taskId: string; move: Extract<ReturnType<typeof moveTask>, { ok: false }> }
  | { ok: false; stage: "checkpoint"; taskId: string; move: { performed: boolean; from: string; to: string }; checkpoint: FailedCheckpoint };

/**
 * T-120 final-boundary flow for a single task or epic: the SAME canonical
 * done move (acceptance gate included) followed by a local checkpoint
 * publication as the last step. No wave controller, no spawns, no container
 * execution -- `finish` is an explicit boundary a runner invokes when its
 * work on the task is over. Retry-safe: a task already canonically done
 * skips the move entirely (no duplicate completion event) and retries only
 * the checkpoint, which cannot bypass the acceptance gate because the gate
 * is re-checked (with the gated acceptance revision and planning state)
 * INSIDE the publication transaction (review F6) -- a concurrent revise or
 * reopen in the gap refuses with stage "precondition" and records no
 * checkpoint. A checkpoint failure leaves the accepted `done` mutation in
 * place -- the distinguished result and a non-zero CLI exit make the split
 * state explicit instead of rolling back accepted history.
 */
export function finishTask(
  handle: StoreHandle,
  tasksRoot: string,
  options: { taskId: string; actor: string; now?: () => Date }
): FinishTaskResult {
  const existing = handle.db.prepare("SELECT planning_state, type FROM task_projection WHERE task_id = ?").get(options.taskId) as { planning_state: string; type: string | null } | undefined;
  if (!existing) {
    return {
      ok: false,
      stage: "move",
      taskId: options.taskId,
      move: { ok: false, reason: "unknown-task", to: "done", message: `Unknown task: ${options.taskId}` }
    };
  }

  let movePerformed = false;
  let fromState = existing.planning_state;
  let releasedClaimId: string | undefined;
  // A revision can be edited after a task became done. Check again before a
  // checkpoint-only retry, so that path cannot bypass the current gate.
  if (existing.planning_state === "done") {
    const acceptance = checkTaskAcceptance(handle.db, options.taskId)
    if (!acceptance.ok) {
      return {
        ok: false,
        stage: "move",
        taskId: options.taskId,
        move: { ok: false, reason: "acceptance-incomplete", to: "done", from: "done", message: acceptance.message }
      }
    }
  }
  if (existing.planning_state !== "done") {
    const move = moveTask(handle, { taskId: options.taskId, to: "done", actor: options.actor, now: options.now });
    if (!move.ok) return { ok: false, stage: "move", taskId: options.taskId, move };
    movePerformed = true;
    fromState = move.from;
    releasedClaimId = move.releasedClaimId;
  }

  const reason: CheckpointReason = existing.type === "epic" ? "epic-end" : "task-end";
  // F6: the gate/move above ran in its own transaction. Capture the gated
  // acceptance revision and re-verify everything under the publication
  // transaction's lock, so a revise/reopen in the gap can never end up
  // under a task-end/epic-end checkpoint.
  const precondition: FinishPrecondition = {
    taskId: options.taskId,
    requirePlanningState: "done",
    expectAcceptanceRevision: readAcceptanceRevision(handle.db, options.taskId)
  };
  const checkpoint = publishCheckpoint(handle, tasksRoot, { reason, actor: options.actor, now: options.now, precondition });
  if (!checkpoint.ok) {
    return {
      ok: false,
      stage: "checkpoint",
      taskId: options.taskId,
      move: { performed: movePerformed, from: fromState, to: "done" },
      checkpoint
    };
  }
  return {
    ok: true,
    taskId: options.taskId,
    move: { performed: movePerformed, from: fromState, to: "done", ...(releasedClaimId ? { releasedClaimId } : {}) },
    checkpoint
  };
}
