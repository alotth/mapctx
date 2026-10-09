/**
 * T-126 (E-017 R5), second half: the `[privacy] patterns` lint.
 *
 * Redaction is the cure; this is the (cheap, optional) prevention. An agent
 * that is about to store a production identifier as evidence gets told so at
 * the moment it writes, instead of someone discovering it in the journal
 * months later when the only remedy left is a redaction event.
 *
 * Deliberately NON-BLOCKING. The board is the system of record for work in
 * flight, and a regex is a guess: a false positive must never be able to stop
 * a task from being created or a receipt from being recorded. A malformed
 * pattern is likewise reported as a warning, never raised -- a typo in
 * mapctx.toml must not brick board operations either. The lint's whole job is
 * to make the operator look.
 *
 * It also never echoes what it matched. Printing the secret into a terminal,
 * a CI log and a scrollback buffer in order to warn that it is sensitive
 * would defeat the point, so a finding reports the field path, which pattern
 * fired, and a masked, length-bearing preview.
 */

export const PRIVACY_PREVIEW_PREFIX_LENGTH = 2

export type PrivacyPatternConfig = { patterns: string[] }

export type CompiledPrivacyPatterns = {
  regexes: Array<{ index: number; source: string; regex: RegExp }>;
  /** Patterns that would not compile, reported rather than thrown. */
  invalid: Array<{ index: number; source: string; message: string }>;
};

export type PrivacyFinding = {
  /** Dot path of the offending value inside the scanned object. */
  fieldPath: string;
  patternIndex: number;
  pattern: string;
  matchLength: number;
  /** Masked: at most the first two characters of the match, never all of it. */
  preview: string;
};

export function compilePrivacyPatterns(patterns: readonly string[]): CompiledPrivacyPatterns {
  const regexes: CompiledPrivacyPatterns["regexes"] = []
  const invalid: CompiledPrivacyPatterns["invalid"] = []
  patterns.forEach((source, index) => {
    try {
      regexes.push({ index, source, regex: new RegExp(source) })
    } catch (error) {
      invalid.push({ index, source, message: (error as Error).message })
    }
  })
  return { regexes, invalid }
}

function maskMatch(match: string): string {
  if (match.length <= PRIVACY_PREVIEW_PREFIX_LENGTH) return "…"
  return `${match.slice(0, PRIVACY_PREVIEW_PREFIX_LENGTH)}…`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Walks every string leaf of `value` and reports the first pattern each leaf
 * trips. One finding per field keeps a wide pattern list from burying the
 * operator; the field is what they have to go look at either way.
 */
export function scanForPrivacyPatterns(
  value: unknown,
  compiled: CompiledPrivacyPatterns,
  rootPath = ""
): PrivacyFinding[] {
  if (compiled.regexes.length === 0) return []
  const findings: PrivacyFinding[] = []
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      for (const { index, source, regex } of compiled.regexes) {
        const match = regex.exec(node)
        if (!match) continue
        findings.push({
          fieldPath: path || "(value)",
          patternIndex: index,
          pattern: source,
          matchLength: match[0].length,
          preview: maskMatch(match[0])
        })
        return
      }
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, itemIndex) => walk(item, path ? `${path}.${itemIndex}` : String(itemIndex)))
      return
    }
    if (isPlainObject(node)) {
      for (const key of Object.keys(node)) walk(node[key], path ? `${path}.${key}` : key)
    }
  }
  walk(value, rootPath)
  return findings
}

/**
 * Human-readable warning lines for a set of findings, plus any invalid
 * pattern. Callers print these on STDERR so `--json` stdout stays a clean,
 * parseable document -- a warning must never corrupt a machine consumer.
 */
export function formatPrivacyWarnings(operation: string, findings: readonly PrivacyFinding[], compiled: CompiledPrivacyPatterns): string[] {
  const lines: string[] = []
  for (const invalid of compiled.invalid) {
    lines.push(`privacy: [privacy] patterns[${invalid.index}] is not a valid regex (${invalid.message}); it was skipped. Fix mapctx.toml.`)
  }
  for (const finding of findings) {
    lines.push(
      `privacy: ${operation} field "${finding.fieldPath}" matches [privacy] patterns[${finding.patternIndex}] /${finding.pattern}/ ` +
      `(${finding.matchLength} chars, starts "${finding.preview}"). Not blocked. If this is production data, remove it, or redact it after the fact: mapctx redact --sequence <n> --field <path> --reason "..." --commit`
    )
  }
  return lines
}

export type PrivacyLintReport = {
  findings: PrivacyFinding[];
  warnings: string[];
};

/** One-call lint: compile, scan, format. Returns an empty report when unconfigured. */
export function lintForPrivacy(operation: string, value: unknown, patterns: readonly string[] | undefined): PrivacyLintReport {
  if (!patterns || patterns.length === 0) return { findings: [], warnings: [] }
  const compiled = compilePrivacyPatterns(patterns)
  const findings = scanForPrivacyPatterns(value, compiled)
  return { findings, warnings: formatPrivacyWarnings(operation, findings, compiled) }
}
