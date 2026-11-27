// Guest mode in a real browser: the landing page offers it, one click gives a guest with the demo friend, the
// guest writes to it and gets a reply, a page that needs an account says so, and "End guest session" deletes it.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person } from './people.ts';

test('a visitor tries Klatsch as a guest, writes to the demo friend, and ends the guest session', async ({ browser }) => {
  const relay: Relay = await startRelay({ guest: true });
  const p = await person(browser, relay, 'Guest', import.meta.filename, undefined, { member: false });
  await p.open(`${relay.base}/`);
  await p.click(p.page.getByRole('link', { name: 'Try it without an account' }).first());
  await expect(p.page.getByRole('heading', { level: 2, name: 'Try Klatsch for 5 hours' })).toBeVisible();
  await p.shot('guest-start.png');
  await p.click(p.page.getByRole('button', { name: 'Start as a guest' }));
  await expect(p.page.getByText(/You are a guest\. This account and everything in it is deleted in/)).toBeVisible();
  await p.shot('guest-home.png');

  await p.open(`${relay.base}/ui/chat/klatsch-demo`);
  await p.page.getByRole('textbox').first().fill('Museum on Saturday? I can get tickets.');
  await p.click(p.page.getByRole('button', { name: /^Send/ }).first());
  await expect(p.page.getByText(/count me in/)).toBeVisible();
  await p.shot('guest-chat.png');

  // A page that needs an account says so instead of opening.
  const notes = await p.open(`${relay.base}/ui/notes`);
  expect(notes.status()).toBe(403);
  await expect(p.page.getByRole('heading', { name: 'Not for guests' })).toBeVisible();

  await p.open(`${relay.base}/ui/settings`);
  await p.click(p.page.getByRole('button', { name: 'End guest session' }).first());
  await expect(p.page.getByRole('heading', { name: 'Guest session ended' })).toBeVisible();
  expect(relay.db.prepare('SELECT count(*) AS n FROM users WHERE guest_expires_at IS NOT NULL').get()).toEqual({ n: 0 });
  await p.expectCleanBrowser();
  await p.context.close();
  await relay.close();
});
