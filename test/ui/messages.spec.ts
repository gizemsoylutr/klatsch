// Messages in real browsers: Alice opens her conversation with Eve from Home, writes with a photo, and Eve sees it
// on Home as new, reads it, writes back, and hands the conversation to her AI. Phone width and desktop.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3, 4]);

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 780 },
]) {
  test.describe.serial(`messages (${viewport.width}px)`, () => {
    let relay: Relay;
    let alice: Person, eve: Person;

    test.beforeAll(async ({ browser }) => {
      relay = await startRelay();
      const a = relay.klatsch.ensureUser('alice', 'Alice');
      const e = relay.klatsch.ensureUser('eve', 'Eve');
      relay.klatsch.addMember(relay.klatsch.friendCircle(a), e, a);
      alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(a), { viewport });
      eve = await person(browser, relay, 'Eve', import.meta.filename, relay.loginLink(e), { viewport });
    });
    test.afterAll(async () => {
      await alice.expectCleanBrowser();
      await eve.expectCleanBrowser();
      await Promise.all([alice.context.close(), eve.context.close()]);
      await relay.close();
    });

    test('Alice writes to Eve from her page, with a photo', async () => {
      const w = viewport.width;
      await alice.open(`${relay.base}/ui/circle`);
      await alice.click(alice.page.getByRole('link', { name: 'Message' }));
      await expect(alice.page.getByRole('heading', { level: 1, name: /Eve/ })).toBeVisible();
      await alice.page.getByLabel('Your message').fill('Dinner on Friday at 19:00?');
      await alice.page.locator('input[type=file]').setInputFiles({ name: 'map.png', mimeType: 'image/png', buffer: PNG });
      await alice.click(alice.page.getByRole('button', { name: 'Send' }));
      await expect(alice.page.locator('.thread').getByText('Dinner on Friday at 19:00?')).toBeVisible();
      await expect(alice.page.getByRole('link', { name: /map\.png/ })).toBeVisible();
      await alice.shot(`messages-alice-${w}.png`);
      const [scroll, client] = await alice.page.evaluate<[number, number]>('[document.documentElement.scrollWidth, document.documentElement.clientWidth]');
      expect(scroll).toBeLessThanOrEqual(client);
    });

    test('Eve sees it as new on Home, reads it, writes back and hands it to her AI', async () => {
      const w = viewport.width;
      await eve.open(`${relay.base}/ui`);
      // Home is the chat list: Alice's chat with one new message.
      const chats = eve.page.getByRole('complementary', { name: 'Chats' });
      await expect(chats.getByLabel('1 new')).toBeVisible();
      await eve.shot(`messages-home-${w}.png`);
      await eve.click(chats.getByRole('link', { name: /Alice/ }));
      await expect(eve.page.locator('.thread').getByText('Dinner on Friday at 19:00?')).toBeVisible();
      await eve.page.getByLabel('Your message').fill('Yes, I will bring dessert.');
      await eve.click(eve.page.getByRole('button', { name: 'Send' }));
      await expect(eve.page.locator('.thread').getByText('Yes, I will bring dessert.')).toBeVisible();
      await eve.shot(`messages-eve-${w}.png`);
      await eve.page.locator('details.chatmore > summary').click();
      await eve.click(eve.page.getByRole('button', { name: 'Brew it' }));
      await expect(eve.page.getByText(/Your AI gets your conversation with @alice/)).toBeVisible();
    });
  });
}
