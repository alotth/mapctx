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
  findStructuralResidues, sanitizeDryRun, sanitizeTaskForPublication, SANITIZE_TOKENS,
  type PublishableTask
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
    assert.ok(elapsed < 500, `${name} took ${elapsed}ms, expected linear-time sanitization`)
    assert.ok(result.ok, `${name}: ${JSON.stringify(result.ok ? undefined : result.message)}`)
  }
})

test("ALTO-1: sanitization time scales linearly, not quadratically, with pathological body size", () => {
  const timeFor = (size: number): number => {
    const body = "packages/store/src/".repeat(Math.ceil(size / 20))
    const started = Date.now()
    const result = sanitizeTaskForPublication({ taskId: "T-ALTO1-scale", title: "x", body }, OK)
    const elapsed = Date.now() - started
    assert.ok(result.ok)
    return elapsed
  }
  // Warm the JIT so the first measurement is not skewed by cold-start cost.
  timeFor(10000)
  const t40k = Math.max(timeFor(40000), 1)
  const t80k = timeFor(80000)
  assert.ok(t80k < t40k * 6, `expected roughly linear scaling, got ${t40k}ms -> ${t80k}ms for double the input`)
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
})

test("ALTO-1: an exhausted structural budget refuses as scan-incomplete, naming the structural budget", () => {
  const result = sanitizeTaskForPublication({ taskId: "T-ALTO1c", title: "x", body: "y" }, { ...OK, structuralBudgetMs: -1 })
  assert.equal(result.ok, false)
  assert.ok(!result.ok)
  assert.equal(result.reason, "scan-incomplete")
  assert.match(result.message, /structural budget/)
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
