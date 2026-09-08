import assert from "node:assert/strict"
import test from "node:test"
import { DEFAULT_PRIOR, DEFAULT_WORKLOAD, MEASURED_ANCHOR_P50_MS, priorForWorkload, WORKLOAD_PRIORS } from "./prior"
import type { Workload } from "./types"

test("the duration prior varies by declared workload", () => {
  const workloads: Workload[] = ["Easy", "Normal", "Hard", "Extreme"]
  const p50s = workloads.map(workload => WORKLOAD_PRIORS[workload].durationP50Ms)
  assert.equal(new Set(p50s).size, 4, "each workload must get its own prior")
  assert.ok(p50s[0] < p50s[1] && p50s[1] < p50s[2] && p50s[2] < p50s[3])
  // An Easy task and an Extreme task must no longer receive an identical forecast.
  assert.notEqual(WORKLOAD_PRIORS.Easy.durationP50Ms, WORKLOAD_PRIORS.Extreme.durationP50Ms)
})

test("the Easy prior is anchored to this repository's measured wave1 actuals", () => {
  // T-067 312,830ms + T-068 116,387ms, arithmetic mean, rounded.
  assert.equal(MEASURED_ANCHOR_P50_MS, Math.round((312_830 + 116_387) / 2))
  assert.equal(WORKLOAD_PRIORS.Easy.durationP50Ms, MEASURED_ANCHOR_P50_MS)
  // The anchor is orders of magnitude below the human working day it replaced.
  assert.ok(WORKLOAD_PRIORS.Easy.durationP50Ms < 60 * 60 * 1000, "measured anchor is minutes, not a human day")
})

test("prior derivation is written down in the assumptions, not buried", () => {
  for (const workload of ["Easy", "Normal", "Hard", "Extreme"] as const) {
    const assumptions = WORKLOAD_PRIORS[workload].assumptions.join(" | ")
    assert.match(assumptions, /T-067/, "must cite the measured actuals")
    assert.match(assumptions, /T-068/)
    assert.match(assumptions, /documented guess/, "upward steps must be labeled a guess, not a baseline")
    assert.match(assumptions, /LOW confidence/)
  }
})

test("P90 retains the 2x P50 spread across all workloads", () => {
  for (const workload of ["Easy", "Normal", "Hard", "Extreme"] as const) {
    assert.equal(WORKLOAD_PRIORS[workload].durationP90Ms, 2 * WORKLOAD_PRIORS[workload].durationP50Ms)
  }
})

test("priorForWorkload falls back to the default workload and rejects typos", () => {
  assert.equal(priorForWorkload(undefined), WORKLOAD_PRIORS[DEFAULT_WORKLOAD])
  assert.equal(priorForWorkload(null), WORKLOAD_PRIORS[DEFAULT_WORKLOAD])
  assert.equal(priorForWorkload("Hard"), WORKLOAD_PRIORS.Hard)
  assert.throws(() => priorForWorkload("EXTREME"))
  assert.throws(() => priorForWorkload("medium"))
})

test("DEFAULT_PRIOR is the default-workload prior, kept as a back-compat alias", () => {
  assert.equal(DEFAULT_PRIOR, WORKLOAD_PRIORS[DEFAULT_WORKLOAD])
})
