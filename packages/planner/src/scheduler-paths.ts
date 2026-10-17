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
 * Unicode to canonical NFD (T-166) because a mixed macOS/Linux fleet reports
 * one filename two ways. That one compares OBSERVED paths — what a receipt reported against
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
 * Segments joined, `.` dropped, `..` resolved, case folded, canonical Unicode
 * normal form (NFD).
 *
 * Returns `""` when the path locates nothing — `/`, a bare `..`, or a `..` that
 * would pop a `**`. The scheduler reads that empty result as "unknown, collide
 * broadly" rather than as "empty".
 *
 * Normalization is applied FIRST, to the whole input, so the two spellings of
 * one filename become one string before anything structural reads it:
 * separator folding, `..` resolution, the `**` check and case folding then all
 * see identical text whichever form arrived.
 *
 * WHY NFD AND NOT NFC — this comparator does PREFIX matching, not only
 * equality. For equality the two canonical forms are interchangeable: they
 * induce the same equivalence class, so either unifies `café.ts` NFC with
 * `café.ts` NFD. But `pathOverlap` compares the truncated static prefixes
 * `staticPrefix` cuts at the first wildcard — possibly mid-segment — with
 * `startsWith`, and **NFC is not prefix-preserving**: `"cafe"` is a prefix of
 * `cafe`+`◌́`+`.ts` and is NOT a prefix of `café.ts`, because composing the
 * base letter with its mark consumes the letter the prefix ended on. So
 * `src/cafe*` declared by one task stops matching the NFD spelling of
 * `src/café.ts` declared by another, and a pair the scheduler used to
 * serialize runs in parallel over one file. Over every ASCII letter against a
 * dozen common marks, one mark per name: NFC breaks a large fraction of such
 * prefixes and NFD breaks none (T-166 review F1, which found this with a
 * repro).
 *
 * NFD decomposes instead, so the base letter survives as its own code point
 * and a prefix cut at a base letter still holds.
 *
 * WHAT NO NORMAL FORM FIXES, AND WHERE IT IS FIXED INSTEAD — canonical
 * REORDERING. Every normal form sorts combining marks by canonical combining
 * class, so a prefix cut BETWEEN two marks written out of canonical order does
 * not survive the sort. `src/à*` against `src/à`+`◌̣`+`.ts` — grave (ccc 230)
 * written first, dot-below (ccc 220) second, so NFD swaps them — left `src/à`
 * no longer a prefix, and that pair serialized on `52c73af` and ran parallel
 * under T-166 (T-166 review attempt 2, N1).
 *
 * That is a property of the TRUNCATION, not of the form: no choice of normal
 * form delivers it. **T-170 fixed it where it lives**, in `staticPrefix`,
 * which now drops trailing combining marks so a static prefix always ends on a
 * base character. The exception is closed — see that function for the `\p{M}`
 * versus `\p{Mn}` argument and for what the trim costs in breadth.
 *
 * Note meanwhile what the single-mark measurement above can and cannot show: a
 * sweep with one mark per name has no prefix boundary between two marks, which
 * is the only place NFD breaks, so "NFD breaks none" is evidence about
 * composition and says nothing about reordering. The same sweep over two marks
 * breaks roughly a third of its probes under NFD and slightly more under NFC.
 * Those breaks are now absorbed by the trim rather than reaching a comparison.
 *
 * It was never reachable from an observed board either — it needs a hand-typed
 * `filesAffected` glob cut between two marks in non-canonical order, and macOS
 * and Linux both report a single combining sequence already in canonical
 * order, which is the whole case this task exists for. Fixed anyway, because a
 * comparison that is conservative only for the inputs seen so far is not
 * conservative.
 *
 * CANONICAL, NOT COMPATIBILITY. NFKC/NFKD would be a bug, not a stricter
 * version of this: they map 215 code points onto characters this function
 * treats as structure — `U+2025` becomes `..` (path traversal), `U+FF0F`
 * becomes `/` (a separator), `U+FF0A` becomes `*` (a wildcard) — so
 * `src/x/‥/a.ts` would normalize to `src/a.ts`, and a doubled-wildcard path
 * whose next segment is `U+2025` would normalize to `""`, which collides
 * broadly. NFD produces and consumes none of
 * `/ \ . * ? [ ( { ! | , -`, verified by brute force over all 0x110000 code
 * points in three directions, so normalizing this early cannot change how the
 * path splits or which segment a `..` pops. A test pins the distinction
 * because "normalize harder" reads like an improvement (T-166 review F4).
 *
 * T-166 added this, for the SCHEDULER and not only for the guard below — they
 * read this one definition precisely so they cannot disagree about what one
 * filename is. With NFD the effect is to widen for every disagreement the
 * fleet actually produces: two paths differing only in the normal form of one
 * combining sequence become the same file. The intended direction is that no
 * comparison which matched before stops matching, and the reordering case
 * above was the known exception until T-170 closed it in `staticPrefix`. Treat
 * that as measured rather than proved: it is an all-ordered-pairs A/B against
 * the pre-change build (2601 pairs, 0 narrowing), and the two narrowings found
 * so far — this one and T-170's own first attempt — were both invisible to a
 * hand-picked shape list, so re-measure that way before widening the claim.
 * macOS reports NFD and Linux NFC,
 * so on a mixed-OS fleet the alternative was a scheduler that ran two writers
 * of one file in parallel.
 */
export function normalizeSchedulerPath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.trim().normalize("NFD").replaceAll("\\", "/").split("/")) {
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
 * Case and `..` are resolved by `normalizeSchedulerPath`.
 *
 * Separators are folded by the protocol's `intersectPaths`, so on the
 * SERIALIZED-PAIR route a `src\a.ts` / `src/a.ts` pair is already a real
 * intersection and short-circuits before this guard is reached (T-159 review,
 * risk 4). That is a fact about one route, not about this function: T-163 Part
 * A added a second caller, the collision route, whose gate is "nothing was
 * RECORDED" rather than "nothing INTERSECTED". A backslash pair whose
 * intersection is entirely claim-covered records nothing, so it does reach
 * this guard, matches, and emits the "may have been MISSED" warning although
 * `intersectPaths` saw the collision and the claims legitimately covered it.
 * That false positive is the deliberate cost of the T-163 review F1 gate and
 * predates T-166 (T-166 review F2).
 *
 * **Unicode normalization** is covered as of T-166. `café.ts` written NFC by a
 * Linux runner and NFD by a macOS one is still disjoint to the audit
 * comparison — correctly, since that one must not rewrite what a receipt
 * recorded — but it is one path to this function, so the guard fires and the
 * serialized-pair route no longer records `overbroad` about two receipts that
 * may have written the same bytes.
 *
 * That was a documented limit (T-159 review F1) for as long as the fix was
 * unmeasured, because the normalization lives in the SCHEDULER's comparison
 * and widens what every plan serializes, while narrowing it to this function
 * would split a shared definition. T-166 took the decision with the plan-level
 * cost measured: on the board at the time, nil — no declared path carried a
 * character canonical normalization could touch — against a mixed-OS fleet in
 * which the two forms otherwise ran in parallel over one file.
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
