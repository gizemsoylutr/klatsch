import { readFileSync } from 'node:fs';

/** This package's version, from its package.json one level up (`src/` in the repository, `dist/` in the npm package). */
export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
