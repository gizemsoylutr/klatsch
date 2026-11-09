import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { agentTokenFor } from './agent-token.ts';

/**
 * `klatsch mcp-proxy`: a local stdio MCP server that forwards every message to the relay over streamable
 * HTTP with the directory's token from its 0600 file. For clients that can run a command but cannot get an
 * HTTP header from one (GitHub Copilot in VS Code and the Copilot CLI): their config then names this
 * command, never the token.
 *
 * It does not interpret MCP, it only carries messages: one JSON-RPC message per stdin line becomes one POST,
 * and whatever the relay answers (a JSON body, or each `data:` message of an event stream) becomes stdout
 * lines. The HTTP headers a protocol revision wants are derived from the message itself: on 2026-07-28 the
 * request's own `_meta` envelope names the version, `Mcp-Method` is its method and `Mcp-Name` the tool,
 * prompt, resource or task it names; on 2025 revisions the version `initialize` agreed on.
 */
const ENVELOPE_VERSION = 'io.modelcontextprotocol/protocolVersion';
const NAME_FIELD: Record<string, string> = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri', 'tasks/get': 'taskId', 'tasks/update': 'taskId', 'tasks/cancel': 'taskId' };
/** The most one answer or one event may be: a relay cannot make the proxy hold unbounded text. */
export const MAX_MESSAGE = 4 * 1024 * 1024;

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A plain token for a header (a method name, a protocol version); anything else is refused, not sent. */
const TOKEN_VALUE = /^[\x21-\x7e]+$/;

/** As the MCP SDK encodes a name for `Mcp-Name`: as is when it is plain ASCII without outer blanks, else `=?base64?…?=`. */
function headerValue(value: string): string {
  const plain = value.length > 0 && !(value.startsWith('=?base64?') && value.endsWith('?=')) && value === value.trim() && /^[\t\x20-\x7e]*$/.test(value);
  return plain ? value : `=?base64?${Buffer.from(value).toString('base64')}?=`;
}

/**
 * The protocol headers for one message; `negotiated` is the version a 2025 `initialize` agreed on. Undefined
 * when the message names a method or version that is no plain header token.
 */
export function protocolHeaders(message: Message, negotiated: string | undefined): Record<string, string> | undefined {
  const params = isObject(message.params) ? message.params : {};
  const claimed = isObject(params._meta) ? params._meta[ENVELOPE_VERSION] : undefined;
  if (typeof claimed === 'string' && typeof message.method === 'string') {
    if (!TOKEN_VALUE.test(claimed) || !TOKEN_VALUE.test(message.method)) return undefined;
    const field = NAME_FIELD[message.method];
    const name = field ? params[field] : undefined;
    return { 'MCP-Protocol-Version': claimed, 'Mcp-Method': message.method, ...(typeof name === 'string' ? { 'Mcp-Name': headerValue(name) } : {}) };
  }
  return negotiated && message.method !== 'initialize' ? { 'MCP-Protocol-Version': negotiated } : {};
}

class TooLarge extends Error {}

/** The JSON-RPC messages in an event stream (any line ending, `data:` over several lines), as they arrive. */
export async function* events(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  // Where the search for the end of the current event resumes, so a long event is not scanned again per chunk.
  let from = 0;
  const parse = (block: string) => {
    const data = block
      .split(/\r\n|\r|\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return undefined;
    try {
      return JSON.parse(data) as unknown;
    } catch {
      return undefined;
    }
  };
  const BOUNDARY = /\r\n\r\n|\n\n|\r\r/g;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      // Back up three characters: a boundary may have started in the part already searched.
      BOUNDARY.lastIndex = Math.max(0, from - 3);
      const end = BOUNDARY.exec(buffer);
      if (!end) break;
      const message = parse(buffer.slice(0, end.index));
      buffer = buffer.slice(end.index + end[0].length);
      from = 0;
      if (message !== undefined) yield message;
    }
    from = buffer.length;
    if (buffer.length > MAX_MESSAGE) throw new TooLarge();
  }
  const last = parse(buffer);
  if (last !== undefined) yield last;
}

/** A whole body as text, or TooLarge past `MAX_MESSAGE`. */
async function boundedText(body: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > MAX_MESSAGE) throw new TooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Fixed texts: nothing from a failed response reaches the agent. */
export const NOT_CONNECTED = 'This directory has no Klatsch token: run klatsch connect here.';
export const REFUSED = "The Klatsch relay refused this directory's token (revoked or expired): run klatsch connect here again.";
export const UNREACHABLE = 'The Klatsch relay could not be reached.';
export const NO_ANSWER = 'The Klatsch relay did not answer.';

/**
 * Runs the proxy until `input` ends and every forwarded message is answered. The token file is read for each
 * message, so a reconnect (a new token) takes effect without restarting the client. Every request gets
 * exactly one answer: the relay's, or a fixed error when the relay gave none. With `relay` (`--url`), a
 * directory connected to another relay counts as not connected: its token never goes to this one.
 */
export async function runProxy(
  dataDir: string,
  dir: string,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  relay?: string,
): Promise<void> {
  let negotiated: string | undefined;
  let session: string | undefined;
  const write = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);

  const forward = async (line: string): Promise<void> => {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      return void write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (!isObject(message)) return void write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    const isRequest = typeof message.method === 'string' && message.id !== undefined;
    let answered = false;
    // Only a request gets an answer, and only one: a notification or a response has nobody waiting.
    const fail = (code: number, text: string) => {
      if (isRequest && !answered) write({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
      answered = true;
    };
    const deliver = (answer: unknown) => {
      const ours = isRequest && isObject(answer) && answer.id === message.id && ('result' in answer || 'error' in answer);
      if (ours && message.method === 'initialize' && isObject(answer.result) && typeof answer.result.protocolVersion === 'string') negotiated = answer.result.protocolVersion;
      if (ours) answered = true;
      write(answer);
    };

    const headers = protocolHeaders(message, negotiated);
    if (!headers) return fail(-32600, 'Invalid request');
    const agent = agentTokenFor(dataDir, dir, relay);
    if (!agent) return fail(-32603, NOT_CONNECTED);
    try {
      const response = await fetch(`${agent.url}/mcp`, {
        method: 'POST',
        // The token goes to the relay's own origin only.
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${agent.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...headers,
          ...(session ? { 'Mcp-Session-Id': session } : {}),
        },
        body: line,
      });
      session = response.headers.get('mcp-session-id') ?? session;
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        return fail(-32603, REFUSED);
      }
      if (!response.body || response.status === 202) return fail(-32603, NO_ANSWER);
      if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
        for await (const answer of events(response.body)) deliver(answer);
        return fail(-32603, NO_ANSWER);
      }
      let answer: unknown;
      try {
        answer = JSON.parse(await boundedText(response.body));
      } catch {
        return fail(-32603, UNREACHABLE);
      }
      // A JSON-RPC error the relay answered (a bad request, an unsupported version) is the client's to read.
      if (isObject(answer) && answer.jsonrpc === '2.0') deliver(answer);
      fail(-32603, UNREACHABLE);
    } catch {
      fail(-32603, UNREACHABLE);
    }
  };

  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    // Each message on its own: a long answer (a watch, a waiting approval) must not hold up the next.
    const done = forward(line).finally(() => pending.delete(done));
    pending.add(done);
  }
  await Promise.all(pending);
}
