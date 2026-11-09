import { createHash } from 'node:crypto';
import type { Google } from '../config.ts';
import { randomToken } from '../crypto.ts';
import { displayName } from './github.ts';

/**
 * Sign in with Google: OpenID Connect's authorization-code flow with PKCE (S256), a state bound to the browser and a
 * nonce bound to the ID token. Only `openid email profile`. The ID token comes straight from Google's token endpoint
 * over TLS, which OpenID Connect Core (3.1.3.7) accepts in place of checking its signature, so no key handling is
 * needed; its issuer, audience, expiry and nonce are checked all the same. The access token is never used or stored.
 * An address Google does not mark verified is refused, so nobody signs up with someone else's address.
 */
const SCOPES = 'openid email profile';
const TIMEOUT_MS = 10_000;
const SUB = /^[\x21-\x7e]{1,255}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export interface GoogleIdentity {
  /** Google's `sub`: stable for this account, the only thing a person is found by. */
  sub: string;
  email: string;
  /** Google's name, or the address's first part; free of control and invisible characters. */
  name: string;
  /** What the address suggests as a handle, when it can be one. */
  login: string;
}

export const newGoogleAttempt = () => ({ state: randomToken(32), verifier: randomToken(48), nonce: randomToken(24) });

export function googleAuthorizeUrl(google: Google, redirectUri: string, attempt: { state: string; verifier: string; nonce: string }): string {
  const url = new URL(google.authorize);
  url.search = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    // On a shared browser, people pick which account they mean.
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

/** The claims of an ID token, without a signature check: only ever called on one Google's token endpoint just gave us. */
function claimsOf(idToken: string): Record<string, unknown> | undefined {
  const payload = idToken.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Exchanges the code and checks who signed in. Undefined on any failure, including an address that is not verified. */
export async function identifyGoogle(google: Google, code: string, attempt: { verifier: string; nonce: string }, redirectUri: string): Promise<GoogleIdentity | undefined> {
  try {
    const response = await fetch(google.token, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: google.clientId, client_secret: google.clientSecret, code, redirect_uri: redirectUri, code_verifier: attempt.verifier, grant_type: 'authorization_code' }),
    });
    if (!response.ok) return undefined;
    const idToken = ((await response.json()) as { id_token?: unknown }).id_token;
    if (typeof idToken !== 'string') return undefined;
    const claims = claimsOf(idToken);
    if (!claims || !google.issuers.includes(String(claims.iss)) || claims.aud !== google.clientId) return undefined;
    if (claims.azp !== undefined && claims.azp !== google.clientId) return undefined;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now() || claims.nonce !== attempt.nonce) return undefined;
    if (typeof claims.sub !== 'string' || !SUB.test(claims.sub)) return undefined;
    if (claims.email_verified !== true || typeof claims.email !== 'string' || !EMAIL.test(claims.email)) return undefined;
    const first = claims.email.split('@')[0]!;
    return {
      sub: claims.sub,
      email: claims.email,
      name: displayName(typeof claims.name === 'string' ? claims.name : '', first),
      login: first.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 39),
    };
  } catch {
    return undefined;
  }
}
