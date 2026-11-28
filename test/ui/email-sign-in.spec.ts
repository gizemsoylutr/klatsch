// Sign in by email in real browsers, on a relay with SMTP (a captured transport) and GitHub (a stand-in): Dana,
// without GitHub, opens Gizem's invite signed out, asks for a sign-in link, opens it, clicks "Sign in as …",
// picks a handle and joins; later she signs in by email again. The new pages in both schemes and both widths.
import { expect, test } from '@playwright/test';
import { createInvite } from '../../src/auth/invites.ts';
import { startRelay, type Relay } from '../e2e/harness.ts';
import { fakeGitHub, type FakeGitHub } from '../github-fake.ts';
import { person, type Person } from './people.ts';

const SENT = 'If that address is confirmed on a Klatsch account, we sent a sign-in code and link. Enter the code here, or open the link. Both work once, for 10 minutes.';

test.describe.serial('sign in by email: join by invite with a mailed link, sign in again by email, and the new pages in light and dark', () => {
  let github: FakeGitHub;
  let relay: Relay;
  let gizem = '';
  let circle = '';
  const people: Person[] = [];

  test.beforeAll(async () => {
    github = await fakeGitHub();
    relay = await startRelay({ mail: true, github: (base) => github.app(base) });
    gizem = relay.klatsch.ensureUser('gizem', 'Gizem');
    circle = relay.klatsch.ensureCircle('demo', gizem);
  });
  test.afterAll(async () => {
    await Promise.all(people.map((p) => p.context.close()));
    await relay.close();
    await github.close();
  });

  /** The link of the last mail to `address`, once it arrived. */
  const linkFor = async (address: string, count: number) => {
    expect(await relay.mailCount(count)).toBe(count);
    const mail = relay.mails.filter((m) => m.to[0]!.address === address).at(-1)!;
    return mail.text.match(/http:\/\/\S+\/ui\/auth\/email\/[\w-]+/)![0];
  };

  test('Dana opens the invite signed out, types her address, opens the mailed link, signs in, picks a handle and joins', async ({ browser }) => {
    const dana = await person(browser, relay, 'Dana', import.meta.filename);
    people.push(dana);
    expect((await dana.open(createInvite(relay.db, relay.secret, circle, gizem, relay.base).link)).status()).toBe(401);
    await expect(dana.page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
    await dana.page.getByText('Continue with Email').click();
    await dana.page.getByRole('textbox', { name: 'Your email address' }).fill('dana@example.org');
    await dana.shot('email-sign-in.png');
    const before = relay.mails.length;
    expect((await dana.click(dana.page.getByRole('button', { name: 'Email me a sign-in link' }))).status()).toBe(200);
    await expect(dana.page.getByText(SENT)).toBeVisible();
    const link = await linkFor('dana@example.org', before + 1);
    expect((await dana.open(link)).status()).toBe(200);
    expect((await dana.click(dana.page.getByRole('button', { name: 'Sign in as dana@example.org' }))).status()).toBe(200);
    await expect(dana.page.getByRole('region')).toContainText('Gizem (@gizem) invites you to demo.');
    await dana.page.getByRole('textbox', { name: 'Handle' }).fill('dana');
    expect((await dana.click(dana.page.getByRole('button', { name: 'Join' }))).status()).toBe(200);
    await expect(dana.page.getByRole('complementary', { name: 'Chats' })).toBeVisible();
    await dana.open(`${relay.base}/ui/settings`);
    await expect(dana.page.getByText('Your address is confirmed. It is also a sign-in')).toBeVisible();
  });

  /** The code of the last mail to `address`. */
  const codeFor = (address: string) => relay.mails.filter((m) => m.to[0]!.address === address).at(-1)!.text.match(/^(\d{6})$/m)![1]!;

  test('Dana types the code from the mail in the browser where she asked, with a space, and is in', async ({ browser }) => {
    const desk = await person(browser, relay, 'Dana', import.meta.filename);
    people.push(desk);
    expect((await desk.open(`${relay.base}/ui`)).status()).toBe(401);
    await desk.page.getByText('Continue with Email').click();
    await desk.page.getByRole('textbox', { name: 'Your email address' }).fill('dana@example.org');
    const before = relay.mails.length;
    await desk.click(desk.page.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await relay.mailCount(before + 1)).toBe(before + 1);
    const code = codeFor('dana@example.org');
    await desk.page.getByRole('textbox', { name: 'Sign-in code' }).fill(`${code.slice(0, 3)} ${code.slice(3)}`);
    await desk.shot('email-code.png');
    expect((await desk.click(desk.page.getByRole('button', { name: 'Sign in', exact: true }))).status()).toBe(200);
    expect(desk.page.url()).toBe(`${relay.base}/ui`);
    await expect(desk.page.getByRole('complementary', { name: 'Chats' })).toBeVisible();
  });

  test('later, in a new browser, Dana signs in by email again', async ({ browser }) => {
    const again = await person(browser, relay, 'Dana', import.meta.filename);
    people.push(again);
    expect((await again.open(`${relay.base}/ui`)).status()).toBe(401);
    await again.page.getByText('Continue with Email').click();
    await again.page.getByRole('textbox', { name: 'Your email address' }).fill('Dana@Example.org');
    const before = relay.mails.length;
    await again.click(again.page.getByRole('button', { name: 'Email me a sign-in link' }));
    const link = await linkFor('dana@example.org', before + 1);
    await again.open(link);
    expect((await again.click(again.page.getByRole('button', { name: 'Sign in as dana@example.org' }))).status()).toBe(200);
    expect(again.page.url()).toBe(`${relay.base}/ui`);
    await expect(again.page.getByRole('complementary', { name: 'Chats' })).toBeVisible();
  });

  /** No sideways scroll at 390px; at 1280px a sheet is centred and no wider than its design. */
  const checkLayout = async (p: Person, name: string, width: 1280 | 390, colorScheme: string) => {
    if (width === 1280 && name !== 'email-sign-in-page') {
      const box = (await p.page.locator('.sheet').first().boundingBox())!;
      const viewport = await p.page.evaluate<number>('document.documentElement.clientWidth');
      expect(box.width, `${name}: width`).toBeLessThanOrEqual(420);
      expect(Math.abs(box.x - (viewport - box.x - box.width)), `${name}: centered`).toBeLessThanOrEqual(1);
    } else {
      const [scroll, client] = await p.page.evaluate<[number, number]>('[document.documentElement.scrollWidth, document.documentElement.clientWidth]');
      expect(scroll, `${name}: horizontal scroll`).toBeLessThanOrEqual(client);
    }
    await p.shot(`layout-${name}-${colorScheme}-${width}.png`);
  };

  let next = 0;
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [1280, 390] as const) {
      test(`on a ${width}px screen (${colorScheme}): the sign-in page with the email field, the sent page, Sign in as, the handle to pick`, async ({ browser }) => {
        const id = next++;
        const address = `newcomer-with-a-long-address-${id}@example.org`;
        const p = await person(browser, relay, 'Newcomer', import.meta.filename, undefined, { colorScheme, viewport: { width, height: width === 1280 ? 900 : 844 } });
        people.push(p);
        expect((await p.open(createInvite(relay.db, relay.secret, circle, gizem, relay.base).link)).status()).toBe(401);
        await checkLayout(p, 'email-sign-in-page', width, colorScheme);
        await p.page.getByText('Continue with Email').click();
    await p.page.getByRole('textbox', { name: 'Your email address' }).fill(address);
        const before = relay.mails.length;
        await p.click(p.page.getByRole('button', { name: 'Email me a sign-in link' }));
        await expect(p.page.getByRole('textbox', { name: 'Sign-in code' })).toBeVisible();
        await expect(p.page.getByRole('link', { name: /Open Gmail/ })).toHaveAttribute('href', 'https://mail.google.com/mail/u/0/#inbox');
        await expect(p.page.getByRole('link', { name: /Open Outlook/ })).toHaveAttribute('href', 'https://outlook.live.com/mail/');
        await checkLayout(p, 'email-sent', width, colorScheme);
        const link = await linkFor(address, before + 1);
        const code = codeFor(address);
        await p.page.getByRole('textbox', { name: 'Sign-in code' }).fill(code === '000000' ? '111111' : '000000');
        expect((await p.click(p.page.getByRole('button', { name: 'Sign in', exact: true }))).status()).toBe(400);
        await expect(p.page.getByRole('heading', { level: 1, name: 'That code did not work' })).toBeVisible();
        await checkLayout(p, 'email-code-failed', width, colorScheme);
        await p.open(link);
        await checkLayout(p, 'email-confirm', width, colorScheme);
        await p.click(p.page.getByRole('button', { name: `Sign in as ${address}` }));
        await expect(p.page.getByText('Pick your handle.')).toBeVisible();
        await checkLayout(p, 'email-join', width, colorScheme);
        await p.page.getByRole('textbox', { name: 'Handle' }).fill(`newcomer-${id}`);
        expect((await p.click(p.page.getByRole('button', { name: 'Join' }))).status()).toBe(200);
      });
    }
  }

  test('no CSP violations, and every form post carried the page origin', async () => {
    for (const p of people) await p.expectCleanBrowser();
  });
});
