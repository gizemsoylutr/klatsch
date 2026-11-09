// Email in a real browser: Alice saves an address, opens the confirmation link from the mail (the
// harness's fake transport), sees the address and clicks Confirm. The link is hers alone.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

const ADDRESS = 'alice@example.test';

test.describe.serial('email: save an address, confirm it from the mailed link', () => {
  let relay: Relay;
  let alice: Person, bob: Person;
  let link = '';

  test.beforeAll(async ({ browser }) => {
    relay = await startRelay({ mail: true });
    const a = relay.klatsch.ensureUser('alice', 'Alice');
    const b = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', a), b, a);
    alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(a));
    bob = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(b));
  });
  test.afterAll(async () => {
    await Promise.all([alice, bob].map((p) => p?.context.close()));
    await relay.close();
  });

  test('Alice opens the Settings tab, types her address and clicks "Save address"; it is not confirmed yet', async () => {
    await alice.click(alice.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }));
    expect(alice.page.url()).toBe(`${relay.base}/ui/settings`);
    await alice.page.getByRole('textbox', { name: 'Your email address' }).fill(ADDRESS);
    const saved = await alice.click(alice.page.getByRole('button', { name: 'Save address' }));
    expect(saved.status()).toBe(200);
    expect(alice.page.url()).toBe(`${relay.base}/ui/settings`);
    await expect(alice.page.getByText('Your address is not confirmed yet')).toBeVisible();
    await expect(alice.page.getByRole('textbox', { name: 'Your email address' })).toHaveValue(ADDRESS);
  });

  test('one mail goes to that address, with the confirmation link', async () => {
    expect(await relay.mailCount(1)).toBe(1);
    expect(relay.mails[0]!.to[0]!.address).toBe(ADDRESS);
    link = relay.mails[0]!.text.match(new RegExp(`${relay.base}/ui/email/confirm/[\\w-]+`))?.[0] ?? '';
    expect(link).not.toBe('');
  });

  test("the link opened in Bob's browser is refused, without the address", async () => {
    const foreign = await bob.open(link);
    expect(foreign.status()).toBe(404);
    await expect(bob.page.getByText('This confirmation link is not valid.')).toBeVisible();
    expect(await bob.page.content()).not.toContain(ADDRESS);
  });

  test('Alice opens the link, sees her address and clicks Confirm', async () => {
    const shown = await alice.open(link);
    expect(shown.status()).toBe(200);
    await expect(alice.page.getByText(`Send Klatsch notifications to ${ADDRESS}?`)).toBeVisible();
    await alice.shot('email-confirm.png');
    const confirmed = await alice.click(alice.page.getByRole('button', { name: 'Confirm' }));
    expect(confirmed.status()).toBe(200);
    await expect(alice.page.getByText(`Confirmed. Notifications go to ${ADDRESS}.`)).toBeVisible();
    await alice.shot('email-confirmed.png');
    expect((await alice.open(link)).status(), 'the link works once').toBe(404);
  });

  test('Settings says the address is confirmed; Alice turns notifications off and on again', async () => {
    await alice.open(`${relay.base}/ui/settings`);
    await expect(alice.page.getByText('Your address is confirmed.')).toBeVisible();
    const toggle = alice.page.getByRole('switch', { name: 'Email notifications' });
    await expect(toggle).toBeChecked();
    await alice.click(toggle);
    await expect(toggle).not.toBeChecked();
    await alice.click(toggle);
    await expect(toggle).toBeChecked();
  });

  test('no CSP violations, and every form post carried the page origin', async () => {
    for (const p of [alice, bob]) await p.expectCleanBrowser();
  });
});
