// OAuth for apps that cannot be given a token (ChatGPT, claude.ai): the app finds the server from the 401,
// registers, sends the person to the consent page, and trades the code (with PKCE) for an ordinary agent token.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { agent, signedOutBrowser, startRelay, unauthorized, type Relay, type SignedOutBrowser } from './harness.ts';

const verifier = () => randomBytes(32).toString('base64url');
const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url');

describe('OAuth: an app connects as the person’s agent after they approve it, and nothing more', () => {
  let relay: Relay;
  let alice = '';
  let visitor: SignedOutBrowser;
  let clientId = '';
  let callback = '';
  let refresh = '';
  let access = '';
  const post = (path: string, body: Record<string, unknown>, form = false) =>
    fetch(`${relay.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
    });
  const authorizeUrl = (params: Record<string, string>) => `/ui/oauth/authorize?${new URLSearchParams(params)}`;
  const codeFrom = (hops: string[]) => new URL(hops.at(-1)!).searchParams;
  const answer = async (response: Response | Promise<Response>) => (await (await response).json()) as Record<string, string>;

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    const bob = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', alice), bob, alice);
    callback = `${relay.base}/test-app/callback`;
    visitor = signedOutBrowser(relay);
  });
  after(async () => relay.close());

  it('an app without a token finds the server and its endpoints from the 401', async () => {
    const refused = await fetch(`${relay.base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
    assert.equal(refused.status, 401);
    const challenge = refused.headers.get('www-authenticate') ?? '';
    assert.match(challenge, /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
    const resource = (await (await fetch(`${relay.base}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string; authorization_servers: string[] };
    assert.equal(resource.resource, `${relay.base}/mcp`);
    assert.deepEqual(resource.authorization_servers.map((s: string) => s.replace(/\/$/, '')), [relay.base]);
    assert.equal((await fetch(`${relay.base}/.well-known/oauth-protected-resource`)).status, 200);
    const server = (await (await fetch(`${relay.base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    assert.equal(server.authorization_endpoint, `${relay.base}/ui/oauth/authorize`);
    assert.equal(server.token_endpoint, `${relay.base}/oauth/token`);
    assert.equal(server.registration_endpoint, `${relay.base}/oauth/register`);
    assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  });

  it('the landing page and /llms.txt give chat apps the address to add, and every tool has a title', async () => {
    const landing = await (await fetch(`${relay.base}/`, { headers: { Accept: 'text/html' } })).text();
    assert.ok(landing.includes(`<code>${relay.base}/mcp</code>`), 'the connector address on the landing page');
    const llms = await fetch(`${relay.base}/llms.txt`);
    assert.equal(llms.status, 200);
    const text = await llms.text();
    assert.ok(text.startsWith('# Klatsch') && text.includes(`add ${relay.base}/mcp as a connector`));
    for (const path of ['/icon.png', '/favicon.ico', '/apple-touch-icon.png']) {
      const icon = await fetch(`${relay.base}${path}`);
      assert.equal(icon.headers.get('content-type'), 'image/png', path);
      assert.deepEqual([...new Uint8Array(await icon.arrayBuffer()).slice(1, 4)], [0x50, 0x4e, 0x47], 'a PNG');
    }
    const app = await agent(relay, relay.agentToken(alice));
    const { tools } = await app.listTools();
    assert.ok(tools.length >= 10 && tools.every((t) => typeof t.title === 'string' && t.title.length > 0), 'directories ask for a title on every tool');
    await app.close();
  });

  it('registration takes https or localhost redirects only, and gives a public client', async () => {
    const plain = await post('/oauth/register', { client_name: 'Plain', redirect_uris: ['http://app.example/cb'] });
    assert.equal(plain.status, 400);
    assert.equal((await answer(plain)).error, 'invalid_redirect_uri');
    const made = await post('/oauth/register', { client_name: 'Test App\u0007', redirect_uris: [callback] });
    assert.equal(made.status, 201);
    const client = await answer(made);
    clientId = client.client_id!;
    assert.equal(client.client_name, 'Test App', 'control characters are dropped');
    assert.equal(client.token_endpoint_auth_method, 'none');
  });

  it('an unknown app or an unregistered redirect is shown on the page and never followed', async () => {
    const v = verifier();
    const common = { response_type: 'code', code_challenge: challengeOf(v), code_challenge_method: 'S256', state: 's1' };
    await visitor.go(relay.loginLink(alice));
    const unknown = await visitor.go(authorizeUrl({ ...common, client_id: 'mcpc_nope', redirect_uri: callback }));
    assert.equal(unknown.status, 400);
    assert.match(unknown.html, /Klatsch does not know this app/);
    const elsewhere = await visitor.go(authorizeUrl({ ...common, client_id: clientId, redirect_uri: 'https://evil.example/cb' }));
    assert.equal(elsewhere.status, 400);
    assert.equal(elsewhere.hops.length, 1, 'no redirect');
    const noPkce = await visitor.go(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: callback, state: 's2' }));
    assert.equal(codeFrom(noPkce.hops).get('error'), 'invalid_request');
    assert.equal(codeFrom(noPkce.hops).get('state'), 's2');
  });

  it('signed out, the person signs in and lands on the consent page; Cancel sends access_denied back', async () => {
    const fresh = signedOutBrowser(relay);
    const v = verifier();
    const url = authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: callback, code_challenge: challengeOf(v), code_challenge_method: 'S256', state: 'xyz' });
    assert.equal((await fresh.go(url, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 401);
    const landed = await fresh.go(relay.loginLink(alice));
    assert.match(landed.html, /Connect Test App\?/);
    assert.match(landed.html, /It can never approve anything/);
    const denied = await fresh.post('/ui/oauth/authorize', { client_id: clientId, redirect_uri: callback, code_challenge: challengeOf(v), code_challenge_method: 'S256', response_type: 'code', state: 'xyz', decision: 'deny' });
    const back = codeFrom(denied.hops);
    assert.equal(back.get('error'), 'access_denied');
    assert.equal(back.get('state'), 'xyz');
  });

  it('Connect gives a one-time code; with the right verifier it buys an agent token that works', async () => {
    const v = verifier();
    const fields = { client_id: clientId, redirect_uri: callback, code_challenge: challengeOf(v), code_challenge_method: 'S256', response_type: 'code', state: 'abc', resource: `${relay.base}/mcp` };
    const page = await visitor.go(authorizeUrl(fields));
    assert.match(page.html, /Connect Test App\?/);
    const allowed = await visitor.post('/ui/oauth/authorize', { ...fields, decision: 'allow' });
    const back = codeFrom(allowed.hops);
    assert.equal(back.get('state'), 'abc');
    assert.equal(back.get('iss'), relay.base);
    const code = back.get('code')!;
    const wrong = await post('/oauth/token', { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: callback, code_verifier: verifier() }, true);
    assert.equal((await answer(wrong)).error, 'invalid_grant');
    const traded = await post('/oauth/token', { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: callback, code_verifier: v }, true);
    assert.equal(traded.status, 200);
    assert.equal(traded.headers.get('cache-control'), 'no-store');
    const tokens = await answer(traded);
    assert.equal(tokens.token_type, 'Bearer');
    access = tokens.access_token!;
    refresh = tokens.refresh_token!;
    const app = await agent(relay, access);
    assert.equal((await app.call('pending')).isError, false);
    await app.close();
    const tokensPage = await visitor.go('/ui/tokens');
    assert.match(tokensPage.html, /Test App/, 'the connection is listed by the app’s name, to revoke');
    // The same code again: refused, and the token it bought is revoked.
    const again = await post('/oauth/token', { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: callback, code_verifier: v }, true);
    assert.equal((await answer(again)).error, 'invalid_grant');
    await assert.rejects(agent(relay, access), unauthorized);
  });

  it('a refresh token rotates the connection once; reused later, it ends it', async () => {
    const v = verifier();
    const fields = { client_id: clientId, redirect_uri: callback, code_challenge: challengeOf(v), code_challenge_method: 'S256', response_type: 'code' };
    await visitor.go(authorizeUrl(fields));
    const code = codeFrom((await visitor.post('/ui/oauth/authorize', { ...fields, decision: 'allow' })).hops).get('code')!;
    const first = await answer(post('/oauth/token', { grant_type: 'authorization_code', code, client_id: clientId, code_verifier: v }, true));
    const second = await answer(post('/oauth/token', { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId }, true));
    assert.ok(second.access_token && second.access_token !== first.access_token);
    await assert.rejects(agent(relay, first.access_token!), unauthorized, 'the old access token stops at once');
    const now = await agent(relay, second.access_token);
    assert.equal((await now.call('pending')).isError, false);
    // Presented again after the retry grace: someone else has it, so the connection ends.
    relay.db.prepare('UPDATE oauth_refresh SET used_at = used_at - 60000 WHERE used_at IS NOT NULL').run();
    const reused = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId }, true);
    assert.equal((await answer(reused)).error, 'invalid_grant');
    await now.close();
    await assert.rejects(agent(relay, second.access_token), unauthorized);
    const after = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: clientId }, true);
    assert.equal((await answer(after)).error, 'invalid_grant', 'nothing refreshes a revoked connection');
    assert.ok(refresh);
  });
});
