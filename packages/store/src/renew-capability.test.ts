import assert from "node:assert/strict"
import * as crypto from "crypto"
import test from "node:test"
import {
  claimTask,
  releaseClaim,
  renewClaim,
  LEASE_TOKEN_PATTERN,
  LEASE_TOKEN_BYTES
} from "./claims"
import { recordDispatchAttempt, recordRunReceipt } from "./dispatch"
import { startTask } from "./start"
import { createTask } from "./tasks"
import { getClaim, getActiveExclusiveClaimForTask } from "./projections"
import { StoreHandle } from "./store-handle"
import { repairStore } from "./repair"
import { importCommit } from "./cutover"
import { cleanupDir, setupGoldenRepo } from "./__test-helpers__"

/**
 * T-142 / C3 (3fc253c): a claim gains a second, independent capability.
 * `leaseToken` renews and releases; `renewToken` only renews. `--dispatch`
 * is a LOOKUP (dispatch -> task -> that task's active claim), never the
 * token's scope. A legacy (pre-migration-12) claim has no renewToken and
 * never will.
 */

function materialize() {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  const committed = importCommit({ cwd: repoDir, actor: "test-actor" });
  const handle = StoreHandle.open(committed.storeDir);
  return { repoDir, restoreEnv, handle, committed };
}

function claimableTask(handle: StoreHandle, id: string, effort = "4h") {
  const created = createTask(handle, { id, title: `Claim task ${id}`, workload: "Normal", detail: { estimatedEffort: effort }, actor: "test" });
  assert.equal(created.ok, true, JSON.stringify(created));
  return id;
}

/** Scans a value (refusal payload, result, etc.) for anything token-shaped, anywhere in its JSON. */
function assertNoTokenLeak(value: unknown, label: string): void {
  const json = JSON.stringify(value);
  assert.ok(!LEASE_TOKEN_PATTERN.test(json), `${label}: token-shaped value leaked in ${json}`);
}

function claimReleasedEvents(handle: StoreHandle, taskId: string) {
  return handle.listEvents().filter(e => e.eventType === "task.claim-released" && (e.payload as { taskId: string }).taskId === taskId);
}

function claimExpiredEvents(handle: StoreHandle, taskId: string) {
  return handle.listEvents().filter(e => e.eventType === "task.claim-expired" && (e.payload as { taskId: string }).taskId === taskId);
}

function receiptFor(dispatchId: string, attempt: number, startedAt: string, endedAt: string) {
  return {
    schemaVersion: 1 as const,
    dispatchId,
    attempt,
    outcome: "completed" as const,
    startedAt,
    endedAt,
    changedFiles: ["README.md"],
    usageEvents: [],
    evidence: [],
    failure: null
  };
}

// ---------------------------------------------------------------------------
// 1. renewToken renews; leaseToken still renews; NEITHER releases without
// the lease token.
// ---------------------------------------------------------------------------

test("renewToken renews; leaseToken still renews; releasing with the renewToken in the lease slot is token-mismatch, claim stays active", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    const now = () => new Date("2026-10-15T09:00:00.000Z");
    claimableTask(handle, "T-900");
    const claim = claimTask(handle, { taskId: "T-900", actor: "worker", now });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;
    const { claimId, leaseToken, renewToken } = claim.claim;
    assert.ok(renewToken, "a freshly minted claim has a renewToken");

    const renewedWithRenewToken = renewClaim(handle, { taskId: "T-900", claimId, renewToken: renewToken!, actor: "orchestrator", now: () => new Date("2026-10-15T09:05:00.000Z") });
    assert.ok(renewedWithRenewToken.ok, JSON.stringify(renewedWithRenewToken));

    const renewedWithLeaseToken = renewClaim(handle, { taskId: "T-900", claimId, leaseToken, actor: "holder", now: () => new Date("2026-10-15T09:10:00.000Z") });
    assert.ok(renewedWithLeaseToken.ok, JSON.stringify(renewedWithLeaseToken));

    const released = releaseClaim(handle, { taskId: "T-900", claimId, leaseToken: renewToken!, actor: "orchestrator" });
    assert.equal(released.ok, false);
    if (!released.ok) assert.equal(released.reason, "token-mismatch");
    assert.ok(getActiveExclusiveClaimForTask(handle.db, "T-900"), "the claim stays active -- the renewToken has no release path at all");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 2. Wrong credential of the right type refuses as token-mismatch.
// ---------------------------------------------------------------------------

test("a wrong leaseToken and a wrong renewToken each refuse as token-mismatch", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-901");
    const claim = claimTask(handle, { taskId: "T-901", actor: "worker" });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;
    const { claimId } = claim.claim;
    const foreignToken = crypto.randomBytes(LEASE_TOKEN_BYTES).toString("hex");

    const wrongLease = renewClaim(handle, { taskId: "T-901", claimId, leaseToken: foreignToken, actor: "x" });
    assert.equal(wrongLease.ok, false);
    if (!wrongLease.ok) assert.equal(wrongLease.reason, "token-mismatch");

    const wrongRenew = renewClaim(handle, { taskId: "T-901", claimId, renewToken: foreignToken, actor: "x" });
    assert.equal(wrongRenew.ok, false);
    if (!wrongRenew.ok) assert.equal(wrongRenew.reason, "token-mismatch");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// Mutation-testing finding: credentialMatches must compare the WHOLE value,
// not a prefix, and must refuse (not throw) on a length mismatch. A prefix
// collision and a short/long credential are both deliberately built FROM the
// real token so a random foreign token (which already differs in the first
// byte) could never catch either regression.
// ---------------------------------------------------------------------------

test("matching the prefix is not enough: a wrong credential sharing the first 8 chars of the real one still refuses as token-mismatch (renew with either token, and release), and the claim is renewable with the real credential afterward", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-913");
    const claim = claimTask(handle, { taskId: "T-913", actor: "worker", now: () => new Date("2026-10-16T09:00:00.000Z") });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;
    const { claimId, leaseToken, renewToken } = claim.claim;

    // Same first 8 characters as the real token, everything after replaced --
    // a truncated comparison (e.g. stored.slice(0,8) === presented.slice(0,8))
    // would accept this; a full comparison must not.
    const prefixCollide = (real: string): string => {
      const collided = real.slice(0, 8) + "f".repeat(real.length - 8);
      assert.notEqual(collided, real, "sanity: the constructed value must actually differ from the real one");
      assert.equal(collided.length, real.length);
      return collided;
    };

    const leaseCollision = prefixCollide(leaseToken);
    const renewCollision = prefixCollide(renewToken!);

    const renewByLease = renewClaim(handle, { taskId: "T-913", claimId, leaseToken: leaseCollision, actor: "x" });
    assert.equal(renewByLease.ok, false);
    if (!renewByLease.ok) assert.equal(renewByLease.reason, "token-mismatch");

    const renewByRenew = renewClaim(handle, { taskId: "T-913", claimId, renewToken: renewCollision, actor: "x" });
    assert.equal(renewByRenew.ok, false);
    if (!renewByRenew.ok) assert.equal(renewByRenew.reason, "token-mismatch");

    const released = releaseClaim(handle, { taskId: "T-913", claimId, leaseToken: leaseCollision, actor: "x" });
    assert.equal(released.ok, false);
    if (!released.ok) assert.equal(released.reason, "token-mismatch");

    assert.ok(getActiveExclusiveClaimForTask(handle.db, "T-913"), "the claim must still be active after all three prefix-collision attempts");

    const renewedForReal = renewClaim(handle, { taskId: "T-913", claimId, leaseToken, actor: "x", now: () => new Date("2026-10-16T09:05:00.000Z") });
    assert.ok(renewedForReal.ok, "the real credential must still work after the collisions were refused");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("a credential of the wrong length (shorter or longer than the real one, same prefix) refuses as token-mismatch and never throws -- the length check guards timingSafeEqual's own exception", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-914");
    const claim = claimTask(handle, { taskId: "T-914", actor: "worker" });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;
    const { claimId, leaseToken, renewToken } = claim.claim;

    const shortCredential = leaseToken.slice(0, 10); // 10 hex chars: well short of the real width
    const longCredential = leaseToken + "00"; // two bytes longer, same prefix

    for (const badLength of [shortCredential, longCredential]) {
      let renewByLease: ReturnType<typeof renewClaim> | undefined;
      assert.doesNotThrow(() => { renewByLease = renewClaim(handle, { taskId: "T-914", claimId, leaseToken: badLength, actor: "x" }); }, `renew by leaseToken must refuse, not throw, for length ${badLength.length}`);
      assert.equal(renewByLease!.ok, false);
      if (!renewByLease!.ok) assert.equal(renewByLease!.reason, "token-mismatch");

      let renewByRenew: ReturnType<typeof renewClaim> | undefined;
      const badRenewCredential = badLength === shortCredential ? renewToken!.slice(0, 10) : renewToken! + "00";
      assert.doesNotThrow(() => { renewByRenew = renewClaim(handle, { taskId: "T-914", claimId, renewToken: badRenewCredential, actor: "x" }); }, `renew by renewToken must refuse, not throw, for length ${badRenewCredential.length}`);
      assert.equal(renewByRenew!.ok, false);
      if (!renewByRenew!.ok) assert.equal(renewByRenew!.reason, "token-mismatch");

      let released: ReturnType<typeof releaseClaim> | undefined;
      assert.doesNotThrow(() => { released = releaseClaim(handle, { taskId: "T-914", claimId, leaseToken: badLength, actor: "x" }); }, `release must refuse, not throw, for length ${badLength.length}`);
      assert.equal(released!.ok, false);
      if (!released!.ok) assert.equal(released!.reason, "token-mismatch");
    }

    assert.ok(getActiveExclusiveClaimForTask(handle.db, "T-914"), "the claim must still be active after every wrong-length attempt");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 3. invalid-request: zero or two addresses, zero or two credentials.
// ---------------------------------------------------------------------------

test("invalid-request: no address, both addresses, no credential, both credentials", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-902");
    const claim = claimTask(handle, { taskId: "T-902", actor: "worker" });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;
    const { claimId, leaseToken, renewToken } = claim.claim;

    const noAddress = renewClaim(handle, { taskId: "T-902", leaseToken, actor: "x" });
    assert.equal(noAddress.ok, false);
    if (!noAddress.ok) assert.equal(noAddress.reason, "invalid-request");

    const bothAddresses = renewClaim(handle, { taskId: "T-902", claimId, dispatchId: "irrelevant", leaseToken, actor: "x" });
    assert.equal(bothAddresses.ok, false);
    if (!bothAddresses.ok) assert.equal(bothAddresses.reason, "invalid-request");

    const noCredential = renewClaim(handle, { taskId: "T-902", claimId, actor: "x" });
    assert.equal(noCredential.ok, false);
    if (!noCredential.ok) assert.equal(noCredential.reason, "invalid-request");

    const bothCredentials = renewClaim(handle, { taskId: "T-902", claimId, leaseToken, renewToken: renewToken!, actor: "x" });
    assert.equal(bothCredentials.ok, false);
    if (!bothCredentials.ok) assert.equal(bothCredentials.reason, "invalid-request");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 4. Legacy claim: a task.claimed event with no renewToken (the honest
// route -- the applier, not raw SQL) projects to renew_token NULL.
// renew-token-unavailable, leaseToken still renews.
// ---------------------------------------------------------------------------

test("a legacy claim (task.claimed with no renewToken) refuses --renew-token as renew-token-unavailable; its leaseToken still renews", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-903");
    const claimId = crypto.randomUUID();
    const leaseToken = crypto.randomBytes(LEASE_TOKEN_BYTES).toString("hex");
    const claimedAt = "2026-10-15T09:00:00.000Z";
    const expiresAt = "2026-10-15T11:00:00.000Z";
    // The honest legacy path: a task.claimed payload with no renewToken field
    // at all, applied through the normal projection applier -- not a raw SQL
    // row. This is exactly what the 162 historical events in the real store
    // look like.
    handle.appendEvent({
      eventType: "task.claimed",
      actor: "worker",
      occurredAt: claimedAt,
      payload: { claimId, taskId: "T-903", leaseToken, holder: {}, claimedAt, expiresAt }
    });

    const row = getClaim(handle.db, claimId);
    assert.ok(row);
    assert.equal(row!.renewToken, null, "a legacy claim projects with no renewToken");

    const withRenewToken = renewClaim(handle, { taskId: "T-903", claimId, renewToken: crypto.randomBytes(LEASE_TOKEN_BYTES).toString("hex"), actor: "x", now: () => new Date("2026-10-15T09:30:00.000Z") });
    assert.equal(withRenewToken.ok, false);
    if (!withRenewToken.ok) assert.equal(withRenewToken.reason, "renew-token-unavailable");

    const withLeaseToken = renewClaim(handle, { taskId: "T-903", claimId, leaseToken, actor: "x", now: () => new Date("2026-10-15T09:30:00.000Z") });
    assert.ok(withLeaseToken.ok, JSON.stringify(withLeaseToken));
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 5. --dispatch resolves the active claim; both credentials renew through
// it; unknown-dispatch; task-id mismatch; receipt-landed; renews again
// after a new attempt is admitted.
// ---------------------------------------------------------------------------

test("renewal by dispatch: resolves the active claim with either credential; unknown-dispatch; task mismatch is invalid-request; receipt-landed after the latest attempt's receipt; renews again after a new attempt", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-904");
    claimableTask(handle, "T-905"); // a second, unrelated task for the mismatch case
    const claimedAt = () => new Date("2026-10-15T09:00:00.000Z");
    const started = startTask(handle, { taskId: "T-904", actor: "worker", now: claimedAt, status: "running" });
    assert.ok(started.ok, JSON.stringify(started));
    if (!started.ok) return;
    const { dispatch, claim } = started;
    const { leaseToken, renewToken } = claim;

    // Resolves and renews through either credential.
    const byLease = renewClaim(handle, { dispatchId: dispatch.dispatchId, leaseToken, actor: "x", now: () => new Date("2026-10-15T09:05:00.000Z") });
    assert.ok(byLease.ok, JSON.stringify(byLease));
    const byRenew = renewClaim(handle, { dispatchId: dispatch.dispatchId, renewToken: renewToken!, actor: "orchestrator", now: () => new Date("2026-10-15T09:10:00.000Z") });
    assert.ok(byRenew.ok, JSON.stringify(byRenew));

    // unknown-dispatch: no attempts exist for a fabricated id.
    const unknown = renewClaim(handle, { dispatchId: "00000000-0000-0000-0000-000000000000", leaseToken, actor: "x" });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.reason, "unknown-dispatch");

    // taskId passed alongside --dispatch is an ASSERTION, not an address:
    // a mismatch with the dispatch's real task refuses as invalid-request.
    const mismatch = renewClaim(handle, { dispatchId: dispatch.dispatchId, taskId: "T-905", leaseToken, actor: "x" });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.reason, "invalid-request");

    // receipt-landed: the latest (and only) attempt now has a receipt.
    const receipt = recordRunReceipt(handle, receiptFor(dispatch.dispatchId, dispatch.attempt, "2026-10-15T09:00:00.000Z", "2026-10-15T09:15:00.000Z"), "worker");
    assert.ok(receipt.ok, JSON.stringify(receipt));
    const afterReceipt = renewClaim(handle, { dispatchId: dispatch.dispatchId, leaseToken, actor: "x", now: () => new Date("2026-10-15T09:20:00.000Z") });
    assert.equal(afterReceipt.ok, false);
    if (!afterReceipt.ok) assert.equal(afterReceipt.reason, "receipt-landed");

    // Admitting a new attempt on the SAME dispatch re-opens renewal.
    const nextAttempt = recordDispatchAttempt(handle, {
      dispatchId: dispatch.dispatchId, taskId: "T-904", executorKind: "cli",
      contextHash: "retry-hash", attempt: dispatch.attempt + 1, status: "running"
    }, "worker");
    assert.ok(nextAttempt.ok, JSON.stringify(nextAttempt));
    const afterRetry = renewClaim(handle, { dispatchId: dispatch.dispatchId, leaseToken, actor: "x", now: () => new Date("2026-10-15T09:25:00.000Z") });
    assert.ok(afterRetry.ok, JSON.stringify(afterRetry));
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 6. A claim with no dispatch (plain claimTask): --claim/--token renews;
// a nonexistent dispatchId is never a side door.
// ---------------------------------------------------------------------------

test("a claim made without a dispatch renews by --claim/--token; a nonexistent dispatchId is not an alternate path to it", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-906");
    const claim = claimTask(handle, { taskId: "T-906", actor: "worker" });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;

    const byClaim = renewClaim(handle, { taskId: "T-906", claimId: claim.claim.claimId, leaseToken: claim.claim.leaseToken, actor: "x" });
    assert.ok(byClaim.ok, JSON.stringify(byClaim));

    const byFakeDispatch = renewClaim(handle, { dispatchId: crypto.randomUUID(), leaseToken: claim.claim.leaseToken, actor: "x" });
    assert.equal(byFakeDispatch.ok, false);
    if (!byFakeDispatch.ok) assert.equal(byFakeDispatch.reason, "unknown-dispatch");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 7. Expiration through the dispatch path matches the claim path: expired +
// task.claim-expired journaled, on both.
// ---------------------------------------------------------------------------

test("expiration journals task.claim-expired the same way whether addressed by --claim or by --dispatch", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-907");
    claimableTask(handle, "T-908");
    const claimedAt = () => new Date("2026-10-15T09:00:00.000Z");
    const afterExpiry = () => new Date("2026-10-15T09:00:02.000Z");

    // By --claim.
    const claim = claimTask(handle, { taskId: "T-907", actor: "worker", now: claimedAt, leaseDurationMs: 1000 });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;
    const expiredByClaim = renewClaim(handle, { taskId: "T-907", claimId: claim.claim.claimId, leaseToken: claim.claim.leaseToken, actor: "x", now: afterExpiry });
    assert.equal(expiredByClaim.ok, false);
    if (!expiredByClaim.ok) assert.equal(expiredByClaim.reason, "expired");
    assert.equal(claimExpiredEvents(handle, "T-907").length, 1);

    // By --dispatch.
    const started = startTask(handle, { taskId: "T-908", actor: "worker", now: claimedAt, leaseDurationMs: 1000, status: "running" });
    assert.ok(started.ok, JSON.stringify(started));
    if (!started.ok) return;
    const expiredByDispatch = renewClaim(handle, { dispatchId: started.dispatch.dispatchId, leaseToken: started.claim.leaseToken, actor: "x", now: afterExpiry });
    assert.equal(expiredByDispatch.ok, false);
    if (!expiredByDispatch.ok) assert.equal(expiredByDispatch.reason, "expired");
    assert.equal(claimExpiredEvents(handle, "T-908").length, 1);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 8. Result shape follows the credential, and no refusal ever leaks a
// token-shaped value.
// ---------------------------------------------------------------------------

test("with leaseToken the result carries both tokens; with renewToken it carries neither; no refusal anywhere leaks a token-shaped value", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-909");
    const claim = claimTask(handle, { taskId: "T-909", actor: "worker", now: () => new Date("2026-10-15T09:00:00.000Z") });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;
    const { claimId, leaseToken, renewToken } = claim.claim;

    const byLease = renewClaim(handle, { taskId: "T-909", claimId, leaseToken, actor: "x", now: () => new Date("2026-10-15T09:05:00.000Z") });
    assert.ok(byLease.ok, JSON.stringify(byLease));
    if (byLease.ok) {
      assert.ok("leaseToken" in byLease.claim && (byLease.claim as { leaseToken: string }).leaseToken);
      assert.ok("renewToken" in byLease.claim);
    }

    const byRenew = renewClaim(handle, { taskId: "T-909", claimId, renewToken: renewToken!, actor: "x", now: () => new Date("2026-10-15T09:10:00.000Z") });
    assert.ok(byRenew.ok, JSON.stringify(byRenew));
    if (byRenew.ok) {
      assert.ok(!("leaseToken" in byRenew.claim), `renewToken-credentialed result must carry no leaseToken: ${JSON.stringify(byRenew.claim)}`);
      assert.ok(!("renewToken" in byRenew.claim), `renewToken-credentialed result must carry no renewToken either: ${JSON.stringify(byRenew.claim)}`);
    }

    // Sweep every refusal reason this file can reach for a leaked token.
    const foreignToken = crypto.randomBytes(LEASE_TOKEN_BYTES).toString("hex");
    const refusals = [
      renewClaim(handle, { taskId: "T-909", leaseToken, actor: "x" }), // invalid-request: no address
      renewClaim(handle, { taskId: "T-909", claimId, actor: "x" }), // invalid-request: no credential
      renewClaim(handle, { taskId: "T-909", claimId, leaseToken: foreignToken, actor: "x" }), // token-mismatch
      renewClaim(handle, { dispatchId: crypto.randomUUID(), leaseToken, actor: "x" }) // unknown-dispatch
    ];
    for (const refusal of refusals) {
      assert.equal(refusal.ok, false);
      assertNoTokenLeak(refusal, `refusal ${JSON.stringify(refusal)}`);
    }
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 9. The two tokens are independent values, and distinct across claims.
// ---------------------------------------------------------------------------

test("renewToken and leaseToken are independent, both match LEASE_TOKEN_PATTERN, and all four values across two claims are pairwise distinct", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-910");
    claimableTask(handle, "T-911");
    const claimA = claimTask(handle, { taskId: "T-910", actor: "worker" });
    const claimB = claimTask(handle, { taskId: "T-911", actor: "worker" });
    assert.ok(claimA.ok && claimB.ok, JSON.stringify({ claimA, claimB }));
    if (!claimA.ok || !claimB.ok) return;

    const values = [claimA.claim.leaseToken, claimA.claim.renewToken!, claimB.claim.leaseToken, claimB.claim.renewToken!];
    for (const value of values) assert.match(value, LEASE_TOKEN_PATTERN);
    assert.equal(new Set(values).size, 4, "all four token values must be pairwise distinct");
    assert.notEqual(claimA.claim.leaseToken, claimA.claim.renewToken, "the two capabilities on the same claim are independent values");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 10. Replay: claim + renewal reproduce renew_token and the renewed
// expiresAt from the journal alone.
// ---------------------------------------------------------------------------

test("replay: after a claim and a renewal, repairStore + reopen reproduces renew_token and the renewed expiresAt", () => {
  const { repoDir, restoreEnv, handle, committed } = materialize();
  try {
    claimableTask(handle, "T-912");
    const claim = claimTask(handle, { taskId: "T-912", actor: "worker", now: () => new Date("2026-10-15T09:00:00.000Z") });
    assert.ok(claim.ok, JSON.stringify(claim));
    if (!claim.ok) return;
    const renewed = renewClaim(handle, { taskId: "T-912", claimId: claim.claim.claimId, leaseToken: claim.claim.leaseToken, actor: "x", now: () => new Date("2026-10-15T09:05:00.000Z") });
    assert.ok(renewed.ok, JSON.stringify(renewed));
    if (!renewed.ok) return;
    const renewedExpiresAt = (renewed.claim as { expiresAt: string }).expiresAt;
    handle.close();

    assert.equal(repairStore(committed.storeDir).status, "ok");
    const replayed = StoreHandle.open(committed.storeDir);
    try {
      const row = getClaim(replayed.db, claim.claim.claimId);
      assert.ok(row);
      assert.equal(row!.renewToken, claim.claim.renewToken, "replay reproduces renew_token from the journal");
      assert.equal(row!.expiresAt, renewedExpiresAt, "replay reproduces the renewed expiresAt, not the original");
    } finally {
      replayed.close();
    }
  } finally {
    restoreEnv(); cleanupDir(repoDir);
  }
});
