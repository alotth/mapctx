import * as fs from "fs"

export type TaskDetailFile = {
  id: string
  role: string
  impact: string
  estimatedEffort: string
  /** Absent fields predate T-099 and retain their human-pace meaning. */
  estimatedEffortSource?: "agent-active" | "legacy-human"
  waitReason?: "review" | "decision" | "parked" | "blocked-external"
  prerequisites: string[]
  blocking: string[]
  filesAffected: string[]
  testsRequired: string[]
  summary: string
  description: string
}

export type AcceptanceChecklistItem = {
  text: string
  completed: boolean
}

export type AcceptanceChecklist = {
  found: boolean
  items: AcceptanceChecklistItem[]
}

const TOP_LEVEL_FIELD_RE = /^  - ([A-Za-z][A-Za-z0-9]*):\s*(.*)$/
const DESCRIPTION_INDENT = "      "

function parseArray(value: string): string[] {
  const match = value.trim().match(/^\[(.*)\]$/)
  if (!match) return []
  const inner = match[1].trim()
  if (!inner) return []
  return inner.split(",").map(item => item.trim()).filter(Boolean)
}

function toArrayString(items: string[]): string {
  if (!items || items.length === 0) return "[]"
  return `[${items.join(", ")}]`
}

function stripDescriptionIndent(line: string): string {
  if (line.startsWith(DESCRIPTION_INDENT)) return line.slice(DESCRIPTION_INDENT.length)
  if (line.trim() === "") return ""
  return line
}

export function parseTaskDetailFile(content: string): TaskDetailFile {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")

  let id = ""
  let role = ""
  let impact = ""
  let estimatedEffort = ""
  let estimatedEffortSource: TaskDetailFile["estimatedEffortSource"]
  let waitReason: TaskDetailFile["waitReason"]
  let prerequisites: string[] = []
  let blocking: string[] = []
  let filesAffected: string[] = []
  let testsRequired: string[] = []
  let summary = ""
  const descriptionLines: string[] = []

  let inDescription = false
  let seenHeading = false

  for (const line of lines) {
    if (!seenHeading) {
      const trimmed = line.trim()
      if (trimmed.startsWith("# ")) {
        id = trimmed.slice(2).trim()
        seenHeading = true
      }
      continue
    }

    if (inDescription) {
      if (TOP_LEVEL_FIELD_RE.test(line)) {
        inDescription = false
      } else {
        descriptionLines.push(stripDescriptionIndent(line))
        continue
      }
    }

    const m = line.match(TOP_LEVEL_FIELD_RE)
    if (!m) continue
    const key = m[1]
    const value = m[2]

    switch (key) {
      case "role":
        role = value.trim()
        break
      case "impact":
        impact = value.trim()
        break
      case "estimatedEffort":
        estimatedEffort = value.trim()
        break
      case "estimatedEffortSource":
        {
          const source = value.trim()
          if (source === "agent-active" || source === "legacy-human") {
            estimatedEffortSource = source
          }
        }
        break
      case "waitReason":
        if (value.trim() && !["review", "decision", "parked", "blocked-external"].includes(value.trim())) throw new Error(`Invalid waitReason: ${value.trim()}`)
        if (value.trim()) waitReason = value.trim() as TaskDetailFile["waitReason"]
        break
      case "prerequisites":
        prerequisites = parseArray(value)
        break
      case "blocking":
        blocking = parseArray(value)
        break
      case "filesAffected":
        filesAffected = parseArray(value)
        break
      case "testsRequired":
        testsRequired = parseArray(value)
        break
      case "summary":
        summary = value.trim()
        break
      case "description":
        inDescription = true
        break
      default:
        break
    }
  }

  while (descriptionLines.length > 0 && descriptionLines[descriptionLines.length - 1] === "") {
    descriptionLines.pop()
  }

  return {
    id,
    role,
    impact,
    estimatedEffort,
    estimatedEffortSource,
    waitReason,
    prerequisites,
    blocking,
    filesAffected,
    testsRequired,
    summary,
    description: descriptionLines.join("\n")
  }
}

export function generateTaskDetailFile(detail: TaskDetailFile): string {
  const out: string[] = []
  out.push(`# ${detail.id}`)
  out.push("")
  out.push(`  - role: ${detail.role}`)
  out.push(`  - impact: ${detail.impact}`)
  out.push(`  - estimatedEffort: ${detail.estimatedEffort}`)
  // Legacy is intentionally represented by absence so historic detail files
  // round-trip byte-for-byte. New agent-active estimates are explicit.
  if (detail.estimatedEffortSource === "agent-active") {
    out.push("  - estimatedEffortSource: agent-active")
  }
  if (detail.waitReason) out.push(`  - waitReason: ${detail.waitReason}`)
  out.push(`  - prerequisites: ${toArrayString(detail.prerequisites)}`)
  out.push(`  - blocking: ${toArrayString(detail.blocking)}`)
  out.push(`  - filesAffected: ${toArrayString(detail.filesAffected)}`)
  out.push(`  - testsRequired: ${toArrayString(detail.testsRequired)}`)
  out.push(`  - summary: ${detail.summary}`)
  out.push("  - description: |")
  const descriptionLines = detail.description.split("\n")
  for (const line of descriptionLines) {
    out.push(line === "" ? "" : `${DESCRIPTION_INDENT}${line}`)
  }

  return `${out.join("\n")}\n`
}

export function readTaskDetailFile(filePath: string): TaskDetailFile {
  return parseTaskDetailFile(fs.readFileSync(filePath, "utf8"))
}

/**
 * Read the acceptance checklist from the Git-authored description. Nested
 * headings are valid inside `## Acceptance`; a sibling `##` heading ends it.
 * Plain bullets are intentionally treated as incomplete: completion must be
 * explicit via `[x]`, never inferred from prose or an Outcome paragraph.
 *
 * Fence handling is the shared `analyzeAcceptanceProse` tokenizer (review
 * N1): fenced lines are opaque to section and bullet detection.
 */
export function parseAcceptanceChecklist(content: string): AcceptanceChecklist {
  const analysis = analyzeAcceptanceProse(content)
  return { found: analysis.found, items: analysis.items }
}

/**
 * Code-fence subset (NOT full CommonMark) shared by
 * `parseAcceptanceChecklist` and `stripAcceptanceSection` so the two can
 * never diverge (review N1):
 *
 * - a fence OPENS on a line whose first non-whitespace characters are a run
 *   of >= 3 backticks or >= 3 tildes; the rest of the line is the info
 *   string. A BACKTICK fence's info string must not contain a backtick, so
 *   an inline span like ```code``` is prose, never a fence opener.
 * - a fence CLOSES on a line whose first non-whitespace characters are a
 *   run of the SAME character with length >= the opening run, followed by
 *   nothing but whitespace (no info string on closers).
 * - INDENT INSENSITIVE (deliberate deviation from CommonMark's 0-3 space
 *   rule): the detail-file description block is indented (6 spaces in raw
 *   detail bytes), so fence recognition keys on the first non-whitespace
 *   character. A deep-indented fence must stay a fence -- treating it as
 *   indented code would resurrect fenced headings as real sections
 *   (review N1 "naive <=3 spaces" hazard). Any other fence syntax
 *   (mismatched characters, closers with trailing text) is NOT recognized;
 *   such markup is prose.
 *
 * Everything between opener and closer is opaque: no section can start or
 * end and no bullet can be an acceptance criterion inside a fence.
 */
type FenceInfo = { char: string; length: number }

function fenceOpener(line: string): FenceInfo | null {
  const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) return null
  const run = match[1]
  const char = run[0]
  const info = match[2]
  // CommonMark rule: a backtick fence's info string cannot contain backticks.
  if (char === "`" && info.includes("`")) return null
  return { char, length: run.length }
}

function fenceCloser(line: string, open: FenceInfo): boolean {
  const pattern = "^\\s*" + open.char + "{" + open.length + ",}[ \\t]*$"
  return new RegExp(pattern).test(line)
}

export type AcceptanceProseAnalysis = {
  /** Lines outside every real `## Acceptance` section, in original order (trailing blank lines trimmed). */
  keptLines: string[]
  /** Checklist items of the FIRST real Acceptance section (parse semantics: scanning stops at its end). */
  items: AcceptanceChecklistItem[]
  /** Whether a real Acceptance heading exists. */
  found: boolean
  /**
   * True when a fence OPENED OUTSIDE a real Acceptance section and was never
   * closed. The canonical section cannot then be re-inserted behind a safe
   * boundary without either swallowing prose or inventing a closing fence;
   * renderers must refuse (see `acceptance-render-refused` in export/push).
   * An unclosed fence that started INSIDE a section is dropped together with
   * that section and is not ambiguous.
   */
  unterminatedFence: boolean
}

/** The one prose walk that parse and strip share (review N1). */
export function analyzeAcceptanceProse(prose: string): AcceptanceProseAnalysis {
  const lines = prose.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  const keptLines: string[] = []
  const items: AcceptanceChecklistItem[] = []
  let sectionLevel: number | null = null
  let everFound = false
  let itemsClosed = false
  let open: FenceInfo | null = null
  let openStartedOutsideSection = false
  let unterminated = false

  for (const line of lines) {
    if (open) {
      if (fenceCloser(line, open)) {
        open = null
        // A closer of a fence that started outside a section is prose like
        // any other line; dropping it would make strip non-idempotent (the
        // re-run would see an unpaired opener).
        if (sectionLevel === null) keptLines.push(line)
      } else if (sectionLevel === null) keptLines.push(line)
      continue
    }
    const opener = fenceOpener(line)
    if (opener) {
      open = opener
      openStartedOutsideSection = sectionLevel === null
      if (sectionLevel === null) keptLines.push(line)
      continue
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/)
    if (heading) {
      const level = heading[1].length
      const title = heading[2].trim().toLowerCase()
      if (sectionLevel !== null) {
        if (level <= sectionLevel) {
          sectionLevel = null
          itemsClosed = true
          if (title === "acceptance") {
            sectionLevel = level
            everFound = true
            continue
          }
          keptLines.push(line)
        }
        continue
      }
      if (title === "acceptance") {
        sectionLevel = level
        everFound = true
        continue
      }
      keptLines.push(line)
      continue
    }
    if (sectionLevel === null) {
      keptLines.push(line)
      continue
    }
    if (!itemsClosed) {
      const bullet = line.match(/^\s*[-*+]\s+(?:(\[([ xX])\])\s+)?(.+?)\s*$/)
      if (bullet) {
        items.push({
          text: bullet[3].trim(),
          completed: bullet[1] !== undefined && bullet[2].toLowerCase() === "x"
        })
      }
    }
  }
  if (open && openStartedOutsideSection) unterminated = true
  while (keptLines.length > 0 && keptLines[keptLines.length - 1] === "") keptLines.pop()
  return { keptLines, items, found: everFound, unterminatedFence: unterminated }
}

/**
 * Removes EVERY real `## Acceptance` section (any heading level; nested
 * headings stay in scope, a sibling heading at or above its level ends it)
 * from description prose. Used by the store-authority export and GitHub
 * push, which render the section from canonical store state instead of
 * mirroring prose.
 *
 * Implemented by the shared `analyzeAcceptanceProse` tokenizer, so parse and
 * strip can never disagree about fences (review N1). Git-authored prose
 * outside the real section -- design notes, fenced examples in any
 * supported fence form, sibling sections -- survives byte-for-byte.
 */
export function stripAcceptanceSection(prose: string): string {
  return analyzeAcceptanceProse(prose).keptLines.join("\n")
}

/**
 * True when the prose opens a code fence outside a real Acceptance section
 * and never closes it. Export and push REFUSE to render canonical Acceptance
 * over such prose (there is no safe insertion boundary), instead of
 * swallowing prose or growing the file on every pass.
 */
export function hasUnterminatedFence(prose: string): boolean {
  return analyzeAcceptanceProse(prose).unterminatedFence
}

/**
 * Renders the store-owned acceptance mirror. The guard comment marks the
 * section as generated: hand edits here are overwritten by the next export,
 * and the authoritative route is `mapctx task acceptance`. The comment is
 * ignored by parseAcceptanceChecklist.
 */
export function renderAcceptanceSection(items: AcceptanceChecklistItem[], revision: number): string {
  const out: string[] = []
  out.push("## Acceptance")
  out.push("")
  out.push(`<!-- mapctx:store-owned acceptance revision ${revision}; generated by export; revise via \`mapctx task acceptance\` -->`)
  // The blank separator matches the in-place render's preamble shape, so a
  // section appended where no real section existed renders identically on
  // the next pass (T-121 idempotency).
  out.push("")
  for (const item of items) {
    out.push(`- [${item.completed ? "x" : " "}] ${item.text}`)
  }
  return out.join("\n")
}

/**
 * T-121 ownership boundary inside a real Acceptance section:
 *
 * - MANAGED (store-owned, replaced by the canonical render): checkbox
 *   bullets, the generated guard comment, and plain bullets whose text
 *   matches a current canonical criterion exactly (trim-normalized, the
 *   same normalization the legacy import parser applies). A criterion is
 *   consumed once: a later duplicate line stays Git-authored prose, so a
 *   duplicated criterion is never rendered twice.
 * - AUTHORED (Git-owned, preserved byte-for-byte in place): notes,
 *   evidence, links, nested headings, fenced examples, blank lines, and
 *   every plain bullet that matches no current criterion (an authored
 *   `- Evidência: ...` list survives even though the legacy import would
 *   have read such bullets as criteria).
 *
 * A managed checkbox bullet that matches no current criterion is dropped:
 * the section is store-owned and its text lives in the store's acceptance
 * revision history. Canonical state always wins over the stale mirror.
 */
const GUARD_PREFIX = "<!-- mapctx:store-owned acceptance revision"

function bulletOf(line: string): { checkbox: boolean; text: string } | null {
  const match = /^\s*[-*+]\s+(?:(\[([ xX])\])\s+)?(.+?)\s*$/.exec(line)
  if (!match) return null
  return { checkbox: match[1] !== undefined, text: match[3].trim() }
}

/**
 * Why `renderAcceptanceProse` cannot safely publish this prose, or null.
 * Shared by export and push so both refuse at the same boundary:
 *
 * - a code fence still open at end of prose (wherever it opened): the
 *   in-place render would classify every following real heading as fence
 *   content, silently swallowing the rest of the document into the
 *   Acceptance section;
 * - more than one real Acceptance section: the canonical criteria target
 *   would be ambiguous (the import parser reads only the first). Remedy:
 *   merge the sections into one before publishing.
 */
export function acceptanceRenderObstruction(prose: string): string | null {
  const lines = prose.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  let open: FenceInfo | null = null
  let sectionLevel: number | null = null
  let sections = 0
  for (const line of lines) {
    if (open) {
      if (fenceCloser(line, open)) open = null
      continue
    }
    const opener = fenceOpener(line)
    if (opener) {
      open = opener
      continue
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/)
    if (!heading) continue
    const level = heading[1].length
    const title = heading[2].trim().toLowerCase()
    if (sectionLevel !== null) {
      if (level > sectionLevel) continue
      sectionLevel = null
    }
    if (title === "acceptance") {
      sectionLevel = level
      sections++
    }
  }
  if (open) {
    return "prose opens a code fence that is never closed, so the in-place render has no safe classification boundary. Close the fence (or remove the stray fence opener) in the Git-authored detail prose, then retry."
  }
  if (sections > 1) {
    return `prose contains ${sections} real Acceptance sections; the canonical criteria target is ambiguous. Merge them into a single Acceptance section in the Git-authored prose, then retry.`
  }
  return null
}

function renderCanonicalLine(item: AcceptanceChecklistItem, indent = ""): string {
  return `${indent}- [${item.completed ? "x" : " "}] ${item.text}`
}

type ClassifiedLine =
  | { kind: "authored"; line: string; blank: boolean }
  | { kind: "guard" }
  | { kind: "matched"; index: number; indent: string }
  | { kind: "staleCheckbox" }

/**
 * Classifies the section body for the canonical render (fence-aware, same
 * documented fence subset). Plain bullets that match no current criterion
 * are AUTHORED prose; checkbox bullets that match none are stale approval
 * markers owned by the store's revision history.
 */
function classifySectionBody(body: string[], items: AcceptanceChecklistItem[]): ClassifiedLine[] {
  const consumed: boolean[] = items.map(() => false)
  const entries: ClassifiedLine[] = []
  let bodyOpen: FenceInfo | null = null
  for (const line of body) {
    if (bodyOpen) {
      entries.push({ kind: "authored", line, blank: line.trim() === "" })
      if (fenceCloser(line, bodyOpen)) bodyOpen = null
      continue
    }
    const opener = fenceOpener(line)
    if (opener) {
      bodyOpen = opener
      entries.push({ kind: "authored", line, blank: line.trim() === "" })
      continue
    }
    if (line.trimStart().startsWith(GUARD_PREFIX)) {
      entries.push({ kind: "guard" })
      continue
    }
    const bullet = bulletOf(line)
    if (bullet) {
      const index = items.findIndex((item, i) => !consumed[i] && item.text === bullet.text)
      if (index >= 0) {
        consumed[index] = true
        entries.push({ kind: "matched", index, indent: (line.match(/^\s*/) ?? [""])[0] })
        continue
      }
      if (bullet.checkbox) {
        entries.push({ kind: "staleCheckbox" })
        continue
      }
    }
    entries.push({ kind: "authored", line, blank: line.trim() === "" })
  }
  return entries
}

/**
 * Renders canonical store acceptance INTO Git-authored description prose,
 * in place: the real Acceptance section keeps its position between sibling
 * sections and authored prose inside it keeps its line positions. Only
 * managed spans (see the ownership boundary above) are replaced by the
 * canonical render; matched bullets keep their authored indentation, so a
 * matched nested criterion stays attached to its parent.
 *
 * Canonical ORDER is authoritative. When the prose already carries the
 * canonical sequence (ascending, complete) the render stays in place so
 * criterion-note association and parentage survive. Otherwise — reordered
 * criteria or criteria missing from the prose — the full canonical
 * sequence renders at the first managed bullet position, keeping authored
 * prefaces (before the first managed bullet) anchored: a preface has no
 * criterion association to lose. Authored prose AFTER the first managed
 * bullet (interleaved or trailing) cannot be re-anchored reliably when the
 * sequence changes, so that shape refuses instead of relocating.
 *
 * REFUSES before publication (`acceptance-render-refused`) when:
 * - the prose has an obstruction (unclosed code fence anywhere, multiple
 *   real Acceptance sections) — see `acceptanceRenderObstruction`;
 * - a stale checkbox bullet (criterion removed or renamed) coexists with
 *   any authored line after the first criterion: dropping the marker would
 *   strand that prose on the wrong criterion. Remedy: a human preserves the
 *   Git-authored note and re-anchors or adjudicates it, for example by moving
 *   it to a Git-authored section outside Acceptance or explicitly linking it
 *   to a current criterion. Review canonical criteria separately when needed.
 *   Never delete evidence or restore a criterion only to make rendering
 *   succeed; associations are never synthesized and approval is never
 *   automatic;
 * - the canonical sequence differs (reorder or added criteria) while ANY
 *   non-blank authored line (note, evidence, plain list, fenced example,
 *   nested heading) follows the first managed bullet — interleaved or
 *   trailing — or bullets are hierarchical: rewriting the sequence would
 *   reassociate that prose (trailing prose has no reliable anchor once the
 *   block moves) or break bullet parentage, and no association is ever
 *   synthesized from prose language. Same remedy: a human re-anchors the
 *   Git-authored prose (or moves it out of the Acceptance section).
 *
 * When no real Acceptance section exists, the generated section is
 * appended after the prose (trailing blank lines trimmed), matching the
 * pre-T-121 shape. With an empty canonical item list no guard marker is
 * emitted: the section carries no generated content to own.
 *
 * Deterministic and idempotent: same prose + same canonical state always
 * yields byte-identical output, so repeated export/checkpoint/push never
 * grows or duplicates the section.
 */
export function renderAcceptanceProse(prose: string, items: AcceptanceChecklistItem[], revision: number): string {
  const obstruction = acceptanceRenderObstruction(prose)
  if (obstruction) {
    throw new Error(`acceptance-render-refused: ${obstruction}`)
  }
  const lines = prose.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")

  // Locate the single real section (fence-aware, same subset as the
  // tokenizer above). The obstruction check guarantees at most one.
  let open: FenceInfo | null = null
  let sectionLevel: number | null = null
  let sectionStart = -1
  let sectionEnd = lines.length
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (open) {
      if (fenceCloser(line, open)) open = null
      continue
    }
    const opener = fenceOpener(line)
    if (opener) {
      open = opener
      continue
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/)
    if (!heading) continue
    const level = heading[1].length
    const title = heading[2].trim().toLowerCase()
    if (sectionLevel !== null) {
      if (level > sectionLevel) continue
      sectionLevel = null
      sectionEnd = i
    }
    if (title === "acceptance") {
      sectionLevel = level
      sectionStart = i
      sectionEnd = lines.length
    }
  }

  if (sectionStart < 0) {
    // No real section: append the generated section (pre-T-121 shape).
    const kept = [...lines]
    while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop()
    const rendered = renderAcceptanceSection(items, revision)
    return kept.length === 0 ? rendered : `${kept.join("\n")}\n\n${rendered}`
  }

  // Leading blank lines of the body are normalized away (the preamble
  // supplies exactly one separator), which keeps the render idempotent.
  const body = lines.slice(sectionStart + 1, sectionEnd)
  while (body.length > 0 && body[0].trim() === "") body.shift()
  const entries = classifySectionBody(body, items)

  // Structural facts driving the conservative refusals. Only non-blank
  // authored lines count as association anchors; blank lines are seams.
  let firstBulletAt = -1
  let unmatchedCheckbox = false
  let authoredAfterFirstBullet = false
  let hierarchical = false
  const proseOrder: number[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.kind === "matched") {
      if (firstBulletAt < 0) firstBulletAt = i
      proseOrder.push(entry.index)
      if (entry.indent !== "") hierarchical = true
    } else if (entry.kind === "staleCheckbox") {
      if (firstBulletAt < 0) firstBulletAt = i
      unmatchedCheckbox = true
    } else if (entry.kind === "authored" && !entry.blank && firstBulletAt >= 0) {
      authoredAfterFirstBullet = true
    }
  }

  const consumedSet = new Set(proseOrder)
  const orderDiffers = proseOrder.some((index, position) => index !== position)
  const missing = items.map((_, i) => i).filter(i => !consumedSet.has(i))

  if (unmatchedCheckbox && authoredAfterFirstBullet) {
    throw new Error(
      "acceptance-render-refused: the section carries a checkbox bullet that matches no current criterion (removed or renamed) next to authored prose after the first criterion; dropping the marker would strand that prose on the wrong criterion. " +
      "Render is refused before any write. A human must preserve and adjudicate the Git-authored prose: re-anchor the note to a current criterion or move it to a Git-authored section outside Acceptance. Review canonical criteria separately when needed; never delete evidence or restore a criterion only to make rendering succeed. Associations are never synthesized."
    )
  }
  if ((orderDiffers || missing.length > 0) && (authoredAfterFirstBullet || hierarchical)) {
    throw new Error(
      "acceptance-render-refused: the canonical criteria sequence differs from the prose (reorder or added criteria) while authored prose follows the first criterion (interleaved or trailing: notes, evidence, plain lists, fenced examples, nested headings) or bullets are hierarchical; rewriting the sequence would reassociate that prose or break bullet parentage, and the renderer never synthesizes associations — trailing prose has no reliable anchor after the block moves. " +
      "Render is refused before any write. A human must adjudicate the Git-authored prose (re-anchor the notes to criteria that exist or move them out of the Acceptance section), then retry."
    )
  }

  let content: string[]
  if (orderDiffers || missing.length > 0) {
    // Canonical order wins. Authored prefaces (before the first managed
    // bullet) have no criterion association to lose and keep their
    // position; the full canonical sequence renders at the first managed
    // bullet position. Authored prose AFTER the first managed bullet was
    // refused above — nothing non-blank can trail here — so this branch
    // never relocates authored text behind a different criterion.
    const canonicalSequence = items.map(item => renderCanonicalLine(item))
    const preface: string[] = []
    if (firstBulletAt < 0) {
      // No managed bullet anchors the section: the body is authored-only
      // prose. It stays in place and the canonical sequence appends AFTER
      // it, so the prose is never presented as trailing evidence of the
      // last criterion.
      for (const entry of entries) {
        if (entry.kind === "authored") preface.push(entry.line)
      }
    } else {
      for (const entry of entries.slice(0, firstBulletAt)) {
        if (entry.kind === "authored") preface.push(entry.line)
      }
    }
    while (preface.length > 0 && preface[preface.length - 1].trim() === "") preface.pop()
    content = [...preface, ...canonicalSequence]
  } else {
    // Pure in-place render: matched bullets are replaced at their positions
    // (authored indentation preserved), stale checkboxes are dropped, and
    // every authored line stays verbatim.
    content = []
    for (const entry of entries) {
      if (entry.kind === "authored") content.push(entry.line)
      else if (entry.kind === "matched") content.push(renderCanonicalLine(items[entry.index], entry.indent))
    }
  }
  while (content.length > 0 && content[0].trim() === "") content.shift()

  // Exactly one blank separates guard from section content; nothing follows
  // the guard when the section carries no rendered lines, which keeps the
  // empty-section shape byte-stable across renders. An empty canonical item
  // list emits no guard: there is no generated content to mark as owned.
  const parts: string[] = [lines[sectionStart]]
  const guard = `<!-- mapctx:store-owned acceptance revision ${revision}; generated by export; revise via \`mapctx task acceptance\` -->`
  if (items.length > 0) parts.push("", guard)
  if (content.length > 0) parts.push("", ...content)
  return [...lines.slice(0, sectionStart), ...parts, ...lines.slice(sectionEnd)].join("\n")
}

/**
 * Renders prose for a task with NO canonical acceptance revision authority.
 * The real Acceptance section (if any) is Git-authored content: authored
 * notes, plain bullets, nested headings and fenced examples are preserved
 * verbatim in place. No criteria, no guard marker, no invented section —
 * the store has nothing canonical to publish.
 *
 * REFUSES before publication when the section carries checkbox bullets:
 * they are stale approval markers that must neither be published as if
 * canonical nor silently deleted as authored prose. Remedy: a human
 * adjudicates the checkbox and its surrounding notes, either adopting the
 * criterion explicitly (`mapctx acceptance import` / `mapctx task acceptance
 * revise`) or preserving the full record in a Git-authored section outside
 * Acceptance, with evidence re-anchored. Never discard associated evidence
 * to make publication succeed.
 */
export function renderAcceptanceProseUnowned(prose: string): string {
  const obstruction = acceptanceRenderObstruction(prose)
  if (obstruction) {
    throw new Error(`acceptance-render-refused: ${obstruction}`)
  }
  const lines = prose.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")

  let open: FenceInfo | null = null
  let sectionLevel: number | null = null
  let sectionStart = -1
  let sectionEnd = lines.length
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (open) {
      if (fenceCloser(line, open)) open = null
      continue
    }
    const opener = fenceOpener(line)
    if (opener) {
      open = opener
      continue
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/)
    if (!heading) continue
    const level = heading[1].length
    const title = heading[2].trim().toLowerCase()
    if (sectionLevel !== null) {
      if (level > sectionLevel) continue
      sectionLevel = null
      sectionEnd = i
    }
    if (title === "acceptance") {
      sectionLevel = level
      sectionStart = i
      sectionEnd = lines.length
    }
  }
  if (sectionStart < 0) return lines.join("\n")

  const body = lines.slice(sectionStart + 1, sectionEnd)
  const content: string[] = []
  let bodyOpen: FenceInfo | null = null
  for (const line of body) {
    if (bodyOpen) {
      content.push(line)
      if (fenceCloser(line, bodyOpen)) bodyOpen = null
      continue
    }
    const opener = fenceOpener(line)
    if (opener) {
      bodyOpen = opener
      content.push(line)
      continue
    }
    if (line.trimStart().startsWith(GUARD_PREFIX)) continue
    const bullet = bulletOf(line)
    if (bullet && bullet.checkbox) {
      throw new Error(
        "acceptance-render-refused: the prose carries an Acceptance section with checkbox bullets but the store holds no canonical acceptance revision for the task; the checkboxes are stale markers that must neither be published as canonical state nor silently deleted. " +
        "Publish is refused before any remote write. A human must adjudicate each checkbox with its surrounding notes: explicitly adopt intended criteria (`mapctx acceptance import` or `mapctx task acceptance revise`), or preserve the complete record in a Git-authored section outside Acceptance and re-anchor its evidence. Never discard associated evidence just to make publication succeed."
      )
    }
    content.push(line)
  }
  // Verbatim body (minus dropped guards): unowned prose is Git content and
  // is never reflowed.
  return [...lines.slice(0, sectionStart), lines[sectionStart], ...content, ...lines.slice(sectionEnd)].join("\n")
}
