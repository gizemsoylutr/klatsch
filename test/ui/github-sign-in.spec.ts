// Sign in with GitHub in real browsers, against a stand-in GitHub on its own port: Dana opens an invite
// signed out, signs in with GitHub, is back at the invite and joins; Alice connects GitHub on Settings,
// confirms and disconnects; Bob cancels. The new pages in both schemes and both widths.
import { expect, test } from '@playwright/test';
import { createInvite } from '../../src/auth/invites.ts';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { fakeGitHub, type FakeGitHub } from '../github-fake.ts';
import { person, type Person } from './people.ts';

test.describe.serial('sign in with GitHub: join by invite, connect and disconnect GitHub, and the new pages in light and dark', () => {
  let github: FakeGitHub;
  let relay: Relay;
  let alice = '';
  let inviteLink = '';
  let circle = '';
  const people: Person[] = [];

  test.beforeAll(async () => {
    github = await fakeGitHub();
    relay = await startRelay({ github: (base) => github.app(base) });
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    circle = relay.klatsch.ensureCircle('demo', alice);
    inviteLink = createInvite(relay.db, relay.secret, circle, alice, relay.base).link;
  });
  test.afterAll(async () => {
    await Promise.all(people.map((p) => p.context.close()));
    await relay.close();
    await github.close();
  });

  test('Dana opens the invite signed out, clicks "Sign in with GitHub", is back at the invite and clicks Join', async ({ browser }) => {
    const dana = await person(browser, relay, 'Dana', import.meta.filename);
    people.push(dana);
    expect((await dana.open(inviteLink)).status()).toBe(401);
    await expect(dana.page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await dana.shot('github-sign-in.png');
    github.signIn({ id: 4242, login: 'dana', name: 'Dana Kowalski', emails: [{ email: 'dana@example.org', primary: true, verified: true }] });
    expect((await dana.click(dana.page.getByRole('link', { name: 'Sign in with GitHub' }))).status()).toBe(200);
    await expect(dana.page.getByRole('region')).toContainText('Alice (@alice) invites you to demo.');
    await expect(dana.page.getByRole('textbox', { name: 'Handle' })).toHaveCount(0);
    expect((await dana.click(dana.page.getByRole('button', { name: 'Join' }))).status()).toBe(200);
    await expect(dana.page.getByRole('heading', { level: 1, name: 'Hi, Dana Kowalski' })).toBeVisible();
  });

  test('Alice, signed in by login link, clicks "Connect GitHub", continues to GitHub, confirms, and later clicks Disconnect', async ({ browser }) => {
    const a = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(alice));
    people.push(a);
    await a.open(`${relay.base}/ui/settings`);
    github.signIn({ id: 1, login: 'alice-gh', name: 'Alice', emails: [] });
    expect((await a.click(a.page.getByRole('button', { name: 'Connect GitHub' }))).status()).toBe(200);
    expect((await a.click(a.page.getByRole('link', { name: 'Continue to GitHub' }))).status()).toBe(200);
    await expect(a.page.getByText('Connect the GitHub account @alice-gh to your Klatsch account?')).toBeVisible();
    expect((await a.click(a.page.getByRole('button', { name: 'Connect', exact: true }))).status()).toBe(200);
    expect(a.page.url()).toBe(`${relay.base}/ui/settings`);
    await expect(a.page.getByText('Connected to @alice-gh: you can sign in with GitHub.')).toBeVisible();
    await a.shot('github-connected.png');
    expect((await a.click(a.page.getByRole('button', { name: 'Disconnect' }))).status()).toBe(200);
    await expect(a.page.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
  });

  test('Bob clicks Cancel on the confirmation: nothing is connected', async ({ browser }) => {
    const bobId = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(circle, bobId, alice);
    const bob = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(bobId));
    people.push(bob);
    await bob.open(`${relay.base}/ui/settings`);
    github.signIn({ id: 2, login: 'bob-gh', name: null, emails: [] });
    await bob.click(bob.page.getByRole('button', { name: 'Connect GitHub' }));
    await bob.click(bob.page.getByRole('link', { name: 'Continue to GitHub' }));
    expect((await bob.click(bob.page.getByRole('button', { name: 'Cancel' }))).status()).toBe(200);
    await expect(bob.page.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
    expect(relay.klatsch.user(bobId).github_id).toBeNull();
  });

  /** Centered and no wider than its design at 1280px; no sideways scroll at 390px. */
  const checkLayout = async (p: Person, name: string, width: 1280 | 390, colorScheme: string) => {
    // The sign-in page's two halves fill the screen; every other page centres its column.
    if (width === 1280 && name !== 'sign-in') {
      const box = (await p.page.locator('main.page, .sheet').first().boundingBox())!;
      const viewport = await p.page.evaluate<number>('document.documentElement.clientWidth');
      expect(box.width, `${name}: width`).toBeLessThanOrEqual(name === 'settings-github' ? 980 : 420);
      expect(Math.abs(box.x - (viewport - box.x - box.width)), `${name}: centered`).toBeLessThanOrEqual(1);
    } else {
      const [scroll, client] = await p.page.evaluate<[number, number]>('[document.documentElement.scrollWidth, document.documentElement.clientWidth]');
      expect(scroll, `${name}: horizontal scroll`).toBeLessThanOrEqual(client);
    }
    await p.shot(`layout-${name}-${colorScheme}-${width}.png`);
  };

  let next = 100;
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [1280, 390] as const) {
      test(`on a ${width}px screen (${colorScheme}): sign in, needs an invite, join with a handle, Settings, connect, failed`, async ({ browser }) => {
        const id = next++;
        const p = await person(browser, relay, 'Another Alice', import.meta.filename, undefined, { colorScheme, viewport: { width, height: width === 1280 ? 900 : 844 } });
        people.push(p);
        expect((await p.open(`${relay.base}/ui`)).status()).toBe(401);
        await checkLayout(p, 'sign-in', width, colorScheme);
        // Her GitHub login is a handle someone here already has; without an invite, nobody is made.
        github.signIn({ id, login: 'Alice', name: 'Another Alice', emails: [] });
        expect((await p.click(p.page.getByRole('link', { name: 'Sign in with GitHub' }))).status()).toBe(200);
        await expect(p.page.getByRole('heading', { name: 'You need an invite' })).toBeVisible();
        await checkLayout(p, 'needs-invite', width, colorScheme);
        expect((await p.open(createInvite(relay.db, relay.secret, circle, alice, relay.base).link)).status()).toBe(401);
        expect((await p.click(p.page.getByRole('link', { name: 'Sign in with GitHub' }))).status()).toBe(200);
        await expect(p.page.getByText('The handle @alice is taken here, or is not one Klatsch accepts. Pick another.')).toBeVisible();
        await checkLayout(p, 'join-pick-handle', width, colorScheme);
        await p.page.getByRole('textbox', { name: 'Handle' }).fill(`alice-${id}`);
        expect((await p.click(p.page.getByRole('button', { name: 'Join' }))).status()).toBe(200);
        await expect(p.page.getByRole('heading', { level: 1, name: 'Hi, Another Alice' })).toBeVisible();
        await p.open(`${relay.base}/ui/settings`);
        await expect(p.page.getByText('Connected to @Alice: you can sign in with GitHub.')).toBeVisible();
        await checkLayout(p, 'settings-github', width, colorScheme);
        await p.click(p.page.getByRole('button', { name: 'Disconnect' }));
        expect((await p.click(p.page.getByRole('button', { name: 'Connect GitHub' }))).status()).toBe(200);
        await checkLayout(p, 'github-continue', width, colorScheme);
        await p.click(p.page.getByRole('link', { name: 'Continue to GitHub' }));
        await expect(p.page.getByText('Connect the GitHub account @Alice to your Klatsch account?')).toBeVisible();
        await checkLayout(p, 'github-confirm', width, colorScheme);
        await p.click(p.page.getByRole('button', { name: 'Connect', exact: true }));
        expect((await p.open(`${relay.base}/ui/auth/github/callback?code=forged&state=forged`)).status()).toBe(400);
        await expect(p.page.getByText('GitHub sign-in did not finish. Start it again.')).toBeVisible();
        await checkLayout(p, 'sign-in-failed', width, colorScheme);
      });
    }
  }

  test('no CSP violations, and every form post carried the page origin', async () => {
    for (const p of people) await p.expectCleanBrowser();
  });
});
