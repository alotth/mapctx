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
 * BOUNDED IN TIME, NOT JUST IN OUTCOME (review ALTA-2)
 * "Non-blocking" has to mean non-blocking in wall-clock too. `mapctx.toml` is
 * versioned and edited by PRs and agents, and a pattern that merely COMPILES
 * can still be catastrophic: `^(a+)+$` against 41 characters measured ~170 s
 * here, exponential in the input, on the write path of `task create`. A
 * budget checked BETWEEN leaves cannot help -- a single `RegExp.exec` is one
 * synchronous, uninterruptible step from JavaScript's point of view. So the
 * matching loop runs inside a `vm` context with a real `timeout`: V8
 * interrupts a running regex for a script timeout, which is the only
 * mechanism available in-process that actually bounds one pathological match.
 * On exhaustion the lint ABORTS -- it reports the findings it already has,
 * names the pattern it was evaluating, and returns. The board operation
 * proceeds. A pattern list can therefore make the lint useless (it says so),
 * never make the board unusable.
 *
 * KEYS ARE SCANNED, AND REPORTED AS UNREDACTABLE (review MEDIA-3)
 * `--evidence "shift-998877=verified"` puts the identifier in the KEY. The
 * key is the audit label: redaction preserves it by design (destroying it
 * would destroy the structure of the record), so it genuinely cannot be
 * cleaned up afterwards. That makes it the one place the lint matters MOST,
 * and the warning says exactly that -- rename it before writing, because
 * there is no later cure. Scanning values but not keys left the two halves of
 * T-126 with the same blind spot; this is that reconciliation.
 *
 * It also never echoes what it matched. Printing the secret into a terminal,
 * a CI log and a scrollback buffer in order to warn that it is sensitive
 * would defeat the point, so a finding reports the field path, which pattern
 * fired, and a masked, length-bearing preview. The full match never leaves
 * the sandbox: the matcher hands out the match LENGTH and at most its first
 * two characters, nothing else.
 */

import * as vm from "node:vm"

export const PRIVACY_PREVIEW_PREFIX_LENGTH = 2

/**
 * Wall-clock ceiling for one lint call (all patterns, all fields). Generous
 * for any sane pattern list, and short enough that a pathological one is an
 * imperceptible hiccup on a board write rather than a hang.
 */
export const PRIVACY_LINT_BUDGET_MS = 250

export type PrivacyPatternConfig = { patterns: string[] }

export type CompiledPrivacyPatterns = {
  regexes: Array<{ index: number; source: string; regex: RegExp }>;
  /** Patterns that would not compile, reported rather than thrown. */
  invalid: Array<{ index: number; source: string; message: string }>;
};

/** Where a match was found: a string value, or a container key. */
export type PrivacySite = "value" | "key"

export type PrivacyFinding = {
  /** Dot path of the offending value (or of the offending key) inside the scanned object. */
  fieldPath: string;
  site: PrivacySite;
  patternIndex: number;
  pattern: string;
  matchLength: number;
  /** Masked: at most the first two characters of the match, never all of it. */
  preview: string;
};

/** Why a scan stopped early. Findings already collected are still reported. */
export type PrivacyScanAbort = {
  afterMs: number;
  /** The pattern being evaluated when the budget ran out, when known. */
  patternIndex: number;
  pattern: string;
};

export type PrivacyScanResult = {
  findings: PrivacyFinding[];
  aborted?: PrivacyScanAbort;
};

export type PrivacyScanOptions = {
  rootPath?: string;
  budgetMs?: number;
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

/**
 * Builds the preview from the only two things the matcher is allowed to
 * return: the match length and its first two characters. A match of two
 * characters or fewer is fully masked -- the prefix would be the whole value.
 */
function previewFrom(prefix: string, matchLength: number): string {
  if (matchLength <= PRIVACY_PREVIEW_PREFIX_LENGTH) return "…"
  return `${prefix.slice(0, PRIVACY_PREVIEW_PREFIX_LENGTH)}…`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type ScanSubject = { fieldPath: string; site: PrivacySite; text: string }

/**
 * Flattens what the lint has to look at: every string leaf, and every
 * container key (array indices excluded -- an index is structure, never a
 * secret). Pure collection, no matching, so it cannot be the slow part.
 */
function scanSubjects(value: unknown, rootPath: string): ScanSubject[] {
  const subjects: ScanSubject[] = []
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      subjects.push({ fieldPath: path || "(value)", site: "value", text: node })
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, path ? `${path}.${index}` : String(index)))
      return
    }
    if (isPlainObject(node)) {
      for (const key of Object.keys(node)) {
        const childPath = path ? `${path}.${key}` : key
        subjects.push({ fieldPath: childPath, site: "key", text: key })
        walk(node[key], childPath)
      }
    }
  }
  walk(value, rootPath)
  return subjects
}

/**
 * The matching loop, compiled once. It runs INSIDE a vm context so the
 * `timeout` below can interrupt a catastrophic regex mid-match (see ALTA-2 in
 * the header). It reports through a host callback and records its position in
 * a host object, so an interrupted run still yields both the findings so far
 * and the pattern that was running when the budget expired.
 *
 * Only the match length and its first two characters cross back out.
 */
const MATCH_SCRIPT = new vm.Script(`
(() => {
  const patterns = __sources.map(source => new RegExp(source));
  for (let subject = 0; subject < __texts.length; subject++) {
    for (let pattern = 0; pattern < patterns.length; pattern++) {
      __progress.pattern = pattern;
      const match = patterns[pattern].exec(__texts[subject]);
      if (match) {
        __report(subject, pattern, match[0].length, match[0].slice(0, 2));
        break;
      }
    }
  }
  __progress.completed = true;
})()
`, { filename: "mapctx-privacy-matcher.js" })

type RawMatch = { subject: number; pattern: number; matchLength: number; prefix: string }

function matchWithinBudget(
  texts: readonly string[],
  sources: readonly string[],
  budgetMs: number
): { matches: RawMatch[]; abortedAtPattern?: number; afterMs: number } {
  const matches: RawMatch[] = []
  const progress = { pattern: -1, completed: false }
  const context = vm.createContext({
    __sources: [...sources],
    __texts: [...texts],
    __progress: progress,
    __report: (subject: number, pattern: number, matchLength: number, prefix: string): void => {
      matches.push({ subject, pattern, matchLength, prefix })
    }
  })
  const startedAt = Date.now()
  try {
    MATCH_SCRIPT.runInContext(context, { timeout: budgetMs })
    return { matches, afterMs: Date.now() - startedAt }
  } catch {
    // Timeout, or any other failure of the matcher itself. Either way the
    // lint degrades to "what it managed to find", never to an exception on a
    // board write.
    return { matches, abortedAtPattern: progress.pattern, afterMs: Date.now() - startedAt }
  }
}

/**
 * Walks every string leaf and container key of `value` and reports the first
 * pattern each one trips. One finding per field keeps a wide pattern list
 * from burying the operator; the field is what they have to go look at either
 * way. Bounded by `budgetMs` of wall clock in total.
 */
export function scanForPrivacyPatterns(
  value: unknown,
  compiled: CompiledPrivacyPatterns,
  options: PrivacyScanOptions | string = {}
): PrivacyScanResult {
  const resolved: PrivacyScanOptions = typeof options === "string" ? { rootPath: options } : options
  if (compiled.regexes.length === 0) return { findings: [] }
  const subjects = scanSubjects(value, resolved.rootPath ?? "")
  if (subjects.length === 0) return { findings: [] }
  const budgetMs = resolved.budgetMs ?? PRIVACY_LINT_BUDGET_MS
  const outcome = matchWithinBudget(subjects.map(subject => subject.text), compiled.regexes.map(entry => entry.source), budgetMs)

  const findings: PrivacyFinding[] = outcome.matches.map(match => {
    const subject = subjects[match.subject]
    const pattern = compiled.regexes[match.pattern]
    return {
      fieldPath: subject.fieldPath,
      site: subject.site,
      patternIndex: pattern.index,
      pattern: pattern.source,
      matchLength: match.matchLength,
      preview: previewFrom(match.prefix, match.matchLength)
    }
  })
  if (outcome.abortedAtPattern === undefined) return { findings }
  const culprit = compiled.regexes[outcome.abortedAtPattern]
  return {
    findings,
    aborted: {
      afterMs: outcome.afterMs,
      patternIndex: culprit?.index ?? -1,
      pattern: culprit?.source ?? "(unknown)"
    }
  }
}

export type PrivacyWarningOptions = {
  /**
   * Whether redaction could still reach this field path after the write.
   * Callers that know the event type pass `redactableRootFor`-backed truth;
   * the default is the honest one for a caller that does not know: no.
   * Promising a cure that `mapctx redact` will refuse is worse than silence,
   * because the operator writes the production value trusting the promise
   * (review MEDIA-1).
   */
  redactable?: (fieldPath: string) => boolean;
};

/**
 * Human-readable warning lines for a set of findings, plus any invalid
 * pattern and any abort. Callers print these on STDERR so `--json` stdout
 * stays a clean, parseable document -- a warning must never corrupt a machine
 * consumer.
 */
export function formatPrivacyWarnings(
  operation: string,
  result: PrivacyScanResult | readonly PrivacyFinding[],
  compiled: CompiledPrivacyPatterns,
  options: PrivacyWarningOptions = {}
): string[] {
  const scan: PrivacyScanResult = Array.isArray(result) ? { findings: [...result] } : result as PrivacyScanResult
  const lines: string[] = []
  for (const invalid of compiled.invalid) {
    lines.push(`privacy: [privacy] patterns[${invalid.index}] is not a valid regex (${invalid.message}); it was skipped. Fix mapctx.toml.`)
  }
  for (const finding of scan.findings) {
    const where = `privacy: ${operation} ${finding.site === "key" ? "key" : "field"} "${finding.fieldPath}" matches [privacy] patterns[${finding.patternIndex}] /${finding.pattern}/ ` +
      `(${finding.matchLength} chars, starts "${finding.preview}").`
    if (finding.site === "key") {
      lines.push(`${where} Not blocked. A key is the audit label and is never redactable -- there is no cure after the write: rename it before writing.`)
      continue
    }
    if (options.redactable?.(finding.fieldPath)) {
      lines.push(`${where} Not blocked. If this is production data, remove it, or redact it after the fact: mapctx redact --sequence <n> --field "${finding.fieldPath}" --reason "..." --commit`)
      continue
    }
    lines.push(`${where} Not blocked. This field is NOT redactable afterwards (mapctx redact covers acceptance evidence, receipt evidence URIs and history repo paths only): remove it before writing.`)
  }
  if (scan.aborted) {
    lines.push(
      `privacy: lint aborted after ${scan.aborted.afterMs}ms; [privacy] patterns[${scan.aborted.patternIndex}] /${scan.aborted.pattern}/ is too expensive to evaluate -- simplify it ` +
      `(nested quantifiers like (a+)+ backtrack exponentially). Fields after it were not scanned. ${operation} was NOT blocked.`
    )
  }
  return lines
}

export type PrivacyLintReport = {
  findings: PrivacyFinding[];
  aborted?: PrivacyScanAbort;
  warnings: string[];
};

export type PrivacyLintOptions = PrivacyScanOptions & PrivacyWarningOptions

/** One-call lint: compile, scan, format. Returns an empty report when unconfigured. */
export function lintForPrivacy(
  operation: string,
  value: unknown,
  patterns: readonly string[] | undefined,
  options: PrivacyLintOptions = {}
): PrivacyLintReport {
  if (!patterns || patterns.length === 0) return { findings: [], warnings: [] }
  const compiled = compilePrivacyPatterns(patterns)
  const scan = scanForPrivacyPatterns(value, compiled, options)
  return {
    findings: scan.findings,
    ...(scan.aborted ? { aborted: scan.aborted } : {}),
    warnings: formatPrivacyWarnings(operation, scan, compiled, options)
  }
}
