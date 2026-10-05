import * as crypto from "crypto"
import { appendTaskClaim, type ClaimOptions, type ClaimResult } from "./claims"
import { appendDispatchAttempt } from "./dispatch"
import { getTask, listDispatchAttempts } from "./projections"
import type { StoreHandle } from "./store-handle"
import type { DispatchAttemptRecord } from "./types"

export type StartOptions = ClaimOptions & {
  dispatchId?: string;
  executorKind?: string;
  contextHash?: string;
  status?: "claimed" | "running";
};

export type StartResult =
  | (Extract<ClaimResult, { ok: true }> & { dispatch: DispatchAttemptRecord })
  | Extract<ClaimResult, { ok: false }>;

/** One durable transaction: failed dispatch admission rolls back the claim and planning hops. */
export function startTask(store: StoreHandle, options: StartOptions): StartResult {
  return store.runInWriteTransaction(append => {
    const task = getTask(store.db, options.taskId);
    if (!task) return { ok: false, reason: "unknown-task" };
    const dispatchId = options.dispatchId ?? crypto.randomUUID();
    let attempt = 1;
    if (options.dispatchId) {
      const history = listDispatchAttempts(store.db, dispatchId);
      if (history.length === 0) throw new Error(`Unknown dispatch: ${dispatchId}. Omit --dispatch-id for a new task start.`);
      if (history.some(item => item.taskId !== options.taskId)) {
        throw new Error(`Dispatch ${dispatchId} belongs to another task. Use task start ${options.taskId} without --dispatch-id.`);
      }
      attempt = Math.max(...history.map(item => item.attempt)) + 1;
    }
    const claim = appendTaskClaim(store, options, append);
    if (!claim.ok) return claim;
    const result = appendDispatchAttempt(store, {
      dispatchId,
      taskId: options.taskId,
      executorKind: options.executorKind ?? "cli",
      contextHash: options.contextHash ?? crypto.createHash("sha256").update(JSON.stringify(task)).digest("hex"),
      attempt,
      status: options.status ?? "claimed",
      actor: options.actor
    }, append);
    if (!result.ok) throw new Error(`Dispatch refused: ${result.reason}`);
    return { ...claim, dispatch: result.dispatch };
  });
}
