import { getConnInfo } from '@hono/node-server/conninfo';
import { buildOAuthProtectedResourceMetadata, oauthMetadataResponse, type AuthMetadataOptions } from '@modelcontextprotocol/server';
import type { Context, Hono } from 'hono';
import { exchangeCode, OAuthFail, refreshTokens, registerClient } from '../auth/oauth.ts';
import { SCOPES } from '../auth/tokens.ts';
import { isHosted } from '../config.ts';
import type { Klatsch } from '../service.ts';
import { addressKey, perKeyLimit } from './web.ts';

/** The authorization server's own endpoints and the two discovery documents. The consent page is in the web UI. */
export function oauthMetadata(publicUrl: string, resource: URL): AuthMetadataOptions {
  return {
    resourceServerUrl: resource,
    resourceName: 'Klatsch',
    scopesSupported: [...SCOPES],
    oauthMetadata: {
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/ui/oauth/authorize`,
      token_endpoint: `${publicUrl}/oauth/token`,
      registration_endpoint: `${publicUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...SCOPES],
      authorization_response_iss_parameter_supported: true,
    },
  };
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version' };
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/** OAuth needs an https issuer, or this machine (RFC 8414); a relay on plain http elsewhere offers tokens only. */
export function oauthOffered(publicUrl: string): boolean {
  const url = new URL(publicUrl);
  return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function oauthRoutes(app: Hono, klatsch: Klatsch, secret: Buffer, resource: URL): void {
  const { config, db } = klatsch;
  if (!oauthOffered(config.publicUrl)) return;
  const metadata = oauthMetadata(config.publicUrl, resource);
  // Registration is open to anyone, as MCP clients expect; per address it is limited, and a client is only a name
  // and its addresses until a signed-in person approves it on the consent page.
  const allowRegister = perKeyLimit(20, 60 * 60 * 1000);
  const allowToken = perKeyLimit(120, 60 * 1000);
  const address = (c: Context): string => {
    if (isHosted(config)) return addressKey(c.req.header('X-Forwarded-For')?.split(',').at(-1)?.trim() || 'unknown');
    try {
      return addressKey(getConnInfo(c).remote.address ?? 'unknown');
    } catch {
      return 'unknown';
    }
  };
  const fail = (c: Context, error: unknown, status = 400) => {
    if (!(error instanceof OAuthFail)) throw error;
    return c.json({ error: error.code, error_description: error.message }, status as 400, { ...CORS, ...NO_STORE });
  };

  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']) {
    app.all(path, (c: Context) => oauthMetadataResponse(c.req.raw, metadata) ?? c.notFound());
  }
  // Some clients look at the origin's root document, without the /mcp path; the same document answers there.
  const resourceDocument = buildOAuthProtectedResourceMetadata(metadata);
  app.get('/.well-known/oauth-protected-resource', (c: Context) => c.json(resourceDocument, 200, { 'Access-Control-Allow-Origin': '*' }));

  app.options('/oauth/register', () => new Response(null, { status: 204, headers: CORS }));
  app.post('/oauth/register', async (c: Context) => {
    if (!allowRegister(address(c))) return c.json({ error: 'slow_down', error_description: 'Too many registrations from here.' }, 429, CORS);
    let body: unknown = c.get('parsedBody');
    if (body === undefined) {
      try {
        body = await c.req.json();
      } catch {
        body = undefined;
      }
    }
    try {
      const client = registerClient(db, body);
      klatsch.audit(null, 'web', 'oauth.register', String(client.client_id));
      return c.json(client, 201, { ...CORS, ...NO_STORE });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.options('/oauth/token', () => new Response(null, { status: 204, headers: CORS }));
  app.post('/oauth/token', async (c: Context) => {
    if (!allowToken(address(c))) return c.json({ error: 'slow_down' }, 429, CORS);
    const raw = await c.req.parseBody();
    const form = Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    if (form.resource !== undefined && form.resource.replace(/\/$/, '') !== resource.toString() && form.resource.replace(/\/$/, '') !== config.publicUrl) {
      return fail(c, new OAuthFail('invalid_target', 'This server is the only resource here.'));
    }
    try {
      const ttl = config.tokenTtlDays;
      if (form.grant_type === 'authorization_code') return c.json(exchangeCode(db, secret, form, ttl), 200, { ...CORS, ...NO_STORE });
      if (form.grant_type === 'refresh_token') return c.json(refreshTokens(db, secret, form, ttl), 200, { ...CORS, ...NO_STORE });
      throw new OAuthFail('unsupported_grant_type', 'Only authorization_code and refresh_token.');
    } catch (error) {
      return fail(c, error);
    }
  });
}
