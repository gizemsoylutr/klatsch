import { createHash } from 'node:crypto';
import { keyedHash, newId, randomToken } from '../crypto.ts';
import { transaction, type Db } from '../store/db.ts';
import { cancelWatchesOfRevokedTokens } from '../watches.ts';
import { createToken, SCOPES } from './tokens.ts';

/**
 * OAuth 2.1 for MCP clients that cannot be handed a token, such as ChatGPT and claude.ai: dynamic registration
 * (RFC 7591) of public clients, the authorization code flow with PKCE (S256 only), and rotating refresh tokens.
 * The access token is an ordinary agent token (a row in `tokens`, the same scopes, revoked on the Tokens page),
 * so everything an agent may do, and that people approve, stays as it is.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A refresh token presented again this soon after its use is a client retrying, not a thief: refused, nothing revoked. */
const RETRY_GRACE_MS = 30 * 1000;
const MAX_REDIRECTS = 5;

export class OAuthFail extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
}

/** https anywhere, plain http only back to this machine (a desktop client); never a fragment or a user name. */
export function redirectAllowed(value: string): boolean {
  if (value.length > 512) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** What a client calls itself, as shown on the consent page: printable, short, and only ever next to its address. */
export function clientName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? [...value.normalize('NFC').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, 48).join('') : '';
  return name || fallback;
}

export function registerClient(db: Db, body: unknown): Record<string, unknown> {
  const meta = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECTS || !uris.every((u) => typeof u === 'string' && redirectAllowed(u))) {
    throw new OAuthFail('invalid_redirect_uri', 'Give one to five redirect URIs: https, or http to localhost, without a fragment.');
  }
  const grants = meta.grant_types;
  if (grants !== undefined && (!Array.isArray(grants) || grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token'))) {
    throw new OAuthFail('invalid_client_metadata', 'Only authorization_code and refresh_token are supported.');
  }
  const id = newId('mcpc');
  const name = clientName(meta.client_name, new URL(uris[0] as string).host);
  const now = Date.now();
  db.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(id, name, JSON.stringify(uris), now);
  return {
    client_id: id,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // Public clients only: a secret in a browser or a shared app protects nothing, PKCE does the work.
    token_endpoint_auth_method: 'none',
  };
}

export function clientOf(db: Db, id: string): OAuthClient | undefined {
  const row = db.prepare('SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?').get(id) as { id: string; name: string; redirect_uris: string } | undefined;
  return row ? { id: row.id, name: row.name, redirectUris: JSON.parse(row.redirect_uris) as string[] } : undefined;
}

export interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  state?: string;
  challenge: string;
}

/**
 * Checks an authorization request in the order RFC 6749 asks: an unknown client or a redirect URI it did not
 * register is shown on the page and never followed (`fatal`); anything else wrong goes back to the client (`back`).
 */
export function readAuthorize(
  db: Db,
  query: Record<string, string | undefined>,
  resources: string[],
): { ok: AuthorizeRequest } | { fatal: string } | { back: { redirectUri: string; state?: string; error: string; description: string } } {
  const client = query.client_id ? clientOf(db, query.client_id) : undefined;
  if (!client) return { fatal: 'unknown-client' };
  const redirectUri = query.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) return { fatal: 'bad-redirect' };
  const state = query.state;
  const back = (error: string, description: string) => ({ back: { redirectUri, ...(state !== undefined ? { state } : {}), error, description } });
  if (query.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code.');
  if (!query.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(query.code_challenge) || query.code_challenge_method !== 'S256') {
    return back('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  }
  if (query.resource !== undefined && !resources.includes(query.resource.replace(/\/$/, ''))) return back('invalid_target', 'This server is the only resource here.');
  return { ok: { client, redirectUri, ...(state !== undefined ? { state } : {}), challenge: query.code_challenge } };
}

/** Where the browser goes back to, with the code or the error, the state, and the issuer (RFC 9207). */
export function redirectTo(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

export function issueCode(db: Db, secret: Buffer, userId: string, request: AuthorizeRequest): string {
  const code = randomToken(32);
  db.prepare('INSERT INTO oauth_codes (hash, client_id, user_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    keyedHash(secret, `code ${code}`),
    request.client.id,
    userId,
    request.redirectUri,
    request.challenge,
    Date.now() + CODE_TTL_MS,
  );
  return code;
}

export interface Issued {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function newRefresh(db: Db, secret: Buffer, clientId: string, tokenId: string): string {
  const refresh = randomToken(32);
  db.prepare('INSERT INTO oauth_refresh (hash, client_id, token_id, expires_at) VALUES (?, ?, ?, ?)').run(keyedHash(secret, `refresh ${refresh}`), clientId, tokenId, Date.now() + REFRESH_TTL_MS);
  return refresh;
}

function revoke(db: Db, tokenId: string): void {
  db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), tokenId);
  cancelWatchesOfRevokedTokens(db);
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** A code works once, for ten minutes, for the client and redirect URI it was issued to, with the verifier of its challenge. */
export function exchangeCode(db: Db, secret: Buffer, form: Record<string, string>, ttlDays: number): Issued {
  const { code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier } = form;
  if (!code || !clientId || !verifier) throw new OAuthFail('invalid_request', 'code, client_id and code_verifier are required.');
  // A refusal that ends a connection is decided inside the transaction and carried out after it, so the throw that
  // tells the client does not roll the revocation back.
  let end: string | null = null;
  const outcome = transaction(db, (): Issued | OAuthFail => {
    const row = db.prepare('SELECT client_id, user_id, redirect_uri, challenge, token_id, expires_at, used_at FROM oauth_codes WHERE hash = ?').get(keyedHash(secret, `code ${code}`)) as
      | { client_id: string; user_id: string; redirect_uri: string; challenge: string; token_id: string | null; expires_at: number; used_at: number | null }
      | undefined;
    if (!row) return new OAuthFail('invalid_grant', 'Unknown or expired code.');
    if (row.used_at !== null) {
      // A code seen twice was stolen or replayed: the token it bought goes too (RFC 6749, 4.1.2).
      end = row.token_id;
      return new OAuthFail('invalid_grant', 'This code was already used.');
    }
    if (row.expires_at <= Date.now() || row.client_id !== clientId || (redirectUri !== undefined && redirectUri !== row.redirect_uri)) {
      return new OAuthFail('invalid_grant', 'Unknown or expired code.');
    }
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || s256(verifier) !== row.challenge) return new OAuthFail('invalid_grant', 'The code verifier does not match.');
    const client = clientOf(db, clientId)!;
    const made = createToken(db, secret, row.user_id, { ttlDays, label: `oauth:${clientId}`, agent: { clients: [], project: client.name } });
    db.prepare('UPDATE oauth_codes SET used_at = ?, token_id = ? WHERE hash = ?').run(Date.now(), made.tokenId, keyedHash(secret, `code ${code}`));
    return {
      access_token: made.token,
      token_type: 'Bearer' as const,
      expires_in: Math.floor((made.expiresAt - Date.now()) / 1000),
      refresh_token: newRefresh(db, secret, clientId, made.tokenId),
      scope: SCOPES.join(' '),
    };
  });
  return settle(db, outcome, end);
}

function settle(db: Db, outcome: Issued | OAuthFail, end: string | null): Issued {
  if (end) revoke(db, end);
  if (outcome instanceof OAuthFail) throw outcome;
  return outcome;
}

/**
 * A refresh token works once: it rotates the same token row (one entry on the Tokens page per connection), so
 * revoking that entry ends the connection for good. Presented again later, it revokes the token (reuse detection).
 */
export function refreshTokens(db: Db, secret: Buffer, form: Record<string, string>, ttlDays: number): Issued {
  const { refresh_token: refresh, client_id: clientId } = form;
  if (!refresh || !clientId) throw new OAuthFail('invalid_request', 'refresh_token and client_id are required.');
  let end: string | null = null;
  const outcome = transaction(db, (): Issued | OAuthFail => {
    const hash = keyedHash(secret, `refresh ${refresh}`);
    const row = db.prepare('SELECT client_id, token_id, expires_at, used_at FROM oauth_refresh WHERE hash = ?').get(hash) as
      | { client_id: string; token_id: string; expires_at: number; used_at: number | null }
      | undefined;
    if (!row || row.client_id !== clientId) return new OAuthFail('invalid_grant', 'Unknown refresh token.');
    if (row.used_at !== null) {
      if (Date.now() - row.used_at > RETRY_GRACE_MS) end = row.token_id;
      return new OAuthFail('invalid_grant', 'This refresh token was already used.');
    }
    const token = db.prepare('SELECT revoked_at FROM tokens WHERE id = ?').get(row.token_id) as { revoked_at: number | null } | undefined;
    if (row.expires_at <= Date.now() || !token || token.revoked_at !== null) return new OAuthFail('invalid_grant', 'This connection has ended; connect again.');
    db.prepare('UPDATE oauth_refresh SET used_at = ? WHERE hash = ?').run(Date.now(), hash);
    const access = 'klt_' + randomToken(32);
    const expiresAt = Date.now() + ttlDays * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE tokens SET hash = ?, expires_at = ? WHERE id = ?').run(keyedHash(secret, access), expiresAt, row.token_id);
    return {
      access_token: access,
      token_type: 'Bearer' as const,
      expires_in: Math.floor((expiresAt - Date.now()) / 1000),
      refresh_token: newRefresh(db, secret, clientId, row.token_id),
      scope: SCOPES.join(' '),
    };
  });
  return settle(db, outcome, end);
}
