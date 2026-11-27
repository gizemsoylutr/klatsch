// Night or day in a real browser: Alice, whose device is set to day, picks Night in the ⋯ menu; the page turns dark
// and stays so on the next page; "Same as this device" brings the day back.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person } from './people.ts';

test('Alice switches to Night in the menu, and back to the device’s own', async ({ browser }) => {
  const relay: Relay = await startRelay();
  const alice = relay.klatsch.ensureUser('alice', 'Alice');
  relay.klatsch.addMember(relay.klatsch.friendCircle(alice), relay.klatsch.ensureUser('eve', 'Eve'), alice);
  const a = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(alice), { colorScheme: 'light' });
  const background = () => a.page.evaluate<string>('getComputedStyle(document.body).backgroundColor');
  expect(await background()).toBe('rgb(255, 255, 255)');
  await a.page.locator('details.menu > summary').click();
  await a.click(a.page.getByRole('button', { name: 'Night' }));
  await expect(a.page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await background()).toBe('rgb(0, 0, 0)');
  await a.shot('theme-night.png');
  await a.open(`${relay.base}/ui/chat/eve`);
  expect(await background()).toBe('rgb(0, 0, 0)');
  await a.page.locator('details.menu > summary').click();
  await a.click(a.page.getByRole('button', { name: 'Same as this device' }));
  expect(await background()).toBe('rgb(255, 255, 255)');
  await a.expectCleanBrowser();
  await a.context.close();
  await relay.close();
});
