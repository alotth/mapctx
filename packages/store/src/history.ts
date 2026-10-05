import type { HistoryCorrectionRecord, HistoryCorrectionRow, HistoryEvidenceRecord, HistoryEvidenceRow } from "./projections"
import {
  getDispatchAttempt,
  getHistoryEvidence,
  getTask,
  insertHistoryCorrection,
  insertHistoryEvidence,
  listHistoryCorrections,
  listHistoryEvidence
} from "./projections"
import type { StoreHandle } from "./store-handle"

/**
 * T-116: historical evidence and auditable corrections.
 *
 * Evidence registration is independent of execution status: it records
 * content-free session linkage (ids, timestamps, owners, hashes only) for any
 * planning state, including done, without claims, dispatches, receipts, or
 * any task_projection mutation. Corrections never rewrite or delete originals
 * -- they journal an auditable verdict that roadmap/calibration readers use
 * to exclude invalid evidence.
 */

const HARNESS_VALUES = new Set(["codex", "opencode", "claude-code"]);
const TIER_VALUES = new Set(["measured", "inferred"]);
const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);
const SIGNAL_VALUES = new Set(["toolcall", "file-edit", "branch", "first-prompt", "weak"]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** Canonical dispatch identity for correction targets: UUID + positive attempt, nothing else. */
const CANONICAL_RECEIPT_TARGET = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[1-9]\d*$/;
const HEX_HASH = /^[0-9a-f]{8,64}$/;

export type HistoryEvidenceWriteResult =
  | { ok: true; evidence: HistoryEvidenceRecord; reactivated: boolean; duplicate: boolean }
  | { ok: false; reason: "unknown-task" | "conflicting-evidence" | "invalid-evidence"; message?: string }

export type HistoryCorrectionWriteResult =
  | { ok: true; correction: HistoryCorrectionRecord; duplicate: boolean }
  | { ok: false; reason: "unknown-task" | "unknown-target" | "already-corrected" | "invalid-correction"; message?: string }

/** Canonical evidence field allowlist: arbitrary caller payload can never journal. */
const EVIDENCE_KEYS = new Set([
  "evidenceId", "taskId", "harness", "sessionId", "tier", "confidence",
  "repoRoot", "repoOrigin", "signals", "spanStart", "spanEnd", "activeMs",
  "sourceHash", "recordedAt"
]);

function finiteTimestamp(value: string): boolean {
  return ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * Review-attempt-2 strictness: evidence is content-free metadata with an
 * exact shape. Impossible dates, unpaired or non-positive spans, negative /
 * non-finite / span-exceeding activeMs, measured tiers without real
 * measurement, transcript text in signal labels, and unknown extra keys are
 * all refused before anything journals. The returned record is the
 * canonicalized value that journals -- never the raw caller object.
 */
function assertValidEvidence(evidence: HistoryEvidenceRecord): { error: string } | { canonical: HistoryEvidenceRecord } {
  for (const key of Object.keys(evidence)) {
    if (!EVIDENCE_KEYS.has(key)) return { error: `unknown field: ${key}` };
  }
  if (!evidence.evidenceId?.trim()) return { error: "evidenceId is required" };
  if (!/^T-\d{1,4}$/.test(evidence.taskId)) return { error: `invalid taskId: ${evidence.taskId}` };
  if (!HARNESS_VALUES.has(evidence.harness)) return { error: `invalid harness: ${evidence.harness}` };
  if (!evidence.sessionId?.trim()) return { error: "sessionId is required" };
  if (!TIER_VALUES.has(evidence.tier)) return { error: `invalid tier: ${evidence.tier}` };
  if (!CONFIDENCE_VALUES.has(evidence.confidence)) return { error: `invalid confidence: ${evidence.confidence}` };
  if (!Array.isArray(evidence.signals)) return { error: "signals must be an array" };
  if (!evidence.signals.every(signal => SIGNAL_VALUES.has(signal))) {
    return { error: `signals must be an allowlisted kind: ${[...SIGNAL_VALUES].join("|")}` };
  }
  if (!finiteTimestamp(evidence.recordedAt)) return { error: `invalid recordedAt: ${evidence.recordedAt}` };
  const spanPaired = (evidence.spanStart === null) === (evidence.spanEnd === null);
  if (!spanPaired) return { error: "spanStart and spanEnd must be paired" };
  if (evidence.spanStart !== null && evidence.spanEnd !== null) {
    if (!finiteTimestamp(evidence.spanStart)) return { error: `invalid spanStart: ${evidence.spanStart}` };
    if (!finiteTimestamp(evidence.spanEnd)) return { error: `invalid spanEnd: ${evidence.spanEnd}` };
    const startMs = Date.parse(evidence.spanStart);
    const endMs = Date.parse(evidence.spanEnd);
    if (endMs <= startMs) return { error: "measured span must be strictly positive and ordered" };
  }
  if (evidence.activeMs !== null) {
    if (!Number.isFinite(evidence.activeMs) || evidence.activeMs < 0) {
      return { error: `activeMs must be a finite non-negative number: ${String(evidence.activeMs)}` };
    }
    if (evidence.spanStart === null || evidence.spanEnd === null) {
      return { error: "activeMs requires a measured span" };
    }
    const spanMs = Date.parse(evidence.spanEnd) - Date.parse(evidence.spanStart);
    if (evidence.activeMs > spanMs) return { error: "activeMs exceeds the measured span" };
  }
  if (evidence.tier === "measured" && (evidence.spanStart === null || evidence.spanEnd === null || evidence.activeMs === null)) {
    return { error: "measured evidence requires span bounds and activeMs -- never an implied measurement" };
  }
  if (evidence.tier === "inferred" && evidence.activeMs !== null) {
    return { error: "inferred evidence must not imply measured active time (activeMs must be null)" };
  }
  if (evidence.sourceHash !== null && !HEX_HASH.test(evidence.sourceHash)) {
    return { error: "sourceHash must be a hex digest" };
  }
  const canonical: HistoryEvidenceRecord = {
    evidenceId: evidence.evidenceId,
    taskId: evidence.taskId,
    harness: evidence.harness,
    sessionId: evidence.sessionId,
    tier: evidence.tier,
    confidence: evidence.confidence,
    repoRoot: evidence.repoRoot ?? null,
    repoOrigin: evidence.repoOrigin ?? null,
    signals: [...evidence.signals],
    spanStart: evidence.spanStart,
    spanEnd: evidence.spanEnd,
    activeMs: evidence.activeMs,
    sourceHash: evidence.sourceHash,
    recordedAt: evidence.recordedAt
  };
  return { canonical };
}

/**
 * Record one content-free evidence link. Idempotent by evidenceId: an
 * identical active row is a no-op; an invalidated row is re-activated (the
 * new event lands after the correction in journal order, so replay is
 * faithful); a conflicting active row is refused -- replacing it requires a
 * correction first, keeping every change auditable.
 */
export function recordHistoryEvidence(
  store: StoreHandle,
  evidence: HistoryEvidenceRecord,
  actor = "history-scan"
): HistoryEvidenceWriteResult {
  const validated = assertValidEvidence(evidence);
  if ("error" in validated) return { ok: false, reason: "invalid-evidence", message: validated.error };
  return store.runInWriteTransaction(append => appendHistoryEvidence(store, validated.canonical, append, actor));
}

/**
 * Transaction-composable variant (review attempt 2, finding 3): callers that
 * already hold the write lock (all-or-nothing approval sets) append through
 * this helper; recordHistoryEvidence is the one-shot wrapper.
 */
export function appendHistoryEvidence(
  store: StoreHandle,
  evidence: HistoryEvidenceRecord,
  append: (input: { eventType: string; actor: string; payload: Record<string, unknown> }) => unknown,
  actor = "history-scan"
): HistoryEvidenceWriteResult {
  const validated = assertValidEvidence(evidence);
  if ("error" in validated) return { ok: false, reason: "invalid-evidence", message: validated.error };
  const canonical = validated.canonical;
  const task = getTask(store.db, canonical.taskId);
  if (!task) return { ok: false, reason: "unknown-task" };
  const existing = getHistoryEvidence(store.db, canonical.evidenceId);
  if (existing?.status === "active") {
    if (existingContentMatches(existing, canonical)) {
      return { ok: true, evidence: canonical, reactivated: false, duplicate: true };
    }
    return {
      ok: false,
      reason: "conflicting-evidence",
      message: `evidence ${canonical.evidenceId} is active with different content; correct it first (mapctx history correct --evidence ${canonical.evidenceId})`
    };
  }
  append({
    eventType: "history.evidence-recorded",
    actor,
    payload: { evidence: canonical }
  });
  return { ok: true, evidence: canonical, reactivated: existing?.status === "invalid", duplicate: false };
}

function existingContentMatches(existing: HistoryEvidenceRow, evidence: HistoryEvidenceRecord): boolean {
  return existing.taskId === evidence.taskId
    && existing.harness === evidence.harness
    && existing.sessionId === evidence.sessionId
    && existing.tier === evidence.tier
    && existing.confidence === evidence.confidence
    && JSON.stringify(existing.signals) === JSON.stringify(evidence.signals)
    && (existing.spanStart ?? null) === (evidence.spanStart ?? null)
    && (existing.spanEnd ?? null) === (evidence.spanEnd ?? null)
    && (existing.activeMs ?? null) === (evidence.activeMs ?? null)
    && (existing.sourceHash ?? null) === (evidence.sourceHash ?? null);
}

/**
 * Journal one auditable correction. The target must exist (a dispatch
 * attempt or an evidence row) and belong to the named task. Correcting the
 * same target twice is refused as a duplicate: the first verdict stands and
 * stays queryable.
 */
export function recordHistoryCorrection(
  store: StoreHandle,
  correction: HistoryCorrectionRecord,
  actor = "history-correct"
): HistoryCorrectionWriteResult {
  if (!correction.correctionId?.trim()) return { ok: false, reason: "invalid-correction", message: "correctionId is required" };
  // Live-recovery follow-up (review attempt 7): corrections may target
  // canonical EPIC ids too -- four history-scan receipts are owned by epics.
  // A correction is an audit verdict on an EXISTING owned receipt, not
  // execution: every other guard below (task exists, canonical
  // uuid/attempt target, ownership, duplicate) is unchanged, and evidence
  // recording keeps its task-only rule.
  if (!/^[TE]-\d{1,4}$/.test(correction.taskId)) return { ok: false, reason: "invalid-correction", message: `invalid taskId: ${correction.taskId}` };
  if (correction.verdict !== "invalid") return { ok: false, reason: "invalid-correction", message: "verdict must be 'invalid'" };
  if (!correction.reason?.trim()) return { ok: false, reason: "invalid-correction", message: "a human-readable reason is required for the audit trail" };
  if (!finiteTimestamp(correction.recordedAt)) return { ok: false, reason: "invalid-correction", message: `invalid recordedAt: ${correction.recordedAt}` };
  // Review attempt 2, finding 2: only the exact canonical identity may be
  // journaled. Extra path segments, non-canonical UUIDs, zero/negative/NaN
  // attempts and bare ids are refused BEFORE append, so an accepted
  // correction always corresponds exactly to the consumer exclusion key.
  if (correction.targetKind === "receipt" && !CANONICAL_RECEIPT_TARGET.test(correction.targetId)) {
    return { ok: false, reason: "invalid-correction", message: `receipt target must be exactly <canonical-uuid>/<positive-integer-attempt>: ${correction.targetId}` };
  }
  if (correction.targetKind === "evidence" && !correction.targetId?.trim()) {
    return { ok: false, reason: "invalid-correction", message: "evidence target id is required" };
  }
  return store.runInWriteTransaction(append => {
    const task = getTask(store.db, correction.taskId);
    if (!task) return { ok: false, reason: "unknown-task" };
    let targetTaskId: string | undefined;
    if (correction.targetKind === "receipt") {
      const separator = correction.targetId.lastIndexOf("/");
      const dispatchId = correction.targetId.slice(0, separator);
      const attempt = Number(correction.targetId.slice(separator + 1));
      const dispatch = getDispatchAttempt(store.db, dispatchId, attempt);
      targetTaskId = dispatch?.taskId;
    } else if (correction.targetKind === "evidence") {
      targetTaskId = getHistoryEvidence(store.db, correction.targetId)?.taskId;
    } else {
      return { ok: false, reason: "invalid-correction", message: `invalid targetKind: ${correction.targetKind}` };
    }
    if (!targetTaskId) return { ok: false, reason: "unknown-target", message: `no such ${correction.targetKind}: ${correction.targetId}` };
    if (targetTaskId !== correction.taskId) {
      return { ok: false, reason: "unknown-target", message: `${correction.targetKind} ${correction.targetId} belongs to ${targetTaskId}, not ${correction.taskId}` };
    }
    const prior = listHistoryCorrections(store.db, { targetKind: correction.targetKind, targetId: correction.targetId });
    if (prior.length > 0) {
      return { ok: false, reason: "already-corrected", message: `${correction.targetKind} ${correction.targetId} was already corrected (${prior[0].correctionId})` };
    }
    append({
      eventType: "history.correction-recorded",
      actor,
      payload: { correction }
    });
    return { ok: true, correction, duplicate: false };
  });
}

export function listHistoryEvidenceForTask(db: StoreHandle["db"], taskId: string): HistoryEvidenceRow[] {
  return listHistoryEvidence(db, taskId);
}

export type { HistoryCorrectionRow, HistoryEvidenceRow };
