// The privacy and terms pages in a real browser: reached from the landing page, readable on a phone, no script.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

test.describe.serial('privacy and terms pages', () => {
  let relay: Relay;
  let visitor: Person;
  test.beforeAll(async ({ browser }) => {
    relay = await startRelay({ operator: { name: 'Ada Lovelace', email: 'ada@example.org', processors: 'Hosting: Example Cloud, in France.' } });
    visitor = await person(browser, relay, 'Visitor', import.meta.filename, undefined, { viewport: { width: 390, height: 780 } });
  });
  test.afterAll(async () => {
    await visitor.expectCleanBrowser();
    await visitor.context.close();
    await relay.close();
  });

  test('from the landing page to Privacy and Terms, with no sideways scroll on a phone', async () => {
    await visitor.open(`${relay.base}/`);
    await visitor.click(visitor.page.getByRole('link', { name: 'Privacy', exact: true }).last());
    await expect(visitor.page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
    await visitor.shot('legal-privacy.png');
    await visitor.click(visitor.page.getByRole('link', { name: 'Terms' }));
    await expect(visitor.page.getByRole('heading', { level: 1, name: 'Terms' })).toBeVisible();
    const [scroll, client] = await visitor.page.evaluate<[number, number]>('[document.documentElement.scrollWidth, document.documentElement.clientWidth]');
    expect(scroll).toBeLessThanOrEqual(client);
  });
});
