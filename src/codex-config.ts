import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './atomic-write.ts';
import { TOOL_NAMES, removeFile } from './claude-settings.ts';

/**
 * What `klatsch connect --client codex` adds to a directory's `.codex/config.toml`, and disconnect takes out
 * again. Project-scoped, not `~/.codex/config.toml`: Codex reads `.codex/` from every folder between the
 * project root and the folder it starts in, for trusted projects only, so each connected directory keeps its
 * own server entry with its own token file, as with Claude Code.
 *
 * The entry is one block between two marker comments, appended at the end of the file: the MCP server with
 * `http_headers_helper` (Codex runs it through `sh -c` and reads a JSON object of headers, the same as Claude
 * Code's headersHelper) and `approval_mode = "approve"` for exactly the Klatsch tools. Klatsch owns only
 * that block; no TOML parser is needed to write or remove it. A file that already defines a `klatsch` server
 * some other way, or `mcp_servers` as an inline table (a table header after it would be invalid), is refused.
 */
const BEGIN = '# >>> klatsch: added by `klatsch connect --client codex`; `klatsch disconnect --client codex` removes it';
const END = '# <<< klatsch';
const BLOCK = /\n?# >>> klatsch:[^\n]*\n[\s\S]*?\n# <<< klatsch(?:\n|$)/;

export const codexConfigPath = (dir: string) => join(dir, '.codex', 'config.toml');
export const codexHooksPath = (dir: string) => join(dir, '.codex', 'hooks.json');

/** A TOML basic string. JSON's escapes are a subset of TOML's; DEL is the one control character JSON leaves bare. */
const tomlString = (value: string) => JSON.stringify(value).replace(/\x7f/g, '\\u007f');

const keyPath = (key: string) => key.split('.').map((part) => part.trim().replace(/^(["'])(.*)\1$/, '$2'));

/** Whether the TOML (without our block) defines a `klatsch` server or makes `mcp_servers` an inline table. Line based: a match inside a multi-line string refuses too much, never too little that Codex would not report. */
function conflict(toml: string): string | undefined {
  let table: string[] = [];
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = keyPath(header[1]!);
      if (table[0] === 'mcp_servers' && table[1] === 'klatsch') return 'already has a klatsch MCP server that klatsch connect did not add';
      continue;
    }
    const assignment = /^\s*((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=/.exec(line);
    if (!assignment) continue;
    const path = [...table, ...keyPath(assignment[1]!)];
    if (path[0] === 'mcp_servers' && path[1] === 'klatsch') return 'already has a klatsch MCP server that klatsch connect did not add';
    if (path.length === 1 && path[0] === 'mcp_servers') return 'defines mcp_servers inline, so no server can be added after it';
  }
  return undefined;
}

/** The config text without the Klatsch block; everything else byte for byte. */
export function withoutKlatschToml(toml: string): string {
  return toml.replace(BLOCK, '');
}

/** The config text with one Klatsch block at the end, replacing an earlier one; refuses a file it cannot safely add to. */
export function withKlatschToml(toml: string, url: string, helper: string): string {
  const rest = withoutKlatschToml(toml);
  const problem = conflict(rest);
  if (problem) throw new Error(`${problem}.`);
  const lines = [BEGIN, '[mcp_servers.klatsch]', `url = ${tomlString(url)}`, `http_headers_helper = ${tomlString(helper)}`];
  for (const tool of TOOL_NAMES) lines.push('', `[mcp_servers.klatsch.tools.${tool}]`, 'approval_mode = "approve"');
  lines.push(END, '');
  // A blank line between their last line and the block; removing the block takes that line with it.
  const head = !rest ? '' : `${rest}${rest.endsWith('\n') ? '' : '\n'}\n`;
  return head + lines.join('\n');
}

/** True when the config has the Klatsch block. */
export const hasKlatschToml = (toml: string) => BLOCK.test(toml);

export function readToml(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Changes `.codex/config.toml` in one atomic write, keeping its mode; deletes it (and an empty `.codex/`) when nothing else is left. */
export function updateToml(path: string, change: (toml: string) => string): void {
  let next: string;
  try {
    next = change(readToml(path));
  } catch (error) {
    throw new Error(`${path} ${(error as Error).message} Fix it, then run this again.`);
  }
  if (!next.trim()) return removeFile(path, true);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, next, existsSync(path) ? statSync(path).mode & 0o777 : 0o644);
}
