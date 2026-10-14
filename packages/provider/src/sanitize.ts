/**
 * T-151 (E-018): sanitization before anything reaches a PUBLIC repository.
 *
 * WHY THIS EXISTS
 * The operator is mirroring this board into issues on the public repo
 * `alotth/mapctx`. The triage in `docs/engineering/board-triage-2026-10.md`
 * (T-149) read the real board and found three shapes of content that must not
 * cross that line: machine-local absolute paths carrying a username, links to
 * Traycer artifacts that embed an internal epic id (dead for every public
 * reader anyway), and a third party's organization name in prose and inside an
 * approved acceptance criterion. Nineteen tasks and one epic carry at least
 * one of them -- including this task's own description.
 *
 * WHAT THIS IS
 * A pure function. It takes the text that would be published and returns the
 * text that may be published, plus a report of what it changed. It performs no
 * I/O, opens no store, and mutates none of its inputs.
 *
 * ONE-WAY BY CONSTRUCTION, NOT BY PROMISE
 * The mirror must never write sanitized text back into the store: the store
 * holds the operator's working truth, where the real path is the useful thing,
 * and feeding the placeholder back would destroy it on the authoritative side.
 * This module cannot enforce that -- a type brand would not survive the
 * round-trip through a provider payload -- so it does the one thing it can:
 * it never mutates the input, so the caller always still holds the original,
 * and the direction is stated here. T-152 publishes the RESULT and keeps
 * writing the INPUT.
 *
 * WHERE THE PATTERNS LIVE, AND WHY NOT IN mapctx.toml
 * The context-dependent category -- a third party's name, this machine's
 * hostname, a customer identifier -- cannot be expressed as a built-in rule;
 * only the operator knows the strings. The obvious home for them,
 * `[privacy] patterns` in mapctx.toml, is the one place they must not go:
 * that file is committed, and it is about to be committed to the PUBLIC
 * repo. Writing the third party's name there to keep it out of public issues
 * would publish it on the way in. So `resolvePrivacyPatterns` (store
 * config.ts) unions mapctx.toml with an unversioned `privacy.toml` beside the
 * store and with a file named by MAPCTX_PRIVACY_PATTERNS_FILE, and this
 * module takes the resolved list.
 *
 * An INVALID pattern refuses too (review ALTO-4). The gate counts patterns
 * that COMPILED, never patterns that were supplied: one unbalanced
 * parenthesis used to leave the report saying "configured" with zero live
 * regexes, which is the gate disarming itself while claiming to be armed.
 * The refusal names the index and not the pattern, because a pattern from
 * the unversioned file is itself a secret.
 *
 * An EMPTY list refuses (review ALTO-3). With no pattern configured the
 * category is inert, and a run then reports `refused=0`, which reads as
 * "clean" but means "I did not look" -- the most dangerous possible output
 * for a tool whose job is to decide what becomes public. `patternsReviewedAsAbsent`
 * lets an operator say they looked and there is nothing; it is recorded in
 * the report, never assumed.
 *
 * FAIL-CLOSED, AND "UNFINISHED" IS NOT "CLEAN"
 * After rewriting, the output is scanned again with the same rules. Anything
 * that still matches refuses publication for that task, naming the field and
 * the category and never the value. The privacy-pattern pass runs untrusted
 * regexes from `mapctx.toml` under the T-126 wall-clock budget; if that budget
 * runs out the task is refused too. A scan that did not finish says nothing
 * about what it did not reach, and treating it as a clean bill of health is
 * precisely how a secret would get published.
 *
 * DELIBERATELY NARROW RULES
 * Over-removal is a real failure here, not a safe default: this board's value
 * is in sentences like "`packages/store/src/x.ts:1-30` fixed it", and a
 * sanitizer that eats repository-relative paths, git SHAs or `github.com`
 * links publishes something useless. So every rule is anchored on something
 * that is unambiguously machine-local or internal:
 *
 *   - paths must start at one of a named list of machine-local roots
 *     (`/Users`, `/home`, `/root`, `/tmp`, `/private/tmp`, `/private/var`,
 *     `/var/folders`, `/Volumes`, `/mnt`, a Windows drive, or `~/`) --
 *     `packages/...` and `docs/...` are untouched. The first cut listed only
 *     the first four and let four more families through as PUBLISHABLE,
 *     including `/private/tmp/claude-<uid>/-Users-<user>-...`, the scratchpad
 *     every agent in this epic writes to, carrying the uid and the username
 *     twice (review ALTO-2);
 *   - `~/.mapctx` and `~/.claude` are explicitly KEPT. The triage flagged them
 *     as generic, documented in the public README, and revealing nothing about
 *     a particular machine. `/Users/<name>/.mapctx` is still removed, because
 *     the username is the disclosure;
 *   - only UUID-shaped identifiers are internal ids. Git SHAs are hex too, and
 *     they are the public evidence this board cites constantly, so a bare-hex
 *     rule would delete the audit trail it is supposed to protect;
 *   - hostnames are matched only on private suffixes (`.local`, `.lan`,
 *     `.internal`, `.home.arpa`) and private IPv4 ranges. A general hostname
 *     rule would strip `github.com` out of every link. A site-specific host
 *     belongs in the pattern list, where the operator can name it.
 *
 *     A SUFFIX-LESS machine name (`someone-mac-air`) stays delegated too, and
 *     that is a deliberate choice rather than an oversight (review ALTO-2).
 *     Any rule general enough to catch it -- `*-mac*`, `*-macbook*`, "two
 *     hyphenated words that look like a hostname" -- is a guess about English
 *     prose, and this board is full of hyphenated identifiers that must
 *     survive (`t058-walking-skeleton`, `board-triage-2026-10`,
 *     `ready-for-do`). Guessing there trades a certain, measurable loss of
 *     meaning for an uncertain gain. What made the delegation unacceptable
 *     was not the delegation: it was that an unconfigured pattern list said
 *     nothing. ALTO-3 removes the silence, so the delegation now holds.
 *
 * IDEMPOTENT
 * The mirror re-publishes on every sync, so sanitizing twice must equal
 * sanitizing once. Every replacement token is chosen so that no rule matches
 * it: the tokens carry no slash-prefixed path, no UUID, no `@`, no private
 * suffix. The test suite asserts the fixed point rather than trusting the
 * reading.
 */

import {
  compilePrivacyPatterns,
  replacePrivacyPatterns,
  scanForPrivacyPatterns,
  PRIVACY_LINT_BUDGET_MS,
  type CompiledPrivacyPatterns,
  type PrivacyScanAbort
} from "@mapctx/store"

export type SanitizeCategory =
  | "artifact-link"
  | "absolute-path"
  | "internal-id"
  | "credential"
  | "email"
  | "private-host"
  | "privacy-pattern"

export const SANITIZE_TOKENS = {
  "artifact-link": "<internal-artifact>",
  "absolute-path": "<local-path>",
  "internal-id": "<internal-id>",
  credential: "<credential>",
  email: "<email>",
  "private-host": "<host>",
  "privacy-pattern": "<redacted>"
} as const satisfies Record<SanitizeCategory, string>

/**
 * Wall-clock ceiling for the STRUCTURAL pass, mirroring the privacy budget.
 *
 * The structural rules are ours and are linear by construction (ALTO-1
 * removed the one that was not, and bounding the email and host quantifiers
 * removed two more of the same shape), so this is not the primary defence --
 * it is the backstop that keeps a future rule from reintroducing an unbounded
 * hang in the one pass that does not run in the sandbox. Exhausting it
 * refuses the task exactly like an exhausted privacy budget: an unfinished
 * sweep is not a clean one.
 *
 * Deliberately looser than the privacy budget. Because the pass is linear,
 * time here tracks document size, and a budget tight enough to be a throttle
 * would refuse big-but-honest task bodies -- a false refusal blocks a clean
 * task from being published, which is a worse outcome than catching a future
 * bad rule a few hundred milliseconds later. Measured: 80 KB of worst-case
 * unbroken text sweeps in ~140 ms, so this leaves roughly an order of
 * magnitude of headroom over anything a task body plausibly holds.
 */
export const STRUCTURAL_BUDGET_MS = 1000

/** What happened to one field, by category. The value is never carried. */
export type SanitizeSubstitution = {
  /** `title`, `body`, `criteria[<criterionId>]`, `links[2]`, `fields.summary`. */
  field: string
  category: SanitizeCategory
  occurrences: number
  /** `replaced` in place, or `dropped` for a structured link that cannot survive. */
  action: "replaced" | "dropped"
  /** The token the content became; safe to print, unlike the content. */
  replacement: string
  /** Which `[privacy] patterns` entry fired, for the privacy category only. */
  patternIndex?: number
}

/** A match that survived sanitization. Named, never quoted. */
export type SanitizeResidue = {
  field: string
  category: SanitizeCategory
  occurrences: number
  patternIndex?: number
}

export type SanitizeReport = {
  taskId: string
  substitutions: SanitizeSubstitution[]
  /** Per-category totals across every field of this task. */
  totals: Record<SanitizeCategory, number>
  /** Field names that were scanned, so an empty report is distinguishable from an unscanned task. */
  scannedFields: string[]
  /**
   * Whether any `[privacy] pattern` was in force. False means the
   * context-dependent category was NOT checked -- the difference between
   * "found nothing" and "did not look" (review ALTO-3).
   */
  privacyPatternsConfigured: boolean
  /** The operator declared the absent pattern list reviewed and intentional. */
  patternsReviewedAsAbsent?: boolean
  /** Set when the privacy budget ran out; the task is refused when it is. */
  aborted?: PrivacyScanAbort
  /** Set when the structural budget ran out; the task is refused when it is. */
  structuralExhausted?: { rule: string; budgetMs: number }
}

export type PublishableTask = {
  taskId: string
  title: string
  body?: string
  summary?: string
  criteria?: readonly { id: string; text: string }[]
  links?: readonly string[]
  /** Any further provider-owned string fields that will be published verbatim. */
  fields?: Readonly<Record<string, string>>
}

export type SanitizeRefusalReason = "residual-match" | "scan-incomplete" | "patterns-unconfigured" | "patterns-invalid"

export type SanitizeResult =
  | { ok: true; task: PublishableTask; report: SanitizeReport }
  | { ok: false; reason: SanitizeRefusalReason; message: string; residues: SanitizeResidue[]; report: SanitizeReport }

export type SanitizeOptions = {
  /**
   * The resolved pattern list. For this project it must come from
   * `resolvePrivacyPatterns`, which unions mapctx.toml with an UNVERSIONED
   * local file -- mapctx.toml is committed to the public repo, so the
   * patterns that matter most (a third party's name, the operator's
   * hostname) cannot live there without publishing themselves.
   */
  privacyPatterns?: readonly string[]
  /**
   * Publish with no pattern configured. Review ALTO-3: an empty list makes
   * the one category that covers context-dependent content inert, and the
   * run then reports `refused=0`, which reads as "clean" but means "I did
   * not look". So an empty list REFUSES by default, and this flag is the
   * operator saying, deliberately and visibly, that they looked and there is
   * nothing to configure. It is recorded in the report rather than silently
   * honoured.
   */
  patternsReviewedAsAbsent?: boolean
  /** Wall-clock ceiling for the untrusted privacy regexes. */
  budgetMs?: number
  /** Wall-clock ceiling for the structural pass (review ALTO-1). */
  structuralBudgetMs?: number
}

type StructuralCategory = Exclude<SanitizeCategory, "privacy-pattern">

type StructuralRule = {
  category: StructuralCategory
  regex: RegExp
  /** Token for one match. A rule may keep a safe capture (the artifact slug). */
  tokenFor: (match: RegExpExecArray) => string
  /**
   * Extend the match leftwards over path characters, in linear code.
   *
   * Review ALTO-1: the artifact rule used to do this with a leading
   * `[A-Za-z0-9._~:\\/-]*` before the `epics/` literal, which is a star
   * followed by a required literal -- on a long run of matching characters
   * that has no `epics/` in it, the engine consumes the run, fails, and
   * backtracks one character per starting position. Measured at 1 min 50 s
   * for 60 KB of unbroken text, in the host realm, with no budget and no
   * refusal: the exact failure class T-126's sandbox exists to prevent,
   * reachable here by CONTENT (a pasted stack trace, a base64 blob, a
   * minified line) rather than by configuration. The scan below is O(n).
   */
  expandLeft?: boolean
}

/** The characters a local path prefix may be built from, for `expandLeft`. */
const PATH_PREFIX_CHARACTER = /[A-Za-z0-9._~:\\/-]/

/**
 * Order matters. The artifact rule runs FIRST because the link it matches
 * contains both an absolute path and a UUID: let either of those rules go
 * first and the link is shredded into tokens, losing the one piece worth
 * keeping -- the artifact's slug, which tells a maintainer which internal
 * document the sentence is about.
 */
const STRUCTURAL_RULES: readonly StructuralRule[] = [
  {
    category: "artifact-link",
    // Anchored on the literal shape only. Any path prefix in front of it is
    // absorbed by `expandLeft`, in linear code -- never by a regex star.
    regex: /epics\/[0-9a-fA-F][0-9a-fA-F-]{7,}\/artifacts\/([A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._-]+)*/g,
    tokenFor: match => `<internal-artifact:${match[1]}>`,
    expandLeft: true
  },
  {
    category: "absolute-path",
    // Review ALTO-2: the first cut anchored only on /Users, /home, /root, a
    // Windows drive and `~/`, so four more families of machine-local path
    // passed through AND were declared publishable. The worst was
    // `/private/tmp/claude-<uid>/-Users-<user>--traycer-...`: the scratchpad
    // every agent in this epic writes to, carrying the uid and the username
    // twice. None of these can appear as a repository-relative path, so
    // adding them as literal alternatives costs no over-removal risk.
    regex: /(?:\/Users|\/home|\/root|\/private\/tmp|\/private\/var|\/var\/folders|\/tmp|\/Volumes|\/mnt)(?:\/[^\s"'`)\]<>]+)+/g,
    tokenFor: () => SANITIZE_TOKENS["absolute-path"]
  },
  {
    category: "absolute-path",
    regex: /\b[A-Za-z]:\\(?:[^\s"'`)\]<>]+)/g,
    tokenFor: () => SANITIZE_TOKENS["absolute-path"]
  },
  {
    category: "absolute-path",
    // `~/` paths, except the two tool directories the triage cleared as
    // generic. `~/.mapctx` and `~/.claude` are in the public README already.
    regex: /~\/(?!\.mapctx\b|\.claude\b)[^\s"'`)\]<>]*/g,
    tokenFor: () => SANITIZE_TOKENS["absolute-path"]
  },
  {
    category: "internal-id",
    regex: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    tokenFor: () => SANITIZE_TOKENS["internal-id"]
  },
  {
    // Review MEDIA-1. The corpus carries none today, and the destination is
    // GitHub, where a leaked PAT is actionable the moment it is indexed.
    // Cheapest possible insurance, and the shapes are unambiguous enough
    // that there is no prose they could eat.
    category: "credential",
    regex: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
    tokenFor: () => SANITIZE_TOKENS.credential
  },
  {
    category: "credential",
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    tokenFor: () => SANITIZE_TOKENS.credential
  },
  {
    category: "credential",
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    tokenFor: () => SANITIZE_TOKENS.credential
  },
  {
    category: "credential",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    tokenFor: () => SANITIZE_TOKENS.credential
  },
  {
    // Every quantifier here is BOUNDED, and that is load-bearing, not
    // tidiness. An unbounded `[A-Za-z0-9._%+-]+` before the required `@` is
    // the same shape as the artifact prefix ALTO-1 removed: on a long
    // unbroken alphanumeric run (a base64 blob, a data URI) the engine
    // consumes the run, fails on `@`, and backtracks a character at a time
    // from every starting position. Measured here at 3.3 s for 60 KB before
    // the bounds went in -- the review found this shape in one rule, and it
    // was in three. 64 is the RFC 5321 local-part maximum and 255 the
    // domain maximum, so the bound costs nothing real and caps the work per
    // position at a constant.
    category: "email",
    regex: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g,
    tokenFor: () => SANITIZE_TOKENS.email
  },
  {
    category: "private-host",
    // Bounded for the same reason as the email rule above; 63 is the DNS
    // label maximum.
    regex: /\b[A-Za-z0-9][A-Za-z0-9-]{0,62}\.(?:local|lan|internal|home\.arpa)\b/g,
    tokenFor: () => SANITIZE_TOKENS["private-host"]
  },
  {
    category: "private-host",
    regex: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g,
    tokenFor: () => SANITIZE_TOKENS["private-host"]
  }
]

type FieldText = { field: string; text: string; kind: "text" | "link" }

function collectFields(task: PublishableTask): FieldText[] {
  const fields: FieldText[] = [{ field: "title", text: task.title, kind: "text" }]
  if (task.body !== undefined) fields.push({ field: "body", text: task.body, kind: "text" })
  if (task.summary !== undefined) fields.push({ field: "summary", text: task.summary, kind: "text" })
  for (const criterion of task.criteria ?? []) {
    fields.push({ field: `criteria[${criterion.id}]`, text: criterion.text, kind: "text" })
  }
  ;(task.links ?? []).forEach((link, index) => {
    fields.push({ field: `links[${index}]`, text: link, kind: "link" })
  })
  for (const name of Object.keys(task.fields ?? {}).sort()) {
    fields.push({ field: `fields.${name}`, text: (task.fields as Record<string, string>)[name], kind: "text" })
  }
  return fields
}

type StructuralOutcome = {
  text: string
  hits: Array<{ category: StructuralCategory; occurrences: number }>
  /** The budget ran out partway; the text is NOT safe to publish. */
  exhausted?: { rule: string; afterMs: number; budgetMs: number }
}

/** Applies one rule across one text, left-expanding where the rule asks. */
function applyRule(text: string, rule: StructuralRule): { text: string; occurrences: number } {
  // A fresh regex per application: the shared literal carries `g`, so its
  // `lastIndex` would otherwise leak between fields.
  const regex = new RegExp(rule.regex.source, rule.regex.flags)
  let out = ""
  let copiedTo = 0
  let occurrences = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) { regex.lastIndex += 1; continue }
    let start = match.index
    if (rule.expandLeft) {
      while (start > copiedTo && PATH_PREFIX_CHARACTER.test(text[start - 1])) start -= 1
    }
    out += text.slice(copiedTo, start) + rule.tokenFor(match)
    copiedTo = regex.lastIndex
    occurrences += 1
  }
  return { text: occurrences === 0 ? text : out + text.slice(copiedTo), occurrences }
}

function applyStructuralRules(text: string, deadline: { endsAt: number; budgetMs: number }): StructuralOutcome {
  const perCategory = new Map<StructuralCategory, number>()
  let current = text
  for (const rule of STRUCTURAL_RULES) {
    if (Date.now() > deadline.endsAt) {
      return {
        text: current,
        hits: [...perCategory.entries()].map(([category, occurrences]) => ({ category, occurrences })),
        exhausted: { rule: rule.category, afterMs: deadline.budgetMs, budgetMs: deadline.budgetMs }
      }
    }
    const applied = applyRule(current, rule)
    current = applied.text
    if (applied.occurrences > 0) perCategory.set(rule.category, (perCategory.get(rule.category) ?? 0) + applied.occurrences)
  }
  return {
    text: current,
    hits: [...perCategory.entries()].map(([category, occurrences]) => ({ category, occurrences }))
  }
}

function emptyTotals(): Record<SanitizeCategory, number> {
  return {
    "artifact-link": 0,
    "absolute-path": 0,
    "internal-id": 0,
    credential: 0,
    email: 0,
    "private-host": 0,
    "privacy-pattern": 0
  }
}

/**
 * Structural residues in one already-sanitized string.
 *
 * Exported because it is half of the fail-closed gate and had no test of its
 * own (review BAIXA-1): gutting it to return `[]` broke nothing, since no
 * reachable input produces a structural residue today -- the tokens are built
 * not to re-trigger a rule. It is defence in depth against a future rule or
 * token that overlaps, so it is tested directly on leaky text rather than
 * through an end-to-end case that cannot currently exist.
 */
export function findStructuralResidues(field: string, text: string): SanitizeResidue[] {
  const residues: SanitizeResidue[] = []
  const perCategory = new Map<StructuralCategory, number>()
  for (const rule of STRUCTURAL_RULES) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags)
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      if (match[0].length === 0) { regex.lastIndex += 1; continue }
      perCategory.set(rule.category, (perCategory.get(rule.category) ?? 0) + 1)
    }
  }
  for (const [category, occurrences] of perCategory) residues.push({ field, category, occurrences })
  return residues
}

/**
 * Sanitizes one task for publication, or refuses it.
 *
 * Structural rules run first and privacy patterns second: the structural pass
 * is cheap and linear, and shrinking the text first means the untrusted
 * patterns run over less of it.
 */
export function sanitizeTaskForPublication(task: PublishableTask, options: SanitizeOptions = {}): SanitizeResult {
  const budgetMs = options.budgetMs ?? PRIVACY_LINT_BUDGET_MS
  const structuralBudgetMs = options.structuralBudgetMs ?? STRUCTURAL_BUDGET_MS
  const configuredPatterns = options.privacyPatterns ?? []
  const compiled: CompiledPrivacyPatterns = compilePrivacyPatterns(configuredPatterns)
  const fields = collectFields(task)
  const substitutions: SanitizeSubstitution[] = []
  const totals = emptyTotals()
  // Review ALTO-4: count what COMPILED, not what was supplied. A single
  // unbalanced parenthesis used to leave `configured = true` with zero live
  // regexes -- the gate ALTO-3 installed, disarmed by a typo, reporting
  // itself as armed.
  const privacyPatternsConfigured = compiled.regexes.length > 0

  // An invalid pattern is NOT "one pattern less". The operator wrote it to
  // catch something, so the coverage they believe they have does not exist,
  // and `patternsReviewedAsAbsent` cannot excuse it either -- that flag means
  // "there is nothing to configure", and a broken pattern is the opposite.
  // The index is named; the pattern SOURCE deliberately is not, because it
  // may come from the unversioned privacy.toml where the pattern is itself
  // the secret.
  if (compiled.invalid.length > 0) {
    const named = compiled.invalid.map(entry => `patterns[${entry.index}] (${entry.message})`).join(", ")
    return {
      ok: false,
      reason: "patterns-invalid",
      message: `${task.taskId} will not be published: ${compiled.invalid.length} of ${configuredPatterns.length} [privacy] pattern(s) did not compile -- ${named}. A pattern that does not compile covers nothing, so the gate would report "configured" while checking less than the operator thinks. Fix the pattern; its text is not reproduced here because it may itself be the sensitive string.`,
      residues: [],
      report: {
        taskId: task.taskId,
        substitutions: [],
        totals,
        scannedFields: fields.map(field => field.field),
        privacyPatternsConfigured
      }
    }
  }

  // Review ALTO-3. Refused BEFORE any work: there is nothing to report about
  // a category that was never checked, and a report that looks complete is
  // the whole hazard. The operator can declare the absence reviewed, which is
  // recorded rather than silently honoured.
  if (!privacyPatternsConfigured && options.patternsReviewedAsAbsent !== true) {
    const bare: SanitizeReport = {
      taskId: task.taskId,
      substitutions: [],
      totals,
      scannedFields: fields.map(field => field.field),
      privacyPatternsConfigured: false
    }
    return {
      ok: false,
      reason: "patterns-unconfigured",
      message: `${task.taskId} will not be published: no [privacy] patterns are configured, so the one category that covers context-dependent content (a third party's name, this machine's hostname, a customer identifier) was not checked at all. "Nothing found" and "did not look" are not the same answer. Add patterns to the UNVERSIONED ${"privacy.toml"} beside the store (never to the public mapctx.toml), or pass patternsReviewedAsAbsent to record that you looked and there is nothing to configure.`,
      residues: [],
      report: bare
    }
  }

  const structuralDeadline = { endsAt: Date.now() + structuralBudgetMs, budgetMs: structuralBudgetMs }
  let structuralExhausted: { rule: string; budgetMs: number } | undefined
  const afterStructural = fields.map(field => {
    const outcome = applyStructuralRules(field.text, structuralDeadline)
    if (outcome.exhausted && !structuralExhausted) {
      structuralExhausted = { rule: outcome.exhausted.rule, budgetMs: outcome.exhausted.budgetMs }
    }
    for (const hit of outcome.hits) {
      totals[hit.category] += hit.occurrences
      substitutions.push({
        field: field.field,
        category: hit.category,
        occurrences: hit.occurrences,
        action: field.kind === "link" ? "dropped" : "replaced",
        replacement: hit.category === "artifact-link" ? `${SANITIZE_TOKENS["artifact-link"]}:<slug>` : SANITIZE_TOKENS[hit.category]
      })
    }
    return { ...field, text: outcome.text, changed: outcome.text !== field.text }
  })

  const privacy = replacePrivacyPatterns(
    afterStructural.map(field => field.text),
    compiled,
    { replacement: SANITIZE_TOKENS["privacy-pattern"], budgetMs }
  )
  for (const count of privacy.counts) {
    const field = afterStructural[count.subject]
    totals["privacy-pattern"] += count.occurrences
    substitutions.push({
      field: field.field,
      category: "privacy-pattern",
      occurrences: count.occurrences,
      action: field.kind === "link" ? "dropped" : "replaced",
      replacement: SANITIZE_TOKENS["privacy-pattern"],
      patternIndex: count.patternIndex
    })
  }

  const report: SanitizeReport = {
    taskId: task.taskId,
    substitutions,
    totals,
    scannedFields: fields.map(field => field.field),
    privacyPatternsConfigured,
    ...(options.patternsReviewedAsAbsent === true ? { patternsReviewedAsAbsent: true } : {}),
    ...(privacy.aborted ? { aborted: privacy.aborted } : {}),
    ...(structuralExhausted ? { structuralExhausted } : {})
  }

  if (structuralExhausted) {
    return {
      ok: false,
      reason: "scan-incomplete",
      message: `Sanitization of ${task.taskId} did not finish: the structural budget (${structuralExhausted.budgetMs}ms) ran out at the "${structuralExhausted.rule}" rule. Text that was not fully swept is not clean text, so publication is refused.`,
      residues: [],
      report
    }
  }

  if (privacy.aborted) {
    return {
      ok: false,
      reason: "scan-incomplete",
      message: `Sanitization of ${task.taskId} did not finish: the [privacy] pattern budget (${privacy.aborted.budgetMs}ms) ran out while evaluating patterns[${privacy.aborted.patternIndex}]. An unfinished scan is not a clean one, so publication is refused. Simplify that pattern or raise the budget.`,
      residues: [],
      report
    }
  }

  const sanitizedTexts = afterStructural.map((field, index) => {
    const replaced = privacy.texts[index]
    const text = replaced ?? field.text
    return { ...field, text, changed: field.changed || text !== fields[index].text }
  })

  // Fail-closed re-scan of exactly what would be published.
  const residues: SanitizeResidue[] = []
  const publishedTexts: FieldText[] = []
  for (const field of sanitizedTexts) {
    // A link that had to be rewritten is not published at all: a URL whose
    // host or path became a token is no longer a link, just a broken one.
    if (field.kind === "link" && field.changed) continue
    publishedTexts.push({ field: field.field, text: field.text, kind: field.kind })
  }
  for (const field of publishedTexts) residues.push(...findStructuralResidues(field.field, field.text))

  const rescan = scanForPrivacyPatterns(
    Object.fromEntries(publishedTexts.map(field => [field.field, field.text])),
    compiled,
    { budgetMs }
  )
  for (const finding of rescan.findings) {
    residues.push({ field: finding.fieldPath, category: "privacy-pattern", occurrences: 1, patternIndex: finding.patternIndex })
  }
  if (rescan.aborted) {
    return {
      ok: false,
      reason: "scan-incomplete",
      message: `The verification pass over the sanitized text of ${task.taskId} did not finish (budget ${rescan.aborted.budgetMs}ms, patterns[${rescan.aborted.patternIndex}]); refusing to publish text that was not fully checked.`,
      residues,
      report: { ...report, aborted: rescan.aborted }
    }
  }
  if (residues.length > 0) {
    const named = residues.map(residue => `${residue.field} (${residue.category}${residue.patternIndex === undefined ? "" : ` patterns[${residue.patternIndex}]`})`).join(", ")
    return {
      ok: false,
      reason: "residual-match",
      message: `${task.taskId} still matches a sensitive pattern after sanitization and will not be published: ${named}. Fix the source text; the value is deliberately not reproduced here.`,
      residues,
      report
    }
  }

  const byField = new Map(sanitizedTexts.map(field => [field.field, field]))
  const textOf = (field: string, fallback: string): string => byField.get(field)?.text ?? fallback
  const sanitized: PublishableTask = {
    taskId: task.taskId,
    title: textOf("title", task.title),
    ...(task.body === undefined ? {} : { body: textOf("body", task.body) }),
    ...(task.summary === undefined ? {} : { summary: textOf("summary", task.summary) }),
    ...(task.criteria === undefined ? {} : {
      criteria: task.criteria.map(criterion => ({ id: criterion.id, text: textOf(`criteria[${criterion.id}]`, criterion.text) }))
    }),
    ...(task.links === undefined ? {} : {
      links: task.links
        .map((link, index) => byField.get(`links[${index}]`))
        .filter((field): field is NonNullable<typeof field> => field !== undefined && !field.changed)
        .map(field => field.text)
    }),
    ...(task.fields === undefined ? {} : {
      fields: Object.fromEntries(Object.keys(task.fields).map(name => [name, textOf(`fields.${name}`, (task.fields as Record<string, string>)[name])]))
    })
  }
  return { ok: true, task: sanitized, report }
}

export type DryRunEntry =
  | { taskId: string; publishable: true; report: SanitizeReport }
  | { taskId: string; publishable: false; reason: SanitizeRefusalReason; message: string; residues: SanitizeResidue[]; report: SanitizeReport }

export type DryRunReport = {
  entries: DryRunEntry[]
  publishable: number
  refused: number
  /** Per-category totals across every task in the run. */
  totals: Record<SanitizeCategory, number>
  /**
   * Whether the context-dependent category was checked at all. When false,
   * `refused` counts refusals for that very reason and NO task is
   * publishable -- read it before reading any other number (review ALTO-3).
   */
  privacyPatternsConfigured: boolean
  /** Operator declared the absent pattern list reviewed and intentional. */
  patternsReviewedAsAbsent: boolean
}

/**
 * What a publication run WOULD change, per task, with nothing published and
 * no sensitive value reproduced. This is the shape an operator reads before
 * letting the mirror touch a public repository.
 */
export function sanitizeDryRun(tasks: readonly PublishableTask[], options: SanitizeOptions = {}): DryRunReport {
  const entries: DryRunEntry[] = []
  const totals = emptyTotals()
  let publishable = 0
  let refused = 0
  for (const task of tasks) {
    const result = sanitizeTaskForPublication(task, options)
    for (const category of Object.keys(totals) as SanitizeCategory[]) totals[category] += result.report.totals[category]
    if (result.ok) {
      publishable++
      entries.push({ taskId: task.taskId, publishable: true, report: result.report })
      continue
    }
    refused++
    entries.push({
      taskId: task.taskId,
      publishable: false,
      reason: result.reason,
      message: result.message,
      residues: result.residues,
      report: result.report
    })
  }
  return {
    entries,
    publishable,
    refused,
    totals,
    // Same correction as the per-task gate (ALTO-4): effective, not supplied.
    privacyPatternsConfigured: compilePrivacyPatterns(options.privacyPatterns ?? []).regexes.length > 0,
    patternsReviewedAsAbsent: options.patternsReviewedAsAbsent === true
  }
}
