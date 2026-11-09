import { mkdirSync, rmSync } from 'node:fs';
import { SCREENSHOTS, VISITED } from './people.ts';

/** Starts the coverage record and the screenshots afresh, so neither shows pages from an earlier run. */
export default function globalSetup() {
  rmSync(VISITED, { force: true });
  rmSync(SCREENSHOTS, { recursive: true, force: true });
  mkdirSync(SCREENSHOTS, { recursive: true });
}
