/**
 * How the SCHEDULER compares declared paths, in one place.
 *
 * This normalization used to be private to `index.ts`. T-159 (T-133 review
 * MEDIA-1) needs it in `violations.ts` too, and the reason it has to be shared
 * rather than rewritten is the whole point of T-133: two copies of a path
 * comparison is how the planner ended up with a guarded detector and an
 * unguarded twin under near-identical names.
 *
 * STILL NOT the `normalizePath` in @mapctx/protocol/claim-paths, and still
 * deliberately not merged with it. This one compares DECLARED claims before
 * work runs, so it resolves `..`, refuses to pop a `**`, folds case because the
 * scheduler must err toward serializing on filesystems that do, and folds
 * Unicode to NFC (T-166) because a mixed macOS/Linux fleet reports one filename
 * two ways. That one compares OBSERVED paths — what a receipt reported against
 * what a violation row recorded — where case is meaningful, `..` does not
 * occur, and the recorded normal form is evidence rather than noise. Merging
 * them would make the audit record lossy or the scheduler case-blind;
 * equivalence was never proven, so the two comparisons stay two functions with
 * two names' worth of documentation.
 *
 * What T-159 adds is a third thing, which is neither of those two: a way to ask
 * "would the scheduler have called these the same file?" about paths the audit
 * comparison found disjoint. That question has exactly one honest answer and it
 * has to come from the scheduler's own rules, which is why this module exists
 * instead of a second case-folding helper in `violations.ts`.
 */

/**
 * Segments joined, `.` dropped, `..` resolved, case folded, Unicode NFC.
 *
 * Returns `""` when the path locates nothing — `/`, a bare `..`, or a `..` that
 * would pop a `**`. The scheduler reads that empty result as "unknown, collide
 * broadly" rather than as "empty".
 *
 * NFC is applied FIRST, to the whole input, so the two spellings of one
 * filename become one string before anything structural reads it: separator
 * folding, `..` resolution, the `**` check and case folding then all see
 * identical text whichever form arrived. Nothing in canonical composition
 * produces or consumes `/`, `.`, `\` or `*`, so normalizing this early cannot
 * change how the path splits or which segment a `..` pops.
 *
 * T-166 added it, for the SCHEDULER and not only for the guard below — they
 * read this one definition precisely so they cannot disagree about what one
 * filename is. The effect is only ever to widen: two paths differing just in
 * normal form become the same file, so a plan serializes more, never less.
 * macOS reports NFD and Linux NFC, so on a mixed-OS fleet the alternative was a
 * scheduler that ran two writers of one file in parallel.
 */
export function normalizeSchedulerPath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.trim().normalize("NFC").replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // A single-segment wildcard consumes exactly one segment, so popping it is exact.
      // `**` spans zero or more, so popping it would narrow a pattern that still
      // matches: leave the path unresolvable instead, which collides broadly.
      if (segments.pop()?.includes("**")) return "";
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/").toLowerCase();
}

/**
 * Whether the scheduler's rules make these two OBSERVED paths the same file.
 *
 * Used as a guard, never to decide a collision. Two receipts can spell one file
 * two ways — `SRC/a.ts` and `src/a.ts` on macOS, `src/x/../a.ts` and
 * `src/a.ts` anywhere — and the audit comparison in @mapctx/protocol treats
 * those as disjoint, correctly, because it must not rewrite what a receipt
 * recorded. The serialized-pair route then reads that disjointness as proof
 * that serializing the pair was unnecessary, which is a positive claim about
 * the past built on an absence the audit comparison cannot establish.
 *
 * Only equality after normalization counts here. Glob semantics are
 * deliberately absent: these are concrete files a receipt reported, not
 * patterns, and widening the guard to the scheduler's conservative glob overlap
 * would suppress the legitimate `overbroad` findings this route exists to
 * produce. An unresolvable path (normalizing to `""`) is not matched against
 * anything either — "locates nothing" is not "is the same file as".
 *
 * WHICH SPELLING DISAGREEMENTS THIS SEES
 *
 * Case and `..` are resolved by `normalizeSchedulerPath`. Separators never
 * arrive here as a disagreement: the protocol's `intersectPaths` folds them, so
 * `src\a.ts` against `src/a.ts` is already a real collision and the pair does
 * not reach this guard at all (T-159 review, risk 4).
 *
 * **Unicode normalization** is covered as of T-166. `café.ts` written NFC by a
 * Linux runner and NFD by a macOS one is still disjoint to the audit
 * comparison — correctly, since that one must not rewrite what a receipt
 * recorded — but it is one path to this function, so the guard fires and the
 * serialized-pair route no longer records `overbroad` about two receipts that
 * may have written the same bytes.
 *
 * That was a documented limit (T-159 review F1) for as long as the fix was
 * unmeasured, because `.normalize("NFC")` lives in the SCHEDULER's comparison
 * and widens what every plan serializes, while narrowing it to this function
 * would split a shared definition. T-166 took the decision with the plan-level
 * cost measured: on the board at the time, nil — no declared path carried a
 * character NFC could touch — against a mixed-OS fleet in which the two forms
 * otherwise ran in parallel over one file.
 */
export function schedulerTreatsAsSameFile(left: string, right: string): boolean {
  const a = normalizeSchedulerPath(left);
  const b = normalizeSchedulerPath(right);
  if (!a || !b) return false;
  return a === b;
}

/**
 * The separator `planExecution` puts between the two sides of a collision
 * cause, making `ClaimCollision.paths` and `causes[].paths` DISPLAY LABELS
 * (`"src/a.ts ↔ src/a.ts"`), not paths.
 *
 * Exported so the producer and the consumer cannot disagree about it: T-133
 * review MEDIA-2 found the detector consuming those labels as if they were
 * paths, which would record `path: "src/a.ts ↔ src/a.ts"` in an immutable
 * violation. `violations.ts` refuses any value containing it.
 */
export const CAUSE_LABEL_SEPARATOR = " ↔ ";
