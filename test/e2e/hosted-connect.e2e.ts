// Connecting Claude Code to a hosted relay: the Tokens page shows `klatsch connect --url … --token -` and
// the token apart; the CLI reads the token from stdin into the directory's 0600 file and registers the MCP
// server with a headersHelper; the header that helper prints is what the agent calls the relay with.
// The relay runs as behind Caddy: plain HTTP on a local port, answering only for its https public host.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { serve } from '@hono/node-server';
import { agentTokenPath } from '../../src/agent-token.ts';
import { createLoginLink } from '../../src/auth/web-sessions.ts';
import { loadConfig } from '../../src/config.ts';
import { seedVocabulary } from '../../src/match/vocabulary.ts';
import { createRelay } from '../../src/relay/app.ts';
import { Klatsch } from '../../src/service.ts';
import { openDb } from '../../src/store/db.ts';

const PUBLIC = 'https://klatsch.test';
const CLI = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'klatsch-hosted-e2e-')));

describe('hosted connect: token from the Tokens page, connect with the CLI, agent calls the relay', () => {
  let server: Server;
  let port = 0;
  let cookie = '';
  let csrf = '';
  let token = '';
  let helper = '';
  let header: Record<string, string> = {};
  const data = fresh();
  const project = fresh();
  const bin = fresh();
  const log = join(bin, 'claude.log');

  /** One HTTP request as the proxy forwards it: to the relay's port, with the public host name as Host. */
  const send = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { Host: 'klatsch.test', ...init.headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8').on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      });
      req.on('error', reject);
      req.end(init.body);
    });
  const post = (path: string) =>
    send(path, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: PUBLIC, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf }).toString(),
    });

  before(async () => {
    const config = loadConfig({ dataDir: '/nonexistent', host: '0.0.0.0', publicUrl: PUBLIC });
    const db = openDb(':memory:');
    seedVocabulary(db);
    const secret = randomBytes(32);
    const klatsch = new Klatsch(db, config, () => {});
    const alice = klatsch.ensureUser('alice', 'Alice');
    klatsch.ensureCircle('demo', alice);
    const relay = createRelay(klatsch, secret);
    server = serve({ fetch: relay.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;

    const link = new URL(createLoginLink(db, secret, alice, PUBLIC));
    const login = await send(`${link.pathname}${link.search}`);
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
    csrf = (await send('/ui/tokens', { headers: { Cookie: cookie } })).text.match(/name="csrf" value="([^"]+)"/)?.[1] ?? '';

    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\n`);
    chmodSync(join(bin, 'claude'), 0o755);
  });
  after(() => {
    server.close();
  });

  it('the person picks their client on the Tokens page (Codex, Copilot) and sees the connect command for it', async () => {
    const codex = (await send('/ui/tokens?client=codex', { headers: { Cookie: cookie } })).text;
    assert.ok(codex.includes(`<code class="cmd">npx klatsch connect --url ${PUBLIC} --token - --client codex</code>`));
    const copilot = (await send('/ui/tokens?client=copilot', { headers: { Cookie: cookie } })).text;
    assert.ok(copilot.includes('--client copilot-vscode</code>') && copilot.includes('--client copilot-cli</code>'));
  });

  it('the Tokens page shows the connect command for this relay, with the token apart from it', async () => {
    const page = await post('/ui/tokens');
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(`<code class="cmd">npx klatsch connect --url ${PUBLIC} --token - --client claude</code>`));
    token = page.text.match(/<code class="cmd">(klt_[\w-]{43})<\/code>/)?.[1] ?? '';
    assert.ok(token);
    assert.doesNotMatch(page.text, /--token klt_/);
  });

  it('the person pastes the token into klatsch connect, which keeps it in a 0600 file and off every command line', () => {
    const connected = spawnSync('node', [CLI, 'connect', '--url', PUBLIC, '--token', '-', '--data', data], {
      cwd: project,
      input: `${token}\n`,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PWD: project },
    });
    assert.equal(connected.status, 0, connected.stderr);
    assert.doesNotMatch(connected.stdout + connected.stderr, /klt_/);
    assert.equal(statSync(agentTokenPath(data, project)).mode & 0o777, 0o600);
    const calls = readFileSync(log, 'utf8');
    assert.doesNotMatch(calls, /klt_/);
    const registered = JSON.parse(calls.split('\n').find((line) => line.startsWith('{'))!);
    assert.equal(registered.url, `${PUBLIC}/mcp`);
    helper = registered.headersHelper;
  });

  it('the agent gets its Authorization header from the headersHelper command', () => {
    header = JSON.parse(execFileSync('sh', ['-c', helper], { cwd: project, encoding: 'utf8' }));
    assert.deepEqual(header, { Authorization: `Bearer ${token}` });
  });

  it('the agent calls the relay with that header and is answered', async () => {
    const call = (authorization: Record<string, string>) =>
      send('/mcp', {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    const answered = await call(header);
    assert.equal(answered.status, 200);
    assert.match(answered.text, /"name":"pending"/);
    assert.equal((await call({})).status, 401, 'and nothing without it');
  });
});
