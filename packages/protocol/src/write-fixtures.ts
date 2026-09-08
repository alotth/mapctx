import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalJson } from "./canonical";
import { ENTITY_FIXTURES, ENVELOPE_FIXTURES } from "./fixtures";
import { PROTOCOL_SCHEMA_VERSION } from "./schema-version";

export function writeGoldenFixtures(outDir: string): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const all = { ...ENTITY_FIXTURES, ...ENVELOPE_FIXTURES };
  for (const [name, value] of Object.entries(all)) {
    const filePath = path.join(outDir, `${name}.v${PROTOCOL_SCHEMA_VERSION}.json`);
    fs.writeFileSync(filePath, canonicalJson(value), "utf8");
    written.push(filePath);
  }
  return written;
}

if (require.main === module) {
  const outDir = path.resolve(__dirname, "..", "fixtures");
  const written = writeGoldenFixtures(outDir);
  process.stdout.write(`${written.length} fixtures written to ${outDir}\n`);
}
