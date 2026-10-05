import assert from "node:assert/strict"
import test from "node:test"
import { parseAcceptanceChecklist, stripAcceptanceSection, hasUnterminatedFence, analyzeAcceptanceProse } from "@mapctx/core"
import { parseAcceptanceRead } from "./acceptance"

const BT = "```"
const BT3 = "```"
const BT4 = "````"
const REAL = "## Acceptance\n- [ ] Canonical actual criterion"

test("N1: tilde fence content is opaque; only the real section is stripped; tail survives", () => {
  const prose = "Intro\n~~~md\n## Acceptance\n- [x] tilde example\n~~~\nKEEP TILDE TAIL.\n\n" + REAL
  assert.deepEqual(parseAcceptanceChecklist(prose).items, [{ text: "Canonical actual criterion", completed: false }])
  const stripped = stripAcceptanceSection(prose)
  assert.ok(stripped.includes("KEEP TILDE TAIL."))
  assert.ok(stripped.includes("tilde example"))
  assert.ok(!stripped.includes("Canonical actual criterion"))
  assert.equal(hasUnterminatedFence(prose), false)
})

test("N1: four-backtick fence wraps triple-backtick lines; closes only on a >= run", () => {
  const prose = "Intro\n" + BT4 + "md\n" + BT3 + "\n## Acceptance\n" + BT3 + "\n" + BT4 + "\nKEEP FOUR TAIL.\n\n" + REAL
  assert.deepEqual(parseAcceptanceChecklist(prose).items, [{ text: "Canonical actual criterion", completed: false }])
  const stripped = stripAcceptanceSection(prose)
  assert.ok(stripped.includes("KEEP FOUR TAIL."))
  assert.ok(stripped.includes("## Acceptance"), "fenced inner heading stays in kept prose")
  assert.equal(hasUnterminatedFence(prose), false)
})

test("N1: inline triple-backtick span is prose, never a fence opener", () => {
  const prose = "Use it like:\n" + BT3 + "npm test" + BT3 + "\nKEEP AFTER INLINE.\n\n" + REAL
  assert.equal(hasUnterminatedFence(prose), false)
  assert.deepEqual(parseAcceptanceChecklist(prose).items, [{ text: "Canonical actual criterion", completed: false }])
  const stripped = stripAcceptanceSection(prose)
  assert.ok(stripped.includes("KEEP AFTER INLINE."))
  assert.ok(stripped.includes(BT3 + "npm test" + BT3))
})

test("N1: closers need the same character, a >= run, and only whitespace after", () => {
  // mismatched characters never close
  const mismatch = "Intro\n" + BT3 + "md\ncontent\n~~~\nKEEP MISMATCH TAIL.\n"
  assert.equal(hasUnterminatedFence(mismatch), true)
  // trailing text after the run disqualifies a closer
  const trailing = "Intro\n" + BT3 + "md\ncontent\n" + BT3 + " text\nKEEP TRAILING TAIL.\n"
  assert.equal(hasUnterminatedFence(trailing), true)
  // a longer run of the same character closes
  const longer = "Intro\n" + BT3 + "md\ncontent\n" + BT4 + "\nKEEP LONGER TAIL.\n\n" + REAL
  assert.equal(hasUnterminatedFence(longer), false)
  assert.ok(stripAcceptanceSection(longer).includes("KEEP LONGER TAIL."))
})

test("N1: indented (<=3 spaces) fences open and close; CRLF is normalized", () => {
  const indented = "Intro\n  " + BT3 + "md\n## Acceptance\n- [ ] indented example\n  " + BT3 + "\nKEEP INDENT TAIL.\n\n" + REAL
  assert.equal(hasUnterminatedFence(indented), false)
  assert.deepEqual(parseAcceptanceChecklist(indented).items, [{ text: "Canonical actual criterion", completed: false }])
  assert.ok(stripAcceptanceSection(indented).includes("KEEP INDENT TAIL."))

  const crlf = "## Design\r\nKEEP CRLF.\r\n\r\n~~~md\r\n## Acceptance\r\n- [ ] fenced\r\n~~~\r\nKEEP TILDE TAIL.\r\n\r\n" + REAL.replace(/\n/g, "\r\n")
  assert.deepEqual(parseAcceptanceChecklist(crlf).items, [{ text: "Canonical actual criterion", completed: false }])
  const stripped = stripAcceptanceSection(crlf)
  assert.ok(stripped.includes("KEEP TILDE TAIL."))
  assert.ok(stripped.includes("KEEP CRLF."))
})

test("N1: unclosed fence in KEPT prose is flagged; unclosed fence inside the section is not", () => {
  const outside = "Intro\n" + BT3 + "md\nunclosed example\n\n## Acceptance\n- [ ] Canonical actual criterion\n\n## Notes\nKEEP NOTES."
  assert.equal(hasUnterminatedFence(outside), true)
  // Everything after the opener is fenced, so parse sees no real section.
  assert.equal(parseAcceptanceChecklist(outside).found, false)

  const insideSection = "Intro\n\n## Acceptance\n- [ ] Canonical actual criterion\n" + BT3 + "md\nnever closed"
  assert.equal(hasUnterminatedFence(insideSection), false, "the fence disappears with the removed section")
  assert.deepEqual(parseAcceptanceChecklist(insideSection).items, [{ text: "Canonical actual criterion", completed: false }])
  assert.equal(stripAcceptanceSection(insideSection), "Intro")
})

test("N1: strip is idempotent and parse finds nothing acceptance-like after stripping fenced examples", () => {
  const cases = [
    "Intro\n~~~md\n## Acceptance\n- [x] a\n~~~\nTAIL\n\n" + REAL,
    "Intro\n" + BT4 + "\n## Acceptance\n" + BT4 + "\nTAIL\n\n" + REAL,
    "Use ```code``` inline.\nTAIL\n\n" + REAL,
    "## Design\n" + BT3 + "markdown\n## Acceptance\n- [x] Example ONLY\n" + BT3 + "\n\n" + REAL + "\n\n## Notes\nKEEP NOTES."
  ]
  for (const prose of cases) {
    const once = stripAcceptanceSection(prose)
    assert.equal(stripAcceptanceSection(once), once, "idempotent: " + prose.slice(0, 30))
    const parsed = parseAcceptanceChecklist(once)
    assert.equal(parsed.found, false, "nothing left to parse: " + prose.slice(0, 30))
  }
})

test("N1: parse/strip agreement over a deterministic mixed corpus vs an independent reference", () => {
  const vocab = ["", "text line", "## Acceptance", "### Acceptance", "# Acceptance", "## Other", "### Sub", "- [ ] item", "- [x] done", BT3, BT3 + "md", "~~~", "  " + BT3, "  ~~~", BT4, BT3 + "npm test" + BT3, "~~~ tilde info ~~~", BT3 + " trailing text", "## ACCEPTANCE"]
  // Independent reference implementing exactly the documented fence subset.
  function opener(line: string): { char: string; length: number } | null {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (!m) return null
    if (m[1][0] === "`" && m[2].includes("`")) return null
    return { char: m[1][0], length: m[1].length }
  }
  function reference(lines: string[]): string {
    const keep: string[] = []
    let lvl: number | null = null
    let open: { char: string; length: number } | null = null
    for (const l of lines) {
      if (open) {
        if (new RegExp("^\\s*" + open.char + "{" + open.length + ",}[ \\t]*$").test(l)) {
          open = null
          if (lvl === null) keep.push(l)
        } else if (lvl === null) keep.push(l)
        continue
      }
      const o = opener(l)
      if (o) { open = o; if (lvl === null) keep.push(l); continue }
      const m = /^\s*(#{1,6})\s+(.+?)\s*$/.exec(l)
      if (m && lvl !== null && m[1].length <= lvl) lvl = null
      if (m && lvl === null && m[2].trim().toLowerCase() === "acceptance") { lvl = m[1].length; continue }
      if (lvl === null) keep.push(l)
    }
    while (keep.length && keep[keep.length - 1] === "") keep.pop()
    return keep.join("\n")
  }
  let seed = 424242
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  let mismatches = 0
  let nonIdempotent = 0
  for (let i = 0; i < 3000; i++) {
    const len = 1 + Math.floor(rnd() * 16)
    const lines: string[] = []
    for (let j = 0; j < len; j++) lines.push(vocab[Math.floor(rnd() * vocab.length)])
    const doc = lines.join("\n")
    const stripped = stripAcceptanceSection(doc)
    if (stripped !== reference(lines)) mismatches++
    if (stripAcceptanceSection(stripped) !== stripped) nonIdempotent++
  }
  assert.equal(mismatches, 0, "strip matches the independent fence-subset reference")
  assert.equal(nonIdempotent, 0, "strip is idempotent over the whole corpus")
})

test("N1: the import parser never treats fenced examples as observed approvals", () => {
  const prose = "Intro\n~~~md\n## Acceptance\n- [x] fenced example ONLY\n~~~\nKEEP TAIL.\n\n## Acceptance\n- [ ] real pending\n- [x] real observed"
  const observed = parseAcceptanceRead(prose)
  assert.equal(observed.condition, "criteria")
  assert.deepEqual(observed.items, [
    { text: "real pending", completed: false },
    { text: "real observed", completed: true }
  ])
  // Guard in depth: the analyzer reports the fenced bullet as opaque content.
  const analysis = analyzeAcceptanceProse(prose)
  assert.equal(analysis.items.length, 2)
})
