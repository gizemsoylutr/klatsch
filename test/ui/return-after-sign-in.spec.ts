// An approval page opened in a browser that is not signed in: the relay remembers it, Alice follows a
// fresh login link, lands on that same approval and clicks Share; her agent gets the outcome.
import { expect, test } from '@playwright/test';
import { agent, startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

const ALICE_TEXT = 'My Node.js API on Postgres returns every row at once.';

test.describe.serial('return after sign-in: an approval opened signed out, decided after the login link', () => {
  let relay: Relay;
  let alice: Person;
  let aliceId = '';

  test.beforeAll(async ({ browser }) => {
    relay = await startRelay();
    aliceId = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('demo', aliceId);
    alice = await person(browser, relay, 'Alice', import.meta.filename);
  });
  test.afterAll(async () => {
    await alice?.context.close();
    await relay.close();
  });

  test("Alice's agent asks to share; the page opens signed out, and after the login link she is back on it and clicks Share", async () => {
    let approvalUrl = '';
    const aliceAgent = await agent(relay, relay.agentToken(aliceId), {
      onPage: async (url) => {
        approvalUrl = url;
        const signedOut = await alice.open(url);
        expect(signedOut.status()).toBe(401);
        expect(await alice.page.locator('body').innerText()).not.toContain(ALICE_TEXT);
        await alice.shot('return-after-sign-in-signed-out.png');
        const back = await alice.open(relay.loginLink(aliceId));
        expect(back.status()).toBe(200);
        expect(alice.page.url()).toBe(url);
        await expect(alice.page.getByRole('region')).toContainText(`“${ALICE_TEXT}”`);
        await alice.shot('return-after-sign-in-back.png');
        await alice.click(alice.page.getByRole('button', { name: 'Share' }));
        await expect(alice.page.getByText("It's on your card now.")).toBeVisible();
      },
    });
    const shared = await aliceAgent.call('update_card', { status: 'looking', tags: ['nodejs', 'express'], summary: ALICE_TEXT, ask_for_intro: false });
    await aliceAgent.close();
    expect(approvalUrl).toMatch(new RegExp(`^${relay.base}/ui/approvals/[\\w-]+$`));
    expect(shared.data.state).toBe('shared');
  });

  test('no CSP violations, and every form post carried the page origin', async () => {
    await alice.expectCleanBrowser();
  });
});
