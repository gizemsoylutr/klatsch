// The pieces every end-to-end scenario is built from: a real relay on a free port, browsers that sign in
// through login links and keep their cookie, and agents on the real MCP client (protocol 2026-07-28).
import { registerClient } from '../../src/auth/oauth.ts';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Client, SdkHttpError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Hono } from 'hono';
import { createTransport } from 'nodemailer';
import { createToken } from '../../src/auth/tokens.ts';
import type { Operator } from '../../src/copy/legal.ts';
import { createLoginLink } from '../../src/auth/web-sessions.ts';
import { loadConfig, type GitHub, type Google } from '../../src/config.ts';
import { seedVocabulary } from '../../src/match/vocabulary.ts';
import { confirmationMailer, emailNotifier, signInMailer, type MailTransport } from '../../src/notify/email.ts';
import { createRelay } from '../../src/relay/app.ts';
import { Klatsch, type Notifier } from '../../src/service.ts';
import { openDb } from '../../src/store/db.ts';

/** Approval codes as the relay draws them; an agent with a dialog must never see one. */
export const CODE = /[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}/;

export interface Mail {
  to: { address: string }[];
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
}

/**
 * A relay of its own for one scenario, with an empty database. With `mail`, it sends real
 * messages (built by nodemailer's JSON transport, never delivered) into `mails`. `approvalWaitMs`
 * is how long a tool call waits for a human who opened the page; shorten it where nobody decides.
 * With `dbFile` and `secret` the relay keeps its data on disk, so a second relay on them is a restart.
 * With `github`, "Sign in with GitHub" talks to the stand-in it returns for the relay's URL (test/github-fake.ts).
 */
export async function startRelay(
  options: { mail?: boolean; approvalWaitMs?: number; dbFile?: string; secret?: Buffer; github?: (base: string) => GitHub; google?: (base: string) => Google; operator?: Operator } = {},
) {
  // Listen first, then build the relay for the port we got: no race for a free port between scenarios.
  let relay: Hono | undefined;
  const server = serve({ fetch: (request) => relay!.fetch(request), hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const config = loadConfig({
    dataDir: '/nonexistent',
    port,
    publicUrl: base,
    approvalWaitMs: options.approvalWaitMs ?? 5000,
    ...(options.github ? { github: options.github(base) } : {}),
    ...(options.google ? { google: options.google(base) } : {}),
    ...(options.operator ? { operator: options.operator } : {}),
  });
  const db = openDb(options.dbFile ?? ':memory:');
  seedVocabulary(db);
  const secret = options.secret ?? randomBytes(32);
  const notifications: string[] = [];
  const mails: Mail[] = [];
  const json = createTransport({ jsonTransport: true });
  const transport: MailTransport = {
    async sendMail(message) {
      const info = await json.sendMail(message);
      mails.push(JSON.parse(info.message));
      return info;
    },
  };
  let mailNotify: Notifier = () => {};
  const klatsch = new Klatsch(
    db,
    config,
    (user, message) => {
      notifications.push(`@${user.handle}: ${message}`);
      mailNotify(user, message);
    },
    options.mail ? confirmationMailer(transport, 'klatsch@relay.test') : undefined,
    options.mail ? signInMailer(transport, 'klatsch@relay.test') : undefined,
  );
  if (options.mail) mailNotify = emailNotifier(db, transport, 'klatsch@relay.test', () => base);
  relay = createRelay(klatsch, secret);

  const close = async () => {
    server.close();
    db.close();
  };
  /** A one-time login link, as `klatsch login` prints it. */
  const loginLink = (userId: string) => createLoginLink(db, secret, userId, base);
  /** An agent token, as `klatsch connect` hands it to Claude Code. */
  const agentToken = (userId: string) => createToken(db, secret, userId, { ttlDays: 1 }).token;
  /**
   * The token a chat app gets by OAuth (ChatGPT by default): its client registered redirect URIs on the app's own
   * host only, which is what lets the relay show cards in the chat to it and to no agent.
   */
  const chatAppToken = (userId: string, redirect = 'https://chatgpt.com/connector_platform_oauth_redirect') => {
    const client = registerClient(db, { client_name: 'ChatGPT', redirect_uris: [redirect] }) as { client_id: string };
    return createToken(db, secret, userId, { ttlDays: 1, label: `oauth:${client.client_id}`, agent: { clients: [], project: 'ChatGPT' } }).token;
  };
  /** Waits for mail sent after a request returned (nodemailer builds it asynchronously). */
  const mailCount = async (count: number) => {
    for (let i = 0; i < 200 && mails.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    return mails.length;
  };

  return { base, db, secret, klatsch, notifications, mails, mailCount, loginLink, agentToken, chatAppToken, close };
}

export type Relay = Awaited<ReturnType<typeof startRelay>>;

/** A browser: follows a login link, keeps the cookie, posts forms the way a page does (with Origin and the form token). */
export async function browser(relay: Relay, loginLink: string) {
  const login = await fetch(loginLink, { redirect: 'manual' });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const get = async (target: string) => {
    const response = await fetch(new URL(target, relay.base), { headers: { Cookie: cookie }, redirect: 'manual' });
    return { status: response.status, html: await response.text() };
  };
  const csrf = (await get('/ui')).html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? '';
  const post = async (target: string, form: Record<string, string> = {}) => {
    const response = await fetch(new URL(target, relay.base), {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: cookie, Origin: relay.base, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, ...form }).toString(),
    });
    return { status: response.status, html: await response.text() };
  };
  /** A multipart form with files, as a page's file input sends it. */
  const upload = async (target: string, files: { name: string; bytes: Uint8Array; type?: string }[], fields: Record<string, string> = {}) => {
    const body = new FormData();
    body.set('csrf', csrf);
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    for (const f of files) body.append('file', new Blob([new Uint8Array(f.bytes)], { type: f.type ?? 'application/octet-stream' }), f.name);
    const response = await fetch(new URL(target, relay.base), { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: relay.base }, body });
    return { status: response.status, html: await response.text() };
  };
  /** The raw response, for files. */
  const fetchRaw = (target: string) => fetch(new URL(target, relay.base), { headers: { Cookie: cookie }, redirect: 'manual' });
  return { get, post, upload, fetchRaw, loginStatus: login.status };
}

export type Browser = Awaited<ReturnType<typeof browser>>;

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * A browser that starts without a session and signs in some other way (GitHub): it keeps the cookies the
 * relay sets (and drops the ones it deletes), follows redirects one by one, also through GitHub and back,
 * and posts forms with the form token of the last page it saw.
 */
export function signedOutBrowser(relay: Relay) {
  const jar = new Map<string, string>();
  let csrf = '';
  const request = async (url: string, init: RequestInit = {}) => {
    const ours = url.startsWith(relay.base);
    const headers = new Headers(init.headers);
    if (ours && jar.size) headers.set('Cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await fetch(url, { ...init, headers, redirect: 'manual' });
    if (ours) {
      for (const cookie of response.headers.getSetCookie()) {
        const [pair = '', ...attributes] = cookie.split(';');
        const [name = '', value = ''] = pair.split('=');
        if (!value || attributes.some((a) => /^\s*max-age=0$/i.test(a))) jar.delete(name);
        else jar.set(name, value);
      }
    }
    return response;
  };
  /** Opens `url` and follows every redirect; `hops` lists the URLs on the way (GitHub's authorize page among them). */
  const go = async (url: string, init: RequestInit = {}) => {
    let at = new URL(url, relay.base).toString();
    const hops = [at];
    let response = await request(at, init);
    for (let i = 0; i < 10 && REDIRECT.has(response.status); i++) {
      at = new URL(response.headers.get('location') ?? '/', at).toString();
      hops.push(at);
      response = await request(at);
    }
    const html = await response.text();
    csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? csrf;
    return { status: response.status, url: at, html, hops };
  };
  const post = (target: string, form: Record<string, string> = {}) =>
    go(target, {
      method: 'POST',
      headers: { Origin: relay.base, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, ...form }).toString(),
    });
  return { go, post, request, jar };
}

export type SignedOutBrowser = ReturnType<typeof signedOutBrowser>;

export interface Dialog {
  message: string;
  url?: string;
}

/**
 * An agent: the MCP client Claude Code uses. With dialogs (the default) the client opens the approval
 * page it is sent to and `onPage` is the person who looks at it; without, the client declares no
 * elicitation and gets a code to show instead.
 */
export async function agent(relay: Relay, token: string, options: { onPage?: (url: string) => Promise<void>; dialogs?: boolean; cards?: boolean } = {}) {
  const dialogs: Dialog[] = [];
  const client = new Client(
    { name: 'e2e-agent', version: '0' },
    {
      capabilities: {
        ...(options.dialogs === false ? {} : { elicitation: { form: {}, url: {} } }),
        // A chat app that shows MCP Apps cards (ChatGPT, Claude).
        ...(options.cards ? { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } : {}),
      },
      versionNegotiation: { mode: 'auto' },
    },
  );
  if (options.dialogs !== false) {
    client.setRequestHandler('elicitation/create', async (request) => {
      const params = request.params as { message?: string; url?: string };
      dialogs.push({ message: String(params.message ?? ''), ...(params.url ? { url: params.url } : {}) });
      if (params.url) await options.onPage?.(params.url);
      return { action: 'accept' as const };
    });
  }
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${relay.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { structuredContent?: any; content?: { text?: string }[]; isError?: boolean; _meta?: Record<string, any> };
    const text = result.content?.[0]?.text ?? '';
    return { data: result.structuredContent ?? (result.isError ? JSON.parse(text) : {}), text, isError: Boolean(result.isError), raw: JSON.stringify(result), meta: result._meta ?? {} };
  };
  return { call, dialogs, listTools: () => client.listTools(), readResource: (uri: string) => client.readResource({ uri }), close: () => client.close() };
}

/**
 * An MCP client at the wire level, as Claude Code speaks protocol 2026-07-28: each request carries the
 * client's capabilities in `_meta`. With `tasks`, it asks server/discover first and adds the tasks
 * extension only if the relay lists it, as a real client does. Used where the SDK client has no surface
 * (a `resultType: "task"` answer, tasks/get, tasks/cancel). Returns the JSON-RPC message.
 */
export function wireAgent(base: string, token: string, options: { tasks?: boolean } = {}) {
  let id = 0;
  let tasks: boolean | undefined = options.tasks ? undefined : false;
  const send = async (method: string, params: Record<string, unknown>, extensions: boolean) => {
    const name = typeof params.name === 'string' ? params.name : typeof params.taskId === 'string' ? params.taskId : undefined;
    const capabilities = { elicitation: { url: {} }, ...(extensions ? { extensions: { 'io.modelcontextprotocol/tasks': {} } } : {}) };
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method,
        ...(name ? { 'Mcp-Name': name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'wire-agent', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': capabilities,
          },
        },
      }),
    });
    const text = await response.text();
    const line = text.trimStart().startsWith('{') ? text : (text.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? '{}');
    return JSON.parse(line) as { result?: any; error?: { code: number; message: string } };
  };
  return async (method: string, params: Record<string, unknown> = {}) => {
    if (tasks === undefined) {
      const discovered = await send('server/discover', {}, false);
      tasks = Boolean(discovered.result?.capabilities?.extensions?.['io.modelcontextprotocol/tasks']);
    }
    return send(method, params, tasks);
  };
}

/** How a call fails when the relay no longer accepts the agent's token. */
export const unauthorized = (error: unknown) => error instanceof SdkHttpError && error.status === 401;

/** The person at the approval page the client opened: reads it, then decides. Returns what they saw. */
export function personAt(person: Browser, decision: 'approved' | 'declined') {
  const seen: { status: number; html: string }[] = [];
  const onPage = async (url: string) => {
    const page = await person.get(url);
    seen.push(page);
    if (page.status === 200) await person.post(`${new URL(url).pathname}/decide`, { decision });
  };
  return { onPage, seen };
}
