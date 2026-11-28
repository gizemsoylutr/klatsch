// Ask around in real browsers: Bob asks his circle where to have brunch; Carol and Gizem answer; Bob marks Carol's
// answer as the one that solved it; Gizem says it helped her too and deletes her own; Bob deletes the question.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person } from './people.ts';

test('Bob asks his circle, gets answers, marks the one that solved it', async ({ browser }) => {
  const relay: Relay = await startRelay();
  const gizem = relay.klatsch.ensureUser('gizem', 'Gizem');
  const bob = relay.klatsch.ensureUser('bob', 'Bob');
  const carol = relay.klatsch.ensureUser('carol', 'Carol');
  const circle = relay.klatsch.createCircle(gizem, 'Weekend crew');
  relay.klatsch.addMember(circle, bob, gizem);
  relay.klatsch.addMember(circle, carol, gizem);
  const b = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(bob));
  await b.open(`${relay.base}/ui/c/${circle}`);
  await b.click(b.page.getByRole('link', { name: 'Ask around' }));
  await b.page.getByLabel('Your question').fill('Brunch on Sunday, where?');
  await b.page.getByLabel('Details').fill('Four of us, near the park.');
  await b.click(b.page.getByRole('button', { name: 'Ask', exact: true }));
  await expect(b.page.getByRole('heading', { level: 2, name: 'Brunch on Sunday, where?' })).toBeVisible();
  const question = new URL(b.page.url()).pathname;

  const c = await person(browser, relay, 'Carol', import.meta.filename, relay.loginLink(carol));
  await c.open(`${relay.base}${question}`);
  await c.page.getByLabel('Your answer').fill('Café Lotte, book ahead.');
  await c.click(c.page.getByRole('button', { name: 'Answer', exact: true }));
  const g = await person(browser, relay, 'Gizem', import.meta.filename, relay.loginLink(gizem));
  await g.open(`${relay.base}${question}`);
  await g.page.getByLabel('Your answer').fill('The bakery on the corner.');
  await g.click(g.page.getByRole('button', { name: 'Answer', exact: true }));

  await b.open(`${relay.base}${question}`);
  await b.click(b.page.locator('li.answer', { hasText: 'Café Lotte' }).getByRole('button', { name: 'This solved it' }));
  await expect(b.page.locator('li.answer.solved')).toContainText('Café Lotte');
  await b.shot('ask-around-question.png');

  await g.open(`${relay.base}${question}`);
  await g.click(g.page.locator('li.answer', { hasText: 'Café Lotte' }).getByRole('button', { name: 'Helped me too' }));
  await expect(g.page.getByText('helped 1 more')).toBeVisible();
  await g.click(g.page.locator('li.answer', { hasText: 'The bakery' }).getByRole('button', { name: 'Delete' }));
  await expect(g.page.locator('li.answer')).toHaveCount(1);

  await b.open(`${relay.base}/ui/c/${circle}/ask`);
  await b.shot('ask-around-list.png');
  await b.click(b.page.getByRole('link', { name: /Brunch on Sunday/ }));
  await b.click(b.page.getByRole('button', { name: 'Delete the question' }));
  await expect(b.page.getByText('Nothing asked yet. Ask the first question.')).toBeVisible();
  for (const p of [b, c, g]) await p.expectCleanBrowser();
  for (const p of [b, c, g]) await p.context.close();
  await relay.close();
});
