import assert from "node:assert/strict";
import test from "node:test";
import { REDACTED_SENTINEL } from "@mapctx/protocol";
import {
  deriveClaimViolations, detectClaimViolations, detectViolations, detectWaveClaimViolations,
  pathsOverlap, type TaskReceipt
} from "./violations";
import { CAUSE_LABEL_SEPARATOR, normalizeSchedulerPath, schedulerTreatsAsSameFile } from "./scheduler-paths";

const uuid = (n: string) => `00000000-0000-5000-8000-00000000000${n}`;
const receipt = (dispatchId: string, changedFiles: string[], outcome: "completed" | "failed" = "completed") => ({
  schemaVersion: 1, dispatchId, attempt: 1, outcome,
  startedAt: "2026-08-17T10:00:00.000Z", endedAt: "2026-08-17T10:01:00.000Z",
  changedFiles, usageEvents: [], evidence: [], failure: outcome === "failed" ? { category: "executor-error" as const, message: "x", retryable: true } : null
});

/** Captures process "warning" events emitted while `fn` runs. */
async function captureWarnings(fn: () => void): Promise<string[]> {
  const warnings: string[] = [];
  const onWarning = (w: Error) => warnings.push(String(w.message));
  process.on("warning", onWarning);
  fn();
  await new Promise(resolve => setImmediate(resolve));
  process.off("warning", onWarning);
  return warnings;
}

test("collision emitted only after successful terminal receipts and uncovered overlap", () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/shared.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["src/shared.ts"]) }
  ];
  const result = detectClaimViolations({
    waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }], receipts, claims: [], detectedAt: "2026-08-17T10:02:00.000Z"
  });
  assert.deepEqual(result.map(item => [item.kind, item.path, item.taskAId, item.taskBId]), [["collision", "src/shared.ts", "T-001", "T-002"]]);
  assert.deepEqual(detectClaimViolations({ waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }], receipts: receipts.slice(0, 1) }), []);
  assert.deepEqual(detectClaimViolations({ waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }], receipts: receipts.map(item => ({ ...item, receipt: receipt(item.receipt.dispatchId, item.receipt.changedFiles, "failed") })) }), []);
});

// Control for the fabrication tests below: when both receipts are intact and
// genuinely disjoint, the overbroad claim ("serializing these was
// unnecessary") IS the correct, legitimate output and must still be emitted.
test("overbroad uses serialized explanation and actual receipts", () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["docs/b.md"]) }
  ];
  const result = detectClaimViolations({
    waves: [
      { waveId: uuid("3"), taskIds: ["T-001"] },
      { waveId: uuid("4"), taskIds: ["T-002"] }
    ], receipts,
    serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: ["src/**"] }],
    detectedAt: "2026-08-17T10:02:00.000Z"
  });
  assert.deepEqual(result.map(item => [item.kind, item.waveId, item.path]), [["overbroad", uuid("3"), "src/**"]]);
});

// ---- T-133 AC1/AC4: the planner publishes the shared G1 primitive under its
// own historical name, and it must be the exact @mapctx/protocol function,
// not a local twin that happens to behave the same today. ----

test("AC1/AC4: planner's published pathsOverlap is @mapctx/protocol's pathsOverlap by reference", () => {
  const protocolModule = require("@mapctx/protocol") as Record<string, unknown>;
  assert.equal(pathsOverlap, protocolModule.pathsOverlap);
  assert.equal(typeof pathsOverlap, "function");
});

test("AC4: detectClaimViolations and its three aliases share one identity, arity 1, array return", () => {
  for (const fn of [detectClaimViolations, deriveClaimViolations, detectViolations, detectWaveClaimViolations]) {
    assert.equal(typeof fn, "function");
    assert.equal(fn.length, 1, "published arity must stay 1");
  }
  assert.equal(deriveClaimViolations, detectClaimViolations);
  assert.equal(detectViolations, detectClaimViolations);
  assert.equal(detectWaveClaimViolations, detectClaimViolations);
  assert.ok(Array.isArray(detectClaimViolations({ receipts: [] })), "must return an array even for empty input");
});

// ---- T-133 AC2, non-fabrication direction: a redacted path must never
// manufacture an audit fact the planner didn't actually observe. Mirrors
// the store's ALTO-2a/serializedPairs tests, now exercised through the
// planner's own `detectClaimViolations`. ----

test("AC2 non-fabrication: two receipts redacted to disjoint (now-sentinel) paths never fabricate a collision", async () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), [REDACTED_SENTINEL]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), [REDACTED_SENTINEL]) }
  ];
  const warnings = await captureWarnings(() => {
    const result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }], receipts, claims: [], detectedAt: "2026-08-17T10:02:00.000Z"
    });
    assert.deepEqual(result, [], "a sentinel must never be treated as overlapping another sentinel");
  });
  assert.ok(warnings.some(w => /INCOMPLETE/.test(w) && /cannot tell/.test(w)), JSON.stringify(warnings));
});

test("AC2 non-fabrication: a real collision redacted on one side must not fabricate an 'overbroad' (did-not-conflict) violation", async () => {
  const SHARED_PATH = "src/acme-prod/secret.ts";
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), [REDACTED_SENTINEL]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), [SHARED_PATH]) }
  ];
  const input = {
    waves: [{ waveId: uuid("3"), taskIds: ["T-001"] }, { waveId: uuid("4"), taskIds: ["T-002"] }],
    receipts,
    serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: [SHARED_PATH] }],
    detectedAt: "2026-08-17T10:02:00.000Z"
  };
  const warnings = await captureWarnings(() => {
    const result = detectClaimViolations(input);
    assert.deepEqual(result.filter(item => item.kind === "overbroad"), [],
      "redacting one side must never produce a permanent claim that two possibly-colliding tasks did not conflict");
  });
  assert.ok(warnings.some(w => /INCOMPLETE/.test(w) && w.includes("T-001")), JSON.stringify(warnings));
  assert.ok(!warnings.join("|").includes(SHARED_PATH.split("/").pop()!), "the warning must never echo the untouched sibling's path content");
});

test("AC2 non-fabrication: a sentinel path supplied directly in serializedPairs.paths is filtered, never emitted", () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["docs/b.md"]) }
  ];
  const result = detectClaimViolations({
    waves: [{ waveId: uuid("3"), taskIds: ["T-001"] }, { waveId: uuid("4"), taskIds: ["T-002"] }],
    receipts,
    serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: [REDACTED_SENTINEL, "src/**"] }],
    detectedAt: "2026-08-17T10:02:00.000Z"
  });
  assert.deepEqual(result.map(item => item.path), ["src/**"], "the sentinel element must be dropped, the real path kept");
  assert.ok(!result.some(item => item.path === REDACTED_SENTINEL));
});

// ---- T-133 AC2, non-suppression direction: a real audit fact on paths that
// were NOT redacted must still be reported, even when another element of the
// same list (a sibling file, or the other side of a pair) is redacted or when
// no redaction is involved at all. ----

test("AC2 non-suppression: a real collision on an unredacted path survives even when a sibling element of the same list is redacted", () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), [REDACTED_SENTINEL, "src/shared.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["src/shared.ts"]) }
  ];
  const result = detectClaimViolations({
    waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }], receipts, claims: [], detectedAt: "2026-08-17T10:02:00.000Z"
  });
  assert.deepEqual(result.map(item => [item.kind, item.path]), [["collision", "src/shared.ts"]],
    "the redacted sibling element must not suppress the real collision on the untouched path");
});

test("AC2 non-suppression: a legitimate overbroad claim (both receipts intact, genuinely disjoint) is still emitted, not swallowed by the redaction guards", () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["docs/b.md"]) }
  ];
  const result = detectClaimViolations({
    waves: [{ waveId: uuid("3"), taskIds: ["T-001"] }, { waveId: uuid("4"), taskIds: ["T-002"] }],
    receipts,
    serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: ["src/a.ts"] }],
    detectedAt: "2026-08-17T10:02:00.000Z"
  });
  assert.deepEqual(result.map(item => item.kind), ["overbroad"], "G2/G3 must not fire when nothing is redacted");
});

// ---- T-159 (T-133 review MEDIA-1): the two path comparisons disagree, and the
// serialized-pair route must not read that disagreement as proof of innocence.
//
// Both directions are tested together on purpose. A guard that skips the pair
// is only correct if it still lets a legitimate `overbroad` through, and a
// one-directional test here would be satisfied by a guard that suppresses
// everything -- which is the failure mode that makes a detector useless rather
// than wrong.

test("T-159: a case-only spelling difference between receipts does not fabricate overbroad", async () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["SRC/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["src/a.ts"]) }
  ];
  let result: ReturnType<typeof detectClaimViolations> = [];
  const warnings = await captureWarnings(() => {
    result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }],
      receipts,
      serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: ["src/a.ts"] }],
      detectedAt: "2026-08-17T10:02:00.000Z"
    });
  });
  // On macOS and Windows these are one file, which is why the scheduler
  // serialized the pair. Recording "they did not conflict" would be a
  // permanent false audit fact about tasks that wrote the same bytes.
  assert.deepEqual(result.filter(item => item.kind === "overbroad"), []);
  // Skipping silently would look identical to a clean pair. This fixture puts
  // the two tasks in one wave AND in serializedPairs, so after T-163 both
  // routes speak about the same disagreement, and they say different things:
  // the collision route may have MISSED a real collision, the serialized-pair
  // route cannot establish that they never intersected. Asserting the pair of
  // them by name rather than counting keeps either one from going quiet.
  const spelling = warnings.filter(w => w.includes("INCOMPLETE") && w.includes("SRC/a.ts vs src/a.ts"));
  assert.equal(spelling.length, 2, JSON.stringify(warnings));
  assert.equal(spelling.filter(w => w.includes("the serialized pair") && w.includes("no overbroad finding")).length, 1);
  assert.equal(spelling.filter(w => w.includes("the wave pair") && w.includes("MISSED")).length, 1);
});

test("T-159: a `..` that resolves to the other receipt's path does not fabricate overbroad", async () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/x/../a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["src/a.ts"]) }
  ];
  let result: ReturnType<typeof detectClaimViolations> = [];
  const warnings = await captureWarnings(() => {
    result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }],
      receipts,
      serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: ["src/a.ts"] }],
      detectedAt: "2026-08-17T10:02:00.000Z"
    });
  });
  assert.deepEqual(result.filter(item => item.kind === "overbroad"), []);
  // Both routes again: same wave and a serialized pair. See the previous test.
  assert.equal(warnings.filter(w => w.includes("INCOMPLETE")).length, 2, JSON.stringify(warnings));
  assert.equal(warnings.filter(w => w.includes("the serialized pair")).length, 1);
  assert.equal(warnings.filter(w => w.includes("the wave pair")).length, 1);
});

test("T-159: a legitimate overbroad between genuinely disjoint paths is still emitted", async () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts", "SRC/b.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["docs/b.md", "src/c.ts"]) }
  ];
  let result: ReturnType<typeof detectClaimViolations> = [];
  const warnings = await captureWarnings(() => {
    result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }],
      receipts,
      serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: ["src/**"] }],
      detectedAt: "2026-08-17T10:02:00.000Z"
    });
  });
  // `SRC/b.ts` differs in case from nothing on the other side, and `src/c.ts`
  // is a different file from `src/a.ts`. Nothing here is one file spelled two
  // ways, so the guard must stay out of the way: suppressing this would make
  // the whole route dead rather than safe.
  assert.deepEqual(result.map(item => [item.kind, item.path]), [["overbroad", "src/**"]]);
  assert.equal(warnings.filter(w => w.includes("INCOMPLETE")).length, 0);
});

test("T-159: the guard compares across the pair, not within one receipt", async () => {
  // `src/a.ts` and `SRC/a.ts` on the SAME side say nothing about whether the
  // two tasks touched one file, so this pair is still reportable.
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts", "SRC/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["docs/b.md"]) }
  ];
  let result: ReturnType<typeof detectClaimViolations> = [];
  const warnings = await captureWarnings(() => {
    result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }],
      receipts,
      serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: ["src/**"] }],
      detectedAt: "2026-08-17T10:02:00.000Z"
    });
  });
  assert.deepEqual(result.map(item => [item.kind, item.path]), [["overbroad", "src/**"]]);
  assert.equal(warnings.filter(w => w.includes("INCOMPLETE")).length, 0);
});

test("T-159: an unresolvable path is not matched against anything", async () => {
  // `..` alone normalizes to "" under the scheduler's rules. "Locates nothing"
  // is not "is the same file as", so it must not silence the pair.
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), [".."]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["docs/b.md"]) }
  ];
  let result: ReturnType<typeof detectClaimViolations> = [];
  const warnings = await captureWarnings(() => {
    result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }],
      receipts,
      serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: ["src/**"] }],
      detectedAt: "2026-08-17T10:02:00.000Z"
    });
  });
  assert.deepEqual(result.map(item => [item.kind, item.path]), [["overbroad", "src/**"]]);
  assert.equal(warnings.filter(w => w.includes("INCOMPLETE")).length, 0);
});

// ---- T-159 (T-133 review MEDIA-2): `ClaimCollision.paths` and `causes[].paths`
// are display labels. Consuming them as paths records `"A ↔ B"` as the path of
// an immutable violation.

test("T-159: a display label is never recorded as a violation path", () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["docs/b.md"]) }
  ];
  const result = detectClaimViolations({
    waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }],
    receipts,
    // Exactly what wiring planExecution's serializedPairs straight in produces.
    serializedPairs: [{
      taskAId: "T-001",
      taskBId: "T-002",
      paths: [`src/a.ts${CAUSE_LABEL_SEPARATOR}src/a.ts`],
      causes: [{ paths: [`src/a.ts${CAUSE_LABEL_SEPARATOR}src/a.ts`] }]
    }],
    detectedAt: "2026-08-17T10:02:00.000Z"
  });
  // Stated before the emptiness check: `assert.deepEqual(x, [])` narrows `x` to
  // `never[]`, which would make the interesting assertion unwritable.
  assert.ok(!result.some(item => item.path.includes(CAUSE_LABEL_SEPARATOR)), "no violation may carry a display label as its path");
  assert.deepEqual(result, [], "a label carries no path, so it yields no violation rather than a labelled one");
});

test("T-159: the real paths come from the claims inside each cause", () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["docs/b.md"]) }
  ];
  const result = detectClaimViolations({
    waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }],
    receipts,
    serializedPairs: [{
      taskAId: "T-001",
      taskBId: "T-002",
      // The label array is the only thing planExecution puts in `paths`; the
      // claims are where the declared paths actually live.
      paths: [`src/** ${""}${CAUSE_LABEL_SEPARATOR.trim()} src/**`],
      causes: [{
        paths: [`src/**${CAUSE_LABEL_SEPARATOR}src/**`],
        claimA: { paths: ["src/**"] },
        claimB: { paths: ["src/lib/**"] }
      }]
    }],
    detectedAt: "2026-08-17T10:02:00.000Z"
  });
  assert.deepEqual(result.map(item => [item.kind, item.path]), [
    ["overbroad", "src/**"],
    ["overbroad", "src/lib/**"]
  ]);
  assert.ok(!result.some(item => item.path.includes(CAUSE_LABEL_SEPARATOR)));
});

test("T-159: the scheduler's normalization is shared, not re-implemented", () => {
  // T-133's whole point: one definition of a path comparison per question. If
  // this ever becomes two functions again, the guard above and the scheduler
  // can drift apart silently.
  assert.equal(normalizeSchedulerPath("SRC/x/../A.ts"), "src/a.ts");
  assert.equal(normalizeSchedulerPath("./src//a.ts"), "src/a.ts");
  assert.equal(normalizeSchedulerPath(".."), "");
  // A `..` that would pop a `**` is unresolvable rather than narrowed.
  assert.equal(normalizeSchedulerPath("src/**/.."), "");
  assert.equal(schedulerTreatsAsSameFile("SRC/a.ts", "src/a.ts"), true);
  assert.equal(schedulerTreatsAsSameFile("src/x/../a.ts", "src/a.ts"), true);
  assert.equal(schedulerTreatsAsSameFile("src/a.ts", "src/b.ts"), false);
  // Globs are not interpreted here: a pattern is not "the same file" as a
  // path it would match, or the guard would suppress every legitimate finding.
  assert.equal(schedulerTreatsAsSameFile("src/**", "src/a.ts"), false);
  assert.equal(schedulerTreatsAsSameFile("..", ".."), false);
});

// ---- T-159, keeping the module header's guard matrix honest.
//
// The header states that the FINAL `isRedactedPath` filter is individually
// load-bearing, and explains why: a plan path spelled `./mapctx:redacted` is
// not the sentinel as written, so the per-route filter passes it, and only
// `normalizePath` turns it INTO the sentinel. That claim was measured with a
// reviewer's temporary fixture during T-133 and no committed test carried it --
// the only sentinel fixture used the bare value, which the per-route filter
// catches, so removing the final filter alone left the suite green. Mutating it
// while doing T-159's work surfaced that, so the fixture lands here: the matrix
// in the header should be reproducible from the repo, not from a transcript.

test("T-159/T-133: a normalizable sentinel spelling is caught only by the final filter", () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["docs/b.md"]) }
  ];
  for (const spelling of [`./${REDACTED_SENTINEL}`, `${REDACTED_SENTINEL}/`, `.\\${REDACTED_SENTINEL}`]) {
    const result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001"] }, { waveId: uuid("4"), taskIds: ["T-002"] }],
      receipts,
      serializedPairs: [{ taskAId: "T-001", taskBId: "T-002", paths: [spelling, "src/**"] }],
      detectedAt: "2026-08-17T10:02:00.000Z"
    });
    // The real path survives -- this is a non-suppression check as much as a
    // non-fabrication one.
    assert.deepEqual(
      result.map(item => item.path),
      ["src/**"],
      `${spelling} must not become a violation path, and src/** must still be reported`
    );
    assert.ok(
      !result.some(item => item.path === REDACTED_SENTINEL),
      `${spelling} normalizes to the sentinel, which asserts nothing about any file`
    );
  }
});

// ---- T-163 Part A (T-159 review, risk 4): the collision route stops missing a
// collision in SILENCE.
//
// Every fixture here passes NO `serializedPairs`, so only the collision route
// runs and the warning cannot be the serialized-pair one wearing a different
// hat. The reviewer's measured table is the specification: case and `..` fall
// through, a backslash does not, a real collision and a disjoint wave are
// unchanged.

test("T-163: a case-only disagreement in one wave warns and records nothing", async () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["SRC/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["src/a.ts"]) }
  ];
  let result: ReturnType<typeof detectClaimViolations> = [];
  const warnings = await captureWarnings(() => {
    result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }],
      receipts,
      detectedAt: "2026-08-17T10:02:00.000Z"
    });
  });
  // Part A records nothing: which spelling an immutable `path` would carry is
  // Part B, and belongs with the store's recordClaimViolations.
  assert.deepEqual(result, []);
  const missed = warnings.filter(w => w.includes("INCOMPLETE") && w.includes("the wave pair"));
  assert.equal(missed.length, 1, JSON.stringify(warnings));
  assert.ok(missed[0]?.includes("T-001/T-002"), "the warning must name the pair");
  assert.ok(missed[0]?.includes("SRC/a.ts vs src/a.ts"), "the warning must name the spellings");
  assert.ok(missed[0]?.includes("MISSED"), "this route misses a collision rather than fabricating an absence");
  // Not the serialized-pair warning: no serializedPairs were supplied.
  assert.equal(warnings.filter(w => w.includes("the serialized pair")).length, 0);
});

test("T-163: a `..` disagreement in one wave warns and records nothing", async () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/x/../a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["src/a.ts"]) }
  ];
  let result: ReturnType<typeof detectClaimViolations> = [];
  const warnings = await captureWarnings(() => {
    result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }],
      receipts,
      detectedAt: "2026-08-17T10:02:00.000Z"
    });
  });
  assert.deepEqual(result, []);
  assert.equal(warnings.filter(w => w.includes("INCOMPLETE") && w.includes("the wave pair")).length, 1, JSON.stringify(warnings));
});

test("T-163: a real collision is unchanged and silent", async () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["src/a.ts"]) }
  ];
  let result: ReturnType<typeof detectClaimViolations> = [];
  const warnings = await captureWarnings(() => {
    result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }],
      receipts,
      detectedAt: "2026-08-17T10:02:00.000Z"
    });
  });
  // The intersection is non-empty, so there is nothing to be blind about.
  assert.deepEqual(result.map(item => [item.kind, item.path]), [["collision", "src/a.ts"]]);
  assert.equal(warnings.filter(w => w.includes("INCOMPLETE")).length, 0, JSON.stringify(warnings));
});

test("T-163: a genuinely disjoint wave is unchanged and silent", async () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["docs/b.md"]) }
  ];
  let result: ReturnType<typeof detectClaimViolations> = [];
  const warnings = await captureWarnings(() => {
    result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }],
      receipts,
      detectedAt: "2026-08-17T10:02:00.000Z"
    });
  });
  // The whole point of the guard being equality-only: a clean wave must stay
  // clean and quiet, or the warning becomes noise nobody reads.
  assert.deepEqual(result, []);
  assert.equal(warnings.filter(w => w.includes("INCOMPLETE")).length, 0, JSON.stringify(warnings));
});

test("T-163: a backslash spelling is caught by intersectPaths, not by the warning", async () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src\\a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["src/a.ts"]) }
  ];
  let result: ReturnType<typeof detectClaimViolations> = [];
  const warnings = await captureWarnings(() => {
    result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }],
      receipts,
      detectedAt: "2026-08-17T10:02:00.000Z"
    });
  });
  // The reviewer's table: the protocol's intersectPaths folds separators, so
  // this is a real collision and never reaches the blind-spot branch. Pinned
  // because the doc comment now claims exactly this.
  assert.deepEqual(result.map(item => [item.kind, item.path]), [["collision", "src/a.ts"]]);
  assert.equal(warnings.filter(w => w.includes("INCOMPLETE")).length, 0, JSON.stringify(warnings));
});

test("T-163: a claim-covered overlap stays silent -- the pair did intersect", async () => {
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["src/a.ts"]) }
  ];
  const claims = ["T-001", "T-002"].map((taskId, index) => ({
    claimId: uuid(String(5 + index)), taskId, domains: [], paths: ["src/**"],
    mode: "write" as const, confidence: "high" as const, provenance: "authored" as const
  }));
  let result: ReturnType<typeof detectClaimViolations> = [];
  const warnings = await captureWarnings(() => {
    result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }],
      receipts, claims,
      detectedAt: "2026-08-17T10:02:00.000Z"
    });
  });
  // Both tasks legitimately claimed the file, so no violation is recorded and
  // the gate DOES open -- but there is no spelling-hidden pair for
  // `schedulerSameFilePairs` to find here, so nothing warns. This stays silent
  // for the right reason: the guard found nothing, not because the gate was
  // shut. The next test is the case that separates the two gates.
  assert.deepEqual(result, []);
  assert.equal(warnings.filter(w => w.includes("INCOMPLETE")).length, 0, JSON.stringify(warnings));
});

test("T-163: the Unicode limit is real and documented, not silently covered", () => {
  // T-159 review F1. NFC and NFD spellings of one filename are disjoint to the
  // audit comparison AND to the scheduler's, so neither the G4 guard nor the
  // collision-route warning fires. Pinned as a KNOWN LIMIT so that whoever
  // later adds `.normalize()` sees this expectation flip and has to decide
  // deliberately -- the fix widens the scheduler's comparison for every plan.
  const nfc = "café.ts";
  const nfd = "café.ts";
  assert.notEqual(nfc, nfd, "the two spellings must differ byte-wise for this to mean anything");
  assert.equal(schedulerTreatsAsSameFile(nfc, nfd), false);
  assert.equal(normalizeSchedulerPath(nfc) === normalizeSchedulerPath(nfd), false);
});

test("T-163 F1: a covered intersection must not hide a spelling collision on another file", async () => {
  // The reviewer's repro, and the case that distinguishes "nothing
  // intersected" from "nothing was recorded". `src/a.ts` intersects and both
  // tasks claim it, so no violation is recorded -- correct. `SRC/b.ts` vs
  // `src/b.ts` is a spelling disagreement hiding an UNCOVERED collision, and
  // gating on the intersection left that silent: the caller got an empty array
  // indistinguishable from a clean wave.
  const receipts: TaskReceipt[] = [
    { taskId: "T-001", receipt: receipt(uuid("1"), ["src/a.ts", "SRC/b.ts"]) },
    { taskId: "T-002", receipt: receipt(uuid("2"), ["src/a.ts", "src/b.ts"]) }
  ];
  const claims = ["T-001", "T-002"].map((taskId, index) => ({
    claimId: uuid(String(7 + index)), taskId, domains: [], paths: ["src/a.ts"],
    mode: "write" as const, confidence: "high" as const, provenance: "authored" as const
  }));
  let result: ReturnType<typeof detectClaimViolations> = [];
  const warnings = await captureWarnings(() => {
    result = detectClaimViolations({
      waves: [{ waveId: uuid("3"), taskIds: ["T-001", "T-002"] }],
      receipts, claims,
      detectedAt: "2026-08-17T10:02:00.000Z"
    });
  });
  // Still no violation row: Part A reports, it does not record.
  assert.deepEqual(result, []);
  const missed = warnings.filter(w => w.includes("INCOMPLETE") && w.includes("the wave pair"));
  assert.equal(missed.length, 1, JSON.stringify(warnings));
  assert.ok(missed[0]?.includes("SRC/b.ts vs src/b.ts"), "the warning must name the hidden pair, not the covered one");
  assert.ok(!missed[0]?.includes("src/a.ts vs"), "the covered file is not a spelling disagreement");
});
