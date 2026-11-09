// A stand-in for GitHub's OAuth endpoints and the two API reads Klatsch makes, on a free port, strict where
// GitHub is: the client id and secret, the exact redirect URI, PKCE with S256, codes that work once.
// Its authorize page does not ask: it sends the browser straight back for whoever `signedIn` is, as
// GitHub does for an app the person already authorized.
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GitHub } from '../src/config.ts';

export interface Account {
  id: number;
  login: string;
  name: string | null;
  emails: { email: string; primary: boolean; verified: boolean }[];
}

export async function fakeGitHub() {
  const clientId = 'Iv1.fakeclient';
  const clientSecret = randomBytes(20).toString('hex');
  /** Who is signed in at "github.com" in the browser that comes to the authorize page. */
  let signedIn: Account | undefined;
  const codes = new Map<string, { account: Account; challenge: string; redirectUri: string; used: boolean }>();
  const tokens = new Map<string, Account>();
  /** Every token exchange: the code and whether GitHub gave a token for it. */
  const exchanges: { code: string; ok: boolean }[] = [];
  const revoked: string[] = [];
  let redirectUri = '';

  const body = async (request: IncomingMessage) => {
    let text = '';
    for await (const chunk of request) text += String(chunk);
    return text;
  };
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const bearer = (request: IncomingMessage) => tokens.get((request.headers.authorization ?? '').replace(/^Bearer /, ''));

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://github.test');
    if (request.method === 'GET' && url.pathname === '/login/oauth/authorize') {
      const q = url.searchParams;
      const ok =
        signedIn &&
        q.get('client_id') === clientId &&
        q.get('redirect_uri') === redirectUri &&
        q.get('scope') === 'read:user user:email' &&
        q.get('code_challenge_method') === 'S256' &&
        /^[\w-]{43}$/.test(q.get('code_challenge') ?? '') &&
        q.get('state');
      if (!ok) return json(response, 400, { error: 'bad_request' });
      const code = randomBytes(10).toString('hex');
      codes.set(code, { account: signedIn!, challenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri')!, used: false });
      const back = new URL(q.get('redirect_uri')!);
      back.search = new URLSearchParams({ code, state: q.get('state')! }).toString();
      response.writeHead(302, { Location: back.toString() });
      return response.end();
    }
    if (request.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      const form = new URLSearchParams(await body(request));
      const code = form.get('code') ?? '';
      const entry = codes.get(code);
      const verifier = form.get('code_verifier') ?? '';
      const ok =
        Boolean(entry) &&
        !entry!.used &&
        form.get('client_id') === clientId &&
        form.get('client_secret') === clientSecret &&
        form.get('redirect_uri') === entry!.redirectUri &&
        createHash('sha256').update(verifier).digest('base64url') === entry!.challenge;
      if (entry) entry.used = true;
      exchanges.push({ code, ok });
      // GitHub answers a bad code with 200 and an error field.
      if (!ok) return json(response, 200, { error: 'bad_verification_code' });
      const token = `gho_${randomBytes(18).toString('hex')}`;
      tokens.set(token, entry!.account);
      return json(response, 200, { access_token: token, token_type: 'bearer', scope: 'read:user,user:email' });
    }
    if (request.method === 'GET' && url.pathname === '/user') {
      const account = bearer(request);
      return account ? json(response, 200, { id: account.id, login: account.login, name: account.name }) : json(response, 401, {});
    }
    if (request.method === 'GET' && url.pathname === '/user/emails') {
      const account = bearer(request);
      return account ? json(response, 200, account.emails.map((e) => ({ ...e, visibility: null }))) : json(response, 401, {});
    }
    if (request.method === 'DELETE' && url.pathname === `/applications/${clientId}/token`) {
      const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      const token = (JSON.parse((await body(request)) || '{}') as { access_token?: string }).access_token ?? '';
      if (request.headers.authorization !== basic || !tokens.delete(token)) return json(response, 404, {});
      revoked.push(token);
      response.writeHead(204);
      return response.end();
    }
    json(response, 404, {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    /** The relay's settings for this stand-in; `relayBase` fixes the one redirect URI it accepts, as an OAuth App does. */
    app(relayBase: string): GitHub {
      redirectUri = `${relayBase}/ui/auth/github/callback`;
      return { clientId, clientSecret, web: base, api: base };
    },
    signIn(account: Account | undefined) {
      signedIn = account;
    },
    exchanges,
    revoked,
    /** Tokens GitHub still considers valid. */
    live: () => tokens.size,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeGitHub = Awaited<ReturnType<typeof fakeGitHub>>;
