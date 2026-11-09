// A stand-in for Google's sign-in on a free port, strict where Google is: the client id and secret, the exact
// redirect URI, PKCE with S256, the nonce it puts in the ID token, codes that work once. Its page does not ask:
// it sends the browser straight back for whoever `signedIn` is. `tamper` changes the claims it issues.
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Google } from '../src/config.ts';

export interface GoogleAccount {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
}

export async function fakeGoogle() {
  const clientId = 'fake.apps.googleusercontent.com';
  const clientSecret = randomBytes(20).toString('hex');
  let signedIn: GoogleAccount | undefined;
  let tamper: (claims: Record<string, unknown>) => Record<string, unknown> = (claims) => claims;
  let redirectUri = '';
  const codes = new Map<string, { account: GoogleAccount; challenge: string; nonce: string; used: boolean }>();
  const seen: URLSearchParams[] = [];
  const jwt = (claims: object) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://google.test');
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.method === 'GET' && url.pathname === '/auth') {
      const q = url.searchParams;
      seen.push(q);
      const ok = signedIn && q.get('client_id') === clientId && q.get('redirect_uri') === redirectUri && q.get('response_type') === 'code' && q.get('scope') === 'openid email profile' && q.get('code_challenge_method') === 'S256' && q.get('state') && q.get('nonce');
      if (!ok) return json(400, { error: 'invalid_request' });
      const code = randomBytes(10).toString('hex');
      codes.set(code, { account: signedIn!, challenge: q.get('code_challenge')!, nonce: q.get('nonce')!, used: false });
      const back = new URL(redirectUri);
      back.search = new URLSearchParams({ code, state: q.get('state')! }).toString();
      response.writeHead(302, { Location: back.toString() });
      return response.end();
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      let text = '';
      for await (const chunk of request) text += String(chunk);
      const q = new URLSearchParams(text);
      const entry = codes.get(q.get('code') ?? '');
      const challenge = createHash('sha256').update(q.get('code_verifier') ?? '').digest('base64url');
      if (!entry || entry.used || q.get('client_id') !== clientId || q.get('client_secret') !== clientSecret || q.get('redirect_uri') !== redirectUri || q.get('grant_type') !== 'authorization_code' || challenge !== entry.challenge) return json(400, { error: 'invalid_grant' });
      entry.used = true;
      const { sub, email, email_verified, name } = entry.account;
      const claims = tamper({ iss: 'https://accounts.google.com', aud: clientId, azp: clientId, exp: Math.floor(Date.now() / 1000) + 600, nonce: entry.nonce, sub, email, email_verified, ...(name ? { name } : {}) });
      return json(200, { access_token: 'ya29.never-used', id_token: jwt(claims), token_type: 'Bearer' });
    }
    json(404, {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    app(relayBase: string): Google {
      redirectUri = `${relayBase}/ui/auth/google/callback`;
      return { clientId, clientSecret, authorize: `${base}/auth`, token: `${base}/token`, issuers: ['https://accounts.google.com'] };
    },
    signIn(account: GoogleAccount | undefined) {
      signedIn = account;
    },
    tamper(change: (claims: Record<string, unknown>) => Record<string, unknown>) {
      tamper = change;
    },
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeGoogle = Awaited<ReturnType<typeof fakeGoogle>>;
