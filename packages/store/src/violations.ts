import { createHash } from "node:crypto";
import type { ClaimViolation, ResourceClaim, RunReceipt } from "@mapctx/protocol";
import { getDispatchAttempt, getRunReceipt, listClaimViolations } from "./projections";
import { REDACTED_SENTINEL } from "./redact";
import type { StoreHandle } from "./store-handle";

export type WaveDispatchRef = { waveId: string; dispatchId: string; attempt: number; taskId?: string };
export type ViolationSerializedPair = {
  taskAId: string;
  taskBId: string;
  paths?: readonly string[];
  causes?: readonly { paths: readonly string[] }[];
};
export type ClaimViolationPlan = {
  waves: readonly { waveId: string; dispatches: readonly WaveDispatchRef[] }[];
  serializedPairs?: readonly ViolationSerializedPair[];
  claims?: readonly ResourceClaim[];
  detectedAt?: string;
};

function normalizePath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

/**
 * T-131 review ALTO-2: a redacted path is NOT COMPARABLE, so it overlaps
 * nothing -- not even another redacted path.
 *
 * Without this, every redacted element equalled every other one, and two
 * receipts with completely disjoint files "collided": the detector appended a
 * `claim-violation.detected` event -- an immutable historical claim that two
 * tasks fought over a file -- naming a file that does not exist. A privacy
 * operation must never be able to fabricate an audit fact. Treating the
 * sentinel as incomparable kills that at the root, and
 * `redactedChangedFileCount` below is what keeps the resulting blind spot
 * declared instead of silent.
 */
function isRedactedPath(value: string): boolean {
  return value === REDACTED_SENTINEL;
}

function pathsOverlap(left: string, right: string): boolean {
  if (isRedactedPath(left) || isRedactedPath(right)) return false;
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const prefix = (value: string) => {
    const wildcard = value.search(/[?*\[]/);
    return normalizePath(wildcard < 0 ? value : value.slice(0, wildcard)).replace(/\/$/, "");
  };
  const aPrefix = prefix(a);
  const bPrefix = prefix(b);
  if (aPrefix === bPrefix || aPrefix.startsWith(`${bPrefix}/`) || bPrefix.startsWith(`${aPrefix}/`)) return true;
  const aDir = a.endsWith("/**") || a.endsWith("/*") || a.endsWith("/");
  const bDir = b.endsWith("/**") || b.endsWith("/*") || b.endsWith("/");
  if (aDir && b.startsWith(`${a.slice(0, a.lastIndexOf("/"))}/`)) return true;
  if (bDir && a.startsWith(`${b.slice(0, b.lastIndexOf("/"))}/`)) return true;
  return false;
}

function actualIntersection(left: RunReceipt, right: RunReceipt): string[] {
  return [...new Set(left.changedFiles.flatMap(a => right.changedFiles.filter(b => pathsOverlap(a, b)).map(normalizePath)))].sort();
}

function claimCovers(claims: readonly ResourceClaim[], taskId: string, path: string): boolean {
  return claims.some(claim => claim.taskId === taskId && claim.mode === "write" && claim.paths.some(claimPath => pathsOverlap(claimPath, path)));
}

function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [hex.slice(0, 8).join(""), hex.slice(8, 12).join(""), hex.slice(12, 16).join(""), hex.slice(16, 20).join(""), hex.slice(20).join("")].join("-");
}

function makeViolation(fields: Omit<ClaimViolation, "id">): ClaimViolation {
  return { ...fields, id: stableUuid(`mapctx:claim-violation:${JSON.stringify(fields)}`) };
}

function semanticExists(store: StoreHandle, violation: ClaimViolation): boolean {
  return listClaimViolations(store.db, {
    waveId: violation.waveId,
    kind: violation.kind,
    taskAId: violation.taskAId,
    taskBId: violation.taskBId,
    path: violation.path
  }).length > 0;
}

/** How much of one receipt's changed-file list is no longer comparable. */
export type IncompleteDetection = {
  taskId: string;
  dispatchId: string;
  attempt: number;
  /** Elements that hold the redaction sentinel instead of a path. */
  redactedPaths: number;
  /** Total elements, so the caller can see how much of the receipt is blind. */
  totalPaths: number;
};

export type ClaimViolationDetectionResult = {
  violations: ClaimViolation[];
  /**
   * Receipts whose changed files were (partly) redacted. Detection over them
   * is INCOMPLETE: an empty `violations` here does not mean "no collision",
   * it means "cannot tell". Empty array = detection saw everything.
   */
  incompleteDetection: IncompleteDetection[];
};

function redactedChangedFileCount(receipt: RunReceipt): number {
  return receipt.changedFiles.filter(isRedactedPath).length;
}

/**
 * Read completed receipts, derive both feedback directions, and append events
 * atomically. Any missing/non-completed receipt aborts the whole plan with no
 * partial output. Repeating a completed plan is idempotent by semantic key.
 *
 * T-131 review ALTO-2: when a receipt's `changedFiles` has been redacted, the
 * paths it contributes are gone, so a real collision on a path that was
 * redacted simply cannot be found any more -- and redacting a whole root
 * takes the innocent siblings with it. That blindness is now REPORTED rather
 * than returned as a clean bill of health, because "no violations" and "could
 * not look" are different answers and only one of them is safe to act on.
 */
export function detectClaimViolations(store: StoreHandle, plan: ClaimViolationPlan, actor = "planner"): ClaimViolationDetectionResult {
  const detectedAt = plan.detectedAt ?? new Date().toISOString();
  const incompleteDetection: IncompleteDetection[] = [];
  const violations = store.runInWriteTransaction(append => {
    const byTask = new Map<string, { receipt: RunReceipt; waveId: string }>();
    for (const wave of plan.waves) {
      if (wave.dispatches.length === 0) return [];
      for (const ref of wave.dispatches) {
        const dispatch = getDispatchAttempt(store.db, ref.dispatchId, ref.attempt);
        const receipt = getRunReceipt(store.db, ref.dispatchId, ref.attempt);
        if (!dispatch || !receipt || receipt.outcome !== "completed" || dispatch.status !== "completed") return [];
        const taskId = ref.taskId ?? dispatch.taskId;
        const redactedPaths = redactedChangedFileCount(receipt);
        if (redactedPaths > 0) {
          incompleteDetection.push({
            taskId,
            dispatchId: ref.dispatchId,
            attempt: ref.attempt,
            redactedPaths,
            totalPaths: receipt.changedFiles.length
          });
        }
        byTask.set(taskId, { receipt, waveId: wave.waveId });
      }
    }

    const claims = plan.claims ?? [];
    const violations: ClaimViolation[] = [];
    for (const wave of plan.waves) {
      const taskIds = wave.dispatches.map(ref => ref.taskId ?? getDispatchAttempt(store.db, ref.dispatchId, ref.attempt)!.taskId);
      for (let i = 0; i < taskIds.length; i += 1) {
        for (let j = i + 1; j < taskIds.length; j += 1) {
          const left = byTask.get(taskIds[i])!.receipt;
          const right = byTask.get(taskIds[j])!.receipt;
          for (const path of actualIntersection(left, right)) {
            if (claimCovers(claims, taskIds[i], path) && claimCovers(claims, taskIds[j], path)) continue;
            const [taskAId, taskBId] = [taskIds[i], taskIds[j]].sort();
            violations.push(makeViolation({ waveId: wave.waveId, kind: "collision", taskAId, taskBId, path, detectedAt, source: "derived-from-receipts" }));
          }
        }
      }
    }
    for (const pair of plan.serializedPairs ?? []) {
      const left = byTask.get(pair.taskAId)?.receipt;
      const right = byTask.get(pair.taskBId)?.receipt;
      if (!left || !right || actualIntersection(left, right).length > 0) continue;
      const waveId = byTask.get(pair.taskAId)?.waveId ?? plan.waves[0]?.waveId;
      if (!waveId) continue;
      // A caller-supplied path can also be a redacted one; a violation whose
      // path is the sentinel asserts nothing and must never be journaled.
      const paths = [...new Set([...(pair.paths ?? []), ...(pair.causes ?? []).flatMap(cause => cause.paths)])]
        .filter(path => !isRedactedPath(path))
        .map(normalizePath).filter(Boolean).sort();
      for (const path of paths) {
        const [taskAId, taskBId] = [pair.taskAId, pair.taskBId].sort();
        violations.push(makeViolation({ waveId, kind: "overbroad", taskAId, taskBId, path, detectedAt, source: "derived-from-receipts" }));
      }
    }

    const unique = new Map(violations.map(violation => [`${violation.waveId}:${violation.kind}:${violation.taskAId}:${violation.taskBId}:${violation.path}`, violation]));
    const emitted: ClaimViolation[] = [];
    for (const violation of [...unique.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      // Belt and braces for the fabricated-fact class: nothing with a
      // sentinel path is ever appended, whatever route produced it.
      if (isRedactedPath(violation.path)) continue;
      if (semanticExists(store, violation)) continue;
      append({ eventType: "claim-violation.detected", actor, occurredAt: violation.detectedAt, payload: { violation } });
      // Projection is already updated by append; return protocol object.
      emitted.push(violation);
    }
    return emitted;
  });
  return { violations, incompleteDetection };
}

/**
 * The published signature: the violations alone. Kept array-returning so
 * existing callers and the two aliases below are untouched; incomplete
 * detection is still impossible to miss, because it is raised as a process
 * warning here. Callers that need it as data use detectClaimViolations.
 */
export function recordClaimViolations(store: StoreHandle, plan: ClaimViolationPlan, actor = "planner"): ClaimViolation[] {
  const result = detectClaimViolations(store, plan, actor);
  for (const incomplete of result.incompleteDetection) {
    process.emitWarning(
      `claim-violation detection over ${incomplete.taskId} (${incomplete.dispatchId}/${incomplete.attempt}) is INCOMPLETE: ${incomplete.redactedPaths} of ${incomplete.totalPaths} changed-file path(s) are redacted and cannot be compared. ` +
      `${result.violations.length === 0 ? "An empty result here means \"cannot tell\", not \"no collision\"." : "Violations found may be a subset."} Use detectClaimViolations for this as data.`
    );
  }
  return result.violations;
}

export const detectAndPersistClaimViolations = recordClaimViolations;
export const emitWaveClaimViolations = recordClaimViolations;
