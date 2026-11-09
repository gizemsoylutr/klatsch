import { keyedHash, newId, randomToken } from '../crypto.ts';
import type { Db } from '../store/db.ts';

const CONFIRMATION_TTL = 24 * 60 * 60 * 1000;
// Each link is a mail to an address nobody has confirmed yet; a few a day is enough for typos.
const MAX_PER_DAY = 3;

export interface EmailConfirmation {
  id: string;
  email: string;
}

/**
 * A link that proves the person can read mail at the address they entered: random, sent only to
 * that address, stored only as an HMAC with the server secret, single use, 24 hours.
 * Undefined once the user asked for MAX_PER_DAY links in the last 24 hours.
 */
export function createEmailConfirmation(db: Db, secret: Buffer, userId: string, email: string, publicUrl: string): string | undefined {
  const now = Date.now();
  const recent = db.prepare('SELECT count(*) AS n FROM email_confirmations WHERE user_id = ? AND created_at > ?').get(userId, now - CONFIRMATION_TTL) as {
    n: number;
  };
  if (recent.n >= MAX_PER_DAY) return undefined;
  const token = randomToken(32);
  db.prepare('INSERT INTO email_confirmations (id, user_id, email, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    newId('emc'),
    userId,
    email,
    keyedHash(secret, token),
    now,
    now + CONFIRMATION_TTL,
  );
  return `${publicUrl}/ui/email/confirm/${token}`;
}

/** An unused, unexpired link of this user for the address they have on file, still unconfirmed; anything else is not found. */
export function findEmailConfirmation(db: Db, secret: Buffer, token: string, userId: string): EmailConfirmation | undefined {
  const row = db
    .prepare(
      `SELECT c.id, c.email FROM email_confirmations c JOIN users u ON u.id = c.user_id
       WHERE c.token_hash = ? AND c.user_id = ? AND c.used_at IS NULL AND c.expires_at > ?
         AND u.email = c.email AND u.email_verified_at IS NULL`,
    )
    .get(keyedHash(secret, token), userId, Date.now()) as EmailConfirmation | undefined;
  return row && { id: row.id, email: row.email };
}

/** Marks the link used; false if it was used, expired or replaced meanwhile. */
export function claimEmailConfirmation(db: Db, confirmationId: string): boolean {
  const now = Date.now();
  const result = db.prepare('UPDATE email_confirmations SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?').run(now, confirmationId, now);
  return result.changes > 0;
}
