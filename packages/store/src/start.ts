import * as crypto from "crypto"
import { appendTaskClaim, type ClaimOptions, type ClaimResult } from "./claims"
import { appendDispatchAttempt } from "./dispatch"
import { getTask, latestDispatchKind, listDispatchAttempts } from "./projections"
import type { StoreHandle } from "./store-handle"
import type { DispatchAttemptRecord } from "./types"

/**
 * T-144 (C5): `kind` is inherited from `ClaimOptions` and used TWICE -- once
 * for the claim's lane and once for the dispatch's. That is the point of one
 * vocabulary for both halves: `startTask({ kind: "review" })` opens a review
 * lane whole, a shared claim and a review dispatch together.
 *
 * T-144 attempt 2 (review M1): this function is what makes the half-open
 * states unreachable, and it had to EARN that. The first version said they
 * were inexpressible, and they were not. `startTask({ dispatchId: <a review
 * dispatch>, /* no kind *\/ })` resolved the claim's lane from
 * `options.kind ?? "implement"` while the dispatch's lane came from the
 * chain's own `kind` by inheritance -- so the call minted an
 * `exclusive`/`implement` claim and attached it to a `review` attempt. Nothing
 * refused it, and the `requireActiveClaim` gate could not have: `startTask`
 * does not turn it on, and with it on any live review claim satisfies a review
 * dispatch's gate anyway.
 *
 * The consequence was not cosmetic. The run's own heartbeats resolve by the
 * dispatch's lane, so they renewed the REVIEWER's claim while the implement
 * claim just minted for the working agent was never renewed by anything and
 * died at its expiry in silence -- the lane confusion §3 forbids, in the
 * direction the tests had not probed. `task renew --dispatch` reported
 * `token-mismatch` (it had resolved the other lane's claim), which tells the
 * caller nothing true about what went wrong.
 *
 * So when `dispatchId` names an existing chain, the chain's lane decides: an
 * absent `kind` INHERITS it, and an explicit `kind` that contradicts it is
 * refused by name. A dispatch id names one lane, and now both halves of a
 * `start` read that lane from the same place.
 */
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
    // T-144 (review M1): ONE lane for both halves of the start, read from the
    // chain when there is a chain to read it from.
    let kind = options.kind;
    if (options.dispatchId) {
      const history = listDispatchAttempts(store.db, dispatchId);
      if (history.length === 0) throw new Error(`Unknown dispatch: ${dispatchId}. Omit --dispatch-id for a new task start.`);
      if (history.some(item => item.taskId !== options.taskId)) {
        throw new Error(`Dispatch ${dispatchId} belongs to another task. Use task start ${options.taskId} without --dispatch-id.`);
      }
      attempt = Math.max(...history.map(item => item.attempt)) + 1;
      // The chain's lane, read from its LATEST attempt -- the same row
      // `laneRoleOf` answers renewals from, so a start and the heartbeats of
      // the run it opens cannot disagree about which lane they are in.
      const chainKind = latestDispatchKind(history);
      // Thrown, not returned as a refusal, to match the two checks directly
      // above (unknown dispatch, dispatch belonging to another task) and
      // `appendDispatchAttempt`'s own contradictory-kind refusal: "you named a
      // dispatch that does not fit this call" has one shape everywhere.
      if (kind !== undefined && kind !== chainKind) {
        throw new Error(
          `Dispatch ${dispatchId} runs in the ${chainKind} lane; starting an attempt on it in the ${kind} lane would take `
          + `the ${kind} claim while the attempt itself ran in the ${chainKind} one. Omit the kind to continue the `
          + `${chainKind} lane, or start without --dispatch-id to open a separate ${kind} dispatch.`
        );
      }
      // Absent kind inherits rather than defaulting to `implement`: the
      // default is only correct for a NEW dispatch, and silently applying it
      // here is exactly what minted an implement claim for a review attempt.
      kind = chainKind;
    }
    const claim = appendTaskClaim(store, { ...options, kind }, append);
    if (!claim.ok) return claim;
    const result = appendDispatchAttempt(store, {
      dispatchId,
      taskId: options.taskId,
      executorKind: options.executorKind ?? "cli",
      contextHash: options.contextHash ?? crypto.createHash("sha256").update(JSON.stringify(task)).digest("hex"),
      attempt,
      status: options.status ?? "claimed",
      // The same lane the claim just took -- resolved above, not re-derived
      // here. `appendDispatchAttempt` still refuses a contradictory kind,
      // which is now a redundant second line of defence on this path rather
      // than the only one.
      kind,
      actor: options.actor
    }, append);
    if (!result.ok) throw new Error(`Dispatch refused: ${result.reason}`);
    return { ...claim, dispatch: result.dispatch };
  });
}
