import { keyedHash, newId, randomToken } from '../crypto.ts';
import type { Db } from '../store/db.ts';
import { cancelWatchesOfRevokedTokens } from '../watches.ts';

export const SCOPES = ['card:write', 'matches:read', 'inbox:read', 'intro:request', 'intro:respond', 'thanks:write'] as const;
export type Scope = (typeof SCOPES)[number];

const PREFIX = 'klt_';
const DAY = 24 * 60 * 60 * 1000;

export interface VerifiedToken {
  tokenId: string;
  userId: string;
  scopes: Scope[];
  expiresAt: number;
}

const CLIENT_NAME = /^[a-z][a-z-]{0,31}$/;
const FOLDER_CHARS = 64;

/**
 * A project folder's name as the Tokens page may show it: the last path segment only (a full path would tell
 * the relay how this machine is laid out), without control, format or other invisible characters, at most
 * 64 characters. Empty when nothing visible is left.
 */
export function folderName(value: string): string {
  const last = value.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  return [...last.normalize('NFC').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').trim()].slice(0, FOLDER_CHARS).join('');
}

/**
 * Agent tokens: random, shown once, stored only as an HMAC keyed with the
 * server secret. They carry agent scopes only; nothing an agent holds can
 * approve a sip or an intro. `agent` is what `klatsch connect` knows the token serves: the clients (names
 * of the form connect uses; anything else is dropped) and the project folder, of which only its name is kept.
 */
export function createToken(
  db: Db,
  secret: Buffer,
  userId: string,
  options: { ttlDays: number; scopes?: readonly Scope[]; label?: string; agent?: { clients: readonly string[]; project: string } },
): { token: string; tokenId: string; expiresAt: number } {
  const token = PREFIX + randomToken(32);
  const tokenId = newId('tok');
  const now = Date.now();
  const expiresAt = now + options.ttlDays * DAY;
  const clients = [...new Set(options.agent?.clients.filter((name) => CLIENT_NAME.test(name)))].slice(0, 8);
  const project = options.agent ? folderName(options.agent.project) : '';
  db.prepare(
    'INSERT INTO tokens (id, user_id, hash, scopes, expires_at, created_at, label, clients, project) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    tokenId,
    userId,
    keyedHash(secret, token),
    JSON.stringify(options.scopes ?? SCOPES),
    expiresAt,
    now,
    options.label ?? null,
    clients.length ? JSON.stringify(clients) : null,
    project || null,
  );
  return { token, tokenId, expiresAt };
}

export function verifyToken(db: Db, secret: Buffer, token: string): VerifiedToken | undefined {
  if (!token.startsWith(PREFIX)) return undefined;
  const row = db
    .prepare('SELECT id, user_id, scopes, expires_at, revoked_at FROM tokens WHERE hash = ?')
    .get(keyedHash(secret, token)) as
    | { id: string; user_id: string; scopes: string; expires_at: number; revoked_at: number | null }
    | undefined;
  if (!row || row.revoked_at !== null || row.expires_at <= Date.now()) return undefined;
  return { tokenId: row.id, userId: row.user_id, scopes: JSON.parse(row.scopes), expiresAt: row.expires_at };
}

export function revokeToken(db: Db, userId: string, tokenId: string): boolean {
  const result = db
    .prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .run(Date.now(), tokenId, userId);
  cancelWatchesOfRevokedTokens(db);
  return result.changes > 0;
}

/** Revokes every live token of a user, or only those made for one label (a directory). Returns how many. */
export function revokeTokens(db: Db, userId: string, label?: string): number {
  const result = db
    .prepare('UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND (? IS NULL OR label = ?) AND revoked_at IS NULL')
    .run(Date.now(), userId, label ?? null, label ?? null);
  cancelWatchesOfRevokedTokens(db);
  return Number(result.changes);
}

export type TokenListing = {
  id: string;
  /** What the Tokens page names the token by: the project folder's name, else its label (`web:<date>`). */
  name: string | null;
  clients: string[];
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
};

/**
 * For the human's web session: what a token is for and whether it still works, never the token or its hash.
 * A label `connect` made before it recorded the folder (`dir:<path>`) is named by the folder's name too.
 */
export function tokensOf(db: Db, userId: string): TokenListing[] {
  const rows = db
    .prepare('SELECT id, label, clients, project, created_at, expires_at, revoked_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as { id: string; label: string | null; clients: string | null; project: string | null; created_at: number; expires_at: number; revoked_at: number | null }[];
  return rows.map(({ label, clients, project, ...row }) => ({
    ...row,
    name: project ?? (label?.startsWith('dir:') ? folderName(label.slice(4)) || null : label),
    clients: clients ? (JSON.parse(clients) as string[]) : [],
  }));
}

/**
 * For a hosted relay: the Klatsch CLI keeps the token in a 0600 file, read from stdin so it stays out of the shell
 * history. `client` as `connect --client` takes it.
 */
export function connectCommand(publicUrl: string, client?: string): string {
  return `npx klatsch connect --url ${publicUrl} --token -${client ? ` --client ${client}` : ''}`;
}

export function mcpAddCommand(publicUrl: string, token: string): string {
  // Local scope: the server is registered for this directory only, so two demo sessions do not overwrite each other.
  return `claude mcp add --scope local --transport http klatsch ${publicUrl}/mcp --header "Authorization: Bearer ${token}"`;
}
