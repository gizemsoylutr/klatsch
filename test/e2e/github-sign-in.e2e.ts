// Sign in with GitHub on a relay with an OAuth App, against a stand-in GitHub on its own port. A new person
// comes from an invite link, signs in with GitHub, lands back on the invite and is made only when they join.
// Around that: a returning person found by GitHub id after renaming their login, a login that collides with
// a handle, an unverified address, no invite, connecting GitHub to an existing person only by asking for it
// and confirming it, disconnecting, a removed member, and the attacks on the callback (wrong state, no
// verifier, an injected code, a replay, a sign-in started by another site).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApproval } from '../../src/auth/approvals.ts';
import { createInvite } from '../../src/auth/invites.ts';
import { fakeGitHub, type Account, type FakeGitHub } from '../github-fake.ts';
import { signedOutBrowser, startRelay, type Relay, type SignedOutBrowser } from './harness.ts';

const DANA: Account = { id: 4242, login: 'Dana-K', name: 'Dana Kowalski', emails: [{ email: 'dana@example.org', primary: true, verified: true }] };

const authorizeHop = (hops: string[], github: FakeGitHub) => new URL(hops.find((h) => h.startsWith(`${github.base}/login/oauth/authorize`))!);
const userCount = (relay: Relay) => (relay.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
const sessionCount = (relay: Relay) => (relay.db.prepare('SELECT count(*) AS n FROM web_sessions').get() as { n: number }).n;
/** The "Continue to GitHub" link on the page the Settings form leads to. */
const continueLink = (html: string) => html.match(/<a class="button primary" href="([^"]+)">Continue to GitHub<\/a>/)![1]!.replaceAll('&amp;', '&');

describe('sign in with GitHub: a new person is made only when they join by invite, connecting GitHub needs a confirmation, and the callback refuses what it should', () => {
  let github: FakeGitHub;
  let relay: Relay;
  let alice = '';
  let circle = '';
  let inviteLink = '';
  const invite = () => createInvite(relay.db, relay.secret, circle, alice, relay.base).link;
  /** A browser that opened `link` signed out (so the relay remembers it), then signed in with GitHub as `account`. */
  const fromInvite = async (link: string, account: Account) => {
    const b = signedOutBrowser(relay);
    await b.go(link, { headers: { 'Sec-Fetch-Site': 'none' } });
    github.signIn(account);
    return { b, page: await b.go('/ui/auth/github') };
  };

  before(async () => {
    github = await fakeGitHub();
    relay = await startRelay({ github: (base) => github.app(base) });
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    circle = relay.klatsch.ensureCircle('demo', alice);
    inviteLink = invite();
  });
  after(async () => {
    await relay.close();
    await github.close();
  });

  it('Dana opens an invite link without a session: the page offers Sign in with GitHub', async () => {
    const page = await signedOutBrowser(relay).go(inviteLink, { headers: { 'Sec-Fetch-Site': 'none' } });
    assert.equal(page.status, 401);
    assert.match(page.html, /<a class="way" href="\/ui\/auth\/github"><svg[^]*?<\/svg><span>Continue with GitHub<\/span><\/a>/);
    const landing = await (await fetch(new URL('/', relay.base), { headers: { Accept: 'text/html' } })).text();
    assert.match(landing, /<a class="btn primary lg" href="\/ui">Sign in with GitHub<\/a>/, 'the landing page says how this relay signs in');
    assert.doesNotMatch(page.html, /demo|Alice/, 'nothing about the invite before signing in');
  });

  let dana: SignedOutBrowser;
  it('she signs in with GitHub and is back at the invite, asked to join; nobody is made yet', async () => {
    const { b, page } = await fromInvite(inviteLink, DANA);
    dana = b;
    const authorize = authorizeHop(page.hops, github);
    assert.equal(authorize.searchParams.get('scope'), 'read:user user:email');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('redirect_uri'), `${relay.base}/ui/auth/github/callback`);
    assert.equal(page.status, 200);
    assert.match(page.html, /<strong>Alice<\/strong> \(@alice\) invites you to <strong>demo<\/strong>/);
    assert.doesNotMatch(page.html, /<input name="handle"/, 'her login is a free handle: nothing to pick');
    assert.equal(relay.klatsch.userByGitHub(DANA.id), undefined);
  });

  it('the relay keeps no GitHub token: it revoked the one it used', () => {
    assert.equal(github.revoked.length, 1);
    assert.equal(github.live(), 0);
    const stored = JSON.stringify(relay.db.prepare('SELECT * FROM users').all()) + JSON.stringify(relay.db.prepare('SELECT * FROM audit').all());
    assert.ok(!stored.includes(github.revoked[0]!), 'not in the database');
  });

  it('she clicks Join: @dana-k is made with her GitHub name and verified address, in the circle, signed in', async () => {
    const joined = await dana.post('/ui/auth/github/join');
    assert.match(joined.html, /Hi, Dana Kowalski/);
    const user = relay.klatsch.user(relay.klatsch.userByGitHub(DANA.id)!);
    assert.equal(user.handle, 'dana-k');
    assert.equal(user.email, 'dana@example.org');
    assert.ok(user.email_verified_at, 'GitHub verified it: no confirmation mail');
    assert.equal(relay.klatsch.memberRole(user.id, circle), 'member');
    assert.equal((await signedOutBrowser(relay).go(inviteLink)).status, 401, 'the invite is used up');
  });

  it('Dana renames her GitHub login and signs in again: the same person, found by her GitHub id', async () => {
    const before = userCount(relay);
    github.signIn({ ...DANA, login: 'dana-renamed', name: 'Dana R.' });
    const page = await signedOutBrowser(relay).go('/ui/auth/github');
    assert.match(page.html, /Hi, Dana Kowalski/);
    assert.equal(userCount(relay), before);
    const user = relay.klatsch.user(relay.klatsch.userByGitHub(DANA.id)!);
    assert.equal(user.handle, 'dana-k');
    assert.equal(user.github_login, 'dana-renamed', 'Settings shows the login GitHub has now');
  });

  it('a GitHub sign-in without an invite makes nobody and opens no session: the page says an invite is needed', async () => {
    github.signIn({ id: 7, login: 'erin', name: null, emails: [] });
    const b = signedOutBrowser(relay);
    const before = userCount(relay);
    const page = await b.go('/ui/auth/github');
    assert.equal(page.status, 200);
    assert.match(page.html, /You signed in with GitHub as @erin, and are in no circle here yet/);
    assert.equal(userCount(relay), before);
    assert.equal((await b.post('/ui/tokens')).status, 401, 'no session, so no agent token');
  });

  it('a GitHub login that is already a handle here picks one on the invite page; a taken one is refused, a free one sticks', async () => {
    const { b, page } = await fromInvite(invite(), { id: 99, login: 'Alice', name: 'Another Alice', emails: [] });
    assert.match(page.html, /The handle @alice is taken here/);
    assert.match(page.html, /<input name="handle"/);
    const taken = await b.post('/ui/auth/github/join', { handle: 'dana-k' });
    assert.equal(taken.status, 409);
    assert.match(taken.html, /That handle is taken or not valid/);
    assert.equal((await b.post('/ui/auth/github/join', { handle: '-not-a-handle' })).status, 409);
    const done = await b.post('/ui/auth/github/join', { handle: 'Alice-Two' });
    assert.match(done.html, /Hi, Another Alice/);
    assert.equal(relay.klatsch.user(relay.klatsch.userByGitHub(99)!).handle, 'alice-two');
    assert.equal(relay.klatsch.user(alice).github_id, null, 'never connected to the existing @alice');
  });

  it('the join form is refused from another origin or without its form token', async () => {
    const { b } = await fromInvite(invite(), { id: 100, login: 'Dana-K', name: null, emails: [] });
    const crossSite = await b.request(`${relay.base}/ui/auth/github/join`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'handle=evil',
    });
    assert.equal(crossSite.status, 403);
    assert.equal((await b.post('/ui/auth/github/join', { handle: 'evil', csrf: 'wrong' })).status, 400);
    assert.equal(relay.klatsch.userByGitHub(100), undefined);
  });

  it('ten tries at taken handles end the sign-in', async () => {
    const { b } = await fromInvite(invite(), { id: 101, login: 'alice', name: null, emails: [] });
    for (let i = 1; i < 10; i++) assert.equal((await b.post('/ui/auth/github/join', { handle: 'alice' })).status, 409);
    const ended = await b.post('/ui/auth/github/join', { handle: 'alice' });
    assert.equal(ended.status, 400);
    assert.match(ended.html, /GitHub sign-in did not finish/);
    assert.equal((await b.post('/ui/auth/github/join', { handle: 'free-handle' })).status, 400, 'the step is gone');
    assert.equal(relay.klatsch.userByGitHub(101), undefined);
  });

  it('an unverified primary address is never stored, even when a verified secondary one exists', async () => {
    const { b } = await fromInvite(invite(), {
      id: 8,
      login: 'frank',
      name: 'Frank',
      emails: [
        { email: 'frank@unverified.example', primary: true, verified: false },
        { email: 'frank@other.example', primary: false, verified: true },
      ],
    });
    await b.post('/ui/auth/github/join');
    const frank = relay.klatsch.user(relay.klatsch.userByGitHub(8)!);
    assert.equal(frank.email, null);
    assert.equal(frank.email_verified_at, null);
  });

  it('a callback with a state that is not this browser’s is refused', async () => {
    github.signIn(DANA);
    const b = signedOutBrowser(relay);
    const started = await b.request(`${relay.base}/ui/auth/github`);
    const authorize = await fetch(started.headers.get('location')!.replace(/state=[^&]+/, 'state=forged'), { redirect: 'manual' });
    const sessions = sessionCount(relay);
    const back = await b.go(authorize.headers.get('location')!);
    assert.equal(back.status, 400);
    assert.match(back.html, /GitHub sign-in did not finish/);
    assert.equal(sessionCount(relay), sessions);
  });

  it('a callback in a browser that never started the sign-in (no cookie, so no PKCE verifier) is refused', async () => {
    github.signIn(DANA);
    const started = await signedOutBrowser(relay).request(`${relay.base}/ui/auth/github`);
    const authorize = await fetch(started.headers.get('location')!, { redirect: 'manual' });
    const exchanges = github.exchanges.length;
    const elsewhere = await signedOutBrowser(relay).go(authorize.headers.get('location')!);
    assert.equal(elsewhere.status, 400);
    assert.equal(github.exchanges.length, exchanges, 'the code was never even sent to GitHub');
  });

  it('a code from another sign-in, injected with this browser’s own state, is refused by PKCE', async () => {
    github.signIn(DANA);
    const mallory = await signedOutBrowser(relay).request(`${relay.base}/ui/auth/github`);
    const malloryCode = new URL((await fetch(mallory.headers.get('location')!, { redirect: 'manual' })).headers.get('location')!).searchParams.get('code')!;
    const victim = signedOutBrowser(relay);
    const state = new URL((await victim.request(`${relay.base}/ui/auth/github`)).headers.get('location')!).searchParams.get('state')!;
    const injected = await victim.go(`/ui/auth/github/callback?code=${malloryCode}&state=${state}`);
    assert.equal(injected.status, 400);
    assert.deepEqual(github.exchanges.at(-1), { code: malloryCode, ok: false });
    assert.ok(!victim.jar.has('klatsch_session'), 'nobody signed in as the account behind that code');
  });

  it('a replayed callback is refused, with the same cookie or a fresh sign-in', async () => {
    github.signIn(DANA);
    const b = signedOutBrowser(relay);
    const started = await b.request(`${relay.base}/ui/auth/github`);
    const startCookie = [...b.jar].map(([n, v]) => `${n}=${v}`).join('; ');
    const callback = (await fetch(started.headers.get('location')!, { redirect: 'manual' })).headers.get('location')!;
    assert.match((await b.go(callback)).html, /Hi, Dana Kowalski/);
    assert.equal((await fetch(callback, { headers: { Cookie: startCookie }, redirect: 'manual' })).status, 400);
    const fresh = signedOutBrowser(relay);
    await fresh.request(`${relay.base}/ui/auth/github`);
    assert.equal((await fresh.go(callback)).status, 400);
  });

  it('a sign-in started by another site is not started', async () => {
    const crossSite = await signedOutBrowser(relay).request(`${relay.base}/ui/auth/github`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 303);
    assert.equal(crossSite.headers.get('location'), '/ui');
  });

  it('Alice, signed in with a login link, follows the plain sign-in link: it never connects GitHub to her', async () => {
    const b = signedOutBrowser(relay);
    await b.go(relay.loginLink(alice));
    github.signIn({ id: 1, login: 'alice-gh', name: 'Alice GH', emails: [] });
    assert.match((await b.go('/ui/auth/github')).html, /in no circle here yet/);
    assert.equal(relay.klatsch.user(alice).github_id, null);
    assert.equal(relay.klatsch.userByGitHub(1), undefined);
  });

  it('Alice clicks Connect GitHub on Settings, continues to GitHub and confirms @alice-gh: connected, and she is told', async () => {
    const b = signedOutBrowser(relay);
    await b.go(relay.loginLink(alice));
    assert.match((await b.go('/ui/settings')).html, /<button>Connect GitHub<\/button>/);
    const connect = await b.post('/ui/auth/github/connect');
    assert.equal(connect.status, 200);
    github.signIn({ id: 1, login: 'alice-gh', name: 'Alice GH', emails: [] });
    const confirm = await b.go(continueLink(connect.html));
    assert.match(confirm.html, /Connect the GitHub account @alice-gh to your Klatsch account\?/);
    assert.equal(relay.klatsch.user(alice).github_id, null, 'nothing is written before she confirms');
    const linked = await b.post('/ui/auth/github/link');
    assert.equal(linked.url, `${relay.base}/ui/settings`);
    assert.match(linked.html, /Connected to @alice-gh/);
    assert.equal(relay.klatsch.userByGitHub(1), alice);
    assert.equal(relay.klatsch.user(alice).display_name, 'Alice', 'her name stays hers');
    assert.ok(relay.notifications.some((n) => n.startsWith('@alice: A GitHub account can now sign in')));
    assert.match((await signedOutBrowser(relay).go('/ui/auth/github')).html, /Hi, Alice/);
  });

  it('Bob cancels on the confirmation page: nothing is connected', async () => {
    const bob = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(circle, bob, alice);
    const b = signedOutBrowser(relay);
    await b.go(relay.loginLink(bob));
    github.signIn({ id: 2, login: 'bob-gh', name: null, emails: [] });
    await b.go(continueLink((await b.post('/ui/auth/github/connect')).html));
    const cancelled = await b.post('/ui/auth/github/cancel');
    assert.equal(cancelled.url, `${relay.base}/ui/settings`);
    assert.equal(relay.klatsch.user(bob).github_id, null);
    assert.equal((await b.post('/ui/auth/github/link')).status, 400, 'the confirmation is gone');
  });

  it('a GitHub account that already signs in as someone else cannot be connected to Bob, and the forms need their token', async () => {
    const bob = relay.klatsch.userByGitHub(2) ?? (relay.db.prepare(`SELECT id FROM users WHERE handle = 'bob'`).get() as { id: string }).id;
    const b = signedOutBrowser(relay);
    await b.go(relay.loginLink(bob));
    assert.equal((await b.post('/ui/auth/github/connect', { csrf: 'wrong' })).status, 403);
    github.signIn(DANA);
    const refused = await b.go(continueLink((await b.post('/ui/auth/github/connect')).html));
    assert.equal(refused.status, 409);
    assert.match(refused.html, /already signs in as someone else/);
    assert.equal(relay.klatsch.user(bob).github_id, null);
  });

  it('Alice clicks Disconnect on Settings: GitHub no longer signs her in, and she is told', async () => {
    const b = signedOutBrowser(relay);
    await b.go(relay.loginLink(alice));
    const done = await b.post('/ui/settings/github/disconnect');
    assert.match(done.html, /<button>Connect GitHub<\/button>/);
    assert.equal(relay.klatsch.userByGitHub(1), undefined);
    assert.ok(relay.notifications.some((n) => n === '@alice: GitHub sign-in was disconnected from your Klatsch account.'));
  });

  it('Alice removes Dana; Dana signs in with GitHub and sees only the invite page: no token, no decision', async () => {
    const danaId = relay.klatsch.userByGitHub(DANA.id)!;
    const share = createApproval(relay.db, relay.secret, danaId, 'share_sip', { status: 'looking', tags: JSON.stringify(['express']), summary: 'Paging.', ask_for_intro: 'false' });
    relay.klatsch.removeMember(alice, circle, danaId);
    github.signIn(DANA);
    const b = signedOutBrowser(relay);
    assert.match((await b.go('/ui/auth/github')).html, /You need an invite/);
    assert.equal((await b.post('/ui/tokens')).status, 409);
    assert.equal((await b.go(`/ui/approvals/${share.approval.id}`)).status, 409);
    assert.equal((await b.post(`/ui/approvals/${share.approval.id}/decide`, { decision: 'approved' })).status, 409);
    assert.equal((await b.post('/ui/device', { code: 'BCDF-GHJK' })).status, 409);
    assert.equal((await b.post('/ui/intros/int_x/approve')).status, 409);
    assert.equal((relay.db.prepare(`SELECT count(*) AS n FROM sips WHERE user_id = ?`).get(danaId) as { n: number }).n, 0);
  });
});
