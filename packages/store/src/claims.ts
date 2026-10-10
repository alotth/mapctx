import * as crypto from "crypto"
import { parseEstimatedEffortMs, workloadSchema } from "@mapctx/protocol"
import { getActiveClaimForTask, getClaim, getTask, getTaskDetail } from "./projections"
import type { AppendEventInput, StoreHandle } from "./store-handle"
import type { EventLogEntry } from "@mapctx/protocol"
import type { DisclosableClaimRecord, ResourceClaimRecord } from "./types"

export const DEFAULT_LEASE_DURATION_MS = 30 * 60 * 1000;

/**
 * Byte length of a lease token. Exported so the regression test derives its
 * token-shaped pattern from the generator instead of hardcoding a width that
 * could silently drift away from what is actually minted.
 */
export const LEASE_TOKEN_BYTES = 24;

/** The pattern a minted lease token matches: hex, two characters per byte. */
export const LEASE_TOKEN_PATTERN = new RegExp(`\\b[0-9a-f]{${LEASE_TOKEN_BYTES * 2}}\\b`);

/**
 * T-134 (C0 / D1): the ONE place a foreign claim is stripped for disclosure.
 *
 * Every refusal that names somebody else's claim goes through this, so the
 * secret cannot escape through a print site that forgot. It is written as an
 * explicit field list -- not a spread-minus-leaseToken -- so a new secret on
 * ResourceClaimRecord is a compile error here instead of a silent leak.
 *
 * The refused caller still gets everything it needs to act: which claim holds
 * the task, who holds it, and when the lease expires.
 */
export function disclosableClaim(claim: ResourceClaimRecord): DisclosableClaimRecord {
  return {
    claimId: claim.claimId,
    taskId: claim.taskId,
    state: claim.state,
    claimedAt: claim.claimedAt,
    expiresAt: claim.expiresAt,
    holder: claim.holder,
    eventNode: claim.eventNode,
    eventSequence: claim.eventSequence
  };
}

export type ClaimOptions = {
  taskId: string;
  actor: string;
  holder?: Record<string, unknown>;
  leaseDurationMs?: number;
  now?: () => Date;
};

export type ClaimResult =
  | { ok: true; claim: ResourceClaimRecord; expiredPrevious?: string; planningTransitionsTo?: string }
  | { ok: false; reason: "active-claim-held" | "unknown-task" | "terminal-state" | "missing-workload-or-estimate" | "invalid-workload-or-estimate"; activeClaim?: DisclosableClaimRecord; message?: string };

/**
 * BEGIN IMMEDIATE (via runInWriteTransaction) is what makes this
 * check-then-act safe across worktrees: two processes racing to claim the
 * same task will have one block on SQLite's write lock (or get SQLITE_BUSY
 * after busy_timeout) and see the other's committed claim on retry --
 * never two winners.
 */
export function claimTask(store: StoreHandle, options: ClaimOptions): ClaimResult {
  return store.runInWriteTransaction(append => appendTaskClaim(store, options, append));
}

/** Compose claim and dispatch under the caller's existing write transaction. */
export function appendTaskClaim(
  store: StoreHandle,
  options: ClaimOptions,
  append: (input: AppendEventInput) => EventLogEntry
): ClaimResult {
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const now = options.now ?? (() => new Date());

  const task = getTask(store.db, options.taskId);
  if (!task) return { ok: false, reason: "unknown-task" };

  if (task.planningState === "done" || task.planningState === "cancelled" || task.planningState === "archived") {
    return { ok: false, reason: "terminal-state" };
  }

  // Containers do not execute. Every executable claim must carry both the
  // forecast class and an explicit agent-active plan; do not let the prior
  // silently fill either gap.
  if (task.type !== "epic") {
    const detail = getTaskDetail(store.db, options.taskId);
    const missingWorkload = !task.workload?.trim();
    const missingEstimate = !detail?.estimatedEffort?.trim();
    const invalidWorkload = !missingWorkload && !workloadSchema.safeParse(task.workload).success;
    const invalidEstimate = !missingEstimate && parseEstimatedEffortMs(detail!.estimatedEffort) === null;
    if (missingWorkload || missingEstimate || invalidWorkload || invalidEstimate) {
      const fixes = [
        ...(missingWorkload || invalidWorkload ? [`mapctx task update ${options.taskId} --set workload=Normal`] : []),
        ...(missingEstimate || invalidEstimate ? [`mapctx task update ${options.taskId} --set detail.estimatedEffort=1d`] : [])
      ];
      const issues = [
        ...(missingWorkload ? ["missing workload"] : []),
        ...(invalidWorkload ? [`invalid workload "${task.workload}" (expected ${workloadSchema.options.join("|")})`] : []),
        ...(missingEstimate ? ["missing estimatedEffort"] : []),
        ...(invalidEstimate ? [`invalid estimatedEffort "${detail!.estimatedEffort}" (expected positive m|h|d|w)`] : [])
      ];
      return {
        ok: false,
        reason: invalidWorkload || invalidEstimate ? "invalid-workload-or-estimate" : "missing-workload-or-estimate",
        message: `Executable task planning invalid: ${issues.join("; ")}. Fix: ${fixes.join("; ")}`
      };
    }
  }

  let active = getActiveClaimForTask(store.db, options.taskId);
  let expiredPrevious: string | undefined;
  const nowMs = now().getTime();

  if (active && new Date(active.expiresAt).getTime() <= nowMs) {
    append({
      eventType: "task.claim-expired",
      actor: "system",
      occurredAt: now().toISOString(),
      payload: { claimId: active.claimId, taskId: options.taskId }
    });
    expiredPrevious = active.claimId;
    active = undefined;
  }

  if (active) {
    // T-134: `activeClaim: active` used to hand the whole ResourceClaimRecord
    // -- including the holder's leaseToken -- to anyone who tried to claim a
    // held task, which is the bearer credential for renew and release.
    return { ok: false, reason: "active-claim-held", activeClaim: disclosableClaim(active) };
  }

  const claimId = crypto.randomUUID();
  const leaseToken = crypto.randomBytes(LEASE_TOKEN_BYTES).toString("hex");
  const claimedAt = now().toISOString();
  const expiresAt = new Date(nowMs + leaseDurationMs).toISOString();

  append({
    eventType: "task.claimed",
    actor: options.actor,
    occurredAt: claimedAt,
    payload: { claimId, taskId: options.taskId, leaseToken, holder: options.holder ?? {}, claimedAt, expiresAt }
  });

  // Claiming is starting work: carry the planning state to in-progress
  // through the legal path only (no new FSM edges), one event per hop.
  // Claim events name the cause, so the history stays honest. Paused,
  // blocked, review, and in-progress tasks are left where they are --
  // unpausing or reopening is an explicit human decision, never a side
  // effect of a lease.
  const CLAIM_PATH: Record<string, string[]> = {
    backlog: ["ready", "in-progress"],
    ready: ["in-progress"]
  };
  const path = CLAIM_PATH[task.planningState] ?? [];
  for (const next of path) {
    append({
      eventType: "task.patched",
      actor: options.actor,
      occurredAt: now().toISOString(),
      payload: {
        taskId: options.taskId,
        patch: { planningState: next, updatedOn: now().toISOString().slice(0, 10) },
        source: "claim"
      }
    });
  }

  const claim = getClaim(store.db, claimId);
  if (!claim) throw new Error("Claim projection missing immediately after task.claimed.");
  return { ok: true, claim, expiredPrevious, planningTransitionsTo: path.length > 0 ? "in-progress" : undefined };
}

export type LeaseOptions = {
  taskId: string;
  claimId: string;
  leaseToken: string;
  actor: string;
  now?: () => Date;
};

export type RenewResult =
  | { ok: true; claim: ResourceClaimRecord }
  | { ok: false; reason: "not-active" | "token-mismatch" | "expired" };

export function renewClaim(store: StoreHandle, options: LeaseOptions & { leaseDurationMs?: number }): RenewResult {
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const now = options.now ?? (() => new Date());

  return store.runInWriteTransaction(append => {
    const claim = getClaim(store.db, options.claimId);
    if (!claim || claim.taskId !== options.taskId || claim.state !== "active") {
      return { ok: false, reason: "not-active" };
    }
    if (claim.leaseToken !== options.leaseToken) {
      return { ok: false, reason: "token-mismatch" };
    }
    const nowMs = now().getTime();
    if (new Date(claim.expiresAt).getTime() <= nowMs) {
      append({
        eventType: "task.claim-expired",
        actor: "system",
        occurredAt: now().toISOString(),
        payload: { claimId: claim.claimId, taskId: options.taskId }
      });
      return { ok: false, reason: "expired" };
    }

    const expiresAt = new Date(nowMs + leaseDurationMs).toISOString();
    append({
      eventType: "task.claim-renewed",
      actor: options.actor,
      occurredAt: now().toISOString(),
      payload: { claimId: claim.claimId, taskId: options.taskId, expiresAt }
    });

    const renewed = getClaim(store.db, claim.claimId);
    if (!renewed) throw new Error("Claim projection missing immediately after task.claim-renewed.");
    return { ok: true, claim: renewed };
  });
}

export type ReleaseResult =
  | { ok: true }
  | { ok: false; reason: "not-active" | "token-mismatch" };

export function releaseClaim(store: StoreHandle, options: LeaseOptions): ReleaseResult {
  const now = options.now ?? (() => new Date());

  return store.runInWriteTransaction(append => {
    const claim = getClaim(store.db, options.claimId);
    if (!claim || claim.taskId !== options.taskId || claim.state !== "active") {
      return { ok: false, reason: "not-active" };
    }
    if (claim.leaseToken !== options.leaseToken) {
      return { ok: false, reason: "token-mismatch" };
    }

    append({
      eventType: "task.claim-released",
      actor: options.actor,
      occurredAt: now().toISOString(),
      payload: { claimId: claim.claimId, taskId: options.taskId }
    });

    return { ok: true };
  });
}
