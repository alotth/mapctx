import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as path from "path"
import { type EventLogEntry, type RunReceipt } from "@mapctx/protocol"
import { listTasks, getDispatchAttempt, getTask, listHistoryCorrections, listHistoryEvidence, listRunReceipts } from "./projections"
import { acquireMaintenanceLock, MAINTENANCE_LOCK_STALE_MS, readMaintenanceLock } from "./maintenance"
import { payloadSha256, writeJournalEntrySync } from "./journal"
import { openDatabase } from "./db"
import { recordDispatchAttempt, recordRunReceipt } from "./dispatch"
import { intactDatabaseFloor as repairIntactDatabaseFloor, repairStore } from "./repair"
import { StoreHandle, storeDbIntegrityOk } from "./store-handle"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

function seedFiveTasks(handle: StoreHandle): void {
  handle.appendEvent({
    eventType: "project.initialized",
    actor: "test",
    payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" }
  });
  for (let i = 1; i <= 5; i++) {
    handle.appendEvent({
      eventType: "task.upserted",
      actor: "test",
      payload: {
        task: {
          taskId: `T-00${i}`,
          positionKey: i,
          title: `task ${i}`,
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
}

test("store repair rebuilds mapctx.db from the independent journal when the SQLite file is corrupt", () => {
  const dir = mkTmpDir("mapctx-store-repair-corrupt-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);
    handle.close();

    fs.writeFileSync(StoreHandle.dbPathFor(dir), "NOT A SQLITE FILE");
    assert.equal(storeDbIntegrityOk(dir), false);

    const result = repairStore(dir);
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.dbWasCorrupt, true);
      assert.equal(result.eventsReplayed, 6); // project.initialized + 5 task.upserted
    }

    assert.equal(storeDbIntegrityOk(dir), true);
    const reopened = StoreHandle.open(dir);
    assert.equal(listTasks(reopened.db).length, 5);
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

test("store repair reports a named gap for a missing journal entry and leaves mapctx.db untouched", () => {
  const dir = mkTmpDir("mapctx-store-repair-gap-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);
    const nodeId = handle.nodeId;
    handle.close();

    // Delete sequence 3 (project.initialized=1, task.upserted x5 = 2..6) --
    // a mid-history gap, not just a trailing one.
    fs.unlinkSync(path.join(dir, "events", nodeId, "3.json"));
    fs.writeFileSync(StoreHandle.dbPathFor(dir), "CORRUPT");

    const result = repairStore(dir);
    assert.equal(result.status, "gap");
    if (result.status === "gap") {
      assert.equal(result.gaps.length, 1);
      assert.equal(result.gaps[0].nodeId, nodeId);
      assert.equal(result.gaps[0].sequence, 3);
    }

    assert.equal(fs.readFileSync(StoreHandle.dbPathFor(dir), "utf8"), "CORRUPT", "a gap must abort before touching mapctx.db");
  } finally {
    cleanupDir(dir);
  }
});

test("store repair detects a fully-deleted trailing journal entry via the sequence watermark, not just directory listing", () => {
  const dir = mkTmpDir("mapctx-store-repair-watermark-");
  try {
    const handle = StoreHandle.open(dir);
    handle.appendEvent({
      eventType: "project.initialized",
      actor: "test",
      payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" }
    });
    const nodeId = handle.nodeId;
    handle.close();

    // Deleting the only (and therefore trailing) journal file makes
    // directory listing alone look like "nothing was ever written" --
    // the watermark in store-meta.json is what catches this.
    fs.unlinkSync(path.join(dir, "events", nodeId, "1.json"));
    fs.writeFileSync(StoreHandle.dbPathFor(dir), "CORRUPT");

    const result = repairStore(dir);
    assert.equal(result.status, "gap");
    if (result.status === "gap") {
      assert.equal(result.gaps.length, 1);
      assert.equal(result.gaps[0].sequence, 1);
    }
  } finally {
    cleanupDir(dir);
  }
});

test("store repair with an intact, non-corrupt store is a safe no-op reprojection", () => {
  const dir = mkTmpDir("mapctx-store-repair-noop-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);
    handle.close();

    const result = repairStore(dir);
    assert.equal(result.status, "ok");
    if (result.status === "ok") assert.equal(result.dbWasCorrupt, false);

    const reopened = StoreHandle.open(dir);
    assert.equal(listTasks(reopened.db).length, 5);
    reopened.close();
  } finally {
    cleanupDir(dir);
  }
});

// R12: repair swaps the database file, so a live maintenance lock must
// exclude openers and writers for the duration -- refused, never interleaved.
test("R12: live maintenance lock refuses open and writes; repair refuses too", () => {
  const dir = mkTmpDir("mapctx-store-repair-lock-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);

    const lock = acquireMaintenanceLock(dir);
    try {
      assert.throws(() => StoreHandle.open(dir), /under maintenance/, "open must refuse under a live maintenance lock");
      assert.throws(
        () => handle.appendEvent({ eventType: "task.upserted", actor: "test", payload: { task: { taskId: "T-099", positionKey: 99, title: "x", planningState: "backlog", executionState: "unclaimed", tags: [], domains: [], externalLinks: [], assignees: [] } } }),
        /under maintenance/,
        "a handle open across the lock must refuse new writes"
      );
      assert.throws(() => repairStore(dir), /under maintenance/, "repair must refuse a live holder");
    } finally {
      lock.release();
    }

    // After release everything works again and no event was lost or duplicated.
    assert.equal(repairStore(dir).status, "ok");
    handle.close();
    const reopened = StoreHandle.open(dir);
    try {
      assert.equal(listTasks(reopened.db).length, 5, "journal identity survived the refused writers untouched");
    } finally {
      reopened.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("R12: a stale maintenance lock left by a dead process is stolen, not a permanent brick", async () => {
  const dir = mkTmpDir("mapctx-store-repair-stale-lock-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);
    handle.close();

    // A PID that provably belongs to no live process.
    const child = (await import("child_process")).spawn("sleep", ["1"]);
    const deadPid = child.pid as number;
    child.kill("SIGKILL");
    await new Promise(resolve => child.once("exit", resolve));
    fs.writeFileSync(path.join(dir, "maintenance.lock"), JSON.stringify({ pid: deadPid, takenAt: "2026-09-08T00:00:00.000Z" }), "utf8");

    assert.equal(repairStore(dir).status, "ok", "a dead holder's lock must be stealable");
    const lock = readMaintenanceLock(dir);
    assert.equal(lock, null, "the stolen lock must not persist");
  } finally {
    cleanupDir(dir);
  }
});

// R12 review P2#1: a stale crash-dirty WAL must not survive the swap next to
// the replacement main DB -- SQLite would recover its frames against the
// replaced generation on the next open. Repair quiesces and removes the WAL
// set under the maintenance lock before the rename.
test("R12 P2#1: repair removes a stale -wal/-shm so the replacement is never paired with old frames", () => {
  const dir = mkTmpDir("mapctx-store-repair-stale-wal-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);
    handle.close();

    // Simulate a crash-dirty WAL: garbage -wal/-shm files beside a healthy
    // main DB (exactly what a kill mid-write leaves behind).
    fs.writeFileSync(`${StoreHandle.dbPathFor(dir)}-wal`, "STALE WAL FRAMES");
    fs.writeFileSync(`${StoreHandle.dbPathFor(dir)}-shm`, "STALE SHM");

    const result = repairStore(dir);
    assert.equal(result.status, "ok");

    assert.equal(fs.existsSync(`${StoreHandle.dbPathFor(dir)}-wal`), false, "no stale WAL may survive the repair");
    assert.equal(fs.existsSync(`${StoreHandle.dbPathFor(dir)}-shm`), false, "no stale SHM may survive the repair");
    assert.equal(storeDbIntegrityOk(dir), true);

    const reopened = StoreHandle.open(dir);
    try {
      assert.equal(listTasks(reopened.db).length, 5, "the replacement DB carries the replayed journal");
    } finally {
      reopened.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// T-075 P3#4: the age cap bounds PID-reuse bricking. A lock whose holder is
// alive but whose takenAt predates the age cap is stale by policy and must
// be stealable -- no permanent brick behind kill(pid,0) false positives.
test("R12 P3#4: an aged lock is stale even with a live PID, and open/write recover", () => {
  const dir = mkTmpDir("mapctx-store-repair-aged-lock-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);

    // Our own live PID, but a takenAt older than the age cap.
    fs.writeFileSync(
      path.join(dir, "maintenance.lock"),
      JSON.stringify({ pid: process.pid, takenAt: new Date(Date.now() - MAINTENANCE_LOCK_STALE_MS * 2).toISOString() }),
      "utf8"
    );

    // The lock itself says a live process holds it, but it is stale.
    const lock = acquireMaintenanceLock(dir);
    try {
      assert.throws(() => repairStore(dir), /under maintenance/, "the fresh lock still refuses a concurrent repair");
    } finally {
      lock.release();
    }
    handle.close();

    const reopened = StoreHandle.open(dir);
    try {
      assert.equal(listTasks(reopened.db).length, 5, "the aged lock was stolen, not a permanent brick");
    } finally {
      reopened.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---- T-118: repair replays historical multi-node dispatches without re-adjudicating them ----

const T118_NODE_A = "11111111-2222-4333-8444-555566667777";
const T118_NODE_B = "99999999-8888-4777-8666-555566667777";
const T118_DISPATCH_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const T118_CLAIM_ID = "c1a7f9b2-5d34-4e8f-9a6b-7c2d1e0f4a55";
const T118_EVIDENCE_ID = "e7a1c3b9-8d24-4f56-9b7a-1c3d5e7f9a11";
const T118_CORRECTION_ID = "b2d4f6a8-0c1e-4a3b-8d5c-7e9f1a3b5d70";

/** One journal entry, content-free synthetic, written straight into the journal. */
function t118Entry(
  storeDir: string,
  nodeId: string,
  sequence: number,
  logicalClock: number,
  eventType: string,
  payload: Record<string, unknown>,
  occurredAt = "2026-10-04T12:00:00.000Z"
): void {
  const entry: EventLogEntry = {
    nodeId,
    sequence,
    logicalClock,
    eventType,
    schemaVersion: 1,
    occurredAt,
    actor: "t118-fixture",
    causation: [],
    payload,
    payloadSha256: payloadSha256(payload)
  };
  writeJournalEntrySync(storeDir, entry);
}

/**
 * Minimal content-free two-node journal reproducing the T-090 history: a task
 * archived under pre-terminal admission rules (node A), then claimed and
 * dispatched from a DIFFERENT node (node B, interleaved by logical clock),
 * completed by receipt, moved to done, and given history evidence plus a
 * correction. Replay order is (logicalClock, nodeId, sequence), so the node B
 * dispatch lands between node A's claim and receipt exactly as in the real
 * failing journal.
 */
function seedT118TwoNodeJournal(dir: string): void {
  fs.mkdirSync(path.join(dir, "events", T118_NODE_A), { recursive: true });
  fs.mkdirSync(path.join(dir, "events", T118_NODE_B), { recursive: true });
  const task = { taskId: "T-F1", positionKey: 1, title: "t118 fixture", planningState: "backlog", executionState: "unclaimed", tags: [], domains: [], externalLinks: [], assignees: [] };
  t118Entry(dir, T118_NODE_A, 1, 1, "project.initialized", { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" });
  t118Entry(dir, T118_NODE_A, 2, 2, "task.upserted", { task, createOnly: true });
  // Historical fact: archived while that was still an admissible transition.
  t118Entry(dir, T118_NODE_A, 3, 3, "task.patched", { taskId: "T-F1", patch: { planningState: "archived" }, source: "legacy-import" });
  t118Entry(dir, T118_NODE_A, 4, 4, "task.claimed", { claimId: T118_CLAIM_ID, taskId: "T-F1", leaseToken: "t118-lease", holder: {}, claimedAt: "2026-10-04T12:00:01.000Z", expiresAt: "2026-10-04T12:30:01.000Z" });
  // The failing event, journaled on a second node: a dispatch admitted under
  // the older rules that allowed dispatching an archived task.
  t118Entry(dir, T118_NODE_B, 1, 5, "dispatch.attempted", { dispatch: { dispatchId: T118_DISPATCH_ID, taskId: "T-F1", executorKind: "traycer", attempt: 1, contextHash: "t118", status: "claimed", workloadAtDispatch: null, executorModel: null } });
  t118Entry(dir, T118_NODE_A, 5, 6, "run.receipt-recorded", { receipt: { schemaVersion: 1, dispatchId: T118_DISPATCH_ID, attempt: 1, outcome: "completed", startedAt: "2026-10-04T12:00:02.000Z", endedAt: "2026-10-04T12:10:02.000Z", changedFiles: [], usageEvents: [], evidence: [], failure: null }, workloadAtReceipt: null });
  t118Entry(dir, T118_NODE_A, 6, 7, "task.patched", { taskId: "T-F1", patch: { planningState: "done", completedOn: "2026-10-04" }, source: "alt" });
  t118Entry(dir, T118_NODE_A, 7, 8, "history.evidence-recorded", { evidence: { evidenceId: T118_EVIDENCE_ID, taskId: "T-F1", harness: "t118", sessionId: "s-t118", tier: "measured", confidence: "high", repoRoot: null, repoOrigin: null, signals: [], spanStart: "2026-10-04T12:00:02.000Z", spanEnd: "2026-10-04T12:10:02.000Z", activeMs: 600000, sourceHash: null, recordedAt: "2026-10-04T12:11:00.000Z" } });
  t118Entry(dir, T118_NODE_A, 8, 9, "history.correction-recorded", { correction: { correctionId: T118_CORRECTION_ID, taskId: "T-F1", targetKind: "evidence", targetId: T118_EVIDENCE_ID, verdict: "invalid", reason: "t118 fixture correction", recordedAt: "2026-10-04T12:12:00.000Z" } });
  // No SQLite database at all: repair must build one purely from the journal.
}

function t118ProjectionSnapshot(dbPath: string): string {
  const db = openDatabase(dbPath);
  try {
    return JSON.stringify({
      tasks: db.prepare("SELECT * FROM task_projection ORDER BY task_id").all(),
      dispatches: db.prepare("SELECT * FROM dispatch_projection ORDER BY dispatch_id, attempt").all(),
      receipts: db.prepare("SELECT * FROM run_receipt_projection ORDER BY dispatch_id, attempt").all(),
      evidence: db.prepare("SELECT * FROM history_evidence_projection ORDER BY evidence_id").all(),
      corrections: db.prepare("SELECT * FROM history_correction_projection ORDER BY correction_id").all(),
      eventLog: db.prepare("SELECT node_id, sequence FROM event_log ORDER BY node_id, sequence").all()
    });
  } finally {
    db.close();
  }
}

test("T-118: repair replays a historical dispatch on a then-legal terminal task from a multi-node journal", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-");
  try {
    seedT118TwoNodeJournal(dir);
    fs.writeFileSync(StoreHandle.dbPathFor(dir), "CORRUPT");

    const result = repairStore(dir);
    assert.equal(result.status, "ok", `repair must replay the legacy multi-node history: ${JSON.stringify(result)}`);
    if (result.status === "ok") assert.equal(result.eventsReplayed, 9);

    assert.equal(storeDbIntegrityOk(dir), true);
    const handle = StoreHandle.open(dir);
    try {
      const task = getTask(handle.db, "T-F1");
      assert.ok(task);
      assert.equal(task.planningState, "done", "the historical done state must survive replay");
      assert.equal(task.completedOn, "2026-10-04");
      assert.equal(task.executionState, "completed");

      // The historical imported dispatch is preserved as a queryable fact...
      const dispatch = getDispatchAttempt(handle.db, T118_DISPATCH_ID, 1);
      assert.ok(dispatch, "the historical dispatch row must survive replay");
      assert.equal(dispatch.status, "completed", "its receipt outcome must be projected");
      assert.equal(listRunReceipts(handle.db, T118_DISPATCH_ID).length, 1);

      // ...as are the history evidence and the correction that invalidates it.
      assert.equal(listHistoryEvidence(handle.db, "T-F1").length, 1);
      assert.equal(listHistoryEvidence(handle.db, "T-F1")[0].status, "invalid");
      assert.equal(listHistoryCorrections(handle.db, { taskId: "T-F1" }).length, 1);
    } finally {
      handle.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("T-118: repeated repair replay is deterministic", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-determinism-");
  try {
    seedT118TwoNodeJournal(dir);
    fs.writeFileSync(StoreHandle.dbPathFor(dir), "CORRUPT");

    const first = repairStore(dir);
    assert.equal(first.status, "ok");
    const snapshot1 = t118ProjectionSnapshot(StoreHandle.dbPathFor(dir));

    const second = repairStore(dir);
    assert.equal(second.status, "ok");
    if (first.status === "ok" && second.status === "ok") {
      assert.equal(first.eventsReplayed, second.eventsReplayed);
    }
    const snapshot2 = t118ProjectionSnapshot(StoreHandle.dbPathFor(dir));
    assert.equal(snapshot1, snapshot2, "replaying the same journal twice must produce identical projections");
  } finally {
    cleanupDir(dir);
  }
});

test("T-118: repair replay distinguishes imported historical dispatch from a forbidden NEW dispatch on a terminal task", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-admission-");
  try {
    seedT118TwoNodeJournal(dir);
    fs.writeFileSync(StoreHandle.dbPathFor(dir), "CORRUPT");
    assert.equal(repairStore(dir).status, "ok");

    const journalEventsBefore = fs.readdirSync(path.join(dir, "events", T118_NODE_A)).length
      + fs.readdirSync(path.join(dir, "events", T118_NODE_B)).length;

    // The replayed history is now projected; a FRESH dispatch attempt against
    // the same (now done) task must still be refused by live admission.
    const handle = StoreHandle.open(dir);
    try {
      assert.throws(
        () => recordDispatchAttempt(handle, { dispatchId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", taskId: "T-F1", executorKind: "traycer", attempt: 1, contextHash: "t118-new" }, "traycer"),
        /Cannot dispatch terminal task/,
        "fresh admission must keep rejecting dispatch onto a terminal task"
      );
    } finally {
      handle.close();
    }
    const journalEventsAfter = fs.readdirSync(path.join(dir, "events", T118_NODE_A)).length
      + fs.readdirSync(path.join(dir, "events", T118_NODE_B)).length;
    assert.equal(journalEventsAfter, journalEventsBefore, "the refused dispatch must not journal anything");
  } finally {
    cleanupDir(dir);
  }
});

// ---- T-118 attempt 2 review fixes ----

const T118_ORPHAN_NODE = "22222222-3333-4444-8555-666677778888";

function t118InsertOrphanEventLogRow(dbPath: string, taskId: string): void {
  const db = openDatabase(dbPath);
  try {
    const payload = { taskId, patch: { title: "orphaned indexed event" }, source: "t118-fixture" };
    db.prepare(`
      INSERT INTO event_log (
        node_id, sequence, logical_clock, event_type, schema_version, occurred_at,
        actor, causation_json, payload_json, payload_sha256, journal_path
      ) VALUES (?, 1, 1, 'task.patched', 1, '2026-10-04T00:00:00.000Z', 't118-fixture', '[]', ?, ?, '')
    `).run(T118_ORPHAN_NODE, JSON.stringify(payload), payloadSha256(payload));
  } finally {
    db.close();
  }
}

test("T-118 P1: repair fails closed with a named gap when an intact DB indexes a node absent from journal and watermarks", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-orphan-node-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);
    handle.close();

    const dbPath = StoreHandle.dbPathFor(dir);
    t118InsertOrphanEventLogRow(dbPath, "T-001");
    const dbBytesBefore = fs.readFileSync(dbPath);

    const result = repairStore(dir);
    assert.equal(result.status, "gap", "a DB-only node must fail repair closed, never be silently dropped");
    if (result.status === "gap") {
      const orphan = result.gaps.find(g => g.nodeId === T118_ORPHAN_NODE);
      assert.ok(orphan, "the orphan node must be named");
      assert.equal(orphan.sequence, 1, "its first missing sequence is reported");
    }

    assert.equal(fs.readFileSync(dbPath).equals(dbBytesBefore), true, "gap aborts before temp DB creation/swap; existing DB bytes untouched");
    const reopened = StoreHandle.open(dir);
    try {
      assert.equal(listTasks(reopened.db).length, 5, "existing DB stays usable and queryable");
      const orphanRows = reopened.db.prepare("SELECT COUNT(*) c FROM event_log WHERE node_id = ?").get(T118_ORPHAN_NODE) as { c: number };
      assert.equal(orphanRows.c, 1, "the orphaned history row is preserved, not discarded");
    } finally {
      reopened.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("T-118 P1: a corrupt database contributes no floor -- nodes are never derived from untrusted rows", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-corrupt-floor-");
  try {
    const handle = StoreHandle.open(dir);
    seedFiveTasks(handle);
    handle.close();

    const dbPath = StoreHandle.dbPathFor(dir);
    t118InsertOrphanEventLogRow(dbPath, "T-001");
    const intact = repairIntactDatabaseFloor(dbPath, false);
    assert.equal(intact[T118_ORPHAN_NODE], 1, "intact DB yields its indexed floor");

    fs.writeFileSync(dbPath, "CORRUPT");
    assert.deepEqual(repairIntactDatabaseFloor(dbPath, false), {}, "corrupt DB yields no floor");
    assert.deepEqual(repairIntactDatabaseFloor(path.join(dir, "missing.db"), false), {}, "missing DB yields no floor");

    const result = repairStore(dir);
    assert.equal(result.status, "ok");
    if (result.status === "ok") assert.equal(result.eventsReplayed, 6, "rebuild is journal-only (init + 5 upserts)");
    const reopened = StoreHandle.open(dir);
    try {
      const orphanRows = reopened.db.prepare("SELECT COUNT(*) c FROM event_log WHERE node_id = ?").get(T118_ORPHAN_NODE) as { c: number };
      assert.equal(orphanRows.c, 0, "untrusted corrupt rows cannot leak into the rebuild");
    } finally {
      reopened.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

const T118_UUID = "44444444-5555-4666-8777-888899990000";

function t118SeedTerminalTask(handle: StoreHandle, taskId: string): void {
  handle.appendEvent({ eventType: "project.initialized", actor: "test", payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" } });
  handle.appendEvent({ eventType: "task.upserted", actor: "test", payload: { task: { taskId, positionKey: 1, title: "term", planningState: "backlog", executionState: "unclaimed", tags: [], domains: [], externalLinks: [], assignees: [] } } });
  handle.appendEvent({ eventType: "task.patched", actor: "test", payload: { taskId, patch: { planningState: "archived" }, source: "test" } });
}

function t118CountJournalFiles(dir: string): number {
  const eventsDir = path.join(dir, "events");
  let count = 0;
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".json")) count++;
    }
  };
  if (fs.existsSync(eventsDir)) walk(eventsDir);
  return count;
}

test("T-118 P2: raw appendEvent refuses a fresh dispatch.attempted onto a terminal task and journals nothing", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-writer-dispatch-");
  try {
    const handle = StoreHandle.open(dir);
    t118SeedTerminalTask(handle, "T-TERM");
    const eventLogBefore = handle.db.prepare("SELECT COUNT(*) c FROM event_log").get() as { c: number };
    const journalBefore = t118CountJournalFiles(dir);

    assert.throws(
      () => handle.appendEvent({
        eventType: "dispatch.attempted",
        actor: "test",
        payload: { dispatch: { dispatchId: T118_UUID, taskId: "T-TERM", executorKind: "traycer", attempt: 1, contextHash: "x", status: "claimed" } }
      }),
      /Cannot dispatch terminal task: T-TERM/,
      "the public event writer must keep fresh-dispatch admission"
    );
    const eventLogAfter = handle.db.prepare("SELECT COUNT(*) c FROM event_log").get() as { c: number };
    assert.equal(eventLogAfter.c, eventLogBefore.c, "no event row may be written");
    handle.close();
    assert.equal(t118CountJournalFiles(dir), journalBefore, "nothing may be journaled");
  } finally {
    cleanupDir(dir);
  }
});

test("T-118 P2: runInWriteTransaction callback refuses a terminal dispatch and aborts the whole transaction", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-writer-callback-");
  try {
    const handle = StoreHandle.open(dir);
    t118SeedTerminalTask(handle, "T-TERM");
    const eventLogBefore = handle.db.prepare("SELECT COUNT(*) c FROM event_log").get() as { c: number };

    assert.throws(
      () => handle.runInWriteTransaction(append => {
        append({ eventType: "task.patched", actor: "test", payload: { taskId: "T-TERM", patch: { title: "unrelated" }, source: "test" } });
        append({
          eventType: "dispatch.attempted",
          actor: "test",
          payload: { dispatch: { dispatchId: T118_UUID, taskId: "T-TERM", executorKind: "traycer", attempt: 1, contextHash: "x", status: "claimed" } }
        });
      }),
      /Cannot dispatch terminal task: T-TERM/
    );
    const eventLogAfter = handle.db.prepare("SELECT COUNT(*) c FROM event_log").get() as { c: number };
    assert.equal(eventLogAfter.c, eventLogBefore.c, "the earlier event in the failed transaction must roll back too");
    handle.close();
    assert.equal(t118CountJournalFiles(dir), 3, "journal holds only the three seeded events");
  } finally {
    cleanupDir(dir);
  }
});

test("T-118 P2: raw writer refuses an illegal execution transition without the retry-admission reset", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-writer-execution-");
  try {
    const handle = StoreHandle.open(dir);
    handle.appendEvent({ eventType: "project.initialized", actor: "test", payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" } });
    handle.appendEvent({ eventType: "task.upserted", actor: "test", payload: { task: { taskId: "T-DONE", positionKey: 1, title: "done run", planningState: "review", executionState: "completed", tags: [], domains: [], externalLinks: [], assignees: [] } } });

    assert.throws(
      () => handle.appendEvent({
        eventType: "dispatch.attempted",
        actor: "test",
        payload: { dispatch: { dispatchId: T118_UUID, taskId: "T-DONE", executorKind: "traycer", attempt: 1, contextHash: "x", status: "claimed" } }
      }),
      /Illegal execution transition: completed -> claimed/,
      "a fresh dispatch without the journaled retry-admission reset must be refused by the writer"
    );
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("T-118 P2: raw writer refuses a completed receipt whose task is not in-progress or review", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-writer-receipt-");
  try {
    const handle = StoreHandle.open(dir);
    handle.appendEvent({ eventType: "project.initialized", actor: "test", payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" } });
    handle.appendEvent({ eventType: "task.upserted", actor: "test", payload: { task: { taskId: "T-RCPT", positionKey: 1, title: "receipt target", planningState: "backlog", executionState: "unclaimed", tags: [], domains: [], externalLinks: [], assignees: [] } } });
    const write = recordDispatchAttempt(handle, { dispatchId: T118_UUID, taskId: "T-RCPT", executorKind: "traycer", attempt: 1, contextHash: "x", status: "claimed" }, "test");
    assert.equal(write.ok, true);
    const eventLogBefore = handle.db.prepare("SELECT COUNT(*) c FROM event_log").get() as { c: number };

    assert.throws(
      () => handle.appendEvent({
        eventType: "run.receipt-recorded",
        actor: "test",
        payload: { receipt: { schemaVersion: 1, dispatchId: T118_UUID, attempt: 1, outcome: "completed", startedAt: "2026-10-04T12:00:00.000Z", endedAt: "2026-10-04T12:10:00.000Z", changedFiles: [], usageEvents: [], evidence: [], failure: null } }
      }),
      /completed receipts land in review from in-progress only/,
      "an invalid receipt planning transition must not bypass admission through the raw writer"
    );
    const eventLogAfter = handle.db.prepare("SELECT COUNT(*) c FROM event_log").get() as { c: number };
    assert.equal(eventLogAfter.c, eventLogBefore.c, "no receipt event may be written");
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("T-118 P2: crash-window reindex still projects already-journaled history without re-adjudication", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-reindex-replay-");
  try {
    // Journal an admitted history through the fixture writer (bypassing the
    // live handle): upsert, archive patch, claim, then a terminal dispatch --
    // exactly the pre-rules sequence repair and reindex must both replay.
    fs.mkdirSync(path.join(dir, "events", T118_NODE_A), { recursive: true });
    const task = { taskId: "T-RE", positionKey: 1, title: "reindex", planningState: "backlog", executionState: "unclaimed", tags: [], domains: [], externalLinks: [], assignees: [] };
    t118Entry(dir, T118_NODE_A, 1, 1, "project.initialized", { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" });
    t118Entry(dir, T118_NODE_A, 2, 2, "task.upserted", { task, createOnly: true });
    t118Entry(dir, T118_NODE_A, 3, 3, "task.patched", { taskId: "T-RE", patch: { planningState: "archived" }, source: "legacy-import" });
    t118Entry(dir, T118_NODE_A, 4, 4, "task.claimed", { claimId: T118_CLAIM_ID, taskId: "T-RE", leaseToken: "t118-lease", holder: {}, claimedAt: "2026-10-04T12:00:01.000Z", expiresAt: "2026-10-04T12:30:01.000Z" });
    t118Entry(dir, T118_NODE_A, 5, 5, "dispatch.attempted", { dispatch: { dispatchId: T118_DISPATCH_ID, taskId: "T-RE", executorKind: "traycer", attempt: 1, contextHash: "t118", status: "claimed", workloadAtDispatch: null, executorModel: null } });

    // No DB exists yet -- the crash-window case where everything lives only in
    // the journal. Reopen must reindex all five as admitted facts: no admission
    // re-check, no universal guard on the replay path.
    fs.writeFileSync(
      path.join(dir, "store-meta.json"),
      JSON.stringify({ nodeId: T118_NODE_A, incarnationId: "816d9e2a-d219-4d2f-84fc-159b74b2b173", createdAt: "2026-10-04T00:00:00.000Z", sequenceWatermarks: {} })
    );
    const handle = StoreHandle.open(dir);
    try {
      assert.equal(handle.nodeId, T118_NODE_A);
      const t = getTask(handle.db, "T-RE");
      assert.ok(t);
      assert.equal(t.planningState, "archived", "historical archive fact is projected");
      assert.equal(t.executionState, "claimed", "the historical terminal dispatch is replayed, not rejected");
      assert.ok(getDispatchAttempt(handle.db, T118_DISPATCH_ID, 1));
    } finally {
      handle.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---- T-118 attempt 3: receipt admission parity across ALL outcomes ----

const T118_RCPT_UUID = "55555555-6666-4777-8888-9999aaaabbbb";

/** Task with a live claimed dispatch; `archiveAfter` reproduces terminal-planning-with-live-dispatch history. */
function t118SeedForReceipt(handle: StoreHandle, taskId: string, planningState: string, archiveAfter = false): void {
  handle.appendEvent({ eventType: "project.initialized", actor: "test", payload: { projectId: "p1", boardTitle: "T", workDomains: [], notesMarkdown: "", plansAuthority: "markdown" } });
  handle.appendEvent({ eventType: "task.upserted", actor: "test", payload: { task: { taskId, positionKey: 1, title: "receipt parity", planningState: "in-progress", executionState: "unclaimed", tags: [], domains: [], externalLinks: [], assignees: [] } } });
  const write = recordDispatchAttempt(handle, { dispatchId: T118_RCPT_UUID, taskId, executorKind: "traycer", attempt: 1, contextHash: "x", status: "claimed" }, "test");
  if (!write.ok) throw new Error(`seed dispatch failed: ${write.reason}`);
  if (archiveAfter) {
    handle.appendEvent({ eventType: "task.patched", actor: "test", payload: { taskId, patch: { planningState }, source: "test" } });
  }
}

function t118Receipt(outcome: "completed" | "blocked" | "failed"): RunReceipt {
  return {
      schemaVersion: 1,
      dispatchId: T118_RCPT_UUID,
      attempt: 1,
      outcome,
      startedAt: "2026-10-04T12:00:00.000Z",
      endedAt: "2026-10-04T12:10:00.000Z",
      changedFiles: [],
      usageEvents: [],
      evidence: [],
    failure: outcome === "failed" ? { category: "executor-error", message: "t118 parity fixture", retryable: true } : null
  } as RunReceipt;
}

function t118ReceiptPayload(outcome: "completed" | "blocked" | "failed"): { receipt: RunReceipt } {
  return { receipt: t118Receipt(outcome) };
}

test("T-118 P2a: blocked receipt on a terminal-planning task is refused by BOTH command and raw writer, journaling nothing", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-receipt-blocked-");
  try {
    // Command side first: recordRunReceipt throws for archived -> blocked.
    const cmdDir = mkTmpDir("mapctx-store-repair-t118-receipt-blocked-cmd-");
    let commandError: unknown;
    try {
      const handle = StoreHandle.open(cmdDir);
      t118SeedForReceipt(handle, "T-BLK", "archived", true);
      assert.throws(
        () => recordRunReceipt(handle, t118Receipt("blocked"), "test"),
        /Illegal planning transition: archived -> blocked/,
        "command admission must refuse archived -> blocked"
      );
      handle.close();
    } finally {
      cleanupDir(cmdDir);
    }

    // Raw side must match exactly.
    const handle = StoreHandle.open(dir);
    t118SeedForReceipt(handle, "T-BLK", "archived", true);
    const eventLogBefore = handle.db.prepare("SELECT COUNT(*) c FROM event_log").get() as { c: number };
    const journalBefore = t118CountJournalFiles(dir);
    assert.throws(
      () => handle.appendEvent({ eventType: "run.receipt-recorded", actor: "test", payload: t118ReceiptPayload("blocked") }),
      /Illegal planning transition: archived -> blocked/,
      "raw writer must apply the same planning admission as the command path"
    );
    const eventLogAfter = handle.db.prepare("SELECT COUNT(*) c FROM event_log").get() as { c: number };
    assert.equal(eventLogAfter.c, eventLogBefore.c, "no receipt event may be written");
    handle.close();
    assert.equal(t118CountJournalFiles(dir), journalBefore, "nothing may be journaled");
  } finally {
    cleanupDir(dir);
  }
});

test("T-118 P2a: a composed transaction rolls back fully when its raw blocked receipt is refused", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-receipt-blocked-tx-");
  try {
    const handle = StoreHandle.open(dir);
    t118SeedForReceipt(handle, "T-BLK", "archived", true);
    const eventLogBefore = handle.db.prepare("SELECT COUNT(*) c FROM event_log").get() as { c: number };
    assert.throws(
      () => handle.runInWriteTransaction(append => {
        append({ eventType: "task.patched", actor: "test", payload: { taskId: "T-BLK", patch: { title: "before receipt" }, source: "test" } });
        append({ eventType: "run.receipt-recorded", actor: "test", payload: t118ReceiptPayload("blocked") });
      }),
      /Illegal planning transition: archived -> blocked/
    );
    const eventLogAfter = handle.db.prepare("SELECT COUNT(*) c FROM event_log").get() as { c: number };
    assert.equal(eventLogAfter.c, eventLogBefore.c, "the earlier patch in the failed transaction must roll back too");
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});

test("T-118 P2a: failed receipt parity -- in-progress/blocked tasks accept it via both command and raw writer", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-receipt-failed-");
  const cmdDir = mkTmpDir("mapctx-store-repair-t118-receipt-failed-cmd-");
  try {
    const handle = StoreHandle.open(cmdDir);
    t118SeedForReceipt(handle, "T-FAIL", "in-progress");
    const cmd = recordRunReceipt(handle, t118Receipt("failed"), "test");
    assert.equal(cmd.ok, true, "command path accepts failed from in-progress (target ready via blocked hop)");
    handle.close();

    const raw = StoreHandle.open(dir);
    t118SeedForReceipt(raw, "T-FAIL", "in-progress");
    raw.appendEvent({ eventType: "run.receipt-recorded", actor: "test", payload: t118ReceiptPayload("failed") });
    const t = getTask(raw.db, "T-FAIL");
    assert.ok(t);
    assert.equal(t.executionState, "failed");
    raw.close();
  } finally {
    cleanupDir(dir);
    cleanupDir(cmdDir);
  }
});

test("T-118 P2a: completed receipt parity -- refusal reason is identical on both paths", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-receipt-completed-");
  const cmdDir = mkTmpDir("mapctx-store-repair-t118-receipt-completed-cmd-");
  try {
    const handle = StoreHandle.open(cmdDir);
    t118SeedForReceipt(handle, "T-CMP", "archived", true);
    const cmd = recordRunReceipt(handle, t118Receipt("completed"), "test");
    assert.equal(cmd.ok, false);
    if (!cmd.ok) assert.match(cmd.message ?? "", /completed receipts land in review from in-progress only/);
    handle.close();

    const raw = StoreHandle.open(dir);
    t118SeedForReceipt(raw, "T-CMP", "archived", true);
    assert.throws(
      () => raw.appendEvent({ eventType: "run.receipt-recorded", actor: "test", payload: t118ReceiptPayload("completed") }),
      /completed receipts land in review from in-progress only/
    );
    raw.close();
  } finally {
    cleanupDir(dir);
    cleanupDir(cmdDir);
  }
});

test("T-118 P2a: blocked receipt good path -- in-progress task accepts it via raw writer; planning stays exportable (R9)", () => {
  const dir = mkTmpDir("mapctx-store-repair-t118-receipt-blocked-ok-");
  try {
    const handle = StoreHandle.open(dir);
    t118SeedForReceipt(handle, "T-BLKOK", "in-progress");
    handle.appendEvent({ eventType: "run.receipt-recorded", actor: "test", payload: t118ReceiptPayload("blocked") });
    const t = getTask(handle.db, "T-BLKOK");
    assert.ok(t);
    assert.equal(t.executionState, "blocked");
    assert.equal(t.planningState, "in-progress", "R9: a blocked RUN never moves planning projection");
    handle.close();
  } finally {
    cleanupDir(dir);
  }
});
