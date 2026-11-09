import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTransport } from 'nodemailer';
import { createInvite } from '../src/auth/invites.ts';
import { createLoginLink, readSession, startSession } from '../src/auth/web-sessions.ts';
import { mailboxOf } from '../src/auth/email-logins.ts';
import { confirmationMailer, emailFromEnv, emailNotifier, mailFailure, signInMailer, smtpUrlFromEnv, type MailTransport } from '../src/notify/email.ts';
import { BASE, setup } from './helpers.ts';

type T = ReturnType<typeof setup>;
const SENT_PAGE = /If that address is confirmed on a Klatsch account, we sent a sign-in code and link\. Enter the code here, or open the link\. Both work once, for 10 minutes\./;

/** A relay with SMTP: sign-in links land in `sent`, "someone signed in" notices in `notices`, instead of a mailbox. */
function withMail(config: Parameters<typeof setup>[0] = {}) {
  const sent: { to: string; link: string; code: string }[] = [];
  const notices: { to: string; settings: string }[] = [];
  const t = setup({
    ...config,
    signInMailer: { link: (to, link, code) => void sent.push({ to, link, code }), notice: (to, settings) => void notices.push({ to, settings }) },
  });
  return { ...t, sent, notices };
}

/** The mail decision runs after the answer; this lets it run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));
const userCount = (t: T) => (t.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
const pathOf = (link: string) => new URL(link).pathname;

/**
 * A browser without a session: keeps cookies and the last form token, posts with the relay's Origin. Hosted
 * (`base` on https), `from` is the address the proxy saw.
 */
function visitor(t: T, { base = BASE, from }: { base?: string; from?: string } = {}) {
  const jar = new Map<string, string>();
  let csrf = '';
  let network = from;
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set('Cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
    if (network) headers.set('X-Forwarded-For', network);
    const response = await t.app.request(`${base}${path}`, { ...init, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = cookie.split(';');
      const [name = '', value = ''] = pair.split('=');
      if (!value || attributes.some((a) => /^\s*max-age=0$/i.test(a))) jar.delete(name);
      else jar.set(name, value);
    }
    const html = await response.text();
    csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? csrf;
    return { status: response.status, html, location: response.headers.get('location') };
  };
  const post = (path: string, form: Record<string, string> = {}, headers: Record<string, string> = { Origin: base }) =>
    request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ csrf, ...form }).toString() });
  /** Opens the sign-in page (at `page`, /ui by default) and asks for a link for `email`. */
  const ask = async (email: string, page = '/ui') => {
    await request(page);
    return post('/ui/auth/email', { email });
  };
  /** Moves this browser to another network. */
  const moveTo = (address: string) => void (network = address);
  return { request, post, ask, jar, moveTo };
}

describe('sign in by email: without SMTP', () => {
  it('shows no email field and has no email sign-in routes', async () => {
    const t = setup();
    const page = await t.app.request(`${BASE}/ui`);
    assert.equal(page.status, 401);
    assert.doesNotMatch(await page.text(), /<input type="email"|Email me a sign-in link/);
    assert.equal((await t.app.request(`${BASE}/ui/auth/email`, { method: 'POST', headers: { Origin: BASE } })).status, 404);
    assert.equal((await t.app.request(`${BASE}/ui/auth/email/abc`)).status, 404);
    assert.equal((await t.app.request(`${BASE}/ui/auth/email/abc`, { method: 'POST', headers: { Origin: BASE } })).status, 404);
    assert.equal((await t.app.request(`${BASE}/ui/auth/email/join`, { method: 'POST', headers: { Origin: BASE } })).status, 404);
  });
});

describe('sign in by email', () => {
  it('shows "Email me a sign-in link" on the sign-in page, with a form token bound to a host-only cookie', async () => {
    const t = withMail();
    const v = visitor(t);
    const page = await v.request('/ui');
    assert.equal(page.status, 401);
    assert.match(page.html, /<form class="mail" method="post" action="\/ui\/auth\/email">/);
    assert.match(page.html, /<input type="email" name="email"[^>]*aria-label="Your email address"/);
    assert.match(page.html, /<button class="primary">Email me a sign-in link<\/button>/);
    assert.ok(v.jar.has('klatsch_form'));
  });

  it('answers every address with the same page, and mails only a person whose confirmed address it is, in lower case', async () => {
    const t = withMail();
    t.klatsch.setVerifiedEmail(t.alice, 'Alice@Example.org', 'cli');
    t.klatsch.setEmail(t.bob, 'bob@example.org');
    const pages: string[] = [];
    for (const email of ['  ALICE@example.ORG ', 'nobody@example.org', 'bob@example.org', 'not an address']) {
      const v = visitor(t);
      const answer = await v.ask(email);
      // Each browser's form token is its own; everything else must match.
      pages.push(`${answer.status} ${answer.html.replace(/name="csrf" value="[^"]+"/g, 'name="csrf" value="…"')}`);
    }
    assert.match(pages[0]!, SENT_PAGE);
    assert.ok(pages.every((p) => p === pages[0]), 'known, unknown, unconfirmed and invalid addresses get the same page');
    assert.match(pages[0]!, /<form method="post" action="\/ui\/auth\/email\/code">/, 'every page has the code box');
    assert.match(pages[0]!, /<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="\\d\{3\} \?\\d\{3\}" maxlength="7" required/);
    assert.match(pages[0]!, /<a class="button" href="https:\/\/mail\.google\.com\/mail\/u\/0\/#inbox" target="_blank" rel="noopener noreferrer">Open Gmail/);
    assert.match(pages[0]!, /<a class="button" href="https:\/\/outlook\.live\.com\/mail\/" target="_blank" rel="noopener noreferrer">Open Outlook/);
    assert.match(pages[0]!, /New here\? Nothing is sent to a new address until you open an invite or join link/, 'a browser from no invite is told how to join');
    await settle();
    assert.deepEqual(
      t.sent.map((s) => s.to),
      ['alice@example.org'],
    );
    assert.match(t.sent[0]!.link, /^http:\/\/127\.0\.0\.1:7417\/ui\/auth\/email\/[\w-]{43}$/);
    const stored = JSON.stringify(t.db.prepare('SELECT * FROM email_logins').all());
    assert.ok(!stored.includes(pathOf(t.sent[0]!.link).split('/').at(-1)!), 'only a keyed hash of the token is stored');
  });

  it('refuses a post from another site or without the form token, and sends nothing', async () => {
    const t = withMail();
    t.klatsch.setVerifiedEmail(t.alice, 'alice@example.org', 'cli');
    const v = visitor(t);
    await v.request('/ui');
    assert.equal((await v.post('/ui/auth/email', { email: 'alice@example.org' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await v.post('/ui/auth/email', { email: 'alice@example.org' }, {})).status, 403);
    assert.equal((await v.post('/ui/auth/email', { email: 'alice@example.org', csrf: 'forged' })).status, 403);
    const fresh = visitor(t);
    assert.equal((await fresh.post('/ui/auth/email', { email: 'alice@example.org' })).status, 403, 'no cookie, no form token');
    await settle();
    assert.equal(t.sent.length, 0);
  });

  it('opening the link only shows a confirm page; the Sign in post uses it, once', async () => {
    const t = withMail();
    t.klatsch.setVerifiedEmail(t.alice, 'alice@example.org', 'cli');
    await visitor(t).ask('alice@example.org');
    await settle();
    const path = pathOf(t.sent[0]!.link);
    // A mail scanner fetches the link first: that changes nothing.
    assert.equal((await t.app.request(`${BASE}${path}`)).status, 200);
    const dana = visitor(t);
    const shown = await dana.request(path);
    assert.equal(shown.status, 200);
    assert.match(shown.html, /<button class="primary">Sign in as alice@example\.org<\/button>/);
    assert.match(shown.html, new RegExp(`<form method="post" action="${path}">`));
    const signedIn = await dana.post(path);
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.location, '/ui');
    assert.match((await dana.request('/ui')).html, /Hi, Alice/);
    assert.equal((await visitor(t).request(path)).status, 404, 'used up');
    assert.equal((await dana.post(path, { csrf: shown.html.match(/name="csrf" value="([^"]+)"/)![1]! })).status, 404);
    assert.match(t.db.prepare(`SELECT action FROM audit WHERE action = 'email.signin'`).get()!.action as string, /email\.signin/);
  });

  it('the code from the mail signs in, typed in the browser that asked; it and the link then work no more', async () => {
    const t = withMail();
    t.klatsch.setVerifiedEmail(t.alice, 'alice@example.org', 'cli');
    const laptop = visitor(t);
    await laptop.ask('alice@example.org');
    await settle();
    const { code, link } = t.sent[0]!;
    assert.match(code, /^\d{6}$/);
    const stored = JSON.stringify(t.db.prepare('SELECT * FROM email_logins').all());
    assert.ok(!stored.includes(`"${code}"`), 'only a keyed hash of the code is stored');
    const signedIn = await laptop.post('/ui/auth/email/code', { code: `${code.slice(0, 3)} ${code.slice(3)}` });
    assert.equal(signedIn.status, 303, 'a space in the middle is fine');
    assert.equal(signedIn.location, '/ui');
    assert.match((await laptop.request('/ui')).html, /Hi, Alice/);
    assert.equal((await visitor(t).request(pathOf(link))).status, 404, 'the link is used up with it');
    const again = visitor(t);
    await again.ask('alice@example.org');
    assert.equal((await again.post('/ui/auth/email/code', { code })).status, 400, 'an old code is no new one');
  });

  it('a used link takes its code with it, and a code typed in another browser finds nothing', async () => {
    const t = withMail();
    t.klatsch.setVerifiedEmail(t.alice, 'alice@example.org', 'cli');
    const laptop = visitor(t);
    await laptop.ask('alice@example.org');
    await settle();
    const { code, link } = t.sent[0]!;
    const phone = visitor(t);
    await phone.request('/ui');
    const elsewhere = await phone.post('/ui/auth/email/code', { code });
    assert.equal(elsewhere.status, 400);
    assert.match(elsewhere.html, /That code did not work/);
    assert.match(elsewhere.html, /action="\/ui\/auth\/email\/code"/, 'the page offers the box again');
    await phone.request(pathOf(link));
    assert.equal((await phone.post(pathOf(link))).status, 303, 'the link still works anywhere');
    assert.equal((await laptop.post('/ui/auth/email/code', { code })).status, 400, 'the code went with the link');
  });

  it('five wrong codes end the link and its code; only the newest link of a browser is tried; codes expire', async () => {
    const t = withMail();
    t.klatsch.setVerifiedEmail(t.alice, 'alice@example.org', 'cli');
    const laptop = visitor(t);
    await laptop.ask('alice@example.org');
    await settle();
    const { code, link } = t.sent[0]!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await laptop.post('/ui/auth/email/code', { code: wrong })).status, 400);
    assert.equal((await laptop.post('/ui/auth/email/code', { code })).status, 400, 'dead after five wrong codes');
    assert.equal((await visitor(t).request(pathOf(link))).status, 404, 'its link too');
    for (const junk of ['', '12345', '1234567', 'abcdef']) assert.equal((await laptop.post('/ui/auth/email/code', { code: junk })).status, 400);

    // Two links for one browser: the older code does nothing, the newer one signs in.
    const twice = visitor(t);
    await twice.ask('alice@example.org');
    await settle();
    await twice.ask('alice@example.org');
    await settle();
    const [older, newer] = [t.sent[1]!.code, t.sent[2]!.code];
    if (older !== newer) assert.equal((await twice.post('/ui/auth/email/code', { code: older })).status, 400);
    t.db.prepare('UPDATE email_logins SET expires_at = ?').run(Date.now() - 1);
    assert.equal((await twice.post('/ui/auth/email/code', { code: newer })).status, 400, 'expired');
  });

  it('a code is refused from another site or without the form token, and limited per browser and per network', async () => {
    const HOSTED = 'https://klatsch.example';
    const t = withMail({ config: { publicUrl: HOSTED, host: '0.0.0.0' } });
    t.klatsch.setVerifiedEmail(t.alice, 'alice@example.org', 'cli');
    const v = visitor(t, { base: HOSTED, from: '198.51.100.1' });
    await v.ask('alice@example.org');
    await settle();
    const { code } = t.sent[0]!;
    assert.equal((await v.post('/ui/auth/email/code', { code }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await v.post('/ui/auth/email/code', { code, csrf: 'forged' })).status, 403);
    // One browser hopping networks: twenty codes an hour, then the busy page.
    const hopper = visitor(t, { base: HOSTED, from: '203.0.113.1' });
    await hopper.request('/ui');
    for (let i = 0; i < 20; i++) {
      hopper.moveTo(`203.0.113.${i + 1}`);
      assert.equal((await hopper.post('/ui/auth/email/code', { code: '123456' })).status, 400);
    }
    hopper.moveTo('203.0.113.99');
    assert.equal((await hopper.post('/ui/auth/email/code', { code: '123456' })).status, 429, 'twenty codes an hour per browser');
    // Many browsers on one network: twenty an hour for the network.
    for (let i = 0; i < 20; i++) {
      const b = visitor(t, { base: HOSTED, from: '192.0.2.7' });
      await b.request('/ui');
      assert.equal((await b.post('/ui/auth/email/code', { code: '123456' })).status, 400);
    }
    const last = visitor(t, { base: HOSTED, from: '192.0.2.7' });
    await last.request('/ui');
    assert.equal((await last.post('/ui/auth/email/code', { code: '123456' })).status, 429, 'twenty codes an hour per network');
    assert.equal((await v.post('/ui/auth/email/code', { code })).status, 303, 'the person who asked still signs in');
  });

  it('an address that got nothing gets the same page and any code fails the same way', async () => {
    const t = withMail();
    const v = visitor(t);
    const page = await v.ask('nobody@example.org');
    assert.match(page.html, /action="\/ui\/auth\/email\/code"/);
    await settle();
    assert.equal(t.sent.length, 0);
    const tried = await v.post('/ui/auth/email/code', { code: '123456' });
    assert.equal(tried.status, 400);
    assert.match(tried.html, /That code did not work/);
  });

  it('a link is refused from another site and after ten minutes', async () => {
    const t = withMail();
    t.klatsch.setVerifiedEmail(t.alice, 'alice@example.org', 'cli');
    await visitor(t).ask('alice@example.org');
    await settle();
    const path = pathOf(t.sent[0]!.link);
    const v = visitor(t);
    await v.request(path);
    assert.equal((await v.post(path, {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await v.post(path, { csrf: 'forged' })).status, 403);
    t.db.prepare('UPDATE email_logins SET expires_at = ?').run(Date.now() - 1);
    assert.equal((await v.request(path)).status, 404);
    assert.equal((await v.post(path)).status, 404);
    assert.doesNotMatch((await v.request('/ui')).html, /Hi, Alice/);
  });

  it('signs in whoever has the address when the link is used: a changed address signs nobody in', async () => {
    const t = withMail();
    t.klatsch.setVerifiedEmail(t.alice, 'alice@example.org', 'cli');
    await visitor(t).ask('alice@example.org');
    await settle();
    t.klatsch.setEmail(t.alice, 'alice@new.example');
    const v = visitor(t);
    await v.request(pathOf(t.sent[0]!.link));
    assert.equal((await v.post(pathOf(t.sent[0]!.link))).status, 404);
  });

  it('sends nothing for an address two people have confirmed', async () => {
    const t = withMail();
    t.klatsch.setVerifiedEmail(t.alice, 'shared@example.org', 'cli');
    t.klatsch.setVerifiedEmail(t.bob, 'Shared@example.org', 'cli');
    assert.match((await visitor(t).ask('shared@example.org')).html, SENT_PAGE);
    await settle();
    assert.equal(t.sent.length, 0);
  });

  describe('limits, all behind the same page', () => {
    const HOSTED = 'https://klatsch.example';
    const hosted = () => {
      const t = withMail({ config: { publicUrl: HOSTED, host: '0.0.0.0' } });
      t.klatsch.setVerifiedEmail(t.alice, 'alice@example.org', 'cli');
      t.klatsch.setVerifiedEmail(t.bob, 'bob@example.org', 'cli');
      let network = 0;
      /** Asks in `browser` (a new one by default), from `from` (a network of its own by default). */
      const ask = async (email: string, { browser = visitor(t, { base: HOSTED, from: `198.51.100.${++network % 250}` }), page = '/ui' } = {}) => {
        const answer = await browser.ask(email, page);
        await settle();
        assert.match(answer.html, SENT_PAGE);
      };
      const sentTo = (email: string) => t.sent.filter((s) => s.to === email).length;
      const anHourLater = () => t.db.prepare('UPDATE email_logins SET created_at = created_at - 61 * 60 * 1000').run();
      const insert = (count: number, join?: { kind: string; ref: string }) => {
        const row = t.db.prepare('INSERT INTO email_logins (hash, email, nonce_hash, join_kind, join_ref, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (let i = 0; i < count; i++) row.run(`h${Math.random()}`, `x${i}@example.org`, 'n', join?.kind ?? null, join?.ref ?? null, Date.now(), Date.now() + 600_000);
      };
      /** A browser `userId` signed in with before (by a login link), then signed out of; known to the relay. */
      const knownBrowser = async (userId: string) => {
        const b = visitor(t, { base: HOSTED, from: `192.0.${2 + Math.floor(++network / 250)}.${network % 250}` });
        await b.request(new URL(createLoginLink(t.db, t.secret, userId, HOSTED)).pathname + new URL(createLoginLink(t.db, t.secret, userId, HOSTED)).search);
        b.jar.delete('klatsch_session');
        assert.ok(b.jar.has('__Host-klatsch_known'));
        return b;
      };
      return { t, ask, sentTo, anHourLater, insert, knownBrowser, browser: (from = '192.0.2.1') => visitor(t, { base: HOSTED, from }) };
    };

    it("3 an hour per address and asking browser: someone else asking for Alice's address does not use up hers", async () => {
      const { ask, sentTo, browser } = hosted();
      const attacker = browser('203.0.113.9');
      for (let i = 0; i < 4; i++) await ask('alice@example.org', { browser: attacker });
      assert.equal(sentTo('alice@example.org'), 3, "three for the attacker's browser");
      await ask('alice@example.org');
      assert.equal(sentTo('alice@example.org'), 4, "Alice's own browser still gets one");
    });

    it('8 an hour and 20 a day per address, whichever browsers ask', async () => {
      const { ask, sentTo, anHourLater } = hosted();
      for (let i = 0; i < 9; i++) await ask('alice@example.org');
      assert.equal(sentTo('alice@example.org'), 8, 'eight an hour');
      anHourLater();
      for (let i = 0; i < 9; i++) await ask('alice@example.org');
      anHourLater();
      for (let i = 0; i < 9; i++) await ask('alice@example.org');
      assert.equal(sentTo('alice@example.org'), 20, 'twenty a day');
    });

    it('10 requests an hour per network (IPv6 by /64), whatever addresses it types', async () => {
      const { ask, sentTo, browser } = hosted();
      for (let i = 0; i < 10; i++) await ask(`nobody${i}@example.org`, { browser: browser(`2001:db8:1:2::${i + 1}`) });
      await ask('bob@example.org', { browser: browser('2001:db8:1:2:ffff::9') });
      assert.equal(sentTo('bob@example.org'), 0, 'the network had its share');
      await ask('bob@example.org', { browser: browser('2001:db8:1:3::1') });
      assert.equal(sentTo('bob@example.org'), 1, 'another network still gets one');
    });

    it('links to new addresses have their own budget: 15 an hour per join link, so strangers asking from many networks cannot crowd out Alice', async () => {
      const { t, ask, sentTo, insert } = hosted();
      const token = t.klatsch.setJoinLink(t.alice, t.circle, true) as string;
      for (let n = 0; n < 100; n++) await ask(`victim${n}@stranger.example`, { page: `/ui/join/${token}` });
      assert.equal(t.sent.length, 15, 'fifteen an hour for one join link');
      await ask('alice@example.org');
      assert.equal(sentTo('alice@example.org'), 1, 'Alice still gets her link');
      // 60 a day for new addresses relay-wide, whatever link they come from.
      insert(45, { kind: 'invite', ref: 'inv_other' });
      const invite = createInvite(t.db, t.secret, t.circle, t.alice, HOSTED).link;
      await ask('one-more@stranger.example', { page: new URL(invite).pathname });
      assert.equal(sentTo('one-more@stranger.example'), 0, 'sixty a day for new addresses');
      await ask('bob@example.org');
      assert.equal(sentTo('bob@example.org'), 1);
    });

    it('links to people already here: 100 an hour and 250 a day for the relay, of which 20 and 50 only known browsers use; new addresses never use any', async () => {
      const { t, ask, sentTo, insert, anHourLater, knownBrowser } = hosted();
      const bobs = await knownBrowser(t.bob);
      insert(80);
      await ask('bob@example.org');
      assert.equal(sentTo('bob@example.org'), 0, 'eighty an hour from browsers the relay does not know');
      await ask('bob@example.org', { browser: bobs });
      assert.equal(sentTo('bob@example.org'), 1, "Bob's known browser uses the reserved share");
      const token = t.klatsch.setJoinLink(t.alice, t.circle, true) as string;
      await ask('newcomer@example.org', { page: `/ui/join/${token}` });
      assert.equal(sentTo('newcomer@example.org'), 1, 'a new address has its own budget');
      anHourLater();
      insert(79);
      await ask('alice@example.org');
      assert.equal(sentTo('alice@example.org'), 1);
      anHourLater();
      insert(39);
      await ask('alice@example.org');
      assert.equal(sentTo('alice@example.org'), 1, 'two hundred a day from unknown browsers');
      await ask('bob@example.org', { browser: bobs });
      assert.equal(sentTo('bob@example.org'), 2, 'the known browser still gets one, up to two hundred and fifty');
      anHourLater();
      insert(49);
      await ask('bob@example.org', { browser: bobs });
      assert.equal(sentTo('bob@example.org'), 2, 'two hundred and fifty a day in all');
    });

    it("strangers asking for Alice's address from fresh browsers fill its totals, but her known browser still gets her link", async () => {
      const { t, ask, sentTo, anHourLater, knownBrowser } = hosted();
      const alices = await knownBrowser(t.alice);
      for (let i = 0; i < 8; i++) await ask('alice@example.org');
      await ask('alice@example.org');
      assert.equal(sentTo('alice@example.org'), 8, 'a fresh browser of hers is held back');
      await ask('alice@example.org', { browser: alices });
      assert.equal(sentTo('alice@example.org'), 9, 'her known browser is not');
      for (let hour = 0; hour < 2; hour++) {
        anHourLater();
        for (let i = 0; i < 8; i++) await ask('alice@example.org');
      }
      assert.ok(sentTo('alice@example.org') >= 20);
      anHourLater();
      const before = sentTo('alice@example.org');
      await ask('alice@example.org');
      assert.equal(sentTo('alice@example.org'), before, 'twenty a day for unknown browsers');
      await ask('alice@example.org', { browser: alices });
      assert.equal(sentTo('alice@example.org'), before + 1, 'not for hers');
    });

    it('a person flooding their own address from their known browser (new form cookies, new networks) is capped at 5 an hour; Alice still gets her links', async () => {
      const { t, ask, sentTo, knownBrowser } = hosted();
      const bobs = await knownBrowser(t.bob);
      for (let i = 0; i < 400; i++) {
        for (const name of [...bobs.jar.keys()]) if (name !== '__Host-klatsch_known') bobs.jar.delete(name);
        bobs.moveTo(`2001:db8:0:${(256 + Math.floor(i / 10)).toString(16)}::1`);
        await ask('bob@example.org', { browser: bobs });
      }
      assert.ok(sentTo('bob@example.org') <= 5, `at most 5 an hour from known browsers, got ${sentTo('bob@example.org')}`);
      const known = (t.db.prepare("SELECT count(*) AS n FROM email_logins WHERE email = 'bob@example.org' AND known = 1").get() as { n: number }).n;
      assert.ok(known <= 5);
      await ask('alice@example.org');
      assert.equal(sentTo('alice@example.org'), 1, "Alice's fresh browser");
      await ask('alice@example.org', { browser: await knownBrowser(t.alice) });
      assert.equal(sentTo('alice@example.org'), 2, 'and her known one');
    });

    it('known browsers get at most 5 links an hour and 15 a day per address, however many sign-ins made them known', async () => {
      const { t, ask, sentTo, knownBrowser, anHourLater } = hosted();
      for (let i = 0; i < 6; i++) await ask('bob@example.org', { browser: await knownBrowser(t.bob) });
      assert.equal(sentTo('bob@example.org'), 5, 'five an hour');
      for (let hour = 0; hour < 3; hour++) {
        anHourLater();
        for (let i = 0; i < 5; i++) await ask('bob@example.org', { browser: await knownBrowser(t.bob) });
      }
      assert.equal(sentTo('bob@example.org'), 15, 'fifteen a day');
    });

    it('the known-browser cookie is signed for one person: copied to another address, or forged, it counts for nothing', async () => {
      const { t, ask, sentTo, knownBrowser } = hosted();
      const bobs = await knownBrowser(t.bob);
      for (let i = 0; i < 8; i++) await ask('alice@example.org');
      await ask('alice@example.org', { browser: bobs });
      assert.equal(sentTo('alice@example.org'), 8, "Bob's known browser is not Alice's");
      const forged = visitor(t, { base: HOSTED, from: '192.0.2.201' });
      forged.jar.set('__Host-klatsch_known', 'abc.def');
      await ask('alice@example.org', { browser: forged });
      assert.equal(sentTo('alice@example.org'), 8);
    });
  });

  it('at an invite, the code of a new address leads to the handle step in the browser that asked; nobody is made before Join', async () => {
    const t = withMail();
    const invite = createInvite(t.db, t.secret, t.circle, t.alice, BASE).link;
    const before = userCount(t);
    const v = visitor(t);
    await v.ask('dana@example.org', pathOf(invite));
    await settle();
    const join = await v.post('/ui/auth/email/code', { code: t.sent[0]!.code });
    assert.equal(join.status, 200);
    assert.match(join.html, /Pick your handle\./);
    assert.equal(userCount(t), before);
  });

  it('at an invite, a new address gets a link bound to that invite; the person is made only on Join, with the address confirmed', async () => {
    const t = withMail();
    const invite = createInvite(t.db, t.secret, t.circle, t.alice, BASE).link;
    const before = userCount(t);
    // Without an invite or join link, a new address gets nothing.
    await visitor(t).ask('dana@example.org');
    await settle();
    assert.equal(t.sent.length, 0);

    await visitor(t).ask('Dana@Example.org', pathOf(invite));
    await settle();
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0]!.to, 'dana@example.org');
    assert.ok(!t.sent[0]!.link.includes(pathOf(invite).split('/').at(-1)!), 'the mail does not carry the invite');
    const row = t.db.prepare('SELECT join_kind, join_ref FROM email_logins').get() as { join_kind: string; join_ref: string };
    assert.equal(row.join_kind, 'invite');
    assert.match(row.join_ref, /^inv_/, 'bound to the invite by id, not by its token');

    // Opened in another browser (her phone's mail app): the confirm page, then the join page with a handle field.
    const phone = visitor(t);
    const path = pathOf(t.sent[0]!.link);
    await phone.request(path);
    const join = await phone.post(path);
    assert.equal(join.status, 200);
    assert.match(join.html, /<strong>Alice<\/strong> \(@alice\) invites you to <strong>test<\/strong>/);
    assert.match(join.html, /<form method="post" action="\/ui\/auth\/email\/join">/);
    assert.match(join.html, /Pick your handle\./);
    assert.equal(userCount(t), before, 'nobody is made before Join');

    assert.equal((await phone.post('/ui/auth/email/join', { handle: 'bob' })).status, 409, 'a taken handle');
    assert.equal(userCount(t), before);
    assert.equal((await phone.post('/ui/auth/email/join', { handle: 'dana' }, { Origin: 'https://evil.example' })).status, 403);
    const joined = await phone.post('/ui/auth/email/join', { handle: 'Dana' });
    assert.equal(joined.status, 303);
    assert.equal(joined.location, '/ui');
    const dana = t.db.prepare('SELECT id, handle, display_name, email, email_verified_at FROM users WHERE handle = ?').get('dana') as {
      id: string;
      email: string;
      display_name: string;
      email_verified_at: number | null;
    };
    assert.equal(dana.email, 'dana@example.org');
    assert.ok(dana.email_verified_at !== null, 'confirmed by opening the link');
    assert.equal(dana.display_name, 'dana');
    assert.equal(t.klatsch.memberRole(dana.id, t.circle), 'member');
    assert.equal((await phone.post('/ui/auth/email/join', { handle: 'dana2' })).status, 404, 'the join step is used up');
    assert.match((await phone.request('/ui')).html, /Hi, dana/);
    assert.equal(userCount(t), before + 1);

    // Later she signs in by email like anyone with a confirmed address.
    await visitor(t).ask('dana@example.org');
    await settle();
    assert.equal(t.sent.length, 2);
    assert.equal(t.db.prepare('SELECT join_kind FROM email_logins WHERE email = ? ORDER BY created_at DESC').get('dana@example.org')!.join_kind, null);
  });

  it('a link bound to an invite used meanwhile makes nobody', async () => {
    const t = withMail();
    const invite = createInvite(t.db, t.secret, t.circle, t.alice, BASE).link;
    await visitor(t).ask('erin@example.org', pathOf(invite));
    await settle();
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    const carolBrowser = await t.human(carol);
    assert.equal((await carolBrowser.post(pathOf(invite))).status, 200, 'Carol joins with the invite first');
    const before = userCount(t);
    const v = visitor(t);
    await v.request(pathOf(t.sent[0]!.link));
    const answer = await v.post(pathOf(t.sent[0]!.link));
    assert.equal(answer.status, 404);
    assert.match(answer.html, /This invite is not valid\./);
    assert.equal(userCount(t), before);
  });

  it('at a public join link, a new address joins the circle', async () => {
    const t = withMail();
    const token = t.klatsch.setJoinLink(t.alice, t.circle, true) as string;
    await visitor(t).ask('frank@example.org', `/ui/join/${token}`);
    await settle();
    assert.equal(t.sent.length, 1);
    const v = visitor(t);
    await v.request(pathOf(t.sent[0]!.link));
    assert.match((await v.post(pathOf(t.sent[0]!.link))).html, /Pick your handle\./);
    assert.equal((await v.post('/ui/auth/email/join', { handle: 'frank' })).status, 303);
    const frank = t.klatsch.usersByEmail('frank@example.org')[0]!;
    assert.equal(t.klatsch.memberRole(frank, t.circle), 'member');
  });
});

describe('sign in by email: one mailbox, one person', () => {
  it('reads an address as the mailbox it reaches: lower case, no +tag, Gmail without dots', () => {
    assert.equal(mailboxOf(' Dana+Klatsch@Example.org '), 'dana@example.org');
    assert.equal(mailboxOf('d.a.n.a+x@googlemail.com'), 'dana@gmail.com');
    assert.equal(mailboxOf('d.ana@example.org'), 'd.ana@example.org', 'dots count outside Gmail');
  });

  /** Joins the public circle with a new address and returns the handle page's status, or undefined when no link came. */
  const joinPublicly = async (t: ReturnType<typeof withMail>, token: string, email: string, handle: string) => {
    const before = t.sent.length;
    await visitor(t).ask(email, `/ui/join/${token}`);
    await settle();
    if (t.sent.length === before) return undefined;
    const v = visitor(t);
    const path = pathOf(t.sent.at(-1)!.link);
    await v.request(path);
    await v.post(path);
    return (await v.post('/ui/auth/email/join', { handle })).status;
  };

  it('a +tag or Gmail-dot variant of an address someone has gets no link, and a removed person cannot come back with one', async () => {
    const t = withMail();
    const token = t.klatsch.setJoinLink(t.alice, t.circle, true) as string;
    assert.equal(await joinPublicly(t, token, 'mallory@example.org', 'mallory'), 303);
    const mallory = t.klatsch.usersByEmail('mallory@example.org')[0]!;
    t.klatsch.removeMember(t.alice, t.circle, mallory);
    assert.equal(await joinPublicly(t, token, 'Mallory+2@example.org', 'mallory2'), undefined, 'no link for a variant');
    t.klatsch.setVerifiedEmail(t.bob, 'bob.smith@gmail.com', 'cli');
    assert.equal(await joinPublicly(t, token, 'bobsmith+x@googlemail.com', 'bob2'), undefined);
    assert.equal(t.klatsch.memberRole(mallory, t.circle), undefined);
    assert.equal((t.db.prepare("SELECT count(*) AS n FROM users WHERE handle IN ('mallory2', 'bob2')").get() as { n: number }).n, 0);
  });

  it('a person removed from a public circle who clears their address cannot rejoin with it', async () => {
    const t = withMail();
    const token = t.klatsch.setJoinLink(t.alice, t.circle, true) as string;
    assert.equal(await joinPublicly(t, token, 'mallory@example.org', 'mallory'), 303);
    const mallory = t.klatsch.usersByEmail('mallory@example.org')[0]!;
    t.klatsch.removeMember(t.alice, t.circle, mallory);
    assert.equal(await joinPublicly(t, token, 'mallory+2@example.org', 'mallory2'), undefined);
    t.klatsch.setEmail(mallory, '');
    assert.equal(await joinPublicly(t, token, 'mallory@example.org', 'mallory3'), undefined, 'the removal sticks to the mailbox');
    assert.deepEqual(t.klatsch.usersByEmail('mallory@example.org'), []);
    // A link sent before the address was cleared makes nobody either.
    const t2 = withMail();
    const token2 = t2.klatsch.setJoinLink(t2.alice, t2.circle, true) as string;
    assert.equal(await joinPublicly(t2, token2, 'eve@example.org', 'eve'), 303);
    const eve = t2.klatsch.usersByEmail('eve@example.org')[0]!;
    t2.klatsch.setEmail(eve, '');
    await visitor(t2).ask('eve+late@example.org', `/ui/join/${token2}`);
    await settle();
    assert.equal(t2.sent.at(-1)!.to, 'eve+late@example.org', 'a link before the removal');
    t2.klatsch.removeMember(t2.alice, t2.circle, eve);
    const v = visitor(t2);
    const path = pathOf(t2.sent.at(-1)!.link);
    await v.request(path);
    await v.post(path);
    const before = userCount(t2);
    assert.equal((await v.post('/ui/auth/email/join', { handle: 'eve2' })).status, 409);
    assert.equal(userCount(t2), before);
  });

  it('keeps the mailbox history only as keyed hashes, filled again for every confirmed address when the relay starts', () => {
    const t = withMail();
    t.klatsch.setVerifiedEmail(t.alice, 'Alice+x@Example.org', 'cli');
    const rows = t.db.prepare('SELECT * FROM mailbox_history').all() as { user_id: string; mailbox_hash: string }[];
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.mailbox_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(rows).includes('alice@example.org'), 'never the mailbox in plain text');
    // An address confirmed before the history existed: in it once the relay starts with the secret.
    t.db.prepare('DELETE FROM mailbox_history').run();
    t.klatsch.useSecret(t.secret);
    assert.deepEqual(
      (t.db.prepare('SELECT mailbox_hash FROM mailbox_history').all() as { mailbox_hash: string }[]).map((r) => r.mailbox_hash),
      [rows[0]!.mailbox_hash],
    );
  });

  it('an invite its owner made after the removal still readmits the mailbox', async () => {
    const t = withMail();
    const token = t.klatsch.setJoinLink(t.alice, t.circle, true) as string;
    assert.equal(await joinPublicly(t, token, 'fay@example.org', 'fay'), 303);
    const fay = t.klatsch.usersByEmail('fay@example.org')[0]!;
    t.klatsch.removeMember(t.alice, t.circle, fay);
    t.klatsch.setEmail(fay, '');
    await new Promise((resolve) => setTimeout(resolve, 2));
    const invite = createInvite(t.db, t.secret, t.circle, t.alice, BASE).link;
    await visitor(t).ask('fay@example.org', pathOf(invite));
    await settle();
    assert.equal(t.sent.at(-1)!.to, 'fay@example.org');
  });

  it('a variant confirmed by someone else after the link was sent makes nobody on Join', async () => {
    const t = withMail();
    const token = t.klatsch.setJoinLink(t.alice, t.circle, true) as string;
    await visitor(t).ask('erin+a@example.org', `/ui/join/${token}`);
    await settle();
    t.klatsch.setVerifiedEmail(t.bob, 'erin@example.org', 'cli');
    const v = visitor(t);
    const path = pathOf(t.sent[0]!.link);
    await v.request(path);
    await v.post(path);
    const before = userCount(t);
    assert.equal((await v.post('/ui/auth/email/join', { handle: 'erin' })).status, 409);
    assert.equal(userCount(t), before);
  });
});

describe('sign in by email: around the link', () => {
  it('the confirm page warns when the link is opened in another browser than the one that asked', async () => {
    const t = withMail();
    t.klatsch.setVerifiedEmail(t.alice, 'alice@example.org', 'cli');
    const asker = visitor(t);
    await asker.ask('alice@example.org');
    await settle();
    const path = pathOf(t.sent[0]!.link);
    const warning = 'You asked for this link from another browser. Continue only if you did.';
    assert.ok(!(await asker.request(path)).html.includes(warning), 'none in the browser that asked');
    assert.ok((await visitor(t).request(path)).html.includes(warning));
  });

  it('after a sign-in by email, the person is notified, content-free, and the address gets a notice mail when notifications do not go there; at most one an hour', async () => {
    const t = withMail();
    t.klatsch.setVerifiedEmail(t.alice, 'alice@example.org', 'cli');
    t.klatsch.setVerifiedEmail(t.bob, 'bob@example.org', 'cli');
    t.klatsch.setEmailNotifications(t.alice, false);
    const signInBy = async (email: string) => {
      const v = visitor(t);
      await v.ask(email);
      await settle();
      const path = pathOf(t.sent.at(-1)!.link);
      await v.request(path);
      assert.equal((await v.post(path)).status, 303);
    };
    await signInBy('bob@example.org');
    assert.deepEqual(t.notices, [], "Bob's notifications go to his address already");
    assert.ok(t.notifications.includes('bob: Someone signed in to your Klatsch account by email. Not you? Change or remove your address in Settings.'));
    for (let i = 0; i < 2; i++) {
      await signInBy('alice@example.org');
    }
    assert.deepEqual(t.notices, [{ to: 'alice@example.org', settings: `${BASE}/ui/settings` }]);
    assert.equal(t.notifications.filter((n) => n.startsWith('alice: Someone signed in')).length, 1);
  });

  it('shows the address on the join page, and says so plainly after ten taken handles', async () => {
    const t = withMail();
    const invite = createInvite(t.db, t.secret, t.circle, t.alice, BASE).link;
    await visitor(t).ask('gina@example.org', pathOf(invite));
    await settle();
    const v = visitor(t);
    const path = pathOf(t.sent[0]!.link);
    await v.request(path);
    assert.match((await v.post(path)).html, /You join as <strong>gina@example\.org<\/strong>\. Pick your handle\./);
    let last = { status: 0, html: '' };
    for (let i = 0; i < 10; i++) last = await v.post('/ui/auth/email/join', { handle: 'alice' });
    assert.equal(last.status, 429);
    assert.match(last.html, /Ten handles were taken or not valid\. Ask for a new sign-in link to try again\./);
  });

  it('every page without a session sets its form cookie again, for twelve hours', async () => {
    const t = withMail();
    const first = await t.app.request(`${BASE}/ui`);
    const cookie = first.headers.getSetCookie().find((c) => c.startsWith('klatsch_form='))!;
    assert.match(cookie, /Max-Age=43200/);
    const again = await t.app.request(`${BASE}/ui`, { headers: { Cookie: cookie.split(';')[0]! } });
    assert.equal(again.headers.getSetCookie().find((c) => c.startsWith('klatsch_form='))!.split(';')[0], cookie.split(';')[0], 'the same value, a new expiry');
  });
});

describe('mail failures in the log', () => {
  it('name only the error code and the SMTP reply code, never the address or the reply text', async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.join(' '));
    try {
      const rejecting: MailTransport = {
        sendMail: async () => {
          throw Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.1 <dana@example.org>: Recipient address rejected"), {
            code: 'EENVELOPE',
            responseCode: 550,
            rejected: ['dana@example.org'],
          });
        },
      };
      signInMailer(rejecting, 'klatsch@relay.test').link('dana@example.org', `${BASE}/ui/auth/email/secret-token`, '024680');
      signInMailer(rejecting, 'klatsch@relay.test').notice('dana@example.org', `${BASE}/ui/settings`);
      confirmationMailer(rejecting, 'klatsch@relay.test')('dana@example.org', `${BASE}/ui/email/confirm/secret-token`);
      const t = setup();
      t.klatsch.setVerifiedEmail(t.alice, 'dana@example.org', 'cli');
      emailNotifier(t.db, rejecting, 'klatsch@relay.test', () => BASE)({ id: t.alice, handle: 'alice' }, 'Something new.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      console.error = original;
    }
    assert.deepEqual(logged, [
      '[klatsch] email sign-in link failed: EENVELOPE 550',
      '[klatsch] email sign-in notice failed: EENVELOPE 550',
      '[klatsch] email confirmation failed: EENVELOPE 550',
      '[klatsch] email notification to @alice failed: EENVELOPE 550',
    ]);
    assert.equal(mailFailure(new Error('dana@example.org')), 'error');
  });
});

describe('the sign-in mail', () => {
  it('has a fixed subject, the link, how long it works and to ignore it if unasked; plain text only, so no service rewrites the link', async () => {
    const json = createTransport({ jsonTransport: true });
    const sent: any[] = [];
    const transport: MailTransport = {
      async sendMail(message) {
        const info = await json.sendMail(message);
        sent.push(JSON.parse(info.message));
        return info;
      },
    };
    const link = `${BASE}/ui/auth/email/abc_DEF-123`;
    signInMailer(transport, 'klatsch@relay.test').link('dana@example.org', link, '049749');
    for (let i = 0; i < 100 && !sent.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const mail = sent[0]!;
    assert.equal(mail.from.address, 'klatsch@relay.test');
    assert.equal(mail.to[0].address, 'dana@example.org');
    assert.equal(mail.subject, 'Your Klatsch sign-in code: 049749', 'six digits in a row, so mail apps offer to copy them');
    assert.equal(
      mail.text,
      `Your sign-in code:\n\n049749\n\nIt works once, for 10 minutes, in the browser where you asked for it. Or open this link:\n\n${link}\n\nIf you didn't ask for it, ignore this mail.\n`,
    );
    assert.equal(mail.html, undefined, 'no HTML part');
    assert.equal(mail.headers['auto-submitted'] ?? mail.headers['Auto-Submitted'], 'auto-generated');

    signInMailer(transport, 'klatsch@relay.test').notice('dana@example.org', `${BASE}/ui/settings`);
    for (let i = 0; i < 100 && sent.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(sent[1].subject, 'Klatsch: new sign-in');
    assert.equal(
      sent[1].text,
      `Someone signed in to Klatsch with this address. If it wasn't you, open Settings and change or remove your address, so it no longer signs in, and tell the relay's operator.\n\n${BASE}/ui/settings\n`,
    );
    assert.equal(sent[1].html, undefined);
  });
});

describe('the SMTP URL from a file', () => {
  const URL_WITH_KEY = 'smtp://relay%40example.org:xsmtpsib-secret-key@smtp-relay.brevo.com:587';

  it('reads KLATSCH_SMTP_URL_FILE (a Docker secret), dropping one trailing newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klatsch-smtp-'));
    try {
      writeFileSync(join(dir, 'url'), `${URL_WITH_KEY}\n`);
      assert.equal(smtpUrlFromEnv({ KLATSCH_SMTP_URL_FILE: join(dir, 'url') }), URL_WITH_KEY);
      writeFileSync(join(dir, 'crlf'), `${URL_WITH_KEY}\r\n`);
      assert.equal(smtpUrlFromEnv({ KLATSCH_SMTP_URL_FILE: join(dir, 'crlf') }), URL_WITH_KEY);
      assert.equal(smtpUrlFromEnv({ KLATSCH_SMTP_URL: URL_WITH_KEY }), URL_WITH_KEY);
      assert.equal(smtpUrlFromEnv({}), undefined);
      const email = emailFromEnv({ KLATSCH_SMTP_URL_FILE: join(dir, 'url'), KLATSCH_MAIL_FROM: 'klatsch@relay.test' }, setup().db, () => BASE);
      assert.equal(typeof email?.signIn.link, 'function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses both at once, or a file it cannot read, without ever naming the URL', () => {
    const refusals = [
      { env: { KLATSCH_SMTP_URL: URL_WITH_KEY, KLATSCH_SMTP_URL_FILE: '/run/secrets/smtp_url' }, message: /Set KLATSCH_SMTP_URL or KLATSCH_SMTP_URL_FILE, not both\./ },
      { env: { KLATSCH_SMTP_URL_FILE: `/nonexistent/${URL_WITH_KEY}` }, message: /^KLATSCH_SMTP_URL_FILE cannot be read\.$/ },
    ];
    for (const { env, message } of refusals) {
      assert.throws(
        () => smtpUrlFromEnv(env),
        (error: Error) => message.test(error.message) && !error.message.includes('secret-key'),
      );
    }
  });
});

describe('web sessions', () => {
  it('renew for 30 days from use at most once a day, never past 90 days from sign-in', () => {
    const t = withMail();
    const { session } = startSession(t.db, t.secret, t.alice);
    const DAY = 24 * 60 * 60 * 1000;
    const row = () => t.db.prepare('SELECT created_at, expires_at FROM web_sessions').get() as { created_at: number; expires_at: number };
    assert.equal(row().expires_at - row().created_at, 30 * DAY);
    assert.equal(readSession(t.db, t.secret, session)?.expiresAt, undefined, 'not renewed within a day');
    t.db.prepare('UPDATE web_sessions SET created_at = created_at - ?, expires_at = expires_at - ?').run(10 * DAY, 10 * DAY);
    const renewed = readSession(t.db, t.secret, session)!;
    assert.ok(renewed.expiresAt && Math.abs(renewed.expiresAt - (Date.now() + 30 * DAY)) < 5000, '30 days from now');
    t.db.prepare('UPDATE web_sessions SET created_at = ?').run(Date.now() - 80 * DAY);
    t.db.prepare('UPDATE web_sessions SET expires_at = ?').run(Date.now() + DAY);
    assert.ok(Math.abs(readSession(t.db, t.secret, session)!.expiresAt! - (Date.now() + 10 * DAY)) < 5000, 'capped at 90 days from sign-in');
    t.db.prepare('UPDATE web_sessions SET expires_at = ?').run(Date.now() - 1);
    assert.equal(readSession(t.db, t.secret, session), undefined, 'an ended session stays ended');
  });
});
