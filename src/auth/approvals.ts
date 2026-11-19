import { randomInt } from 'node:crypto';
import { keyedHash, newId } from '../crypto.ts';
import { sealText, type Db } from '../store/db.ts';

// RFC 8628 user-code alphabet: consonants only, no vowels (no accidental words), no 0/O or 1/I.
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const TTL_MS = 10 * 60 * 1000;

export type ApprovalAction = 'share_sip' | 'send_intro' | 'answer_intro' | 'ask_person' | 'answer_ask' | 'send_message';
export type ApprovalState = 'pending' | 'approved' | 'declined' | 'expired';

export interface Approval {
  id: string;
  userId: string;
  action: ApprovalAction;
  payload: Record<string, string>;
  state: ApprovalState;
  result: Record<string, unknown> | null;
  expiresAt: number;
}

interface Row {
  id: string;
  user_id: string;
  action: ApprovalAction;
  payload: string;
  state: 'pending' | 'approved' | 'declined';
  result: string | null;
  expires_at: number;
}

function toApproval(row: Row): Approval {
  const expired = row.state === 'pending' && row.expires_at <= Date.now();
  return {
    id: row.id,
    userId: row.user_id,
    action: row.action,
    payload: JSON.parse(row.payload),
    state: expired ? 'expired' : row.state,
    result: row.result ? JSON.parse(row.result) : null,
    expiresAt: row.expires_at,
  };
}

/** XXXX-XXXX from the alphabet: 20^8, about 34 bits; it only works in its owner's web session. */
export function newCode(): string {
  const chars = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

export function normalizeCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/**
 * An agent asks for one action; the human types the code shown in their
 * terminal into their own web session and approves it there. The code is
 * not a secret: it binds the terminal request to the approval page. What
 * the agent cannot reach is the human's session.
 */
const payloadKey = (secret: Buffer, json: string) => keyedHash(secret, `klatsch-approval-payload:${json}`);

export function createApproval(
  db: Db,
  secret: Buffer,
  userId: string,
  action: ApprovalAction,
  payload: Record<string, string>,
): { approval: Approval; code: string } {
  const id = newId('ap');
  const now = Date.now();
  // Decided and expired approvals are kept a day for the audit trail, then dropped (their codes free up).
  db.prepare('DELETE FROM approvals WHERE expires_at < ?').run(now - 24 * 60 * 60 * 1000);
  const insert = db.prepare(
    `INSERT INTO approvals (id, user_id, code_hash, action, payload, payload_key, state, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  );
  for (let attempt = 0; ; attempt++) {
    const code = newCode();
    try {
      const json = JSON.stringify(payload);
      insert.run(id, userId, keyedHash(secret, code), action, sealText(db, json), payloadKey(secret, json), now, now + TTL_MS);
      return { approval: getApproval(db, userId, id)!, code };
    } catch (error) {
      // A code may collide with another open one (codes are about 34 bits); draw a new one.
      if (attempt >= 4 || !String((error as Error).message).includes('UNIQUE')) throw error;
    }
  }
}

/**
 * The approval an agent's ask opens. The same ask (user, action, exact payload) while its approval is still
 * open reuses that approval: same id, same page, same expiry, with a fresh code, because only the code's
 * hash is kept. A different ask when `limit` approvals are already open gets nothing: the human decides
 * those first. Against approval fatigue, and against an agent flooding its human with requests.
 */
export function openApproval(
  db: Db,
  secret: Buffer,
  userId: string,
  action: ApprovalAction,
  payload: Record<string, string>,
  limit: number,
): { approval: Approval; code: string } | undefined {
  const now = Date.now();
  const json = JSON.stringify(payload);
  const same = db
    .prepare(`SELECT id FROM approvals WHERE user_id = ? AND action = ? AND payload_key = ? AND state = 'pending' AND expires_at > ? ORDER BY created_at LIMIT 1`)
    .get(userId, action, payloadKey(secret, json), now) as { id: string } | undefined;
  if (same) {
    for (let attempt = 0; ; attempt++) {
      const code = newCode();
      try {
        db.prepare('UPDATE approvals SET code_hash = ? WHERE id = ?').run(keyedHash(secret, code), same.id);
        return { approval: getApproval(db, userId, same.id)!, code };
      } catch (error) {
        if (attempt >= 4 || !String((error as Error).message).includes('UNIQUE')) throw error;
      }
    }
  }
  const open = (db.prepare(`SELECT count(*) AS n FROM approvals WHERE user_id = ? AND state = 'pending' AND expires_at > ?`).get(userId, now) as { n: number }).n;
  return open >= limit ? undefined : createApproval(db, secret, userId, action, payload);
}

export function getApproval(db: Db, userId: string, id: string): Approval | undefined {
  const row = db.prepare('SELECT * FROM approvals WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
  return row && toApproval(row);
}

/** A code matches only a pending, unexpired approval of the same user. */
export function findByCode(db: Db, secret: Buffer, userId: string, input: string): Approval | undefined {
  const row = db
    .prepare(`SELECT * FROM approvals WHERE code_hash = ? AND user_id = ? AND state = 'pending' AND expires_at > ?`)
    .get(keyedHash(secret, normalizeCode(input)), userId, Date.now()) as Row | undefined;
  return row && toApproval(row);
}

/**
 * Single use: claims a pending, unexpired approval for a decision. Run it
 * before the action, in the same transaction, so an approval that expired or
 * was decided meanwhile never runs.
 */
export function claim(db: Db, userId: string, id: string, state: 'approved' | 'declined'): boolean {
  const now = Date.now();
  return (
    db
      .prepare(`UPDATE approvals SET state = ?, decided_at = ? WHERE id = ? AND user_id = ? AND state = 'pending' AND expires_at > ?`)
      .run(state, now, id, userId, now).changes > 0
  );
}

export function setResult(db: Db, id: string, result: Record<string, unknown>): void {
  db.prepare('UPDATE approvals SET result = ? WHERE id = ?').run(JSON.stringify(result), id);
}
