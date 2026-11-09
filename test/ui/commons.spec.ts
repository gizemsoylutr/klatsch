// Link cards and the commons in real browsers, light and dark, on a phone and a wide screen. The operator has
// turned on the public join link of Gizem's circle; her Circle page shows it with Turn off. Bob shares a link
// card on the approval page: the source with its host, his private circle ticked and the commons not, until
// he ticks it. Carol, in no
// circle yet, opens the join link and joins; her Home shows Bob's link card with the host apart from the
// title, and her Circle page names only the owner and herself. Gizem turns the link off again.
import { expect, test } from '@playwright/test';
import { createApproval } from '../../src/auth/approvals.ts';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

const BOB_TEXT = 'Postgres keyset paging: order by (created_at, id) and pass the last pair as the cursor.';
const CAROL_TEXT = 'My Postgres API pages with OFFSET and gets slow on later pages.';
const SOURCE = { url: 'https://use-the-index-luke.com/no-offset', title: 'Faster pagination in Postgres', author: 'Markus Winand' };

test.describe.serial('link cards and the commons: join link, approval with source and circles, Home link card, light and dark, phone and wide', () => {
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
      test(`on a ${width}px screen (${colorScheme}), a link card reaches a stranger in the commons only once Bob ticks it`, async ({ browser }) => {
        const { klatsch, db, secret } = relay;
        const n = ++round;
        const gizem = klatsch.ensureUser(`gizem-${n}`, 'Gizem');
        const alice = klatsch.ensureUser(`alice-${n}`, 'Alice');
        const bob = klatsch.ensureUser(`bob-${n}`, 'Bob');
        const carol = klatsch.ensureUser(`carol-${n}`, 'Carol');
        const beta = klatsch.ensureCircle(`beta-${n}`, alice);
        klatsch.addMember(beta, bob, alice);
        const commons = klatsch.ensureCircle(`commons-${n}`, gizem);
        const options = { colorScheme, viewport: { width, height: width === 1280 ? 900 : 844 } };
        const tag = `${colorScheme}-${width}`;

        // The operator turned the join link on; Gizem sees it on her Circle page, with Turn off and no Turn on.
        klatsch.setJoinLink(gizem, commons, true);
        const g = await person(browser, relay, 'Gizem', import.meta.filename, relay.loginLink(gizem), options);
        people.push(g);
        await g.open(`${relay.base}/ui/circle`);
        await expect(g.page.getByRole('button', { name: 'Turn on' })).toHaveCount(0);
        const link = (await g.page.locator('code.cmd').filter({ hasText: '/join/' }).textContent())!;
        expect(link).toMatch(new RegExp(`^${relay.base}/join/[\\w-]{22}$`));
        await expect(g.page.getByRole('button', { name: 'Turn off' })).toBeVisible();
        await check(g, `commons-owner-link-${tag}.png`);
        const token = link.split('/').at(-1)!;
        klatsch.joinPublic(bob, token);

        // Bob's approval page: the link card, and where it opens; the commons is not ticked until he ticks it.
        const { approval } = createApproval(db, secret, bob, 'share_sip', {
          status: 'solved',
          tags: JSON.stringify(['postgres', 'pagination']),
          summary: BOB_TEXT,
          ask_for_intro: 'false',
          visibility: 'open',
          source_url: SOURCE.url,
          source_title: SOURCE.title,
          source_author: SOURCE.author,
        });
        const b = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(bob), options);
        people.push(b);
        await b.open(`${relay.base}/ui/approvals/${approval.id}`);
        const card = b.page.locator('.src');
        await expect(card.getByRole('link', { name: SOURCE.title })).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
        await expect(card.getByRole('link', { name: SOURCE.title })).toHaveAttribute('target', '_blank');
        await expect(card.locator('.host')).toHaveText('use-the-index-luke.com');
        await expect(b.page.getByRole('checkbox', { name: new RegExp(`^beta-${n}`) })).toBeChecked();
        const ticked = b.page.getByRole('checkbox', { name: new RegExp(`^commons-${n}`) });
        await expect(ticked).not.toBeChecked();
        await expect(b.page.getByText(`Ticked: everyone in commons-${n} (2 people) who is stuck on this reads it at once, with your name.`)).toBeVisible();
        await expect(b.page.locator('legend', { hasText: 'Match in' })).toBeVisible();
        await expect(b.page.getByText(`Ticked: someone in commons-${n} (2 people) you don't know may ask you for an intro.`)).toBeHidden();
        await check(b, `commons-share-${tag}.png`);
        await ticked.check();
        expect((await b.click(b.page.getByRole('button', { name: 'Share', exact: true }))).status()).toBe(200);
        await expect(b.page.getByRole('heading', { name: 'Shared.' })).toBeVisible();

        // Carol, in no circle yet, opens the short link and joins.
        const c = await person(browser, relay, 'Carol', import.meta.filename, relay.loginLink(carol), { ...options, member: false });
        people.push(c);
        expect((await c.open(link)).status()).toBe(200);
        expect(c.page.url()).toBe(`${relay.base}/ui/join/${token}`);
        await expect(c.page.getByRole('heading', { name: `Join commons-${n}` })).toBeVisible();
        await expect(c.page.getByText('Alice')).toHaveCount(0);
        await check(c, `commons-join-${tag}.png`);
        expect((await c.click(c.page.getByRole('button', { name: 'Join', exact: true }))).status()).toBe(200);
        await expect(c.page.getByText(`You joined commons-${n}.`)).toBeVisible();

        // Her Home: Bob's link card, the host apart from the title, the circle it came through.
        klatsch.approveSip(carol, klatsch.draftSip(carol, { status: 'looking', tags: ['postgres'], summary: CAROL_TEXT }, 'cli').sipId, 'cli', undefined, [commons]);
        await c.open(`${relay.base}/ui`);
        const note = c.page.getByRole('listitem').filter({ hasText: BOB_TEXT });
        await expect(note.getByRole('link', { name: SOURCE.title })).toHaveAttribute('href', SOURCE.url);
        await expect(note.getByRole('link', { name: SOURCE.title })).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
        await expect(note.locator('.host')).toHaveText('use-the-index-luke.com');
        await expect(note.getByText(`postgres · commons-${n}`)).toBeVisible();
        await check(c, `commons-home-${tag}.png`);

        // Her Circle page: the owner, herself and a count, never Bob's name.
        await c.open(`${relay.base}/ui/circle`);
        await expect(c.page.getByText('1 other', { exact: true })).toBeVisible();
        await expect(c.page.getByText('Bob')).toHaveCount(0);
        await check(c, `commons-member-${tag}.png`);

        // Gizem turns it off: nobody new joins by link, everyone stays.
        await g.open(`${relay.base}/ui/circle`);
        expect((await g.click(g.page.getByRole('button', { name: 'Turn off' }))).status()).toBe(200);
        await expect(g.page.getByText('Off: nobody new can join by link. Everyone who joined stays.')).toBeVisible();
        expect(klatsch.memberRole(carol, commons)).toBe('member');
      });
    }
  }

  test('no CSP violations, and every post came from the page', async () => {
    for (const p of people) await p.expectCleanBrowser();
  });
});
