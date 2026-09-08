import { DispatchStatus } from "./entities";
import { RunReceipt } from "./envelopes";

// Pure decision logic for whether a RunReceipt is the valid result of a
// dispatch's current attempt. No storage: T-058 owns persisting
// DispatchAttemptHistory and calling evaluateRunReceipt before accepting a
// receipt. Keeping this pure (history in, decision out) makes the retry /
// stale-attempt races exhaustively testable without a store.

export interface AttemptRecord {
  attempt: number;
  status: DispatchStatus;
}

export interface DispatchAttemptHistory {
  dispatchId: string;
  attempts: readonly AttemptRecord[];
  acceptedReceiptAttempts: readonly number[];
}

export type ReceiptRejectionReason =
  | "dispatch-mismatch"
  | "unknown-attempt"
  | "stale-attempt"
  | "duplicate-receipt";

export type ReceiptDecision =
  | { accepted: true }
  | { accepted: false; reason: ReceiptRejectionReason };

export function emptyDispatchAttemptHistory(dispatchId: string): DispatchAttemptHistory {
  return { dispatchId, attempts: [], acceptedReceiptAttempts: [] };
}

export function latestAttemptNumber(history: DispatchAttemptHistory): number | null {
  if (history.attempts.length === 0) return null;
  return history.attempts.reduce((max, a) => Math.max(max, a.attempt), -Infinity);
}

/**
 * Decides whether `receipt` is the valid outcome of its attempt, given every
 * attempt dispatched so far for that dispatchId. Rejects:
 *  - receipts for a different dispatchId ("dispatch-mismatch")
 *  - receipts for an attempt that was never dispatched ("unknown-attempt")
 *  - receipts for an attempt older than the latest dispatched attempt
 *    ("stale-attempt") — the case that matters: attempt 1 fails, attempt 2 is
 *    dispatched, attempt 1's receipt arrives late and must not overwrite
 *    attempt 2's outcome.
 *  - a second receipt for an attempt that already has an accepted receipt
 *    ("duplicate-receipt") — accept-once semantics per attempt.
 */
export function evaluateRunReceipt(
  history: DispatchAttemptHistory,
  receipt: Pick<RunReceipt, "dispatchId" | "attempt">
): ReceiptDecision {
  if (receipt.dispatchId !== history.dispatchId) {
    return { accepted: false, reason: "dispatch-mismatch" };
  }

  const known = history.attempts.some((a) => a.attempt === receipt.attempt);
  if (!known) {
    return { accepted: false, reason: "unknown-attempt" };
  }

  const latest = latestAttemptNumber(history);
  if (latest !== null && receipt.attempt < latest) {
    return { accepted: false, reason: "stale-attempt" };
  }

  if (history.acceptedReceiptAttempts.includes(receipt.attempt)) {
    return { accepted: false, reason: "duplicate-receipt" };
  }

  return { accepted: true };
}

export function recordAttempt(
  history: DispatchAttemptHistory,
  attempt: AttemptRecord
): DispatchAttemptHistory {
  const others = history.attempts.filter((a) => a.attempt !== attempt.attempt);
  return {
    ...history,
    attempts: [...others, attempt].sort((a, b) => a.attempt - b.attempt)
  };
}

export function recordAcceptedReceipt(
  history: DispatchAttemptHistory,
  attempt: number
): DispatchAttemptHistory {
  if (history.acceptedReceiptAttempts.includes(attempt)) return history;
  return { ...history, acceptedReceiptAttempts: [...history.acceptedReceiptAttempts, attempt] };
}
