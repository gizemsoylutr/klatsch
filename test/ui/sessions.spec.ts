// Signed in on two browsers: Settings says so, and "Sign out everywhere else" ends the other one.
import { expect, test } from '@playwright/test';
import { startRelay } from '../e2e/harness.ts';
import { person } from './people.ts';

test('Alice signs out her other browser from Settings', async ({ browser }) => {
  const relay = await startRelay();
  try {
    const a = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('demo', a);
    const laptop = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(a));
    const phone = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(a));
    await laptop.click(laptop.page.getByRole('navigation').getByRole('link', { name: 'Settings' }));
    await expect(laptop.page.getByText('This browser and 1 other. A sign-in lasts 30 days from its last use, 90 at most.')).toBeVisible();
    await laptop.shot('sessions-settings.png');
    await laptop.click(laptop.page.getByRole('button', { name: 'Sign out everywhere else' }));
    await expect(laptop.page.getByText('Only this browser. A sign-in lasts 30 days from its last use, 90 at most.')).toBeVisible();
    await expect(laptop.page.getByRole('button', { name: 'Sign out everywhere else' })).toHaveCount(0);
    expect((await phone.open(`${relay.base}/ui`)).status()).toBe(401);
    await laptop.expectCleanBrowser();
    await Promise.all([laptop.context.close(), phone.context.close()]);
  } finally {
    await relay.close();
  }
});
