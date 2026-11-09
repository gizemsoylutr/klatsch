// Asking one person directly, in real browsers: Bob reads Alice's question on Home, sends it to his agent, the
// agent's answer comes back for Alice, who sends it to hers; then a declined and a withdrawn one.
import { expect, test } from '@playwright/test';
import { agent, startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

test.describe.serial('direct ask: Home shows both sides, and every step is a click', () => {
  let relay: Relay;
  let alice: Person, bob: Person;
  let aliceAgent: Awaited<ReturnType<typeof agent>>, bobAgent: Awaited<ReturnType<typeof agent>>;

  const approveByCode = async (p: Person, code: string, button: string) => {
    await p.open(`${relay.base}/ui/device`);
    await p.page.getByRole('textbox').fill(code);
    await p.click(p.page.getByRole('button', { name: 'Continue' }));
    await p.click(p.page.getByRole('button', { name: button, exact: true }));
  };

  test.beforeAll(async ({ browser }) => {
    relay = await startRelay();
    const a = relay.klatsch.ensureUser('alice', 'Alice');
    const b = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', a), b, a);
    alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(a));
    bob = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(b));
    aliceAgent = await agent(relay, relay.agentToken(a), { dialogs: false });
    bobAgent = await agent(relay, relay.agentToken(b), { dialogs: false });
  });
  test.afterAll(async () => {
    await alice.expectCleanBrowser();
    await bob.expectCleanBrowser();
    await aliceAgent.close();
    await bobAgent.close();
    await alice.context.close();
    await bob.context.close();
    await relay.close();
  });

  test('Alice approves the question; Bob reads it on Home and sends it to his agent', async () => {
    const asked = await aliceAgent.call('ask_person', { handle: 'bob', tags: ['postgres'], question: 'How did you fix paging?' });
    await expect(async () => expect(asked.data.code).toBeTruthy()).toPass();
    await approveByCode(alice, asked.data.code, 'Ask');
    await bob.open(`${relay.base}/ui`);
    await expect(bob.page.getByText('Alice asks you')).toBeVisible();
    await expect(bob.page.getByText('How did you fix paging?')).toBeVisible();
    await bob.shot('direct-ask-home.png');
    await bob.click(bob.page.getByRole('button', { name: 'Send to my agent' }));
    await expect(bob.page.getByText('Your agent gets this from @alice')).toBeVisible();
  });

  test('Bob approves his agent’s answer; Alice reads it and sends it to hers', async () => {
    const ask = ((await bobAgent.call('inbox')).data.events as { kind: string; ref: string }[]).find((e) => e.kind === 'ask.received')!;
    const answered = await bobAgent.call('answer_ask', { ask_id: ask.ref, answer: 'A keyset cursor.' });
    await approveByCode(bob, answered.data.code, 'Send');
    await alice.open(`${relay.base}/ui`);
    await expect(alice.page.getByText('A keyset cursor.')).toBeVisible();
    await alice.click(alice.page.getByRole('button', { name: 'Send to my agent' }));
    await expect(alice.page.getByText('Your agent gets this from @bob')).toBeVisible();
  });

  test('Bob declines one, and Alice withdraws another', async () => {
    const one = await aliceAgent.call('ask_person', { handle: 'bob', tags: ['postgres'], question: 'Declined one?' });
    await approveByCode(alice, one.data.code, 'Ask');
    await bob.open(`${relay.base}/ui`);
    await bob.click(bob.page.getByRole('button', { name: 'Decline' }));
    await alice.open(`${relay.base}/ui`);
    await expect(alice.page.getByText('They won’t answer this one.')).toBeVisible();
    const two = await aliceAgent.call('ask_person', { handle: 'bob', tags: ['postgres'], question: 'Withdrawn one?' });
    await approveByCode(alice, two.data.code, 'Ask');
    await alice.open(`${relay.base}/ui`);
    await alice.click(alice.page.getByRole('button', { name: 'Withdraw' }));
    await bob.open(`${relay.base}/ui`);
    await expect(bob.page.getByText('Withdrawn one?')).toHaveCount(0);
  });
});
