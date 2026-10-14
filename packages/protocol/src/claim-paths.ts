/**
 * T-133: THE one definition of how a claim violation compares paths and how it
 * is identified. Previously there were two.
 *
 * WHY THIS LIVES IN @mapctx/protocol
 * `packages/store/src/violations.ts` and `packages/planner/src/violations.ts`
 * were structural twins: normalizePath, pathsOverlap, actualIntersection,
 * claimCovers and the stable id, written twice. T-131 then hardened the store
 * copy against redacted evidence and the planner copy stayed as it was, so one
 * package published a guarded detector and the other an unguarded one under a
 * near-identical name (T-131 review MEDIA-3).
 *
 * The planner depends on @mapctx/protocol and nothing else; the store depends
 * on protocol and core. So protocol is the only existing package both can
 * import without adding a dependency edge, and it cannot close a cycle because
 * it depends on neither. It is also where the shared pure helpers over these
 * entities already live (canonicalJson, the money and effort arithmetic), and
 * where ClaimViolation, ResourceClaim and RunReceipt are defined -- the
 * identity of a protocol entity belongs next to the entity.
 *
 * NOT THE SAME normalizePath AS THE PLANNER'S SCHEDULER
 * `packages/planner/src/index.ts` has its own `normalizePath`, and the two are
 * deliberately NOT merged. That one answers "could these two DECLARED claims
 * collide?" before any work runs, so it walks segments, resolves `..`, folds
 * case for macOS/Windows, and refuses to pop a `**`. This one answers "are
 * these two OBSERVED paths the same file?" over paths a receipt reported and a
 * violation row recorded, where case is meaningful and `..` does not appear.
 * Folding them would either make the scheduler's comparison case-sensitive or
 * make recorded violation paths lossy; equivalence was not proven and is not
 * claimed. See the note at that function.
 *
 * THE REDACTION GUARD THAT LIVES HERE (T-131 review ALTO-2, guard G1)
 * A redacted path is NOT COMPARABLE: it overlaps nothing, not even another
 * redacted path. Without that, every sentinel equalled every other one and two
 * receipts with completely disjoint files "collided" -- the detector then
 * recorded an immutable claim that two tasks fought over a file that does not
 * exist. A privacy operation must never be able to fabricate an audit fact.
 *
 * G1 is necessary but NOT sufficient, and the other two guards cannot move
 * here because they are about receipts and plans, not about a pair of strings:
 *   G2 -- skip a serialized pair when either receipt holds a redacted path.
 *         `actualIntersection` is used NEGATIVELY there ("they never
 *         intersected, so serializing them was unnecessary"), so G1 making the
 *         sentinel incomparable turns an unknown into a confident FALSE claim
 *         about tasks that may well have collided.
 *   G3 -- never emit a violation whose own path is the sentinel.
 * Each caller's emission loop owns G2 and G3; the store's violations.ts
 * records the measured mutation matrix for which of them is individually
 * load-bearing. Both callers must have all three, which is the point of T-133.
 */

import type { ClaimViolation, ResourceClaim } from "./entities";
import { createHash } from "node:crypto";

/**
 * The value a redacted string leaf becomes (T-126). It lives here rather than
 * in the store because it is a value that travels in events and receipts, and
 * because both the store and the planner must recognise it; a second literal
 * somewhere else is exactly the divergence this module exists to prevent.
 * `@mapctx/store` re-exports it, so its published name is unchanged.
 */
export const REDACTED_SENTINEL = "mapctx:redacted";

/** Whether this path element is a redaction sentinel rather than a path. */
export function isRedactedPath(value: string): boolean {
  return value === REDACTED_SENTINEL;
}

/** Windows separators to POSIX, no leading `./`, no doubled or trailing slash. */
export function normalizePath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

function staticPrefix(value: string): string {
  const wildcard = value.search(/[?*[]/);
  return normalizePath(wildcard < 0 ? value : value.slice(0, wildcard)).replace(/\/$/, "");
}

/**
 * Glob-ish overlap between two observed paths. Guard G1: a redacted element is
 * incomparable, so it overlaps nothing -- including another redacted element.
 */
export function pathsOverlap(left: string, right: string): boolean {
  if (isRedactedPath(left) || isRedactedPath(right)) return false;
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const aPrefix = staticPrefix(a);
  const bPrefix = staticPrefix(b);
  if (aPrefix === bPrefix || aPrefix.startsWith(`${bPrefix}/`) || bPrefix.startsWith(`${aPrefix}/`)) return true;
  const aDir = a.endsWith("/**") || a.endsWith("/*") || a.endsWith("/");
  const bDir = b.endsWith("/**") || b.endsWith("/*") || b.endsWith("/");
  if (aDir && b.startsWith(`${a.slice(0, a.lastIndexOf("/"))}/`)) return true;
  if (bDir && a.startsWith(`${b.slice(0, b.lastIndexOf("/"))}/`)) return true;
  return false;
}

/**
 * The normalized, sorted, de-duplicated set of paths two changed-file lists
 * have in common. Used POSITIVELY to find collisions and NEGATIVELY to decide
 * that a serialized pair never conflicted -- see G2 in the header before
 * relying on an empty result.
 */
export function intersectPaths(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set(left.flatMap(a => right.filter(b => pathsOverlap(a, b)).map(normalizePath)))].sort();
}

/** Whether a write claim held by `taskId` covers the observed path. */
export function claimCovers(claims: readonly ResourceClaim[], taskId: string, path: string): boolean {
  return claims.some(claim => claim.taskId === taskId && claim.mode === "write" && claim.paths.some(claimPath => pathsOverlap(claimPath, path)));
}

/** How many elements of a changed-file list hold the sentinel instead of a path. */
export function redactedPathCount(paths: readonly string[]): number {
  return paths.filter(isRedactedPath).length;
}

function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [hex.slice(0, 8).join(""), hex.slice(8, 12).join(""), hex.slice(12, 16).join(""), hex.slice(16, 20).join(""), hex.slice(20).join("")].join("-");
}

/**
 * THE id derivation, in one place so a lookup can reproduce it exactly.
 *
 * The key order below is load-bearing: the seed is `JSON.stringify(ordered)`,
 * so reordering these keys would change every id and orphan every row already
 * recorded. It is the order both former copies used (the store wrote it out
 * explicitly; the planner relied on the literal's insertion order, which
 * matched), so centralising it here changes no existing id.
 */
export function violationIdFor(fields: Omit<ClaimViolation, "id">): string {
  const ordered = {
    waveId: fields.waveId,
    kind: fields.kind,
    taskAId: fields.taskAId,
    taskBId: fields.taskBId,
    path: fields.path,
    detectedAt: fields.detectedAt,
    source: fields.source
  };
  return stableUuid(`mapctx:claim-violation:${JSON.stringify(ordered)}`);
}

/** A violation plus its derived stable id. */
export function makeClaimViolation(fields: Omit<ClaimViolation, "id">): ClaimViolation {
  return { ...fields, id: violationIdFor(fields) };
}
