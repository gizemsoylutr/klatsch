import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { TOOL_NAMES } from './claude-settings.ts';

/**
 * What `klatsch connect --client copilot-vscode | copilot-cli` adds, and disconnect takes out again.
 *
 * Neither GitHub Copilot client can get an HTTP header from a command (Claude Code's `headersHelper`, Codex's
 * `http_headers_helper`); a remote server's header is a literal, an environment variable or a VS Code input
 * prompt, which the default Copilot harness in VS Code does not forward. So both get a local stdio server
 * instead, `klatsch mcp-proxy` (src/mcp-proxy.ts), which reads the directory's token from its 0600 file:
 * the configs name a command, never the token.
 *
 * - VS Code: `servers.klatsch` in the project's `.vscode/mcp.json` (VS Code's format).
 * - Copilot CLI: `mcpServers.klatsch` in the project's `.mcp.json`, which it reads from the working
 *   directory up to the repository root, in trusted folders; and saved approvals for exactly the Klatsch
 *   tools in `permissions-config.json` (`$COPILOT_HOME`, default `~/.copilot`), under the location the CLI
 *   scopes approvals to (the Git root, else the directory).
 *
 * VS Code has no setting that approves single MCP tools in advance; the person chooses "Always allow" in the
 * first confirmation instead. Neither client passes a prompt hook's output to the model (Copilot drops a
 * `userPromptSubmitted` hook's output), so there is no reminder hook.
 */
type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export const vscodeMcpPath = (dir: string) => join(dir, '.vscode', 'mcp.json');
export const copilotMcpPath = (dir: string) => join(dir, '.mcp.json');
export const copilotPermissionsPath = (env: NodeJS.ProcessEnv = process.env) => join(env.COPILOT_HOME || join(homedir(), '.copilot'), 'permissions-config.json');
/** Older Copilot CLI builds used this name; while it is the only one, a new `permissions-config.json` would hide it. */
export const legacyCopilotPermissionsPath = (env: NodeJS.ProcessEnv = process.env) => join(dirname(copilotPermissionsPath(env)), 'permissions-config');

/** The stdio server entry: `command` and `args` run `klatsch mcp-proxy` for one directory. */
export interface ProxyCommand {
  command: string;
  args: string[];
}

/** Ours when it runs `mcp-proxy`: reconnecting replaces it, disconnecting finds it, anything else is left alone. */
const isOurs = (entry: unknown) => isObject(entry) && Array.isArray(entry.args) && entry.args.includes('mcp-proxy');

function withoutServer(json: Json, key: string): Json {
  const next = structuredClone(json);
  const servers = next[key];
  if (isObject(servers) && isOurs(servers.klatsch)) {
    delete servers.klatsch;
    if (!Object.keys(servers).length) delete next[key];
  }
  return next;
}

function withServer(json: Json, key: string, entry: Json): Json {
  const next = withoutServer(json, key);
  if (next[key] !== undefined && !isObject(next[key])) throw new Error(`"${key}" is not an object.`);
  const servers = (next[key] ??= {}) as Json;
  if (servers.klatsch !== undefined) throw new Error(`already has a klatsch server that klatsch connect did not add; remove it first.`);
  servers.klatsch = entry;
  return next;
}

const hasServer = (json: Json, key: string) => isObject(json[key]) && isOurs(json[key].klatsch);

/** `.vscode/mcp.json`: the server in VS Code's own format. */
export const withVscodeServer = (json: Json, proxy: ProxyCommand) => withServer(json, 'servers', { type: 'stdio', ...proxy });
export const withoutVscodeServer = (json: Json) => withoutServer(json, 'servers');
export const hasVscodeServer = (json: Json) => hasServer(json, 'servers');

/**
 * `.mcp.json` for the Copilot CLI: `tools` is required there; `timeout` covers a call that waits for the
 * human's decision on the approval page (the relay waits two minutes).
 */
export function withCopilotServer(json: Json, proxy: ProxyCommand): Json {
  if (Object.keys(json).some((key) => key !== 'mcpServers')) throw new Error('lists servers without "mcpServers"; klatsch connect only adds to the "mcpServers" form.');
  return withServer(json, 'mcpServers', { type: 'stdio', ...proxy, tools: ['*'], timeout: 180_000 });
}
export const withoutCopilotServer = (json: Json) => withoutServer(json, 'mcpServers');
export const hasCopilotServer = (json: Json) => hasServer(json, 'mcpServers');

/** The location the Copilot CLI keys saved approvals by: the Git root above `dir`, else `dir`. */
export function copilotLocation(dir: string): string {
  const start = realpathSync(dir);
  for (let at = start; ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return at;
    if (dirname(at) === at) return start;
  }
}

const isOurApproval = (approval: unknown) => isObject(approval) && approval.kind === 'mcp' && approval.serverName === 'klatsch' && TOOL_NAMES.includes(approval.toolName as string);

/** `permissions-config.json` without the Klatsch tool approvals at `location`; containers it emptied go too. */
export function withoutCopilotApprovals(json: Json, location: string): Json {
  const next = structuredClone(json);
  const locations = next.locations;
  const here = isObject(locations) ? locations[location] : undefined;
  if (!isObject(locations) || !isObject(here) || !Array.isArray(here.tool_approvals)) return next;
  here.tool_approvals = here.tool_approvals.filter((approval) => !isOurApproval(approval));
  if (!(here.tool_approvals as unknown[]).length) delete here.tool_approvals;
  if (!Object.keys(here).length) delete locations[location];
  if (!Object.keys(locations).length) delete next.locations;
  return next;
}

/** `permissions-config.json` with one saved approval per Klatsch tool at `location`; idempotent. */
export function withCopilotApprovals(json: Json, location: string): Json {
  const next = withoutCopilotApprovals(json, location);
  if (next.locations !== undefined && !isObject(next.locations)) throw new Error('"locations" is not an object.');
  const locations = (next.locations ??= {}) as Json;
  if (locations[location] !== undefined && !isObject(locations[location])) throw new Error('this location is not an object.');
  const here = (locations[location] ??= {}) as Json;
  if (here.tool_approvals !== undefined && !Array.isArray(here.tool_approvals)) throw new Error('"tool_approvals" is not a list.');
  const approvals = (here.tool_approvals ??= []) as unknown[];
  for (const tool of TOOL_NAMES) approvals.push({ kind: 'mcp', serverName: 'klatsch', toolName: tool });
  return next;
}
