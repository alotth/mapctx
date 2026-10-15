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
 *   G3-final alone off               RED    G4 alone off               RED
 *   serializedPairs pair-filter off  green  G4 widened to always-true  RED
 *   collision-route warning off      RED    warning gated on empty
 *                                           intersection instead of
 *                                           nothing-recorded            RED
 *
 * So G2 is individually load-bearing -- it is the SOLE redaction guard of the
 * serialized-pair route, where G1 cannot help because that route reads
 * non-intersection as evidence. The final `isRedactedPath` filter on the
 * return is ALSO individually load-bearing: a plan path spelled
 * `./mapctx:redacted` (or `mapctx:redacted/`, `.\mapctx:redacted`) passes the
 * per-route filter, because the raw value is not the sentinel, and only
 * normalizePath turns it INTO the sentinel -- so only the final filter catches
 * it. The per-route filter is the redundant member: it pairs with the final
 * filter on the overbroad route, so removing it alone is invisible and removing
 * both brings the fabricated violation back. Do not delete either guard because
 * a single mutation shows one dead.
 *
 * G3-final's RED is now reproducible from this repository. T-133 measured it
 * with a reviewer's temporary fixture and committed none, so the only sentinel
 * fixture here used the BARE value -- which the per-route filter catches, which
 * left this row green when T-159 re-ran the matrix. The normalizable spelling
 * is a committed test now ("a normalizable sentinel spelling is caught only by
 * the final filter"). A matrix that can only be reproduced from a transcript is
 * a claim, not a measurement.
 *
 * G4 is new in T-159 and is the second guard of the same route, for a different
 * reason than G2: see it below. Both of its rows matter, because a guard that
 * suppresses too much is as wrong as one that suppresses too little -- widening
 * it to always-true turns the whole overbroad route dead and takes eight tests
 * with it.
 *
 * The collision-route warning is T-163 Part A, and it is in the matrix for the
 * same reason the guards are: it is the only thing standing between a missed
 * collision and an empty result that reads like a clean wave. It records no
 * violation and changes no existing output, so nothing but its own test can
 * notice if it disappears.
 *
 * Its GATE is in the matrix separately, because the first version got it wrong
 * in a way no existing test could see (T-163 review F1). Gating on "nothing
 * intersected" rather than "nothing was recorded" stays silent for a pair whose
 * intersection is entirely claim-covered while a second pair of changed files
 * hides an uncovered collision behind a spelling. The two conditions differ
 * only there, which is exactly why that row exists.
 *
 * Unicode normalization used to be the entry NOT in the matrix, because no
 * guard here covered it: NFC and NFD spellings of one filename were disjoint to
 * the audit comparison and to the scheduler's alike, so G4 did not fire and the
 * overbroad route emitted. T-166 folded NFC into `normalizeSchedulerPath`, so
 * G4 now covers it and it is in the matrix like the rest -- a mutation removing
 * that `.normalize("NFC")` turns the row red. The audit comparison still does
 * not normalize, deliberately, which is why this is G4's job and not its own
 * guard: see `schedulerTreatsAsSameFile`.
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
import { CAUSE_LABEL_SEPARATOR, schedulerTreatsAsSameFile } from "./scheduler-paths";

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
  /**
   * DISPLAY LABELS, not paths.
   *
   * `planExecution` fills `ClaimCollision.paths` and `causes[].paths` with
   * `"<left> ↔ <right>"` strings for a human to read. T-133 review MEDIA-2
   * found this detector consuming them as paths, which records
   * `path: "src/a.ts ↔ src/a.ts"` in an immutable violation. They are still
   * accepted, because a caller may legitimately pass real paths here, and every
   * value is screened for the separator before use.
   */
  paths?: readonly string[];
  /**
   * The real declared paths live on the CLAIMS inside each cause, which is
   * where this reads them from. `causes[].paths` is the label array again.
   */
  causes?: readonly {
    paths?: readonly string[];
    claimA?: { paths?: readonly string[] };
    claimB?: { paths?: readonly string[] };
  }[];
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
 * The real declared paths of a serialized pair.
 *
 * T-133 review MEDIA-2: `ClaimCollision.paths` and `causes[].paths` are display
 * labels, so the paths are read from the CLAIMS inside each cause. The label
 * arrays are still consulted, because a caller may pass real paths there, but
 * every candidate is screened: a value carrying the label separator is a label
 * and is dropped rather than normalized into a violation. Dropping is right
 * rather than splitting the label on the separator -- a split would resurrect
 * the guess, and a label is not evidence of anything the claims do not already
 * say.
 */
function declaredPathsOf(pair: SerializedPairForViolations): string[] {
  const causes = pair.causes ?? [];
  const candidates = [
    ...(pair.paths ?? []),
    ...causes.flatMap(cause => [
      ...(cause.claimA?.paths ?? []),
      ...(cause.claimB?.paths ?? []),
      ...(cause.paths ?? [])
    ])
  ];
  return [...new Set(candidates.filter(path => typeof path === "string" && !path.includes(CAUSE_LABEL_SEPARATOR)))];
}

/** Observed-path pairs the scheduler would call one file. See guard G4. */
function schedulerSameFilePairs(left: readonly string[], right: readonly string[]): string[] {
  const pairs: string[] = [];
  for (const a of left) {
    if (isRedactedPath(a)) continue;
    for (const b of right) {
      if (isRedactedPath(b)) continue;
      // Already-equal paths are handled by `actualIntersection`, which runs
      // first; only a disagreement between the two comparisons matters here.
      if (a !== b && schedulerTreatsAsSameFile(a, b)) pairs.push(`${a} vs ${b}`);
    }
  }
  return [...new Set(pairs)].sort();
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
        const intersection = actualIntersection(left, right);
        let recordedForPair = false;
        for (const path of intersection) {
          if (claimCovers(claims, left.taskId, path) && claimCovers(claims, right.taskId, path)) continue;
          const [taskAId, taskBId] = [left.taskId, right.taskId].sort();
          violations.push(makeViolation({ waveId: wave.waveId, kind: "collision", taskAId, taskBId, path, detectedAt, source: "derived-from-receipts" }));
          recordedForPair = true;
        }
        // T-163 Part A. This route uses `actualIntersection` POSITIVELY, so a
        // spelling disagreement makes it miss a collision rather than fabricate
        // a non-collision -- which is why T-159 left the finding unrecorded.
        // That argument covers not RECORDING a collision; it never covered
        // saying nothing at all. An empty result here is indistinguishable from
        // a clean wave, which is the exact mistake G2 and G4 exist to refuse:
        // "no violations" and "could not look" are different answers.
        //
        // The warning is the whole change. No violation row is added, because
        // which spelling an immutable `path` should carry -- the left
        // receipt's, the right's, or the normalized form -- is a question about
        // the audit record and belongs with the store's `recordClaimViolations`
        // (T-163 Part B, deliberately out of scope here).
        //
        // The gate is "nothing was RECORDED", not "nothing INTERSECTED", and
        // the two differ exactly where it matters (T-163 review F1). A pair can
        // intersect on one file that both tasks legitimately claimed -- so
        // nothing is recorded, correctly -- while a SECOND pair of changed
        // files is a spelling-hidden collision that nothing covers. Gating on
        // the intersection stayed silent there and handed the caller an empty
        // array indistinguishable from a clean wave, which is the one case
        // where this route's own thesis did not hold.
        //
        // Known property (review F2): a caller that passes the same pair both
        // in a wave and in `serializedPairs` gets one warning from each route.
        // They say different things -- missed collision here, unestablishable
        // non-intersection there -- and both are true, so neither is suppressed.
        if (!recordedForPair) {
          const sameFile = schedulerSameFilePairs(left.receipt.changedFiles, right.receipt.changedFiles);
          if (sameFile.length > 0) warnOnMissedCollisionSpelling(left.taskId, right.taskId, sameFile);
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
    // Guard G4 (T-159, from T-133 review MEDIA-1). Same shape as G2 and for the
    // same reason: do not assert an absence that cannot be established.
    //
    // `actualIntersection` compares what the receipts literally recorded, where
    // case is meaningful, `..` does not occur and the normal form a runner
    // reported is evidence -- correct for an audit trail, which must not
    // rewrite evidence. The SCHEDULER compares declared claims with case
    // folded, `..` resolved and Unicode folded to NFC, because it has to err
    // toward serializing on macOS and Windows. So `planExecution` serializes
    // `SRC/a.ts` against `src/a.ts`, and `café.ts` NFD against `café.ts` NFC;
    // the receipts come back spelling the same file both ways, the audit
    // comparison finds no intersection, and this route would record a permanent
    // "these tasks did not conflict" about two tasks that wrote the same bytes.
    //
    // The pair is skipped and the incompleteness reported, rather than the
    // paths being folded: folding them here would make the recorded violation
    // path lossy, which is the merge T-133 refused.
    //
    // DELIBERATELY ASYMMETRIC, and narrower than it first looks. The collision
    // route above uses `actualIntersection` POSITIVELY, so a spelling
    // disagreement makes it MISS a collision rather than fabricate a
    // non-collision. CASE, `..` and NORMAL FORM escape there -- a backslash
    // spelling is already caught, because the protocol's `intersectPaths` folds
    // separators (T-159 review, risk 4).
    //
    // Still no violation row on that side: a missed finding is recoverable by
    // looking again, while a recorded "they did not conflict" is immutable, and
    // deciding which spelling such a row's `path` would carry is a question
    // about the audit record rather than about this guard (T-163 Part B).
    // It is no longer SILENT though -- T-163 Part A gave that route the mirror
    // of this warning, because "not recording a finding" never justified
    // "saying nothing".
    const schedulerCollisions = schedulerSameFilePairs(left.receipt.changedFiles, right.receipt.changedFiles);
    if (schedulerCollisions.length > 0) {
      warnOnSchedulerDisagreement(pair.taskAId, pair.taskBId, schedulerCollisions);
      continue;
    }
    const wave = waves.find(candidate => candidate.taskIds.includes(pair.taskAId)) ?? waves[0];
    if (!wave) continue;
    // A caller-supplied path can be a redacted one too; a violation whose path
    // is the sentinel asserts nothing about any file.
    const paths = declaredPathsOf(pair)
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
 * The one spelling-disagreement warning, in two voices.
 *
 * Both routes hit the same cause -- two receipts spelling one file two ways --
 * and reach opposite dead ends from it, so the consequence sentence differs and
 * nothing else may. Sharing the builder is deliberate: the T-159 review found
 * the collision route silent while the serialized-pair route warned, and two
 * independently worded warnings are how that asymmetry would quietly come back.
 */
function warnOnSpellingDisagreement(subject: string, samePairs: readonly string[], consequence: string): void {
  process.emitWarning(
    `claim-violation detection over ${subject} is INCOMPLETE: ` +
    `${samePairs.length} changed-file pair(s) are different spellings of one file under the scheduler's comparison ` +
    `(${samePairs.join(", ")}), so ${consequence}. ` +
    `The audit comparison keeps receipts verbatim by design; the scheduler folds case, resolves ".." and folds Unicode to NFC.`
  );
}

/**
 * Guard G4's blind spot, said out loud.
 *
 * Silence here would be the bug: the pair is skipped precisely so that an
 * `overbroad` is NOT recorded, and without a warning the caller sees the same
 * empty result it would see from a clean pair. Same reasoning as
 * `warnOnIncompleteDetection` -- "no violations" and "could not look" are
 * different answers.
 */
function warnOnSchedulerDisagreement(taskAId: string, taskBId: string, samePairs: readonly string[]): void {
  warnOnSpellingDisagreement(
    `the serialized pair ${taskAId}/${taskBId}`,
    samePairs,
    `"they never intersected" cannot be established and no overbroad finding is emitted`
  );
}

/**
 * The collision route's blind spot, said out loud (T-163 Part A).
 *
 * The mirror image of the G4 warning above, and reported for the same reason
 * rather than a weaker one. This route misses a REAL collision instead of
 * fabricating a false absence, which is the less dangerous failure and is why
 * T-159 did not record a violation for it -- but an unreported miss is still
 * returned to the caller as an empty result that looks exactly like a clean
 * wave. Whether a violation should be recorded, and which spelling its
 * immutable `path` would carry, is T-163 Part B and belongs with the store's
 * `recordClaimViolations`.
 */
function warnOnMissedCollisionSpelling(taskAId: string, taskBId: string, samePairs: readonly string[]): void {
  warnOnSpellingDisagreement(
    `the wave pair ${taskAId}/${taskBId}`,
    samePairs,
    `a real collision may have been MISSED and no collision is recorded`
  );
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
