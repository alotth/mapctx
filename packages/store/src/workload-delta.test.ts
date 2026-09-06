import assert from "node:assert/strict"
import test from "node:test"
import { getDispatchAttempt, listWorkloadDeltaRows } from "./projections"
import { recordDispatchAttempt, recordRunReceipt } from "./dispatch"
import { applyEventToProjections } from "./events"
import { StoreHandle, resetProjectionsForRebuild } from "./store-handle"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

const DISPATCH_ID = "9b2e4d71-6c18-4a0f-b3d5-11aa22bb33cc"

function seedTask(handle: StoreHandle, taskId: string, workload: string | null): void {
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
        taskId,
        positionKey: 0,
        title: "x",
        workload,
        planningState: "in-progress",
        executionState: "claimed",
        tags: [],
        domains: [],
        externalLinks: [],
        assignees: []
      }
    }
  });
}

function reclassify(handle: StoreHandle, taskId: string, workload: string | null): void {
  handle.appendEvent({
    eventType: "task.patched",
    actor: "operator",
    payload: { taskId, patch: { workload }, source: "operator" }
  });
}

function dispatchInput(taskId: string, overrides: Record<string, unknown> = {}) {
  return {
    dispatchId: DISPATCH_ID,
    taskId,
    executorKind: "test",
    attempt: 1,
    contextHash: "hash",
    status: "claimed" as const,
    actor: "test",
    ...overrides
  };
}

function receipt() {
  return {
    schemaVersion: 1,
    dispatchId: DISPATCH_ID,
    attempt: 1,
    outcome: "completed" as const,
    startedAt: "2026-08-16T19:54:07.171Z",
    endedAt: "2026-08-16T19:55:07.171Z",
    changedFiles: ["tasks/T-001.md"],
    usageEvents: [],
    evidence: [],
    failure: null
  };
}

test("dispatch freezes the planned workload at hand-off; untagged stays null", () => {
  const dir = mkTmpDir("mapctx-store-workload-delta-1-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-001", "Easy");
    assert.equal(recordDispatchAttempt(handle, dispatchInput("T-001")).ok, true);
    assert.equal(getDispatchAttempt(handle.db, DISPATCH_ID, 1)?.workloadAtDispatch, "Easy");

    seedTask(handle, "T-002", null);
    assert.equal(recordDispatchAttempt(handle, dispatchInput("T-002", { dispatchId: "0a1b2c3d-4e5f-4a60-b1c2-d3e4f5a6b7c8" })).ok, true);
    assert.equal(getDispatchAttempt(handle.db, "0a1b2c3d-4e5f-4a60-b1c2-d3e4f5a6b7c8", 1)?.workloadAtDispatch, null);
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("client-supplied workloadAtDispatch is ignored -- the store stamps the board's belief", () => {
  const dir = mkTmpDir("mapctx-store-workload-delta-2-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-001", "Easy");
    const forged = dispatchInput("T-001", { workloadAtDispatch: "Extreme" });
    assert.equal(recordDispatchAttempt(handle, forged).ok, true);
    assert.equal(getDispatchAttempt(handle.db, DISPATCH_ID, 1)?.workloadAtDispatch, "Easy");
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("executorModel is captured as a raw fact when supplied, null otherwise", () => {
  const dir = mkTmpDir("mapctx-store-workload-delta-3-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-001", "Easy");
    assert.equal(recordDispatchAttempt(handle, dispatchInput("T-001", { executorModel: "glm-4.7" })).ok, true);
    assert.equal(getDispatchAttempt(handle.db, DISPATCH_ID, 1)?.executorModel, "glm-4.7");

    seedTask(handle, "T-002", null);
    assert.equal(recordDispatchAttempt(handle, dispatchInput("T-002", { dispatchId: "0a1b2c3d-4e5f-4a60-b1c2-d3e4f5a6b7c8" })).ok, true);
    assert.equal(getDispatchAttempt(handle.db, "0a1b2c3d-4e5f-4a60-b1c2-d3e4f5a6b7c8", 1)?.executorModel, null);
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("receipt freezes the discovered workload; planned stamp survives re-classification", () => {
  const dir = mkTmpDir("mapctx-store-workload-delta-4-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-001", "Easy");
    assert.equal(recordDispatchAttempt(handle, dispatchInput("T-001", { executorModel: "glm-4.7" })).ok, true);
    reclassify(handle, "T-001", "Hard");
    assert.equal(recordRunReceipt(handle, receipt(), "test").ok, true);

    const rows = listWorkloadDeltaRows(handle.db);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { planned: rows[0].plannedWorkload, atReceipt: rows[0].atReceiptWorkload, current: rows[0].currentWorkload },
      { planned: "Easy", atReceipt: "Hard", current: "Hard" }
    );
    assert.equal(rows[0].executorModel, "glm-4.7");

    // Late re-classification re-attributes the actual (last-wins pooling):
    // current moves, the frozen stamps do not.
    reclassify(handle, "T-001", "Extreme");
    const after = listWorkloadDeltaRows(handle.db)[0];
    assert.deepEqual(
      { planned: after.plannedWorkload, atReceipt: after.atReceiptWorkload, current: after.currentWorkload },
      { planned: "Easy", atReceipt: "Hard", current: "Extreme" }
    );
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("untagged runs never gain a guessed workload on either stamp", () => {
  const dir = mkTmpDir("mapctx-store-workload-delta-5-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-001", null);
    assert.equal(recordDispatchAttempt(handle, dispatchInput("T-001")).ok, true);
    reclassify(handle, "T-001", "Hard");
    assert.equal(recordRunReceipt(handle, receipt(), "test").ok, true);
    const row = listWorkloadDeltaRows(handle.db)[0];
    assert.equal(row.plannedWorkload, null);
    assert.equal(row.atReceiptWorkload, "Hard");
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("workload stamps survive projection rebuild from the event log", () => {
  const dir = mkTmpDir("mapctx-store-workload-delta-6-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-001", "Easy");
    assert.equal(recordDispatchAttempt(handle, dispatchInput("T-001", { executorModel: "glm-4.7" })).ok, true);
    reclassify(handle, "T-001", "Hard");
    assert.equal(recordRunReceipt(handle, receipt(), "test").ok, true);
    const before = listWorkloadDeltaRows(handle.db);

    resetProjectionsForRebuild(handle.db);
    for (const entry of handle.listEvents()) {
      applyEventToProjections(handle.db, entry);
    }
    assert.deepEqual(listWorkloadDeltaRows(handle.db), before);
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});
