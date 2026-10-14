/**
 * Post-hoc claim feedback, derived from receipts a caller already holds.
 *
 * T-133 (from T-131 review MEDIA-3): this file used to be a STRUCTURAL TWIN of
 * packages/store/src/violations.ts -- its own normalizePath, pathsOverlap,
 * actualIntersection, claimCovers and stable id -- and it carried none of the
 * redaction guards T-131 added to the store copy. With a redacted
 * `changedFiles` it would fabricate both kinds of false audit fact: a
 * `collision` on the sentinel (actualIntersection used positively) and an
 * `overbroad` "these tasks did not conflict" (used negatively), and it took
 * plan-declared paths without filtering the sentinel.
 *
 * All five primitives now come from @mapctx/protocol/claim-paths, the one
 * package both this and the store already depend on, so there is a single
 * definition of path comparison and of violation identity. G1 (a redacted
 * path is incomparable) therefore arrives with the import; G2 and G3 are
 * decisions about receipts, so they are implemented below exactly as the
 * store implements them. The ids are unchanged: the shared derivation uses
 * the same key order this file's object literals always used.
 *
 * WHICH GUARD IS LOAD-BEARING HERE, measured the way the store measured its
 * own (mutation matrix over claim-paths.test.ts, violations.test.ts and the
 * store's violations.test.ts):
 *
 *   G1 alone off                     RED    G1 + G3-final off          RED
 *   G2 alone off                     RED    pair-filter + G3-final off RED
 *   G3-final alone off               green
 *   serializedPairs pair-filter off  green
 *
 * So G2 is individually load-bearing -- it is the SOLE guard of the
 * serialized-pair route, where G1 cannot help because that route reads
 * non-intersection as evidence. The final `isRedactedPath` filter on the
 * return is a redundant SIBLING: it pairs with G1 on the collision route and
 * with the per-route filter on the overbroad route, so removing either member
 * of a pair is invisible and removing both brings the fabricated violation
 * straight back. Do not delete the final filter because a single mutation
 * shows it dead -- it is dead only while its sibling lives.
 *
 * WHAT THIS STILL IS NOT. The store's recordClaimViolations is the version
 * that JOURNALS violations, with idempotent re-detection and a declared
 * blind-spot report. This one is pure: it derives from receipts handed to it
 * and returns them. When a receipt is redacted it now refuses to guess, and
 * says so through a process warning -- the array return is published API, so
 * the blind spot cannot be returned as data here without a second name, and a
 * second name shared with the store at a different safety level is the exact
 * problem T-133 exists to remove. Callers that need that as data use
 * @mapctx/store's detectClaimViolationsWithCoverage.
 */
import type { ClaimViolation, ResourceClaim, RunReceipt } from "@mapctx/protocol";
import {
  claimCovers, intersectPaths, isRedactedPath, normalizePath,
  redactedPathCount, makeClaimViolation as makeViolation
} from "@mapctx/protocol";

/**
 * Published since the first version of this module, and now the shared
 * definition rather than a local twin of it. Behaviour change in 0.4.0: a
 * redaction sentinel no longer overlaps anything, including another sentinel.
 */
export { pathsOverlap } from "@mapctx/protocol";

/** A receipt paired with task identity. Store builds these from its projections. */
export type TaskReceipt = { taskId: string; receipt: RunReceipt };

export type ViolationWave = {
  /** Stable protocol wave id. */
  waveId: string;
  taskIds: readonly string[];
  receipts?: readonly TaskReceipt[];
};

export type SerializedPairForViolations = {
  taskAId: string;
  taskBId: string;
  /** Planning-time claim/path explanation from planExecution.serializedPairs. */
  paths?: readonly string[];
  causes?: readonly { paths: readonly string[] }[];
};

export type ClaimViolationInput = {
  waves?: readonly ViolationWave[];
  /** Single-wave shorthand for callers processing one completed wave. */
  waveId?: string;
  taskIds?: readonly string[];
  receipts: readonly TaskReceipt[];
  serializedPairs?: readonly SerializedPairForViolations[];
  claims?: readonly ResourceClaim[];
  detectedAt?: string;
};

function actualIntersection(a: TaskReceipt, b: TaskReceipt): string[] {
  return intersectPaths(a.receipt.changedFiles, b.receipt.changedFiles);
}

function pairKey(a: string, b: string): string {
  return a.localeCompare(b) <= 0 ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Derive post-hoc claim feedback. Incomplete or failed receipts produce no
 * output for their wave. Function is deterministic for fixed receipts and
 * detection timestamp; no recalibration occurs here.
 *
 * Redacted receipts make detection INCOMPLETE rather than clean: an empty
 * result over them means "cannot tell", not "no collision". That is reported
 * as a process warning (see the module header for why it is not returned).
 */
export function detectClaimViolations(input: ClaimViolationInput): ClaimViolation[] {
  const waves = input.waves ?? (input.waveId && input.taskIds ? [{ waveId: input.waveId, taskIds: input.taskIds }] : []);
  const receiptItems = [...input.receipts, ...waves.flatMap(wave => wave.receipts ?? [])];
  const receiptsByTask = new Map(receiptItems.map(item => [item.taskId, item]));
  const claims = input.claims ?? [];
  const detectedAt = input.detectedAt ?? new Date().toISOString();
  const violations: ClaimViolation[] = [];

  for (const wave of waves) {
    const waveReceipts = wave.taskIds.map(taskId => receiptsByTask.get(taskId));
    // Ground truth exists only once every dispatch is terminal and successful.
    if (waveReceipts.some(item => !item || item.receipt.outcome !== "completed")) continue;
    for (let i = 0; i < waveReceipts.length; i += 1) {
      for (let j = i + 1; j < waveReceipts.length; j += 1) {
        const left = waveReceipts[i]!;
        const right = waveReceipts[j]!;
        for (const path of actualIntersection(left, right)) {
          if (claimCovers(claims, left.taskId, path) && claimCovers(claims, right.taskId, path)) continue;
          const [taskAId, taskBId] = [left.taskId, right.taskId].sort();
          violations.push(makeViolation({ waveId: wave.waveId, kind: "collision", taskAId, taskBId, path, detectedAt, source: "derived-from-receipts" }));
        }
      }
    }
  }

  // Overbroad pairs are only reportable after both tasks have successful
  // receipts. Their actual files must not intersect at all.
  for (const pair of input.serializedPairs ?? []) {
    const left = receiptsByTask.get(pair.taskAId);
    const right = receiptsByTask.get(pair.taskBId);
    if (!left || !right || left.receipt.outcome !== "completed" || right.receipt.outcome !== "completed") continue;
    // Guard G2. This route reads non-intersection as proof that serializing
    // the pair was unnecessary -- a positive claim about the past built on an
    // ABSENCE. With a redacted path on either side the absence is unknown, and
    // emitting anyway fabricates the inverse of the sentinel collision: two
    // tasks that really did fight over a file get a permanent record saying
    // they did not. G1 does not cover this one; nothing else does either.
    if (redactedPathCount(left.receipt.changedFiles) > 0 || redactedPathCount(right.receipt.changedFiles) > 0) continue;
    if (actualIntersection(left, right).length > 0) continue;
    const wave = waves.find(candidate => candidate.taskIds.includes(pair.taskAId)) ?? waves[0];
    if (!wave) continue;
    // A caller-supplied path can be a redacted one too; a violation whose path
    // is the sentinel asserts nothing about any file.
    const paths = [...new Set([...(pair.paths ?? []), ...(pair.causes ?? []).flatMap(cause => cause.paths)])]
      .filter(path => !isRedactedPath(path))
      .map(normalizePath).filter(Boolean).sort();
    for (const path of paths) {
      const [taskAId, taskBId] = [pair.taskAId, pair.taskBId].sort();
      violations.push(makeViolation({ waveId: wave.waveId, kind: "overbroad", taskAId, taskBId, path, detectedAt, source: "derived-from-receipts" }));
    }
  }

  warnOnIncompleteDetection(receiptItems);

  const seen = new Set<string>();
  return violations
    // Guard G3: belt and braces for the fabricated-fact class -- nothing with
    // a sentinel path is ever returned, whatever route produced it.
    .filter(item => !isRedactedPath(item.path))
    .filter(item => {
      const key = `${item.waveId}:${item.kind}:${pairKey(item.taskAId, item.taskBId)}:${item.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.waveId.localeCompare(b.waveId) || a.kind.localeCompare(b.kind) || a.taskAId.localeCompare(b.taskAId) || a.taskBId.localeCompare(b.taskBId) || a.path.localeCompare(b.path));
}

/**
 * "No violations" and "could not look" are different answers and only one of
 * them is safe to act on, so a redacted receipt is never silently treated as
 * clean evidence.
 */
function warnOnIncompleteDetection(receipts: readonly TaskReceipt[]): void {
  for (const item of receipts) {
    const redacted = redactedPathCount(item.receipt.changedFiles);
    if (redacted === 0) continue;
    process.emitWarning(
      `claim-violation detection over ${item.taskId} is INCOMPLETE: ${redacted} of ${item.receipt.changedFiles.length} changed-file path(s) are redacted and cannot be compared. ` +
      `An empty result may mean "cannot tell" rather than "no collision". Use @mapctx/store's detectClaimViolationsWithCoverage to get this as data.`
    );
  }
}

export const deriveClaimViolations = detectClaimViolations;
export const detectViolations = detectClaimViolations;
export const detectWaveClaimViolations = detectClaimViolations;
