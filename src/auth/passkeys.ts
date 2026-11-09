import type { Db } from '../store/db.ts';

/** Passkeys one person may have. */
export const PASSKEYS_PER_PERSON = 10;

export type PasskeyRow = {
  id: string;
  user_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string;
  synced: number;
  created_at: number;
  last_used_at: number | null;
};

/** What Settings lists: never the key. */
export type PasskeyView = { id: string; synced: boolean; createdAt: number; lastUsedAt: number | null };

export function passkeyById(db: Db, id: string): PasskeyRow | undefined {
  return db.prepare('SELECT * FROM passkeys WHERE id = ?').get(id) as PasskeyRow | undefined;
}

export function passkeysOf(db: Db, userId: string): PasskeyView[] {
  const rows = db.prepare('SELECT id, synced, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at').all(userId) as {
    id: string;
    synced: number;
    created_at: number;
    last_used_at: number | null;
  }[];
  return rows.map((row) => ({ id: row.id, synced: Boolean(row.synced), createdAt: row.created_at, lastUsedAt: row.last_used_at }));
}

/** The transports a browser reported, as stored: known names only. */
export function transportsOf(row: PasskeyRow): string[] {
  try {
    const list: unknown = JSON.parse(row.transports);
    return Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string' && /^[a-z-]{1,16}$/.test(t)) : [];
  } catch {
    return [];
  }
}
