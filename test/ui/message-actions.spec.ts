// A message's own menu in a real browser: Alice opens ⌄ on Eve's message and stars it, pins it (the bar shows at the
// top), opens Starred messages from the ⋯ menu, then deletes her own message for everyone in two steps.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person } from './people.ts';

test('Alice stars and pins Eve’s message, finds it under Starred, and deletes her own for everyone', async ({ browser }) => {
  const relay: Relay = await startRelay();
  const alice = relay.klatsch.ensureUser('alice', 'Alice');
  const eve = relay.klatsch.ensureUser('eve', 'Eve');
  relay.klatsch.addMember(relay.klatsch.friendCircle(alice), eve, alice);
  const mine = relay.klatsch.sendMessage(alice, '@eve', 'Oops, wrong chat');
  const theirs = relay.klatsch.sendMessage(eve, '@alice', 'Museum at 11?');
  const a = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(alice));
  await a.open(`${relay.base}/ui/chat/eve`);
  const bubble = a.page.locator(`#m-${theirs}`);
  await bubble.hover();
  await bubble.locator('details.msgmenu > summary').click();
  await a.click(bubble.getByRole('button', { name: 'Star', exact: true }));
  await expect(a.page.locator(`#m-${theirs} time svg`)).toHaveCount(1);
  await a.page.locator(`#m-${theirs}`).hover();
  await a.page.locator(`#m-${theirs} details.msgmenu > summary`).click();
  await a.click(a.page.locator(`#m-${theirs}`).getByRole('button', { name: 'Pin', exact: true }));
  await expect(a.page.locator('a.pinbar')).toContainText('Museum at 11?');
  await a.shot('message-pinned.png');
  await a.page.locator('details.menu > summary').click();
  await a.click(a.page.getByRole('link', { name: 'Starred messages' }));
  await expect(a.page.locator('ol.starred')).toContainText('Museum at 11?');
  await a.open(`${relay.base}/ui/chat/eve`);
  const own = a.page.locator(`#m-${mine}`);
  await own.hover();
  await own.locator('details.msgmenu > summary').click();
  await own.locator('details.del > summary').click();
  await a.click(own.getByRole('button', { name: 'Delete for everyone' }));
  await expect(a.page.locator(`#m-${mine}`)).toContainText('This message was deleted');
  await a.expectCleanBrowser();
  await a.context.close();
  await relay.close();
});
