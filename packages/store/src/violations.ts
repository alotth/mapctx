import { createHash } from "node:crypto";
import type { ClaimViolation, ResourceClaim, RunReceipt } from "@mapctx/protocol";
import { getDispatchAttempt, getRunReceipt, listClaimViolations } from "./projections";
import { normalizePath } from "./paths";
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
 *
 * HOW THE THREE GUARDS RELATE, as measured rather than assumed. The same
 * invariant -- never journal a claim derived from redacted evidence -- is
 * enforced at three places: G1 here at the comparison, G2 at the
 * serialized-pair decision, and G3 by the sentinel filter in the emission
 * loop. An earlier version of this comment called that a three-way redundancy
 * where no guard was individually load-bearing. That was wrong in both
 * halves. The mutation matrix (violations.test.ts + redact.test.ts):
 *
 *   G1 alone        green      G1+G2  RED (serializedPairs test)
 *   G2 alone        RED        G1+G3  RED (ALTO-2a test)
 *   G3 alone        green      G2+G3  RED (serializedPairs test)
 *                              G1+G2+G3 RED (both tests)
 *
 * So: G2 is the SOLE guard of the serialized-pair route -- G1 and G3 never
 * execute on it -- and is individually load-bearing. G1 and G3 are a
 * redundant PAIR on the collision route: either one alone covers it, so
 * removing either is invisible, and removing both brings the fabricated
 * collision straight back. Every combination that changes observable
 * behaviour is now red; the ones that stay green are the ones where the
 * surviving sibling still enforces the invariant. Do not delete G1 or G3
 * because a single mutation shows it "dead" -- it is dead only while the
 * other lives.
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

/**
 * Whether this exact violation is already recorded.
 *
 * Matched by ID, not by the field tuple (review MEDIA-1). The id is a
 * stableUuid over the ORIGINAL fields and redaction does not change it, so a
 * row whose `path` has since been redacted still answers "already recorded".
 * Matching on `path` instead meant a redacted row stopped being found, the
 * next detection run appended a BRAND NEW event carrying the real path, and
 * the projection ended up with both rows -- redacting the derived copy was
 * silently undone by the next wave. `insertClaimViolation` already keys its
 * ON CONFLICT on the id alone, which is what proves the id is the stable
 * identity here.
 */
function semanticExists(store: StoreHandle, violation: ClaimViolation): boolean {
  return listClaimViolations(store.db, { id: violation.id }).length > 0;
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
export function detectClaimViolationsWithCoverage(store: StoreHandle, plan: ClaimViolationPlan, actor = "planner"): ClaimViolationDetectionResult {
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
      if (!left || !right) continue;
      // An "overbroad" violation asserts the two tasks did NOT actually
      // conflict, so serializing them was unnecessary. That claim rests on
      // seeing both receipts' files. With a redacted path on either side,
      // non-intersection cannot be established -- and emitting anyway
      // fabricates the INVERSE of the ALTO-2a false positive: two tasks that
      // really did collide get a permanent record saying they did not.
      // (Measured: before the sentinel became incomparable this route was
      // accidentally safe, because the two sentinels "intersected" and the
      // pair was skipped. Making them incomparable turned that accident into
      // a fabrication, so the condition is now explicit.) The blindness is
      // already reported through incompleteDetection.
      if (redactedChangedFileCount(left) > 0 || redactedChangedFileCount(right) > 0) continue;
      if (actualIntersection(left, right).length > 0) continue;
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
 * warning here. Callers that need it as data use
 * detectClaimViolationsWithCoverage -- named that way, and not
 * `detectClaimViolations`, because @mapctx/planner already publishes a
 * function by that name with a different signature and WITHOUT the sentinel
 * guards (review MEDIA-3). Two packages exporting one name with two safety
 * levels is how a future caller ends up on the unguarded one by accident.
 */
export function recordClaimViolations(store: StoreHandle, plan: ClaimViolationPlan, actor = "planner"): ClaimViolation[] {
  const result = detectClaimViolationsWithCoverage(store, plan, actor);
  for (const incomplete of result.incompleteDetection) {
    process.emitWarning(
      `claim-violation detection over ${incomplete.taskId} (${incomplete.dispatchId}/${incomplete.attempt}) is INCOMPLETE: ${incomplete.redactedPaths} of ${incomplete.totalPaths} changed-file path(s) are redacted and cannot be compared. ` +
      `${result.violations.length === 0 ? "An empty result here means \"cannot tell\", not \"no collision\"." : "Violations found may be a subset."} Use detectClaimViolationsWithCoverage for this as data.`
    );
  }
  return result.violations;
}

export const detectAndPersistClaimViolations = recordClaimViolations;
export const emitWaveClaimViolations = recordClaimViolations;
