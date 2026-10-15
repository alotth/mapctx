import * as crypto from "crypto"
import { parseEstimatedEffortMs, workloadSchema } from "@mapctx/protocol"
import { resolveCoordinationSettings, type CoordinationSettings } from "./config"
import { getActiveClaimForTask, getClaim, getTask, getTaskDetail } from "./projections"
import type { AppendEventInput, StoreHandle } from "./store-handle"
import type { EventLogEntry } from "@mapctx/protocol"
import type { DisclosableClaimRecord, ResourceClaimRecord } from "./types"

/**
 * The lease a task gets when nothing can be derived: no parseable
 * `estimatedEffort` (a container/epic claim) and no `[coordination]` tuning.
 * It is the same 30 minutes every claim used to get, kept as the floor of the
 * clamp rather than as the answer -- see `deriveLeaseDurationMs`.
 */
export const DEFAULT_LEASE_DURATION_MS = 30 * 60 * 1000;

/**
 * D4's absolute ceiling on a lease: 24 hours. C4 will enforce it on every
 * renewal path, where its purpose is to stop a wedged-but-still-heartbeating
 * agent from renewing forever. T-141 declares the number here and applies it
 * to the one surface that can already exceed it -- an explicit `--lease` --
 * so C4 extends the reach of one constant instead of inventing a second.
 *
 * It bounds the *explicit* lease only. A derived lease cannot reach it
 * (`maxLease` defaults to 8 h and is itself the clamp), and a caller passing
 * `leaseDurationMs` in-process is trusted the way every in-process caller of
 * this store is.
 */
export const ABSOLUTE_LEASE_CEILING_MS = 24 * 60 * 60 * 1000;

/**
 * T-141 (C2 / D3, D10): the lease is read from the plan instead of from a
 * constant. `appendTaskClaim` already refuses an executable task without both
 * `workload` and a parseable `estimatedEffort`, so the inputs for a sensible
 * lease are mandatory at claim time and were simply being thrown away: a
 * `Hard`/`2d` task received the same 30 minutes as an `Easy`/`30m` one.
 *
 *     lease = clamp(estimatedEffort x leaseFactor, defaultLease, maxLease)
 *
 * with the D10 starting figures (0.5, 30m, 8h), each overridable through
 * `[coordination]` in mapctx.toml. D10 approves those numbers as a first
 * guess to be re-derived once C4's heartbeat exclusion makes receipt
 * durations trustworthy again -- so this function is the one place to change
 * when that happens.
 *
 * `workload` is deliberately NOT a term: D10 approved an effort-based figure,
 * and workload stays what it already is -- a claim precondition and the
 * forecast's pool key. Adding a second multiplier nobody calibrated would be
 * inventing a number, not deriving one.
 *
 * A task with no parseable estimate gets `defaultLease` whole: the clamp has
 * nothing to clamp, and refusing the claim here is not this function's job
 * (admission already refuses executable tasks that lack the plan).
 */
export function deriveLeaseDurationMs(options: {
  estimatedEffort?: string | null;
  coordination?: CoordinationSettings;
}): number {
  const settings = options.coordination ?? resolveCoordinationSettings(undefined);
  const effortMs = options.estimatedEffort ? parseEstimatedEffortMs(options.estimatedEffort) : null;
  if (effortMs === null) return settings.defaultLeaseMs;
  const derived = Math.round(effortMs * settings.leaseFactor);
  return Math.min(Math.max(derived, settings.defaultLeaseMs), settings.maxLeaseMs);
}

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
  /**
   * An explicit lease, which wins over config and over the derived default --
   * the `--lease` flag's precedence (T-141). Left unset, the lease comes from
   * `deriveLeaseDurationMs`.
   */
  leaseDurationMs?: number;
  /**
   * Resolved `[coordination]`. The CLI reads it from mapctx.toml; a caller
   * that omits it gets the D10 defaults, which is the honest fallback for a
   * caller that has no project file in hand.
   */
  coordination?: CoordinationSettings;
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
  const now = options.now ?? (() => new Date());

  const task = getTask(store.db, options.taskId);
  if (!task) return { ok: false, reason: "unknown-task" };

  if (task.planningState === "done" || task.planningState === "cancelled" || task.planningState === "archived") {
    return { ok: false, reason: "terminal-state" };
  }

  // Read once: the same row answers the admission check below and the lease
  // derivation further down.
  const detail = getTaskDetail(store.db, options.taskId);

  // Containers do not execute. Every executable claim must carry both the
  // forecast class and an explicit agent-active plan; do not let the prior
  // silently fill either gap.
  if (task.type !== "epic") {
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

  // Precedence (T-141): an explicit `leaseDurationMs` (the `--lease` flag)
  // wins; otherwise the lease is derived from this task's own plan under the
  // project's `[coordination]` figures.
  const leaseDurationMs = options.leaseDurationMs
    ?? deriveLeaseDurationMs({ estimatedEffort: detail?.estimatedEffort, coordination: options.coordination });

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
  coordination?: CoordinationSettings;
  now?: () => Date;
};

export type RenewResult =
  | { ok: true; claim: ResourceClaimRecord }
  | { ok: false; reason: "not-active" | "token-mismatch" | "expired" };

/**
 * T-141 decision -- a renewal extends by the SAME derived size as the claim,
 * not by a fixed 30 minutes.
 *
 * The alternative was to extend by the length the claim itself was minted
 * with (`expiresAt - claimedAt`, recoverable from the row until the first
 * renewal rewrites `expiresAt`). Re-deriving from the plan wins on two
 * counts: it needs no history, and it is self-correcting -- the skills tell
 * an agent to re-classify a task the moment the work turns out harder
 * (`task update --set workload=Hard`, and the estimate with it), and the next
 * renewal should honour the new plan rather than the one that was wrong.
 * Leaving renewal on the constant would have been the original bug in a
 * second place: a `Hard`/`2d` task claimed for 8 h, then renewed for 30 min.
 *
 * `--lease` is deliberately NOT offered on `task renew`: D3 approves it for
 * `task claim`/`task start`, and a per-renewal override is a second way to
 * set the same number with no decision behind it. A caller that needs one
 * can still pass `leaseDurationMs` in-process.
 */
export function renewClaim(store: StoreHandle, options: LeaseOptions & { leaseDurationMs?: number }): RenewResult {
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

    const leaseDurationMs = options.leaseDurationMs
      ?? deriveLeaseDurationMs({
        estimatedEffort: getTaskDetail(store.db, options.taskId)?.estimatedEffort,
        coordination: options.coordination
      });

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
