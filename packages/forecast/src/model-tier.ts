/**
 * Model capability tier lens (T-071/D5).
 *
 * Difficulty is executor-relative: a task that is Hard for a small local model
 * is Easy for a frontier one, so estimation-error signals are only honest per
 * capability level. But model NAMES rot -- providers rename and supersede
 * models continuously -- so this file deliberately contains NO stored
 * property. The store captures the raw executor identity as a fact
 * (`executorModel` on the dispatch attempt); tier is DERIVED here, at
 * analysis time, through this versioned lens. When the mapping improves,
 * history re-derives without any data migration -- the same
 * facts-plus-recomputable-lens shape the prior table uses.
 *
 * This table is a DOCUMENTED GUESS, like the workload priors: pattern matches
 * conservative and few, confidence LOW, and "unclassified" is a first-class
 * answer rather than a silent default into a real tier. It exists so the
 * notion of "which level of model are we talking about" has one canonical,
 * upgradeable home -- not to pretend capability is a solved measurement.
 *
 * v1 scoping (decision D5): pools stay workload-keyed. With single-digit real
 * actuals, slicing by tier would empty every pool; the raw ids captured per
 * dispatch make later tier-sliced analysis possible without recapture.
 */

export type ModelTier = "frontier" | "capable" | "fast" | "local" | "unclassified";

/**
 * Ordered coarse levels. "frontier" = provider flagship class; "capable" =
 * strong mid-tier; "fast" = latency/price-optimized variants; "local" =
 * self-hosted/small models. Unknown ids fall to "unclassified".
 */
export const MODEL_TIER_ORDER: readonly ModelTier[] = ["frontier", "capable", "fast", "local", "unclassified"];

type TierPattern = { tier: Exclude<ModelTier, "unclassified">; pattern: RegExp };

/**
 * Substring patterns against lowercased raw ids. Deliberately conservative:
 * a wrong tier assignment poisons the lens silently, so ambiguous ids stay
 * "unclassified" until evidence places them.
 */
const TIER_PATTERNS: readonly TierPattern[] = [
  // Order matters where names overlap: "flash-lite" is a fast variant and
  // must match before the capable-tier "gemini.*flash" pattern below it.
  { tier: "fast", pattern: /flash-lite|instant|turbo|(\b|[-_.])grok-?fast/ },
  { tier: "frontier", pattern: /opus/ },
  { tier: "frontier", pattern: /(\b|[-_.])gpt-?5/ },
  { tier: "frontier", pattern: /(\b|[-_.])glm-?5/ },
  { tier: "frontier", pattern: /gemini.*pro/ },
  { tier: "frontier", pattern: /(\b|[-_.])grok-?[45]/ },
  { tier: "frontier", pattern: /deepseek-r/ },
  { tier: "capable", pattern: /sonnet/ },
  { tier: "capable", pattern: /(\b|[-_.])glm-?4/ },
  { tier: "capable", pattern: /(\b|[-_.])gpt-?4/ },
  { tier: "capable", pattern: /gemini.*flash/ },
  { tier: "fast", pattern: /haiku/ },
  { tier: "local", pattern: /llama|qwen|mistral|phi-|gemma/ }
];

/** Derive the capability tier of one raw executor model id. Deterministic; unknown/null -> "unclassified". */
export function modelTierFor(executorModel: string | null | undefined): ModelTier {
  if (executorModel === null || executorModel === undefined || executorModel === "") return "unclassified";
  const id = executorModel.toLowerCase();
  for (const { tier, pattern } of TIER_PATTERNS) {
    if (pattern.test(id)) return tier;
  }
  return "unclassified";
}
