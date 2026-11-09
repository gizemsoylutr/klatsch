import { keyedHash, newId, randomToken } from '../crypto.ts';
import type { Db } from '../store/db.ts';

const INVITE_TTL = 7 * 24 * 60 * 60 * 1000;

export interface Invite {
  id: string;
  circleId: string;
  circleName: string;
  createdBy: string;
  createdAt: number;
  inviterName: string;
  inviterHandle: string;
}

/**
 * An invite into one circle: random, shown once to the inviter as a link,
 * stored only as an HMAC with the server secret, single use, seven days.
 */
export function createInvite(db: Db, secret: Buffer, circleId: string, userId: string, publicUrl: string): { inviteId: string; link: string } {
  const token = randomToken(32);
  const inviteId = newId('inv');
  const now = Date.now();
  db.prepare('INSERT INTO invites (id, circle_id, created_by, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    inviteId,
    circleId,
    userId,
    keyedHash(secret, token),
    now,
    now + INVITE_TTL,
  );
  return { inviteId, link: `${publicUrl}/ui/invite/${token}` };
}

/** An unused, unexpired invite whose inviter is still in the circle; anything else is simply not found. */
export function findInvite(db: Db, secret: Buffer, token: string): Invite | undefined {
  return validInvite(db, 'token_hash', keyedHash(secret, token));
}

/** The same, by the invite's id: what an email sign-in link asked for at an invite is bound to, never the invite's token. */
export function inviteById(db: Db, inviteId: string): Invite | undefined {
  return validInvite(db, 'id', inviteId);
}

function validInvite(db: Db, by: 'token_hash' | 'id', value: string): Invite | undefined {
  const row = db
    .prepare(
      `SELECT i.id, i.circle_id, c.name AS circle_name, i.created_by, i.created_at, u.display_name AS inviter_name, u.handle AS inviter_handle
       FROM invites i
       JOIN circles c ON c.id = i.circle_id
       JOIN users u ON u.id = i.created_by
       JOIN memberships m ON m.circle_id = i.circle_id AND m.user_id = i.created_by
       WHERE i.${by} = ? AND i.used_at IS NULL AND i.expires_at > ?`,
    )
    .get(value, Date.now()) as
    | { id: string; circle_id: string; circle_name: string; created_by: string; created_at: number; inviter_name: string; inviter_handle: string }
    | undefined;
  return (
    row && {
      id: row.id,
      circleId: row.circle_id,
      circleName: row.circle_name,
      createdBy: row.created_by,
      createdAt: row.created_at,
      inviterName: row.inviter_name,
      inviterHandle: row.inviter_handle,
    }
  );
}

/** Marks the invite used by `userId`; false if it was used or expired meanwhile, or its inviter left the circle. */
export function claimInvite(db: Db, inviteId: string, userId: string): boolean {
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE invites SET used_by = ?, used_at = ?
       WHERE id = ? AND used_at IS NULL AND expires_at > ?
         AND EXISTS (SELECT 1 FROM memberships m WHERE m.circle_id = invites.circle_id AND m.user_id = invites.created_by)`,
    )
    .run(userId, now, inviteId, now);
  return result.changes > 0;
}
