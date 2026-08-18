import * as fs from "node:fs";
import * as path from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ENTITY_SCHEMAS } from "./entities";
import { ENVELOPE_SCHEMAS } from "./envelopes";
import { canonicalJson } from "./canonical";
import { PROTOCOL_SCHEMA_VERSION } from "./schema-version";

const ALL_SCHEMAS: Record<string, unknown> = { ...ENTITY_SCHEMAS, ...ENVELOPE_SCHEMAS };
const toJsonSchema = zodToJsonSchema as unknown as (
  schema: unknown,
  options: { name: string; $refStrategy: "none" }
) => unknown;

export function writeGeneratedSchemas(outDir: string): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const [name, schema] of Object.entries(ALL_SCHEMAS)) {
    const json = toJsonSchema(schema, { name, $refStrategy: "none" });
    const filePath = path.join(outDir, `${name}.v${PROTOCOL_SCHEMA_VERSION}.json`);
    fs.writeFileSync(filePath, canonicalJson(json), "utf8");
    written.push(filePath);
  }
  return written;
}

if (require.main === module) {
  const outDir = path.resolve(__dirname, "..", "schemas");
  const written = writeGeneratedSchemas(outDir);
  process.stdout.write(`${written.length} schemas written to ${outDir}\n`);
}
