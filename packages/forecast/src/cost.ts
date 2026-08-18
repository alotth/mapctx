import { randomUUID } from "node:crypto"
import type { CostEvent, PlanPeriod, UsageEvent } from "@mapctx/protocol"

export const PRICE_TABLE_VERSION = "2026-08-17-v1"

export type PriceTableEntry = {
  provider: string
  model: string
  microsPerToken: number
}

/** Vendored list-price table. Historical events retain version and applied rate. */
export const PRICE_TABLE: readonly PriceTableEntry[] = [
  { provider: "anthropic", model: "claude-sonnet", microsPerToken: 300 },
  { provider: "anthropic", model: "claude-3-5-sonnet", microsPerToken: 300 },
  { provider: "openai", model: "gpt-4o", microsPerToken: 500 },
  { provider: "openai", model: "gpt-4o-mini", microsPerToken: 30 }
]

export type CostOptions = {
  billingType?: CostEvent["billingType"]
  cashCents?: number
  priceTableVersion?: string
  appliedRateMicrosPerToken?: number
  costEventId?: string
}

export function lookupRate(provider: string, model: string, table = PRICE_TABLE): number | undefined {
  return table.find(entry => entry.provider === provider && entry.model === model)?.microsPerToken
}

/** Normalize one usage event into cost measures. Forecast never consumes allocation. */
export function costEventFromUsage(
  usage: UsageEvent,
  options: CostOptions = {}
): CostEvent {
  const rate = options.appliedRateMicrosPerToken ?? lookupRate(usage.provider, usage.model)
  const appliedRate = rate ?? 0
  const tokens = usage.inputTokens + usage.cacheTokens + usage.outputTokens
  const shadowMicros = tokens * appliedRate
  const billingType = options.billingType ?? "unknown"
  const cashCents = options.cashCents ?? 0
  const costStatus: CostEvent["costStatus"] = rate === undefined
    ? "unpriced"
    : options.cashCents === undefined
      ? "estimated"
      : "reported"
  return {
    costEventId: options.costEventId ?? randomUUID(),
    dispatchId: usage.dispatchId,
    usageEventId: usage.usageEventId,
    billingType,
    costStatus,
    cashCents,
    shadowMicros,
    allocatedMicros: null,
    planPeriodId: null,
    priceTableVersion: options.priceTableVersion ?? PRICE_TABLE_VERSION,
    appliedRateMicrosPerToken: appliedRate
  }
}

function microsForCents(cents: number): number {
  return cents * 10_000
}

/** Allocate fixed period fee proportionally to shadow cost, preserving total by deterministic remainder. */
export function allocateMicros(
  costs: readonly CostEvent[],
  period: PlanPeriod
): CostEvent[] {
  const totalShadow = costs.reduce((sum, cost) => sum + Math.max(0, cost.shadowMicros), 0)
  const budget = microsForCents(period.fixedCents)
  if (totalShadow === 0) {
    return costs.map(cost => ({ ...cost, allocatedMicros: 0, planPeriodId: period.planPeriodId, costStatus: "allocated" }))
  }
  let assigned = 0
  let largestIndex = 0
  for (let i = 1; i < costs.length; i += 1) {
    if (costs[i].shadowMicros > costs[largestIndex].shadowMicros) largestIndex = i
  }
  const result = costs.map((cost, index) => {
    const allocation = Math.floor((budget * Math.max(0, cost.shadowMicros)) / totalShadow)
    assigned += allocation
    return { ...cost, allocatedMicros: allocation, planPeriodId: period.planPeriodId, costStatus: "allocated" as const }
  })
  const remainder = budget - assigned
  if (remainder !== 0) {
    result[largestIndex] = {
      ...result[largestIndex],
      allocatedMicros: (result[largestIndex].allocatedMicros ?? 0) + remainder
    }
  }
  return result
}

export const normalizeCostEvent = costEventFromUsage
export const allocatePeriodCosts = allocateMicros

export type NonTokenCostInput = {
  dispatchId: string
  billingType: CostEvent["billingType"]
  cashCents?: number
  shadowMicros?: number
  allocatedMicros?: number | null
  planPeriodId?: string | null
  costStatus?: CostEvent["costStatus"]
  priceTableVersion?: string
  costEventId?: string
}

/** Preserve compute/tooling/human costs in same stream without inventing token usage. */
export function costEventFromNonToken(input: NonTokenCostInput): CostEvent {
  return {
    costEventId: input.costEventId ?? randomUUID(),
    dispatchId: input.dispatchId,
    usageEventId: null,
    billingType: input.billingType,
    costStatus: input.costStatus ?? "reported",
    cashCents: input.cashCents ?? 0,
    shadowMicros: input.shadowMicros ?? 0,
    allocatedMicros: input.allocatedMicros ?? null,
    planPeriodId: input.planPeriodId ?? null,
    priceTableVersion: input.priceTableVersion ?? "non-token-v1",
    appliedRateMicrosPerToken: 0
  }
}
