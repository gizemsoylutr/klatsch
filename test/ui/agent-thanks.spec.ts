// Thanks from the agent in real browsers, light and dark, on a phone and a wide screen: Bob's agent thanked
// Alice for the note it got; Bob sees "Your agent thanked Alice" with Undo on Home and takes it back. In
// Settings › Thanks the switch "Let my agent say thanks when a note fixed the problem" is on, and he turns
// it off and on again.
import { expect, test } from '@playwright/test';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

const ALICE_OPEN = 'Cursor paging in a Node.js API on Postgres: use a keyset cursor on (created_at, id) and return next_cursor instead of OFFSET.';
const BOB_TEXT = 'Paging in my Node.js API on Postgres returns every row at once.';
const SWITCH = 'Let my agent say thanks when a note fixed the problem';

test.describe.serial('agent thanks: the Home line with Undo and the Settings switch, light and dark, phone and wide', () => {
  let relay: Relay;
  const people: Person[] = [];

  test.beforeAll(async () => {
    relay = await startRelay();
  });
  test.afterAll(async () => {
    await Promise.all(people.map((p) => p.context.close()));
    await relay.close();
  });

  /** Nothing scrolls sideways, then a full-page screenshot. */
  const check = async (p: Person, file: string) => {
    const [scroll, client] = await p.page.evaluate<[number, number]>('[document.documentElement.scrollWidth, document.documentElement.clientWidth]');
    expect(scroll, `${file}: horizontal scroll`).toBeLessThanOrEqual(client);
    await p.shot(file);
  };

  let round = 0;
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [1280, 390] as const) {
      test(`on a ${width}px screen (${colorScheme}), Bob undoes his agent's thanks and switches agent thanks off and on`, async ({ browser }) => {
        // Fresh people for each round: Bob's agent has just thanked Alice for the note it got.
        const { klatsch } = relay;
        const n = ++round;
        const alice = klatsch.ensureUser(`alice-${n}`, 'Alice');
        const bob = klatsch.ensureUser(`bob-${n}`, 'Bob');
        klatsch.addMember(klatsch.ensureCircle(`demo-${n}`, alice), bob, alice);
        const sipId = klatsch.draftSip(alice, { status: 'solved', tags: ['pagination'], summary: ALICE_OPEN, visibility: 'open' }, 'cli').sipId;
        klatsch.approveSip(alice, sipId, 'cli');
        klatsch.approveSip(bob, klatsch.draftSip(bob, { status: 'looking', tags: ['pagination'], summary: BOB_TEXT }, 'cli').sipId, 'cli');
        klatsch.sendNote(bob, sipId);
        const quote = klatsch.inbox(bob).find((e) => e.type === 'quote')!;
        expect(klatsch.agentThankNote(bob, quote.ref)).toBe(true);
        const options = { colorScheme, viewport: { width, height: width === 1280 ? 900 : 844 } };
        const tag = `${colorScheme}-${width}`;

        const b = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(bob), options);
        people.push(b);

        // Home: the line, its Undo, and the note shows Thanked.
        const line = b.page.locator('.agent-thanks li').filter({ hasText: 'Your agent thanked Alice' });
        await expect(line).toBeVisible();
        await expect(b.page.getByRole('listitem').filter({ hasText: ALICE_OPEN }).getByText('Thanked', { exact: true })).toBeVisible();
        await check(b, `agent-thanks-home-${tag}.png`);
        expect((await b.click(line.getByRole('button', { name: 'Undo' }))).status()).toBe(200);
        expect(b.page.url()).toBe(`${relay.base}/ui`);
        await expect(b.page.locator('.agent-thanks')).toHaveCount(0);
        await expect(b.page.getByRole('listitem').filter({ hasText: ALICE_OPEN }).getByRole('button', { name: 'Thanks', exact: true })).toBeVisible();
        expect(klatsch.helped(alice)).toEqual({ month: 0, total: 0 });

        // Settings › Thanks: on by default; off, then on again.
        await b.open(`${relay.base}/ui/settings#thanks`);
        const toggle = b.page.getByRole('switch', { name: SWITCH });
        await expect(toggle).toHaveAttribute('aria-checked', 'true');
        await b.page.evaluate('window.scrollTo(0, 0)');
        await check(b, `agent-thanks-settings-on-${tag}.png`);
        expect((await b.click(toggle)).status()).toBe(200);
        await expect(b.page.getByRole('switch', { name: SWITCH })).toHaveAttribute('aria-checked', 'false');
        await expect(b.page.getByText('Off. Only you can say thanks, with the button next to a note.')).toBeVisible();
        await b.page.evaluate('window.scrollTo(0, 0)');
        await check(b, `agent-thanks-settings-off-${tag}.png`);
        expect((await b.click(b.page.getByRole('switch', { name: SWITCH }))).status()).toBe(200);
        await expect(b.page.getByRole('switch', { name: SWITCH })).toHaveAttribute('aria-checked', 'true');
      });
    }
  }

  test('no CSP violations, and every post came from the page', async () => {
    for (const p of people) await p.expectCleanBrowser();
  });
});
