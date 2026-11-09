// Every MCP tool and every web route needs an end-to-end scenario. This reads what the relay registers
// and fails, naming what is missing, when no scenario file under test/e2e/ mentions it.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createRelay } from '../../src/relay/app.ts';
import { setup } from '../helpers.ts';

// Routes that need no scenario; keep this short and say why for each.
const NO_SCENARIO = new Set<string>([]);

const scenarios = readdirSync(import.meta.dirname)
  .filter((file) => file.endsWith('.e2e.ts'))
  .map((file) => readFileSync(join(import.meta.dirname, file), 'utf8'));
const lines = scenarios.flatMap((source) => source.split('\n'));

/**
 * `/ui/approvals/:id/decide` as a pattern for how a scenario writes it: a parameter is a template
 * interpolation (`${approvalId}`) or a literal id. The path must not continue after it, so
 * `/ui/tokens` is not covered by `/ui/tokens/${id}/revoke`.
 */
function pathPattern(path: string): RegExp {
  const parts = path.split('/').map((part) => (part.startsWith(':') ? String.raw`(?:\$\{[^}]+\}|[\w-]+)` : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return new RegExp(`${parts.join('/')}(?![\\w/-])`);
}

/** A POST must be sent with `post(` on the same line; a GET must be fetched on a line that does not post. */
function covered(method: string, path: string): boolean {
  const pattern = pathPattern(path);
  return lines.some((line) => pattern.test(line) && (method === 'ALL' || (method === 'POST') === /\bpost\(/.test(line)));
}

describe('end-to-end coverage', () => {
  it('has a scenario for every MCP tool and every web route', async () => {
    const t = setup();
    const listed = await t.mcp(t.token(t.alice), 'tools/list');
    const tools = (listed.body.result.tools as { name: string }[]).map((tool) => tool.name);
    assert.ok(tools.length > 0);
    // `ALL /*` and `ALL /ui/*` are middleware (host check, headers, sign-in), not pages.
    const registered = createRelay(t.klatsch, t.secret).routes.filter((route) => !route.path.endsWith('*'));
    const routes = [...new Set(registered.map((route) => `${route.method} ${route.path}`))];
    assert.ok(routes.length > 0);

    const missing = [
      // A tool counts only where an agent calls it: `call('pending')`, not the word in some other string.
      ...tools.filter((name) => !scenarios.some((source) => source.includes(`call('${name}'`))).map((name) => `tool \`${name}\``),
      ...routes
        .filter((route) => !NO_SCENARIO.has(route))
        .filter((route) => {
          const [method, path] = route.split(' ') as [string, string];
          return !covered(method, path);
        })
        .map((route) => `route ${route}`),
    ];
    assert.deepEqual(missing, [], `No end-to-end scenario covers: ${missing.join(', ')} — add one under test/e2e/`);
    for (const route of NO_SCENARIO) assert.ok(routes.includes(route), `${route} is allowlisted but no longer exists; remove it from NO_SCENARIO`);
  });
});
