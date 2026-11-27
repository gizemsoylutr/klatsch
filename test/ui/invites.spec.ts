// Invites in real browsers: Alice clicks "Invite someone" and sees the link once; Carol opens it in her
// own browser and joins; Alice's circle page shows the tree; Alice removes Carol and Carol's session ends.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

test.describe.serial('invites: Alice invites Carol, Carol joins, Alice removes her', () => {
  let relay: Relay;
  let ids: Record<'alice' | 'bob' | 'carol' | 'dave', string>;
  let alice: Person, bob: Person, carol: Person, dave: Person;
  let link = '';

  test.beforeAll(async ({ browser }) => {
    relay = await startRelay();
    ids = {
      alice: relay.klatsch.ensureUser('alice', 'Alice'),
      bob: relay.klatsch.ensureUser('bob', 'Bob'),
      carol: relay.klatsch.ensureUser('carol', 'Carol'),
      dave: relay.klatsch.ensureUser('dave', 'Dave'),
    };
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', ids.alice), ids.bob, ids.alice);
    alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(ids.alice));
    bob = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(ids.bob));
    carol = await person(browser, relay, 'Carol', import.meta.filename, relay.loginLink(ids.carol), { member: false });
    dave = await person(browser, relay, 'Dave', import.meta.filename, relay.loginLink(ids.dave), { member: false });
  });
  test.afterAll(async () => {
    await Promise.all([alice, bob, carol, dave].map((p) => p?.context.close()));
    await relay.close();
  });

  test('Alice opens her circles from the dashboard and clicks "Invite someone"; the link is shown once', async () => {
    await alice.goTo('Circle');
    await expect(alice.page.getByRole('heading', { name: 'demo · 2 people' })).toBeVisible();
    const shown = await alice.click(alice.page.getByRole('button', { name: 'Invite someone' }));
    expect(shown.status()).toBe(200);
    await expect(alice.page.getByText('It works once, for seven days, and is shown only now.')).toBeVisible();
    link = await alice.page.locator('code').innerText();
    expect(link).toMatch(new RegExp(`^${relay.base}/ui/invite/[\\w-]+$`));
    await alice.shot('invites-link-shown.png');
    await alice.click(alice.page.getByRole('link', { name: 'Back to your circles' }));
    expect(await alice.page.content()).not.toContain(link.split('/').at(-1)!);
  });

  test('Carol opens the link in her browser, sees who invites her to which circle, and clicks Join', async () => {
    const page = await carol.open(link);
    expect(page.status()).toBe(200);
    await expect(carol.page.getByText('Alice (@alice) invites you to demo.')).toBeVisible();
    await carol.shot('invites-carol-invite.png');
    const joined = await carol.click(carol.page.getByRole('button', { name: 'Join' }));
    expect(joined.status()).toBe(200);
    await expect(carol.page.getByText('You joined demo.')).toBeVisible();
    await carol.shot('invites-carol-joined.png');
  });

  test('the link does not work a second time, in anyone’s browser', async () => {
    const used = await dave.open(link);
    expect(used.status()).toBe(404);
    await expect(dave.page.getByText('This invite is not valid. Invites work once and last seven days.')).toBeVisible();
    await dave.shot('invites-link-used.png');
  });

  test("Alice's circle page shows the tree: Carol under Alice; only Alice gets Remove buttons", async () => {
    await alice.open(`${relay.base}/ui/circle`);
    await expect(alice.page.getByRole('heading', { name: 'demo · 3 people' })).toBeVisible();
    const aliceItem = alice.page.locator('li', { has: alice.page.getByText('Alice', { exact: true }) }).first();
    await expect(aliceItem.locator('li', { hasText: 'Carol @carol' })).toBeVisible();
    await expect(alice.page.getByRole('button', { name: 'Remove' })).toHaveCount(2);
    await alice.shot('invites-circle-tree.png');
    await bob.open(`${relay.base}/ui/circle`);
    await expect(bob.page.getByRole('heading', { name: 'demo · 3 people' })).toBeVisible();
    await expect(bob.page.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  });

  test('Alice removes Carol; Carol is signed out of Klatsch', async () => {
    const carolItem = alice.page.locator('li', { hasText: 'Carol @carol' }).last();
    const removed = await alice.click(carolItem.getByRole('button', { name: 'Remove' }));
    expect(removed.status()).toBe(200);
    expect(alice.page.url()).toBe(`${relay.base}/ui/circle`);
    await expect(alice.page.getByRole('heading', { name: 'demo · 2 people' })).toBeVisible();
    await expect(alice.page.getByText('@carol')).toHaveCount(0);
    expect((await carol.open(`${relay.base}/ui`)).status()).toBe(401);
  });

  test('no CSP violations, and every form post carried the page origin', async () => {
    for (const p of [alice, bob, carol, dave]) await p.expectCleanBrowser();
  });
});
