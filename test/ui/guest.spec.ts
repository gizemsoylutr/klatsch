// Guest mode in real browsers: the landing page offers it, one click gives a guest, the guest makes a friend link,
// a friend opens it in their own browser and joins as a guest with one click, they write to each other, a page that
// needs an account says so, and "End guest session" deletes the guest and the friendship.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person } from './people.ts';

test('two friends try Klatsch as guests: a link, one click to join, a message, and the end', async ({ browser }) => {
  const relay: Relay = await startRelay({ guest: true });
  const a = await person(browser, relay, 'Guest A', import.meta.filename, undefined, { member: false });
  await a.open(`${relay.base}/`);
  await a.click(a.page.getByRole('link', { name: 'Try it without an account' }).first());
  await expect(a.page.getByRole('heading', { level: 1, name: 'Try Klatsch for 5 hours' })).toBeVisible();
  await a.shot('guest-start.png');
  await a.click(a.page.getByRole('button', { name: 'Start as a guest' }));
  await expect(a.page.getByText(/You are a guest\. This account and everything in it is deleted in/)).toBeVisible();
  await expect(a.page.getByRole('heading', { name: 'Try it with a friend' })).toBeVisible();
  await a.shot('guest-home.png');
  await a.click(a.page.getByRole('button', { name: 'Add a friend' }).first());
  const link = (await a.page.locator('code.cmd').first().textContent())!.trim();

  const b = await person(browser, relay, 'Guest B', import.meta.filename, undefined, { member: false });
  await b.open(link);
  await expect(b.page.getByRole('heading', { name: /invited you to try Klatsch together/ })).toBeVisible();
  await b.shot('guest-invited.png');
  await b.click(b.page.getByRole('button', { name: 'Join as a guest' }));
  await b.page.getByRole('textbox').first().fill('Hi! It works.');
  await b.click(b.page.getByRole('button', { name: /^Send/ }).first());
  await expect(b.page.locator('.thread').getByText('Hi! It works.')).toBeVisible();
  await b.shot('guest-chat.png');

  await a.open(`${relay.base}/ui`);
  await expect(a.page.getByRole('complementary', { name: 'Chats' }).getByText('Hi! It works.')).toBeVisible();

  // A page that needs an account says so instead of opening.
  const notes = await a.open(`${relay.base}/ui/notes`);
  expect(notes.status()).toBe(403);
  await expect(a.page.getByRole('heading', { name: 'Not for guests' })).toBeVisible();

  await a.open(`${relay.base}/ui/settings`);
  await a.click(a.page.getByRole('button', { name: 'End guest session' }).first());
  await expect(a.page.getByRole('heading', { name: 'Guest session ended' })).toBeVisible();
  expect(relay.db.prepare('SELECT count(*) AS n FROM users WHERE guest_expires_at IS NOT NULL').get()).toEqual({ n: 1 });
  await a.expectCleanBrowser();
  await b.expectCleanBrowser();
  await a.context.close();
  await b.context.close();
  await relay.close();
});
