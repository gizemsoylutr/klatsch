import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { authorizeUrl, displayName, identify, newAttempt } from '../src/auth/github.ts';
import { checkServing, envConfig, GITHUB_API, GITHUB_WEB, loadConfig } from '../src/config.ts';
import { fakeGitHub, type Account, type FakeGitHub } from './github-fake.ts';
import { BASE, setup } from './helpers.ts';

const SECRET = 'gh-secret-value-0123456789';

describe('GitHub OAuth App settings', () => {
  it('reads the client id with a secret, or with a secret file (a Docker secret), or nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klatsch-gh-'));
    try {
      writeFileSync(join(dir, 'secret'), `${SECRET}\n`);
      const app = { clientId: 'Ov23li', clientSecret: SECRET, web: GITHUB_WEB, api: GITHUB_API };
      assert.deepEqual(envConfig({ KLATSCH_GITHUB_CLIENT_ID: 'Ov23li', KLATSCH_GITHUB_CLIENT_SECRET: SECRET }).github, app);
      assert.deepEqual(envConfig({ KLATSCH_GITHUB_CLIENT_ID: 'Ov23li', KLATSCH_GITHUB_CLIENT_SECRET_FILE: join(dir, 'secret') }).github, app);
      assert.equal(envConfig({ KLATSCH_GITHUB_CLIENT_ID: '', KLATSCH_GITHUB_CLIENT_SECRET: '' }).github, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses half a configuration without ever naming the secret', () => {
    const refusals = [
      { KLATSCH_GITHUB_CLIENT_SECRET: SECRET },
      { KLATSCH_GITHUB_CLIENT_ID: 'Ov23li' },
      { KLATSCH_GITHUB_CLIENT_ID: 'Ov23li', KLATSCH_GITHUB_CLIENT_SECRET: SECRET, KLATSCH_GITHUB_CLIENT_SECRET_FILE: '/run/secrets/x' },
      { KLATSCH_GITHUB_CLIENT_ID: 'Ov23li', KLATSCH_GITHUB_CLIENT_SECRET_FILE: `/nonexistent/${SECRET}` },
    ];
    for (const env of refusals) {
      assert.throws(
        () => envConfig(env),
        (error: Error) => /KLATSCH_GITHUB_CLIENT/.test(error.message) && !error.message.includes(SECRET),
      );
    }
  });

  it('lets only a relay on loopback talk to a GitHub stand-in', () => {
    const app = { clientId: 'id', clientSecret: 's', web: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9' };
    assert.doesNotThrow(() => checkServing(loadConfig({ github: app })));
    assert.throws(() => checkServing(loadConfig({ publicUrl: 'https://klatsch.example', host: '0.0.0.0', github: app })), /github\.com only/);
    assert.doesNotThrow(() =>
      checkServing(loadConfig({ publicUrl: 'https://klatsch.example', host: '0.0.0.0', github: { ...app, web: GITHUB_WEB, api: GITHUB_API } })),
    );
  });

  it('asks GitHub for the two scopes it needs, with an S256 challenge of a verifier that stays here', () => {
    const { state, verifier } = newAttempt();
    const url = new URL(authorizeUrl({ clientId: 'id', clientSecret: SECRET, web: GITHUB_WEB, api: GITHUB_API }, `${BASE}/ui/auth/github/callback`, state, verifier));
    assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(url.searchParams.get('scope'), 'read:user user:email');
    assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), `${BASE}/ui/auth/github/callback`);
    assert.ok(!url.toString().includes(verifier) && !url.toString().includes(SECRET));
  });
});

describe('without a GitHub OAuth App', () => {
  it('shows no GitHub button, has no GitHub routes, and login links work as before', async () => {
    const t = setup();
    const page = await t.app.request(`${BASE}/ui`);
    assert.equal(page.status, 401);
    assert.doesNotMatch(await page.text(), /GitHub/);
    assert.equal((await t.app.request(`${BASE}/ui/auth/github`)).status, 404);
    assert.equal((await t.app.request(`${BASE}/ui/auth/github/callback?code=x&state=y`)).status, 404);
    assert.match(await (await t.human(t.alice)).page(), /Hi, Alice/);
    assert.doesNotMatch(await (await t.human(t.alice)).settings(), /GitHub/);
  });
});

describe('with a GitHub OAuth App', () => {
  let github: FakeGitHub;
  const account = (id: number, extra: Partial<Account> = {}): Account => ({ id, login: `user${id}`, name: null, emails: [], ...extra });

  before(async () => {
    github = await fakeGitHub();
  });
  after(async () => {
    await github.close();
  });

  /** A code GitHub issued for `verifier`, as its authorize page would send back. */
  const codeFor = async (app: ReturnType<FakeGitHub['app']>, redirectUri: string, verifier: string) => {
    const authorize = await fetch(authorizeUrl(app, redirectUri, 'state', verifier), { redirect: 'manual' });
    return new URL(authorize.headers.get('location')!).searchParams.get('code')!;
  };

  it('keeps a display name only of what a reader can see, and falls back to the login', () => {
    assert.equal(displayName('\u202EAlice\u200B\u0007 Smith', 'x'), 'Alice Smith');
    assert.equal(displayName('Ali\u2028ce\u2029', 'x'), 'Alice');
    assert.equal(displayName('\u3164\u115F\u1160\uFFA0\u2800', 'the-login'), 'the-login');
    assert.equal(displayName('   ', 'the-login'), 'the-login');
    assert.equal(displayName('\u0301\u0301', 'the-login'), 'the-login', 'marks alone are not visible');
    assert.equal(displayName('Z\u0301\u0302\u0303\u0304\u0305oe', 'x'), 'Z\u0301\u0302oe', 'at most two marks per letter');
    assert.equal(displayName('Ann\u3000\u00A0 Lee', 'x'), 'Ann Lee');
    assert.equal([...displayName('é'.repeat(300), 'x')].length, 100);
  });

  it('keeps a GitHub name only without control or invisible characters, and ignores a noreply address', async () => {
    const redirectUri = `${BASE}/ui/auth/github/callback`;
    const app = github.app(BASE);
    github.signIn(account(5, { name: '‮Alice​\u0007 Smith', emails: [{ email: '5+user5@users.noreply.github.com', primary: true, verified: true }] }));
    const { verifier } = newAttempt();
    const who = await identify(app, await codeFor(app, redirectUri, verifier), verifier, redirectUri);
    assert.deepEqual(who, { id: 5, login: 'user5', name: 'Alice Smith', email: undefined });
    assert.equal(github.live(), 0, 'the token was revoked');
  });

  it('gives nothing back for a profile that is not what GitHub sends, and still revokes the token', async () => {
    const redirectUri = `${BASE}/ui/auth/github/callback`;
    const app = github.app(BASE);
    for (const odd of [account(0), account(-3), { ...account(9), login: 'not a login' }, { ...account(9), login: 'x'.repeat(40) }]) {
      github.signIn(odd);
      const { verifier } = newAttempt();
      assert.equal(await identify(app, await codeFor(app, redirectUri, verifier), verifier, redirectUri), undefined);
    }
    assert.equal(github.live(), 0);
  });

  it('gives nothing back when GitHub cannot be reached', async () => {
    const app = { clientId: 'id', clientSecret: SECRET, web: 'http://127.0.0.1:9', api: 'http://127.0.0.1:9' };
    assert.equal(await identify(app, 'code', 'verifier', `${BASE}/ui/auth/github/callback`), undefined);
  });

  it('offers GitHub only on the public origin: in local mode not on localhost, where GitHub would not send anyone back', async () => {
    const t = setup({ config: { github: github.app(BASE) } });
    const signIn = await (await t.app.request(`${BASE}/ui`)).text();
    assert.match(signIn, /Sign in with GitHub/);
    assert.match(signIn, /Ask for a new login link in the terminal where Klatsch runs/, 'a local relay keeps the terminal hint');
    const local = 'http://localhost:7417';
    assert.doesNotMatch(await (await t.app.request(`${local}/ui`)).text(), /GitHub/);
    assert.equal((await t.app.request(`${local}/ui/auth/github`)).status, 404);
  });

  it('names GitHub on the landing page only while it is the one way in', async () => {
    const html = { headers: { Accept: 'text/html' } };
    const only = setup({ config: { github: github.app(BASE) } });
    assert.match(await (await only.app.request(`${BASE}/`, html)).text(), /href="\/ui">Sign in with GitHub</);
    const both = setup({ config: { github: github.app(BASE) }, mailer: () => {} });
    const page = await (await both.app.request(`${BASE}/`, html)).text();
    assert.match(page, /href="\/ui">Sign in</);
    assert.doesNotMatch(page, /Sign in with GitHub/, 'with email sign-in beside GitHub the buttons just say Sign in');
  });

  it('sets the sign-in cookie HttpOnly, SameSite=Lax, short-lived and only on its own path', async () => {
    const t = setup({ config: { github: github.app(BASE) } });
    const start = await t.app.request(`${BASE}/ui/auth/github`);
    assert.equal(start.status, 302);
    assert.match(start.headers.get('set-cookie') ?? '', /^klatsch_github=[\w-]+; Max-Age=600; Path=\/ui\/auth\/github; HttpOnly; SameSite=Lax$/);
    assert.match(start.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  });

  it('sets the sign-in cookie host-only with the __Host- prefix on a hosted relay', async () => {
    const t = setup({ config: { host: '0.0.0.0', publicUrl: 'https://klatsch.example', github: github.app('https://klatsch.example') } });
    const start = await t.app.request('https://klatsch.example/ui/auth/github');
    assert.match(start.headers.get('set-cookie') ?? '', /^__Host-klatsch_github=[\w-]+; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  });

  it('starts at most 40 sign-ins per address in ten minutes, counting the address the proxy saw', async () => {
    const t = setup({ config: { host: '0.0.0.0', publicUrl: 'https://klatsch.example', github: github.app('https://klatsch.example') } });
    const start = (from: string) => t.app.request('https://klatsch.example/ui/auth/github', { headers: { 'X-Forwarded-For': from } });
    for (let i = 0; i < 40; i++) assert.equal((await start(`spoofed-${i}, 203.0.113.5`)).status, 302);
    assert.equal((await start('203.0.113.5')).status, 429, 'what a client puts in front does not count');
    assert.equal((await start('198.51.100.7')).status, 302, 'another address is not affected');
  });
});
