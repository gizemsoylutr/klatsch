// Circles in real browsers: Gizem starts a circle from the Circles tab, sets house rules and slow mode, adds a room,
// makes Bob a host and pauses Carol for a while; Bob writes; Carol accepts the rules and reports a message; Gizem
// sees the report and keeps it; she deletes a message of her own.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person } from './people.ts';

test('a circle: start it, set rules, add a room, hosts, a pause, a report', async ({ browser }) => {
  const relay: Relay = await startRelay();
  const gizem = relay.klatsch.ensureUser('gizem', 'Gizem');
  const bob = relay.klatsch.ensureUser('bob', 'Bob');
  const carol = relay.klatsch.ensureUser('carol', 'Carol');
  relay.klatsch.addMember(relay.klatsch.friendCircle(gizem), bob, gizem);
  const g = await person(browser, relay, 'Gizem', import.meta.filename, relay.loginLink(gizem));

  // Start one from the Circles tab.
  await g.click(g.page.getByRole('link', { name: 'Circles' }));
  await g.page.getByLabel('Name of a new circle').fill('SAP crowd');
  await g.click(g.page.getByRole('button', { name: 'Start a circle' }));
  await expect(g.page.getByRole('heading', { level: 1, name: 'SAP crowd' })).toBeVisible();
  const circle = relay.db.prepare(`SELECT id FROM circles WHERE name = 'SAP crowd'`).get()!.id as string;
  relay.klatsch.addMember(circle, bob, gizem);
  relay.klatsch.addMember(circle, carol, gizem);

  // Settings: rules and slow mode, a room, Bob a host, Carol paused then let go.
  await g.click(g.page.getByRole('link', { name: 'Circle settings' }));
  await g.page.getByLabel('House rules, shown once to everyone before they write').fill('Be kind. No sales.');
  await g.click(g.page.getByRole('button', { name: 'Save' }));
  await g.page.getByLabel('Name of a new room').fill('abap');
  await g.click(g.page.getByRole('button', { name: 'Add room' }));
  await expect(g.page.getByRole('link', { name: /abap/ })).toBeVisible();
  await g.open(`${relay.base}/ui/c/${circle}/settings`);
  const bobRow = g.page.locator('li.item', { hasText: '@bob' });
  await g.click(bobRow.getByRole('button', { name: 'Host / not host' }));
  const carolRow = g.page.locator('li.item', { hasText: '@carol' });
  await carolRow.getByLabel('Pause writing for').selectOption('10');
  await g.click(carolRow.getByRole('button', { name: 'Apply' }));
  await g.shot('circle-settings.png');

  // Bob, a host now, writes in general (hosts set the rules, so they are not asked to accept them).
  const b = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(bob));
  await b.open(`${relay.base}/ui/c/${circle}`);
  await b.page.getByRole('textbox', { name: 'Message #general' }).fill('Anyone seen MMPUR_CONF/026?');
  await b.click(b.page.getByRole('button', { name: 'Send' }));
  await expect(b.page.locator('.thread')).toContainText('Anyone seen MMPUR_CONF/026?');
  await b.shot('circle-room.png');

  // Carol, paused, can still read and report.
  const c = await person(browser, relay, 'Carol', import.meta.filename, relay.loginLink(carol));
  await c.open(`${relay.base}/ui/c/${circle}`);
  await expect(c.page.getByText('Be kind. No sales.')).toBeVisible();
  await c.click(c.page.getByRole('button', { name: 'I agree' }));
  await expect(c.page.getByText(/A host paused your writing here/)).toBeVisible();
  const message = c.page.locator('.msg', { hasText: 'Anyone seen' });
  await message.hover();
  await message.locator('details.msgmenu > summary').click();
  await c.click(message.getByRole('button', { name: 'Report to the hosts' }));
  await expect(c.page.getByText('Reported. The hosts will look at it.')).toBeVisible();

  // Gizem sees it, keeps it; then deletes her own message.
  await g.open(`${relay.base}/ui/c/${circle}`);
  await g.click(g.page.getByRole('link', { name: '1 report' }));
  await expect(g.page.getByText('Reported by Carol')).toBeVisible();
  await g.click(g.page.getByRole('button', { name: 'Keep it' }));
  await expect(g.page.getByText('Nothing reported. All calm.')).toBeVisible();
  await g.open(`${relay.base}/ui/c/${circle}`);
  await g.page.getByRole('textbox', { name: 'Message #general' }).fill('Wrong room');
  await g.click(g.page.getByRole('button', { name: 'Send' }));
  const mine = g.page.locator('.msg.mine', { hasText: 'Wrong room' });
  await mine.hover();
  await mine.locator('details.msgmenu > summary').click();
  await g.click(mine.getByRole('button', { name: 'Delete' }));
  await expect(g.page.locator('.thread')).toContainText('This message was deleted');

  for (const p of [g, b, c]) await p.expectCleanBrowser();
  for (const p of [g, b, c]) await p.context.close();
  await relay.close();
});
