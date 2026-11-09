import { randomInt } from 'node:crypto';
import { keyedHash, randomToken, safeEqual } from '../crypto.ts';
import type { Db } from '../store/db.ts';

const LOGIN_TTL = 10 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/**
 * Links one address gets. Counted per asking browser first, so someone else asking for your address from their
 * browser does not use up yours; the looser total bounds what the relay mails to one inbox.
 */
const PER_ADDRESS_AND_BROWSER_HOUR = 3;
const PER_ADDRESS_HOUR = 8;
const PER_ADDRESS_DAY = 20;
/**
 * Links to addresses nobody here has, which anyone holding an invite or a public join link can ask for: their own
 * budget, per link and per relay, so they can never use up what people already here need to sign in.
 */
const NEW_PER_JOIN_LINK_HOUR = 15;
const NEW_PER_RELAY_DAY = 60;
/**
 * Links to people already here: a ceiling for the relay, under a small mail plan's daily quota. Part of it only a
 * known browser (one its person signed in with before) can use, so strangers asking for many addresses cannot use
 * it all up; a known browser also skips the per-address totals, which anyone can fill.
 */
const MEMBER_PER_RELAY_HOUR = 100;
const MEMBER_PER_RELAY_DAY = 250;
const RESERVED_FOR_KNOWN_HOUR = 20;
const RESERVED_FOR_KNOWN_DAY = 50;
/**
 * Links from known browsers per address, which skip the totals anyone can fill: few, so a person with their own
 * known cookie cannot mail themselves the reserved share (5 an hour is at most a quarter of it) or the relay's budget.
 */
const KNOWN_PER_ADDRESS_HOUR = 5;
const KNOWN_PER_ADDRESS_DAY = 15;
/** Wrong codes a link takes before it is dead, its link too: 5 in a million per mail. */
export const CODE_TRIES = 5;

/** What a link for an address nobody here has was asked for at: an invite (by id, never its token) or a public join link. */
export interface JoinRef {
  kind: 'invite' | 'public';
  ref: string;
}

export interface EmailLogin {
  email: string;
  join: JoinRef | undefined;
  /** Whether the link is opened in the browser that asked for it. */
  sameBrowser: boolean;
}

/** Addresses are compared as typed, without surrounding spaces and in lower case. */
export const normalEmail = (email: string): string => email.trim().toLowerCase();

const GMAIL = new Set(['gmail.com', 'googlemail.com']);

/**
 * The mailbox an address reaches, so variants of one cannot make several people: lower case, without a +tag, and
 * for Gmail without dots and as gmail.com. The same rules as the migration that filled `users.mailbox`.
 */
export function mailboxOf(email: string): string {
  const lower = normalEmail(email);
  const at = lower.lastIndexOf('@');
  const local = lower.slice(0, at).split('+')[0]!;
  const domain = lower.slice(at + 1);
  return GMAIL.has(domain) ? `${local.replaceAll('.', '')}@gmail.com` : `${local}@${domain}`;
}

const nonceHash = (secret: Buffer, nonce: string) => keyedHash(secret, `email-login ${nonce}`);
/** A code as stored: keyed to its own link, so the same six digits in two mails are two different values. */
const codeHash = (secret: Buffer, linkHash: string, code: string) => keyedHash(secret, `email-code ${linkHash} ${code}`);

/** Six digits, as people type them: spaces and dashes are dropped. Undefined for anything else. */
export function normalCode(typed: string): string | undefined {
  const code = typed.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(code) ? code : undefined;
}

/**
 * A sign-in link and code mailed to `email`, asked for by `browser` (its known cookie's random part, else its form cookie's value): random, stored only as an HMAC with the
 * server secret, single use, ten minutes, bound to that address, that browser and `join`, if any. `known`: the browser
 * is one the address's person signed in with before. The code (six random digits) signs in the same way, but only typed in
 * the browser that asked. Undefined when the address, the join link or the relay has had its share.
 */
export function createEmailLogin(
  db: Db,
  secret: Buffer,
  request: { email: string; browser: string; join: JoinRef | undefined; known: boolean },
  publicUrl: string,
): { link: string; code: string } | undefined {
  const { email, join, known } = request;
  const reserved = (amount: number) => (known ? 0 : amount);
  const browser = nonceHash(secret, request.browser);
  const now = Date.now();
  // Rows older than the longest window count for nothing.
  db.prepare('DELETE FROM email_logins WHERE created_at <= ?').run(now - DAY);
  const count = (where: string, ...args: (string | number)[]) => (db.prepare(`SELECT count(*) AS n FROM email_logins WHERE ${where}`).get(...args) as { n: number }).n;
  const full =
    count('email = ? AND nonce_hash = ? AND created_at > ?', email, browser, now - HOUR) >= PER_ADDRESS_AND_BROWSER_HOUR ||
    (known
      ? count('email = ? AND known = 1 AND created_at > ?', email, now - HOUR) >= KNOWN_PER_ADDRESS_HOUR ||
        count('email = ? AND known = 1 AND created_at > ?', email, now - DAY) >= KNOWN_PER_ADDRESS_DAY
      : count('email = ? AND created_at > ?', email, now - HOUR) >= PER_ADDRESS_HOUR ||
        count('email = ? AND created_at > ?', email, now - DAY) >= PER_ADDRESS_DAY) ||
    (join
      ? count('join_ref = ? AND join_kind = ? AND created_at > ?', join.ref, join.kind, now - HOUR) >= NEW_PER_JOIN_LINK_HOUR ||
        count('join_ref IS NOT NULL AND created_at > ?', now - DAY) >= NEW_PER_RELAY_DAY
      : count('join_ref IS NULL AND created_at > ?', now - HOUR) >= MEMBER_PER_RELAY_HOUR - reserved(RESERVED_FOR_KNOWN_HOUR) ||
        count('join_ref IS NULL AND created_at > ?', now - DAY) >= MEMBER_PER_RELAY_DAY - reserved(RESERVED_FOR_KNOWN_DAY));
  if (full) return undefined;
  const token = randomToken(32);
  const hash = keyedHash(secret, token);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare('INSERT INTO email_logins (hash, code_hash, email, nonce_hash, known, join_kind, join_ref, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    hash,
    codeHash(secret, hash, code),
    email,
    browser,
    known ? 1 : 0,
    join?.kind ?? null,
    join?.ref ?? null,
    now,
    now + LOGIN_TTL,
  );
  return { link: `${publicUrl}/ui/auth/email/${token}`, code };
}

type Row = { email: string; nonce_hash: string; join_kind: JoinRef['kind'] | null; join_ref: string | null };
const loginOf = (secret: Buffer, row: Row | undefined, browsers: string[]): EmailLogin | undefined =>
  row && {
    email: row.email,
    join: row.join_kind && row.join_ref ? { kind: row.join_kind, ref: row.join_ref } : undefined,
    sameBrowser: browsers.some((browser) => nonceHash(secret, browser) === row.nonce_hash),
  };

/**
 * An unused, unexpired link, only looked at: opening it (or a mail scanner fetching it) uses nothing up. `browsers`:
 * the keys this browser could have asked with, to tell whether it is the one that did.
 */
export function findEmailLogin(db: Db, secret: Buffer, token: string, browsers: string[]): EmailLogin | undefined {
  const row = db
    .prepare('SELECT email, nonce_hash, join_kind, join_ref FROM email_logins WHERE hash = ? AND used_at IS NULL AND expires_at > ? AND code_tries < ?')
    .get(keyedHash(secret, token), Date.now(), CODE_TRIES) as Row | undefined;
  return loginOf(secret, row, browsers);
}

/** Uses the link up; undefined if it was unknown, used or expired. */
export function claimEmailLogin(db: Db, secret: Buffer, token: string): EmailLogin | undefined {
  const now = Date.now();
  const row = db
    .prepare('UPDATE email_logins SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ? AND code_tries < ? RETURNING email, nonce_hash, join_kind, join_ref')
    .get(now, keyedHash(secret, token), now, CODE_TRIES) as Row | undefined;
  return loginOf(secret, row, []);
}

/**
 * Uses up the newest unused, unexpired link this browser asked for (`browsers`: the keys it could have asked with),
 * if `code` is its code. Only that one: an older link of the same browser is never tried. A wrong code counts against
 * the link, and at the fifth its link is dead too. Undefined for no link, a dead one or a wrong code.
 */
export function claimEmailLoginByCode(db: Db, secret: Buffer, browsers: string[], code: string): EmailLogin | undefined {
  const keys = browsers.map((browser) => nonceHash(secret, browser));
  if (!keys.length) return undefined;
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT hash, code_hash, code_tries FROM email_logins WHERE nonce_hash IN (${keys.map(() => '?').join(', ')}) AND used_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(...keys, now) as { hash: string; code_hash: string | null; code_tries: number } | undefined;
  if (!row || row.code_tries >= CODE_TRIES) return undefined;
  if (!row.code_hash || !safeEqual(row.code_hash, codeHash(secret, row.hash, code))) {
    db.prepare('UPDATE email_logins SET code_tries = code_tries + 1 WHERE hash = ?').run(row.hash);
    return undefined;
  }
  const claimed = db
    .prepare('UPDATE email_logins SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ? AND code_tries < ? RETURNING email, nonce_hash, join_kind, join_ref')
    .get(now, row.hash, now, CODE_TRIES) as Row | undefined;
  return loginOf(secret, claimed, []);
}
