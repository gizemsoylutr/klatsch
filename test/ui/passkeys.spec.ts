// Passkeys in a real browser: Alice adds one on Settings with Chromium's virtual authenticator (user verified,
// like Face ID), signs out, signs back in with it, and removes it. At `localhost`: a passkey's relying party
// cannot be an IP address. WebKit has no virtual authenticator, so there it checks the buttons stay hidden only
// where the browser cannot use passkeys.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { createLoginLink } from '../../src/auth/web-sessions.ts';
import { person, type Person } from './people.ts';

test.describe.serial('passkeys: add, sign in, remove', () => {
  let relay: Relay;
  let base = '';
  let alice: Person;

  test.beforeAll(async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'the virtual authenticator is a Chromium DevTools feature');
    relay = await startRelay();
    base = relay.base.replace('127.0.0.1', 'localhost');
    const a = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('demo', a);
    // Settings is what this part shows: Home's offer (below) is put away first.
    relay.klatsch.dismissPasskeyOffer(a);
    alice = await person(browser, relay, 'Alice', import.meta.filename, createLoginLink(relay.db, relay.secret, a, base), { at: base });
    const cdp = await alice.context.newCDPSession(alice.page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
  });
  test.afterAll(async () => {
    await alice?.context.close();
    await relay?.close();
  });

  test('Settings shows "Add a passkey"; Alice adds one and sees it listed', async () => {
    await alice.goTo('Settings');
    await expect(alice.page.getByText('Sign in with Face ID, Touch ID or your phone. Klatsch stores only a public key.')).toBeVisible();
    await expect(alice.page.getByText('No passkeys yet.')).toBeVisible();
    const add = alice.page.getByRole('button', { name: 'Add a passkey' });
    await expect(add).toBeVisible();
    await Promise.all([alice.page.waitForEvent('load'), add.click()]);
    await expect(alice.page.locator('#passkeys .row').filter({ hasText: /Passkey|passkey on one device/ }).getByRole('button', { name: 'Remove' })).toHaveCount(1);
    await expect(alice.page.getByText(/Added \d{4}-\d{2}-\d{2} · not used yet/)).toBeVisible();
    await alice.shot('passkeys-settings.png');
  });

  test('Alice signs out and signs back in with the passkey', async () => {
    await alice.signOut();
    await alice.open(`${base}/ui`);
    const signIn = alice.page.getByRole('button', { name: 'Continue with a passkey' });
    await expect(signIn).toBeVisible();
    await alice.shot('passkeys-sign-in.png');
    await Promise.all([alice.page.waitForURL(`${base}/ui`), signIn.click()]);
    await expect(alice.page.getByRole('complementary', { name: 'Chats' })).toBeVisible();
  });

  test('Alice removes the passkey on Settings', async () => {
    await alice.goTo('Settings');
    await expect(alice.page.getByText(/last used \d{4}-\d{2}-\d{2}/)).toBeVisible();
    await alice.click(alice.page.locator('#passkeys').getByRole('button', { name: 'Remove' }));
    await alice.open(`${base}/ui/settings`);
    await expect(alice.page.getByText('No passkeys yet.')).toBeVisible();
    await alice.expectCleanBrowser();
  });
});

test.describe.serial('passkeys: Home offers one after sign-in', () => {
  let relay: Relay;
  let base = '';
  let bobId = '';
  let bob: Person;
  let cdp: Awaited<ReturnType<Person['context']['newCDPSession']>>;
  let authenticatorId = '';
  const authenticator = (isUserVerified: boolean) =>
    cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified, automaticPresenceSimulation: true },
    });

  test.beforeAll(async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'the virtual authenticator is a Chromium DevTools feature');
    relay = await startRelay();
    base = relay.base.replace('127.0.0.1', 'localhost');
    bobId = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.ensureCircle('demo', bobId);
    bob = await person(browser, relay, 'Bob', import.meta.filename, undefined, { at: base });
    cdp = await bob.context.newCDPSession(bob.page);
    await cdp.send('WebAuthn.enable');
  });
  test.afterAll(async () => {
    await bob?.context.close();
    await relay?.close();
  });

  test('a cancelled dialog leaves the card with its button and no error; the next Home does not open it again', async () => {
    // Presence is simulated but verification fails, as when someone cancels Face ID.
    authenticatorId = (await authenticator(false)).authenticatorId;
    await bob.open(createLoginLink(relay.db, relay.secret, bobId, base));
    const offer = bob.page.locator('section[data-passkey-offer]');
    await expect(offer).toBeVisible();
    await expect(offer.getByRole('button', { name: 'Save a passkey' })).toBeEnabled();
    await expect(bob.page.locator('#passkey-error')).toBeHidden();
    expect(relay.db.prepare('SELECT count(*) n FROM passkeys').get()).toEqual({ n: 0 });
    await bob.shot('passkeys-offer.png');
    await bob.open(`${base}/ui`);
    await expect(offer).toBeVisible();
    await expect(offer).not.toHaveAttribute('data-passkey-auto', '1');
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  });

  test('after the next sign-in the dialog opens by itself, Face ID says yes, and the card is gone', async () => {
    await authenticator(true);
    await bob.page.context().clearCookies();
    await Promise.all([bob.page.waitForEvent('load'), bob.open(createLoginLink(relay.db, relay.secret, bobId, base))]);
    await expect.poll(() => (relay.db.prepare('SELECT count(*) n FROM passkeys').get() as { n: number }).n).toBe(1);
    await bob.page.waitForLoadState('load');
    await expect(bob.page.locator('section[data-passkey-offer]')).toHaveCount(0);
    await bob.open(`${base}/ui/settings`);
    await expect(bob.page.locator('#passkeys').getByRole('button', { name: 'Remove' })).toHaveCount(1);
  });

  test('"Not now" puts the card away for good; Settings still offers a passkey', async () => {
    relay.db.prepare('DELETE FROM passkeys').run();
    await bob.open(`${base}/ui`);
    const offer = bob.page.locator('section[data-passkey-offer]');
    await expect(offer).toBeVisible();
    await bob.click(offer.getByRole('button', { name: 'Not now' }));
    await expect(offer).toHaveCount(0);
    await bob.open(`${base}/ui/settings`);
    await expect(bob.page.getByRole('button', { name: 'Add a passkey' })).toBeVisible();
    await bob.expectCleanBrowser();
  });
});

test('the passkey button stays hidden where passkeys do not work (127.0.0.1)', async ({ browser }) => {
  const relay = await startRelay();
  try {
    const visitor = await person(browser, relay, 'Visitor', import.meta.filename);
    await visitor.open(`${relay.base}/ui`);
    await expect(visitor.page.getByRole('button', { name: 'Continue with a passkey' })).toHaveCount(0);
    await visitor.expectCleanBrowser();
    await visitor.context.close();
  } finally {
    await relay.close();
  }
});
