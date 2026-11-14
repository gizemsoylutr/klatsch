// UI coverage: every web route a person reaches in a browser must have been opened by a UI scenario,
// as a page (GET) or as the form a real button posted (POST). Checked only when every spec file ran,
// so `npx playwright test invites` does not fail for routes it never meant to visit.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRelay } from '../../src/relay/app.ts';
import { setup } from '../helpers.ts';
import { VISITED } from './people.ts';

// Routes no browser opens; keep this short and say why for each.
const NOT_IN_A_BROWSER = new Set([
  // The agents' endpoint, driven by the real MCP client in every scenario, never by a page.
  'ALL /mcp',
  // Plain text for assistants that read a site before suggesting it (test/e2e/oauth.e2e.ts).
  // What a browser fetches for notifications and the home screen, not as a page: the worker, the manifest, its
  // icon, and the subscription the script posts, which needs a real push service (test/e2e/push.e2e.ts).
  'GET /ui/sw.js',
  'GET /ui/manifest.webmanifest',
  'GET /ui/icon.svg',
  'POST /ui/push/subscribe',
  'GET /llms.txt',
  // The side of `klatsch connect` that waits in the terminal: JSON, refused with an Origin, so no page can use it.
  'POST /ui/connect/start',
  'POST /ui/connect/poll',
  // OAuth's machine side: discovery documents, registration and the token endpoint, called by the app's server
  // (test/e2e/oauth.e2e.ts). The person's side, the consent page, is opened in a browser.
  'ALL /.well-known/oauth-protected-resource/mcp',
  'ALL /.well-known/oauth-authorization-server',
  'GET /.well-known/oauth-protected-resource',
  'OPTIONS /oauth/register',
  'POST /oauth/register',
  'OPTIONS /oauth/token',
  'POST /oauth/token',
]);

const pattern = (path: string) =>
  new RegExp(`^${path.split('/').map((part) => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/').replace(/\/$/, '')}/?$`);

export default function globalTeardown() {
  const specs = readdirSync(import.meta.dirname).filter((file) => file.endsWith('.spec.ts'));
  const records = existsSync(VISITED)
    ? readFileSync(VISITED, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { spec: string; route: string })
    : [];
  const ran = new Set(records.map((r) => r.spec));
  const notRun = specs.filter((spec) => !ran.has(spec));
  if (notRun.length) {
    console.log(`UI coverage not checked: ${notRun.join(', ')} did not open a page in this run.`);
    return;
  }
  const t = setup();
  const routes = [...new Set(createRelay(t.klatsch, t.secret).routes.filter((r) => !r.path.endsWith('*')).map((r) => `${r.method} ${r.path}`))];
  const visited = new Set(records.map((r) => r.route));
  const missing = routes
    .filter((route) => !NOT_IN_A_BROWSER.has(route))
    .filter((route) => {
      const [method, path] = route.split(' ') as [string, string];
      const re = pattern(path);
      return ![...visited].some((v) => {
        const [vm, vp] = v.split(' ') as [string, string];
        return (method === 'ALL' || vm === method) && re.test(vp);
      });
    });
  for (const route of NOT_IN_A_BROWSER) if (!routes.includes(route)) missing.push(`${route} is allowlisted but no longer exists`);
  if (missing.length) throw new Error(`No UI scenario opened: ${missing.join(', ')} — add a step under test/ui/`);
  console.log(`UI coverage: all ${routes.length - NOT_IN_A_BROWSER.size} browser routes were opened by a scenario.`);
}
