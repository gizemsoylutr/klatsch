// The dashboard in a real browser: drafts made in the terminal are shared or put off with their
// buttons, a sip is retired, and an intro Bob's agent asked for (he approved it on the page his client
// opened) is declined by Alice on her dashboard.
import { expect, test } from '@playwright/test';
import { agent, startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

const SOLVED = 'Use a keyset cursor on (created_at, id) and return next_cursor from the route handler.';
const FLAGGED = 'Fixed it on prod-erp.acme.internal by raising the batch size.';
const BOB_TEXT = 'Paging returns every row.';

test.describe.serial('dashboard: drafts, the card and intros, decided with buttons', () => {
  let relay: Relay;
  let alice: Person, bob: Person;
  let bobAgent: Awaited<ReturnType<typeof agent>>;
  const seen: Record<string, string> = {};

  const section = (p: Person, heading: RegExp) => p.page.locator('section', { has: p.page.getByRole('heading', { name: heading }) });

  test.beforeAll(async ({ browser }) => {
    relay = await startRelay();
    const a = relay.klatsch.ensureUser('alice', 'Alice');
    const b = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', a), b, a);
    relay.klatsch.draftSip(a, { status: 'solved', tags: ['nodejs', 'express'], summary: SOLVED }, 'cli');
    relay.klatsch.draftSip(a, { status: 'solved', tags: ['nodejs'], summary: FLAGGED }, 'cli');
    const looking = relay.klatsch.draftSip(b, { status: 'looking', tags: ['nodejs'], summary: BOB_TEXT }, 'cli');
    relay.klatsch.approveSip(b, looking.sipId, 'cli');
    alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(a));
    bob = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(b));
  });
  test.afterAll(async () => {
    await bobAgent?.close();
    await Promise.all([alice, bob].map((p) => p?.context.close()));
    await relay.close();
  });

  test('two drafts wait on the dashboard, one with a warning about a hostname', async () => {
    const drafts = section(alice, /^Needs you 2$/);
    await expect(drafts.locator('.item')).toHaveCount(2);
    await expect(drafts.locator('.item', { hasText: FLAGGED })).toContainText('Check before sharing: hostname: prod-erp.acme.internal');
    await alice.shot('dashboard-drafts.png');
  });

  test('Alice clicks Share on one and Not now on the other', async () => {
    await alice.click(section(alice, /^Needs you/).locator('.item', { hasText: SOLVED }).getByRole('button', { name: 'Share' }));
    await expect(section(alice, /^Your card 1$/)).toContainText(SOLVED);
    await alice.click(section(alice, /^Needs you/).locator('.item', { hasText: FLAGGED }).getByRole('button', { name: 'Not now' }));
    await expect(alice.page.getByRole('heading', { name: 'Needs you 0', exact: true })).toBeVisible();
    expect(await alice.page.content()).not.toContain(FLAGGED);
  });

  test("Bob's agent asks for an intro; Bob reads what Alice will see and clicks Ask", async () => {
    bobAgent = await agent(relay, relay.agentToken(relay.klatsch.ensureUser('bob', 'Bob')), {
      onPage: async (url) => {
        await bob.open(url);
        seen.bob = await bob.page.getByRole('region').innerText();
        await bob.shot('dashboard-bob-intro-ask.png');
        await bob.click(bob.page.getByRole('button', { name: 'Ask' }));
      },
    });
    const found = await bobAgent.call('find_matches', { tags: ['nodejs'] });
    expect(found.data.matches).toHaveLength(1);
    const asked = await bobAgent.call('request_intro', { match_id: found.data.matches[0].match_id });
    expect(asked.data.state, 'approved, so the intro now waits for the solver').toBe('awaiting-solver');
    expect(seen.bob).toContain('Ask for an intro?');
    expect(seen.bob).toContain("They'll read your sip:");
    expect(seen.bob).toContain(`“${BOB_TEXT}”`);
    expect(seen.bob).toContain('Names are shared only if they accept.');
    expect(seen.bob).not.toMatch(/Alice/);
  });

  test("Alice sees the request on her dashboard, without Bob's name, and clicks Decline", async () => {
    await alice.open(`${relay.base}/ui`);
    const waiting = section(alice, /^Needs you 1$/);
    await expect(waiting).toContainText('Someone would like to compare notes.');
    await expect(waiting).toContainText(`“${BOB_TEXT}”`);
    await expect(waiting).toContainText('Allowing shares your names.');
    expect(await alice.page.locator('body').innerText()).not.toMatch(/Bob|@bob/);
    await alice.click(waiting.getByRole('button', { name: 'Decline' }));
    await expect(alice.page.getByRole('heading', { name: 'Needs you 0', exact: true })).toBeVisible();
    await expect(alice.page.getByRole('heading', { name: /^Connected 0 / })).toBeVisible();
  });

  test('Alice clicks Retire on her sip; it leaves her card', async () => {
    await alice.click(section(alice, /^Your card/).getByRole('button', { name: 'Retire' }));
    await expect(alice.page.getByRole('heading', { name: 'Your card 0', exact: true })).toBeVisible();
    expect((await bobAgent.call('find_matches', { tags: ['nodejs'] })).data.matches).toHaveLength(0);
  });

  test('no CSP violations, and every form post carried the page origin', async () => {
    for (const p of [alice, bob]) await p.expectCleanBrowser();
  });
});
