import assert from "node:assert/strict"
import * as fs from "fs"
import * as path from "path"
import { spawn } from "node:child_process"
import test from "node:test"
import { appendRunEventClaimRenewal, claimTask, disclosableClaim, releaseClaim, renewClaim } from "./claims"
import { recordDispatchAttempt, recordRunEvent } from "./dispatch"
import { startTask } from "./start"
import { createTask, moveTask } from "./tasks"
import { getActiveExclusiveClaimForTask, getTask, listActiveClaimsForTask } from "./projections"
import { StoreHandle } from "./store-handle"
import { repairStore } from "./repair"
import { importCommit } from "./cutover"
import { cleanupDir, mkTmpDir, setupGoldenRepo } from "./__test-helpers__"

/**
 * T-144 (C5 / D5, D6, D11): the review lane as a first-class dispatch kind
 * and shared claim role. These tests isolate the delta on top of 6037bba --
 * the admission fix (review N1: `getActiveExclusiveClaimForTask` replacing
 * the unqualified `.get()`), lane-aware appliers, lane-fixed dispatchIds, and
 * the renewal lookup's liveness tiebreak (`resolveLaneClaim`, N2).
 */

function materialize() {
  const { repoDir, restoreEnv } = setupGoldenRepo();
  const committed = importCommit({ cwd: repoDir, actor: "test-actor" });
  const handle = StoreHandle.open(committed.storeDir);
  return { repoDir, restoreEnv, handle, committed };
}

function claimableTask(handle: StoreHandle, id: string, effort = "4h") {
  const created = createTask(handle, { id, title: `Lane task ${id}`, workload: "Normal", detail: { estimatedEffort: effort }, actor: "test" });
  assert.equal(created.ok, true, JSON.stringify(created));
  return id;
}

function eventsOf(handle: StoreHandle, eventType: string, taskId?: string) {
  return handle.listEvents().filter(e => e.eventType === eventType && (taskId === undefined || (e.payload as { taskId?: string }).taskId === taskId));
}

// ---------------------------------------------------------------------------
// 1. Review is never refused, and never causes the wrong refusal (N1).
// ---------------------------------------------------------------------------

test("N1: an implement claim request is never refused by a live review claim on the same task, in either lease order", () => {
  for (const reviewLeaseLonger of [true, false]) {
    const { repoDir, restoreEnv, handle } = materialize();
    try {
      claimableTask(handle, "T-700");
      const now = () => new Date("2026-10-16T09:00:00.000Z");
      const review = claimTask(handle, {
        taskId: "T-700", actor: "reviewer", kind: "review", now,
        leaseDurationMs: reviewLeaseLonger ? 8 * 60 * 60 * 1000 : 30 * 1000
      });
      assert.ok(review.ok, JSON.stringify(review));

      const implement = claimTask(handle, {
        taskId: "T-700", actor: "worker", kind: "implement", now,
        leaseDurationMs: reviewLeaseLonger ? 30 * 1000 : 8 * 60 * 60 * 1000
      });
      assert.equal(implement.ok, true, `implement claim must not be refused by a live review claim (reviewLeaseLonger=${reviewLeaseLonger}): ${JSON.stringify(implement)}`);
    } finally {
      handle.close(); restoreEnv(); cleanupDir(repoDir);
    }
  }
});

test("N1: a review claim request is never refused by a live implement claim on the same task, in either lease order", () => {
  for (const reviewLeaseLonger of [true, false]) {
    const { repoDir, restoreEnv, handle } = materialize();
    try {
      claimableTask(handle, "T-701");
      const now = () => new Date("2026-10-16T09:00:00.000Z");
      const implement = claimTask(handle, {
        taskId: "T-701", actor: "worker", kind: "implement", now,
        leaseDurationMs: reviewLeaseLonger ? 30 * 1000 : 8 * 60 * 60 * 1000
      });
      assert.ok(implement.ok, JSON.stringify(implement));

      const review = claimTask(handle, {
        taskId: "T-701", actor: "reviewer", kind: "review", now,
        leaseDurationMs: reviewLeaseLonger ? 8 * 60 * 60 * 1000 : 30 * 1000
      });
      assert.equal(review.ok, true, `review claim must not be refused by a live implement claim (reviewLeaseLonger=${reviewLeaseLonger}): ${JSON.stringify(review)}`);
    } finally {
      handle.close(); restoreEnv(); cleanupDir(repoDir);
    }
  }
});

test("N1: reclaiming an expired implement claim journals task.claim-expired naming the IMPLEMENT claim's id, never the review claim's, in either lease order", () => {
  for (const reviewLeaseLonger of [true, false]) {
    const { repoDir, restoreEnv, handle } = materialize();
    try {
      claimableTask(handle, "T-702");
      const claimedAt = () => new Date("2026-10-16T09:00:00.000Z");
      // The IMPLEMENT lease is always short, so it is always the one expired
      // at the probe instant -- what varies is whether the review lease is
      // still alive then (reviewLeaseLonger) or also already lapsed, to
      // prove the result never depends on the review lane's own state.
      const implementLeaseMs = 1000;
      const reviewLeaseMs = reviewLeaseLonger ? 8 * 60 * 60 * 1000 : 500;

      const implement = claimTask(handle, { taskId: "T-702", actor: "worker", kind: "implement", now: claimedAt, leaseDurationMs: implementLeaseMs });
      assert.ok(implement.ok, JSON.stringify(implement));
      const review = claimTask(handle, { taskId: "T-702", actor: "reviewer", kind: "review", now: claimedAt, leaseDurationMs: reviewLeaseMs });
      assert.ok(review.ok, JSON.stringify(review));
      if (!implement.ok || !review.ok) return;

      // Past the implement lease (1s), regardless of the review lease.
      const probeAt = () => new Date(new Date("2026-10-16T09:00:00.000Z").getTime() + implementLeaseMs + 500);

      const beforeExpired = eventsOf(handle, "task.claim-expired", "T-702").length;
      const reclaim = claimTask(handle, { taskId: "T-702", actor: "worker-2", kind: "implement", now: probeAt });
      assert.equal(reclaim.ok, true, JSON.stringify(reclaim));
      if (!reclaim.ok) return;
      assert.equal(reclaim.expiredPrevious, implement.claim.claimId, "the implement claim's id, not the review claim's");

      const expiredEvents = eventsOf(handle, "task.claim-expired", "T-702");
      assert.equal(expiredEvents.length, beforeExpired + 1, "exactly one new task.claim-expired");
      assert.equal((expiredEvents[expiredEvents.length - 1]!.payload as { claimId: string }).claimId, implement.claim.claimId);

      // The review claim, live or dead, is untouched by the reclaim: it is a
      // different lane, and claim admission never retires another lane's row.
      const reviewStillThere = listActiveClaimsForTask(handle.db, "T-702", { role: "review" });
      assert.equal(reviewStillThere.length, 1, "the review claim row is never retired by an implement reclaim");
      assert.equal(reviewStillThere[0]!.claimId, review.claim.claimId);
    } finally {
      handle.close(); restoreEnv(); cleanupDir(repoDir);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Replay reproduces the normalization of legacy (role/kind-absent) events
//    identically to the live path -- byte-identical (claim_id, exclusivity,
//    role) and (dispatch_id, attempt, kind), via repairStore.
// ---------------------------------------------------------------------------

test("replay via repairStore reproduces legacy (role/kind-absent) task.claimed and dispatch.attempted events as implement/exclusive, identically to the live append", () => {
  const { repoDir, restoreEnv, handle, committed } = materialize();
  try {
    claimableTask(handle, "T-703");

    // A hand-appended event shaped exactly like one of the 231 historical
    // task.claimed events T-144 migrates: no exclusivity, no role.
    const legacyClaimId = "33333333-3333-4333-8333-333333333333";
    handle.appendEvent({
      eventType: "task.claimed",
      actor: "worker",
      occurredAt: "2026-10-16T09:00:00.000Z",
      payload: {
        claimId: legacyClaimId,
        taskId: "T-703",
        leaseToken: "a".repeat(48),
        holder: {},
        claimedAt: "2026-10-16T09:00:00.000Z",
        expiresAt: "2026-10-16T09:30:00.000Z"
      }
    });

    // A hand-appended dispatch.attempted shaped like one of the 235 legacy
    // dispatch attempts: no kind.
    const legacyDispatchId = "44444444-4444-4444-8444-444444444444";
    handle.appendEvent({
      eventType: "dispatch.attempted",
      actor: "store",
      payload: {
        dispatch: {
          dispatchId: legacyDispatchId,
          taskId: "T-703",
          executorKind: "cli",
          attempt: 1,
          contextHash: "legacy-hash",
          status: "claimed"
        }
      }
    });

    const claimRowBefore = { ...(handle.db.prepare("SELECT claim_id, exclusivity, role FROM resource_claim_projection WHERE claim_id = ?").get(legacyClaimId) as Record<string, unknown>) };
    const dispatchRowBefore = { ...(handle.db.prepare("SELECT dispatch_id, attempt, kind FROM dispatch_projection WHERE dispatch_id = ?").get(legacyDispatchId) as Record<string, unknown>) };
    assert.deepEqual(claimRowBefore, { claim_id: legacyClaimId, exclusivity: "exclusive", role: "implement" });
    assert.deepEqual(dispatchRowBefore, { dispatch_id: legacyDispatchId, attempt: 1, kind: "implement" });

    handle.close();
    assert.equal(repairStore(committed.storeDir).status, "ok", "full rebuild from the journal alone");

    const replayed = StoreHandle.open(committed.storeDir);
    try {
      const claimRowAfter = { ...(replayed.db.prepare("SELECT claim_id, exclusivity, role FROM resource_claim_projection WHERE claim_id = ?").get(legacyClaimId) as Record<string, unknown>) };
      const dispatchRowAfter = { ...(replayed.db.prepare("SELECT dispatch_id, attempt, kind FROM dispatch_projection WHERE dispatch_id = ?").get(legacyDispatchId) as Record<string, unknown>) };
      assert.deepEqual(claimRowAfter, claimRowBefore, "replay reproduces the claim's lane fields identically to the live append");
      assert.deepEqual(dispatchRowAfter, dispatchRowBefore, "replay reproduces the dispatch's kind identically to the live append");
    } finally {
      replayed.close();
    }
  } finally {
    restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 3. Two-process contention for the exclusive implement slot; a review claim
//    joins in without disturbing either contender.
// ---------------------------------------------------------------------------

const workerImports = `
const fs = require('fs');
const { StoreHandle } = require(${JSON.stringify(path.join(__dirname, "store-handle.js"))});
const { startTask } = require(${JSON.stringify(path.join(__dirname, "start.js"))});
const { claimTask } = require(${JSON.stringify(path.join(__dirname, "claims.js"))});
const wait = p => { const until = Date.now() + 10000; while (!fs.existsSync(p)) { if (Date.now() > until) throw Error('barrier timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } };
`;

async function untilFile(file: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`Timeout waiting for ${file}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function worker(script: string) {
  const child = spawn(process.execPath, ["-e", workerImports + script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => stdout += b);
  child.stderr.on("data", b => stderr += b);
  const done = new Promise<string>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `worker exit ${code}`)));
  });
  void done.catch(() => {});
  return { child, done };
}

test("two processes racing task start on the same task: exactly one wins the exclusive implement slot, the other sees active-claim-held; a review claim joins alongside the winner undisturbed", async () => {
  const dir = mkTmpDir("mapctx-claim-lane-race-");
  const handle = StoreHandle.open(dir);
  claimableTask(handle, "T-704");
  handle.close();
  const go = path.join(dir, "go");
  const workers: ReturnType<typeof worker>[] = [];
  for (const name of ["one", "two"]) {
    workers.push(worker(`
const h = StoreHandle.open(${JSON.stringify(dir)});
const run = h.runInWriteTransaction.bind(h);
h.runInWriteTransaction = fn => { fs.writeFileSync(${JSON.stringify(path.join(dir, name))}, ''); wait(${JSON.stringify(go)}); return run(fn); };
console.log(JSON.stringify(startTask(h, { taskId: 'T-704', actor: ${JSON.stringify(name)}, kind: 'implement' })));
h.close();
`));
    await untilFile(path.join(dir, name));
  }
  try {
    await Promise.all(["one", "two"].map(name => untilFile(path.join(dir, name))));
    fs.writeFileSync(go, "");
    const results = (await Promise.all(workers.map(w => w.done))).map(s => JSON.parse(s));
    const winners = results.filter(r => r.ok);
    const losers = results.filter(r => !r.ok);
    assert.equal(winners.length, 1, `exactly one winner of the exclusive implement slot: ${JSON.stringify(results)}`);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason, "active-claim-held");

    const r = StoreHandle.open(dir);
    try {
      assert.ok(getActiveExclusiveClaimForTask(r.db, "T-704"), "exactly one active exclusive claim survives");
      const review = claimTask(r, { taskId: "T-704", actor: "reviewer", kind: "review" });
      assert.equal(review.ok, true, "a review claim joins alongside the implement winner without being refused");
      assert.ok(getActiveExclusiveClaimForTask(r.db, "T-704"), "the implement winner's claim is untouched by the review claim joining");
    } finally {
      r.close();
    }
  } finally {
    workers.forEach(w => w.child.kill());
    await Promise.all(workers.map(w => w.done.catch(() => {})));
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// 5. Heartbeat renewal, both sides (criterion 4), plus ambiguous-claim and
//    the ghost-never-competes tiebreak for review.
// ---------------------------------------------------------------------------

test("heartbeat i: a review dispatch's event with only a live implement claim present renews nothing (no-active-claim), implement expiresAt byte-identical, no task.claim-renewed", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-705");
    const now = () => new Date("2026-10-16T09:00:00.000Z");
    const implementStarted = startTask(handle, { taskId: "T-705", actor: "worker", kind: "implement", now, status: "running" });
    assert.ok(implementStarted.ok, JSON.stringify(implementStarted));
    if (!implementStarted.ok) return;

    const reviewDispatch = recordDispatchAttempt(handle, {
      dispatchId: "55555555-5555-4555-8555-555555555555", taskId: "T-705", executorKind: "cli", contextHash: "review-hash", attempt: 1, status: "running", kind: "review"
    }, "reviewer");
    assert.ok(reviewDispatch.ok, JSON.stringify(reviewDispatch));

    const implementExpiresAtBefore = getActiveExclusiveClaimForTask(handle.db, "T-705")!.expiresAt;
    const before = eventsOf(handle, "task.claim-renewed", "T-705").length;

    const result = appendRunEventClaimRenewal(
      handle,
      { dispatchId: reviewDispatch.dispatch.dispatchId, attempt: 1, actor: "reviewer", now },
      input => handle.appendEvent(input)
    );
    assert.equal(result.renewed, false);
    if (result.renewed) return;
    assert.equal(result.reason, "no-active-claim");

    assert.equal(eventsOf(handle, "task.claim-renewed", "T-705").length, before, "no task.claim-renewed journaled");
    assert.equal(getActiveExclusiveClaimForTask(handle.db, "T-705")!.expiresAt, implementExpiresAtBefore, "the implement claim's expiresAt is byte-identical before and after");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("heartbeat ii: with both an implement and a review claim live, a review dispatch's event renews ONLY the review claim; the implement claim's expiresAt is untouched", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-706");
    const now = () => new Date("2026-10-16T09:00:00.000Z");
    const implementStarted = startTask(handle, { taskId: "T-706", actor: "worker", kind: "implement", now, status: "running" });
    assert.ok(implementStarted.ok, JSON.stringify(implementStarted));
    if (!implementStarted.ok) return;
    const reviewStarted = startTask(handle, { taskId: "T-706", actor: "reviewer", kind: "review", now, status: "running" });
    assert.ok(reviewStarted.ok, JSON.stringify(reviewStarted));
    if (!reviewStarted.ok) return;

    const implementExpiresAtBefore = getActiveExclusiveClaimForTask(handle.db, "T-706")!.expiresAt;
    const laterNow = () => new Date("2026-10-16T09:10:00.000Z");

    const result = appendRunEventClaimRenewal(
      handle,
      { dispatchId: reviewStarted.dispatch.dispatchId, attempt: reviewStarted.dispatch.attempt, actor: "reviewer", now: laterNow },
      input => handle.appendEvent(input)
    );
    assert.equal(result.renewed, true, JSON.stringify(result));
    if (!result.renewed) return;
    assert.equal(result.claimId, reviewStarted.claim.claimId, "renews the REVIEW claim, not the implement one");

    assert.equal(getActiveExclusiveClaimForTask(handle.db, "T-706")!.expiresAt, implementExpiresAtBefore, "the implement claim's expiresAt is untouched by the review heartbeat");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("an implement dispatch's heartbeat does not renew a review claim on the same task", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-707");
    const now = () => new Date("2026-10-16T09:00:00.000Z");
    const implementStarted = startTask(handle, { taskId: "T-707", actor: "worker", kind: "implement", now, status: "running" });
    assert.ok(implementStarted.ok, JSON.stringify(implementStarted));
    if (!implementStarted.ok) return;
    const reviewClaim = claimTask(handle, { taskId: "T-707", actor: "reviewer", kind: "review", now });
    assert.ok(reviewClaim.ok, JSON.stringify(reviewClaim));
    if (!reviewClaim.ok) return;

    const reviewExpiresAtBefore = listActiveClaimsForTask(handle.db, "T-707", { role: "review" })[0]!.expiresAt;
    const laterNow = () => new Date("2026-10-16T09:10:00.000Z");

    const result = appendRunEventClaimRenewal(
      handle,
      { dispatchId: implementStarted.dispatch.dispatchId, attempt: implementStarted.dispatch.attempt, actor: "worker", now: laterNow },
      input => handle.appendEvent(input)
    );
    assert.equal(result.renewed, true, JSON.stringify(result));
    if (!result.renewed) return;
    assert.equal(result.claimId, implementStarted.claim.claimId, "renews the implement claim, not the review one");

    assert.equal(listActiveClaimsForTask(handle.db, "T-707", { role: "review" })[0]!.expiresAt, reviewExpiresAtBefore, "the review claim's expiresAt is untouched by the implement heartbeat");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("two LIVE review claims on the same task are ambiguous for renewal (unreachable before T-144, exercised here); the message names the review role", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-708");
    const now = () => new Date("2026-10-16T09:00:00.000Z");
    const first = claimTask(handle, { taskId: "T-708", actor: "reviewer-1", kind: "review", now });
    const second = claimTask(handle, { taskId: "T-708", actor: "reviewer-2", kind: "review", now });
    assert.ok(first.ok && second.ok, JSON.stringify({ first, second }));
    if (!first.ok || !second.ok) return;

    const ambiguous = renewClaim(handle, { taskId: "T-708", claimId: first.claim.claimId, leaseToken: first.claim.leaseToken, actor: "x", now });
    // Addressing by claimId is unambiguous (it names the exact row); the
    // ambiguity is reachable only through the dispatch-addressed path, which
    // resolves by role rather than by id.
    assert.equal(ambiguous.ok, true, "renewing by its own claimId is never ambiguous, even with a sibling review claim live");

    const dispatch = recordDispatchAttempt(handle, {
      dispatchId: "66666666-6666-4666-8666-666666666666", taskId: "T-708", executorKind: "cli", contextHash: "hash", attempt: 1, status: "running", kind: "review"
    }, "reviewer-1");
    assert.ok(dispatch.ok, JSON.stringify(dispatch));

    const viaDispatch = renewClaim(handle, { taskId: "T-708", dispatchId: dispatch.dispatch.dispatchId, leaseToken: first.claim.leaseToken, actor: "x", now });
    assert.equal(viaDispatch.ok, false, "the dispatch-addressed path cannot disambiguate two live review claims");
    if (viaDispatch.ok) return;
    assert.equal(viaDispatch.reason, "ambiguous-claim");
    assert.match(viaDispatch.message ?? "", /review/i, `the refusal must name the review lane: ${viaDispatch.message}`);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("a review claim's ambiguity via the run-event path also names the review role, and the gate's refusal activeClaim (if any) names the lane too", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-709");
    const now = () => new Date("2026-10-16T09:00:00.000Z");
    claimTask(handle, { taskId: "T-709", actor: "reviewer-1", kind: "review", now });
    claimTask(handle, { taskId: "T-709", actor: "reviewer-2", kind: "review", now });
    const dispatch = recordDispatchAttempt(handle, {
      dispatchId: "77777777-7777-4777-8777-777777777777", taskId: "T-709", executorKind: "cli", contextHash: "hash", attempt: 1, status: "running", kind: "review"
    }, "reviewer-1");
    assert.ok(dispatch.ok, JSON.stringify(dispatch));

    const result = appendRunEventClaimRenewal(
      handle,
      { dispatchId: dispatch.dispatch.dispatchId, attempt: 1, actor: "reviewer-1", now },
      input => handle.appendEvent(input)
    );
    assert.equal(result.renewed, false);
    if (result.renewed) return;
    assert.equal(result.reason, "ambiguous-claim");
    assert.match(result.message, /review/i, `the run-event refusal must name the review lane: ${result.message}`);
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("a review claim expired beside a live one is NOT ambiguous: the ghost never competes (liveness tiebreak)", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-710");
    const claimedAt = () => new Date("2026-10-16T09:00:00.000Z");
    const ghost = claimTask(handle, { taskId: "T-710", actor: "reviewer-1", kind: "review", now: claimedAt, leaseDurationMs: 1000 });
    assert.ok(ghost.ok, JSON.stringify(ghost));
    const later = () => new Date("2026-10-16T09:00:05.000Z"); // past the ghost's 1s lease
    const live = claimTask(handle, { taskId: "T-710", actor: "reviewer-2", kind: "review", now: later, leaseDurationMs: 8 * 60 * 60 * 1000 });
    assert.ok(live.ok, JSON.stringify(live));
    if (!ghost.ok || !live.ok) return;

    const dispatch = recordDispatchAttempt(handle, {
      dispatchId: "88888888-8888-4888-8888-888888888888", taskId: "T-710", executorKind: "cli", contextHash: "hash", attempt: 1, status: "running", kind: "review"
    }, "reviewer-2");
    assert.ok(dispatch.ok, JSON.stringify(dispatch));

    const result = appendRunEventClaimRenewal(
      handle,
      { dispatchId: dispatch.dispatch.dispatchId, attempt: 1, actor: "reviewer-2", now: later },
      input => handle.appendEvent(input)
    );
    assert.equal(result.renewed, true, `a ghost must never make the live review claim ambiguous: ${JSON.stringify(result)}`);
    if (!result.renewed) return;
    assert.equal(result.claimId, live.claim.claimId, "resolves to the live review claim, not the ghost");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 6. Lane-aware appliers.
// ---------------------------------------------------------------------------

test("releasing or expiring a REVIEW claim while implement is claimed/running leaves executionState untouched", () => {
  // "claimed" is the state that actually exercises the applier's reset
  // branch (it only ever resets FROM "claimed"), so it is the case that
  // would actually catch a role check removed from the applier; "running"
  // is included too because it is the state the design's own commentary
  // names, and it must stay untouched regardless.
  for (const executionState of ["claimed", "running"] as const) {
    for (const how of ["release", "expire"] as const) {
      const { repoDir, restoreEnv, handle } = materialize();
      try {
        claimableTask(handle, "T-711");
        const now = () => new Date("2026-10-16T09:00:00.000Z");
        const implementStarted = startTask(handle, { taskId: "T-711", actor: "worker", kind: "implement", now, status: executionState === "claimed" ? "claimed" : "running" });
        assert.ok(implementStarted.ok, JSON.stringify(implementStarted));
        if (!implementStarted.ok) return;
        const leaseDurationMs = how === "expire" ? 1000 : 8 * 60 * 60 * 1000;
        const review = claimTask(handle, { taskId: "T-711", actor: "reviewer", kind: "review", now, leaseDurationMs });
        assert.ok(review.ok, JSON.stringify(review));
        if (!review.ok) return;

        assert.equal(getTask(handle.db, "T-711")!.executionState, executionState);

        if (how === "release") {
          const released = releaseClaim(handle, { taskId: "T-711", claimId: review.claim.claimId, leaseToken: review.claim.leaseToken, actor: "reviewer" });
          assert.equal(released.ok, true, JSON.stringify(released));
        } else {
          // Expire it via a reclaim attempt on the review lane: review
          // admission does not retire ghosts itself (deliberately, see
          // claims.ts), so journal the expiry directly the way the renewal
          // paths do, to isolate the applier under test.
          handle.appendEvent({
            eventType: "task.claim-expired",
            actor: "system",
            occurredAt: new Date("2026-10-16T09:00:02.000Z").toISOString(),
            payload: { claimId: review.claim.claimId, taskId: "T-711" }
          });
        }

        assert.equal(getTask(handle.db, "T-711")!.executionState, executionState, `review claim ${how} must not reset executionState away from ${executionState}`);
      } finally {
        handle.close(); restoreEnv(); cleanupDir(repoDir);
      }
    }
  }
});

test("releasing or expiring the IMPLEMENT claim still returns executionState to unclaimed, exactly as before T-144", () => {
  for (const how of ["release", "expire"] as const) {
    const { repoDir, restoreEnv, handle } = materialize();
    try {
      claimableTask(handle, "T-712");
      const now = () => new Date("2026-10-16T09:00:00.000Z");
      const claimed = claimTask(handle, { taskId: "T-712", actor: "worker", kind: "implement", now, leaseDurationMs: how === "expire" ? 1000 : 8 * 60 * 60 * 1000 });
      assert.ok(claimed.ok, JSON.stringify(claimed));
      if (!claimed.ok) return;
      assert.equal(getTask(handle.db, "T-712")!.executionState, "claimed");

      if (how === "release") {
        const released = releaseClaim(handle, { taskId: "T-712", claimId: claimed.claim.claimId, leaseToken: claimed.claim.leaseToken, actor: "worker" });
        assert.equal(released.ok, true, JSON.stringify(released));
      } else {
        // Journal the expiry directly (as a reclaim or the renewal paths
        // would) rather than reclaiming: reclaiming would immediately mint a
        // NEW active implement claim afterward, which would carry
        // executionState straight back to "claimed" and defeat the point of
        // isolating the expire applier's own effect.
        handle.appendEvent({
          eventType: "task.claim-expired",
          actor: "system",
          occurredAt: new Date("2026-10-16T09:00:02.000Z").toISOString(),
          payload: { claimId: claimed.claim.claimId, taskId: "T-712" }
        });
      }

      assert.equal(getTask(handle.db, "T-712")!.executionState, "unclaimed", `implement claim ${how} must return executionState to unclaimed`);
    } finally {
      handle.close(); restoreEnv(); cleanupDir(repoDir);
    }
  }
});

test("a review claim on a backlog task does not carry planningState to in-progress, nor executionState to claimed", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-713");
    assert.equal(getTask(handle.db, "T-713")!.planningState, "backlog");
    assert.equal(getTask(handle.db, "T-713")!.executionState, "unclaimed");
    const review = claimTask(handle, { taskId: "T-713", actor: "reviewer", kind: "review" });
    assert.ok(review.ok, JSON.stringify(review));
    assert.equal(getTask(handle.db, "T-713")!.planningState, "backlog", "claiming the review lane must not move planningState");
    assert.equal(getTask(handle.db, "T-713")!.executionState, "unclaimed", "claiming the review lane must not move executionState either -- that scalar describes the implement run alone");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("a review dispatch against a running implementation does not throw and does not change executionState", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-714");
    const started = startTask(handle, { taskId: "T-714", actor: "worker", kind: "implement", status: "running" });
    assert.ok(started.ok, JSON.stringify(started));
    assert.equal(getTask(handle.db, "T-714")!.executionState, "running");

    assert.doesNotThrow(() => {
      const result = recordDispatchAttempt(handle, {
        dispatchId: "99999999-9999-4999-8999-999999999999", taskId: "T-714", executorKind: "cli", contextHash: "hash", attempt: 1, status: "running", kind: "review"
      }, "reviewer");
      assert.ok(result.ok, JSON.stringify(result));
    });
    assert.equal(getTask(handle.db, "T-714")!.executionState, "running", "a review dispatch must not touch executionState");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("a review dispatch on a never-claimed (unclaimed) task does not advance executionState to claimed", () => {
  // Distinct from the test above: here executionState and the review
  // dispatch's desiredExecution genuinely DIFFER (unclaimed vs claimed), so
  // the applier's lane guard is what actually prevents the move -- a guard
  // that silently no-ops because both sides already agree proves nothing.
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-719");
    assert.equal(getTask(handle.db, "T-719")!.executionState, "unclaimed");

    const result = recordDispatchAttempt(handle, {
      dispatchId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", taskId: "T-719", executorKind: "cli", contextHash: "hash", attempt: 1, status: "claimed", kind: "review"
    }, "reviewer");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(getTask(handle.db, "T-719")!.executionState, "unclaimed", "a review dispatch must never advance executionState, even from a state that differs from its own desiredExecution");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("the same guarantee holds at the raw new-event admission gate (assertNewEventAdmission via appendEvent): a review dispatch.attempted against a running implementation is admitted", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-715");
    const started = startTask(handle, { taskId: "T-715", actor: "worker", kind: "implement", status: "running" });
    assert.ok(started.ok, JSON.stringify(started));
    assert.equal(getTask(handle.db, "T-715")!.executionState, "running");

    assert.doesNotThrow(() => handle.appendEvent({
      eventType: "dispatch.attempted",
      actor: "reviewer",
      payload: {
        dispatch: {
          dispatchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          taskId: "T-715", executorKind: "cli", attempt: 1, contextHash: "hash", status: "running", kind: "review"
        }
      }
    }), "assertNewEventAdmission must admit a review dispatch against a running implementation");
    assert.equal(getTask(handle.db, "T-715")!.executionState, "running", "the raw admission path must not change executionState for a review dispatch");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("a task.claimed event whose exclusivity contradicts its role is refused BEFORE any claim row exists", () => {
  // The applier derives the (exclusivity, role) pair from `role` alone, but
  // `exclusivity` still rides on the event because it is what the index
  // predicate reads. A hand-written event asserting a pair that cannot exist
  // -- a SHARED implement claim, or an EXCLUSIVE review claim -- describes a
  // lane nothing downstream can reason about, so it is refused rather than
  // silently normalized to whichever field the applier happens to prefer.
  // The row must not exist afterwards: the refusal comes before the insert,
  // not merely inside a transaction that rolls one back.
  for (const [role, exclusivity] of [["implement", "shared"], ["review", "exclusive"]] as const) {
    const { repoDir, restoreEnv, handle } = materialize();
    try {
      claimableTask(handle, "T-722");
      const claimId = "22222222-2222-4222-8222-222222222222";
      assert.throws(
        () => handle.appendEvent({
          eventType: "task.claimed",
          actor: "worker",
          occurredAt: "2026-10-16T09:00:00.000Z",
          payload: {
            claimId,
            taskId: "T-722",
            leaseToken: "b".repeat(48),
            exclusivity,
            role,
            holder: {},
            claimedAt: "2026-10-16T09:00:00.000Z",
            expiresAt: "2026-10-16T09:30:00.000Z"
          }
        }),
        (error: Error) => {
          assert.match(error.message, new RegExp(claimId), error.message);
          assert.match(error.message, new RegExp(exclusivity), error.message);
          assert.match(error.message, new RegExp(role), error.message);
          return true;
        },
        `${exclusivity}/${role} is not a lane that exists`
      );
      assert.equal(
        handle.db.prepare("SELECT COUNT(*) AS n FROM resource_claim_projection WHERE claim_id = ?").get(claimId)!.n,
        0,
        "no claim row may exist for a refused contradictory event"
      );
    } finally {
      handle.close(); restoreEnv(); cleanupDir(repoDir);
    }
  }
});

// ---------------------------------------------------------------------------
// 7. `kind` fixed per dispatchId.
// ---------------------------------------------------------------------------

test("attempt N+1 with a contradictory kind is refused by name; omitting kind on N+1 inherits the dispatch's existing kind", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-716");
    const dispatchId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const first = recordDispatchAttempt(handle, {
      dispatchId, taskId: "T-716", executorKind: "cli", contextHash: "hash", attempt: 1, status: "running", kind: "review"
    }, "reviewer");
    assert.ok(first.ok, JSON.stringify(first));

    assert.throws(
      () => recordDispatchAttempt(handle, {
        dispatchId, taskId: "T-716", executorKind: "cli", contextHash: "hash-2", attempt: 2, status: "running", kind: "implement"
      }, "worker"),
      (error: Error) => {
        assert.match(error.message, new RegExp(dispatchId));
        assert.match(error.message, /review/);
        assert.match(error.message, /implement/);
        return true;
      }
    );

    const inherited = recordDispatchAttempt(handle, {
      dispatchId, taskId: "T-716", executorKind: "cli", contextHash: "hash-3", attempt: 2, status: "running"
    }, "reviewer");
    assert.equal(inherited.ok, true, JSON.stringify(inherited));
    if (inherited.ok) assert.equal(inherited.dispatch.kind, "review", "omitting kind on attempt N+1 inherits the existing kind");
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

// ---------------------------------------------------------------------------
// 9. Allowlist: a review claim refusal names the review lane too.
// ---------------------------------------------------------------------------

test("disclosableClaim on a review claim discloses exclusivity:shared, role:review, and never a token", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-717");
    const review = claimTask(handle, { taskId: "T-717", actor: "reviewer", kind: "review" });
    assert.ok(review.ok, JSON.stringify(review));
    if (!review.ok) return;
    const disclosed = disclosableClaim(review.claim);
    assert.equal(disclosed.exclusivity, "shared");
    assert.equal(disclosed.role, "review");
    assert.equal((disclosed as unknown as { leaseToken?: unknown }).leaseToken, undefined);
    assert.equal((disclosed as unknown as { renewToken?: unknown }).renewToken, undefined);
    assert.deepEqual(
      Object.keys(disclosed).sort(),
      ["claimId", "claimedAt", "eventNode", "eventSequence", "exclusivity", "expiresAt", "holder", "role", "state", "taskId"].sort()
    );
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("the requireActiveClaim gate's refusal names the review lane when a review dispatch finds no live review claim", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-718");
    assert.throws(
      () => recordDispatchAttempt(handle, {
        dispatchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", taskId: "T-718", executorKind: "cli", contextHash: "hash", attempt: 1, status: "running", kind: "review"
      }, "reviewer", true),
      (error: Error) => {
        assert.match(error.message, /review/, `the gate's refusal must name the review lane: ${error.message}`);
        return true;
      }
    );
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});

test("the requireActiveClaim gate checks the DISPATCH'S OWN lane: a live implement claim does not satisfy a review dispatch's gate, and vice versa", () => {
  const { repoDir, restoreEnv, handle } = materialize();
  try {
    claimableTask(handle, "T-720");
    const implement = claimTask(handle, { taskId: "T-720", actor: "worker", kind: "implement" });
    assert.ok(implement.ok, JSON.stringify(implement));

    // A live IMPLEMENT claim must not satisfy a REVIEW dispatch's gate.
    assert.throws(
      () => recordDispatchAttempt(handle, {
        dispatchId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", taskId: "T-720", executorKind: "cli", contextHash: "hash", attempt: 1, status: "running", kind: "review"
      }, "reviewer", true),
      /review/
    );

    claimableTask(handle, "T-721");
    const review = claimTask(handle, { taskId: "T-721", actor: "reviewer", kind: "review" });
    assert.ok(review.ok, JSON.stringify(review));

    // A live REVIEW claim must not satisfy an IMPLEMENT dispatch's gate.
    assert.throws(
      () => recordDispatchAttempt(handle, {
        dispatchId: "ffffffff-ffff-4fff-8fff-ffffffffffff", taskId: "T-721", executorKind: "cli", contextHash: "hash", attempt: 1, status: "running", kind: "implement"
      }, "worker", true),
      /implement/
    );
  } finally {
    handle.close(); restoreEnv(); cleanupDir(repoDir);
  }
});
