import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as path from "path"
import { PRIVACY_PATTERNS_FILE_ENV, readMapctxToml, resolvePrivacyPatterns, serializeMapctxToml } from "./config"
import { compilePrivacyPatterns, lintForPrivacy, replacePrivacyPatterns, scanForPrivacyPatterns } from "./privacy"
import { cleanupDir, mkTmpDir } from "./__test-helpers__"

const SECRET = "cust-ctx-9f31a778421"
const PATTERN = "cust-ctx-[0-9a-f]+"

test("privacy scanner reports nested object/array paths, masked previews and lengths without echoing matches", () => {
  const compiled = compilePrivacyPatterns([PATTERN, "cust-ctx-.*"]);
  const value = { evidence: [{ uri: `https://example.invalid/${SECRET}`, other: null }, SECRET], count: 778421, enabled: true };
  const report = scanForPrivacyPatterns(value, compiled, "receipt");
  assert.equal(report.aborted, undefined);
  assert.deepEqual(report.findings, [
    { fieldPath: "receipt.evidence.0.uri", site: "value", patternIndex: 0, pattern: PATTERN, matchLength: SECRET.length, preview: "cu…" },
    { fieldPath: "receipt.evidence.1", site: "value", patternIndex: 0, pattern: PATTERN, matchLength: SECRET.length, preview: "cu…" }
  ]);
  assert.ok(!JSON.stringify(report).includes(SECRET));
  assert.deepEqual(value.evidence[1], SECRET, "scan must not change the input");
  assert.equal(report.findings.length, 2, "only first matching pattern per string field is reported");
  assert.equal(scanForPrivacyPatterns(SECRET, compiled).findings[0].fieldPath, "(value)");
});

test("privacy lint formats advisory warnings with operation, field, pattern index and masked preview", () => {
  const report = lintForPrivacy("acceptance approve T-001", { evidence: { shift: SECRET } }, [PATTERN]);
  assert.equal(report.findings.length, 1);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /privacy: acceptance approve T-001 field "evidence.shift"/);
  assert.ok(report.warnings[0].includes(`[privacy] patterns[0] /${PATTERN}/`));
  assert.ok(report.warnings[0].includes(`(${SECRET.length} chars, starts "cu…")`));
  assert.match(report.warnings[0], /Not blocked/);
  assert.ok(!JSON.stringify(report).includes(SECRET), "warnings and findings must never echo full match");
});

test("invalid privacy regex is reported and skipped while valid later patterns still lint", () => {
  const compiled = compilePrivacyPatterns(["(", PATTERN]);
  assert.equal(compiled.invalid.length, 1);
  assert.equal(compiled.invalid[0].index, 0);
  assert.equal(compiled.regexes.length, 1);
  assert.equal(compiled.regexes[0].index, 1);
  const report = lintForPrivacy("task create", { title: SECRET }, ["(", PATTERN]);
  assert.equal(report.findings[0].patternIndex, 1);
  assert.equal(report.warnings.length, 2);
  assert.match(report.warnings[0], /patterns\[0\] is not a valid regex.*it was skipped/);
  assert.match(report.warnings[1], /task create field "title".*patterns\[1\]/);
  assert.ok(!JSON.stringify(report).includes(SECRET));
  assert.deepEqual(lintForPrivacy("task update", SECRET, ["("]).findings, []);
});

// T-151 ALTO-4: a pattern's compile-error message must never quote the
// pattern back. V8 formats it as `Invalid regular expression: /<source>/:
// <reason>`, so the raw message carries the source; since patterns may now
// come from an unversioned privacy.toml, the pattern IS the secret (a third
// party's name, a hostname), and echoing it into a lint warning or a
// sanitize refusal would leak exactly what it was written to hide.
test("compilePrivacyPatterns: an invalid pattern's reason never quotes the pattern source, and is non-empty", () => {
  const SOURCE = "Acme(Bank";
  const compiled = compilePrivacyPatterns([SOURCE]);
  assert.equal(compiled.invalid.length, 1);
  assert.ok(!compiled.invalid[0].message.includes(SOURCE), compiled.invalid[0].message);
  assert.ok(compiled.invalid[0].message.length > 0);
  // The lint warning built from it must not leak the source either.
  const report = lintForPrivacy("task create", { title: "x" }, [SOURCE]);
  assert.ok(!report.warnings.join("\n").includes(SOURCE), report.warnings.join("\n"));
});

test("privacy lint disables cleanly for absent/empty patterns and ignores non-string or unmatched values", () => {
  const empty = { findings: [], warnings: [] };
  assert.deepEqual(lintForPrivacy("task create", SECRET, undefined), empty);
  assert.deepEqual(lintForPrivacy("task create", SECRET, []), empty);
  assert.deepEqual(lintForPrivacy("task update", { title: "safe", n: 778421, flag: true, nil: null }, [PATTERN]), empty);
});

test("one/two-character privacy matches are fully masked; repeated scans remain deterministic", () => {
  const compiled = compilePrivacyPatterns(["X{1,2}"]);
  const first = scanForPrivacyPatterns(["X", "XX", "safe"], compiled);
  assert.deepEqual(first.findings.map(f => [f.matchLength, f.preview]), [[1, "…"], [2, "…"]]);
  assert.deepEqual(scanForPrivacyPatterns(["X", "XX", "safe"], compiled), first);
  const report = lintForPrivacy("task create", "XX", ["X{1,2}"]);
  assert.ok(!report.warnings.join("\n").includes("XX"));
});

// MÉDIA-3: a secret written into a container KEY (`--evidence "shift-998877=ok"`)
// is scanned too, reported with site "key", and warned as having no later cure --
// redaction preserves keys by design, so there is no "redact it after the fact" here.
test("privacy scanner finds secrets in container keys, reported as site \"key\" with no redaction cure", () => {
  const keyPattern = "shift-[0-9]{6}";
  const compiled = compilePrivacyPatterns([keyPattern]);
  const report = scanForPrivacyPatterns({ evidence: { "shift-998877": "verified" } }, compiled);
  assert.deepEqual(report.findings, [
    { fieldPath: "evidence.shift-998877", site: "key", patternIndex: 0, pattern: keyPattern, matchLength: "shift-998877".length, preview: "sh…" }
  ]);
  // The key itself IS the fieldPath (the audit label), so it legitimately
  // appears there; what must never leak is the full match outside fieldPath/preview.
  assert.equal(report.findings[0].preview, "sh…");

  const lint = lintForPrivacy("acceptance approve T-001", { evidence: { "shift-998877": "verified" } }, [keyPattern]);
  assert.equal(lint.findings.length, 1);
  assert.equal(lint.findings[0].site, "key");
  assert.equal(lint.warnings.length, 1);
  assert.match(lint.warnings[0], /privacy: acceptance approve T-001 key "evidence\.shift-998877"/);
  assert.match(lint.warnings[0], /never redactable/);
  assert.match(lint.warnings[0], /rename it/);
  assert.ok(!lint.warnings[0].includes("redact it after the fact"));

  // Array indices are structure, never a key to scan.
  assert.deepEqual(scanForPrivacyPatterns(["shift-998877"], compilePrivacyPatterns([keyPattern])).findings, [
    { fieldPath: "0", site: "value", patternIndex: 0, pattern: keyPattern, matchLength: "shift-998877".length, preview: "sh…" }
  ]);
});

// MÉDIA-1: the lint must not promise a cure `mapctx redact` would refuse.
// `task create`/`task update` have no redactable root at all.
test("privacy lint on an event type with no redactable root says there is no cure, never promises one", () => {
  const report = lintForPrivacy("task create", { summary: `x ${SECRET}` }, [PATTERN]);
  assert.equal(report.findings.length, 1);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /NOT redactable afterwards/);
  assert.ok(!report.warnings[0].includes("redact it after the fact"));
  // T-131 widened the surfaces mapctx redact covers; the no-cure wording must
  // name the current list, not the stale T-126 one.
  assert.match(report.warnings[0], /receipt failure messages and changed files/);
  assert.match(report.warnings[0], /run event payloads/);
});

// MÉDIA-1 cross-check: when the caller DOES know the field is redactable
// (acceptance evidence), the warning promises the real cure and the command
// it prints is one `mapctx redact --field` actually accepts.
test("privacy lint on a redactable field promises the real cure with the field path redaction accepts", () => {
  const report = lintForPrivacy("acceptance approve T-001", { evidence: { shift: SECRET } }, [PATTERN], {
    redactable: fieldPath => fieldPath === "evidence.shift"
  });
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /redact it after the fact/);
  assert.match(report.warnings[0], /mapctx redact --sequence <n> --field "evidence\.shift"/);
});

// ALTA-2: a catastrophic pattern must bound the lint in wall-clock, not merely
// in outcome -- one RegExp.exec is a single uninterruptible step from JS's
// point of view, so the matching loop (privacy.ts) runs inside a vm context
// with a real timeout. On exhaustion the lint aborts rather than hangs.
// T-165: elapsed < 2000 here is class B (an absolute "did not hang" ceiling,
// ~33x measured headroom), not a wall-clock ratio; see sanitize.test.ts.
test("catastrophic backtracking pattern is bounded by budget, reported by name, and never blocks the operation", () => {
  const long = `${"a".repeat(60)}b`;
  const started = Date.now();
  const report = scanForPrivacyPatterns(long, compilePrivacyPatterns(["^(a+)+$"]));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `expected the scan to abort quickly, took ${elapsed}ms`);
  assert.ok(report.aborted, "a catastrophic pattern must be reported as aborted");
  assert.equal(report.aborted!.patternIndex, 0);
  assert.equal(report.aborted!.pattern, "^(a+)+$");

  const lint = lintForPrivacy("task create", { summary: long }, ["^(a+)+$"]);
  assert.ok(lint.aborted);
  const abortWarning = lint.warnings.find(w => /too expensive/.test(w));
  assert.ok(abortWarning, JSON.stringify(lint.warnings));
  assert.match(abortWarning!, /patterns\[0\]/);
  assert.match(abortWarning!, /NOT blocked/);
  assert.ok(!JSON.stringify(lint).includes(long), "the pathological input itself must never be echoed");

  const budgeted = scanForPrivacyPatterns(long, compilePrivacyPatterns(["^(a+)+$"]), { budgetMs: 60 });
  assert.ok(budgeted.aborted);
  assert.ok(budgeted.aborted!.afterMs < 1500, `expected the explicit budget to be honoured, took ${budgeted.aborted!.afterMs}ms`);

  // A sane pattern in the same call keeps working and stays masked.
  const ok = scanForPrivacyPatterns({ summary: `ctx ${SECRET} x` }, compilePrivacyPatterns([PATTERN]));
  assert.equal(ok.aborted, undefined);
  assert.equal(ok.findings.length, 1);
  assert.equal(ok.findings[0].fieldPath, "summary");
  assert.equal(ok.findings[0].preview, "cu…");
  assert.ok(!JSON.stringify(ok).includes(SECRET));
});

// Review BAIXA-6: a non-positive or non-finite budget cannot scan anything,
// and must be reported as what it is -- the budget was unusable -- never as
// a nonexistent "patterns[-1] /(unknown)/" blaming a pattern that was never
// evaluated. A real catastrophic abort must still name its pattern.
test("a zero (or non-finite) privacy lint budget is named as the cause, never blamed on a nonexistent pattern", () => {
  const long = "x".repeat(50);
  for (const budgetMs of [0, -1, Number.NaN]) {
    const zeroBudget = scanForPrivacyPatterns(long, compilePrivacyPatterns(["x+"]), { budgetMs });
    assert.ok(zeroBudget.aborted, `budgetMs=${budgetMs} must still report an abort`);
    assert.equal(zeroBudget.aborted!.patternIndex, -1);
    assert.equal(zeroBudget.aborted!.pattern, "");
    assert.equal(zeroBudget.aborted!.budgetMs, budgetMs);
  }

  const lint = lintForPrivacy("task create", { summary: long }, ["x+"], { budgetMs: 0 });
  assert.ok(lint.aborted);
  assert.equal(lint.aborted!.patternIndex, -1);
  assert.ok(!lint.warnings.some(w => /patterns\[-1\]/.test(w) || /\(unknown\)/.test(w)), JSON.stringify(lint.warnings));
  const budgetWarning = lint.warnings.find(w => /without evaluating any pattern/.test(w));
  assert.ok(budgetWarning, JSON.stringify(lint.warnings));
  assert.match(budgetWarning!, /0ms budget/);
  assert.match(budgetWarning!, /NOT blocked/);

  // A normal lint is unaffected by the default budget.
  const sane = lintForPrivacy("task create", { summary: `a ${SECRET}` }, [PATTERN]);
  assert.equal(sane.findings.length, 1);
  assert.equal(sane.aborted, undefined);

  // A real catastrophic abort still names its pattern -- the fix is scoped to
  // an unusable budget, not to abort reporting in general.
  const catastrophic = lintForPrivacy("task create", { summary: `${"a".repeat(60)}b` }, ["^(a+)+$"]);
  assert.ok(catastrophic.aborted);
  assert.equal(catastrophic.aborted!.patternIndex, 0);
  assert.ok(catastrophic.warnings.some(w => /too expensive/.test(w)), JSON.stringify(catastrophic.warnings));
});

// Review BAIXA-8: a non-finite budget (Infinity/NaN) is not a duration at
// all -- `vm` takes a finite timeout -- so calling it "too small" told the
// operator to raise a budget that was already infinite. It now gets its own
// wording; a `<= 0` budget keeps the correct "too small, raise it" message.
test("a non-finite privacy lint budget is named as not a duration, distinct from a too-small one", () => {
  for (const budgetMs of [Infinity, Number.NaN]) {
    const report = lintForPrivacy("task create", { summary: "x" }, ["a"], { budgetMs });
    assert.ok(report.aborted, `budgetMs=${budgetMs} must still report an abort`);
    assert.equal(report.findings.length, 0, "a lint that never ran must find nothing");
    const abortWarning = report.warnings.find(w => /not a finite number of milliseconds/.test(w));
    assert.ok(abortWarning, JSON.stringify(report.warnings));
    assert.ok(!report.warnings.some(w => /too small/.test(w)), JSON.stringify(report.warnings));
    assert.match(abortWarning!, /NOT blocked/);
  }
  const zero = lintForPrivacy("task create", { summary: "x" }, ["a"], { budgetMs: 0 });
  assert.ok(zero.aborted);
  assert.equal(zero.findings.length, 0);
  assert.ok(zero.warnings.some(w => /0ms budget is too small/.test(w)), JSON.stringify(zero.warnings));
  assert.ok(!zero.warnings.some(w => /not a finite number of milliseconds/.test(w)), JSON.stringify(zero.warnings));
});

// T-151: replacePrivacyPatterns is sanitize.ts's building block for actually
// REWRITING a configured pattern's match, not merely reporting it. Covered
// directly here, at the module that implements the vm sandbox + budget.
test("replacePrivacyPatterns counts occurrences per pattern/text, leaves zero-length matches untouched, and never echoes a value", () => {
  const compiled = compilePrivacyPatterns([PATTERN]);
  const result = replacePrivacyPatterns([`ctx ${SECRET} and ${SECRET}`, "clean"], compiled, { replacement: "<redacted>" });
  assert.equal(result.texts[0], "ctx <redacted> and <redacted>");
  assert.equal(result.texts[1], "clean");
  assert.equal(result.aborted, undefined);
  assert.deepEqual(result.counts, [{ subject: 0, patternIndex: 0, occurrences: 2 }]);
  assert.ok(!JSON.stringify(result).includes(SECRET));

  // A pattern whose only reachable match is zero-length (no "q" anywhere)
  // must not pepper the text with the replacement token.
  const zeroLength = replacePrivacyPatterns(["no cue letter in here at all"], compilePrivacyPatterns(["q*"]), { replacement: "<redacted>" });
  assert.equal(zeroLength.texts[0], "no cue letter in here at all");
  assert.deepEqual(zeroLength.counts, []);

  // No configured patterns: passthrough, not an abort.
  assert.deepEqual(replacePrivacyPatterns(["x"], compilePrivacyPatterns([]), { replacement: "<redacted>" }), { texts: ["x"], counts: [] });
});

// T-165: elapsed < 2000 here is class B (an absolute "did not hang" ceiling,
// ~33x measured headroom), not a wall-clock ratio; see sanitize.test.ts.
test("replacePrivacyPatterns on budget exhaustion: the subject it ran out on (and anything after) is undefined, never half-rewritten; an earlier subject already finished is kept", () => {
  const long = `${"a".repeat(60)}b`;
  const compiled = compilePrivacyPatterns(["^(a+)+$"]);
  const started = Date.now();
  const result = replacePrivacyPatterns(["clean text", long, "never reached"], compiled, { replacement: "<redacted>", budgetMs: 60 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `expected the replace to abort quickly, took ${elapsed}ms`);
  assert.ok(result.aborted);
  assert.equal(result.aborted!.patternIndex, 0);
  assert.equal(result.texts[0], "clean text", "a subject fully processed before the abort is not discarded");
  assert.equal(result.texts[1], undefined, "the subject the budget ran out on must not be half-rewritten");
  assert.equal(result.texts[2], undefined, "a subject never reached must not be emitted either");
  assert.ok(!JSON.stringify(result).includes(long));
});

const CONFIG = 'schemaVersion = 1\nprojectId = "11111111-1111-4111-8111-111111111111"\nplansAuthority = "store"\n';

test("config parses and round-trips privacy regex strings, leaving invalid regex non-fatal for lint", t => {
  const dir = mkTmpDir("mapctx-privacy-config-");
  t.after(() => cleanupDir(dir));
  const filename = path.join(dir, "mapctx.toml");
  fs.writeFileSync(filename, CONFIG + "\n[privacy]\npatterns = ['\\b\\d{6}\\b', 'cust-ctx-[0-9a-f]+', '(']\n");
  const config = readMapctxToml(filename);
  assert.deepEqual(config.privacy, { patterns: ["\\b\\d{6}\\b", PATTERN, "("] });
  fs.writeFileSync(filename, serializeMapctxToml(config));
  assert.deepEqual(readMapctxToml(filename), config);
  const report = lintForPrivacy("task create", "shift 778421", config.privacy!.patterns);
  assert.equal(report.findings[0].matchLength, 6);
  assert.equal(report.findings[0].preview, "77…");
  assert.equal(report.warnings.length, 2, "invalid regex does not prevent valid lint");
});

test("config absent privacy table, missing patterns and empty patterns all disable lint", t => {
  const dir = mkTmpDir("mapctx-privacy-disabled-");
  t.after(() => cleanupDir(dir));
  const filename = path.join(dir, "mapctx.toml");
  for (const [suffix, expected] of [
    ["", undefined], ["\n[privacy]\n", { patterns: [] }], ["\n[privacy]\npatterns = []\n", { patterns: [] }]
  ] as const) {
    fs.writeFileSync(filename, CONFIG + suffix);
    const config = readMapctxToml(filename);
    assert.deepEqual(lintForPrivacy("task create", SECRET, config.privacy?.patterns).warnings, []);
    assert.deepEqual(config.privacy, expected);
  }
});

for (const patterns of ['"cust-ctx-.*"', "42", "true", "[42]", '["valid", false]', '{ regex = "valid" }']) {
  test(`config refuses privacy patterns that are not an array of strings: ${patterns}`, t => {
    const dir = mkTmpDir("mapctx-privacy-invalid-");
    t.after(() => cleanupDir(dir));
    const filename = path.join(dir, "mapctx.toml");
    fs.writeFileSync(filename, CONFIG + `\n[privacy]\npatterns = ${patterns}\n`);
    assert.throws(() => readMapctxToml(filename), /\[privacy\] patterns must be an array of regex strings/);
  });
}

// ---- T-151: resolvePrivacyPatterns unions mapctx.toml with the UNVERSIONED
// local file and env-named file. Always a temporary storeDir and an injected
// env, never ~/.mapctx or the process's real environment. ----

test("resolvePrivacyPatterns unions local file, env file and mapctx.toml, unversioned sources first, deduplicated", t => {
  const dir = mkTmpDir("mapctx-privacy-resolve-");
  t.after(() => cleanupDir(dir));
  fs.writeFileSync(path.join(dir, "privacy.toml"), '[privacy]\npatterns = ["AcmeOrg", "someone-mac-air"]\n');
  const envFile = path.join(dir, "extra.toml");
  fs.writeFileSync(envFile, '[privacy]\npatterns = ["ExtraCo"]\n');

  const resolved = resolvePrivacyPatterns("00000000-0000-4000-8000-000000000000", ["FromPublicToml"], {
    storeDir: dir, env: { MAPCTX_PRIVACY_PATTERNS_FILE: envFile }
  });
  assert.deepEqual(resolved.patterns, ["AcmeOrg", "someone-mac-air", "ExtraCo", "FromPublicToml"]);
  assert.equal(resolved.hasUnversionedSource, true);
  assert.equal(resolved.origins[0].origin, "local-file");
  assert.ok(resolved.origins.some(o => o.origin === "env-file"));
  assert.ok(resolved.origins.some(o => o.origin === "mapctx.toml"));

  const deduped = resolvePrivacyPatterns("x", ["AcmeOrg"], { storeDir: dir, env: {} });
  assert.equal(deduped.patterns.filter(p => p === "AcmeOrg").length, 1, "a pattern repeated across sources must collapse to one entry");
});

test("resolvePrivacyPatterns: a malformed local privacy file throws rather than reading as empty; missing sources yield an empty list with no error", t => {
  const dir = mkTmpDir("mapctx-privacy-resolve-bad-");
  t.after(() => cleanupDir(dir));
  fs.writeFileSync(path.join(dir, "privacy.toml"), '[privacy]\npatterns = "notalist"\n');
  assert.throws(() => resolvePrivacyPatterns("x", [], { storeDir: dir, env: {} }), /array of regex strings/);

  const none = resolvePrivacyPatterns("x", [], { storeDir: path.join(dir, "missing-store"), env: {} });
  assert.deepEqual(none.patterns, []);
  assert.equal(none.hasUnversionedSource, false);
  assert.deepEqual(none.origins, []);
});

test("resolvePrivacyPatterns: with no local or env file configured, mapctx.toml patterns alone are not an unversioned source", t => {
  const dir = mkTmpDir("mapctx-privacy-resolve-public-only-");
  t.after(() => cleanupDir(dir));
  const resolved = resolvePrivacyPatterns("x", ["PublicOnly"], { storeDir: dir, env: {} });
  assert.deepEqual(resolved.patterns, ["PublicOnly"]);
  assert.equal(resolved.hasUnversionedSource, false);
  assert.deepEqual(resolved.origins, [{ origin: "mapctx.toml", count: 1 }]);
});

// T-151 MEDIA-2: three silent degradations in the resolver -- a typo'd key,
// an empty-but-present file, and a broken MAPCTX_PRIVACY_PATTERNS_FILE --
// must all refuse (or at least be visible) rather than quietly reading as
// "no patterns configured".

test("resolvePrivacyPatterns: a mis-keyed privacy.toml (\"pattern\" instead of \"patterns\") refuses instead of reading as empty", t => {
  const dir = mkTmpDir("mapctx-privacy-media2-");
  t.after(() => cleanupDir(dir));
  fs.writeFileSync(path.join(dir, "privacy.toml"), '[privacy]\npattern = ["typo"]\n');
  assert.throws(() => resolvePrivacyPatterns("x", [], { storeDir: dir, env: {} }), /unknown key "pattern"/);
});

test("resolvePrivacyPatterns: an existing-but-empty local file is reported in origins with count 0, and still counts as unversioned", t => {
  const dir = mkTmpDir("mapctx-privacy-media2-empty-");
  t.after(() => cleanupDir(dir));
  fs.writeFileSync(path.join(dir, "privacy.toml"), "[privacy]\n");
  const resolved = resolvePrivacyPatterns("x", [], { storeDir: dir, env: {} });
  assert.deepEqual(resolved.origins, [{ origin: "local-file", path: path.join(dir, "privacy.toml"), count: 0 }]);
  assert.equal(resolved.hasUnversionedSource, true, "an empty file is still a present unversioned source, not silence");
});

test("resolvePrivacyPatterns: MAPCTX_PRIVACY_PATTERNS_FILE pointing at a missing file, or set but empty, both refuse; unset stays silent", t => {
  const dir = mkTmpDir("mapctx-privacy-media2-env-");
  t.after(() => cleanupDir(dir));
  assert.throws(
    () => resolvePrivacyPatterns("x", [], { storeDir: dir, env: { [PRIVACY_PATTERNS_FILE_ENV]: "/nope/missing.toml" } }),
    /does not exist/
  );
  assert.throws(
    () => resolvePrivacyPatterns("x", [], { storeDir: dir, env: { [PRIVACY_PATTERNS_FILE_ENV]: "   " } }),
    /set but empty/
  );
  const unset = resolvePrivacyPatterns("x", [], { storeDir: path.join(dir, "missing-store"), env: {} });
  assert.deepEqual(unset.patterns, []);
  assert.deepEqual(unset.origins, [], "an unset env var is simply not using this source, no error, no origin entry");
});
