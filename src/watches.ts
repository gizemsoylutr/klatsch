import { randomBytes } from 'node:crypto';
import { transaction, type Db } from './store/db.ts';

/**
 * An agent waiting for something new for its human, served as an MCP task. Bound to the token that
 * started it: only that token can ask about it or cancel it, and revoking the token ends it. The id is
 * 128 random bits, so it is no handle to anyone else's watch. The result is the same content-free
 * reminder the `pending` tool gives.
 *
 * MCP on 2026-07-28 has no sessions, so a token has one watch, shared by every session that uses it
 * (one connected directory): a second `watch` returns the same task, and cancelling it ends it for all.
 */
export interface Watch {
  id: string;
  status: 'working' | 'completed' | 'cancelled';
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Events that complete a waiting watch, when someone else caused them (see `events.wakes`). The person's
 * own action does not wake them: they just did it, and their agent got the result in the same call.
 * A quote is the exception: the human sends it to their agent on purpose, from the web page.
 */
export const WAKES = ['match.new', 'intro.requested', 'intro.accepted', 'intro.declined', 'quote.received', 'ask.received', 'ask.answered', 'ask.declined', 'ask.question', 'ask.answer', 'message.received', 'message.thread'] as const;

export const WATCH_LIMIT_PER_USER = 5;
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_FINISHED_PER_TOKEN = 2;

interface Row {
  id: string;
  status: Watch['status'];
  result: string | null;
  created_at: number;
  updated_at: number;
}

const toWatch = (row: Row): Watch => ({ id: row.id, status: row.status, result: row.result, createdAt: row.created_at, updatedAt: row.updated_at });

/**
 * Keeps the table small: ends watches of tokens that no longer work, deletes finished watches after seven
 * days, and keeps at most two finished ones per token (enough for a client still polling the last one).
 */
function tidy(db: Db, now: number, tokenId?: string): void {
  db.prepare(
    `UPDATE watches SET status = 'cancelled', updated_at = ? WHERE status = 'working'
     AND token_id IN (SELECT id FROM tokens WHERE revoked_at IS NOT NULL OR expires_at <= ?)`,
  ).run(now, now);
  db.prepare(`DELETE FROM watches WHERE status != 'working' AND updated_at < ?`).run(now - KEEP_FINISHED_MS);
  if (tokenId) {
    db.prepare(
      `DELETE FROM watches WHERE token_id = ? AND status != 'working' AND id NOT IN
       (SELECT id FROM watches WHERE token_id = ? AND status != 'working' ORDER BY updated_at DESC LIMIT ?)`,
    ).run(tokenId, tokenId, KEEP_FINISHED_PER_TOKEN);
  }
}

const latestWake = (db: Db, userId: string): number =>
  (db.prepare('SELECT max(id) AS id FROM events WHERE user_id = ? AND wakes = 1').get(userId) as { id: number | null }).id ?? 0;

const setMark = (db: Db, tokenId: string, eventId: number) =>
  db.prepare('INSERT INTO watch_marks (token_id, event_id) VALUES (?, ?) ON CONFLICT (token_id) DO UPDATE SET event_id = excluded.event_id').run(tokenId, eventId);

/**
 * The token's working watch, or a new one. News that arrived since this token's last watch reported
 * (while none was running) comes back at once: the new watch is already completed with `reminder()`,
 * and the mark moves on, so the same news never completes a watch twice. A token's first watch starts
 * from now. Undefined when the user already has `WATCH_LIMIT_PER_USER` working watches.
 */
export function startWatch(db: Db, userId: string, tokenId: string, reminder: () => string): Watch | undefined {
  return transaction(db, () => {
    const now = Date.now();
    tidy(db, now, tokenId);
    const working = db.prepare(`SELECT * FROM watches WHERE token_id = ? AND status = 'working'`).get(tokenId) as Row | undefined;
    if (working) return toWatch(working);
    const open = (db.prepare(`SELECT count(*) AS n FROM watches WHERE user_id = ? AND status = 'working'`).get(userId) as { n: number }).n;
    if (open >= WATCH_LIMIT_PER_USER) return undefined;
    const latest = latestWake(db, userId);
    const mark = (db.prepare('SELECT event_id FROM watch_marks WHERE token_id = ?').get(tokenId) as { event_id: number } | undefined)?.event_id;
    const missed = mark !== undefined && latest > mark;
    setMark(db, tokenId, latest);
    const id = randomBytes(16).toString('base64url');
    const status = missed ? 'completed' : 'working';
    const result = missed ? reminder() : null;
    db.prepare(`INSERT INTO watches (id, user_id, token_id, status, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      userId,
      tokenId,
      status,
      result,
      now,
      now,
    );
    return { id, status, result, createdAt: now, updatedAt: now };
  });
}

/** A watch only for the token that started it; any other id is unknown. */
export function getWatch(db: Db, tokenId: string, id: string): Watch | undefined {
  const row = db.prepare('SELECT * FROM watches WHERE id = ? AND token_id = ?').get(id, tokenId) as Row | undefined;
  return row && toWatch(row);
}

export function cancelWatch(db: Db, tokenId: string, id: string): Watch | undefined {
  db.prepare(`UPDATE watches SET status = 'cancelled', updated_at = ? WHERE id = ? AND token_id = ? AND status = 'working'`).run(Date.now(), id, tokenId);
  const watch = getWatch(db, tokenId, id);
  tidy(db, Date.now(), tokenId);
  return watch;
}

/** Completes every working watch of the user with `text` (a content-free reminder) and moves their marks. */
export function completeWatches(db: Db, userId: string, text: string): number {
  return transaction(db, () => {
    const now = Date.now();
    const latest = latestWake(db, userId);
    const tokens = db.prepare(`SELECT token_id FROM watches WHERE user_id = ? AND status = 'working'`).all(userId) as { token_id: string }[];
    for (const { token_id } of tokens) setMark(db, token_id, latest);
    const done = Number(db.prepare(`UPDATE watches SET status = 'completed', result = ?, updated_at = ? WHERE user_id = ? AND status = 'working'`).run(text, now, userId).changes);
    tidy(db, now);
    return done;
  });
}

/** A revoked token's watches end with it. */
export function cancelWatchesOfRevokedTokens(db: Db): void {
  db.prepare(
    `UPDATE watches SET status = 'cancelled', updated_at = ? WHERE status = 'working' AND token_id IN (SELECT id FROM tokens WHERE revoked_at IS NOT NULL)`,
  ).run(Date.now());
}
