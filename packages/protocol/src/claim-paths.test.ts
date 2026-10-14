import assert from "node:assert/strict";
import test from "node:test";
import {
  claimCovers,
  intersectPaths,
  isRedactedPath,
  makeClaimViolation,
  normalizePath,
  pathsOverlap,
  redactedPathCount,
  REDACTED_SENTINEL,
  violationIdFor
} from "./claim-paths";
import type { ResourceClaim } from "./entities";

const WAVE_ID = "11111111-1111-4111-8111-111111111111";
const DETECTED_AT = "2026-10-14T00:00:00.000Z";

// ---- T-133 AC5: the golden id. Computed independently from the three
// pre-refactor implementations (store, planner, the new shared module) and
// found equal across all three -- this pins that the refactor changed no
// existing id. The key order below is load-bearing: violationIdFor seeds the
// hash with JSON.stringify(ordered), and JSON key order is insertion order,
// so reordering the object literal inside violationIdFor would silently
// change every id already recorded and orphan every row a store has
// journaled. This test exists so that reorder is caught here, not in a
// production store. ----

test("AC5: violationIdFor reproduces the pinned golden id (key order is load-bearing)", () => {
  const id = violationIdFor({
    waveId: WAVE_ID,
    kind: "collision",
    taskAId: "T-001",
    taskBId: "T-002",
    path: "packages/store/src/a.ts",
    detectedAt: DETECTED_AT,
    source: "derived-from-receipts"
  });
  assert.equal(id, "862c8913-add9-53d1-89bd-011c338ec2f5");

  // A different key ORDER for the exact same field values must reproduce a
  // DIFFERENT id if the implementation ever stopped controlling the order
  // itself (e.g. destructured straight into JSON.stringify). This does not
  // call violationIdFor with reordered keys -- JS object key order is fixed
  // once constructed and violationIdFor rebuilds its own literal regardless
  // of input order -- it instead proves the seed really is order-sensitive,
  // so the golden value above is not a coincidence of a key order that
  // wouldn't have mattered anyway.
  const reordered = JSON.stringify({
    kind: "collision", waveId: WAVE_ID, taskBId: "T-002", taskAId: "T-001",
    source: "derived-from-receipts", path: "packages/store/src/a.ts", detectedAt: DETECTED_AT
  });
  const canonical = JSON.stringify({
    waveId: WAVE_ID, kind: "collision", taskAId: "T-001", taskBId: "T-002",
    path: "packages/store/src/a.ts", detectedAt: DETECTED_AT, source: "derived-from-receipts"
  });
  assert.notEqual(reordered, canonical, "JSON.stringify key order follows insertion order, so this must differ");
});

test("makeClaimViolation attaches exactly violationIdFor's id and nothing else", () => {
  const fields = {
    waveId: WAVE_ID, kind: "overbroad" as const, taskAId: "T-001", taskBId: "T-002",
    path: "docs/readme.md", detectedAt: DETECTED_AT, source: "derived-from-receipts" as const
  };
  const violation = makeClaimViolation(fields);
  assert.deepEqual(violation, { ...fields, id: violationIdFor(fields) });
});

test("isRedactedPath recognizes only the exact sentinel literal", () => {
  assert.equal(REDACTED_SENTINEL, "mapctx:redacted");
  assert.ok(isRedactedPath(REDACTED_SENTINEL));
  assert.ok(!isRedactedPath("mapctx:redacted "));
  assert.ok(!isRedactedPath("src/a.ts"));
  assert.ok(!isRedactedPath(""));
});

test("normalizePath folds separators and strips leading ./, doubled and trailing slashes", () => {
  assert.equal(normalizePath("src/a.ts"), "src/a.ts");
  assert.equal(normalizePath("./src/a.ts"), "src/a.ts");
  assert.equal(normalizePath("src\\a.ts"), "src/a.ts");
  assert.equal(normalizePath("src//a.ts"), "src/a.ts");
  assert.equal(normalizePath("src/a.ts/"), "src/a.ts");
  assert.equal(normalizePath("/"), "/");
  // Case is preserved: this compares OBSERVED paths, not declared ones.
  assert.equal(normalizePath("SRC/A.ts"), "SRC/A.ts");
});

// ---- G1 (T-131 review ALTO-2): a redacted path is incomparable, overlapping
// nothing, not even another redacted element. Without this, two receipts
// redacted to disjoint real files "collide" on the shared sentinel string. ----

test("pathsOverlap G1: a redacted path overlaps nothing, including another redacted path", () => {
  assert.equal(pathsOverlap(REDACTED_SENTINEL, REDACTED_SENTINEL), false, "two sentinels must never 'overlap'");
  assert.equal(pathsOverlap(REDACTED_SENTINEL, "src/a.ts"), false);
  assert.equal(pathsOverlap("src/a.ts", REDACTED_SENTINEL), false);
});

test("pathsOverlap finds exact matches, glob/prefix overlaps, and real disjoint paths", () => {
  assert.ok(pathsOverlap("src/a.ts", "src/a.ts"));
  assert.ok(pathsOverlap("src/**", "src/a.ts"));
  assert.ok(pathsOverlap("src/a.ts", "src/**"));
  assert.ok(pathsOverlap("src/**", "src/nested/a.ts"));
  assert.ok(!pathsOverlap("src/a.ts", "docs/a.ts"));
  assert.ok(!pathsOverlap("packages/store", "packages/store-ui/x.ts"), "sibling directories with a shared prefix must stay disjoint");
  // Case is significant for observed paths -- unlike the planner's
  // declared-claim normalizePath, which case-folds (see index.test.ts).
  assert.ok(!pathsOverlap("SRC/a.ts", "src/a.ts"));
});

// ---- intersectPaths is used in BOTH directions by both callers: positively
// to find real collisions, negatively to prove two receipts never conflicted
// (the "overbroad" / serializedPairs route). Both directions need their own
// assertion, since a bug in either corrupts a different claim. ----

test("intersectPaths positive: returns the normalized, sorted, deduplicated overlap", () => {
  assert.deepEqual(intersectPaths(["src/b.ts", "src/a.ts", "./src/a.ts"], ["src/a.ts", "docs/x.md"]), ["src/a.ts"]);
  assert.deepEqual(intersectPaths(["src/**"], ["src/a.ts", "src/b.ts"]), ["src/a.ts", "src/b.ts"]);
});

test("intersectPaths negative: genuinely disjoint lists return empty, proving non-collision rather than omitting it", () => {
  assert.deepEqual(intersectPaths(["src/a.ts"], ["docs/b.md"]), []);
  assert.deepEqual(intersectPaths([], ["src/a.ts"]), []);
  // A redacted element must not accidentally manufacture an intersection via G1.
  assert.deepEqual(intersectPaths([REDACTED_SENTINEL], [REDACTED_SENTINEL]), []);
});

test("claimCovers: only a write claim on an overlapping path by the same task covers it", () => {
  const claims: ResourceClaim[] = [
    { claimId: "11111111-1111-4111-8111-100000000001", taskId: "T-001", domains: [], paths: ["src/a.ts"], mode: "write", confidence: "high", provenance: "authored" },
    { claimId: "11111111-1111-4111-8111-100000000002", taskId: "T-002", domains: [], paths: ["src/a.ts"], mode: "read", confidence: "high", provenance: "authored" }
  ];
  assert.ok(claimCovers(claims, "T-001", "src/a.ts"));
  assert.ok(!claimCovers(claims, "T-002", "src/a.ts"), "a read claim does not cover");
  assert.ok(!claimCovers(claims, "T-003", "src/a.ts"), "no claim for this task");
  assert.ok(!claimCovers(claims, "T-001", "docs/b.md"), "no overlapping path");
  assert.ok(!claimCovers(claims, "T-001", REDACTED_SENTINEL), "a redacted path is not comparable, so it covers nothing");
});

test("redactedPathCount counts sentinel elements only", () => {
  assert.equal(redactedPathCount(["src/a.ts", REDACTED_SENTINEL, "src/b.ts"]), 1);
  assert.equal(redactedPathCount([REDACTED_SENTINEL, REDACTED_SENTINEL]), 2);
  assert.equal(redactedPathCount(["src/a.ts"]), 0);
  assert.equal(redactedPathCount([]), 0);
});
