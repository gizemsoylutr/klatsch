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
    // The test button: every device gets one, and the page says what to check when nothing shows.
    relay.klatsch.pushTest = async (subs) => subs.map(() => 'sent' as const);
    await alice.click(alice.page.getByRole('button', { name: 'Send a test notification' }));
    await expect(alice.page.getByText(/Sent to 1 device/)).toBeVisible();
    await expect(alice.page.getByText(/Focus or Do Not Disturb/)).toBeVisible();
    await alice.shot('push-test.png');
    // Home re-sends this device's subscription on each visit, from the page (here by hand: no push service in tests).
    await alice.open(`${relay.base}/ui`);
    const sync = alice.page.locator('[data-push-sync]');
    await expect(sync).toHaveCount(1);
    const csrf = await sync.getAttribute('data-csrf');
    const answer = await alice.page.evaluate(
      async ([csrf, p256dh, auth]) =>
        (await fetch('/ui/push/sync', { method: 'POST', body: new URLSearchParams({ csrf: csrf!, endpoint: 'https://fcm.googleapis.com/fcm/send/test', p256dh: p256dh!, auth: auth! }), credentials: 'same-origin' })).text(),
      [csrf, ua.getPublicKey().toString('base64url'), Buffer.alloc(16, 2).toString('base64url')],
    );
    expect(answer).toBe('on');
    await alice.open(`${relay.base}/ui/settings`);
    await alice.click(alice.page.getByRole('button', { name: 'Turn off everywhere' }));
    await alice.open(`${relay.base}/ui/settings`);
    await expect(alice.page.getByText('Off on every device.')).toBeVisible();
  });
});
