// Signing in, in a real browser: the one-time login link sets an HttpOnly, SameSite=Lax session cookie,
// the link does not work twice, and a browser without a session gets a page with no recipe for one.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

test.describe.serial('sign-in: a one-time login link, a session cookie, signing out', () => {
  let relay: Relay;
  let alice: string;
  let aliceLink = '';
  let people: Person[] = [];

  test.beforeAll(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('demo', alice);
  });
  test.afterAll(async () => {
    await Promise.all(people.map((p) => p.context.close()));
    await relay.close();
  });

  test('Alice opens her login link and lands on her dashboard', async ({ browser }) => {
    aliceLink = relay.loginLink(alice);
    const a = await person(browser, relay, 'Alice', import.meta.filename, aliceLink);
    people.push(a);
    await expect(a.page).toHaveTitle('Alice · Klatsch');
  });

  test('typing the bare relay address shows what Klatsch is; Sign in takes her to her dashboard', async () => {
    const a = people[0]!;
    expect((await a.open(`${relay.base}/`)).status()).toBe(200);
    await expect(a.page).toHaveTitle('Ask your friends from any chat · Klatsch');
    await expect(a.page.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute('href', 'https://github.com/gizemsoylutr/klatsch');
    await expect(a.page.getByRole('figure')).toContainText('Example:');
    await a.shot('sign-in-landing.png');
    expect((await a.click(a.page.getByRole('link', { name: 'Sign in', exact: true }).first())).status()).toBe(200);
    expect(a.page.url()).toBe(`${relay.base}/ui`);
    await expect(a.page).toHaveTitle('Alice · Klatsch');
  });

  test('the session cookie is HttpOnly, SameSite=Lax and scoped to /ui', async () => {
    const cookies = await people[0]!.context.cookies(`${relay.base}/ui`);
    const session = cookies.find((c) => c.name === 'klatsch_session');
    expect(session).toBeDefined();
    expect(session!.httpOnly).toBe(true);
    expect(session!.sameSite).toBe('Lax');
    expect(session!.path).toBe('/ui');
    expect(await people[0]!.page.evaluate('document.cookie'), 'page scripts cannot read it').toBe('');
  });

  test('the same link does not work twice, not even in another browser', async ({ browser }) => {
    const other = await person(browser, relay, 'Mallory', import.meta.filename);
    people.push(other);
    const used = await other.open(aliceLink);
    expect(used.status()).toBe(401);
    await expect(other.page.getByRole('heading', { level: 1 })).toHaveText('Link expired');
    await expect(other.page.getByText('This login link was already used or has expired')).toBeVisible();
    await other.shot('sign-in-link-used.png');
    expect(await other.context.cookies(`${relay.base}/ui`)).toEqual([]);
  });

  test('a browser without a session sees "Not signed in", with no command to get one', async () => {
    const other = people[1]!;
    const page = await other.open(`${relay.base}/ui`);
    expect(page.status()).toBe(401);
    await expect(other.page).toHaveTitle('Not signed in · Klatsch');
    await other.shot('sign-in-not-signed-in.png');
    const text = await other.page.locator('body').innerText();
    expect(text).toContain('Ask for a new login link in the terminal where Klatsch runs.');
    expect(text).not.toMatch(/klatsch\s+(login|up|connect)|npx |npm |node |--/i);
    expect(await other.page.locator('form, button').count()).toBe(0);
  });

  test('Alice signs out; her browser is then not signed in', async () => {
    const a = people[0]!;
    const out = await a.signOut();
    expect(out.status()).toBe(200);
    await expect(a.page.getByText('Signed out.')).toBeVisible();
    expect((await a.open(`${relay.base}/ui`)).status()).toBe(401);
  });

  test('no CSP violations, and every form post carried the page origin', async () => {
    for (const p of people) await p.expectCleanBrowser();
    expect((await Promise.all(people[0]!.posts)).length).toBe(1);
  });
});
