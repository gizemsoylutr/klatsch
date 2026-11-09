// Standing consent in real browsers. Bob shares one note open to the circle and one that asks first.
// Alice reads the open one at once and chooses to always get Bob's notes; Bob allows Carol's intro always,
// Carol chooses the same for Bob's notes; both "always" are listed in Settings and revoked with one click.
import { expect, test } from '@playwright/test';
import { createApproval } from '../../src/auth/approvals.ts';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

const BOB_OPEN = 'Cursor paging in a Node.js API on Postgres: use a keyset cursor on (created_at, id) and return next_cursor instead of OFFSET.';
const BOB_ASK = 'For a total count with paging in Postgres, run a separate COUNT query, not one per page.';

test.describe.serial('standing consent: open notes, "always" on both sides, revoked in Settings', () => {
  let relay: Relay;
  let ids: Record<'alice' | 'bob' | 'carol', string>;
  let alice: Person, bob: Person, carol: Person;
  let introId = '';

  test.beforeAll(async ({ browser }) => {
    relay = await startRelay();
    const { klatsch } = relay;
    ids = { alice: klatsch.ensureUser('alice', 'Alice'), bob: klatsch.ensureUser('bob', 'Bob'), carol: klatsch.ensureUser('carol', 'Carol') };
    const circle = klatsch.ensureCircle('demo', ids.alice);
    klatsch.addMember(circle, ids.bob, ids.alice);
    klatsch.addMember(circle, ids.carol, ids.alice);
    klatsch.approveSip(ids.alice, klatsch.draftSip(ids.alice, { status: 'looking', tags: ['pagination'], summary: 'My Express API returns every row at once.' }, 'cli').sipId, 'cli');
    klatsch.approveSip(ids.carol, klatsch.draftSip(ids.carol, { status: 'looking', tags: ['javascript'], summary: 'My $count is wrong with paging.' }, 'cli').sipId, 'cli');
    alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(ids.alice));
    bob = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(ids.bob));
    carol = await person(browser, relay, 'Carol', import.meta.filename, relay.loginLink(ids.carol));
  });
  test.afterAll(async () => {
    await Promise.all([alice, bob, carol].map((p) => p?.context.close()));
    await relay.close();
  });

  // As update_card opens it today: with the choice, open unless the agent proposed otherwise.
  const share = (summary: string, tags: string[]) =>
    createApproval(relay.db, relay.secret, ids.bob, 'share_sip', { status: 'solved', tags: JSON.stringify(tags), summary, ask_for_intro: 'false', visibility: 'open' }).approval.id;
  const section = (p: Person, heading: RegExp) => p.page.locator('section', { has: p.page.getByRole('heading', { name: heading }) });

  test('on the approval page of a solved note, "Open to my circle" is chosen; Bob reads what it means and clicks Share', async () => {
    await bob.open(`${relay.base}/ui/approvals/${share(BOB_OPEN, ['pagination'])}`);
    await expect(bob.page.getByRole('radio', { name: /Open to my circle/ })).toBeChecked();
    await expect(bob.page.getByRole('radio', { name: /Ask me first/ })).not.toBeChecked();
    await expect(bob.page.getByRole('group', { name: 'Who reads it' })).toContainText('Nobody asks you, and you are not disturbed.');
    await bob.shot('consent-share-open.png');
    expect((await bob.click(bob.page.getByRole('button', { name: 'Share' }))).status()).toBe(200);
  });

  test("Alice's dashboard shows Bob's note with his name at once; she clicks \"Send once\"", async () => {
    await alice.open(`${relay.base}/ui`);
    const notes = section(alice, /^Notes from your circle solved, open to you · 1$/);
    await expect(notes).toContainText(BOB_OPEN);
    await expect(notes).toContainText('Bob @bob');
    await expect(notes).toContainText('From now on, their notes that match what you are looking for reach your agent without asking you. Revoke any time in Settings.');
    await alice.shot('consent-alice-open-note.png');
    expect((await alice.click(notes.getByRole('button', { name: 'Send once' }))).status()).toBe(200);
    await expect(alice.page.getByText('Your agent will see it as a quote from @bob.')).toBeVisible();
  });

  test(`she clicks "Always send @bob's notes to my agent"; her page then says it goes there`, async () => {
    await alice.open(`${relay.base}/ui`);
    const notes = section(alice, /^Notes from your circle/);
    expect((await alice.click(notes.getByRole('button', { name: "Always send @bob's notes to my agent" }))).status()).toBe(200);
    await expect(alice.page.getByText("Your agent will see it as a quote from @bob, and from now on @bob's notes that match what you are looking for, without asking you.")).toBeVisible();
    await alice.open(`${relay.base}/ui`);
    await expect(section(alice, /^Notes from your circle/).locator('.item')).toContainText('already goes to your agent');
    await expect(alice.page.getByRole('button', { name: /Always send/ })).toHaveCount(0);
  });

  test('Bob shares a second note and picks "Ask me first"; Carol, who matches it, does not see it', async () => {
    await bob.open(`${relay.base}/ui/approvals/${share(BOB_ASK, ['javascript'])}`);
    await bob.page.getByRole('radio', { name: /Ask me first/ }).check();
    await bob.shot('consent-share-ask.png');
    expect((await bob.click(bob.page.getByRole('button', { name: 'Share' }))).status()).toBe(200);
    await bob.open(`${relay.base}/ui`);
    await expect(section(bob, /^Your card/)).toContainText(/solved · javascript\s*ask me first/);
    await carol.open(`${relay.base}/ui`);
    await expect(carol.page.getByText(BOB_ASK)).toHaveCount(0);
  });

  test('Carol asks for an intro; Bob\'s dashboard offers "Allow once" and "Allow always" with what it means; he clicks "Allow always"', async () => {
    const match = (relay.db.prepare('SELECT id FROM matches WHERE seeker_id = ?').get(ids.carol) as { id: string }).id;
    introId = relay.klatsch.requestIntro(ids.carol, match).introId;
    await bob.open(`${relay.base}/ui`);
    const waiting = section(bob, /^Needs you 1$/);
    await expect(waiting.getByRole('button', { name: 'Allow once' })).toBeVisible();
    await expect(waiting).toContainText('They also see the notes you share from now on with these tags in the circle where they asked, without asking you. Revoke any time in Settings.');
    await bob.shot('consent-bob-allow.png');
    expect((await bob.click(waiting.getByRole('button', { name: 'Allow always' }))).status()).toBe(200);
  });

  test(`Carol, connected, clicks "Always send @bob's notes to my agent" on the accepted intro`, async () => {
    await carol.open(`${relay.base}/ui`);
    const accepted = section(carol, /^Connected 1 /);
    await expect(accepted).toContainText(BOB_ASK);
    expect((await carol.click(accepted.getByRole('button', { name: "Always send @bob's notes to my agent" }))).status()).toBe(200);
    await expect(carol.page.getByRole('heading', { name: 'Sent.' })).toBeVisible();
  });

  test('Settings list each "always" by person; Bob and Alice each click Revoke', async () => {
    await bob.open(`${relay.base}/ui/settings`);
    const readers = section(bob, /^Who reads your notes without asking$/);
    await expect(readers).toContainText('Carol (@carol)');
    await expect(readers).toContainText('notes with javascript');
    await expect(section(bob, /^Whose notes go to your agent$/)).toContainText('Nobody.');
    await bob.shot('consent-bob-settings.png');
    expect((await bob.click(readers.getByRole('button', { name: 'Revoke' }))).status()).toBe(200);
    await expect(section(bob, /^Who reads your notes without asking$/)).toContainText('Nobody.');

    await alice.open(`${relay.base}/ui/settings`);
    const senders = section(alice, /^Whose notes go to your agent$/);
    await expect(senders).toContainText('Bob (@bob)');
    expect((await alice.click(senders.getByRole('button', { name: 'Revoke' }))).status()).toBe(200);
    await expect(section(alice, /^Whose notes go to your agent$/)).toContainText('Nobody.');
  });

  test('no CSP violations, and every form post carried the page origin', async () => {
    for (const p of [alice, bob, carol]) await p.expectCleanBrowser();
  });
});
