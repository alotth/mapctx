import assert from "node:assert/strict"
import test from "node:test"
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { importCommit } from "./cutover"
import { approveAcceptanceCriterion, commitAcceptanceImport, planAcceptanceImport, reviseAcceptance, unapproveAcceptanceCriterion } from "./acceptance"
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
