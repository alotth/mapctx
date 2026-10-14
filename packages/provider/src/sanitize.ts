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
 *   - paths must start at `/Users`, `/home`, `/root`, a Windows drive, or `~/`
 *     -- `packages/...` and `docs/...` are untouched;
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
 *     belongs in `[privacy] patterns`, where the operator can name it.
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
  | "email"
  | "private-host"
  | "privacy-pattern"

export const SANITIZE_TOKENS = {
  "artifact-link": "<internal-artifact>",
  "absolute-path": "<local-path>",
  "internal-id": "<internal-id>",
  email: "<email>",
  "private-host": "<host>",
  "privacy-pattern": "<redacted>"
} as const satisfies Record<SanitizeCategory, string>

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
  /** Set when the privacy budget ran out; the task is refused when it is. */
  aborted?: PrivacyScanAbort
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

export type SanitizeRefusalReason = "residual-match" | "scan-incomplete"

export type SanitizeResult =
  | { ok: true; task: PublishableTask; report: SanitizeReport }
  | { ok: false; reason: SanitizeRefusalReason; message: string; residues: SanitizeResidue[]; report: SanitizeReport }

export type SanitizeOptions = {
  /** `[privacy] patterns` from mapctx.toml, as the lint reads them. */
  privacyPatterns?: readonly string[]
  /** Wall-clock ceiling for the untrusted privacy regexes. */
  budgetMs?: number
}

type StructuralCategory = Exclude<SanitizeCategory, "privacy-pattern">

type StructuralRule = {
  category: StructuralCategory
  regex: RegExp
  /** Token for one match. A rule may keep a safe capture (the artifact slug). */
  tokenFor: (match: RegExpExecArray) => string
}

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
    // An optional path-ish prefix (never bracket or paren, so a Markdown
    // `[text](...)` keeps its syntax), then the epic/artifact shape itself.
    regex: /[A-Za-z0-9._~:\\/-]*epics\/[0-9a-fA-F][0-9a-fA-F-]{7,}\/artifacts\/([A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._-]+)*/g,
    tokenFor: match => `<internal-artifact:${match[1]}>`
  },
  {
    category: "absolute-path",
    regex: /(?:\/Users|\/home|\/root)(?:\/[^\s"'`)\]<>]+)+/g,
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
    category: "email",
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    tokenFor: () => SANITIZE_TOKENS.email
  },
  {
    category: "private-host",
    regex: /\b[A-Za-z0-9][A-Za-z0-9-]*\.(?:local|lan|internal|home\.arpa)\b/g,
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

type StructuralOutcome = { text: string; hits: Array<{ category: StructuralCategory; occurrences: number }> }

function applyStructuralRules(text: string): StructuralOutcome {
  const perCategory = new Map<StructuralCategory, number>()
  let current = text
  for (const rule of STRUCTURAL_RULES) {
    // A fresh regex per application: the shared literal carries `g`, so its
    // `lastIndex` would otherwise leak between fields.
    const regex = new RegExp(rule.regex.source, rule.regex.flags)
    current = current.replace(regex, (...args) => {
      const match = args.slice(0, -2) as unknown as RegExpExecArray
      if (match[0].length === 0) return match[0]
      perCategory.set(rule.category, (perCategory.get(rule.category) ?? 0) + 1)
      return rule.tokenFor(match)
    })
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
    email: 0,
    "private-host": 0,
    "privacy-pattern": 0
  }
}

/** Structural residues in one already-sanitized string. */
function structuralResidues(field: string, text: string): SanitizeResidue[] {
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
  const compiled: CompiledPrivacyPatterns = compilePrivacyPatterns(options.privacyPatterns ?? [])
  const fields = collectFields(task)
  const substitutions: SanitizeSubstitution[] = []
  const totals = emptyTotals()

  const afterStructural = fields.map(field => {
    const outcome = applyStructuralRules(field.text)
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
    ...(privacy.aborted ? { aborted: privacy.aborted } : {})
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
  for (const field of publishedTexts) residues.push(...structuralResidues(field.field, field.text))

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
  return { entries, publishable, refused, totals }
}
