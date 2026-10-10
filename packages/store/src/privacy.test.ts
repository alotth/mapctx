import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs"
import * as path from "path"
import { readMapctxToml, serializeMapctxToml } from "./config"
import { compilePrivacyPatterns, lintForPrivacy, scanForPrivacyPatterns } from "./privacy"
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
