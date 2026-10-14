/**
 * Pins two things the contract suite does not reach, because both are below
 * the level the suite tests at.
 *
 * The edge-preservation hazard is the one described in
 * docs/engineering/provider-contract-decisions.md: `updateTask` replaces a
 * task's `dependsOn`/`blocking` lists rather than appending, so writing one
 * kind of edge without resending the other kind's list silently deletes it.
 * `writeDependency` sends both lists on every write specifically to avoid
 * this, and this is the test that would catch it if that stopped being true.
 *
 * `LOCAL_STORE_CAPABILITIES` is checked against the two fields the decisions
 * doc calls out by name as deliberately read-only or absent: `body` (stays
 * Git-authored) and `completedOn` (stamped by the `done` gate, never caller-
 * written).
 */

import assert from "node:assert/strict"
import test from "node:test"
import { LOCAL_STORE_CAPABILITIES, LocalStoreProvider } from "./local-store-provider"
import { createProviderFixture, FIXTURE_SECOND, FIXTURE_THIRD, FIXTURE_WRITABLE } from "./__test-helpers__"
import type { ProviderItemRef } from "./types"

const ref = (id: string): ProviderItemRef => ({ provider: "local", workItem: { id, key: id } })

test("adding a blocked-by edge does not delete an existing blocks edge, and vice versa", async () => {
  const fixture = createProviderFixture()
  try {
    const provider = new LocalStoreProvider({ store: fixture.handle, actor: "edge-test", projectId: fixture.storeDir })

    const blockedBy = await provider.addDependency({
      from: ref(FIXTURE_WRITABLE),
      to: ref(FIXTURE_SECOND),
      kind: "blocked-by",
      clientOperationId: "edge-setup-blocked-by"
    })
    assert.equal(blockedBy.ok, true)

    const blocks = await provider.addDependency({
      from: ref(FIXTURE_WRITABLE),
      to: ref(FIXTURE_THIRD),
      kind: "blocks",
      clientOperationId: "edge-setup-blocks"
    })
    assert.equal(blocks.ok, true)

    // The write under test: a second blocked-by edge. If writeDependency ever
    // sent only the dependsOn list, this call would silently drop the blocks
    // edge to FIXTURE_THIRD set up above.
    const secondBlockedBy = await provider.addDependency({
      from: ref(FIXTURE_WRITABLE),
      to: ref(FIXTURE_THIRD),
      kind: "blocked-by",
      clientOperationId: "edge-mutating-write"
    })
    assert.equal(secondBlockedBy.ok, true)

    const after = await provider.getDependencies({ items: [ref(FIXTURE_WRITABLE)] })
    assert.equal(after.ok, true)
    if (!after.ok) return

    const has = (to: string, kind: "blocked-by" | "blocks") =>
      after.value.items.some(
        (edge) => edge.kind === kind && edge.from.workItem.id === FIXTURE_WRITABLE && edge.to.workItem.id === to
      )

    assert.equal(has(FIXTURE_SECOND, "blocked-by"), true, "original blocked-by edge must survive")
    assert.equal(has(FIXTURE_THIRD, "blocks"), true, "original blocks edge must survive the later blocked-by write")
    assert.equal(has(FIXTURE_THIRD, "blocked-by"), true, "the new blocked-by edge must also be present")
  } finally {
    fixture.teardown()
  }
})

test("LOCAL_STORE_CAPABILITIES: body is neither readable nor writable", () => {
  assert.deepEqual(LOCAL_STORE_CAPABILITIES.fields.body, { read: false, write: false })
})

test("LOCAL_STORE_CAPABILITIES: completedOn is readable but not writable", () => {
  assert.equal(LOCAL_STORE_CAPABILITIES.fields.completedOn?.read, true)
  assert.equal(LOCAL_STORE_CAPABILITIES.fields.completedOn?.write, false)
})
