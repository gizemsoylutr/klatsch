import { keyedHash, randomToken } from '../crypto.ts';
import type { Db } from '../store/db.ts';

const LOGIN_TTL = 10 * 60 * 1000;
/** A web session ends 30 days after its last use, and 90 days after sign-in whatever happens. */
export const SESSION_IDLE = 30 * 24 * 60 * 60 * 1000;
export const SESSION_MAX = 90 * 24 * 60 * 60 * 1000;
/** Renewed at most once a day, so reading a page is not a write every time. */
const RENEW_AFTER = 24 * 60 * 60 * 1000;

/**
 * The human channel. A login link is printed to the human's terminal, used once,
 * and turns into a cookie session; so does a finished GitHub sign-in. Agent tokens
 * never open a web session.
 */
export function createLoginLink(db: Db, secret: Buffer, userId: string, publicUrl: string): string {
  const token = randomToken(32);
  db.prepare('INSERT INTO web_logins (hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    keyedHash(secret, token),
    userId,
    Date.now() + LOGIN_TTL,
  );
  return `${publicUrl}/ui/login?t=${token}`;
}

export function consumeLogin(db: Db, secret: Buffer, token: string): { session: string; csrf: string; userId: string } | undefined {
  const hash = keyedHash(secret, token);
  const row = db
    .prepare('UPDATE web_logins SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id')
    .get(Date.now(), hash, Date.now()) as { user_id: string } | undefined;
  return row && { ...startSession(db, secret, row.user_id), userId: row.user_id };
}

/** A new web session: the cookie value and the form token. Only its keyed hash is stored. */
export function startSession(db: Db, secret: Buffer, userId: string): { session: string; csrf: string } {
  const session = randomToken(32);
  const csrf = randomToken(24);
  const now = Date.now();
  // A fresh sign-in: Home may open the browser's passkey dialog by itself, once (`takeFirstHome`).
  db.prepare('INSERT INTO web_sessions (hash, user_id, csrf, created_at, expires_at, offer_pending) VALUES (?, ?, ?, ?, ?, 1)').run(
    keyedHash(secret, session),
    userId,
    csrf,
    now,
    now + SESSION_IDLE,
  );
  return { session, csrf };
}

/** True the first time it is asked for a session, false ever after: Home's first load after this sign-in. */
export function takeFirstHome(db: Db, secret: Buffer, session: string): boolean {
  return Boolean(db.prepare('UPDATE web_sessions SET offer_pending = 0 WHERE hash = ? AND offer_pending = 1 RETURNING 1').get(keyedHash(secret, session)));
}

/**
 * The session behind a cookie, renewed for another 30 days of no use (never past 90 days from sign-in).
 * `expiresAt` is set when it was renewed, for the cookie's new lifetime.
 */
export function readSession(db: Db, secret: Buffer, session: string): { userId: string; csrf: string; expiresAt?: number } | undefined {
  const hash = keyedHash(secret, session);
  const now = Date.now();
  const row = db
    .prepare('SELECT user_id, csrf, created_at, expires_at FROM web_sessions WHERE hash = ? AND expires_at > ?')
    .get(hash, now) as { user_id: string; csrf: string; created_at: number; expires_at: number } | undefined;
  if (!row) return undefined;
  const renewed = Math.min(now + SESSION_IDLE, row.created_at + SESSION_MAX);
  if (renewed - row.expires_at < RENEW_AFTER) return { userId: row.user_id, csrf: row.csrf };
  db.prepare('UPDATE web_sessions SET expires_at = ? WHERE hash = ?').run(renewed, hash);
  return { userId: row.user_id, csrf: row.csrf, expiresAt: renewed };
}

export function endSession(db: Db, secret: Buffer, session: string): void {
  db.prepare('DELETE FROM web_sessions WHERE hash = ?').run(keyedHash(secret, session));
}

/** "Sign out everywhere else": every session of the person but this one. Returns how many ended. */
export function endOtherSessions(db: Db, secret: Buffer, userId: string, session: string): number {
  return Number(db.prepare('DELETE FROM web_sessions WHERE user_id = ? AND hash != ?').run(userId, keyedHash(secret, session)).changes);
}

/** How many other browsers are signed in as the person now. */
export function otherSessions(db: Db, secret: Buffer, userId: string, session: string): number {
  return (db.prepare('SELECT count(*) n FROM web_sessions WHERE user_id = ? AND hash != ? AND expires_at > ?').get(userId, keyedHash(secret, session), Date.now()) as { n: number }).n;
}
