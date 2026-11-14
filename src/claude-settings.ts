import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './atomic-write.ts';

/**
 * What `klatsch connect` adds to a directory's `.claude/settings.local.json`, and `klatsch disconnect`
 * takes out again, leaving everything else in the file as it was.
 *
 * - A UserPromptSubmit `command` hook that prints the pending reminder. Not an `mcp_tool` hook: Claude Code
 *   does not pass such a hook's output to the model, and skips it while the server is still connecting.
 * - Allow rules for the Klatsch tools, so Claude Code (also in auto mode) does not ask before each call.
 *   None of them shares, introduces or reveals anything by itself: what does is decided by the human on
 *   the approval page. `thank_note` adds +1 to an author's count, within bounds the human set (a switch,
 *   once per note, a daily limit, undo on Home). The rule only skips Claude Code's own prompt.
 *   Disconnecting removes these rules even if the person had added them by hand.
 */
/** The Klatsch tools every client may call without its own prompt (see docs/security-model.md for why that is safe). */
export const TOOL_NAMES = ['update_card', 'find_matches', 'request_intro', 'respond_intro', 'ask_person', 'answer_ask', 'friends', 'pending', 'inbox', 'watch', 'thank_note'];
export const KLATSCH_TOOLS = TOOL_NAMES.map((tool) => `mcp__klatsch__${tool}`);

/** Marks the hook command as ours, so reconnecting replaces it and disconnecting finds it. */
export const HOOK_MARK = ' pending --hook';
/** Marks the status line command as ours. */
export const STATUS_MARK = ' status-line ';

type Settings = Record<string, unknown>;
type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isOurs = (hook: unknown) =>
  isObject(hook) &&
  ((hook.type === 'mcp_tool' && hook.server === 'klatsch') || (hook.type === 'command' && typeof hook.command === 'string' && hook.command.includes(HOOK_MARK)));

/**
 * The hooks file (Claude Code's settings, Codex's hooks.json: the same `hooks.UserPromptSubmit` shape) without
 * the Klatsch hook (also an older `mcp_tool` one); containers it emptied go too. Shapes it does not expect
 * (null, a string where a list was) are left exactly as they are.
 */
export function withoutKlatschHook(settings: Settings): Settings {
  const next = structuredClone(settings);
  const hooks = next.hooks;
  if (isObject(hooks) && Array.isArray(hooks.UserPromptSubmit)) {
    const kept = hooks.UserPromptSubmit.map((g: unknown) => (isObject(g) && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g)).filter(
      (g: unknown) => !(isObject(g) && Array.isArray(g.hooks) && !g.hooks.length),
    );
    if (kept.length) hooks.UserPromptSubmit = kept;
    else delete hooks.UserPromptSubmit;
    if (!Object.keys(hooks).length) delete next.hooks;
  }
  return next;
}

/** The hooks file with one Klatsch hook running `hookCommand`; idempotent. */
export function withKlatschHook(settings: Settings, hookCommand: string): Settings {
  const next = withoutKlatschHook(settings);
  if (next.hooks !== undefined && !isObject(next.hooks)) throw new Error('"hooks" in the settings is not an object.');
  const hooks = (next.hooks ??= {}) as Json;
  if (hooks.UserPromptSubmit !== undefined && !Array.isArray(hooks.UserPromptSubmit)) throw new Error('"hooks.UserPromptSubmit" in the settings is not a list.');
  ((hooks.UserPromptSubmit ??= []) as unknown[]).push({ hooks: [{ type: 'command', command: hookCommand, timeout: 10 }] });
  return next;
}

/** True when the hooks file has the Klatsch hook: that client is connected in this directory. */
export const hasKlatschHook = (settings: Settings): boolean =>
  isObject(settings.hooks) && Array.isArray(settings.hooks.UserPromptSubmit) && settings.hooks.UserPromptSubmit.some((g) => isObject(g) && Array.isArray(g.hooks) && g.hooks.some(isOurs));

const isOurStatusLine = (value: unknown) => isObject(value) && typeof value.command === 'string' && value.command.includes(STATUS_MARK);

/** A status line someone else put there, which connect must not replace. */
export const hasOtherStatusLine = (settings: Settings): boolean => settings.statusLine !== undefined && !isOurStatusLine(settings.statusLine);

/** The settings showing Klatsch's status line. Only ever called when no other one is set. */
export const withStatusLine = (settings: Settings, command: string): Settings => ({ ...settings, statusLine: { type: 'command', command, padding: 0 } });

/** The settings without anything Klatsch put there: the hook, the allow rules and its status line. */
export function withoutKlatsch(settings: Settings): Settings {
  const next = withoutKlatschHook(settings);
  if (isOurStatusLine(next.statusLine)) delete next.statusLine;
  const permissions = next.permissions;
  if (isObject(permissions) && Array.isArray(permissions.allow)) {
    permissions.allow = permissions.allow.filter((rule) => !KLATSCH_TOOLS.includes(rule as string));
    if (!(permissions.allow as unknown[]).length) delete permissions.allow;
    if (!Object.keys(permissions).length) delete next.permissions;
  }
  return next;
}

/** The settings with one Klatsch hook running `hookCommand` and the allow rules; idempotent. */
export function withKlatsch(settings: Settings, hookCommand: string): Settings {
  const next = withKlatschHook(withoutKlatsch(settings), hookCommand);
  // Reconnecting keeps a status line the person asked for earlier.
  if (isOurStatusLine(settings.statusLine)) next.statusLine = settings.statusLine;
  if (next.permissions !== undefined && !isObject(next.permissions)) throw new Error('"permissions" in the settings is not an object.');
  const permissions = (next.permissions ??= {}) as Json;
  if (permissions.allow !== undefined && !Array.isArray(permissions.allow)) throw new Error('"permissions.allow" in the settings is not a list.');
  const allow = (permissions.allow ??= []) as unknown[];
  for (const rule of KLATSCH_TOOLS) if (!allow.includes(rule)) allow.push(rule);
  return next;
}

export const settingsPath = (dir: string) => join(dir, '.claude', 'settings.local.json');

/** A JSON settings file as an object ({} when missing), or a clear error naming the file, before anything is changed anywhere. */
export function readJsonObject(path: string): Settings {
  if (!existsSync(path)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON: fix or delete it, then run this again.`);
  }
  if (!isObject(value)) throw new Error(`${path} is not a JSON object: fix or delete it, then run this again.`);
  return value;
}

/**
 * Changes a JSON settings file in one atomic write, keeping the file's mode. With `dropEmpty`, a file the
 * change leaves empty is deleted (connect created it), and with 'folder' also its folder (`.codex/`,
 * `.vscode/`) when nothing else is in it.
 */
export function updateJsonFile(path: string, change: (settings: Settings) => Settings, dropEmpty?: 'file' | 'folder'): void {
  let next: Settings;
  try {
    next = change(readJsonObject(path));
  } catch (error) {
    throw new Error(error instanceof Error && error.message.startsWith(path) ? error.message : `${path}: ${(error as Error).message} Fix or delete it, then run this again.`);
  }
  if (dropEmpty && !Object.keys(next).length) return removeFile(path, dropEmpty === 'folder');
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, existsSync(path) ? statSync(path).mode & 0o777 : 0o644);
}

/** Deletes a file connect wrote, and with `folder` its folder if that is now empty (rmdir removes only an empty one). */
export function removeFile(path: string, folder: boolean): void {
  rmSync(path, { force: true });
  if (!folder) return;
  try {
    rmdirSync(dirname(path));
  } catch {}
}

/** The directory's Claude Code settings, or a clear error naming the file, before anything is changed anywhere. */
export const readSettings = (dir: string): Settings => readJsonObject(settingsPath(dir));

/** Changes `dir/.claude/settings.local.json` in one atomic write, keeping the file's mode. */
export const updateSettings = (dir: string, change: (settings: Settings) => Settings): void => updateJsonFile(settingsPath(dir), change);
