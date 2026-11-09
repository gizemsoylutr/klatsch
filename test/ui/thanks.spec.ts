// "Thanks, this helped" in real browsers, light and dark, on a phone and a wide screen: Bob thanks the open
// note Alice wrote, Alice thanks Bob on the page right after she allows his intro, Bob thanks her on his
// Connected card; each button turns into "Thanked". Alice sees her own count on Home, turns on her badge in
// Settings, and the badge's public link shows a number only.
import { expect, test } from '@playwright/test';
import { createApproval } from '../../src/auth/approvals.ts';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person, SCREENSHOTS, type Person } from './people.ts';

const ALICE_OPEN = 'Cursor paging in a Node.js API on Postgres: use a keyset cursor on (created_at, id) and return next_cursor instead of OFFSET.';
const ALICE_ASK = 'Counting rows for paging on Postgres: run one COUNT query per list, not one per page.';
const BOB_TEXT = 'Paging in my Node.js API on Postgres returns every row at once.';

test.describe.serial('thanks: buttons, the Home count and the badge, light and dark, phone and wide', () => {
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
      test(`on a ${width}px screen (${colorScheme}), thanks turn into "Thanked", Alice sees her count and shows her badge`, async ({ browser }) => {
        // Fresh people for each round, so every button starts unclicked.
        const { klatsch, db, secret } = relay;
        const n = ++round;
        const alice = klatsch.ensureUser(`alice-${n}`, 'Alice');
        const bob = klatsch.ensureUser(`bob-${n}`, 'Bob');
        klatsch.addMember(klatsch.ensureCircle(`demo-${n}`, alice), bob, alice);
        klatsch.approveSip(alice, klatsch.draftSip(alice, { status: 'solved', tags: ['pagination'], summary: ALICE_OPEN, visibility: 'open' }, 'cli').sipId, 'cli');
        klatsch.approveSip(alice, klatsch.draftSip(alice, { status: 'solved', tags: ['postgres'], summary: ALICE_ASK }, 'cli').sipId, 'cli');
        klatsch.approveSip(bob, klatsch.draftSip(bob, { status: 'looking', tags: ['pagination', 'postgres'], summary: BOB_TEXT }, 'cli').sipId, 'cli');
        const ask = db.prepare(`SELECT id FROM matches WHERE seeker_id = ? AND tags LIKE '%"postgres"%'`).get(bob) as { id: string };
        const introId = klatsch.requestIntro(bob, ask.id).introId;
        const answer = createApproval(db, secret, alice, 'answer_intro', { intro_id: introId }).approval.id;
        const options = { colorScheme, viewport: { width, height: width === 1280 ? 900 : 844 } };
        const tag = `${colorScheme}-${width}`;

        const b = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(bob), options);
        const a = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(alice), options);
        people.push(a, b);

        // Bob: Thanks next to Send once on Alice's open note.
        const note = b.page.getByRole('listitem').filter({ hasText: ALICE_OPEN });
        await expect(note.getByRole('button', { name: 'Send once' })).toBeVisible();
        await check(b, `thanks-bob-note-${tag}.png`);
        expect((await b.click(note.getByRole('button', { name: 'Thanks', exact: true }))).status()).toBe(200);
        await expect(note.getByText('Thanked', { exact: true })).toBeVisible();
        await expect(note.getByRole('button', { name: 'Thanks', exact: true })).toHaveCount(0);

        // Alice allows the intro; the connected page offers "Thanks, this helped".
        expect((await a.open(`${relay.base}/ui/approvals/${answer}`)).status()).toBe(200);
        expect((await a.click(a.page.getByRole('button', { name: 'Allow once' }))).status()).toBe(200);
        await expect(a.page.getByText('Bob sees a thanks count with no names and no message. After an intro, they can often tell it was you.')).toBeVisible();
        await check(a, `thanks-alice-connected-${tag}.png`);
        expect((await a.click(a.page.getByRole('button', { name: 'Thanks, this helped' }))).status()).toBe(200);
        expect(a.page.url()).toBe(`${relay.base}/ui`);
        const aliceCard = a.page.locator('.conn').filter({ hasText: 'Bob' });
        await expect(aliceCard.getByText('Thanked', { exact: true })).toBeVisible();

        // Bob thanks Alice on his Connected card.
        await b.open(`${relay.base}/ui`);
        const bobCard = b.page.locator('.conn').filter({ hasText: 'Alice' });
        expect((await b.click(bobCard.getByRole('button', { name: 'Thanks', exact: true }))).status()).toBe(200);
        await expect(bobCard.getByText('Thanked', { exact: true })).toBeVisible();
        await expect(b.page.getByText('Your notes helped 1 person this month.')).toBeVisible();
        await check(b, `thanks-bob-thanked-${tag}.png`);

        // Alice: her own count on Home, only for her.
        await a.open(`${relay.base}/ui`);
        await expect(a.page.getByText('Your notes helped 1 person this month.')).toBeVisible();
        await expect(a.page.getByText('1 since you joined · only you see this')).toBeVisible();
        await check(a, `thanks-alice-home-${tag}.png`);

        // Settings: the Thanks group, the badge off by default, then on with its link and a Markdown line.
        expect((await a.click(a.page.getByRole('link', { name: 'Show badge' }))).status()).toBe(200);
        const badgeSwitch = a.page.getByRole('switch', { name: 'Show a badge' });
        await expect(badgeSwitch).toHaveAttribute('aria-checked', 'false');
        await expect(a.page.getByText('Your notes helped 1 person', { exact: true })).toBeVisible();
        expect((await a.click(badgeSwitch)).status()).toBe(200);
        await expect(a.page.getByRole('switch', { name: 'Show a badge' })).toHaveAttribute('aria-checked', 'true');
        const url = (await a.page.locator('code.cmd').filter({ hasText: /\/badge\/[\w-]+\.svg$/ }).innerText()).trim();
        await expect(a.page.locator('code.cmd').filter({ hasText: `[![Helped people on Klatsch](${url})]` })).toBeVisible();
        // "Show badge" landed on #thanks; from the top, so the sticky bar sits where it belongs in the full-page shot.
        await a.page.evaluate('window.scrollTo(0, 0)');
        await check(a, `thanks-alice-settings-${tag}.png`);

        // The badge itself, as anyone would load it: an SVG with a number only.
        const badge = await a.open(url);
        expect(badge.status()).toBe(200);
        expect(badge.headers()['content-type']).toBe('image/svg+xml; charset=utf-8');
        const svg = await badge.text();
        expect(svg).toContain('>Helped 1 person on Klatsch<');
        expect(svg).not.toMatch(/alice|bob/i);
        // As a README shows it: an image on another page. (A full-page shot of a bare SVG document hangs in both engines.)
        const readme = await a.context.newPage();
        await readme.setContent(`<body style="margin:24px;background:${colorScheme === 'dark' ? '#0d1117' : '#ffffff'}"><img alt="badge" src="${url}"></body>`);
        const img = readme.getByRole('img', { name: 'badge' });
        await expect.poll(() => img.evaluate((el: { complete: boolean; naturalWidth: number }) => el.complete && el.naturalWidth > 0)).toBe(true);
        await img.screenshot({ path: `${SCREENSHOTS}/${browser.browserType().name()}/thanks-badge-${tag}.png` });
        await readme.close();
      });
    }
  }

  test('no CSP violations, and every post came from the page', async () => {
    for (const p of people) await p.expectCleanBrowser();
  });
});
