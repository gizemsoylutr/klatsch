// Notifications in Settings, in a real browser: the script shows the button where the browser can get push
// notifications, the page runs without a CSP violation, and "Turn off everywhere" forgets every device.
import { expect, test } from '@playwright/test';
import { createECDH } from 'node:crypto';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

test.describe.serial('notifications on this device', () => {
  let relay: Relay;
  let alice: Person;
  let aliceId = '';

  test.beforeAll(async ({ browser }) => {
    relay = await startRelay();
    aliceId = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('home', aliceId);
    alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(aliceId));
  });
  test.afterAll(async () => {
    await alice.expectCleanBrowser();
    await alice.context.close();
    await relay.close();
  });

  test('Home offers notifications; "Not now" puts the offer away', async () => {
    await alice.open(`${relay.base}/ui`);
    await expect(alice.page.getByRole('heading', { name: 'Know when a friend asks you' })).toBeVisible();
    await alice.shot('push-offer.png');
    await alice.click(alice.page.getByRole('button', { name: 'Not now' }));
    await expect(alice.page.getByRole('heading', { name: 'Know when a friend asks you' })).toHaveCount(0);
  });

  test('Settings shows the section; with a device on, one click turns it off everywhere', async () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    relay.klatsch.savePushSubscription(aliceId, { endpoint: 'https://fcm.googleapis.com/fcm/send/test', p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') });
    await alice.open(`${relay.base}/ui/settings`);
    await expect(alice.page.getByRole('heading', { name: 'Notifications on this device' })).toBeVisible();
    await expect(alice.page.getByText('On for 1 device.')).toBeVisible();
    // The script ran: either the button shows, or it says why this browser cannot get notifications.
    await expect(alice.page.getByRole('button', { name: 'Turn on here' }).or(alice.page.getByText('cannot get notifications from a web page'))).toBeVisible();
    await alice.shot('push-settings.png');
    await alice.click(alice.page.getByRole('button', { name: 'Turn off everywhere' }));
    await alice.open(`${relay.base}/ui/settings`);
    await expect(alice.page.getByText('Off on every device.')).toBeVisible();
  });
});
