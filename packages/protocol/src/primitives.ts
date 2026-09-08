import { z } from "zod";
import { PROTOCOL_SCHEMA_VERSION } from "./schema-version";

export const isoDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, "expected ISO-8601 UTC timestamp");

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const uuidSchema = z.string().uuid();

export const taskIdSchema = z.string().regex(/^[TE]-\d{3,}$/);

export const schemaVersionSchema = z.number().int().positive();

export const defaultSchemaVersion = PROTOCOL_SCHEMA_VERSION;

export const nonEmptyStringSchema = z.string().min(1);

export const microsSchema = z.number().int();
export const centsSchema = z.number().int();
export const tokenCountSchema = z.number().int().nonnegative();
