// What `npm publish` would upload, checked against what the package is meant to hold: the compiled CLI and
// relay, the wire schemas and the four documents. Fails on anything else (sources, tests, deploy files, a
// stray .env) and on anything missing. Run after `npm run build` (`npm run pack:check` does both).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ALLOWED = [/^dist\/[\w/-]+\.js$/, /^schema\/[\w.-]+\.schema\.json$/, /^(package\.json|README\.md|LICENSE|CHANGELOG\.md|SECURITY\.md)$/];
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'SECURITY.md', 'dist/cli.js', 'dist/relay/app.js', 'schema/update-card.input.schema.json'];

const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' })) as [{ files: { path: string }[] }];
const files = pack.files.map((file) => file.path).sort();
const unexpected = files.filter((path) => !ALLOWED.some((pattern) => pattern.test(path)));
const missing = REQUIRED.filter((path) => !files.includes(path));
const problems = [...unexpected.map((path) => `not meant to be published: ${path}`), ...missing.map((path) => `missing: ${path}`)];

// `npx klatsch` runs the bin with node; Node does not strip types under node_modules, so it must be JavaScript.
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { bin?: Record<string, string>; private?: boolean };
if (manifest.private) problems.push('package.json is private');
if (manifest.bin?.klatsch !== 'dist/cli.js') problems.push('bin.klatsch is not dist/cli.js');
else if (!readFileSync('dist/cli.js', 'utf8').startsWith('#!/usr/bin/env node\n')) problems.push('dist/cli.js has no node shebang');

if (problems.length) {
  console.error(`npm pack would not publish what it should:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`npm pack: ${files.length} files, all expected.`);
