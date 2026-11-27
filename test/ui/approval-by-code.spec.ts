// A client without dialogs: the agent gets a code, Alice types it at /ui/device in her browser, reads the
// request and clicks Share. Case and the dash do not matter; a wrong code and another person's browser
// get the same neutral line.
import { expect, test } from '@playwright/test';
import { agent, CODE, startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

const ALICE_TEXT = 'My Node.js API on Postgres returns every row at once.';

test.describe.serial('approval by code: Alice types the code her agent showed', () => {
  let relay: Relay;
  let alice: Person, bob: Person;
  let aliceAgent: Awaited<ReturnType<typeof agent>>;
  let code = '';

  const enter = async (p: Person, typed: string) => {
    await p.page.getByRole('textbox').fill(typed);
    return p.click(p.page.getByRole('button', { name: 'Continue' }));
  };

  test.beforeAll(async ({ browser }) => {
    relay = await startRelay();
    const a = relay.klatsch.ensureUser('alice', 'Alice');
    const b = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', a), b, a);
    alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(a));
    bob = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(b));
    aliceAgent = await agent(relay, relay.agentToken(a), { dialogs: false });
  });
  test.afterAll(async () => {
    await aliceAgent?.close();
    await Promise.all([alice, bob].map((p) => p?.context.close()));
    await relay.close();
  });

  test('the agent asks to share and gets a code and the page to enter it on', async () => {
    const asked = await aliceAgent.call('update_card', { status: 'looking', tags: ['nodejs'], summary: ALICE_TEXT });
    expect(asked.data.state).toBe('pending-approval');
    expect(asked.data.approve_url).toBe(`${relay.base}/ui/device`);
    expect(asked.data.code).toMatch(CODE);
    code = asked.data.code;
  });

  test('Alice follows the link on her dashboard to the code page', async () => {
    // Home's menu (⋯) has the code page.
    await alice.page.locator('details.menu > summary').click();
    await alice.click(alice.page.getByRole('link', { name: 'Enter a code from your agent' }));
    expect(alice.page.url()).toBe(`${relay.base}/ui/device`);
    await expect(alice.page.getByText('Enter the code your agent showed in the terminal.')).toBeVisible();
    await expect(alice.page.getByRole('textbox')).toBeFocused();
    await alice.shot('approval-by-code-entry.png');
  });

  test('a wrong code shows the neutral page', async () => {
    const wrong = await enter(alice, 'BBBB-CCCC');
    expect(wrong.status()).toBe(404);
    await expect(alice.page.getByText('No open request with this code. Check it in your terminal; codes last 10 minutes.')).toBeVisible();
    await alice.shot('approval-by-code-wrong-code.png');
  });

  test("Alice's code in Bob's browser shows the same neutral page", async () => {
    await bob.open(`${relay.base}/ui/device`);
    const foreign = await enter(bob, code);
    expect(foreign.status()).toBe(404);
    await expect(bob.page.getByText('No open request with this code. Check it in your terminal; codes last 10 minutes.')).toBeVisible();
    expect(await bob.page.locator('body').innerText()).not.toContain(ALICE_TEXT);
  });

  test('typed in lower case, the code finds the request', async () => {
    const shown = await enter(alice, code.toLowerCase());
    expect(shown.status()).toBe(200);
    await expect(alice.page.getByRole('region')).toContainText(`“${ALICE_TEXT}”`);
  });

  test('typed without the dash, too; Alice reads exactly what will be shared and clicks Share', async () => {
    await alice.open(`${relay.base}/ui/device`);
    const shown = await enter(alice, code.replace('-', ''));
    expect(shown.status()).toBe(200);
    const card = alice.page.getByRole('region');
    await expect(card).toContainText('Share this sip?');
    await expect(card).toContainText(`“${ALICE_TEXT}”`);
    await expect(card).toContainText('Whoever solved this gets an intro request and reads this sip.');
    await alice.shot('approval-by-code-request.png');
    const decided = await alice.click(card.getByRole('button', { name: 'Share' }));
    expect(decided.status()).toBe(200);
    await expect(alice.page.getByText("It's on your card now.")).toBeVisible();
    await expect(alice.page.getByText('Your agent sees the outcome; you can close this page.')).toBeVisible();
    await alice.shot('approval-by-code-approved.png');
  });

  test('the card has the sip; the agent learns the outcome from its inbox, without the text or the code', async () => {
    await alice.open(`${relay.base}/ui`);
    await expect(alice.page.getByRole('heading', { name: 'Your card 1', exact: true })).toBeVisible();
    const inbox = await aliceAgent.call('inbox');
    expect(inbox.data.events.some((e: { kind: string }) => e.kind === 'approval.approved')).toBe(true);
    expect(inbox.raw).not.toMatch(CODE);
    expect(inbox.raw).not.toContain(ALICE_TEXT);
  });

  test('a used code finds nothing any more', async () => {
    await alice.open(`${relay.base}/ui/device`);
    expect((await enter(alice, code)).status()).toBe(404);
  });

  test('no CSP violations, and every form post carried the page origin', async () => {
    for (const p of [alice, bob]) await p.expectCleanBrowser();
  });
});
