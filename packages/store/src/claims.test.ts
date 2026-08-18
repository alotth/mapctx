import assert from "node:assert/strict"
import test from "node:test"
import { claimTask, releaseClaim, renewClaim } from "./claims"
import { StoreHandle } from "./store-handle"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

function seedOneTask(handle: StoreHandle): void {
  handle.appendEvent({
    eventType: "project.initialized",
    actor: "test",
    payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" }
  });
  handle.appendEvent({
    eventType: "task.upserted",
    actor: "test",
    payload: {
      task: {
        taskId: "T-001",
        positionKey: 0,
        title: "x",
        planningState: "backlog",
        executionState: "unclaimed",
        tags: [],
        domains: [],
        externalLinks: [],
        assignees: []
      }
    }
  });
}

test("claimTask: concurrent claims on the same task -- exactly one winner", () => {
  const dir = mkTmpDir("mapctx-store-claims-concurrency-");
  try {
    const h1 = StoreHandle.open(dir);
    seedOneTask(h1);
    const h2 = StoreHandle.open(dir); // simulates a second worktree/process against the same store

    const r1 = claimTask(h1, { taskId: "T-001", actor: "agent-1" });
    const r2 = claimTask(h2, { taskId: "T-001", actor: "agent-2" });

    assert.notEqual(r1.ok, r2.ok, "exactly one of the two racing claims must win");
    const winner = r1.ok ? r1 : (r2 as Extract<typeof r2, { ok: true }>);
    const loser = r1.ok ? r2 : r1;
    assert.equal(winner.ok, true);
    assert.equal(loser.ok, false);
    if (!loser.ok) assert.equal(loser.reason, "active-claim-held");

    h1.close();
    h2.close();
  } finally {
    cleanupDir(dir);
  }
});

test("renewClaim rejects a mismatched lease token and accepts the correct one", () => {
  const dir = mkTmpDir("mapctx-store-claims-renew-");
  try {
    const handle = StoreHandle.open(dir);
    seedOneTask(handle);
    const claimed = claimTask(handle, { taskId: "T-001", actor: "agent-1" });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;

    const wrongToken = renewClaim(handle, { taskId: "T-001", claimId: claimed.claim.claimId, leaseToken: "not-the-token", actor: "agent-1" });
    assert.equal(wrongToken.ok, false);
    if (!wrongToken.ok) assert.equal(wrongToken.reason, "token-mismatch");

    const correct = renewClaim(handle, { taskId: "T-001", claimId: claimed.claim.claimId, leaseToken: claimed.claim.leaseToken, actor: "agent-1" });
    assert.equal(correct.ok, true);

    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("releaseClaim frees the task for a new claim; a dead lease auto-expires on the next attempt", () => {
  const dir = mkTmpDir("mapctx-store-claims-lifecycle-");
  try {
    const handle = StoreHandle.open(dir);
    seedOneTask(handle);

    const claimed = claimTask(handle, { taskId: "T-001", actor: "agent-1" });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;

    const blocked = claimTask(handle, { taskId: "T-001", actor: "agent-2" });
    assert.equal(blocked.ok, false);

    const released = releaseClaim(handle, { taskId: "T-001", claimId: claimed.claim.claimId, leaseToken: claimed.claim.leaseToken, actor: "agent-1" });
    assert.equal(released.ok, true);

    const reclaimed = claimTask(handle, { taskId: "T-001", actor: "agent-2" });
    assert.equal(reclaimed.ok, true);

    // Expiry: claim with a short lease, then attempt again after it lapses.
    if (reclaimed.ok) {
      const releaseSecond = releaseClaim(handle, { taskId: "T-001", claimId: reclaimed.claim.claimId, leaseToken: reclaimed.claim.leaseToken, actor: "agent-2" });
      assert.equal(releaseSecond.ok, true);
    }

    const t0 = new Date("2026-01-01T00:00:00Z");
    const shortLease = claimTask(handle, { taskId: "T-001", actor: "agent-3", leaseDurationMs: 1000, now: () => t0 });
    assert.equal(shortLease.ok, true);

    const tLater = new Date("2026-01-01T00:00:05Z");
    const afterExpiry = claimTask(handle, { taskId: "T-001", actor: "agent-4", now: () => tLater });
    assert.equal(afterExpiry.ok, true);
    if (afterExpiry.ok && shortLease.ok) {
      assert.equal(afterExpiry.expiredPrevious, shortLease.claim.claimId);
    }

    handle.close();
  } finally {
    cleanupDir(dir);
  }
});
