// Deleting an account in a real browser: from Settings to the confirmation page, a wrong handle, then the right one.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 780 },
]) {
  test.describe.serial(`delete an account (${viewport.width}px)`, () => {
    let relay: Relay;
    let bob: Person;
    test.beforeAll(async ({ browser }) => {
      relay = await startRelay();
      const alice = relay.klatsch.ensureUser('alice', 'Alice');
      const bobId = relay.klatsch.ensureUser('bob', 'Bob');
      const circle = relay.klatsch.ensureCircle('team', bobId);
      relay.klatsch.addMember(circle, alice, bobId);
      bob = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(bobId), { viewport });
    });
    test.afterAll(async () => {
      await bob.expectCleanBrowser();
      await bob.context.close();
      await relay.close();
    });

    test('Settings, the page that says what goes, a wrong handle, then the right one', async () => {
      const w = viewport.width;
      await bob.open(`${relay.base}/ui/settings`);
      await bob.click(bob.page.getByRole('link', { name: 'Delete account…' }));
      await expect(bob.page.getByRole('heading', { level: 1, name: 'Delete your account?' })).toBeVisible();
      await expect(bob.page.getByText('Circles you own pass to their longest-standing member: team.')).toBeVisible();
      await bob.shot(`account-delete-${w}.png`);
      await bob.page.getByLabel('Type bob to confirm').fill('alice');
      await bob.click(bob.page.getByRole('button', { name: 'Delete my account' }));
      await expect(bob.page.getByRole('alert')).toHaveText('That is not your handle, so nothing was deleted.');
      await bob.page.getByLabel('Type bob to confirm').fill('bob');
      await bob.click(bob.page.getByRole('button', { name: 'Delete my account' }));
      await expect(bob.page.getByRole('heading', { level: 1, name: 'Your account is deleted' })).toBeVisible();
      await bob.shot(`account-deleted-${w}.png`);
      const [scroll, client] = await bob.page.evaluate<[number, number]>('[document.documentElement.scrollWidth, document.documentElement.clientWidth]');
      expect(scroll).toBeLessThanOrEqual(client);
      await bob.open(`${relay.base}/ui`);
      await expect(bob.page.getByRole('heading', { level: 1, name: /Hi, Bob/ })).toHaveCount(0);
    });
  });
}
