/**
 * T-151: sanitization before anything reaches the public mirror.
 *
 * Every value in these fixtures is synthetic -- invented strings with the
 * same SHAPE as what the triage found on the real board (a username under
 * `/Users`, an epic UUID, a private host), never copied from the real store.
 * Assertions never reproduce a sensitive value either: they check for its
 * ABSENCE (`!all.includes(...)`) or for a token/category, by design -- a test
 * that printed the fixture secret into a failure message would defeat the
 * point of the module it is testing.
 *
 * `OK` is the review ALTO-3 acknowledgement (`patternsReviewedAsAbsent: true`)
 * used wherever a test is not itself about the pattern-configuration gate --
 * otherwise every such test would refuse with `patterns-unconfigured` before
 * reaching the behavior under test.
 */

import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as path from "path"
import { compilePrivacyPatterns, replacePrivacyPatterns } from "@mapctx/store"
import {
  findStructuralResidues, measureStructuralSweep, sanitizeDryRun, sanitizeTaskForPublication,
  structuralSweepSteps, SANITIZE_TOKENS, STRUCTURAL_BUDGET_MS,
  type PublishableTask, type SweepClock
} from "./sanitize"

const EPIC = "00000000-1111-4222-8333-444444444444"
const DISPATCH = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const OK = { patternsReviewedAsAbsent: true } as const

function fixtureTask(): PublishableTask {
  return {
    taskId: "T-900",
    title: "Walking skeleton proved the dispatch path",
    body: [
      `Artifact: [skeleton](/Users/someone/.traycer/epics/${EPIC}/artifacts/t058-walking-skeleton/index.md)`,
      `Relative link: epics/${EPIC}/artifacts/t072-integrity-decisions/index.md`,
      `Home: ~/.traycer/epics/${EPIC}/artifacts/x/index.md and plain ~/.traycer/logs`,
      "Kept tool paths: ~/.mapctx and ~/.claude stay.",
      "Windows: C:\\Users\\someone\\mapctx\\store.db",
      "Linux: /home/someone/work/mapctx",
      `Receipt ${DISPATCH} recorded.`,
      "Mail alt@example.com, host build-box.local, ip 192.168.1.44",
      "Code lives in packages/store/src/privacy.ts:47 and docs/engineering/x.md",
      "Commit 18723b5 and 0902712aa1 are public evidence; see https://github.com/alotth/mapctx/pull/3"
    ].join("\n"),
    summary: `Pipeline over /Users/someone/code and ${DISPATCH}`,
    criteria: [
      { id: "c1", text: "Nothing under /Users/someone survives" },
      { id: "c2", text: "packages/provider/src/sanitize.ts is covered" }
    ],
    links: [
      "https://github.com/alotth/mapctx/issues/7",
      `/Users/someone/.traycer/epics/${EPIC}/artifacts/t073-review/index.md`
    ],
    fields: { role: "implementation", note: "ping ops@example.org" }
  }
}

test("sanitizeTaskForPublication: a task with every leaky shape at once is publishable with nothing sensitive left", () => {
  const task = fixtureTask()
  const result = sanitizeTaskForPublication(task, OK)
  assert.ok(result.ok, JSON.stringify(result.ok ? undefined : (result.residues ?? result.message)))
  assert.ok(result.ok)
  const all = JSON.stringify(result.task)
  assert.ok(!all.includes("/Users/"), "no /Users path may survive")
  assert.ok(!all.includes("/home/"), "no /home path may survive")
  assert.ok(!all.includes("C:\\\\") && !all.includes("C:\\"), "no windows path may survive")
  assert.ok(!all.includes("~/.traycer"), "no ~/.traycer path may survive")
  assert.ok(!all.includes(EPIC) && !all.includes(DISPATCH), "no internal uuid may survive")
  assert.ok(!all.includes("alt@example.com") && !all.includes("ops@example.org"), "no email may survive")
  assert.ok(!all.includes("build-box.local") && !all.includes("192.168.1.44"), "no private host/ip may survive")
})

test("sanitizeTaskForPublication: repo-relative paths, docs paths, git SHAs and public github links survive untouched (no over-removal)", () => {
  const task = fixtureTask()
  const result = sanitizeTaskForPublication(task, OK)
  assert.ok(result.ok)
  assert.ok(result.task.body!.includes("packages/store/src/privacy.ts:47"), "repo-relative code path must survive");
  assert.ok(result.task.body!.includes("docs/engineering/x.md"), "docs path must survive");
  assert.ok(result.task.body!.includes("18723b5") && result.task.body!.includes("0902712aa1"), "git SHAs must survive");
  assert.ok(result.task.body!.includes("https://github.com/alotth/mapctx/pull/3"), "public github url must survive");
  assert.ok(result.task.body!.includes("~/.mapctx") && result.task.body!.includes("~/.claude"), "~/.mapctx and ~/.claude must survive");
  assert.equal(result.task.title, task.title, "a title with no sensitive content must be unchanged");
  assert.equal(result.task.criteria![1].text, task.criteria![1].text, "a criterion with only a repo path must be untouched");
})

test("sanitizeTaskForPublication: links -- public url kept in links[], local artifact link dropped and reported", () => {
  const task = fixtureTask()
  const result = sanitizeTaskForPublication(task, OK)
  assert.ok(result.ok)
  assert.equal(result.task.links!.length, 1)
  assert.ok(result.task.links![0].includes("github.com"))
  assert.ok(result.report.substitutions.some(s => s.field.startsWith("links[") && s.action === "dropped"),
    "the dropped local link must be reported as dropped")
})

test("sanitizeTaskForPublication: an artifact link's slug survives as a neutral <internal-artifact:slug> reference, the epic uuid does not", () => {
  const task = fixtureTask()
  const result = sanitizeTaskForPublication(task, OK)
  assert.ok(result.ok)
  assert.ok(result.task.body!.includes("<internal-artifact:t058-walking-skeleton>"))
  assert.ok(result.task.body!.includes("<internal-artifact:t072-integrity-decisions>"))
  assert.ok(!result.task.body!.includes(EPIC))
})

test("sanitizeTaskForPublication: report names field and category per substitution, totals are counted per category, and never echoes a value", () => {
  const task = fixtureTask()
  const result = sanitizeTaskForPublication(task, OK)
  assert.ok(result.ok)
  const reportJson = JSON.stringify(result.report)
  assert.ok(!reportJson.includes("someone") && !reportJson.includes(EPIC) && !reportJson.includes(DISPATCH) &&
    !reportJson.includes("alt@example.com") && !reportJson.includes("build-box") && !reportJson.includes("192.168"),
    "the report must never echo a sensitive value")
  assert.ok(result.report.substitutions.some(s => s.field === "body" && s.category === "absolute-path"))
  assert.ok(result.report.substitutions.some(s => s.field.startsWith("criteria[")))
  assert.ok(result.report.substitutions.some(s => s.field === "summary"))
  assert.ok(result.report.totals["internal-id"] > 0)
  assert.ok(result.report.totals["artifact-link"] >= 3)
  assert.equal(result.report.totals.email, 2)
})

test("sanitizeTaskForPublication: idempotent -- sanitizing the already-sanitized task is a fixed point with zero further substitutions", () => {
  const task = fixtureTask()
  const first = sanitizeTaskForPublication(task, OK)
  assert.ok(first.ok)
  const second = sanitizeTaskForPublication(first.task, OK)
  assert.ok(second.ok, JSON.stringify(second.ok ? undefined : second.message))
  assert.ok(second.ok)
  assert.equal(JSON.stringify(second.task), JSON.stringify(first.task), "sanitize(sanitize(x)) must equal sanitize(x)")
  assert.equal(second.report.substitutions.length, 0, "a second pass must find nothing left to change")
})

test("sanitizeTaskForPublication: a configured [privacy] pattern is replaced, reported by category and index, never by value, and stays idempotent", () => {
  const task: PublishableTask = { taskId: "T-901", title: "Work for AcmeOrg", body: "AcmeOrg asked for it; see packages/x.ts" }
  const result = sanitizeTaskForPublication(task, { privacyPatterns: ["AcmeOrg"] })
  assert.ok(result.ok, JSON.stringify(result.ok ? undefined : (result.residues ?? result.message)))
  assert.ok(result.ok)
  assert.ok(!JSON.stringify(result.task).includes("AcmeOrg"))
  assert.equal(result.report.privacyPatternsConfigured, true)
  const privacySubs = result.report.substitutions.filter(s => s.category === "privacy-pattern")
  assert.equal(privacySubs.length, 2)
  assert.ok(privacySubs.every(s => s.patternIndex === 0))
  assert.ok(!JSON.stringify(result.report).includes("AcmeOrg"))

  const second = sanitizeTaskForPublication(result.task, { privacyPatterns: ["AcmeOrg"] })
  assert.ok(second.ok)
  assert.equal(JSON.stringify(second.task), JSON.stringify(result.task))
})

test("sanitizeTaskForPublication: a residual match (pattern that also matches its own replacement token) refuses publication, naming field and category only", () => {
  const result = sanitizeTaskForPublication({ taskId: "T-902", title: "secret here", body: "x" }, { privacyPatterns: ["secret|redacted"] })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.reason, "residual-match")
  assert.ok(result.residues.some(r => r.field === "title" && r.category === "privacy-pattern"))
  assert.ok(!JSON.stringify(result.residues).includes("secret here"))
  assert.ok(!result.message.includes("secret here"))
})

test("sanitizeTaskForPublication: an unfinished privacy-budget scan is refused as scan-incomplete, bounded in wall-clock, naming the budget and pattern", () => {
  const long = `${"a".repeat(60)}b`
  const started = Date.now()
  const result = sanitizeTaskForPublication({ taskId: "T-903", title: "x", body: long }, { privacyPatterns: ["^(a+)+$"], budgetMs: 80 })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 3000, `expected the scan to abort quickly, took ${elapsed}ms`)
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.reason, "scan-incomplete")
  assert.match(result.message, /budget/)
  assert.match(result.message, /patterns\[0\]/)
  assert.ok(!result.message.includes(long))
})

test("sanitizeDryRun: reports per task without publishing, aggregates totals, and echoes no value", () => {
  const run = sanitizeDryRun([fixtureTask(), { taskId: "T-904", title: "clean title", body: "packages/a/b.ts" }], OK)
  assert.equal(run.entries.length, 2)
  assert.equal(run.entries[0].taskId, "T-900")
  assert.equal(run.publishable, 2)
  assert.equal(run.refused, 0)
  assert.equal(run.entries[1].report.substitutions.length, 0, "a clean task has no substitutions")
  assert.ok(run.totals["absolute-path"] > 0)
  const runJson = JSON.stringify(run)
  assert.ok(!runJson.includes("someone") && !runJson.includes(EPIC))
})

test("sanitizeDryRun: a refused task is counted and reported as refused, alongside publishable ones", () => {
  const run = sanitizeDryRun([
    { taskId: "T-905", title: "ok", body: "clean" },
    { taskId: "T-906", title: "secret here", body: "x" }
  ], { privacyPatterns: ["secret|redacted"] })
  assert.equal(run.publishable, 1)
  assert.equal(run.refused, 1)
  const refusedEntry = run.entries.find(e => e.taskId === "T-906")
  assert.ok(refusedEntry && !refusedEntry.publishable)
  assert.ok(refusedEntry && !refusedEntry.publishable && refusedEntry.reason === "residual-match")
})

// ---- super-removal guard: a rule that is too greedy would also eat these.
// Each is a distinct, minimal fixture so a failure names exactly which shape
// regressed. ----

test("sanitizeTaskForPublication: does not touch a bare git SHA, a repo-relative doc path, a public url, or ~/.mapctx/~/.claude on their own", () => {
  const task: PublishableTask = {
    taskId: "T-910", title: "survivors",
    body: [
      "see packages/store/src/x.ts:47",
      "docs/engineering/x.md has the write-up",
      "commits 18723b5 and 0902712aa1",
      "public link https://github.com/alotth/mapctx/pull/9",
      "tool dirs ~/.mapctx and ~/.claude are fine",
      "/tmpfile is not a path root"
    ].join("\n")
  }
  const result = sanitizeTaskForPublication(task, OK)
  assert.ok(result.ok)
  assert.deepEqual(result.task, task, "none of these shapes should be touched at all")
  assert.equal(result.report.substitutions.length, 0)
})

// ---- ALTO-1: the artifact/email/host rules are linear now, not just bounded
// by a budget. Each pathological shape must sanitize fast AND succeed; a slow
// pass that still eventually finished would not have caught the regression a
// budget alone hides. ----

test("ALTO-1: pathological bodies (base64, path-like runs, near-misses, data URIs) sanitize fast and publish", () => {
  const shapes: Record<string, string> = {
    "base64 60k": "A".repeat(60000),
    "run of ./ 60k": "./".repeat(30000),
    "path-like run 60k": "packages/store/src/".repeat(3158),
    "near miss 40k + epics/": `${"a".repeat(40000)}epics/`,
    "data-uri 40k": `data:image/png;base64,${"Qk".repeat(20000)}`
  }
  for (const [name, body] of Object.entries(shapes)) {
    const started = Date.now()
    const result = sanitizeTaskForPublication({ taskId: "T-ALTO1", title: "x", body }, OK)
    const elapsed = Date.now() - started
    // T-165: real detection of a quadratic regression here is `result.ok`
    // below, not this elapsed-time ceiling. A quadratic rule blows the
    // structural budget (STRUCTURAL_BUDGET_MS, 1000ms) long before 3000ms,
    // so the task is refused as scan-incomplete -- measured: the historical
    // ALTO-1 mutation (a regex star in front of the `epics/` literal)
    // refused in 3 of these 5 shapes, a quadratic email-quantifier mutation
    // refused 1 of 5. This 3000ms ceiling does NOT reliably catch either
    // mutation on the "ok" side: the budget truncates the sweep first, so a
    // mutated run still lands under 3000ms -- measured totals from 1393ms up
    // to 2260ms across different mutations and runs, a margin of only ~1.3x
    // at the high end. On a slower host this ceiling could still flake, but
    // on the WRONG message ("expected linear-time sanitization" instead of
    // the real refusal), which is a hint to look at `result.ok`, not a false
    // negative on the mutation itself. On the clean side the margin is a
    // comfortable 125x, which is what keeps this ceiling itself from
    // flaking. (The "16s / 9.6s" this comment used to cite is from before
    // the structural budget existed.) It stays here only as a backstop
    // against a real hang. The class of driver -- an unbounded leftward walk
    // or backtrack -- is what the steps-counting test below actually
    // detects, as an outcome rather than a duration.
    assert.ok(elapsed < 3000, `${name} took ${elapsed}ms, expected linear-time sanitization`)
    assert.ok(result.ok, `${name}: ${JSON.stringify(result.ok ? undefined : result.message)}`)
  }
})

// ---- T-165: wall-clock assertions in this suite, classified. Every margin
// below was independently measured; this table is the record of why the
// scaling test that used to sit here was replaced, and why the other three
// elapsed-time assertions in this file (and three in packages/store) were
// not.
//
// class A: compares two small wall-clock measurements against each other.
//          Fragile -- the margin between them is often a few milliseconds,
//          so a single GC pause can blow the ratio with nothing quadratic
//          having happened.
// class B: an absolute ceiling that only a real hang crosses -- not fragile
//          in the class-A sense, but the measured headroom still varies:
//          7.9x to 125x below. The tightest, 7.9x, is tight because that
//          scan runs on the default 250ms budget, so a 2000ms ceiling is
//          only ~8x the expected abort time -- still ample for "did not
//          hang", just the floor of this table rather than its typical case.
//
// Line numbers below name the ASSERTION itself (not its enclosing `test(...)`
// or a comment above it), confirmed by grep after the last edit to either
// file; re-check them if either file moves again.
//
// test (assertion line)                                   | assertion                        | class | measured margin
// sanitize.test.ts:168 (unfinished privacy budget)        | elapsed < 3000, budget 80ms       | B     | aborts ~80ms -> 37x
// sanitize.test.ts:260 (pathological bodies)               | elapsed < 3000                    | B     | worst clean shape 24ms -> 125x
// sanitize.test.ts (scaling, REMOVED, replaced by the test below) | t80k < t40k * 6             | A     | 6ms absolute -- this was the flake
// sanitize.test.ts:726 (tasks/*.md corpus)                 | elapsed < 5000                    | B     | ~70ms for ~190 files -> 71x
// store/privacy.test.ts:153 (catastrophic backtracking)     | elapsed < 2000, default 250ms budget | B | ~250-252ms -> 7.9x
// store/privacy.test.ts:170 (explicit 60ms budget honoured; | aborted.afterMs < 1500            | B     | ~61ms -> 24.6x
//   a second assertion inside the SAME test as the :153 row above, on a
//   separate scan with an explicit budget -- not a distinct test)
// store/privacy.test.ts:268 (replace budget exhaustion)     | elapsed < 2000, budget 60ms       | B     | ~61ms -> 32.8x
//
// Only the removed scaling test was class A. The six that remain are "did
// not hang" ceilings with 7.9x-125x of measured headroom and are left
// exactly as they are. ----

test("ALTO-1/T-165: the structural sweep's work scales linearly in STEPS, not wall clock -- a leftward walk that lost its bound is 4x per doubling", () => {
  // The old version of this test compared two wall-clock measurements
  // (`t80k < t40k * 6`) and flaked about 1 in 5 runs: a body this size
  // sanitizes in a couple of milliseconds, so the ratio's margin was a few
  // milliseconds of GC jitter, not a quadratic signal. `measureStructuralSweep`
  // runs the production sweep and counts the work it does as it goes
  // (`execCalls`, `expandLeftSteps`, `charsCopied`), so this test asserts on
  // an integer the sweep itself produced instead of the clock.
  //
  // The body is path-like end to end: `epics/<uuid>/artifacts/a/x.md~`,
  // repeated. The trailing `~` is the reason this shape is pathological for
  // `expandLeft`: `~` is one of the characters PATH_PREFIX_CHARACTER walks
  // over, so the leftward walk keeps crossing it -- but `~` is NOT in the
  // artifact rule's own tail class, so it also ends one match and starts the
  // next right after it. Every character of the body ends up path-like,
  // which is exactly the condition that makes an unbounded leftward walk
  // visible: if `expandLeft`'s floor regresses from `start > copiedTo` to
  // `start > 0` (the ALTO-1 shape), each match's walk re-crosses everything
  // already consumed by the matches before it.
  const body = (n: number) => `epics/${EPIC}/artifacts/a/x.md~`.repeat(n)
  const smallBody = body(500)
  const largeBody = body(1000)

  // Budget is deliberately generous (60s) for these two measurements: they
  // measure a COMPLETE sweep (integral step counts), not the sweep's
  // interaction with the structural budget. That is a different role from
  // the n=4000 measurement below, which uses the PRODUCTION budget on
  // purpose because its assertion is about the outcome (did it finish?),
  // not the count.
  const small = measureStructuralSweep(smallBody, 60000)
  const large = measureStructuralSweep(largeBody, 60000)
  assert.ok(!small.exhausted && !large.exhausted, "this test measures a complete sweep, not a truncated one")

  const smallSteps = structuralSweepSteps(small.work)
  const largeSteps = structuralSweepSteps(large.work)

  // Measured on this body: 1012 -> 2012 steps for the doubled input, a 1.99x
  // ratio -- linear. With ALTO-1's mutation (expandLeft's floor relaxed to
  // `start > 0`) the same doubling measures 4.00x.
  assert.ok(
    largeSteps <= smallSteps * 2.5,
    `expected roughly linear scaling, got ${smallSteps} steps (n=500) -> ${largeSteps} steps (n=1000), ` +
      `ratio ${(largeSteps / smallSteps).toFixed(2)} ` +
      `(execCalls ${small.work.execCalls}->${large.work.execCalls}, ` +
      `expandLeftSteps ${small.work.expandLeftSteps}->${large.work.expandLeftSteps}, ` +
      `charsCopied ${small.work.charsCopied}->${large.work.charsCopied})`
  )

  // Measured on this body: 2012 steps / 60000 chars = 0.034 steps/char, about
  // 118x inside this ceiling. With ALTO-1's mutation the same body measures
  // 29,971,013 steps -- 500 steps/char, a 14,900x overshoot.
  assert.ok(
    largeSteps <= largeBody.length * 4,
    `expected a per-character ceiling on total work, got ${largeSteps} steps for ${largeBody.length} chars ` +
      `(${(largeSteps / largeBody.length).toFixed(3)} steps/char) ` +
      `(execCalls ${large.work.execCalls}, expandLeftSteps ${large.work.expandLeftSteps}, charsCopied ${large.work.charsCopied})`
  )

  // T-165 review MÉDIA-2: the counters above are instrumentation with no
  // test of their own -- a mutation that drops just `expandLeftSteps += 1`
  // (the walk still runs correctly) leaves every assertion above green,
  // because `smallSteps`/`largeSteps` fold three counters into one and the
  // other two absorb the loss. Pin the n=1000 breakdown to the exact,
  // deterministic reading, the same closure the T-151 review (BAIXA-1) used
  // for `findStructuralResidues`: "gutting it ... broke nothing" is exactly
  // the failure mode an untested instrument invites.
  assert.deepEqual(large.work, { execCalls: 1012, expandLeftSteps: 999, charsCopied: 1 },
    "the leftward-walk counter must be pinned directly: a mutation that stops " +
    "incrementing expandLeftSteps (while the walk itself stays correct) would " +
    "leave every ratio/ceiling assertion above green")

  // T-165 review MÉDIA-1: steps are blind to work the sweep does without
  // touching a counter -- an uninstrumented O(n)-per-match loop added to
  // `applyRule` leaves steps unchanged (1012/2012 here, on both the clean
  // and mutated code) while the sweep itself runs ~40x slower. That class is
  // caught as an OUTCOME, not a duration: measured at n=4000, under the
  // PRODUCTION structural budget (STRUCTURAL_BUDGET_MS, 1000ms, no override
  // here), a clean sweep finishes in ~5ms (200x of headroom) while the same
  // uninstrumented-loop mutation measures ~1578ms and exhausts the budget
  // partway through the `absolute-path` rule. So this assertion is about
  // whether the sweep finished, not how long it took.
  const atProductionBudget = measureStructuralSweep(body(4000))
  assert.ok(!atProductionBudget.exhausted,
    `expected a 4000-repeat sweep to finish well inside the ${STRUCTURAL_BUDGET_MS}ms structural budget, ` +
    `but it was exhausted: ${JSON.stringify(atProductionBudget.exhausted)}`)
})

test("ALTO-1: a real artifact link still collapses to its slug, and markdown link syntax survives the leftward expansion", () => {
  const result = sanitizeTaskForPublication({
    taskId: "T-ALTO1b", title: "x",
    body: `see [doc](/Users/someone/.traycer/epics/${EPIC}/artifacts/t058-walking-skeleton/index.md) end`
  }, OK)
  assert.ok(result.ok)
  assert.ok(result.task.body!.includes("<internal-artifact:t058-walking-skeleton>"))
  assert.ok(!result.task.body!.includes("/Users/"))
  assert.ok(result.task.body!.startsWith("see [doc]("), result.task.body)
  assert.ok(result.task.body!.endsWith(") end"), result.task.body)
  // The assertions above are all still true if `expandLeft` is disabled: the
  // `absolute-path` rule that runs after the artifact rule mops up the
  // orphaned `/Users/...` prefix on its own, producing
  // `<local-path><internal-artifact:...>` -- two tokens where the walk is
  // supposed to produce one. None of the checks above can see that, because
  // they only check for absence/presence of substrings, not for what sits
  // between them. Pinning the exact string is what makes the leftward walk
  // load-bearing rather than redundant with the rule that follows it.
  assert.equal(result.task.body, "see [doc](<internal-artifact:t058-walking-skeleton>) end",
    "the leftward walk must absorb the path prefix INTO the artifact token: with it disabled, " +
    "the absolute-path rule mops up the orphaned prefix instead, leaving " +
    "`<local-path><internal-artifact:...>` -- two tokens where one belongs")
})

test("ALTO-1: an exhausted structural budget refuses as scan-incomplete, naming the structural budget", () => {
  const result = sanitizeTaskForPublication({ taskId: "T-ALTO1c", title: "x", body: "y" }, { ...OK, structuralBudgetMs: -1 })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.reason, "scan-incomplete")
  assert.match(result.message, /structural budget/)
})

test("T-165: structuralExhausted.afterMs reaches the report and the refusal message", () => {
  // Plumbing only: does the field exist, reach `report`, and get quoted in
  // the message? The exact VALUE of afterMs is a separate concern, covered
  // below by a test with a scripted clock -- a real-clock test like this one
  // cannot pin an exact value, because a budget small enough to exhaust
  // immediately (as here, -1) also makes the real-clock elapsed time ~0ms,
  // where "time spent", "time past the deadline" and the constant 0 are
  // indistinguishable (T-165 review BAIXA-1).
  const result = sanitizeTaskForPublication({ taskId: "T-ALTO1d", title: "x", body: "y" }, { ...OK, structuralBudgetMs: -1 })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.ok(result.report.structuralExhausted, "expected structuralExhausted on the report")
  const { afterMs } = result.report.structuralExhausted!
  assert.ok(Number.isFinite(afterMs) && afterMs >= 0, `afterMs must be a finite, non-negative number, got ${afterMs}`)
  assert.match(result.message, /after \d+ms/)
})

test("T-165: structuralExhausted.afterMs is computed as (time of exhaustion) - (time the sweep started), not the budget or a constant", () => {
  // T-165 review BAIXA-1: pin the exact arithmetic with a scripted clock, the
  // one way to tell apart three readings that all look like "basically 0ms"
  // on the real clock (which is exactly how the wrong versions below passed
  // the first attempt's real-clock-only test).
  //
  // `measureStructuralSweep` reads the clock three times: once to compute its
  // own deadline, once per rule to check it (here, just the first rule,
  // which is where this script exhausts), and once more to compute afterMs
  // on exhaustion.
  const readings = [1000, 5000, 5000]
  let read = 0
  const now: SweepClock = () => readings[Math.min(read++, readings.length - 1)]

  // endsAt = 1000 (1st reading) + 100 budget = 1100; the 2nd reading (5000)
  // exceeds it on the very first rule, so afterMs = 5000 - (1100 - 100) = 4000.
  const result = measureStructuralSweep("y", 100, now)
  assert.ok(result.exhausted, "expected the scripted clock to exhaust the budget on the first rule")
  assert.equal(result.exhausted!.afterMs, 4000,
    "correct arithmetic: afterMs = (time of exhaustion check) - (deadline.endsAt - budgetMs) = 5000 - 1000 = 4000. " +
    "A mutation that instead computes `now() - deadline.endsAt` (time PAST the deadline) would get 3900 here; " +
    "a mutation that hardcodes 0 would get 0; both differ from 4000, which the real clock alone cannot distinguish.")
  assert.equal(result.exhausted!.budgetMs, 100,
    "budgetMs must be the budget passed in, not an echo of afterMs or of the reading that triggered exhaustion")
})

// ---- ALTO-2: four more machine-local path families, previously declared
// publishable. Each gets its own minimal fixture, plus a check that the new
// anchors introduce no new over-removal. ----

const PATH_FAMILIES: Record<string, string> = {
  scratchpad: "/private/tmp/claude-501/-Users-someone--traycer-worktrees-someone--mapctx-e-018/scratch.js",
  varfolders: "/var/folders/43/4t8t4zqs71j1q9mym6413mkm0000gn/T/thing.log",
  tmp: "/tmp/t151-npm-test.log",
  privatevar: "/private/var/db/something",
  volumes: "/Volumes/SomeonesDisk/backup",
  mnt: "/mnt/data/share"
}

for (const [name, fixturePath] of Object.entries(PATH_FAMILIES)) {
  test(`ALTO-2: the ${name} path family is removed`, () => {
    const result = sanitizeTaskForPublication({ taskId: "T-ALTO2", title: "x", body: `path ${fixturePath} here` }, OK)
    assert.ok(result.ok)
    assert.ok(!result.task.body!.includes(fixturePath), `${name}: path must not survive`)
    assert.ok(result.task.body!.includes("<local-path>"), `${name}: must be replaced with the local-path token`)
    if (name === "scratchpad" || name === "privatevar") {
      // Both of these start with `/private/...`, which is ALSO the literal
      // this family's own rule anchors on. A rule that dropped just the
      // `/private/tmp` (or `/private/var`) alternative but kept a shorter
      // overlapping one (`/tmp`) would still remove the match -- but would
      // leave the unconsumed `/private` segment sitting in front of the
      // token as residue. Checking for the absence of the fixture path alone
      // cannot see that: this is what makes the literal load-bearing rather
      // than redundant.
      assert.ok(!result.task.body!.includes("/private"), `${name}: no "/private" prefix residue may survive in front of the token`)
    }
  })
}

test("ALTO-2: the new path anchors introduce no new over-removal", () => {
  const task: PublishableTask = {
    taskId: "T-ALTO2b", title: "x",
    body: "packages/store/src/x.ts:47, docs/engineering/y.md, /tmpfile is not a path root, 18723b5, https://github.com/alotth/mapctx/pull/3, ~/.mapctx, ~/.claude"
  }
  const result = sanitizeTaskForPublication(task, OK)
  assert.ok(result.ok)
  assert.deepEqual(result.task, task)
  assert.equal(result.report.substitutions.length, 0)
})

// ---- ALTO-3: an unconfigured pattern list refuses outright; the operator
// can acknowledge the absence, and the report always says whether the
// context-dependent category was actually checked. ----

test("ALTO-3: no [privacy] patterns configured refuses as patterns-unconfigured, naming the unversioned privacy.toml vs the public mapctx.toml", () => {
  const result = sanitizeTaskForPublication({ taskId: "T-ALTO3", title: "clean", body: "packages/a.ts" })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.reason, "patterns-unconfigured")
  assert.match(result.message, /UNVERSIONED/)
  assert.match(result.message, /privacy\.toml/)
  assert.match(result.message, /public mapctx\.toml/)
  assert.equal(result.report.privacyPatternsConfigured, false)
})

test("ALTO-3: patternsReviewedAsAbsent publishes and records the acknowledgement in the report", () => {
  const result = sanitizeTaskForPublication({ taskId: "T-ALTO3b", title: "clean", body: "packages/a.ts" }, OK)
  assert.ok(result.ok)
  assert.equal(result.report.patternsReviewedAsAbsent, true)
  assert.equal(result.report.privacyPatternsConfigured, false)
})

test("ALTO-3: a configured pattern list publishes normally and records privacyPatternsConfigured: true", () => {
  const result = sanitizeTaskForPublication({ taskId: "T-ALTO3c", title: "AcmeOrg", body: "x" }, { privacyPatterns: ["AcmeOrg"] })
  assert.ok(result.ok)
  assert.equal(result.report.privacyPatternsConfigured, true)
})

test("ALTO-3: sanitizeDryRun with no patterns configured refuses every task and says the category was not checked, so refused=0 can never read as clean", () => {
  const run = sanitizeDryRun([{ taskId: "T-1", title: "a" }, { taskId: "T-2", title: "b" }])
  assert.equal(run.refused, 2)
  assert.equal(run.publishable, 0)
  assert.equal(run.privacyPatternsConfigured, false)
  // Documents the invariant the fix exists for: an unconfigured run is never
  // allowed to present as zero refusals, which is why refused is 2, not 0.
  assert.notEqual(run.refused, 0, "an unconfigured run must never present as zero refusals")
})

// ---- ALTO-4: the gate must count EFFECTIVE (compiled) patterns, not the
// supplied list, or a single typo can disarm it while reporting itself
// armed. An invalid pattern refuses publication by name, never excused by
// patternsReviewedAsAbsent, and the refusal names the index -- never the
// pattern source, which may itself be the secret (an operator-written
// third-party name or hostname). ----

test("ALTO-4: a lone invalid pattern refuses as patterns-invalid, publishes nothing, and reports privacyPatternsConfigured: false", () => {
  const SECRET = "AcmeBank"
  const task: PublishableTask = { taskId: "T-INV", title: `work for ${SECRET}`, body: "packages/a.ts" }
  const result = sanitizeTaskForPublication(task, { privacyPatterns: ["Acme(Bank"] })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.reason, "patterns-invalid")
  assert.equal(result.report.privacyPatternsConfigured, false, "a pattern that did not compile is not an effective pattern")
  assert.match(result.message, /patterns\[0\]/)
  assert.ok(!result.message.includes("Acme(Bank"), "the refusal must never echo the pattern source")
})

test("ALTO-4: one invalid pattern beside one valid still refuses, naming the invalid index, and reports privacyPatternsConfigured: true", () => {
  const task: PublishableTask = { taskId: "T-INV2", title: "work for AcmeBank", body: "packages/a.ts" }
  const result = sanitizeTaskForPublication(task, { privacyPatterns: ["\\bELA\\b", "Acme(Bank"] })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.reason, "patterns-invalid")
  assert.match(result.message, /patterns\[1\]/)
  assert.ok(!result.message.includes("Acme(Bank"))
  assert.equal(result.report.privacyPatternsConfigured, true, "a valid pattern exists among the configured ones")
})

test("ALTO-4: patternsReviewedAsAbsent does not excuse a broken pattern", () => {
  const task: PublishableTask = { taskId: "T-INV3", title: "work for AcmeBank", body: "x" }
  const result = sanitizeTaskForPublication(task, { privacyPatterns: ["Acme(Bank"], patternsReviewedAsAbsent: true })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.reason, "patterns-invalid", "reviewedAsAbsent means nothing to configure, not a broken configuration")
})

test("ALTO-4: a valid pattern alongside the fix still publishes normally with the secret gone", () => {
  const SECRET = "AcmeBank"
  const result = sanitizeTaskForPublication({ taskId: "T-INV4", title: `work for ${SECRET}`, body: "packages/a.ts" }, { privacyPatterns: [SECRET] })
  assert.ok(result.ok)
  assert.ok(!JSON.stringify(result.task).includes(SECRET))
})

test("ALTO-4: sanitizeDryRun with an invalid pattern refuses the task and reports privacyPatternsConfigured: false", () => {
  const task: PublishableTask = { taskId: "T-INV5", title: "work for AcmeBank", body: "x" }
  const run = sanitizeDryRun([task], { privacyPatterns: ["Acme(Bank"] })
  assert.equal(run.refused, 1)
  assert.equal(run.publishable, 0)
  assert.equal(run.privacyPatternsConfigured, false)
})

// ---- MEDIA-1: credential shapes are removed as <credential>; ordinary
// prose that merely looks similar must survive. ----

const CREDENTIALS: Record<string, string> = {
  ghp: `ghp_${"A1b2C3d4E5f6G7h8i9"}`,
  gho: `gho_${"Z9y8X7w6V5u4T3s2r1"}`,
  pat: `github_pat_${"A".repeat(25)}`,
  sk: `sk-${"B".repeat(24)}`,
  xoxb: `xoxb-${"1234567890-abcdefghij"}`
}

for (const [name, value] of Object.entries(CREDENTIALS)) {
  test(`MEDIA-1: a ${name} credential is removed as <credential>`, () => {
    const result = sanitizeTaskForPublication({ taskId: "T-MED1", title: "x", body: `token ${value} end` }, OK)
    assert.ok(result.ok)
    assert.ok(!result.task.body!.includes(value))
    assert.ok(result.task.body!.includes("<credential>"))
  })
}

test("MEDIA-1: credential rules do not eat ordinary prose that merely resembles a credential prefix", () => {
  const body = "ghost writer, skiing, sk-1, xoxo-hi, github_patch"
  const result = sanitizeTaskForPublication({ taskId: "T-MED1b", title: "x", body }, OK)
  assert.ok(result.ok)
  assert.equal(result.task.body, body)
})

// ---- BAIXA-1: findStructuralResidues is half of the fail-closed gate and is
// tested directly, since no reachable sanitize() input currently produces a
// structural residue (the tokens are built not to re-trigger a rule). ----

test("BAIXA-1: findStructuralResidues detects a leak directly, echoes no value, and is empty for clean text", () => {
  const leaky = findStructuralResidues("body", `left /Users/someone/x and ${EPIC}`)
  assert.equal(leaky.length, 2)
  assert.ok(leaky.some(r => r.category === "absolute-path"))
  assert.ok(leaky.some(r => r.category === "internal-id"))
  assert.ok(!JSON.stringify(leaky).includes("someone"))
  assert.deepEqual(findStructuralResidues("body", "packages/a.ts and 18723b5"), [])
})

// ---- replacePrivacyPatterns, directly: counts, zero-length matches, abort
// semantics. sanitize.ts builds on this, so its own contract gets its own
// cross-check here rather than only through sanitize's integration tests. ----

test("replacePrivacyPatterns: counts occurrences per pattern and text, and never aborts on a clean call", () => {
  const compiled = compilePrivacyPatterns(["AcmeOrg", "ThirdCo"])
  const result = replacePrivacyPatterns(["AcmeOrg said AcmeOrg again", "ThirdCo once, nothing else"], compiled, { replacement: "<redacted>" })
  assert.equal(result.texts[0], "<redacted> said <redacted> again")
  assert.equal(result.texts[1], "<redacted> once, nothing else")
  assert.equal(result.aborted, undefined)
  const acmeCount = result.counts.find(c => c.subject === 0 && c.patternIndex === 0)
  assert.ok(acmeCount && acmeCount.occurrences === 2)
  const thirdCount = result.counts.find(c => c.subject === 1 && c.patternIndex === 1)
  assert.ok(thirdCount && thirdCount.occurrences === 1)
})

test("replacePrivacyPatterns: a pattern whose only possible match is zero-length is left alone, never peppering the text with the token", () => {
  // "q*" against text with no "q" at all matches only the empty string, at
  // every position; those zero-length matches must not be replaced.
  const compiled = compilePrivacyPatterns(["q*"])
  const text = "xyz 123 zzz, no cue letter here at all"
  const result = replacePrivacyPatterns([text], compiled, { replacement: "<redacted>" })
  assert.equal(result.texts[0], text, "a zero-length-only match must leave the text byte-identical")
  assert.equal(result.counts.length, 0, "a zero-length match must not be counted as an occurrence")
})

test("replacePrivacyPatterns: on abort, the text the budget ran out on (and anything after it) is undefined, never half-rewritten", () => {
  const long = `${"a".repeat(60)}b`
  const compiled = compilePrivacyPatterns(["^(a+)+$"])
  // The subject the budget is exhausted on, and every subject after it in
  // the batch, must come back undefined -- never a text some but not all of
  // whose matches were replaced. A subject fully processed BEFORE the budget
  // ran out is legitimately emitted (per-text, not an all-or-nothing batch).
  const result = replacePrivacyPatterns(["clean text", long, "also after the abort"], compiled, { replacement: "<redacted>", budgetMs: 60 })
  assert.ok(result.aborted)
  assert.equal(result.aborted!.patternIndex, 0)
  assert.equal(result.texts[0], "clean text", "a subject completed before the budget ran out is not discarded")
  assert.equal(result.texts[1], undefined, "the subject the budget ran out on must not be half-rewritten")
  assert.equal(result.texts[2], undefined, "a subject never reached by the time the budget ran out must not be emitted either")
})

// ---- regression: everything attempt 1 proved still holds, with the new
// path families added to the mix. ----

test("regression: every attempt-1 leak category is still removed, and what matters still survives", () => {
  const task: PublishableTask = {
    taskId: "T-900", title: "Walking skeleton",
    body: `[a](/Users/someone/.traycer/epics/${EPIC}/artifacts/t058-walking-skeleton/index.md) ~/.traycer/logs ` +
      "C:\\Users\\someone\\db /home/someone/w mail alt@example.com host build-box.local ip 192.168.1.44 " +
      "code packages/store/src/privacy.ts:47 sha 18723b5",
    criteria: [{ id: "c1", text: `uuid ${EPIC}` }],
    links: ["https://github.com/alotth/mapctx/issues/7", `/Users/someone/.traycer/epics/${EPIC}/artifacts/t073-review/index.md`]
  }
  const result = sanitizeTaskForPublication(task, OK)
  assert.ok(result.ok)
  const all = JSON.stringify(result.task)
  assert.ok(!all.includes("/Users/") && !all.includes("~/.traycer") && !all.includes("C:\\") && !all.includes("/home/") &&
    !all.includes(EPIC) && !all.includes("alt@example.com") && !all.includes("build-box.local") && !all.includes("192.168.1.44"))
  assert.ok(all.includes("packages/store/src/privacy.ts:47") && all.includes("18723b5"))
  assert.equal(result.task.links!.length, 1)
  const again = sanitizeTaskForPublication(result.task, OK)
  assert.ok(again.ok)
  assert.equal(JSON.stringify(again.task), JSON.stringify(result.task))
  assert.ok(!JSON.stringify(result.report).includes("someone") && !JSON.stringify(result.report).includes(EPIC))
})

// ---- the real tasks/*.md corpus, read in memory only. Its content is never
// written into a fixture, a snapshot, or this file: only pass/fail counts and
// task ids leave this test. ----

test("the real tasks/*.md corpus sanitizes clean, publishable and idempotent for every task file, including the new path families", () => {
  const dir = path.join(__dirname, "..", "..", "..", "tasks")
  const files = fs.readdirSync(dir).filter(name => name.endsWith(".md"))
  assert.ok(files.length > 0, `expected task files under ${dir}`)
  const problems: string[] = []
  const started = Date.now()
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8")
    const id = file.replace(/\.md$/, "")
    const result = sanitizeTaskForPublication({ taskId: id, title: id, body: text }, OK)
    if (!result.ok) { problems.push(`${id}:${result.reason}`); continue }
    const out = JSON.stringify(result.task)
    if (/\/Users\/|~\/\.traycer|\/private\/tmp|\/var\/folders|\/tmp\/|\/Volumes\//.test(out)) problems.push(`${id}:path-leak`)
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(out)) problems.push(`${id}:uuid-leak`)
    const again = sanitizeTaskForPublication(result.task, OK)
    if (!again.ok || JSON.stringify(again.task) !== out) problems.push(`${id}:not-idempotent`)
  }
  const elapsed = Date.now() - started
  assert.ok(elapsed < 5000, `corpus scan took ${elapsed}ms, expected a fast linear sweep`)
  assert.deepEqual(problems, [], `${files.length} task files scanned in ${elapsed}ms; problems: ${problems.slice(0, 10).join(", ")}`)
})

test("sanitize token constants carry no slash-prefixed path, uuid, @ or private suffix -- the tokens themselves cannot re-trigger a rule", () => {
  for (const token of Object.values(SANITIZE_TOKENS)) {
    assert.ok(!token.startsWith("/Users") && !token.startsWith("/home") && !token.startsWith("/root") && !token.startsWith("~/"))
    assert.ok(!/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.test(token))
    assert.ok(!token.includes("@"))
    assert.ok(!/\.(local|lan|internal|home\.arpa)\b/.test(token))
  }
})
