// The layout in both engines, light and dark: the main column is centered and width-limited on a wide
// screen, nothing scrolls sideways on a phone, and a screenshot of each main page for every combination.
// The relay offers GitHub sign-in (a stand-in), so the landing and sign-in pages show their GitHub variant.
import { expect, test } from '@playwright/test';
import { createApproval } from '../../src/auth/approvals.ts';
import { createToken } from '../../src/auth/tokens.ts';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { fakeGitHub, type FakeGitHub } from '../github-fake.ts';
import { person, type Person } from './people.ts';

const SOLVED = 'Cursor paging in a Node.js API on Postgres: use a keyset cursor on (created_at, id) and return next_cursor instead of OFFSET.';
const LOOKING = 'Paging in my Node.js API on Postgres returns every row at once.';
const FLAGGED = 'The batch job on prod-erp.acme.internal times out after a long export of every sales order.';

test.describe.serial('layout: centered on a wide screen, no sideways scroll on a phone, light and dark', () => {
  let relay: Relay;
  let github: FakeGitHub;
  let bob: string;
  const pages: Record<string, string> = {};
  const people: Person[] = [];
  /** One intro Bob accepts on the approval page per screen size and scheme: the connected notice and the Sent page. */
  const toAccept: string[] = [];

  test.beforeAll(async () => {
    github = await fakeGitHub();
    relay = await startRelay({ github: (base) => github.app(base) });
    const { klatsch, db, secret } = relay;
    const alice = klatsch.ensureUser('alice', 'Alice');
    bob = klatsch.ensureUser('bob', 'Bob');
    klatsch.addMember(klatsch.ensureCircle('demo', alice), bob, alice);
    klatsch.approveSip(bob, klatsch.draftSip(bob, { status: 'solved', tags: ['nodejs', 'express'], summary: SOLVED }, 'cli').sipId, 'cli');
    klatsch.approveSip(alice, klatsch.draftSip(alice, { status: 'looking', tags: ['nodejs', 'express'], summary: LOOKING }, 'cli').sipId, 'cli');
    klatsch.draftSip(bob, { status: 'looking', tags: ['express'], summary: FLAGGED }, 'cli');
    const matchId = (db.prepare('SELECT id FROM matches').get() as { id: string }).id;
    const { introId } = klatsch.requestIntro(alice, matchId);
    const share = createApproval(db, secret, bob, 'share_sip', { status: 'looking', tags: JSON.stringify(['express']), summary: FLAGGED, ask_for_intro: 'true' });
    const answer = createApproval(db, secret, bob, 'answer_intro', { intro_id: introId });
    // One intro already accepted (the dashboard's Accepted row) and four for Bob to accept on the page.
    for (const [index, tag] of ['django', 'react', 'aws', 'redis', 'docker'].entries()) {
      klatsch.approveSip(bob, klatsch.draftSip(bob, { status: 'solved', tags: [tag], summary: `${SOLVED} (${tag})` }, 'cli').sipId, 'cli');
      klatsch.approveSip(alice, klatsch.draftSip(alice, { status: 'looking', tags: [tag], summary: `${LOOKING} (${tag})` }, 'cli').sipId, 'cli');
      const match = (db.prepare(`SELECT id FROM matches WHERE tags LIKE ?`).get(`%"${tag}"%`) as { id: string }).id;
      const intro = klatsch.requestIntro(alice, match).introId;
      if (index === 0) klatsch.approveIntro(bob, intro);
      else toAccept.push(createApproval(db, secret, bob, 'answer_intro', { intro_id: intro }).approval.id);
    }
    // One more intro, allowed always, and Alice's notes always sent to Bob's agent: both lists on his Settings page.
    klatsch.approveSip(bob, klatsch.draftSip(bob, { status: 'solved', tags: ['go'], summary: `${SOLVED} (go)` }, 'cli').sipId, 'cli');
    klatsch.approveSip(alice, klatsch.draftSip(alice, { status: 'looking', tags: ['go'], summary: `${LOOKING} (go)` }, 'cli').sipId, 'cli');
    const always = klatsch.requestIntro(alice, (db.prepare(`SELECT id FROM matches WHERE tags LIKE '%"go"%'`).get() as { id: string }).id).introId;
    klatsch.approveIntro(bob, always, 'web', true);
    klatsch.sendQuote(bob, always, true);
    // Notes open to Bob on his dashboard: Alice's (already sent to his agent) and Carol's (with "Always send").
    const carol = klatsch.ensureUser('carol', 'Carol');
    klatsch.addMember(klatsch.ensureCircle('demo', alice), carol, alice);
    klatsch.approveSip(bob, klatsch.draftSip(bob, { status: 'looking', tags: ['postgres'], summary: `${LOOKING} (postgres)` }, 'cli').sipId, 'cli');
    for (const who of [alice, carol]) {
      klatsch.approveSip(who, klatsch.draftSip(who, { status: 'solved', tags: ['postgres'], summary: `${SOLVED} (postgres)`, visibility: 'open' }, 'cli').sipId, 'cli');
    }
    // Tokens: one a connect made for a project (client and folder name), one made on the web, one revoked.
    createToken(db, secret, bob, { ttlDays: 7, label: 'dir:/home/bob/shop-api', agent: { clients: ['claude', 'codex'], project: 'shop-api' } });
    createToken(db, secret, bob, { ttlDays: 7, label: 'web:2026-11-01' });
    const revoked = createToken(db, secret, bob, { ttlDays: 7, label: 'web:2026-10-30' });
    db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ?').run(Date.now(), revoked.tokenId);
    const shareSolved = createApproval(db, secret, bob, 'share_sip', { status: 'solved', tags: JSON.stringify(['express']), summary: SOLVED, ask_for_intro: 'false', visibility: 'open' });
    Object.assign(pages, {
      landing: '/',
      dashboard: '/ui',
      approval: `/ui/approvals/${share.approval.id}`,
      'approval-solved': `/ui/approvals/${shareSolved.approval.id}`,
      intro: `/ui/approvals/${answer.approval.id}`,
      device: '/ui/device',
      circle: '/ui/circle',
      tokens: '/ui/tokens?client=codex',
      settings: '/ui/settings',
    });
  });
  test.afterAll(async () => {
    await Promise.all(people.map((p) => p.context.close()));
    await relay.close();
    await github.close();
  });

  /** The column each page centres, and how wide it may be: the landing's, a tab's, or a sheet. */
  const column = (name: string): [string, number] =>
    name === 'landing' ? ['.wrap', 1080] : ['dashboard', 'circle', 'tokens', 'settings'].includes(name) ? ['main.page', 980] : ['.sheet', 420];

  /** Centered and width-limited at 1280px (the sign-in page's two halves fill it); no sideways scroll at 390px. */
  const checkLayout = async (p: Person, name: string, width: 1280 | 390, colorScheme: string) => {
    // Home and People & invites are the messenger across the whole screen: nothing to centre there.
    if (width === 1280 && name !== 'sign-in' && name !== 'dashboard' && name !== 'circle') {
      const [selector, max] = column(name);
      const box = (await p.page.locator(selector).first().boundingBox())!;
      const viewport = await p.page.evaluate<number>('document.documentElement.clientWidth');
      expect(box.width, `${name}: width`).toBeLessThanOrEqual(max);
      expect(Math.abs(box.x - (viewport - box.x - box.width)), `${name}: centered`).toBeLessThanOrEqual(1);
    } else {
      // A string, not a function: this project's TypeScript has no DOM types.
      const [scroll, client] = await p.page.evaluate<[number, number]>('[document.documentElement.scrollWidth, document.documentElement.clientWidth]');
      expect(scroll, `${name}: horizontal scroll`).toBeLessThanOrEqual(client);
    }
    await p.shot(`layout-${name}-${colorScheme}-${width}.png`);
  };

  for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [1280, 390] as const) {
      const what = width === 1280 ? "every page's main column is centered and no wider than its design" : 'no page scrolls sideways';
      test(`on a ${width}px screen (${colorScheme}), ${what}`, async ({ browser }) => {
        // Signed out first: the sign-in page a visitor gets.
        const visitor = await person(browser, relay, 'Visitor', import.meta.filename, undefined, { colorScheme, viewport: { width, height: width === 1280 ? 900 : 844 } });
        people.push(visitor);
        expect((await visitor.open(`${relay.base}/ui`)).status()).toBe(401);
        await expect(visitor.page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
        await checkLayout(visitor, 'sign-in', width, colorScheme);
        const p = await person(browser, relay, 'Bob', import.meta.filename, relay.loginLink(bob), { colorScheme, viewport: { width, height: width === 1280 ? 900 : 844 } });
        people.push(p);
        for (const [name, path] of Object.entries(pages)) {
          expect((await p.open(`${relay.base}${path}`)).status(), name).toBe(200);
          await checkLayout(p, name, width, colorScheme);
        }
        // Bob accepts an intro on its page (the connected notice), then sends Alice's sip to his agent.
        expect((await p.open(`${relay.base}/ui/approvals/${toAccept.shift()}`)).status()).toBe(200);
        expect((await p.click(p.page.getByRole('button', { name: 'Allow once' }))).status()).toBe(200);
        await expect(p.page.getByText(/Visible until .* UTC, then only the names stay\./)).toBeVisible();
        await checkLayout(p, 'connected', width, colorScheme);
        expect((await p.click(p.page.getByRole('button', { name: 'Send to my agent' }))).status()).toBe(200);
        await checkLayout(p, 'sent', width, colorScheme);
      });
    }
  }

  test('no CSP violations', async () => {
    for (const p of people) await p.expectCleanBrowser();
  });
});
