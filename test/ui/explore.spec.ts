// Explore and Picks in real browsers: Gizem lists her circle; Dana finds it in Explore and asks to join; Gizem lets her
// in, declines Erin; Gizem adds a question to Picks and takes it out again.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person } from './people.ts';

test('a listed circle: found in Explore, asked to join, let in; a question picked', async ({ browser }) => {
  const relay: Relay = await startRelay();
  const gizem = relay.klatsch.ensureUser('gizem', 'Gizem');
  const dana = relay.klatsch.ensureUser('dana', 'Dana');
  const erin = relay.klatsch.ensureUser('erin', 'Erin');
  for (const u of [dana, erin]) relay.klatsch.ensureCircle(`own-${u}`, u);
  const circle = relay.klatsch.createCircle(gizem, 'SAP crowd');
  const g = await person(browser, relay, 'Gizem', import.meta.filename, relay.loginLink(gizem));
  await g.open(`${relay.base}/ui/c/${circle}/settings`);
  await g.page.getByLabel('List this circle in Explore (people ask to join; hosts decide)').check();
  await g.page.getByLabel('A line about the circle').fill('SAP fixes, shared over coffee');
  await g.click(g.page.locator('form', { has: g.page.locator('input[name="listed"]') }).getByRole('button', { name: 'Save' }));

  const d = await person(browser, relay, 'Dana', import.meta.filename, relay.loginLink(dana));
  await d.click(d.page.getByRole('link', { name: 'Circles' }));
  await d.click(d.page.getByRole('link', { name: 'Explore circles' }));
  await expect(d.page.getByText('SAP fixes, shared over coffee')).toBeVisible();
  await d.shot('explore.png');
  await d.click(d.page.getByRole('button', { name: 'Ask to join' }));
  await expect(d.page.getByText('Asked: the hosts decide')).toBeVisible();
  relay.klatsch.requestToJoin(erin, circle);

  await g.open(`${relay.base}/ui/c/${circle}`);
  await g.click(g.page.getByRole('link', { name: '2 want to join' }));
  await g.click(g.page.locator('li.item', { hasText: '@dana' }).getByRole('button', { name: 'Let in' }));
  await g.click(g.page.locator('li.item', { hasText: '@erin' }).getByRole('button', { name: 'Not now' }));
  await expect(g.page.locator('#requests')).toHaveCount(0);

  const q = relay.klatsch.askAround(dana, circle, 'MMPUR_CONF/026 on a PO confirmation?');
  await g.open(`${relay.base}/ui/q/${q}`);
  await g.click(g.page.getByRole('button', { name: 'Add to Picks' }));
  await g.open(`${relay.base}/ui/c/${circle}/ask?state=picks`);
  await expect(g.page.locator('ul.questions')).toContainText('MMPUR_CONF/026');
  await g.open(`${relay.base}/ui/q/${q}`);
  await g.click(g.page.getByRole('button', { name: 'Take out of Picks' }));
  await expect(g.page.getByRole('button', { name: 'Add to Picks' })).toBeVisible();
  for (const p of [g, d]) await p.expectCleanBrowser();
  for (const p of [g, d]) await p.context.close();
  await relay.close();
});
