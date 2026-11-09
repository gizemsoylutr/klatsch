// The whole Klatsch story in real browsers: Alice's agent asks to share what she is stuck on; the client
// opens the approval page in her browser and she clicks Share. Two people solved it: Bob allows the
// intro on his dashboard, Dave declines on the page his agent opened. Only Alice and Bob learn names.
import { expect, test } from '@playwright/test';
import { agent, CODE, startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

const ALICE_TEXT = 'Paging in my Node.js API on Postgres returns every row at once.';
const BOB_TEXT = 'Cursor paging in a Node.js API on Postgres: use a keyset cursor on (created_at, id) and return next_cursor instead of OFFSET.';
const DAVE_TEXT = 'Paged a Node.js API on Postgres by returning next_cursor from the handler.';

type Agent = Awaited<ReturnType<typeof agent>>;

test.describe.serial('share and intro: Alice approves in her browser, Bob accepts, Dave declines', () => {
  let relay: Relay;
  let ids: Record<'alice' | 'bob' | 'dave', string>;
  let alice: Person, bob: Person, dave: Person;
  let aliceAgent: Agent, daveAgent: Agent;
  const seen: Record<string, { status: number; text: string }> = {};

  test.beforeAll(async ({ browser }) => {
    relay = await startRelay();
    ids = {
      alice: relay.klatsch.ensureUser('alice', 'Alice'),
      bob: relay.klatsch.ensureUser('bob', 'Bob'),
      dave: relay.klatsch.ensureUser('dave', 'Dave'),
    };
    const circle = relay.klatsch.ensureCircle('demo', ids.alice);
    relay.klatsch.addMember(circle, ids.bob, ids.alice);
    relay.klatsch.addMember(circle, ids.dave, ids.alice);
    for (const [solver, text] of [
      [ids.bob, BOB_TEXT],
      [ids.dave, DAVE_TEXT],
    ] as const) {
      const solved = relay.klatsch.draftSip(solver, { status: 'solved', tags: ['nodejs', 'express', 'pagination'], summary: text }, 'cli');
      relay.klatsch.approveSip(solver, solved.sipId, 'cli');
    }
    alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(ids.alice));
    bob = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(ids.bob));
    dave = await person(browser, relay, 'Dave', import.meta.filename, relay.loginLink(ids.dave));
  });
  test.afterAll(async () => {
    await Promise.all([aliceAgent?.close(), daveAgent?.close()]);
    await Promise.all([alice, bob, dave].map((p) => p?.context.close()));
    await relay.close();
  });

  test("Alice's agent asks to share; her browser shows the exact sip and what will happen; she clicks Share", async () => {
    // Claude Code opens the dialog's URL in her browser. Before she decides, Bob tries the same URL in his.
    aliceAgent = await agent(relay, relay.agentToken(ids.alice), {
      onPage: async (url) => {
        const foreign = await bob.open(url);
        seen.foreign = { status: foreign.status(), text: await bob.page.locator('body').innerText() };
        const page = await alice.open(url);
        seen.alice = { status: page.status(), text: await alice.page.getByRole('region').innerText() };
        await alice.shot('share-and-intro-alice-approval.png');
        const decided = await alice.click(alice.page.getByRole('button', { name: 'Share' }));
        seen.aliceDecided = { status: decided.status(), text: await alice.page.locator('body').innerText() };
        await alice.shot('share-and-intro-alice-approved.png');
      },
    });
    const shared = await aliceAgent.call('update_card', { status: 'looking', tags: ['pagination', 'express', 'nodejs'], summary: ALICE_TEXT });

    expect(aliceAgent.dialogs).toHaveLength(1);
    expect(aliceAgent.dialogs[0]!.url).toMatch(new RegExp(`^${relay.base}/ui/approvals/[\\w-]+$`));
    expect(seen.alice!.status).toBe(200);
    expect(seen.alice!.text).toContain('Share this sip?');
    expect(seen.alice!.text).toContain(`“${ALICE_TEXT}”`);
    expect(seen.alice!.text).toMatch(/^Adds to your card as looking$/m);
    expect(seen.alice!.text).toContain('Whoever solved this gets an intro request and reads this sip.');
    expect(seen.aliceDecided!.status).toBe(200);
    expect(seen.aliceDecided!.text).toContain("It's on your card now.");
    expect(seen.aliceDecided!.text).toContain('Your agent sees the outcome; you can close this page.');

    expect(shared.data.state, 'the agent call returns the outcome').toBe('shared');
    expect(shared.data.intros).toHaveLength(2);
    expect(shared.raw).not.toMatch(CODE);
  });

  test("the approval page refuses another person's browser", () => {
    expect(seen.foreign!.status).toBe(404);
    expect(seen.foreign!.text).toContain('This request has expired.');
    expect(seen.foreign!.text).toContain('Ask your agent for a new one.');
    expect(seen.foreign!.text).not.toContain(ALICE_TEXT);
  });

  test("Bob's dashboard shows what she is stuck on, not her name; he clicks 'Allow once'", async () => {
    await bob.open(`${relay.base}/ui`);
    const waiting = bob.page.locator('section', { has: bob.page.getByRole('heading', { name: 'Needs you 1', exact: true }) });
    await expect(waiting).toContainText('Someone would like to compare notes.');
    await expect(waiting).toContainText(`“${ALICE_TEXT}”`);
    await expect(waiting).toContainText('Allowing shares your names.');
    await bob.shot('share-and-intro-bob-intro-request.png');
    expect(await bob.page.locator('body').innerText()).not.toMatch(/Alice|@alice/);
    const accepted = await bob.click(waiting.getByRole('button', { name: 'Allow once' }));
    expect(accepted.status()).toBe(200);
    expect(bob.page.url()).toBe(`${relay.base}/ui`);
  });

  test("Dave's agent asks him on the approval page; he reads the request, not who sent it, and clicks Decline", async () => {
    daveAgent = await agent(relay, relay.agentToken(ids.dave), {
      onPage: async (url) => {
        const page = await dave.open(url);
        seen.dave = { status: page.status(), text: await dave.page.locator('body').innerText() };
        await dave.shot('share-and-intro-dave-intro-approval.png');
        await dave.click(dave.page.getByRole('button', { name: 'Decline' }));
      },
    });
    const inbox = await daveAgent.call('inbox');
    const request = inbox.data.events.find((e: { kind: string }) => e.kind === 'intro.requested');
    expect(request).toBeDefined();
    const answered = await daveAgent.call('respond_intro', { intro_id: request.ref });
    expect(seen.dave!.status).toBe(200);
    expect(seen.dave!.text).toContain('Someone would like to compare notes.');
    expect(seen.dave!.text).toContain("They're stuck on:");
    expect(seen.dave!.text).toContain(`“${ALICE_TEXT}”`);
    expect(seen.dave!.text).toContain('Allowing shares your names.');
    expect(seen.dave!.text).not.toMatch(/Alice|@alice/);
    expect(answered.data.state).toBe('declined');
    expect(answered.raw).not.toMatch(/Alice/);
  });

  test('Alice and Bob now see each other on their dashboards; nobody sees Dave', async () => {
    await alice.open(`${relay.base}/ui`);
    const alicesAccepted = alice.page.locator('section', { has: alice.page.getByRole('heading', { name: /^Connected 1 / }) });
    await expect(alicesAccepted).toContainText('Bob @bob');
    await expect(alicesAccepted).toContainText('Their sip');
    await expect(alicesAccepted).toContainText(`“${BOB_TEXT}”`);
    await alice.shot('share-and-intro-alice-names.png');
    expect(await alice.page.locator('body').innerText()).not.toMatch(/Dave|@dave/);

    await bob.open(`${relay.base}/ui`);
    const bobsAccepted = bob.page.locator('section', { has: bob.page.getByRole('heading', { name: /^Connected 1 / }) });
    await expect(bobsAccepted).toContainText('Alice @alice');
    await bob.shot('share-and-intro-bob-names.png');

    await dave.open(`${relay.base}/ui`);
    expect(await dave.page.locator('body').innerText()).not.toMatch(/Alice|@alice/);
  });

  test('only on an accepted intro, Alice can send Bob\'s sip to her own agent; she clicks "Send once"', async () => {
    await dave.open(`${relay.base}/ui`);
    await expect(dave.page.getByRole('button', { name: 'Send once' })).toHaveCount(0);
    await alice.open(`${relay.base}/ui`);
    const alicesAccepted = alice.page.locator('section', { has: alice.page.getByRole('heading', { name: /^Connected 1 / }) });
    const sent = await alice.click(alicesAccepted.getByRole('button', { name: 'Send once' }));
    expect(sent.status()).toBe(200);
    await expect(alice.page.getByRole('heading', { name: 'Sent.' })).toBeVisible();
    await expect(alice.page.getByText('Your agent will see it as a quote from @bob.')).toBeVisible();
    await alice.shot('share-and-intro-alice-sent-quote.png');
  });

  test('the sip shows how long it stays; a day later only the names stay and the button is gone', async () => {
    await alice.open(`${relay.base}/ui`);
    const accepted = () => alice.page.locator('section', { has: alice.page.getByRole('heading', { name: /^Connected 1 / }) });
    await expect(accepted()).toContainText(/Visible until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, then only the names stay\./);
    relay.db.prepare('UPDATE intros SET accepted_at = ? WHERE state = ?').run(Date.now() - 25 * 60 * 60 * 1000, 'accepted');
    await alice.open(`${relay.base}/ui`);
    await expect(accepted()).toContainText('@bob no longer shares this note.');
    await expect(accepted()).toContainText('Bob @bob');
    await expect(accepted()).not.toContainText(BOB_TEXT);
    await expect(accepted().getByRole('button', { name: 'Send once' })).toHaveCount(0);
    await alice.shot('share-and-intro-alice-names-only.png');
  });

  test('no CSP violations, and every form post carried the page origin', async () => {
    for (const p of [alice, bob, dave]) await p.expectCleanBrowser();
  });
});
