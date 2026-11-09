// The Notes page in a real browser: Bob leaves the tick on as he shares; Alice opens Notes from the top bar.
import { expect, test } from '@playwright/test';
import { agent, startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

test.describe.serial('notes page: tick on the approval page, read from the top bar', () => {
  let relay: Relay;
  let alice: Person, bob: Person;

  test.beforeAll(async ({ browser }) => {
    relay = await startRelay();
    const a = relay.klatsch.ensureUser('alice', 'Alice');
    const b = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', a), b, a);
    alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(a));
    bob = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(b));
    const bobAgent = await agent(relay, relay.agentToken(b), { dialogs: false });
    const asked = await bobAgent.call('update_card', { status: 'solved', tags: ['postgres'], summary: 'Keyset paging beats OFFSET.', visibility: 'open' });
    await bob.open(`${relay.base}/ui/device`);
    await bob.page.getByRole('textbox').fill(asked.data.code);
    await bob.click(bob.page.getByRole('button', { name: 'Continue' }));
    await expect(bob.page.getByRole('checkbox', { name: /Also on the Notes page/ })).toBeChecked();
    await bob.shot('notes-page-approval.png');
    await bob.click(bob.page.getByRole('button', { name: 'Share' }));
    await bobAgent.close();
  });
  test.afterAll(async () => {
    await alice.expectCleanBrowser();
    await bob.expectCleanBrowser();
    await alice.context.close();
    await bob.context.close();
    await relay.close();
  });

  test('Alice opens Notes and reads it, with his name', async () => {
    await alice.open(`${relay.base}/ui`);
    await alice.click(alice.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Notes' }));
    await expect(alice.page.getByRole('heading', { name: 'Notes from your circles' })).toBeVisible();
    await expect(alice.page.getByText('Keyset paging beats OFFSET.')).toBeVisible();
    await expect(alice.page.getByText('@bob')).toBeVisible();
    await alice.shot('notes-page.png');
  });

  test('no sideways scroll on a phone', async ({ browser }) => {
    const phone = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(relay.klatsch.ensureUser('alice', 'Alice')), { viewport: { width: 390, height: 780 } });
    await phone.open(`${relay.base}/ui/notes`);
    const [scroll, client] = await phone.page.evaluate<[number, number]>('[document.documentElement.scrollWidth, document.documentElement.clientWidth]');
    expect(scroll).toBeLessThanOrEqual(client);
    await phone.context.close();
  });
});
