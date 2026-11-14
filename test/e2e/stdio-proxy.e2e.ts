// GitHub Copilot (VS Code and the CLI) cannot get a header from a command, so `klatsch connect --client
// copilot-*` registers `klatsch mcp-proxy`: a stdio MCP server that forwards each message to the relay with
// the directory's token from its 0600 file. Here the real MCP client talks to the relay through it, on
// protocol 2026-07-28 (approval page opened from a dialog) and on 2025-06-18 (a code), and a revoked token
// gets a fixed answer, never the token.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { saveAgentToken } from '../../src/agent-token.ts';
import { revokeTokens } from '../../src/auth/tokens.ts';
import { browser, CODE, personAt, startRelay, type Browser, type Relay } from './harness.ts';

const CLI = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'klatsch-proxy-e2e-')));
const ALICE_TEXT = 'My Node.js API on Postgres returns every row at once.';
/** Every client started, closed after the scenario even when a step failed: an open proxy keeps the run alive. */
const clients: Client[] = [];

/** The MCP client as Copilot runs it: the proxy as a stdio server, with the command connect wrote. */
async function proxied(data: string, dir: string, options: { modern: boolean; onPage?: (url: string) => Promise<void> }) {
  let stderr = '';
  const client = new Client(
    { name: 'copilot-like', version: '0' },
    options.modern ? { capabilities: { elicitation: { form: {}, url: {} } }, versionNegotiation: { mode: 'auto' } } : { capabilities: {} },
  );
  if (options.modern) client.setRequestHandler('elicitation/create', async (request) => {
    const url = (request.params as { url?: string }).url;
    if (url) await options.onPage?.(url);
    return { action: 'accept' as const };
  });
  clients.push(client);
  const transport = new StdioClientTransport({ command: 'node', args: [CLI, 'mcp-proxy', '--data', data, '--dir', dir], stderr: 'pipe' });
  transport.stderr?.on('data', (chunk) => (stderr += chunk));
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { structuredContent?: any; content?: { text?: string }[]; isError?: boolean };
    return { data: result.structuredContent ?? {}, raw: JSON.stringify(result) };
  };
  return { client, call, stderr: () => stderr };
}

describe('the stdio proxy for clients without a header helper (Copilot)', () => {
  let relay: Relay;
  let aliceBrowser: Browser;
  let alice = '';
  const data = fresh();
  const modernDir = fresh();
  const legacyDir = fresh();
  const tokens: string[] = [];

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('demo', alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    for (const dir of [modernDir, legacyDir]) {
      const token = relay.agentToken(alice);
      tokens.push(token);
      saveAgentToken(data, dir, { url: relay.base, token });
    }
  });
  after(async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    await relay.close();
  });

  it('on 2026-07-28 the client sees the tools, and the approval page opens from the dialog', async () => {
    const person = personAt(aliceBrowser, 'approved');
    const agent = await proxied(data, modernDir, { modern: true, onPage: person.onPage });
    const tools = (await agent.client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, ['answer_ask', 'ask_person', 'find_matches', 'friends', 'inbox', 'pending', 'request_intro', 'respond_intro', 'thank_note', 'update_card', 'watch']);
    const shared = await agent.call('update_card', { status: 'looking', tags: ['nodejs', 'express'], summary: ALICE_TEXT, ask_for_intro: false });
    assert.equal(person.seen.length, 1, 'the client opened the approval page');
    assert.equal(person.seen[0]!.status, 200);
    assert.doesNotMatch(shared.raw, CODE, 'a page was opened, so the agent gets no code');
    assert.match(JSON.stringify(shared.data), /shared/i);
    const pending = await agent.call('pending');
    assert.equal(typeof pending.data.introRequests, 'number');
    await agent.client.close();
    for (const token of tokens) assert.ok(!agent.stderr().includes(token));
  });

  it('on 2025-06-18 the approval falls back to a code the person types', async () => {
    const agent = await proxied(data, legacyDir, { modern: false });
    const asked = await agent.call('update_card', { status: 'looking', tags: ['nodejs', 'postgres'], summary: ALICE_TEXT, ask_for_intro: false });
    assert.equal(asked.data.state, 'pending-approval');
    assert.match(asked.data.code, CODE);
    assert.equal((await aliceBrowser.post('/ui/device', { code: asked.data.code })).status, 200);
    assert.equal((await aliceBrowser.post('/ui/device/decide', { code: asked.data.code, decision: 'approved' })).status, 200);
    await agent.client.close();
  });

  it('a revoked token gets a fixed answer, and the token never shows', async () => {
    const agent = await proxied(data, legacyDir, { modern: false });
    revokeTokens(relay.db, alice);
    const refused = await agent.client.callTool({ name: 'pending', arguments: {} }).then(
      () => '',
      (error: Error) => error.message,
    );
    assert.match(refused, /refused this directory's token/);
    for (const token of tokens) assert.ok(!refused.includes(token) && !agent.stderr().includes(token));
    await agent.client.close();
  });
});
