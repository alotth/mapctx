/**
 * Reading a capability record.
 *
 * Capabilities are data, and the contract suite checks every provider against
 * its own declaration. That is the whole anti-lying mechanism: a provider that
 * declares `write: false` must refuse the write, and one that declares
 * `write: true` must not refuse it as `unsupported`. Either direction of
 * mismatch is a contract failure, because a caller plans around the
 * declaration and cannot plan around a surprise.
 */

import type {
  FieldCapability,
  ProviderCapabilities,
  ProviderFieldDescriptor,
  ProviderItemSpecies,
  ProviderOwnedField,
  ProviderRelationKind,
  RelationCapability,
  SpeciesCapabilities,
  TaskProvider
} from "./types"

export function fieldCapability(
  capabilities: ProviderCapabilities,
  field: ProviderOwnedField
): FieldCapability | undefined {
  return capabilities.fields[field]
}

export function canReadField(capabilities: ProviderCapabilities, field: ProviderOwnedField): boolean {
  return capabilities.fields[field]?.read === true
}

export function canWriteField(capabilities: ProviderCapabilities, field: ProviderOwnedField): boolean {
  return capabilities.fields[field]?.write === true
}

export function relationCapability(
  capabilities: ProviderCapabilities,
  kind: ProviderRelationKind
): RelationCapability | undefined {
  return capabilities.relations[kind]
}

export function canReadRelation(capabilities: ProviderCapabilities, kind: ProviderRelationKind): boolean {
  return capabilities.relations[kind]?.read === true
}

export function canWriteRelation(capabilities: ProviderCapabilities, kind: ProviderRelationKind): boolean {
  return capabilities.relations[kind]?.write === true
}

/** Fields the provider says it can write, in contract order. */
export function writableFields(capabilities: ProviderCapabilities): ProviderOwnedField[] {
  return (Object.keys(capabilities.fields) as ProviderOwnedField[])
    .filter((field) => capabilities.fields[field]?.write === true)
    .sort()
}

export function readableFields(capabilities: ProviderCapabilities): ProviderOwnedField[] {
  return (Object.keys(capabilities.fields) as ProviderOwnedField[])
    .filter((field) => capabilities.fields[field]?.read === true)
    .sort()
}

/**
 * A field that can be written but not read back cannot be verified, and
 * read-after-write is the only retry primitive this contract has (T-135: no
 * precondition, and `clientOperationId` does not de-duplicate). Such a field is
 * legal but worth naming, so the contract suite reports it.
 */
export function unverifiableWritableFields(capabilities: ProviderCapabilities): ProviderOwnedField[] {
  return (Object.keys(capabilities.fields) as ProviderOwnedField[])
    .filter((field) => capabilities.fields[field]?.write === true && capabilities.fields[field]?.read !== true)
    .sort()
}

/**
 * The capability record for one species.
 *
 * An override REPLACES the entry it names rather than merging field by field,
 * so a species that says `relations: {}` has no readable relations at all —
 * which is exactly what a GitHub draft issue needs to say. Absent entries fall
 * through to the primary record untouched.
 */
export function capabilitiesForSpecies(
  capabilities: ProviderCapabilities,
  species: ProviderItemSpecies
): ProviderCapabilities {
  if (species === capabilities.primarySpecies) return capabilities
  const override: SpeciesCapabilities | undefined = capabilities.species?.[species]
  if (override === undefined) return capabilities
  return {
    ...capabilities,
    fields: override.fields ?? capabilities.fields,
    relations: override.relations ?? capabilities.relations,
    comments: override.comments ?? capabilities.comments,
    criteria: override.criteria ?? capabilities.criteria,
    timeline: override.timeline ?? capabilities.timeline,
    lifecycle: {
      create: override.lifecycle?.create ?? capabilities.lifecycle.create,
      closeOrReopen: override.lifecycle?.closeOrReopen ?? capabilities.lifecycle.closeOrReopen
    },
    primarySpecies: species
  }
}

/**
 * Capabilities that actually apply to one item.
 *
 * Prefers the provider's own resolver, because only the provider can infer a
 * species from an id it issued. Falls back to the ref's declared species, then
 * to the primary record.
 */
export function effectiveCapabilities(provider: TaskProvider, ref?: { species?: ProviderItemSpecies }): ProviderCapabilities {
  if (ref !== undefined && provider.capabilitiesForItem !== undefined) {
    return provider.capabilitiesForItem(ref as Parameters<NonNullable<TaskProvider["capabilitiesForItem"]>>[0])
  }
  if (ref?.species !== undefined) return capabilitiesForSpecies(provider.capabilities, ref.species)
  return provider.capabilities
}

/**
 * Species declarations that claim MORE than the primary record.
 *
 * Returned as a list of offending paths rather than a boolean so a failure says
 * which claim was widened. A non-empty result is a contract violation: the
 * primary record is a description, and a species that widens it turns it into a
 * floor that nothing documents.
 */
export function widenedSpeciesClaims(capabilities: ProviderCapabilities): string[] {
  const offences: string[] = []
  for (const [species, override] of Object.entries(capabilities.species ?? {})) {
    if (species === capabilities.primarySpecies) continue
    for (const [field, cap] of Object.entries(override.fields ?? {}) as [ProviderOwnedField, FieldCapability][]) {
      const base = capabilities.fields[field]
      if (cap.read === true && base?.read !== true) offences.push(`${species}.fields.${field}.read`)
      if (cap.write === true && base?.write !== true) offences.push(`${species}.fields.${field}.write`)
    }
    for (const [kind, cap] of Object.entries(override.relations ?? {}) as [ProviderRelationKind, RelationCapability][]) {
      const base = capabilities.relations[kind]
      if (cap.read === true && base?.read !== true) offences.push(`${species}.relations.${kind}.read`)
      if (cap.write === true && base?.write !== true) offences.push(`${species}.relations.${kind}.write`)
    }
    if (override.comments?.read === true && !capabilities.comments.read) offences.push(`${species}.comments.read`)
    if (override.comments?.write === true && !capabilities.comments.write) offences.push(`${species}.comments.write`)
    if (override.criteria?.read === true && !capabilities.criteria.read) offences.push(`${species}.criteria.read`)
    if (override.criteria?.write === true && !capabilities.criteria.write) offences.push(`${species}.criteria.write`)
    if (override.timeline?.read === true && !capabilities.timeline.read) offences.push(`${species}.timeline.read`)
    if (override.lifecycle?.create === true && !capabilities.lifecycle.create) offences.push(`${species}.lifecycle.create`)
    if (override.lifecycle?.closeOrReopen === true && !capabilities.lifecycle.closeOrReopen) {
      offences.push(`${species}.lifecycle.closeOrReopen`)
    }
  }
  return offences.sort()
}

/**
 * The option id for an enumerated field value.
 *
 * Name matching is exact and case-insensitive, and nothing is guessed: an
 * unmatched value returns `undefined` so the caller refuses the write instead
 * of sending a wrong id, which on GitHub would move an item to the wrong
 * column rather than fail.
 */
export function resolveOptionId(
  descriptors: readonly ProviderFieldDescriptor[],
  semantic: ProviderOwnedField,
  value: string
): string | undefined {
  const descriptor = descriptors.find((entry) => entry.semantic === semantic && entry.options !== undefined)
  if (descriptor === undefined) return undefined
  const wanted = value.trim().toLowerCase()
  return descriptor.options?.find((option) => option.name.trim().toLowerCase() === wanted)?.id
}

/** Fields left before the board's ceiling, or `undefined` when there is none. */
export function remainingFieldBudget(
  capabilities: ProviderCapabilities,
  descriptors: readonly ProviderFieldDescriptor[]
): number | undefined {
  const budget = capabilities.fieldBudget
  if (budget === undefined) return undefined
  return Math.max(0, budget.maxFieldsPerProject - descriptors.filter((entry) => entry.surface === "project-item").length)
}
