import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';

import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.ts';
import { checkPendingCounts, pendingReminder, statusText, type PendingCounts } from './copy/agent.ts';

/**
 * The agent token of one connected directory, at rest: one file per directory under the Klatsch data dir
 * (`agents/<hash of the directory>.token`, file 0600, folder 0700), holding the relay URL and the token.
 * Claude Code gets the header from it through `headersHelper` (`klatsch token-header`), and the reminder
 * hook reads it to ask the relay, so the token is in no Claude Code config and on no command line.
 */
export interface AgentToken {
  url: string;
  token: string;
}

export function agentTokenPath(dataDir: string, dir: string): string {
  const key = createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 32);
  return join(dataDir, 'agents', `${key}.token`);
}

export function saveAgentToken(dataDir: string, dir: string, value: AgentToken): void {
  const path = agentTokenPath(dataDir, dir);
  const folder = join(dataDir, 'agents');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  // A new 0600 file renamed over the old one: never readable by others, never half written.
  writeFileAtomic(path, `${JSON.stringify(value)}\n`, 0o600);
}

export function readAgentToken(dataDir: string, dir: string): AgentToken | undefined {
  try {
    const value = JSON.parse(readFileSync(agentTokenPath(dataDir, dir), 'utf8')) as Partial<AgentToken>;
    return typeof value.url === 'string' && typeof value.token === 'string' ? { url: value.url, token: value.token } : undefined;
  } catch {
    return undefined;
  }
}

const origin = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/**
 * The directory's token, only for the relay that asks for it: `relay` is the one a client config names
 * (`--url`), `server` the MCP server URL Claude Code names to a header helper. A token is never handed to a
 * server it was not made for (a plugin's klatsch.dev server in a directory connected to another relay).
 */
export function agentTokenFor(dataDir: string, dir: string, relay?: string, server?: string): AgentToken | undefined {
  const agent = readAgentToken(dataDir, dir);
  if (!agent) return undefined;
  if (relay !== undefined && (origin(relay) === undefined || origin(relay) !== origin(agent.url))) return undefined;
  if (server !== undefined && server !== `${agent.url}/mcp`) return undefined;
  return agent;
}

/** True when there was a file to remove. */
export function removeAgentToken(dataDir: string, dir: string): boolean {
  const path = agentTokenPath(dataDir, dir);
  rmSync(statusCachePath(dataDir, dir), { force: true });
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

const MAX_BODY = 64 * 1024;
const REQUEST_ID = 1;

/** The response body, or undefined past `MAX_BODY`: a relay cannot flood the hook. */
async function boundedText(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The JSON-RPC response to our request: the plain JSON body, or the SSE `data:` line with our id. */
function rpcResponse(body: string): { id?: unknown; result?: { isError?: boolean; structuredContent?: unknown } } | undefined {
  const candidates = body.trimStart().startsWith('{') ? [body] : body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
  for (const candidate of candidates) {
    try {
      const message = JSON.parse(candidate) as { id?: unknown };
      if (message.id === REQUEST_ID) return message;
    } catch {}
  }
  return undefined;
}

/**
 * The reminder for the hook. It calls the relay's `pending` tool once over HTTP(S) with the directory's
 * token, so a hosted relay works as well as a local one, takes only the counts from the answer, checks
 * them and renders the text itself from src/copy: no text from the server reaches the agent's context.
 * Empty, without any network call, when the directory has no token; empty on a redirect, a body over
 * 64 KB, anything that does not check out, any error, or after `timeoutMs`.
 */
export async function hookReminder(dataDir: string, dir: string, timeoutMs = 2000): Promise<string> {
  const counts = await pendingCounts(dataDir, dir, timeoutMs);
  return counts ? pendingReminder(counts) : '';
}

const STATUS_TTL_MS = 30_000;
const statusCachePath = (dataDir: string, dir: string) => agentTokenPath(dataDir, dir).replace(/\.token$/, '.status');

/**
 * The Claude Code status line for a connected directory. A client runs it often, so the relay is asked at most
 * every 30 seconds; in between, the answer comes from a 0600 file holding numbers only. Empty on any error.
 */
export async function statusLine(dataDir: string, dir: string, timeoutMs = 1500): Promise<string> {
  try {
    if (!readAgentToken(dataDir, dir)) return '';
    const path = statusCachePath(dataDir, dir);
    let counts: PendingCounts | undefined;
    let fresh = false;
    try {
      const cached = JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown; counts?: unknown };
      if (typeof cached.at === 'number' && Date.now() - cached.at < STATUS_TTL_MS && Date.now() >= cached.at) {
        fresh = true;
        counts = checkPendingCounts(cached.counts);
      }
    } catch {}
    if (!fresh) {
      counts = await pendingCounts(dataDir, dir, timeoutMs);
      // Handles stay out of this file: the status line shows numbers only. A failure is remembered too, so a
      // relay that is down is not asked on every redraw.
      const numbers = counts && { ...counts, connectedWith: [], quotesFrom: [] };
      writeFileAtomic(path, `${JSON.stringify({ at: Date.now(), counts: numbers ?? null })}\n`, 0o600);
    }
    return counts ? statusText(counts) : '';
  } catch {
    return '';
  }
}

async function pendingCounts(dataDir: string, dir: string, timeoutMs: number): Promise<PendingCounts | undefined> {
  const agent = readAgentToken(dataDir, dir);
  if (!agent) return undefined;
  try {
    const response = await fetch(`${agent.url}/mcp`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${agent.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        // One stateless request, no session: the 2025 protocol needs no initialize for a single call.
        'MCP-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: REQUEST_ID, method: 'tools/call', params: { name: 'pending', arguments: {} } }),
    });
    if (!response.ok) return undefined;
    const body = await boundedText(response);
    const result = body === undefined ? undefined : rpcResponse(body)?.result;
    return result && !result.isError ? checkPendingCounts(result.structuredContent) : undefined;
  } catch {
    return undefined;
  }
}
