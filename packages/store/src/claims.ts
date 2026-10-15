import * as crypto from "crypto"
import { parseEstimatedEffortMs, workloadSchema } from "@mapctx/protocol"
import { ABSOLUTE_LEASE_CEILING_MS, resolveCoordinationSettings, type CoordinationSettings } from "./config"
import { getActiveClaimForTask, getClaim, getRunReceipt, getTask, getTaskDetail, listActiveClaimsForTask, listDispatchAttempts } from "./projections"
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
 * Re-exported so T-141's importers keep working; the declaration moved to
 * `config.ts` in T-143 so `resolveCoordinationSettings` can refuse a
 * `maxLease` above it (review F1). It now bounds minting as well as renewal,
 * which is what a constant named ABSOLUTE should always have meant.
 */
export { ABSOLUTE_LEASE_CEILING_MS };

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
 * T-142 (C3 / D2): the renew capability is minted at the SAME width from the
 * same CSPRNG, deliberately. Two reasons, one of them defensive: there is no
 * argument for a weaker renew secret, and the T-134 regression test that
 * sweeps stdout for anything token-shaped then catches either capability with
 * one pattern instead of needing to learn a second shape.
 *
 * Independent value, not a derivation. D2 withdrew the HMAC idea because
 * verifying a derived token still requires reading the secret it was meant to
 * avoid: `HMAC(leaseToken, ...)` cannot be checked without `leaseToken`. Two
 * random values compared by equality need no algorithm and no second lookup.
 */
export const RENEW_TOKEN_BYTES = LEASE_TOKEN_BYTES;

/**
 * Constant-time string comparison for claim credentials.
 *
 * `timingSafeEqual` throws on length mismatch rather than returning false, so
 * the length is checked first -- which leaks the length of the presented
 * value, and nothing else. That is not a weakness worth engineering around:
 * every token this store mints is the same width, so the length carries no
 * information about the secret, only about what the caller typed.
 */
function credentialMatches(stored: string, presented: string): boolean {
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

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
  // T-142 (D2): the capability split is by POSSESSION. `leaseToken` renews and
  // releases; `renewToken` only renews, so an orchestrator can keep a lane
  // alive without being able to take the lane away from the agent working in
  // it. Both are scoped to this `claimId` and live and die with this row --
  // not to `(dispatchId, attempt)`, which the data model cannot express
  // anyway: a claim carries no dispatch reference, `task claim` mints a claim
  // with no dispatch at all, and one claim legitimately spans the attempts of
  // a retry.
  const renewToken = crypto.randomBytes(RENEW_TOKEN_BYTES).toString("hex");
  // T-162: ONE clock read for both ends of the lease. `expiresAt` has always
  // been derived from `nowMs`, read at the top of this function; `claimedAt`
  // used to be a SECOND read taken here, after the admission checks, the
  // lease derivation and two token generations. Whatever time passed in
  // between -- a GC pause, a descheduled process under a parallel test run --
  // silently shortened the lease the row describes: a claim asking for 8h
  // would store a pair 62ms apart from 8h, and `expiresAt - claimedAt` is how
  // every consumer reads the duration back. That is a row that misstates its
  // own lease, and it is also what made the T-141 CLI test need a wall-clock
  // tolerance at all. Deriving both from the same instant makes the stored
  // duration exact by construction rather than approximately right when the
  // machine is idle.
  const claimedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + leaseDurationMs).toISOString();

  append({
    eventType: "task.claimed",
    actor: options.actor,
    occurredAt: claimedAt,
    payload: { claimId, taskId: options.taskId, leaseToken, renewToken, holder: options.holder ?? {}, claimedAt, expiresAt }
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

/**
 * How a renewal addresses the claim it extends, and what it presents to prove
 * it may (T-142 / C3, D2-D3).
 *
 * Exactly one address and exactly one credential. "Exactly" on both counts is
 * a refusal, not a preference: guessing between two addresses is how a renewal
 * ends up extending the wrong lane, and accepting two credentials at once lets
 * a caller probe which one matched.
 */
export type RenewOptions = {
  /**
   * The task the claim must belong to. Required with `claimId` (it is what
   * makes a claim id from another task a refusal); optional with `dispatchId`,
   * where the dispatch already names the task and this becomes an assertion
   * that the caller is renewing the lane it thinks it is.
   */
  taskId?: string;
  /** Claim address: the claim's own id. */
  claimId?: string;
  /**
   * Dispatch address: a LOOKUP (dispatch -> task -> that task's active claim),
   * never the token's scope. A claim carries no dispatch reference, so this
   * resolves through `task_id`, the only edge the data model has.
   */
  dispatchId?: string;
  /** The full capability: renews and releases. */
  leaseToken?: string;
  /** The renew-only capability. Cannot release, by having no release path. */
  renewToken?: string;
  actor: string;
  coordination?: CoordinationSettings;
  leaseDurationMs?: number;
  now?: () => Date;
};

export type RenewResult =
  /**
   * T-142: the result discloses exactly what the presented credential already
   * proves, and nothing more.
   *
   * - presented `leaseToken`: the full record, unchanged from before. The
   *   caller holds the stronger capability already, so echoing it escalates
   *   nothing -- and T-134's approved criterion 3 ("the holder still gets its
   *   own leaseToken from claim/start/renew") is a tested contract of a task
   *   that is already `done`. A capability change is not a licence to revoke
   *   it quietly.
   * - presented `renewToken`: a DISCLOSABLE record, no token fields at all. An
   *   orchestrator that can renew must not be handed release authority as a
   *   reward for renewing, which would void the whole split.
   *
   * Hence the union: narrow on it, or read `expiresAt`, which is the answer a
   * renewal actually owes its caller and is present either way.
   */
  | { ok: true; claim: ResourceClaimRecord | DisclosableClaimRecord }
  | {
      ok: false;
      reason:
        | "not-active"
        | "token-mismatch"
        | "expired"
        | "renew-token-unavailable"
        | "receipt-landed"
        | "unknown-dispatch"
        | "ambiguous-claim"
        | "ceiling-reached"
        | "invalid-request";
      /**
       * Context only, never a new field on an existing shape: T-142 adds no
       * key to the refusals that already existed (`not-active`,
       * `token-mismatch`, `expired` keep exactly the shape callers assert
       * today). What a caller learns that is new travels in `message`, which
       * the CLI renders into the `Error:` line.
       */
      message?: string;
    };

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
/**
 * T-143 (C4 / D4): where the 24 h ceiling is actually applied, for EVERY
 * renewal path -- the explicit `task renew` below and the run-event path that
 * follows it. T-141 declared the number and bounded an explicit `--lease` with
 * it; this is the half that stops a wedged-but-still-heartbeating agent from
 * renewing forever, which is the whole reason evidence-based liveness is
 * allowed to be secret-free in the first place (§2).
 *
 * Measured from the ORIGINAL `claimedAt`, never from the current `expiresAt`:
 * a ceiling measured from the thing it constrains is no ceiling at all, since
 * every renewal would push it along. Past the ceiling nothing extends the
 * claim -- only a fresh `task start`, which mints a new claim with a new
 * `claimedAt` and is a deliberate act by someone who looked.
 *
 * Inside the window a renewal is CLAMPED rather than refused: a lease that
 * would end after the ceiling ends at the ceiling instead. Refusing there
 * would make a 5 h lease unrenewable from hour 20 onward while a 30-minute
 * lease kept working, which has nothing to do with liveness.
 *
 * The clock is the trust boundary §2 declares: this is the local clock of
 * whichever process renews, so a clock skewed backwards extends the lease.
 * Accepted at the same level as the rest of the local CLI's trust, and stated
 * rather than discovered.
 */
/**
 * T-143 (review F2): why a lane really died.
 *
 * The ceiling is almost never the refusal an agent sees, and that is
 * structural rather than accidental: the clamp pulls `expiresAt` down to the
 * ceiling, and both renewal paths test expiry BEFORE they test the ceiling, so
 * a heartbeating agent -- the exact case the ceiling exists for -- gets
 * `expired` at +24 h. The advice it carries ("re-claim with task start") is
 * right; what was missing is that a 24 h policy limit fired rather than a
 * missed heartbeat. Whoever debugs "why did my lane die at exactly 24 hours?"
 * should not have to read this file to find out.
 */
function ceilingNote(claim: ResourceClaimRecord, nowMs: number): string {
  const ceilingMs = new Date(claim.claimedAt).getTime() + ABSOLUTE_LEASE_CEILING_MS;
  if (nowMs < ceilingMs) return "";
  return ` This claim had also reached its 24 h maximum lifetime (claimed ${claim.claimedAt}, ceiling `
    + `${new Date(ceilingMs).toISOString()}), so no renewal path would have extended it either -- a fresh`
    + " task start is the only way to open the lane again.";
}

function ceilingBoundedExpiry(
  claim: ResourceClaimRecord,
  nowMs: number,
  leaseDurationMs: number
): { expiresAt: string; cappedByCeiling: boolean } | { ceilingReached: true; ceilingAt: string } {
  const ceilingMs = new Date(claim.claimedAt).getTime() + ABSOLUTE_LEASE_CEILING_MS;
  if (nowMs >= ceilingMs) return { ceilingReached: true, ceilingAt: new Date(ceilingMs).toISOString() };
  const requestedMs = nowMs + leaseDurationMs;
  const cappedByCeiling = requestedMs > ceilingMs;
  return { expiresAt: new Date(cappedByCeiling ? ceilingMs : requestedMs).toISOString(), cappedByCeiling };
}

export function renewClaim(store: StoreHandle, options: RenewOptions): RenewResult {
  const now = options.now ?? (() => new Date());

  return store.runInWriteTransaction(append => {
    const byClaim = options.claimId !== undefined;
    const byDispatch = options.dispatchId !== undefined;
    if (byClaim === byDispatch) {
      return {
        ok: false,
        reason: "invalid-request",
        message: byClaim
          ? "A renewal takes one address: either the claim id or the dispatch id to look it up by, not both."
          : "A renewal must address a claim: pass its claim id, or the dispatch id to look it up by."
      };
    }
    const presentsLease = options.leaseToken !== undefined;
    const presentsRenew = options.renewToken !== undefined;
    if (presentsLease === presentsRenew) {
      return {
        ok: false,
        reason: "invalid-request",
        message: presentsLease
          ? "Present one credential, not both: the lease token or the renew token."
          : "A renewal must present a credential: the claim's lease token or its renew token."
      };
    }

    const nowMs = now().getTime();
    let claim: ResourceClaimRecord | undefined;

    if (byClaim) {
      const found = getClaim(store.db, options.claimId!);
      if (!found || found.taskId !== options.taskId || found.state !== "active") {
        return { ok: false, reason: "not-active" };
      }
      claim = found;
    } else {
      const attempts = listDispatchAttempts(store.db, options.dispatchId);
      if (attempts.length === 0) {
        return { ok: false, reason: "unknown-dispatch", message: `Unknown dispatch: ${options.dispatchId}` };
      }
      const dispatchTaskId = attempts[0]!.taskId;
      if (options.taskId !== undefined && dispatchTaskId !== options.taskId) {
        return {
          ok: false,
          reason: "invalid-request",
          message: `Dispatch ${options.dispatchId} belongs to ${dispatchTaskId}, not ${options.taskId}.`
        };
      }
      // "Latest open attempt" is the admission rule for the DISPATCH, and it
      // is about the lane being finished -- not about the credential's scope.
      // A lane whose latest attempt already landed a receipt is over; keeping
      // its lease alive would hold the task against a run that reported
      // itself complete. A retry opens attempt N+1 and renews again.
      const latestAttempt = Math.max(...attempts.map(attempt => attempt.attempt));
      if (getRunReceipt(store.db, options.dispatchId!, latestAttempt)) {
        return {
          ok: false,
          reason: "receipt-landed",
          message: `Dispatch ${options.dispatchId} attempt ${latestAttempt} already has a receipt; admit a new attempt before renewing again.`
        };
      }
      // Role narrows this lookup once C5 exists; today the partial unique
      // index means at most one active row per task. Refusing an ambiguous
      // resolution rather than picking one keeps that an index guarantee
      // instead of a coincidence -- and `--claim` is the way out when it
      // ever fires.
      const active = listActiveClaimsForTask(store.db, dispatchTaskId);
      if (active.length === 0) return { ok: false, reason: "not-active" };
      if (active.length > 1) {
        return {
          ok: false,
          reason: "ambiguous-claim",
          message: `Dispatch ${options.dispatchId} resolves ${active.length} active claims on ${dispatchTaskId}; name the one to renew with its claim id.`
        };
      }
      claim = active[0]!;
    }

    if (presentsRenew) {
      if (claim.renewToken === null) {
        return {
          ok: false,
          reason: "renew-token-unavailable",
          message: "This claim was made before the renew capability existed, so no renewToken was ever minted for it; renew it with its lease token."
        };
      }
      if (!credentialMatches(claim.renewToken, options.renewToken!)) {
        return { ok: false, reason: "token-mismatch" };
      }
    } else if (!credentialMatches(claim.leaseToken, options.leaseToken!)) {
      return { ok: false, reason: "token-mismatch" };
    }

    // Everything below reads the task from the RESOLVED CLAIM, never from
    // `options.taskId`: on the dispatch-addressed path the caller may not have
    // passed one, and a `taskId: undefined` in an event payload or a lease
    // derived from the wrong task's plan are both silent corruptions.
    const taskId = claim.taskId;

    if (new Date(claim.expiresAt).getTime() <= nowMs) {
      append({
        eventType: "task.claim-expired",
        actor: "system",
        occurredAt: now().toISOString(),
        payload: { claimId: claim.claimId, taskId }
      });
      // The message appears ONLY when the ceiling has something to add. This
      // refusal's shape is a documented decision of T-142 -- `not-active`,
      // `token-mismatch` and `expired` keep exactly the shape callers assert
      // today (see `RenewResult` above), and `dispatch.test.ts:221` asserts
      // this one with `deepEqual`. An unconditional `message` broke that for
      // every ordinary expiry in order to say something only the ceiling case
      // needs, which is the wrong trade: F2 asked for a diagnosis when the
      // 24 h limit fired, not for a new key on a refusal that already had its
      // shape fixed by another task.
      const note = ceilingNote(claim, nowMs);
      return {
        ok: false,
        reason: "expired",
        ...(note ? { message: `Claim ${claim.claimId} expired at ${claim.expiresAt}.${note}` } : {})
      };
    }

    const leaseDurationMs = options.leaseDurationMs
      ?? deriveLeaseDurationMs({
        estimatedEffort: getTaskDetail(store.db, taskId)?.estimatedEffort,
        coordination: options.coordination
      });

    const bounded = ceilingBoundedExpiry(claim, nowMs, leaseDurationMs);
    if ("ceilingReached" in bounded) {
      return {
        ok: false,
        reason: "ceiling-reached",
        message: `Claim ${claim.claimId} has been alive for the 24 h maximum (claimed ${claim.claimedAt}, ceiling ${bounded.ceilingAt});`
          + " no renewal extends it further. Release it and open a new lane with task start, which is a decision somebody makes rather than a lease that never ends."
      };
    }
    const expiresAt = bounded.expiresAt;
    append({
      eventType: "task.claim-renewed",
      actor: options.actor,
      occurredAt: now().toISOString(),
      payload: { claimId: claim.claimId, taskId, expiresAt }
    });

    const renewed = getClaim(store.db, claim.claimId);
    if (!renewed) throw new Error("Claim projection missing immediately after task.claim-renewed.");
    return { ok: true, claim: presentsRenew ? disclosableClaim(renewed) : renewed };
  });
}

/**
 * What a run event did to the lane's lease (T-143 / C4). Reported rather than
 * thrown: the event itself is the record the caller asked for, and whether it
 * also renewed is a second, independent answer.
 */
export type RunEventRenewal =
  | { renewed: true; claimId: string; taskId: string; expiresAt: string; cappedByCeiling: boolean }
  | {
      renewed: false;
      reason: "no-active-claim" | "ambiguous-claim" | "claim-expired" | "receipt-landed" | "stale-attempt" | "ceiling-reached";
      message: string;
    };

/**
 * T-143 (C4 / D3, 1C): renewal as a by-product of working, addressed by
 * `dispatchId` with no credential.
 *
 * This is deliberately secret-free, which is a trust decision and not an
 * oversight: anyone who can reach the local store already has that trust level
 * (§8), and the worst a spurious event can do is keep a lease alive a little
 * longer -- never seize it, never release it. What bounds a wedged agent is
 * the 24 h ceiling above, plus the attempt-chain warning from the other side.
 *
 * Runs inside the caller's write transaction, AFTER the event has been
 * appended, so the renewal is atomic with the evidence for it: there is no
 * state where the lease was extended by an event the journal does not hold.
 *
 * An event renews only when all of these hold. Each `renewed: false` reason is
 * a real case, not a defensive branch:
 * - the event's attempt IS the dispatch's latest. A late or replayed event
 *   from a superseded attempt is still journaled -- it happened, and the
 *   record is the point -- but extending whoever holds the claim NOW on the
 *   strength of a dead attempt's heartbeat is exactly the confusion §2 names;
 * - the latest attempt has no landed receipt. A lane that reported itself
 *   finished is over; keeping its lease alive would hold the task against a
 *   run that already ended;
 * - the task has exactly one active claim. Pre-C5 the partial unique index
 *   makes that an invariant; refusing to guess keeps it an index guarantee
 *   instead of a coincidence, and C5 is where `role` narrows the lookup;
 * - the claim is unexpired, and inside the ceiling.
 *
 * On the expired branch this writes NOTHING -- not even the
 * `task.claim-expired` that `renewClaim` journals there. The explicit path has
 * a caller who presented a credential and asked for a renewal, so recording
 * why it was refused is part of the answer; a liveness event is a by-product,
 * and a by-product that quietly journals claim lifecycle for a lane it does
 * not address is how audit trails fill with events nobody asked for. The next
 * admission, renewal or close journals that expiry honestly.
 *
 * **Implement-only until C5, and this is safe by construction rather than by
 * assertion.** Resolution is by `taskId` alone, which would be wrong once
 * shared review claims exist -- a heartbeat on a review dispatch must not
 * extend the implement lease. It cannot be wrong yet: `dispatchSchema` is a
 * plain `z.object` with no `.passthrough()`, so Zod DROPS a `kind` field, no
 * review dispatch can exist, and every dispatch that can exist resolves
 * unambiguously. C5 owns the role-aware resolver, and the test that a review
 * heartbeat renews nothing is not writable before it -- there is no way to
 * construct a review dispatch to write it against.
 */
export function appendRunEventClaimRenewal(
  store: StoreHandle,
  options: {
    dispatchId: string;
    attempt: number;
    actor: string;
    coordination?: CoordinationSettings;
    leaseDurationMs?: number;
    now?: () => Date;
  },
  append: (input: AppendEventInput) => EventLogEntry
): RunEventRenewal {
  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();

  const attempts = listDispatchAttempts(store.db, options.dispatchId);
  if (attempts.length === 0) {
    return {
      renewed: false,
      reason: "no-active-claim",
      message: `Unknown dispatch: ${options.dispatchId}.`
    };
  }
  const latestAttempt = Math.max(...attempts.map(attempt => attempt.attempt));
  if (options.attempt !== latestAttempt) {
    return {
      renewed: false,
      reason: "stale-attempt",
      message: `Event is on attempt ${options.attempt} while attempt ${latestAttempt} is the latest; it is recorded but renews nothing.`
    };
  }
  if (getRunReceipt(store.db, options.dispatchId, latestAttempt)) {
    return {
      renewed: false,
      reason: "receipt-landed",
      message: `Attempt ${latestAttempt} already has a receipt, so this lane is finished; the event is recorded but renews nothing.`
    };
  }

  const taskId = attempts[0]!.taskId;
  const active = listActiveClaimsForTask(store.db, taskId);
  if (active.length === 0) {
    return { renewed: false, reason: "no-active-claim", message: `${taskId} holds no active claim to renew.` };
  }
  if (active.length > 1) {
    return {
      renewed: false,
      reason: "ambiguous-claim",
      message: `${taskId} holds ${active.length} active claims; an event cannot choose between them. Renew the one you mean with task renew --claim <id>.`
    };
  }
  const claim = active[0]!;

  if (new Date(claim.expiresAt).getTime() <= nowMs) {
    return {
      renewed: false,
      reason: "claim-expired",
      message: `Claim ${claim.claimId} expired at ${claim.expiresAt}; re-claim the task with task start instead.`
        + ceilingNote(claim, nowMs)
    };
  }

  const leaseDurationMs = options.leaseDurationMs
    ?? deriveLeaseDurationMs({
      estimatedEffort: getTaskDetail(store.db, taskId)?.estimatedEffort,
      coordination: options.coordination
    });
  const bounded = ceilingBoundedExpiry(claim, nowMs, leaseDurationMs);
  if ("ceilingReached" in bounded) {
    return {
      renewed: false,
      reason: "ceiling-reached",
      message: `Claim ${claim.claimId} has been alive for the 24 h maximum (claimed ${claim.claimedAt}, ceiling ${bounded.ceilingAt});`
        + " no event extends it further. Release it and open a new lane with task start."
    };
  }

  append({
    eventType: "task.claim-renewed",
    actor: options.actor,
    occurredAt: now().toISOString(),
    payload: { claimId: claim.claimId, taskId, expiresAt: bounded.expiresAt }
  });

  return {
    renewed: true,
    claimId: claim.claimId,
    taskId,
    expiresAt: bounded.expiresAt,
    cappedByCeiling: bounded.cappedByCeiling
  };
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
    // Release is `leaseToken` ONLY -- there is no renewToken branch here, and
    // that absence is the capability split (D2). It is enforced by having no
    // code path, not by a check that could be relaxed. Compared in constant
    // time for the same reason renewal is.
    if (!credentialMatches(claim.leaseToken, options.leaseToken)) {
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
