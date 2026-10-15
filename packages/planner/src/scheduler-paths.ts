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
 * work runs, so it resolves `..`, refuses to pop a `**`, and folds case because
 * the scheduler must err toward serializing on filesystems that do. That one
 * compares OBSERVED paths — what a receipt reported against what a violation
 * row recorded — where case is meaningful and `..` does not occur. Merging them
 * would make the audit record lossy or the scheduler case-blind; equivalence
 * was never proven, so the two comparisons stay two functions with two names'
 * worth of documentation.
 *
 * What T-159 adds is a third thing, which is neither of those two: a way to ask
 * "would the scheduler have called these the same file?" about paths the audit
 * comparison found disjoint. That question has exactly one honest answer and it
 * has to come from the scheduler's own rules, which is why this module exists
 * instead of a second case-folding helper in `violations.ts`.
 */

/**
 * Segments joined, `.` dropped, `..` resolved, case folded.
 *
 * Returns `""` when the path locates nothing — `/`, a bare `..`, or a `..` that
 * would pop a `**`. The scheduler reads that empty result as "unknown, collide
 * broadly" rather than as "empty".
 */
export function normalizeSchedulerPath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.trim().replaceAll("\\", "/").split("/")) {
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
 * WHAT THIS DOES NOT SEE (the guard's documented limits)
 *
 * Case and `..` are covered, and separators are folded before this is ever
 * reached. The one disagreement that escapes is **Unicode normalization**:
 * `café.ts` written NFC by one runner and NFD by another is disjoint to the
 * audit comparison AND to this function, so a guard built on it does not fire
 * and the serialized-pair route records `overbroad` — a permanent "these two
 * did not conflict" about receipts that may have written the same bytes
 * (T-159 review F1). Reachability is narrow but real: the pair must have been
 * serialized, and the two receipts must come from runners that disagree about
 * normal form — macOS reports NFD, Linux NFC. A mixed-OS fleet is what this
 * epic is building toward.
 *
 * It is documented rather than fixed on purpose. The one-line fix is
 * `.normalize("NFC")` inside `normalizeSchedulerPath`, but that function is the
 * SCHEDULER's comparison: adding it there widens what gets serialized for every
 * plan, which is a decision about scheduling behaviour and not a patch to a
 * guard. Narrowing the fix to this function instead would split the two apart,
 * and they share a definition precisely so they cannot disagree. Either way it
 * is a choice someone should make deliberately, with the plan-level cost in
 * front of them.
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
