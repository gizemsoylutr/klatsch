// A note older than 90 days: its author reads the question on Home and clicks "Still holds"; a tried note is marked for its reader.
import { expect, test } from '@playwright/test';
import { agent, startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

test.describe.serial('note check: an old note in the browser', () => {
  let relay: Relay;
  let alice: Person, bob: Person;
  let aliceAgent: Awaited<ReturnType<typeof agent>>;

  test.beforeAll(async ({ browser }) => {
    relay = await startRelay();
    const a = relay.klatsch.ensureUser('alice', 'Alice');
    const b = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', a), b, a);
    alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(a));
    bob = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(b));
    const old = relay.klatsch.draftSip(b, { status: 'solved', tags: ['postgres'], summary: 'Keyset paging fixed it.', visibility: 'open' }, 'cli');
    relay.klatsch.approveSip(b, old.sipId, 'cli');
    relay.db.prepare('UPDATE sips SET approved_at = ? WHERE id = ?').run(Date.now() - 120 * 24 * 60 * 60 * 1000, old.sipId);
    const failed = relay.klatsch.draftSip(b, { status: 'tried', tags: ['postgres'], summary: 'A covering index did not help.', visibility: 'open' }, 'cli');
    relay.klatsch.approveSip(b, failed.sipId, 'cli');
    aliceAgent = await agent(relay, relay.agentToken(a), {
      dialogs: false,
    });
    const asked = await aliceAgent.call('update_card', { status: 'looking', tags: ['postgres'], summary: 'Paging is slow.' });
    await alice.open(`${relay.base}/ui/device`);
    await alice.page.getByRole('textbox').fill(asked.data.code);
    await alice.click(alice.page.getByRole('button', { name: 'Continue' }));
    await alice.click(alice.page.getByRole('button', { name: 'Share' }));
  });
  test.afterAll(async () => {
    await alice.expectCleanBrowser();
    await bob.expectCleanBrowser();
    await aliceAgent.close();
    await alice.context.close();
    await bob.context.close();
    await relay.close();
  });

  test('Alice reads both notes with their age, and the tried one is marked', async () => {
    await alice.open(`${relay.base}/ui`);
    await expect(alice.page.getByText('did not work for them')).toBeVisible();
    await expect(alice.page.getByText(/as of \d{4}-\d{2}-\d{2}/).first()).toBeVisible();
    await alice.shot('note-check-reader.png');
  });

  test('Bob is asked on Home and clicks Still holds; the question goes away', async () => {
    await bob.open(`${relay.base}/ui`);
    await expect(bob.page.getByText('Does it still hold?')).toBeVisible();
    await bob.shot('note-check-author.png');
    await bob.click(bob.page.getByRole('button', { name: 'Still holds' }));
    await expect(bob.page.getByText('Does it still hold?')).toHaveCount(0);
  });
});
