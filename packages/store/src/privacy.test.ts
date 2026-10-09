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
  const findings = scanForPrivacyPatterns(value, compiled, "receipt");
  assert.deepEqual(findings, [
    { fieldPath: "receipt.evidence.0.uri", patternIndex: 0, pattern: PATTERN, matchLength: SECRET.length, preview: "cu…" },
    { fieldPath: "receipt.evidence.1", patternIndex: 0, pattern: PATTERN, matchLength: SECRET.length, preview: "cu…" }
  ]);
  assert.ok(!JSON.stringify(findings).includes(SECRET));
  assert.deepEqual(value.evidence[1], SECRET, "scan must not change the input");
  assert.equal(findings.length, 2, "only first matching pattern per string field is reported");
  assert.equal(scanForPrivacyPatterns(SECRET, compiled)[0].fieldPath, "(value)");
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
  assert.deepEqual(scanForPrivacyPatterns({ [SECRET]: "safe" }, compilePrivacyPatterns([PATTERN])), [], "scan values, not label keys");
});

test("one/two-character privacy matches are fully masked; repeated scans remain deterministic", () => {
  const compiled = compilePrivacyPatterns(["X{1,2}"]);
  const first = scanForPrivacyPatterns(["X", "XX", "safe"], compiled);
  assert.deepEqual(first.map(f => [f.matchLength, f.preview]), [[1, "…"], [2, "…"]]);
  assert.deepEqual(scanForPrivacyPatterns(["X", "XX", "safe"], compiled), first);
  const report = lintForPrivacy("task create", "XX", ["X{1,2}"]);
  assert.ok(!report.warnings.join("\n").includes("XX"));
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
