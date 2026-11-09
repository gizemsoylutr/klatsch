// `klatsch connect --url` without a token, in a real browser: Alice types the code from her terminal, reads what
// it means, and clicks Connect; Decline connects nothing.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

test.describe.serial('browser connect: Alice types the code from her terminal', () => {
  let relay: Relay;
  let alice: Person;

  const start = async () => {
    const response = await fetch(`${relay.base}/ui/connect/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client: 'claude' }) });
    return (await response.json()) as { device_code: string; user_code: string; verification_url: string };
  };
  const poll = async (device: string) =>
    (await (await fetch(`${relay.base}/ui/connect/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: device }) })).json()) as { state: string; token?: string };

  test.beforeAll(async ({ browser }) => {
    relay = await startRelay();
    const a = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('demo', a);
    alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(a));
  });
  test.afterAll(async () => {
    await alice.expectCleanBrowser();
    await alice.context.close();
    await relay.close();
  });

  test('a wrong code gets a neutral line and the form again', async () => {
    const { verification_url: page } = await start();
    await alice.open(page);
    await expect(alice.page.getByRole('textbox')).toBeFocused();
    await alice.shot('browser-connect-entry.png');
    await alice.page.getByRole('textbox').fill('BBBB-CCCC');
    const wrong = await alice.click(alice.page.getByRole('button', { name: 'Continue' }));
    expect(wrong.status()).toBe(404);
    await expect(alice.page.getByText('No open request with this code.')).toBeVisible();
  });

  test('the right code shows what connecting means, with the warning; Connect finishes it', async () => {
    const { device_code, user_code, verification_url: page } = await start();
    await alice.open(page);
    await alice.page.getByRole('textbox').fill(user_code.toLowerCase());
    await alice.click(alice.page.getByRole('button', { name: 'Continue' }));
    await expect(alice.page.getByRole('heading', { name: 'Connect Claude Code to your Klatsch account?' })).toBeVisible();
    await expect(alice.page.getByText('Only continue if you ran klatsch connect yourself')).toBeVisible();
    await alice.shot('browser-connect-confirm.png');
    await alice.click(alice.page.getByRole('button', { name: 'Connect', exact: true }));
    await expect(alice.page.getByText('Go back to your terminal')).toBeVisible();
    expect((await poll(device_code)).token).toMatch(/^klt_/);
  });

  test('Decline connects nothing', async () => {
    const { device_code, user_code, verification_url: page } = await start();
    await alice.open(page);
    await alice.page.getByRole('textbox').fill(user_code);
    await alice.click(alice.page.getByRole('button', { name: 'Continue' }));
    await alice.click(alice.page.getByRole('button', { name: 'Decline' }));
    await expect(alice.page.getByText('Nothing was connected.')).toBeVisible();
    expect((await poll(device_code)).state).toBe('declined');
  });
});
