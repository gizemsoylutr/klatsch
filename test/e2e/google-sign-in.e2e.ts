// Sign in with Google against a stand-in: a new person comes from an invite and is made only when they join; a
// returning one is found by Google's id, never by address. Around that: an address someone here has, an unverified
// address, connecting from Settings with a confirmation, and the attacks on the callback and the ID token.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createInvite } from '../../src/auth/invites.ts';
import { loadConfig, checkServing } from '../../src/config.ts';
import { fakeGoogle, type FakeGoogle, type GoogleAccount } from '../google-fake.ts';
import { browser, signedOutBrowser, startRelay, type Relay, type SignedOutBrowser } from './harness.ts';

const DANA: GoogleAccount = { sub: '1001', email: 'Dana.K@example.org', email_verified: true, name: 'Dana Kowalski' };
const users = (relay: Relay) => (relay.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
const continueLink = (html: string) => html.match(/<a class="button primary" href="([^"]+)">Continue to Google<\/a>/)![1]!.replace(/&amp;/g, '&');

describe('sign in with Google: made only by joining, found by id only, verified addresses only', () => {
  let google: FakeGoogle;
  let relay: Relay;
  let alice = '';
  let circle = '';
  const invite = () => createInvite(relay.db, relay.secret, circle, alice, relay.base).link;
  const fromInvite = async (account: GoogleAccount) => {
    const b = signedOutBrowser(relay);
    await b.go(invite(), { headers: { 'Sec-Fetch-Site': 'none' } });
    google.signIn(account);
    return { b, page: await b.go('/ui/auth/google') };
  };

  before(async () => {
    google = await fakeGoogle();
    relay = await startRelay({ google: (base) => google.app(base) });
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    circle = relay.klatsch.ensureCircle('demo', alice);
  });
  after(async () => {
    await relay.close();
    await google.close();
  });

  it('the sign-in page offers Google, and the landing page does not say GitHub only', async () => {
    const page = await signedOutBrowser(relay).go('/ui/settings', { headers: { 'Sec-Fetch-Site': 'none' } });
    assert.equal(page.status, 401);
    assert.match(page.html, /href="\/ui\/auth\/google"[^]*Continue with Google/);
    assert.match(page.html, /no access to your mail or files/);
    const landing = await (await fetch(new URL('/', relay.base), { headers: { Accept: 'text/html' } })).text();
    assert.doesNotMatch(landing, /Sign in with GitHub/);
  });

  let dana: SignedOutBrowser;
  it('Dana comes from an invite and is asked to join, with a handle from her address; nobody is made yet, and the request asks only for what it needs', async () => {
    const before = users(relay);
    const { b, page } = await fromInvite(DANA);
    dana = b;
    assert.equal(page.status, 200);
    assert.match(page.html, /invites you to <strong>demo<\/strong>/);
    assert.equal(users(relay), before);
    const asked = google.seen.at(-1)!;
    assert.equal(asked.get('scope'), 'openid email profile');
    assert.equal(asked.get('code_challenge_method'), 'S256');
    assert.ok(asked.get('nonce'));
    assert.equal(asked.get('redirect_uri'), `${relay.base}/ui/auth/google/callback`);
    assert.equal(asked.get('access_type'), null, 'no refresh token is asked for');
  });

  it('she joins: the person has her confirmed address, and no Google token is kept', async () => {
    const page = await dana.post('/ui/auth/google/join');
    assert.equal(page.status, 200);
    const id = relay.klatsch.userByGoogle(DANA.sub)!;
    const user = relay.klatsch.user(id);
    assert.equal(user.handle, 'dana-k');
    assert.equal(user.display_name, 'Dana Kowalski');
    assert.equal(user.email, DANA.email);
    assert.ok(user.email_verified_at);
    assert.ok(!JSON.stringify(relay.db.prepare('SELECT * FROM users').all()).includes('ya29'));
  });

  it('she comes back with a changed address and is found by id', async () => {
    const b = signedOutBrowser(relay);
    google.signIn({ ...DANA, email: 'dana.new@example.org' });
    const page = await b.go('/ui/auth/google');
    assert.equal(page.status, 200);
    assert.match(page.html, /Hi, Dana Kowalski/);
    assert.equal(relay.klatsch.user(relay.klatsch.userByGoogle(DANA.sub)!).google_email, 'dana.new@example.org');
  });

  it('a Google account with an address someone here has is refused, and is linked to nobody', async () => {
    const before = users(relay);
    const { page } = await fromInvite({ sub: '2002', email: DANA.email, email_verified: true });
    assert.equal(page.status, 409);
    assert.match(page.html, /Someone here already uses this address/);
    assert.equal(relay.klatsch.userByGoogle('2002'), undefined);
    assert.equal(users(relay), before);
  });

  it('a variant of that mailbox is refused too', async () => {
    const taken = relay.klatsch.ensureUser('erin', 'Erin');
    relay.klatsch.setVerifiedEmail(taken, 'erin@gmail.com', 'cli');
    const { page } = await fromInvite({ sub: '2003', email: 'e.rin+x@gmail.com', email_verified: true });
    assert.equal(page.status, 409);
  });

  it('an address Google has not verified signs nobody in', async () => {
    const before = users(relay);
    const { page } = await fromInvite({ sub: '3003', email: 'frank@example.org', email_verified: false });
    assert.equal(page.status, 400);
    assert.match(page.html, /Google sign-in did not finish/);
    assert.equal(users(relay), before);
  });

  it('no invite, no person', async () => {
    const before = users(relay);
    const b = signedOutBrowser(relay);
    google.signIn({ sub: '4004', email: 'gina@example.org', email_verified: true });
    const page = await b.go('/ui/auth/google');
    assert.match(page.html, /You signed in with Google as gina@example.org/);
    assert.equal(users(relay), before);
  });

  for (const [what, change] of [
    ['another audience', (c: Record<string, unknown>) => ({ ...c, aud: 'someone-else' })],
    ['another issuer', (c: Record<string, unknown>) => ({ ...c, iss: 'https://evil.example' })],
    ['another authorized party', (c: Record<string, unknown>) => ({ ...c, azp: 'someone-else' })],
    ['an old token', (c: Record<string, unknown>) => ({ ...c, exp: 1000 })],
    ['another nonce', (c: Record<string, unknown>) => ({ ...c, nonce: 'replayed' })],
    ['no subject', (c: Record<string, unknown>) => ({ ...c, sub: undefined })],
  ] as const) {
    it(`an ID token with ${what} signs nobody in`, async () => {
      google.tamper(change);
      const { page } = await fromInvite({ sub: '5005', email: 'hal@example.org', email_verified: true });
      google.tamper((c) => c);
      assert.equal(page.status, 400);
      assert.equal(relay.klatsch.userByGoogle('5005'), undefined);
    });
  }

  it('a forged callback, a replay, and a start from another site do nothing', async () => {
    const b = signedOutBrowser(relay);
    assert.equal((await b.go('/ui/auth/google/callback?code=x&state=y')).status, 400);
    const other = await b.request(`${relay.base}/ui/auth/google`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(other.status, 303);
    google.signIn(DANA);
    const c = signedOutBrowser(relay);
    const started = await c.request(`${relay.base}/ui/auth/google`);
    const atGoogle = await fetch(started.headers.get('location')!, { redirect: 'manual' });
    const back = atGoogle.headers.get('location')!;
    assert.equal((await c.go(back)).status, 200);
    assert.equal((await c.go(back)).status, 400, 'a replayed callback finds nothing');
  });

  it('Alice connects Google only by asking and confirming, hears of it, and disconnects', async () => {
    const a = await browser(relay, relay.loginLink(alice));
    const signed = signedOutBrowser(relay);
    await signed.go(relay.loginLink(alice));
    const settings = await signed.go('/ui/settings');
    assert.match(settings.html, /Connect Google/);
    google.signIn({ sub: '6006', email: 'alice@example.org', email_verified: true });
    const lead = await signed.post('/ui/auth/google/connect');
    assert.equal(relay.klatsch.user(alice).google_sub, null, 'nothing yet');
    const confirm = await signed.go(continueLink(lead.html));
    assert.match(confirm.html, /Connect the Google account alice@example.org to your Klatsch account/);
    assert.equal(relay.klatsch.user(alice).google_sub, null, 'still nothing');
    await signed.post('/ui/auth/google/cancel');
    assert.equal(relay.klatsch.user(alice).google_sub, null, 'cancel connects nothing');
    const again = await signed.post('/ui/auth/google/connect');
    await signed.go(continueLink(again.html));
    await signed.post('/ui/auth/google/link');
    assert.equal(relay.klatsch.user(alice).google_sub, '6006');
    assert.ok(relay.notifications.some((line) => line.includes('A Google account can now sign in')));
    assert.match((await a.get('/ui/settings')).html, /Connected to alice@example.org/);
    await signed.post('/ui/settings/google/disconnect');
    assert.equal(relay.klatsch.user(alice).google_sub, null);
    assert.ok(relay.notifications.some((line) => line.includes('Google sign-in was disconnected')));
  });

  it('a Google account that signs in as someone else cannot be connected', async () => {
    const signed = signedOutBrowser(relay);
    await signed.go(relay.loginLink(alice));
    google.signIn(DANA);
    const lead = await signed.post('/ui/auth/google/connect');
    const page = await signed.go(continueLink(lead.html));
    assert.equal(page.status, 409);
    assert.match(page.html, /already signs in as someone else/);
  });

  it('a removal sticks through Google: the removed mailbox is not let back in by an old invite', async () => {
    const irene = relay.klatsch.ensureUser('irene', 'Irene');
    relay.klatsch.addMember(circle, irene, alice);
    relay.klatsch.setVerifiedEmail(irene, 'irene@example.org', 'cli');
    const old = createInvite(relay.db, relay.secret, circle, alice, relay.base).link;
    relay.klatsch.removeMember(alice, circle, irene);
    relay.klatsch.setVerifiedEmail(irene, 'irene.other@example.org', 'cli');
    const b = signedOutBrowser(relay);
    await b.go(old, { headers: { 'Sec-Fetch-Site': 'none' } });
    google.signIn({ sub: '7007', email: 'irene@example.org', email_verified: true });
    await b.go('/ui/auth/google');
    const page = await b.post('/ui/auth/google/join');
    assert.ok(page.status >= 400);
    assert.equal(relay.klatsch.userByGoogle('7007'), undefined);
  });

  it('a hosted relay signs in with Google itself only', () => {
    const fake = google.app(relay.base);
    assert.throws(() => checkServing(loadConfig({ publicUrl: 'https://k.example', host: '0.0.0.0', google: fake })), /Google itself/);
    google.app(relay.base);
  });
});
