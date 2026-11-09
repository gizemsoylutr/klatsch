import { keyedHash, newId, randomToken } from '../crypto.ts';
import type { Db } from '../store/db.ts';
import { newCode } from './approvals.ts';
import { createToken } from './tokens.ts';

/**
 * `klatsch connect --url <relay>` without a token (the device flow of RFC 8628, as for approvals): the command
 * gets a secret device code it keeps and a short code the person types in their own signed-in session. They
 * read what it means and decide; the command then collects a new agent token, once. The token is made at
 * that moment, so it is never stored; of the codes only keyed hashes are.
 *
 * The code is typed, never carried in a link: someone who sends a victim a link could otherwise get a token
 * for the victim's account with a single click (RFC 8628, section 5.4).
 */

const TTL_MS = 10 * 60 * 1000;
export const CONNECT_INTERVAL_S = 3;
const MAX_OPEN = 1000;
/** The clients `klatsch connect --client` takes. Nothing else is shown on the page. */
const CLIENT = /^(claude|codex|copilot-vscode|copilot-cli)$/;

export interface ConnectRequest {
  id: string;
  client: string;
  expiresAt: number;
}

const deviceHash = (secret: Buffer, device: string) => keyedHash(secret, `klatsch-connect-device:${device}`);
const codeHash = (secret: Buffer, code: string) => keyedHash(secret, `klatsch-connect-code:${code}`);

/** A new request, or undefined for an unknown client or when too many are open. */
export function startConnect(db: Db, secret: Buffer, client: string): { device: string; code: string; expiresAt: number } | undefined {
  if (!CLIENT.test(client)) return undefined;
  const now = Date.now();
  db.prepare('DELETE FROM connect_requests WHERE expires_at < ?').run(now);
  const open = db.prepare('SELECT COUNT(*) AS n FROM connect_requests').get() as { n: number };
  if (open.n >= MAX_OPEN) return undefined;
  const device = randomToken(32);
  const expiresAt = now + TTL_MS;
  const insert = db.prepare(`INSERT INTO connect_requests (id, device_hash, code_hash, client, state, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`);
  for (let attempt = 0; ; attempt++) {
    const code = newCode();
    try {
      insert.run(newId('con'), deviceHash(secret, device), codeHash(secret, code), client, now, expiresAt);
      return { device, code, expiresAt };
    } catch (error) {
      if (attempt >= 4 || !String((error as Error).message).includes('UNIQUE')) throw error;
    }
  }
}

/** An open request by the code a person typed. Unknown, decided and expired ones are all absent. */
export function findConnect(db: Db, secret: Buffer, code: string): ConnectRequest | undefined {
  const row = db.prepare(`SELECT id, client, expires_at FROM connect_requests WHERE code_hash = ? AND state = 'pending' AND expires_at > ?`).get(codeHash(secret, code), Date.now()) as
    | { id: string; client: string; expires_at: number }
    | undefined;
  return row && { id: row.id, client: row.client, expiresAt: row.expires_at };
}

/** One decision: true when this call made it. */
export function decideConnect(db: Db, id: string, userId: string, allow: boolean): boolean {
  const result = db
    .prepare(`UPDATE connect_requests SET state = ?, user_id = ? WHERE id = ? AND state = 'pending' AND expires_at > ?`)
    .run(allow ? 'approved' : 'declined', userId, id, Date.now());
  return result.changes > 0;
}

export type ConnectOutcome = { state: 'pending' | 'declined' | 'expired' } | { state: 'connected'; token: string; tokenId: string; userId: string };

/**
 * What the waiting command hears. The token comes out once: the row is claimed in the same statement, so a
 * second poll, or one that lost the race, finds nothing. A request whose person has since left every circle
 * gets none (`inCircle`).
 */
export function pollConnect(db: Db, secret: Buffer, device: string, ttlDays: number, inCircle: (userId: string) => boolean): ConnectOutcome {
  const hash = deviceHash(secret, device);
  const row = db.prepare('SELECT id, client, state, user_id, expires_at FROM connect_requests WHERE device_hash = ?').get(hash) as
    | { id: string; client: string; state: string; user_id: string | null; expires_at: number }
    | undefined;
  if (!row || row.state === 'collected' || row.expires_at <= Date.now()) return { state: 'expired' };
  if (row.state === 'declined') return { state: 'declined' };
  if (row.state === 'pending') return { state: 'pending' };
  const userId = row.user_id!;
  if (!inCircle(userId)) return { state: 'declined' };
  const claimed = db.prepare(`UPDATE connect_requests SET state = 'collected' WHERE id = ? AND state = 'approved'`).run(row.id);
  if (!claimed.changes) return { state: 'expired' };
  const day = new Date().toISOString().slice(0, 10);
  // No folder name: a hosted connect tells the relay nothing about this machine (a folder can name a customer).
  const { token, tokenId } = createToken(db, secret, userId, { ttlDays, label: `connect:${day}`, agent: { clients: [row.client], project: '' } });
  return { state: 'connected', token, tokenId, userId };
}
