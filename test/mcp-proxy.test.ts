import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { saveAgentToken } from '../src/agent-token.ts';
import { events, MAX_MESSAGE, NO_ANSWER, NOT_CONNECTED, protocolHeaders, runProxy, UNREACHABLE } from '../src/mcp-proxy.ts';

const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'klatsch-proxy-')));
const TOKEN = `klt_${'C'.repeat(43)}`;
const ENVELOPE = (version = '2026-07-28') => ({ _meta: { 'io.modelcontextprotocol/protocolVersion': version } });

/** A stand-in relay on a free port: `handle` answers each request; every request is recorded. */
async function fakeRelay(handle: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const seen: { url: string; headers: IncomingMessage['headers']; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk)).on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body });
      handle(req, res, body);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Runs the proxy for these stdin lines against a directory connected to `url`; returns what it wrote. */
async function proxy(lines: unknown[], url?: string, relayFlag?: string) {
  const data = fresh();
  const dir = fresh();
  if (url) saveAgentToken(data, dir, { url, token: TOKEN });
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => (text += chunk));
  await runProxy(data, dir, Readable.from(lines.map((line) => `${typeof line === 'string' ? line : JSON.stringify(line)}\n`)), output, relayFlag);
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id?: unknown; result?: any; error?: { code: number; message: string } });
}

async function collect(chunks: string[]) {
  const out: unknown[] = [];
  for await (const message of events(Readable.from(chunks.map((c) => Buffer.from(c))))) out.push(message);
  return out;
}

describe('klatsch mcp-proxy', () => {
  it('derives the protocol headers from the message, and refuses values that are no header token', () => {
    assert.deepEqual(protocolHeaders({ method: 'tools/call', params: { name: 'inbox', ...ENVELOPE() } }, undefined), {
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'inbox',
    });
    assert.deepEqual(protocolHeaders({ method: 'tools/list', params: ENVELOPE() }, undefined), { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' });
    assert.deepEqual(protocolHeaders({ method: 'initialize', params: {} }, '2025-06-18'), {}, 'initialize names no version header');
    assert.deepEqual(protocolHeaders({ method: 'tools/list', params: {} }, '2025-06-18'), { 'MCP-Protocol-Version': '2025-06-18' });
    // Names are encoded as the SDK does: plain ASCII as is, anything else (or outer blanks) as base64.
    const name = (value: string) => protocolHeaders({ method: 'tools/call', params: { name: value, ...ENVELOPE() } }, undefined)!['Mcp-Name'];
    assert.equal(name('a b'), 'a b');
    assert.equal(name('ü'), `=?base64?${Buffer.from('ü').toString('base64')}?=`);
    assert.equal(name(' x'), `=?base64?${Buffer.from(' x').toString('base64')}?=`);
    assert.equal(name(''), '=?base64??=');
    assert.equal(name('=?base64?x?='), `=?base64?${Buffer.from('=?base64?x?=').toString('base64')}?=`);
    assert.equal(protocolHeaders({ method: 'tools/call\r\nX: y', params: ENVELOPE() }, undefined), undefined);
    assert.equal(protocolHeaders({ method: 'tools/list', params: ENVELOPE('2026 07') }, undefined), undefined);
  });

  it('reads event streams with any line ending, data over several lines, and events split across chunks', async () => {
    assert.deepEqual(await collect(['data: {"a":1}\r\n\r\n', 'event: message\r\ndata: {"b":\r\ndata: 2}\r\n\r\n']), [{ a: 1 }, { b: 2 }]);
    assert.deepEqual(await collect(['data: {"a"', ':1}\n', '\n: ping\n\ndata: {"c":3}\r', '\n\r', '\n']), [{ a: 1 }, { c: 3 }]);
    assert.deepEqual(await collect(['data: {"a":1}\r\rdata: {"b":2}']), [{ a: 1 }, { b: 2 }], 'CR endings, and a last event without a blank line');
    assert.deepEqual(await collect([': ping\n\n']), []);
    await assert.rejects(collect([`data: ${'x'.repeat(MAX_MESSAGE)}`, 'y']), 'an event over the cap ends the stream');
  });

  it('answers a request the relay left unanswered (a stream with only a ping) with a fixed error, once', async () => {
    const relay = await fakeRelay((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(': ping\n\n');
    });
    const out = await proxy([{ jsonrpc: '2.0', id: 7, method: 'tools/list', params: ENVELOPE() }, { jsonrpc: '2.0', method: 'notifications/x', params: ENVELOPE() }], relay.base);
    await relay.close();
    assert.deepEqual(out, [{ jsonrpc: '2.0', id: 7, error: { code: -32603, message: NO_ANSWER } }], 'the notification gets nothing');
  });

  it('passes the answer through, and only that one', async () => {
    const relay = await fakeRelay((_req, res, body) => {
      const { id } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\ndata: {"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"ok":true}}\n\n`);
    });
    const out = await proxy([{ jsonrpc: '2.0', id: 'a', method: 'tools/list', params: ENVELOPE() }], relay.base);
    await relay.close();
    assert.deepEqual(out, [{ jsonrpc: '2.0', method: 'notifications/progress', params: {} }, { jsonrpc: '2.0', id: 'a', result: { ok: true } }]);
    assert.equal(relay.seen[0]!.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(relay.seen[0]!.headers['mcp-method'], 'tools/list');
  });

  it('follows no redirect, so the token never reaches another address', async () => {
    const elsewhere = await fakeRelay((_req, res) => res.end('{}'));
    const relay = await fakeRelay((_req, res) => {
      res.writeHead(307, { Location: `${elsewhere.base}/mcp` });
      res.end();
    });
    const out = await proxy([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: ENVELOPE() }], relay.base);
    await relay.close();
    await elsewhere.close();
    assert.deepEqual(out, [{ jsonrpc: '2.0', id: 1, error: { code: -32603, message: UNREACHABLE } }]);
    assert.equal(elsewhere.seen.length, 0, 'nothing was sent to the redirect target');
  });

  it('without a token file it answers at once and calls nothing; a header it cannot send is an invalid request', async () => {
    assert.deepEqual(await proxy([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]), [{ jsonrpc: '2.0', id: 1, error: { code: -32603, message: NOT_CONNECTED } }]);
    const relay = await fakeRelay((_req, res) => res.end('{}'));
    const out = await proxy([{ jsonrpc: '2.0', id: 2, method: 'tools/list\nX', params: ENVELOPE() }, 'not json'], relay.base);
    await relay.close();
    assert.deepEqual(out, [
      { jsonrpc: '2.0', id: 2, error: { code: -32600, message: 'Invalid request' } },
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    ]);
    assert.equal(relay.seen.length, 0);
  });

  it('with --url, a directory connected to another relay counts as not connected: its token is never sent', async () => {
    const relay = await fakeRelay((_req, res) => res.end('{}'));
    const out = await proxy([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: ENVELOPE() }], relay.base, 'https://klatsch.dev');
    await relay.close();
    assert.deepEqual(out, [{ jsonrpc: '2.0', id: 1, error: { code: -32603, message: NOT_CONNECTED } }]);
    assert.equal(relay.seen.length, 0);
  });
});
