// The OAuth consent page in a real browser: an app's request, the page, and Connect taking the browser back to
// the app on another origin (the page's form-action allows exactly that one), with no policy violation.
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 780 },
]) {
  test.describe.serial(`connect an app by OAuth (${viewport.width}px)`, () => {
    let relay: Relay;
    let alice: Person;
    test.beforeAll(async ({ browser }) => {
      relay = await startRelay();
      const aliceId = relay.klatsch.ensureUser('alice', 'Alice');
      const bob = relay.klatsch.ensureUser('bob', 'Bob');
      relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', aliceId), bob, aliceId);
      alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(aliceId), { viewport });
    });
    test.afterAll(async () => {
      await alice.expectCleanBrowser();
      await alice.context.close();
      await relay.close();
    });

    test('the consent page names the app and where it goes back to; Connect returns there with a code', async () => {
      // The app's own address: the relay's other loopback name, so the redirect really leaves this origin.
      const appOrigin = relay.base.replace('127.0.0.1', 'localhost');
      const callback = `${appOrigin}/`;
      const registered = await fetch(`${relay.base}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Test App', redirect_uris: [callback] }),
      });
      const { client_id } = (await registered.json()) as { client_id: string };
      const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
      const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: callback, code_challenge: challenge, code_challenge_method: 'S256', state: 'st' });
      await alice.open(`${relay.base}/ui/oauth/authorize?${query}`);
      await expect(alice.page.getByRole('heading', { level: 1, name: 'Connect Test App?' })).toBeVisible();
      await expect(alice.page.getByText(/It can never approve anything/)).toBeVisible();
      await alice.shot(`oauth-consent-${viewport.width}.png`);
      const [scroll, client] = await alice.page.evaluate<[number, number]>('[document.documentElement.scrollWidth, document.documentElement.clientWidth]');
      expect(scroll).toBeLessThanOrEqual(client);
      await Promise.all([alice.page.waitForURL((url) => url.origin === appOrigin), alice.page.getByRole('button', { name: 'Connect' }).click()]);
      const back = new URL(alice.page.url());
      expect(back.searchParams.get('state')).toBe('st');
      expect(back.searchParams.get('code')).toBeTruthy();
    });
  });
}
