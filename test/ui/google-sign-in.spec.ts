// Sign in with Google in real browsers, against a stand-in: Dana opens an invite signed out, signs in, joins;
// Alice connects Google on Settings, confirms and disconnects; Bob cancels.
import { expect, test } from '@playwright/test';
import { createInvite } from '../../src/auth/invites.ts';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { fakeGoogle, type FakeGoogle } from '../google-fake.ts';
import { person, type Person } from './people.ts';

test.describe.serial('sign in with Google: join by invite, connect and disconnect', () => {
  let google: FakeGoogle;
  let relay: Relay;
  let alice = '';
  let circle = '';
  const people: Person[] = [];

  test.beforeAll(async () => {
    google = await fakeGoogle();
    relay = await startRelay({ google: (base) => google.app(base) });
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    circle = relay.klatsch.ensureCircle('demo', alice);
  });
  test.afterAll(async () => {
    await Promise.all(people.map((p) => p.context.close()));
    await relay.close();
    await google.close();
  });

  test('Dana opens the invite signed out, clicks "Sign in with Google", and joins', async ({ browser }) => {
    const dana = await person(browser, relay, 'Dana', import.meta.filename);
    people.push(dana);
    expect((await dana.open(createInvite(relay.db, relay.secret, circle, alice, relay.base).link)).status()).toBe(401);
    await dana.shot('google-sign-in.png');
    google.signIn({ sub: '42', email: 'dana@example.org', email_verified: true, name: 'Dana Kowalski' });
    expect((await dana.click(dana.page.getByRole('link', { name: 'Sign in with Google' }))).status()).toBe(200);
    await expect(dana.page.getByRole('region')).toContainText('Alice (@alice) invites you to demo.');
    expect((await dana.click(dana.page.getByRole('button', { name: 'Join' }))).status()).toBe(200);
    await expect(dana.page.getByRole('complementary', { name: 'Chats' })).toBeVisible();
  });

  test('Alice clicks "Connect Google", continues, confirms, and later clicks Disconnect', async ({ browser }) => {
    const a = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(alice));
    people.push(a);
    await a.open(`${relay.base}/ui/settings`);
    google.signIn({ sub: '1', email: 'alice@example.org', email_verified: true });
    await a.click(a.page.getByRole('button', { name: 'Connect Google' }));
    await a.click(a.page.getByRole('link', { name: 'Continue to Google' }));
    await expect(a.page.getByText('Connect the Google account alice@example.org to your Klatsch account?')).toBeVisible();
    await a.click(a.page.getByRole('button', { name: 'Connect', exact: true }));
    await expect(a.page.getByText('Connected to alice@example.org: you can sign in with Google.')).toBeVisible();
    await a.shot('google-connected.png');
    await a.click(a.page.getByRole('button', { name: 'Disconnect' }));
    await expect(a.page.getByRole('button', { name: 'Connect Google' })).toBeVisible();
  });

  test('Bob clicks Cancel on the confirmation: nothing is connected', async ({ browser }) => {
    const bobId = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(circle, bobId, alice);
    const bob = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(bobId));
    people.push(bob);
    await bob.open(`${relay.base}/ui/settings`);
    google.signIn({ sub: '2', email: 'bob@example.org', email_verified: true });
    await bob.click(bob.page.getByRole('button', { name: 'Connect Google' }));
    await bob.click(bob.page.getByRole('link', { name: 'Continue to Google' }));
    await bob.click(bob.page.getByRole('button', { name: 'Cancel' }));
    await expect(bob.page.getByRole('button', { name: 'Connect Google' })).toBeVisible();
    expect(relay.klatsch.user(bobId).google_sub).toBeNull();
  });

  test('a forged callback shows the plain failure; no CSP violations, and every post carried the page origin', async () => {
    const dana = people[0]!;
    expect((await dana.open(`${relay.base}/ui/auth/google/callback?code=forged&state=forged`)).status()).toBe(400);
    await expect(dana.page.getByText('Google sign-in did not finish.')).toBeVisible();
    for (const p of people) await p.expectCleanBrowser();
  });
});
