import assert from "node:assert/strict"
import test from "node:test"
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { importCommit } from "./cutover"
import { approveAcceptanceCriteria, approveAcceptanceCriterion, commitAcceptanceImport, planAcceptanceImport, reviseAcceptance, unapproveAcceptanceCriterion } from "./acceptance"
import { getAcceptance } from "./projections"
import { moveTask } from "./tasks"
import { StoreHandle } from "./store-handle"
import { cleanupDir, setupGoldenRepo } from "./__test-helpers__"

function materialize() {
  const fixture = setupGoldenRepo()
  const committed = importCommit({ cwd: fixture.repoDir, actor: "test" })
  const store = StoreHandle.open(committed.storeDir)
  return { ...fixture, committed, store }
}

test("Acceptance import pins observed bytes and maps only explicit checkboxes", () => {
  const fixture = materialize()
  try {
    const detailPath = path.join(fixture.repoDir, "tasks", "T-101.md")
    const original = fs.readFileSync(detailPath)
    const content = original.toString("utf8").replace(
      /## Acceptance[\s\S]*?(?=\n## |$)/,
      "## Acceptance\n- [x] Observed criterion.\n- [ ] Pending criterion.\n"
    )
    fs.writeFileSync(detailPath, content)
    const planned = planAcceptanceImport(fixture.store.db, fixture.repoDir)
    const entry = planned.entries.find(item => item.taskId === "T-101")!
    assert.equal(entry.action, "import")
    assert.equal(entry.approvedCount, 1)
    assert.equal(entry.pendingCount, 1)
    assert.equal(entry.sourceSha256, (awaitlessHash(fs.readFileSync(detailPath))))

    const committed = commitAcceptanceImport(fixture.store, fixture.repoDir, { actor: "importer" })
    assert.equal(committed.ok, true)
    const acceptance = getAcceptance(fixture.store.db, "T-101")!
    assert.equal(acceptance.revision, 1)
    assert.deepEqual(acceptance.criteria.map(item => [item.text, item.state, item.source]), [
      ["Observed criterion.", "approved", "import-observed"],
      ["Pending criterion.", "pending", "import-observed-unchecked"]
    ])
    const event = fixture.store.listEvents().find(item => item.eventType === "acceptance.imported")!
    assert.equal((event.payload as { sourceSha256: string }).sourceSha256, entry.sourceSha256)

    const rerun = commitAcceptanceImport(fixture.store, fixture.repoDir, { actor: "importer" })
    assert.equal(rerun.ok, true)
    if (rerun.ok) assert.ok(rerun.skippedExisting > 0)
    assert.equal(getAcceptance(fixture.store.db, "T-101")?.revision, 1)
  } finally { fixture.store.close(); fixture.restoreEnv(); cleanupDir(fixture.repoDir) }
})

test("new Acceptance revision resets approvals, protects expected revision, and empty revision keeps counter", () => {
  const fixture = materialize()
  try {
    const first = reviseAcceptance(fixture.store, { taskId: "T-101", condition: "criteria", texts: ["Criterion A", "Criterion B"], actor: "author", expectRevision: 0 })
    assert.ok(first.ok)
    if (!first.ok) return
    const approved = approveAcceptanceCriterion(fixture.store, { taskId: "T-101", criterionId: first.criteria[0].criterionId, expectRevision: 1, actor: "reviewer", evidence: { uri: "proof://one" } })
    assert.ok(approved.ok)

    const changed = reviseAcceptance(fixture.store, { taskId: "T-101", condition: "criteria", texts: ["Criterion A", "Criterion B"], actor: "author", expectRevision: 1 })
    assert.ok(changed.ok)
    if (!changed.ok) return
    assert.equal(changed.revision, 2, "identical text with approvals starts a clean revision")
    assert.ok(changed.criteria.every(item => item.state === "pending" && (item.evidence === undefined || item.evidence === null)))
    const stale = approveAcceptanceCriterion(fixture.store, { taskId: "T-101", criterionId: first.criteria[0].criterionId, expectRevision: 1, actor: "reviewer" })
    assert.equal(stale.ok, false)
    if (!stale.ok) assert.equal(stale.reason, "revision-conflict")

    const unapproved = unapproveAcceptanceCriterion(fixture.store, { taskId: "T-101", criterionId: changed.criteria[0].criterionId, expectRevision: 2, actor: "reviewer" })
    assert.equal(unapproved.ok, false)
    const emptied = reviseAcceptance(fixture.store, { taskId: "T-101", condition: "empty", texts: [], actor: "author", expectRevision: 2 })
    assert.ok(emptied.ok)
    if (!emptied.ok) return
    assert.equal(emptied.revision, 3)
    assert.equal(emptied.criteria.length, 0)
    const next = reviseAcceptance(fixture.store, { taskId: "T-101", condition: "criteria", texts: ["Criterion A"], actor: "author", expectRevision: 3 })
    assert.ok(next.ok)
    if (next.ok) assert.equal(next.revision, 4)
  } finally { fixture.store.close(); fixture.restoreEnv(); cleanupDir(fixture.repoDir) }
})

test("done gate uses canonical Acceptance and never reads local detail changes", () => {
  const fixture = materialize()
  try {
    const revised = reviseAcceptance(fixture.store, { taskId: "T-101", condition: "criteria", texts: ["Store criterion"], actor: "author", expectRevision: 0 })
    assert.ok(revised.ok)
    if (!revised.ok) return
    assert.equal(moveTask(fixture.store, { taskId: "T-101", to: "ready", actor: "operator" }).ok, true)
    assert.equal(moveTask(fixture.store, { taskId: "T-101", to: "in-progress", actor: "operator" }).ok, true)
    assert.equal(moveTask(fixture.store, { taskId: "T-101", to: "review", actor: "operator" }).ok, true)
    const localDetail = path.join(fixture.repoDir, "tasks", "T-101.md")
    fs.writeFileSync(localDetail, "# T-101\n\n## Acceptance\n- [x] Local-only approval.\n")
    const blocked = moveTask(fixture.store, { taskId: "T-101", to: "done", actor: "operator" })
    assert.equal(blocked.ok, false)
    if (!blocked.ok) assert.equal(blocked.reason, "acceptance-incomplete")
    assert.equal(approveAcceptanceCriterion(fixture.store, { taskId: "T-101", index: 0, expectRevision: 1, actor: "reviewer" }).ok, true)
    assert.equal(moveTask(fixture.store, { taskId: "T-101", to: "done", actor: "operator" }).ok, true)
  } finally { fixture.store.close(); fixture.restoreEnv(); cleanupDir(fixture.repoDir) }
})

test("library revise/approve/unapprove REQUIRE expectRevision and refuse without it (zero events)", () => {
  const fixture = materialize()
  try {
    const first = reviseAcceptance(fixture.store, { taskId: "T-101", condition: "criteria", texts: ["Criterion A"], actor: "author", expectRevision: 0 })
    assert.ok(first.ok)
    if (!first.ok) return
    const eventsBefore = fixture.store.listEvents().length

    const noRevise = reviseAcceptance(fixture.store, { taskId: "T-101", condition: "criteria", texts: ["Silent latest"], actor: "author" } as never)
    assert.equal(noRevise.ok, false)
    if (!noRevise.ok) {
      assert.equal(noRevise.reason, "revision-conflict")
      assert.match(noRevise.message, /expectRevision is required/)
    }
    const noApprove = approveAcceptanceCriterion(fixture.store, { taskId: "T-101", index: 0, actor: "reviewer" } as never)
    assert.equal(noApprove.ok, false)
    if (!noApprove.ok) assert.match(noApprove.message, /expectRevision is required/)
    const noUnapprove = unapproveAcceptanceCriterion(fixture.store, { taskId: "T-101", index: 0, actor: "reviewer" } as never)
    assert.equal(noUnapprove.ok, false)
    if (!noUnapprove.ok) assert.match(noUnapprove.message, /expectRevision is required/)

    assert.equal(fixture.store.listEvents().length, eventsBefore, "refusals without expectRevision write zero events")
    assert.equal(getAcceptance(fixture.store.db, "T-101")?.criteria[0].state, "pending")
  } finally { fixture.store.close(); fixture.restoreEnv(); cleanupDir(fixture.repoDir) }
})

test("raw acceptance.revised cannot carry approval metadata into a pending new revision (zero writes)", () => {
  const fixture = materialize()
  try {
    const first = reviseAcceptance(fixture.store, { taskId: "T-101", condition: "criteria", texts: ["Criterion A"], actor: "author", expectRevision: 0 })
    assert.ok(first.ok)
    if (!first.ok) return
    const approved = approveAcceptanceCriterion(fixture.store, { taskId: "T-101", criterionId: first.criteria[0].criterionId, expectRevision: 1, actor: "reviewer", evidence: { uri: "proof://revision1" } })
    assert.ok(approved.ok)
    const eventsBefore = fixture.store.listEvents().length
    const smuggled = getAcceptance(fixture.store.db, "T-101")!.criteria[0]

    assert.throws(
      () =>
        fixture.store.appendEvent({
          eventType: "acceptance.revised",
          actor: "raw-writer",
          payload: {
            taskId: "T-101",
            revision: 2,
            condition: "criteria",
            criteria: [{ ...smuggled, revision: 2, state: "pending" }]
          }
        }),
      /approval metadata/
    )
    assert.equal(fixture.store.listEvents().length, eventsBefore, "refused raw revise leaves zero writes")
    const acceptance = getAcceptance(fixture.store.db, "T-101")!
    assert.equal(acceptance.revision, 1)
    assert.equal(acceptance.criteria[0].state, "approved", "prior revision untouched by the refusal")

    // The composed path stays usable: a legitimate revise still works and
    // lands all-pending with approval state reset.
    const second = reviseAcceptance(fixture.store, { taskId: "T-101", condition: "criteria", texts: ["Criterion A"], actor: "author", expectRevision: 1 })
    assert.ok(second.ok)
    if (!second.ok) return
    assert.equal(second.criteria[0].state, "pending")
    assert.equal(second.criteria[0].approvedAt ?? null, null)
    assert.equal(second.criteria[0].approvedBy ?? null, null)
    assert.equal(second.criteria[0].evidence ?? null, null)
  } finally { fixture.store.close(); fixture.restoreEnv(); cleanupDir(fixture.repoDir) }
})

function awaitlessHash(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

// ---------------------------------------------------------------------------
// T-129 criterion 1: approveAcceptanceCriteria -- batch approve.
// ---------------------------------------------------------------------------

function materializeWithThreeCriteria() {
  const fixture = materialize()
  const revised = reviseAcceptance(fixture.store, { taskId: "T-101", condition: "criteria", texts: ["a", "b", "c"], actor: "author", expectRevision: 0 })
  assert.ok(revised.ok, JSON.stringify(revised))
  if (!revised.ok) throw new Error("setup failed")
  return { ...fixture, criteria: revised.criteria }
}

test("T-129 approveAcceptanceCriteria: --index 0,2 approves both under one evidence set; alreadyApproved stays empty for an explicit selection", () => {
  const fixture = materializeWithThreeCriteria()
  try {
    const result = approveAcceptanceCriteria(fixture.store, { taskId: "T-101", indices: [0, 2], evidence: { uri: "proof://batch" }, actor: "reviewer", expectRevision: 1 })
    assert.ok(result.ok, JSON.stringify(result))
    if (!result.ok) return
    assert.equal(result.approved.length, 2)
    assert.deepEqual(result.alreadyApproved, [])

    const acceptance = getAcceptance(fixture.store.db, "T-101")!
    assert.equal(acceptance.criteria[0].state, "approved")
    assert.deepEqual(acceptance.criteria[0].evidence, { uri: "proof://batch" })
    assert.equal(acceptance.criteria[1].state, "pending")
    assert.equal(acceptance.criteria[2].state, "approved")
    assert.deepEqual(acceptance.criteria[2].evidence, { uri: "proof://batch" }, "the SAME evidence set lands on every criterion the batch approves")
  } finally { fixture.store.close(); fixture.restoreEnv(); cleanupDir(fixture.repoDir) }
})

test("T-129 approveAcceptanceCriteria: --all approves every pending criterion and skips (reports) already-approved ones; explicit selection of an approved one refuses", () => {
  const fixture = materializeWithThreeCriteria()
  try {
    const first = approveAcceptanceCriteria(fixture.store, { taskId: "T-101", indices: [0], actor: "reviewer", expectRevision: 1 })
    assert.ok(first.ok)

    const all = approveAcceptanceCriteria(fixture.store, { taskId: "T-101", all: true, actor: "reviewer", expectRevision: 1 })
    assert.ok(all.ok, JSON.stringify(all))
    if (!all.ok) return
    assert.equal(all.approved.length, 2, "the two still-pending criteria")
    assert.deepEqual(all.alreadyApproved, [fixture.criteria[0].criterionId])
    assert.ok(getAcceptance(fixture.store.db, "T-101")!.criteria.every(c => c.state === "approved"))

    // Explicit selection of an already-approved criterion refuses (unlike --all).
    const explicit = approveAcceptanceCriteria(fixture.store, { taskId: "T-101", indices: [0], actor: "reviewer", expectRevision: 1 })
    assert.equal(explicit.ok, false)
    if (!explicit.ok) assert.equal(explicit.reason, "already-approved")

    // --all when everything is already approved refuses nothing-to-approve.
    const nothing = approveAcceptanceCriteria(fixture.store, { taskId: "T-101", all: true, actor: "reviewer", expectRevision: 1 })
    assert.equal(nothing.ok, false)
    if (!nothing.ok) assert.equal(nothing.reason, "nothing-to-approve")
  } finally { fixture.store.close(); fixture.restoreEnv(); cleanupDir(fixture.repoDir) }
})

test("MUTATION GUARD: approveAcceptanceCriteria rolls back the WHOLE batch when one selector is out of range -- no partial approval", () => {
  const fixture = materializeWithThreeCriteria()
  try {
    const result = approveAcceptanceCriteria(fixture.store, { taskId: "T-101", indices: [0, 99], actor: "reviewer", expectRevision: 1 })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, "unknown-criterion")
    const acceptance = getAcceptance(fixture.store.db, "T-101")!
    assert.ok(acceptance.criteria.every(c => c.state === "pending"), "index 0 must NOT have been approved despite being valid -- the whole batch rolls back");
  } finally { fixture.store.close(); fixture.restoreEnv(); cleanupDir(fixture.repoDir) }
})

test("approveAcceptanceCriteria refuses invalid selections: --all with an explicit selection, duplicate index, duplicate criterionId, index+id selecting the same criterion twice, and a stale revision -- none approve anything", () => {
  const fixture = materializeWithThreeCriteria()
  try {
    const bothAllAndIndex = approveAcceptanceCriteria(fixture.store, { taskId: "T-101", all: true, indices: [0], actor: "reviewer", expectRevision: 1 })
    assert.equal(bothAllAndIndex.ok, false)
    if (!bothAllAndIndex.ok) assert.equal(bothAllAndIndex.reason, "invalid-selection")

    const dupeIndex = approveAcceptanceCriteria(fixture.store, { taskId: "T-101", indices: [0, 0], actor: "reviewer", expectRevision: 1 })
    assert.equal(dupeIndex.ok, false)
    if (!dupeIndex.ok) assert.equal(dupeIndex.reason, "invalid-selection")

    const criterionId = fixture.criteria[0].criterionId
    const dupeId = approveAcceptanceCriteria(fixture.store, { taskId: "T-101", criterionIds: [criterionId, criterionId], actor: "reviewer", expectRevision: 1 })
    assert.equal(dupeId.ok, false)
    if (!dupeId.ok) assert.equal(dupeId.reason, "invalid-selection")

    const sameByBoth = approveAcceptanceCriteria(fixture.store, { taskId: "T-101", indices: [0], criterionIds: [criterionId], actor: "reviewer", expectRevision: 1 })
    assert.equal(sameByBoth.ok, false)
    if (!sameByBoth.ok) assert.equal(sameByBoth.reason, "invalid-selection")

    const staleRevision = approveAcceptanceCriteria(fixture.store, { taskId: "T-101", indices: [0], actor: "reviewer", expectRevision: 999 })
    assert.equal(staleRevision.ok, false)
    if (!staleRevision.ok) assert.equal(staleRevision.reason, "revision-conflict")

    assert.ok(getAcceptance(fixture.store.db, "T-101")!.criteria.every(c => c.state === "pending"), "none of the refused calls approved anything")
  } finally { fixture.store.close(); fixture.restoreEnv(); cleanupDir(fixture.repoDir) }
})

// ---------------------------------------------------------------------------
// T-129 criterion 2: reviseAcceptance --expect-title (titleMismatch).
// ---------------------------------------------------------------------------

test("MUTATION GUARD: reviseAcceptance with the wrong --expect-title refuses title-mismatch, naming both titles, and leaves acceptance untouched", () => {
  const fixture = materialize()
  try {
    const before = getAcceptance(fixture.store.db, "T-101")
    const refused = reviseAcceptance(fixture.store, { taskId: "T-101", condition: "criteria", texts: ["x"], actor: "author", expectRevision: 0, expectTitle: "Completely wrong title" })
    assert.equal(refused.ok, false)
    if (!refused.ok) {
      assert.equal(refused.reason, "title-mismatch")
      assert.match(refused.message, /Completely wrong title/)
    }
    assert.deepEqual(getAcceptance(fixture.store.db, "T-101"), before, "a title mismatch must change nothing: no revision, no criteria")
  } finally { fixture.store.close(); fixture.restoreEnv(); cleanupDir(fixture.repoDir) }
})

test("reviseAcceptance --expect-title accepts the human form (no [T-xxx] prefix), the full stored form, and case/whitespace variants; proceeds normally without the flag", () => {
  const fixture = materialize()
  try {
    const storedTitle = require("./projections").getTask(fixture.store.db, "T-101")!.title as string
    assert.match(storedTitle, /^\[T-101\]/, "sanity: the stored title carries the bracketed id prefix")
    const humanTitle = storedTitle.replace(/^\s*\[[^\]]+\]\s*/, "")

    for (const [label, title] of [
      ["human form", humanTitle],
      ["full stored form", storedTitle],
      ["different case", humanTitle.toUpperCase()],
      ["collapsed whitespace", humanTitle.replace(/\s+/g, "   ")]
    ] as const) {
      const result = reviseAcceptance(fixture.store, { taskId: "T-101", condition: "criteria", texts: [`texts for ${label}`], actor: "author", expectRevision: (getAcceptance(fixture.store.db, "T-101")?.revision ?? 0), expectTitle: title })
      assert.ok(result.ok, `${label}: ${JSON.stringify(result)}`)
    }

    // Without --expect-title, old behavior is unaffected.
    const noFlag = reviseAcceptance(fixture.store, { taskId: "T-101", condition: "criteria", texts: ["no flag"], actor: "author", expectRevision: getAcceptance(fixture.store.db, "T-101")!.revision })
    assert.ok(noFlag.ok)
  } finally { fixture.store.close(); fixture.restoreEnv(); cleanupDir(fixture.repoDir) }
})

// ---------------------------------------------------------------------------
// T-129 criterion 3: acceptance import --task (scoped import).
// ---------------------------------------------------------------------------

test("MUTATION GUARD: planAcceptanceImport without --task has taskFilter null and every task; with --task T-101 it scopes to one entry and names the filter; an unknown id throws", () => {
  const fixture = materialize()
  try {
    const unscoped = planAcceptanceImport(fixture.store.db, fixture.repoDir)
    assert.equal(unscoped.taskFilter, null)
    assert.ok(unscoped.entries.length >= 3, JSON.stringify(unscoped.entries))

    const scoped = planAcceptanceImport(fixture.store.db, fixture.repoDir, { taskIds: ["T-101"] })
    assert.deepEqual(scoped.taskFilter, ["T-101"])
    assert.deepEqual(scoped.entries.map(e => e.taskId), ["T-101"])

    assert.throws(
      () => planAcceptanceImport(fixture.store.db, fixture.repoDir, { taskIds: ["T-101", "T-999"] }),
      /T-999/
    )
  } finally { fixture.store.close(); fixture.restoreEnv(); cleanupDir(fixture.repoDir) }
})

test("commitAcceptanceImport --task honors the same scope: only the filtered task gets an acceptance revision", () => {
  const fixture = materialize()
  try {
    const result = commitAcceptanceImport(fixture.store, fixture.repoDir, { actor: "import-bot", taskIds: ["T-101"] })
    assert.ok(result.ok, JSON.stringify(result))
    assert.ok(getAcceptance(fixture.store.db, "T-101"), "T-101 (in scope, has a ## Acceptance section) must have been imported")
    assert.equal(getAcceptance(fixture.store.db, "T-102"), null, "T-102 is out of scope and must still have no acceptance revision")
  } finally { fixture.store.close(); fixture.restoreEnv(); cleanupDir(fixture.repoDir) }
})
