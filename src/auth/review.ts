import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Passwords for review accounts only. Klatsch signs people in by email link, GitHub, Google or passkey; a chat
 * app's directory reviewers need a username and password and no codes. So one account the operator names gets a
 * password (`klatsch review-account`), and nobody else can have one. scrypt, a random salt, a constant-time compare.
 */
const N = 16384;
const R = 8;
const P = 1;
const LENGTH = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, LENGTH, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Off the event loop (the thread pool), so a check never stalls the relay. */
export async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, key] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p) }, (error, derived) => (error ? reject(error) : resolve(derived))),
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A password a reviewer can type: 20 characters from a set without look-alikes. */
export function newReviewPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...randomBytes(20)].map((b) => alphabet[b % alphabet.length]).join('');
}
