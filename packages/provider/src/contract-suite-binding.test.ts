/**
 * The binding test: `LocalStoreProvider` must pass the whole contract suite.
 *
 * `skipped === 0` matters as much as `failed === 0` here. A group that silently
 * skips (missing sample value, no legal move supplied, …) is a group that
 * stopped testing anything, and a suite that degenerates that way would not
 * catch the bugs the mutation tests in contract-suite-mutations.test.ts prove
 * it can catch. `passed > 100` guards against the same failure mode at the
 * other end: a suite that collapsed to three trivial checks would still
 * report failed=0, skipped=0.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { checkProviderContract, formatContractFailures, type ContractContext } from "./contract-suite"
import { LocalStoreProvider } from "./local-store-provider"
import {
  createProviderFixture,
  FIXTURE_EPIC,
  FIXTURE_MISSING,
  FIXTURE_SECOND,
  FIXTURE_WRITABLE
} from "./__test-helpers__"
import type { ProviderItemRef } from "./types"

const ref = (id: string): ProviderItemRef => ({ provider: "local", workItem: { id, key: id } })

function buildContractContext(fixture: ReturnType<typeof createProviderFixture>): ContractContext {
  const provider = new LocalStoreProvider({ store: fixture.handle, actor: "contract", projectId: fixture.storeDir })
  return {
    provider,
    project: fixture.storeDir,
    writableItem: ref(FIXTURE_WRITABLE),
    secondWritableItem: ref(FIXTURE_SECOND),
    missingItem: ref(FIXTURE_MISSING),
    sampleValues: {
      title: "Contract suite title",
      type: "chore",
      parent: FIXTURE_EPIC,
      priority: "low",
      tags: ["contract"],
      startDate: "2026-02-01",
      dueDate: "2026-03-01",
      iteration: "sprint-1",
      assignees: ["someone"],
      milestone: "m1",
      summary: "Contract suite summary.",
      role: "implementation",
      impact: "medium"
    },
    legalPlanningStateMove: "ready",
    illegalPlanningStateMove: "done",
    expectedItemCount: 4
  }
}

test("LocalStoreProvider passes the full contract suite", async () => {
  const fixture = createProviderFixture()
  try {
    const report = await checkProviderContract(buildContractContext(fixture))
    assert.equal(report.failed, 0, formatContractFailures(report))
    assert.equal(report.skipped, 0, `expected no skipped checks, got:\n${report.checks.filter((c) => c.skipped).map((c) => `${c.group}/${c.id}: ${c.detail}`).join("\n")}`)
    assert.ok(report.passed > 100, `expected more than 100 passed checks, got ${report.passed}`)
  } finally {
    fixture.teardown()
  }
})
