// Friends in real browsers: Alice clicks "Add a friend" and sees the link once; Eve opens it and adds her; both
// Circle pages list the other under Friends; Eve removes the friend and stays signed in.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 780 },
]) {
  test.describe.serial(`friends (${viewport.width}px)`, () => {
    let relay: Relay;
    let alice: Person, eve: Person;
    let link = '';

    test.beforeAll(async ({ browser }) => {
      relay = await startRelay();
      const a = relay.klatsch.ensureUser('alice', 'Alice');
      const e = relay.klatsch.ensureUser('eve', 'Eve');
      relay.klatsch.ensureCircle('home', a);
      alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(a), { viewport });
      eve = await person(browser, relay, 'Eve', import.meta.filename, relay.loginLink(e), { viewport, member: false });
    });
    test.afterAll(async () => {
      await alice.expectCleanBrowser();
      await eve.expectCleanBrowser();
      await Promise.all([alice.context.close(), eve.context.close()]);
      await relay.close();
    });

    test('Alice adds a friend; Eve opens the link and adds her back', async () => {
      const w = viewport.width;
      await alice.open(`${relay.base}/ui/circle`);
      await alice.click(alice.page.getByRole('button', { name: 'Add a friend' }));
      await expect(alice.page.getByText('Send this link to your friend, by any messenger.')).toBeVisible();
      link = await alice.page.locator('code').innerText();
      expect(link).toMatch(new RegExp(`^${relay.base}/ui/invite/[\\w-]+$`));
      await alice.shot(`friends-link-${w}.png`);
      await eve.open(link);
      await expect(eve.page.getByRole('heading', { level: 1, name: 'Add as a friend?' })).toBeVisible();
      await eve.shot(`friends-invite-${w}.png`);
      await eve.click(eve.page.getByRole('button', { name: 'Add friend' }));
      await alice.open(`${relay.base}/ui/circle`);
      await expect(alice.page.getByRole('heading', { name: 'Friends' })).toBeVisible();
      await expect(alice.page.getByText('@eve')).toBeVisible();
      await alice.shot(`friends-circle-${w}.png`);
      const [scroll, client] = await alice.page.evaluate<[number, number]>('[document.documentElement.scrollWidth, document.documentElement.clientWidth]');
      expect(scroll).toBeLessThanOrEqual(client);
    });

    test('Eve removes the friend and stays signed in', async () => {
      await eve.open(`${relay.base}/ui/circle`);
      await expect(eve.page.getByText('@alice')).toBeVisible();
      await eve.click(eve.page.getByRole('button', { name: 'Remove friend' }));
      await eve.open(`${relay.base}/ui/circle`);
      await expect(eve.page.getByText('@alice')).toHaveCount(0);
      await expect(eve.page.getByRole('button', { name: 'Add a friend' })).toBeVisible();
    });
  });
}
