import { createHash } from 'node:crypto';
import type { GitHub } from '../config.ts';
import { randomToken } from '../crypto.ts';

/**
 * Sign in with GitHub: the OAuth 2.0 authorization-code flow with PKCE (RFC 7636, S256) and a state bound
 * to the browser (the relay keeps it with the verifier, the cookie holds only a random key). Only the
 * scopes needed to know who signs in: the profile, and the email addresses with their verified flag.
 * The access token is used for two reads and then revoked; it is never stored.
 */
const SCOPES = 'read:user user:email';
const TIMEOUT_MS = 10_000;
/** GitHub logins: letters, digits and hyphens, at most 39. Anything else is not GitHub talking. */
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
/** GitHub's own relay addresses are verified but deliver nothing. */
const NOREPLY = /@users\.noreply\.github\.com$/i;

export interface GitHubIdentity {
  /** GitHub's numeric user id: stable across renamed logins, the only thing a person is found by. */
  id: number;
  login: string;
  /** GitHub's name, or the login without one; free of control and invisible characters. */
  name: string;
  /** The primary address, only when GitHub marks it verified. */
  email: string | undefined;
}

/** One sign-in attempt: `state` travels to GitHub and back; `verifier` never leaves the relay. */
export const newAttempt = () => ({ state: randomToken(32), verifier: randomToken(48) });

export function authorizeUrl(github: GitHub, redirectUri: string, state: string, verifier: string): string {
  const url = new URL('/login/oauth/authorize', github.web);
  url.search = new URLSearchParams({
    client_id: github.clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/**
 * Exchanges the code (with the verifier and the exact redirect URI), reads who signed in, and revokes the
 * token. Undefined on any failure: GitHub refused the code, answered something unexpected, or did not answer.
 */
export async function identify(github: GitHub, code: string, verifier: string, redirectUri: string): Promise<GitHubIdentity | undefined> {
  try {
    const exchanged = (await call(new URL('/login/oauth/access_token', github.web), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: github.clientId, client_secret: github.clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier }),
    }).then((r) => r.json())) as { access_token?: unknown };
    const token = exchanged.access_token;
    if (typeof token !== 'string' || !token) return undefined;
    try {
      const api = { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
      const user = (await call(new URL('/user', github.api), api).then((r) => (r.ok ? r.json() : undefined))) as
        | { id?: unknown; login?: unknown; name?: unknown }
        | undefined;
      if (!user || !Number.isSafeInteger(user.id) || (user.id as number) <= 0 || typeof user.login !== 'string' || !LOGIN.test(user.login)) return undefined;
      // Without the user:email grant this fails, and the person simply has no address yet.
      const emails = await call(new URL('/user/emails', github.api), api)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []);
      const primary = Array.isArray(emails)
        ? emails.find((e: { email?: unknown; primary?: unknown; verified?: unknown }) => e?.primary === true && e.verified === true && typeof e.email === 'string')
        : undefined;
      return {
        id: user.id as number,
        login: user.login,
        name: displayName(typeof user.name === 'string' ? user.name : '', user.login),
        email: primary && !NOREPLY.test(primary.email) ? primary.email : undefined,
      };
    } finally {
      await revoke(github, token);
    }
  } catch {
    return undefined;
  }
}

/**
 * A name other people read next to the handle: without control, format, line or paragraph separators, the
 * Hangul and Braille fillers that render as nothing, or stacks of combining marks (two per letter at most);
 * spaces collapsed, at most 100 characters. The login when nothing visible remains.
 */
export function displayName(name: string, login: string): string {
  const cleaned = name
    .replace(/[\p{C}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800]/gu, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .replace(/\p{Zs}+/gu, ' ')
    .trim();
  const short = [...cleaned].slice(0, 100).join('').trim();
  return /[^\p{Z}\p{M}]/u.test(short) ? short : login;
}

/** Best effort: the token is not needed after sign-in, so it should not stay valid at GitHub either. */
async function revoke(github: GitHub, token: string): Promise<void> {
  await call(new URL(`/applications/${encodeURIComponent(github.clientId)}/token`, github.api), {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${Buffer.from(`${github.clientId}:${github.clientSecret}`).toString('base64')}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ access_token: token }),
  }).catch(() => {});
}

/** No redirects (a code or token never follows one), a time limit, and GitHub's required User-Agent. */
const call = (url: URL, init: RequestInit) =>
  fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'klatsch', ...init.headers } });
