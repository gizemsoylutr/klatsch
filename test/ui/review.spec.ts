// The review account in a real browser: the sign-in page links to it, a wrong password says so, the right one signs in.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person } from './people.ts';

test('a reviewer signs in with the handle and password they were given', async ({ browser }) => {
  const relay: Relay = await startRelay();
  const password = relay.klatsch.setReviewAccount('reviewer', 'Directory Reviewer');
  const alice = relay.klatsch.ensureUser('alice', 'Alice');
  relay.klatsch.ensureCircle('home', alice);
  // Signed in as someone else first, so the visit is recorded; then signed out to reach the form.
  const p = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(alice));
  await p.context.clearCookies();
  await p.open(`${relay.base}/ui`);
  // The way in for reviewers is folded under "What Klatsch keeps, and more".
  const more = p.page.getByText('What Klatsch keeps, and more');
  if (await more.count()) await more.click();
  await p.click(p.page.getByRole('link', { name: /review account/ }));
  await p.page.getByLabel('Handle').fill('reviewer');
  await p.page.getByLabel('Password').fill('wrong');
  await p.click(p.page.getByRole('button', { name: 'Sign in' }));
  await expect(p.page.getByRole('alert')).toHaveText('That handle and password do not match a review account.');
  await p.page.getByLabel('Handle').fill('reviewer');
  await p.page.getByLabel('Password').fill(password);
  await p.click(p.page.getByRole('button', { name: 'Sign in' }));
  await expect(p.page.getByRole('complementary', { name: 'Chats' })).toBeVisible();
  await p.shot('review-signed-in.png');
  await p.context.close();
  await relay.close();
});
