import assert from "node:assert/strict"
import test from "node:test"
import { claimTask, releaseClaim, renewClaim } from "./claims"
import { recordDispatchAttempt, recordRunReceipt } from "./dispatch"
import { moveTask } from "./tasks"
import { getTask } from "./projections"
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

test("claimTask: claiming starts work -- backlog reaches in-progress through the legal path", () => {
  const { handle, cleanup } = (() => {
    const storeDir = mkTmpDir("mapctx-claims-");
    const handle = StoreHandle.open(storeDir);
    seedOneTask(handle);
    return { handle, cleanup: () => { handle.close(); cleanupDir(storeDir); } };
  })();
  try {
    const result = claimTask(handle, { taskId: "T-001", actor: "worker" });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.planningTransitionsTo, "in-progress");
    }
    const task = handle.db.prepare("SELECT planning_state FROM task_projection WHERE task_id = 'T-001'").get() as { planning_state: string };
    assert.equal(task.planning_state, "in-progress", "backlog -> ready -> in-progress, both hops recorded");
    // A second claimer sees the held lease, and the planning state is untouched.
    const second = claimTask(handle, { taskId: "T-001", actor: "other" });
    assert.equal(second.ok, false);
    assert.equal(getPlanningState(handle, "T-001"), "in-progress");
    function getPlanningState(h: StoreHandle, id: string): string {
      return (h.db.prepare("SELECT planning_state FROM task_projection WHERE task_id = ?").get(id) as { planning_state: string }).planning_state;
    }
  } finally {
    cleanup();
  }
});

test("claimTask: ready claims jump straight to in-progress; done tasks refuse to be claimed", () => {
  const storeDir = mkTmpDir("mapctx-claims-");
  const handle = StoreHandle.open(storeDir);
  try {
    seedOneTask(handle);
    // Move the task to ready, then claim: single hop expected.
    handle.appendEvent({
      eventType: "task.patched",
      actor: "test",
      payload: { taskId: "T-001", patch: { planningState: "ready" }, source: "test" }
    });
    const fromReady = claimTask(handle, { taskId: "T-001", actor: "worker" });
    assert.ok(fromReady.ok);
    if (fromReady.ok) assert.equal(fromReady.planningTransitionsTo, "in-progress");
    assert.equal((handle.db.prepare("SELECT planning_state FROM task_projection WHERE task_id = 'T-001'").get() as { planning_state: string }).planning_state, "in-progress");

    // Terminal state: claiming a done task is nonsense and must refuse.
    handle.appendEvent({
      eventType: "task.patched",
      actor: "test",
      payload: { taskId: "T-001", patch: { planningState: "done" }, source: "test" }
    });
    const fromDone = claimTask(handle, { taskId: "T-001", actor: "worker" });
    assert.equal(fromDone.ok, false);
    if (!fromDone.ok) assert.equal(fromDone.reason, "terminal-state");

    // Paused stays paused: unpausing is a human decision, not a lease side effect.
    handle.appendEvent({
      eventType: "task.upserted",
      actor: "test",
      payload: {
        task: {
          taskId: "T-002",
          positionKey: 1,
          title: "y",
          planningState: "paused",
          executionState: "unclaimed",
          tags: [],
          domains: [],
          externalLinks: [],
          assignees: []
        }
      }
    });
    const fromPaused = claimTask(handle, { taskId: "T-002", actor: "worker" });
    assert.ok(fromPaused.ok, "claiming a paused task is allowed");
    assert.equal((handle.db.prepare("SELECT planning_state FROM task_projection WHERE task_id = 'T-002'").get() as { planning_state: string }).planning_state, "paused", "paused must not auto-resume");
  } finally {
    handle.close();
    cleanupDir(storeDir);
  }
});

// R11: lease status and executor state are separate concerns. Releasing or
// expiring a lease underneath a live attempt must not silently reset the
// execution projection (the old code performed running -> unclaimed, which
// then made the attempt's later valid receipt unreceivable).
test("R11: releasing a lease under a running dispatch preserves execution and its receipt", () => {
  const dir = mkTmpDir("mapctx-store-claims-r11-release-");
  const handle = StoreHandle.open(dir);
  try {
    seedOneTask(handle);
    const claim = claimTask(handle, { taskId: "T-001", actor: "agent-1" });
    assert.ok(claim.ok);
    if (!claim.ok) return;

    const dispatchId = "6c1f5e2a-1111-4a0f-b3d5-11aa22bb33cc";
    const created = recordDispatchAttempt(handle, {
      dispatchId,
      taskId: "T-001",
      executorKind: "test",
      attempt: 1,
      contextHash: "hash",
      status: "running"
    }, "test");
    assert.equal(created.ok, true);
    assert.equal(getTask(handle.db, "T-001")?.executionState, "running");

    // The orchestrator loses its lease while the executor is mid-run.
    const released = releaseClaim(handle, { taskId: "T-001", claimId: claim.claim.claimId, leaseToken: claim.claim.leaseToken, actor: "test" });
    assert.equal(released.ok, true);
    assert.equal(getTask(handle.db, "T-001")?.executionState, "running", "release must not reset a running execution");

    // The executor's valid receipt must still be receivable.
    const receipt = recordRunReceipt(handle, {
      schemaVersion: 1,
      dispatchId,
      attempt: 1,
      outcome: "completed",
      startedAt: "2026-09-08T12:00:00.000Z",
      endedAt: "2026-09-08T12:05:00.000Z",
      changedFiles: [],
      usageEvents: [],
      evidence: [],
      failure: null
    }, "test", dispatchId);
    assert.equal(receipt.ok, true, `receipt must remain receivable: ${JSON.stringify(receipt)}`);
    assert.equal(getTask(handle.db, "T-001")?.executionState, "completed");
  } finally {
    handle.close();
    cleanupDir(dir);
  }
});

test("R11: a done task refuses both claim and fresh dispatch", () => {
  const dir = mkTmpDir("mapctx-store-claims-r11-terminal-");
  const handle = StoreHandle.open(dir);
  try {
    seedOneTask(handle);
    // Reach done through the only legal route: claim -> dispatch -> receipt.
    const claim = claimTask(handle, { taskId: "T-001", actor: "agent-1" });
    assert.ok(claim.ok);
    if (!claim.ok) return;
    const dispatchId = "6c1f5e2a-2222-4a0f-b3d5-11aa22bb33cc";
    assert.equal(recordDispatchAttempt(handle, {
      dispatchId,
      taskId: "T-001",
      executorKind: "test",
      attempt: 1,
      contextHash: "hash",
      status: "claimed"
    }, "test").ok, true);
    assert.equal(recordRunReceipt(handle, {
      schemaVersion: 1,
      dispatchId,
      attempt: 1,
      outcome: "completed",
      startedAt: "2026-09-08T12:00:00.000Z",
      endedAt: "2026-09-08T12:05:00.000Z",
      changedFiles: [],
      usageEvents: [],
      evidence: [],
      failure: null
    }, "test", dispatchId).ok, true);
    const moved = moveTask(handle, { taskId: "T-001", to: "done", actor: "reviewer" });
    assert.equal(moved.ok, true);
    void claim;

    const laterClaim = claimTask(handle, { taskId: "T-001", actor: "agent-2" });
    assert.equal(laterClaim.ok, false, "done tasks must refuse claims");
    if (!laterClaim.ok) assert.equal(laterClaim.reason, "terminal-state");

    assert.throws(
      () => recordDispatchAttempt(handle, {
        dispatchId: "6c1f5e2a-4444-4a0f-b3d5-11aa22bb33cc",
        taskId: "T-001",
        executorKind: "test",
        attempt: 1,
        contextHash: "hash",
        status: "claimed"
      }, "test"),
      /Cannot dispatch terminal task/
    );
  } finally {
    handle.close();
    cleanupDir(dir);
  }
});

test("R11: completed execution is not reset when planning moves to done", () => {
  const dir = mkTmpDir("mapctx-store-claims-r11-done-");
  const handle = StoreHandle.open(dir);
  try {
    seedOneTask(handle);
    const claim = claimTask(handle, { taskId: "T-001", actor: "agent-1" });
    assert.ok(claim.ok);
    if (!claim.ok) return;

    const dispatchId = "6c1f5e2a-3333-4a0f-b3d5-11aa22bb33cc";
    assert.equal(recordDispatchAttempt(handle, {
      dispatchId,
      taskId: "T-001",
      executorKind: "test",
      attempt: 1,
      contextHash: "hash",
      status: "claimed"
    }, "test").ok, true);
    assert.equal(recordRunReceipt(handle, {
      schemaVersion: 1,
      dispatchId,
      attempt: 1,
      outcome: "completed",
      startedAt: "2026-09-08T12:00:00.000Z",
      endedAt: "2026-09-08T12:05:00.000Z",
      changedFiles: [],
      usageEvents: [],
      evidence: [],
      failure: null
    }, "test", dispatchId).ok, true);

    const before = getTask(handle.db, "T-001");
    assert.equal(before?.planningState, "review");
    assert.equal(before?.executionState, "completed");

    moveTask(handle, { taskId: "T-001", to: "done", actor: "reviewer" });

    const after = getTask(handle.db, "T-001");
    assert.equal(after?.planningState, "done");
    assert.equal(after?.executionState, "completed", "closing the review loop must not erase the completed execution (R11: no completed -> unclaimed reset)");
  } finally {
    handle.close();
    cleanupDir(dir);
  }
});
