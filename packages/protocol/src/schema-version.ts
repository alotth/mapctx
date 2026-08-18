export const PROTOCOL_SCHEMA_VERSION = 1;
export const MIN_COMPATIBLE_SCHEMA_VERSION = 1;

export type SchemaCompatibility =
  | { ok: true }
  | { ok: false; reason: "too-old" | "too-new"; schemaVersion: number };

export function checkSchemaCompatibility(schemaVersion: number): SchemaCompatibility {
  if (!Number.isInteger(schemaVersion)) {
    return { ok: false, reason: "too-old", schemaVersion };
  }
  if (schemaVersion < MIN_COMPATIBLE_SCHEMA_VERSION) {
    return { ok: false, reason: "too-old", schemaVersion };
  }
  if (schemaVersion > PROTOCOL_SCHEMA_VERSION) {
    return { ok: false, reason: "too-new", schemaVersion };
  }
  return { ok: true };
}

export function assertCompatibleSchemaVersion(schemaVersion: number): void {
  const result = checkSchemaCompatibility(schemaVersion);
  if (result.ok) return;
  const bound =
    result.reason === "too-new"
      ? `greater than ${PROTOCOL_SCHEMA_VERSION}`
      : `less than ${MIN_COMPATIBLE_SCHEMA_VERSION}`;
  throw new Error(`Incompatible schemaVersion ${schemaVersion}: ${bound}.`);
}
