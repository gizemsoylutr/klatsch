import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { wireSchemas } from './index.ts';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema');
const check = process.argv.includes('--check');
let stale = 0;

mkdirSync(outDir, { recursive: true });
for (const [name, schema] of Object.entries(wireSchemas)) {
  const path = join(outDir, `${name}.schema.json`);
  const json = `${JSON.stringify(z.toJSONSchema(schema), null, 2)}\n`;
  if (!check) {
    writeFileSync(path, json);
    continue;
  }
  let current = '';
  try {
    current = readFileSync(path, 'utf8');
  } catch {}
  if (current !== json) {
    console.error(`stale: schema/${name}.schema.json`);
    stale++;
  }
}
if (stale) {
  console.error('Run `npm run schema` and commit the result.');
  process.exit(1);
}
