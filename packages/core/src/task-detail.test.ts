import assert from "node:assert/strict"
import test from "node:test"
import { parseBareAcceptanceChecklist } from "./task-detail"

// ---------------------------------------------------------------------------
// T-129 criterion 4: parseBareAcceptanceChecklist -- the fallback reader for
// a scratch file holding just a checklist, no `## Acceptance` heading.
// Deliberately stricter than the in-section parser: only bullets carrying an
// explicit `[ ]`/`[x]` box count, because without a heading to scope them a
// plain `- bullet` is prose, not a criterion.
// ---------------------------------------------------------------------------

test("parseBareAcceptanceChecklist collects checkbox bullets with no heading required", () => {
  const items = parseBareAcceptanceChecklist("- [ ] a\n- [x] b\n")
  assert.deepEqual(items, [
    { text: "a", completed: false },
    { text: "b", completed: true }
  ])
})

test("parseBareAcceptanceChecklist maps [x] and [X] to completed, [ ] to pending", () => {
  const items = parseBareAcceptanceChecklist("- [ ] pending\n- [x] lower\n- [X] upper\n")
  assert.deepEqual(items.map(i => i.completed), [false, true, true])
})

test("parseBareAcceptanceChecklist ignores a bullet with no box at all -- stricter than the in-section parser", () => {
  const items = parseBareAcceptanceChecklist("- [ ] real criterion\n- plain bullet, no box\n")
  assert.deepEqual(items, [{ text: "real criterion", completed: false }])
})

test("parseBareAcceptanceChecklist accepts -, *, and + as the bullet marker", () => {
  const items = parseBareAcceptanceChecklist("- [ ] dash\n* [ ] star\n+ [ ] plus\n")
  assert.deepEqual(items.map(i => i.text), ["dash", "star", "plus"])
})

test("parseBareAcceptanceChecklist keeps a checkbox inside a fenced code block opaque -- not a criterion", () => {
  const content = [
    "- [ ] real criterion before",
    "```md",
    "- [ ] fenced, must not count",
    "```",
    "- [x] real criterion after"
  ].join("\n")
  const items = parseBareAcceptanceChecklist(content)
  assert.deepEqual(items.map(i => i.text), ["real criterion before", "real criterion after"])
})

test("parseBareAcceptanceChecklist: an unclosed/tilde fence still swallows everything after it", () => {
  const content = ["- [ ] before", "~~~", "- [ ] inside tilde fence", "~~~", "- [x] after"].join("\n")
  const items = parseBareAcceptanceChecklist(content)
  assert.deepEqual(items.map(i => i.text), ["before", "after"])
})

test("parseBareAcceptanceChecklist returns an empty list for prose with no checkbox bullets at all", () => {
  assert.deepEqual(parseBareAcceptanceChecklist("Just a paragraph.\n- a bullet with no box\n"), [])
})

test("parseBareAcceptanceChecklist also reads a real ## Acceptance section's own items (no special-casing, they are checkbox bullets like any other)", () => {
  const content = "## Acceptance\n- [ ] a\n- [x] b\n"
  const items = parseBareAcceptanceChecklist(content)
  assert.deepEqual(items.map(i => i.text), ["a", "b"])
})
