import assert from "node:assert/strict"
import * as fs from "fs"
import * as path from "path"
import test from "node:test"
import { claimTask } from "./claims"
import { recordDispatchAttempt, recordRunReceipt, listReceiptsForTask } from "./dispatch"
import { moveTask } from "./tasks"
import { approveAcceptanceCriterion, reviseAcceptance } from "./acceptance"
import { recordHistoryCorrection, recordHistoryEvidence } from "./history"
import { getTask, getHistoryEvidence, listHistoryEvidence, listHistoryCorrections, listInvalidatedReceiptKeys } from "./projections"
import { StoreHandle } from "./store-handle"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"
import type { RunReceipt } from "@mapctx/protocol"

function seedTask(handle: StoreHandle, taskId: string, planningState = "backlog"): void {
  fs.mkdirSync(path.join(handle.storeDir, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(handle.storeDir, "tasks", `${taskId}.md`), `# ${taskId}\n\n## Acceptance\n- [x] Test acceptance.\n`, "utf8");
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
        planningState,
        executionState: "unclaimed",
        workload: "Normal",
        detailPath: `./tasks/${taskId}.md`,
        tags: [],
        domains: [],
        externalLinks: [],
        assignees: []
      },
      detail: {
        taskId, role: "implementation", impact: "medium", estimatedEffort: "1d",
        prerequisites: [], blocking: [], filesAffected: [], testsRequired: [], summary: "x"
      }
    }
  });
}

function evidenceFor(taskId: string, sessionId: string, overrides: Partial<Parameters<typeof recordHistoryEvidence>[1]> = {}): Parameters<typeof recordHistoryEvidence>[1] {
  return {
    evidenceId: `ev-${taskId}-${sessionId}`,
    taskId,
    harness: "codex",
    sessionId,
    tier: "measured",
    confidence: "high",
    repoRoot: "/repo",
    repoOrigin: "/repo",
    signals: ["toolcall", "file-edit"],
    spanStart: "2026-09-13T13:00:00.000Z",
    spanEnd: "2026-09-13T15:00:00.000Z",
    activeMs: 3_600_000,
    sourceHash: "a".repeat(16),
    recordedAt: "2026-10-04T05:00:00.000Z",
    ...overrides
  };
}

/** Push a task through claim -> dispatch -> completed receipt the normal way. */
function completeWithReceipt(handle: StoreHandle, taskId: string, dispatchId: string): void {
  const claim = claimTask(handle, { taskId, actor: "executor" });
  assert.equal(claim.ok, true);
  assert.ok(claim.ok);
  const dispatch = recordDispatchAttempt(handle, {
    dispatchId, taskId, executorKind: "agent", attempt: 1, contextHash: "hash", status: "claimed"
  }, "executor");
  assert.equal(dispatch.ok, true);
  const receipt: RunReceipt = {
    schemaVersion: 1,
    dispatchId,
    attempt: 1,
    outcome: "completed",
    startedAt: "2026-09-20T10:00:00.000Z",
    endedAt: "2026-09-20T12:00:00.000Z",
    changedFiles: ["src/x.ts"],
    usageEvents: [],
    evidence: [],
    failure: null
  };
  const recorded = recordRunReceipt(handle, receipt, "executor");
  assert.equal(recorded.ok, true);
  approveAllCriteria(handle, taskId, ["Acceptance satisfied."]);
  const moved = moveTask(handle, { taskId, to: "done", actor: "human" });
  assert.equal(moved.ok, true, moved.ok ? "" : moved.reason);
}


/** T-120: the done gate reads store acceptance; tests author + approve it explicitly. */
function approveAllCriteria(handle: StoreHandle, taskId: string, texts: string[]): void {
  const revised = reviseAcceptance(handle, { taskId, condition: "criteria", texts, actor: "test", expectRevision: 0 });
  assert.ok(revised.ok, JSON.stringify(revised));
  if (!revised.ok) return;
  revised.criteria.forEach((criterion, index) => {
    const approved = approveAcceptanceCriterion(handle, { taskId, index, actor: "test", expectRevision: revised.revision });
    assert.ok(approved.ok, JSON.stringify(approved));
  });
}

test("history evidence records on a done task without any lifecycle mutation", () => {
  const dir = mkTmpDir("mapctx-store-history-done-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-001");
    completeWithReceipt(handle, "T-001", "11111111-1111-4111-8111-111111111111");
    const before = getTask(handle.db, "T-001")!;

    const result = recordHistoryEvidence(handle, evidenceFor("T-001", "s-done"), "history-scan");
    assert.equal(result.ok, true);

    const after = getTask(handle.db, "T-001")!;
    assert.equal(after.planningState, before.planningState);
    assert.equal(after.executionState, before.executionState);
    assert.equal(after.completedOn, before.completedOn);
    assert.equal(after.updatedOn, before.updatedOn);
    // No new claim/dispatch/receipt rows: evidence is the only write.
    assert.equal(listReceiptsForTask(handle.db, "T-001").length, 1);
    const rows = listHistoryEvidence(handle.db, "T-001");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "active");
    // Privacy shape: ids/hashes only, no content field exists to fill.
    assert.deepEqual(Object.keys(rows[0]).sort(), [
      "activeMs", "confidence", "evidenceId", "harness", "recordedAt", "repoOrigin", "repoRoot",
      "revisionEventNode", "revisionEventSequence", "sessionId", "signals", "sourceHash",
      "spanEnd", "spanStart", "status", "taskId", "tier"
    ]);
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("evidence registration is idempotent and refuses conflicting content", () => {
  const dir = mkTmpDir("mapctx-store-history-idem-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-002");
    const first = recordHistoryEvidence(handle, evidenceFor("T-002", "s1"));
    assert.equal(first.ok, true);
    assert.ok(first.ok && first.reactivated === false);
    // Identical re-record: no-op success.
    const again = recordHistoryEvidence(handle, evidenceFor("T-002", "s1"));
    assert.ok(again.ok);
    assert.equal(again.ok && again.reactivated, false);
    assert.equal(listHistoryEvidence(handle.db, "T-002").length, 1);
    // Different content under the same id: refused, needs correction first.
    const conflict = recordHistoryEvidence(handle, evidenceFor("T-002", "s1", { confidence: "low" }));
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.reason, "conflicting-evidence");
    // Different id: recorded as its own row.
    const second = recordHistoryEvidence(handle, evidenceFor("T-002", "s2"));
    assert.equal(second.ok, true);
    assert.equal(listHistoryEvidence(handle.db, "T-002").length, 2);
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("correction invalidates evidence and receipts; originals stay queryable; replay is faithful", () => {
  const dir = mkTmpDir("mapctx-store-history-correct-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-003");
    completeWithReceipt(handle, "T-003", "22222222-2222-4222-8222-222222222222");
    recordHistoryEvidence(handle, evidenceFor("T-003", "s-other-project"));

    // Correct the foreign receipt.
    const receiptCorrection = recordHistoryCorrection(handle, {
      correctionId: "cor-1",
      taskId: "T-003",
      targetKind: "receipt",
      targetId: "22222222-2222-4222-8222-222222222222/1",
      verdict: "invalid",
      reason: "session cwd belongs to another project",
      recordedAt: "2026-10-04T05:00:00.000Z"
    }, "auditor");
    assert.equal(receiptCorrection.ok, true);

    // Original receipt stays queryable and untouched.
    const receipts = listReceiptsForTask(handle.db, "T-003");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].outcome, "completed");
    // Invalidation key set feeds roadmap/calibration exclusions.
    assert.deepEqual([...listInvalidatedReceiptKeys(handle.db)], ["22222222-2222-4222-8222-222222222222/1"]);

    // Correct the evidence row.
    const evidenceCorrection = recordHistoryCorrection(handle, {
      correctionId: "cor-2",
      taskId: "T-003",
      targetKind: "evidence",
      targetId: "ev-T-003-s-other-project",
      verdict: "invalid",
      reason: "wrong project",
      recordedAt: "2026-10-04T05:01:00.000Z"
    }, "auditor");
    assert.equal(evidenceCorrection.ok, true);
    assert.equal(getHistoryEvidence(handle.db, "ev-T-003-s-other-project")?.status, "invalid");

    // Duplicate corrections are refused: first verdict stands.
    const duplicate = recordHistoryCorrection(handle, {
      correctionId: "cor-3",
      taskId: "T-003",
      targetKind: "receipt",
      targetId: "22222222-2222-4222-8222-222222222222/1",
      verdict: "invalid",
      reason: "again",
      recordedAt: "2026-10-04T05:02:00.000Z"
    }, "auditor");
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.reason, "already-corrected");

    // Target ownership is enforced.
    seedTask(handle, "T-004");
    const foreign = recordHistoryCorrection(handle, {
      correctionId: "cor-4",
      taskId: "T-004",
      targetKind: "receipt",
      targetId: "22222222-2222-4222-8222-222222222222/1",
      verdict: "invalid",
      reason: "not mine",
      recordedAt: "2026-10-04T05:03:00.000Z"
    }, "auditor");
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.reason, "unknown-target");

    // Re-approval after correction re-activates (new event, faithful replay).
    const reactivated = recordHistoryEvidence(handle, evidenceFor("T-003", "s-other-project"));
    assert.ok(reactivated.ok && reactivated.reactivated === true);
    assert.equal(getHistoryEvidence(handle.db, "ev-T-003-s-other-project")?.status, "active");

    // Replay from the journal reproduces rows and statuses.
    const corrections = listHistoryCorrections(handle.db);
    assert.equal(corrections.length, 2);
    handle.close();

    const reopened = StoreHandle.open(dir);
    assert.equal(getHistoryEvidence(reopened.db, "ev-T-003-s-other-project")?.status, "active");
    assert.equal((reopened.db.prepare("SELECT COUNT(*) AS n FROM history_correction_projection").get() as { n: number }).n, 2);
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

test("epic-owned history-scan receipts are correctable: canonical E-* targets, originals preserved", () => {
  const dir = mkTmpDir("mapctx-store-history-correct-epic-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "E-005");
    completeWithReceipt(handle, "E-005", "55555555-5555-4555-8555-555555555555");
    seedTask(handle, "E-001");
    const before = getTask(handle.db, "E-005")!;
    const receiptBefore = listReceiptsForTask(handle.db, "E-005")[0];

    // The live-recovery case (review attempt 7 follow-up): a history-scan
    // receipt owned by an EPIC with a proven foreign source. Correction
    // validation must accept canonical epic ids -- correction is an audit
    // verdict on an existing owned receipt, not execution of the epic.
    const correction = recordHistoryCorrection(handle, {
      correctionId: "cor-e1",
      taskId: "E-005",
      targetKind: "receipt",
      targetId: "55555555-5555-4555-8555-555555555555/1",
      verdict: "invalid",
      reason: "session cwd belongs to another project (epic-owned receipt)",
      recordedAt: "2026-10-04T06:00:00.000Z"
    }, "auditor");
    assert.equal(correction.ok, true, correction.ok ? "" : correction.message);

    // Originals unchanged and queryable; lifecycle untouched.
    const after = getTask(handle.db, "E-005")!;
    assert.equal(after.planningState, before.planningState);
    assert.equal(after.executionState, before.executionState);
    assert.equal(after.completedOn, before.completedOn);
    assert.deepEqual(listReceiptsForTask(handle.db, "E-005")[0], receiptBefore);
    assert.deepEqual([...listInvalidatedReceiptKeys(handle.db)], ["55555555-5555-4555-8555-555555555555/1"]);

    // Refusals stay refusals.
    const malformed = recordHistoryCorrection(handle, {
      correctionId: "cor-e2",
      taskId: "E-005",
      targetKind: "receipt",
      targetId: "55555555-5555-4555-8555-555555555555/0",
      verdict: "invalid",
      reason: "zero attempt is not canonical",
      recordedAt: "2026-10-04T06:01:00.000Z"
    }, "auditor");
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.match(malformed.message ?? "", /canonical/);

    const unknown = recordHistoryCorrection(handle, {
      correctionId: "cor-e3",
      taskId: "E-999",
      targetKind: "receipt",
      targetId: "55555555-5555-4555-8555-555555555555/1",
      verdict: "invalid",
      reason: "no such epic",
      recordedAt: "2026-10-04T06:02:00.000Z"
    }, "auditor");
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.reason, "unknown-task");

    const foreign = recordHistoryCorrection(handle, {
      correctionId: "cor-e4",
      taskId: "E-001",
      targetKind: "receipt",
      targetId: "55555555-5555-4555-8555-555555555555/1",
      verdict: "invalid",
      reason: "belongs to E-005, not E-001",
      recordedAt: "2026-10-04T06:03:00.000Z"
    }, "auditor");
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.reason, "unknown-target");

    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("evidence validation rejects malformed records", () => {
  const dir = mkTmpDir("mapctx-store-history-invalid-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-005");
    const backwards = recordHistoryEvidence(handle, evidenceFor("T-005", "s1", {
      spanStart: "2026-09-13T15:00:00.000Z",
      spanEnd: "2026-09-13T13:00:00.000Z"
    }));
    assert.equal(backwards.ok, false);
    if (!backwards.ok) assert.equal(backwards.reason, "invalid-evidence");
    const badHarness = recordHistoryEvidence(handle, evidenceFor("T-005", "s1", { harness: "irc" }));
    assert.equal(badHarness.ok, false);
    const unknownTask = recordHistoryEvidence(handle, evidenceFor("T-999", "s1"));
    assert.equal(unknownTask.ok, false);
    if (!unknownTask.ok) assert.equal(unknownTask.reason, "unknown-task");
    const noReason = recordHistoryCorrection(handle, {
      correctionId: "cor-5", taskId: "T-005", targetKind: "evidence",
      targetId: "missing", verdict: "invalid", reason: "  ", recordedAt: "2026-10-04T05:00:00.000Z"
    });
    assert.equal(noReason.ok, false);
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

// ---- T-116 review attempt 2: strict validation repros (findings 2 + 5) ----

test("review2 finding2: malformed receipt targets are refused before journaling", () => {
  const dir = mkTmpDir("mapctx-store-history-target-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-006");
    completeWithReceipt(handle, "T-006", "55555555-5555-4555-8555-555555555555");
    const before = listHistoryCorrections(handle.db).length;
    const badTargets = [
      "55555555-5555-4555-8555-555555555555/1/extra",
      "55555555-5555-4555-8555-555555555555/0",
      "55555555-5555-4555-8555-555555555555/-1",
      "55555555-5555-4555-8555-555555555555/NaN",
      "55555555-5555-4555-8555-555555555555/1.5",
      "555555555555555555555555555555555555555/1",
      "55555555-5555-4555-8555-555555555555/",
      "55555555-5555-4555-8555-555555555555"
    ];
    for (const [index, target] of badTargets.entries()) {
      const result = recordHistoryCorrection(handle, {
        correctionId: `cor-bad-${index}`,
        taskId: "T-006",
        targetKind: "receipt",
        targetId: target,
        verdict: "invalid",
        reason: "probe",
        recordedAt: "2026-10-04T05:00:00.000Z"
      }, "auditor");
      assert.equal(result.ok, false, `target ${target} must be refused`);
      if (!result.ok) assert.equal(result.reason, "invalid-correction", `target ${target}`);
    }
    assert.equal(listHistoryCorrections(handle.db).length, before, "no correction journaled");
    // Canonical form still works and actually excludes the receipt key.
    const good = recordHistoryCorrection(handle, {
      correctionId: "cor-good",
      taskId: "T-006",
      targetKind: "receipt",
      targetId: "55555555-5555-4555-8555-555555555555/1",
      verdict: "invalid",
      reason: "probe canonical",
      recordedAt: "2026-10-04T05:01:00.000Z"
    }, "auditor");
    assert.equal(good.ok, true);
    assert.deepEqual([...listInvalidatedReceiptKeys(handle.db)], ["55555555-5555-4555-8555-555555555555/1"]);
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("review2 finding5: impossible dates, bad activeMs, non-enum signals, extra keys all refused", () => {
  const dir = mkTmpDir("mapctx-store-history-schema-");
  try {
    const handle = StoreHandle.open(dir);
    seedTask(handle, "T-007");
    const cases: Array<[string, Parameters<typeof recordHistoryEvidence>[1]]> = [
      ["NaN date", evidenceFor("T-007", "s1", { spanStart: "2026-13-45T99:99:99.000Z" })],
      ["zero-length measured span", evidenceFor("T-007", "s1", {
        spanStart: "2026-09-13T15:00:00.000Z", spanEnd: "2026-09-13T15:00:00.000Z"
      })],
      ["negative activeMs", evidenceFor("T-007", "s1", { activeMs: -5 })],
      ["NaN activeMs", evidenceFor("T-007", "s1", { activeMs: Number.NaN })],
      ["Infinity activeMs", evidenceFor("T-007", "s1", { activeMs: Number.POSITIVE_INFINITY })],
      ["activeMs beyond span", evidenceFor("T-007", "s1", { activeMs: 10 * 3_600_000 + 1 })],
      ["measured without span", evidenceFor("T-007", "s1", { spanStart: null, spanEnd: null, activeMs: null })],
      ["transcript text in signals", evidenceFor("T-007", "s1", { signals: ["SUPERSECRET_CANARY_R3 leak"] })],
      ["unknown signal kind", evidenceFor("T-007", "s1", { signals: ["toolcall", "astral"] })]
    ];
    for (const [label, evidence] of cases) {
      const result = recordHistoryEvidence(handle, evidence);
      assert.equal(result.ok, false, `case ${label} must be refused`);
      if (!result.ok) assert.equal(result.reason, "invalid-evidence", `case ${label}: ${result.message ?? ""}`);
    }
    // Extra keys (arbitrary caller payload) are rejected outright.
    const polluted = evidenceFor("T-007", "s1") as Record<string, unknown>;
    polluted.transcriptExcerpt = "should never journal";
    const pollutedResult = recordHistoryEvidence(handle, polluted as never);
    assert.equal(pollutedResult.ok, false, "extra keys must be refused");
    // inferred tier must NOT imply measurement: activeMs set on inferred refused.
    const inferredWithMs = recordHistoryEvidence(handle, evidenceFor("T-007", "s1", {
      tier: "inferred", activeMs: 1234
    }));
    assert.equal(inferredWithMs.ok, false, "inferred evidence with activeMs implies measurement");
    // Valid inferred with null activeMs is fine.
    const inferred = recordHistoryEvidence(handle, evidenceFor("T-007", "s1", {
      tier: "inferred", activeMs: null, spanStart: null, spanEnd: null
    }));
    assert.equal(inferred.ok, true);
    assert.equal(listHistoryEvidence(handle.db, "T-007").length, 1);
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});
