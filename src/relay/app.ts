import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, getOAuthProtectedResourceMetadataUrl, OAuthError, OAuthErrorCode, requireBearerAuth, type AuthInfo } from '@modelcontextprotocol/server';
import type { Context, Hono } from 'hono';
import { verifyToken } from '../auth/tokens.ts';
import { baseFor, relayOrigins } from '../config.ts';
import { agentHandle, type Klatsch } from '../service.ts';
import { badgeRoute } from './badge.ts';
import { buildMcpServer } from './mcp.ts';
import { iconPng } from './icon-png.ts';
import { llmsTxt } from './llms.ts';
import { oauthOffered, oauthRoutes } from './oauth.ts';
import { landing, legalPage } from './layout.ts';
import { pageHeaders, webRoutes } from './web.ts';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const clean = (value: unknown): string => (typeof value === 'string' ? value.replace(/[^\w/.-]/g, '').slice(0, 64) : '');

/** What a request asked for: JSON-RPC methods and tool names, never arguments or results. */
function calls(body: unknown): string {
  return (Array.isArray(body) ? body : [body])
    .map((message: { method?: unknown; params?: { name?: unknown } } | undefined) => {
      const method = clean(message?.method);
      return method === 'tools/call' ? `${method} ${clean(message?.params?.name)}` : method || 'response';
    })
    .join(', ');
}

/** Fixed-window limit per token; enough for one relay instance. */
function rateLimiter(limit: number, windowMs: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const current = windows.get(key);
    if (!current || now - current.start >= windowMs) {
      windows.set(key, { start: now, count: 1 });
      return true;
    }
    current.count++;
    return current.count <= limit;
  };
}

export function createRelay(klatsch: Klatsch, secret: Buffer): Hono {
  const { config, db } = klatsch;
  klatsch.useSecret(secret);
  const resource = new URL(`${config.publicUrl}/mcp`);
  // Host and Origin validation against DNS rebinding comes from createMcpHonoApp.
  const app = LOCAL_HOSTS.has(config.host)
    ? createMcpHonoApp()
    : createMcpHonoApp({
        host: config.host,
        allowedHosts: [new URL(config.publicUrl).hostname],
        allowedOrigins: [new URL(config.publicUrl).hostname],
      });
  // The SDK's local check allows any port on any loopback name; the relay answers only on its own origins.
  const origins = relayOrigins(config);
  if (origins.length > 1) app.use('*', async (c, next) => (origins.includes(`http://${c.req.header('host')}`) ? next() : c.text('Unknown host.', 403)));

  const gate = requireBearerAuth({
    expectedResource: resource,
    // A client without a token finds the OAuth server from the 401 (RFC 9728), as ChatGPT and claude.ai do.
    ...(oauthOffered(config.publicUrl) ? { resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) } : {}),
    verifier: {
      async verifyAccessToken(token: string): Promise<AuthInfo> {
        const verified = verifyToken(db, secret, token);
        if (!verified) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid, expired or revoked token.');
        return {
          token,
          clientId: verified.tokenId,
          scopes: verified.scopes,
          expiresAt: Math.floor(verified.expiresAt / 1000),
          resource,
          extra: { userId: verified.userId },
        };
      },
    },
  });
  const handler = createMcpHandler((ctx) =>
    buildMcpServer(klatsch, secret, ctx.authInfo, ctx.era, baseFor(config, ctx.requestInfo?.headers.get('host') ?? undefined)),
  );
  const allow = rateLimiter(60, 60_000);
  // KLATSCH_LOG=1: who called which tool, so a hook or client that never reaches the relay shows up. No content.
  const log = Boolean(process.env.KLATSCH_LOG);

  app.all('/mcp', async (c: Context) => {
    const auth = await gate(c.req.raw);
    if (auth instanceof Response) return auth;
    if (!allow(auth.clientId)) return c.json({ error: 'rate_limited' }, 429);
    if (log) {
      // Diagnostics never fail a request; the handle is printed only in its checked form.
      try {
        console.error(`[klatsch] mcp ${agentHandle(klatsch.user(String(auth.extra?.userId)).handle) ?? '@?'}: ${calls(c.get('parsedBody'))}`);
      } catch {}
    }
    return handler.fetch(c.req.raw, { authInfo: auth, parsedBody: c.get('parsedBody') });
  });

  oauthRoutes(app, klatsch, secret, resource);
  app.route('/ui', webRoutes(klatsch, secret));
  // The only public page under a person's control: their opt-in thanks badge, a number behind a random id.
  app.get('/badge/:file', badgeRoute(klatsch));
  // A public circle's join link, short to share; the page itself is in the web UI, where the session cookie is.
  app.get('/join/:token', (c: Context) => c.redirect(`/ui/join/${encodeURIComponent(c.req.param('token') ?? '')}`, 303));
  // A person who types the bare address reads what Klatsch is (the session cookie is scoped to /ui, so the
  // page cannot know who is signed in); anything else gets one plain line.
  app.use('/', pageHeaders);
  // Public, like the landing page, and only where the operator has said who they are.
  app.use('/privacy', pageHeaders);
  app.use('/terms', pageHeaders);
  app.get('/privacy', (c: Context) => (config.operator ? c.html(legalPage('privacy', config.operator)) : c.notFound()));
  app.get('/terms', (c: Context) => (config.operator ? c.html(legalPage('terms', config.operator)) : c.notFound()));
  // "Sign in with GitHub" only where GitHub is the one way in: configured, on the public origin GitHub returns to,
  // and no email sign-in beside it (then the buttons just say "Sign in").
  const github = (c: Context) => Boolean(config.github) && !config.google && !klatsch.mailer && baseFor(config, c.req.header('host')) === config.publicUrl;
  app.get('/llms.txt', (c: Context) => c.text(llmsTxt(config.publicUrl)));
  // The icon as a bitmap, for chat apps, link previews and home screens; /favicon.ico for clients that only try that.
  const png = (size: number, rounded = true) => (c: Context) => {
    c.header('Content-Type', 'image/png');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(new Uint8Array(iconPng(size, rounded)));
  };
  app.get('/icon.png', png(512));
  app.get('/favicon.ico', png(64));
  app.get('/apple-touch-icon.png', png(180, false));
  app.get('/', (c: Context) =>
    (c.req.header('Accept') ?? '').includes('text/html') ? c.html(landing(github(c), Boolean(config.operator), oauthOffered(config.publicUrl) ? `${config.publicUrl}/mcp` : '')) : c.text('Klatsch relay. Agents use /mcp, humans use /ui.'),
  );
  return app;
}
