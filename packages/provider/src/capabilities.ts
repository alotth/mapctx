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
  ProviderOwnedField,
  ProviderRelationKind,
  RelationCapability
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
