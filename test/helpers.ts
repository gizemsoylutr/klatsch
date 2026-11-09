import { randomBytes } from 'node:crypto';
import { createToken, type Scope } from '../src/auth/tokens.ts';
import { createLoginLink } from '../src/auth/web-sessions.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { seedVocabulary } from '../src/match/vocabulary.ts';
import { createRelay } from '../src/relay/app.ts';
import { Klatsch, type ConfirmationMailer, type Notifier, type SignInMailer } from '../src/service.ts';
import { openDb } from '../src/store/db.ts';

export const BASE = 'http://127.0.0.1:7417';

export function setup(options: { notify?: Notifier; mailer?: ConfirmationMailer; signInMailer?: SignInMailer; config?: Partial<Config> } = {}) {
  const config = loadConfig({ dataDir: '/nonexistent', approvalWaitMs: 300, ...options.config });
  const db = openDb(':memory:');
  seedVocabulary(db);
  const secret = randomBytes(32);
  const notifications: string[] = [];
  const notify: Notifier = (user, message) => {
    notifications.push(`${user.handle}: ${message}`);
    options.notify?.(user, message);
  };
  const klatsch = new Klatsch(db, config, notify, options.mailer, options.signInMailer);
  const relay = createRelay(klatsch, secret);
  // Real HTTP requests always carry Host; Hono's in-process request() does not.
  const app = {
    request: (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (!headers.has('Host')) headers.set('Host', new URL(url).host);
      return relay.request(url, { ...init, headers });
    },
  };
  const alice = klatsch.ensureUser('alice', 'Alice');
  const bob = klatsch.ensureUser('bob', 'Bob');
  const circle = klatsch.ensureCircle('test', alice);
  klatsch.addMember(circle, bob, alice);
  const token = (userId: string, scopes?: Scope[]) =>
    createToken(db, secret, userId, { ttlDays: 1, ...(scopes ? { scopes } : {}) }).token;

  async function mcp(bearer: string | undefined, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    const response = await app.request(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await response.text();
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    return { status: response.status, headers: response.headers, raw: text, body: data[0] ?? (text ? safeJson(text) : undefined) };
  }

  async function tool(bearer: string, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
    const result = await mcp(bearer, 'tools/call', { name, arguments: args }, headers);
    const payload = result.body?.result;
    return { ...result, isError: Boolean(payload?.isError), data: payload?.structuredContent ?? safeJson(payload?.content?.[0]?.text) };
  }

  /** A logged-in human browser: follows the login link and keeps the cookie and the form token. */
  async function human(userId: string) {
    const link = createLoginLink(db, secret, userId, config.publicUrl);
    const login = await app.request(link);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const page = async () => (await app.request(`${BASE}/ui`, { headers: { Cookie: cookie } })).text();
    const settings = async () => (await app.request(`${BASE}/ui/settings`, { headers: { Cookie: cookie } })).text();
    const csrf = (await page()).match(/name="csrf" value="([^"]+)"/)?.[1] ?? '';
    const post = (path: string, form: Record<string, string> = { csrf }, headers: Record<string, string> = {}) =>
      app.request(`${BASE}${path}`, {
        method: 'POST',
        // Browsers send Origin on every form post; the UI refuses posts without it.
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, ...headers },
        body: new URLSearchParams(form).toString(),
      });
    /** Enter a code at /ui/device and decide, as the human would. Returns both responses. */
    const enterCode = async (code: string, decision: 'approved' | 'declined' = 'approved') => {
      const confirm = await post('/ui/device', { csrf, code });
      const confirmPage = await confirm.text();
      const decided = confirm.status === 200 ? await post('/ui/device/decide', { csrf, code, decision }) : undefined;
      return { confirm, confirmPage, decided };
    };
    /** Open an approval link (as the MCP client would, in this human's browser) and decide. */
    const openApproval = async (url: string, decision: 'approved' | 'declined' = 'approved') => {
      const opened = await app.request(url, { headers: { Cookie: cookie } });
      const html = await opened.text();
      const decided = opened.status === 200 ? await post(`${new URL(url).pathname}/decide`, { csrf, decision }) : undefined;
      return { opened, html, decided };
    };
    return { link, cookie, csrf, page, settings, post, enterCode, openApproval };
  }

  return { app, db, secret, config, klatsch, circle, alice, bob, token, mcp, tool, human, notifications };
}

function safeJson(text: unknown): any {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
