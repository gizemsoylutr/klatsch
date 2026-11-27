// Sign in by email, for people without GitHub. Dana opens Gizem's invite signed out, asks for a sign-in link,
// opens it from her mail (where a scanner fetched it first), confirms, picks a handle and joins: she is made only
// then, with her address confirmed. Later she signs in again by email. Every request gets the same page, and an
// address nobody here has gets no mail without an invite.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createInvite } from '../../src/auth/invites.ts';
import { signedOutBrowser, startRelay, type Relay, type SignedOutBrowser } from './harness.ts';

const DANA = 'dana@example.org';
const SENT = 'If that address is confirmed on a Klatsch account, we sent a sign-in code and link. Enter the code here, or open the link. Both work once, for 10 minutes.';

const userCount = (relay: Relay) => (relay.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('sign in by email: a new person joins by invite with a mailed link, and signs in by email again later', () => {
  let relay: Relay;
  let gizem = '';
  let circle = '';
  let inviteLink = '';
  let laptop: SignedOutBrowser;
  let phone: SignedOutBrowser;
  let linkPath = '';
  let people = 0;

  before(async () => {
    relay = await startRelay({ mail: true });
    gizem = relay.klatsch.ensureUser('gizem', 'Gizem');
    circle = relay.klatsch.ensureCircle('demo', gizem);
    inviteLink = createInvite(relay.db, relay.secret, circle, gizem, relay.base).link;
    people = userCount(relay);
  });
  after(async () => {
    await relay.close();
  });

  it('Dana opens the invite link Gizem sent her, without a session: the sign-in page offers "Email me a sign-in link"', async () => {
    laptop = signedOutBrowser(relay);
    const page = await laptop.go(inviteLink, { headers: { 'Sec-Fetch-Site': 'none' } });
    assert.equal(page.status, 401);
    assert.match(page.html, /<form class="composer" method="post" action="\/ui\/auth\/email">/);
    assert.match(page.html, /<button class="primary send" aria-label="Email me a sign-in link">/);
    assert.doesNotMatch(page.html, /demo|Gizem/, 'nothing about the invite before signing in');
  });

  it('she types her address and gets the neutral page; one mail goes to her', async () => {
    const sent = await laptop.post('/ui/auth/email', { email: ' Dana@Example.org ' });
    assert.equal(sent.status, 200);
    assert.ok(sent.html.includes(SENT));
    assert.equal(await relay.mailCount(1), 1);
    assert.equal(relay.mails[0]!.to[0]!.address, DANA);
  });

  it('the mail carries the link, how long it works and to ignore it if unasked; plain text only, not the invite', () => {
    const mail = relay.mails[0]!;
    linkPath = mail.text.match(/\/ui\/auth\/email\/[\w-]+/)![0];
    const code = mail.text.match(/^(\d{6})$/m)![1]!;
    assert.equal(mail.subject, `Your Klatsch sign-in code: ${code}`);
    assert.equal(
      mail.text,
      `Your sign-in code:\n\n${code}\n\nIt works once, for 10 minutes, in the browser where you asked for it. Or open this link:\n\n${relay.base}${linkPath}\n\nIf you didn't ask for it, ignore this mail.\n`,
    );
    assert.equal(mail.html, undefined, 'no HTML part for a mail service to rewrite links in');
    assert.ok(!mail.text.includes(new URL(inviteLink).pathname.split('/').at(-1)!), 'the invite stays on the relay');
  });

  it('a mail scanner opening the link first uses nothing up', async () => {
    const scanned = await fetch(new URL(linkPath, relay.base));
    assert.equal(scanned.status, 200);
    assert.equal((await fetch(new URL(linkPath, relay.base))).status, 200);
  });

  it('she opens the link on her phone and sees "Sign in as dana@example.org", with a warning that she asked from another browser; nobody is made yet', async () => {
    phone = signedOutBrowser(relay);
    const token = linkPath.split('/').at(-1)!;
    const page = await phone.go(`/ui/auth/email/${token}`);
    assert.equal(page.status, 200);
    assert.match(page.html, /<button class="primary">Sign in as dana@example\.org<\/button>/);
    assert.match(page.html, /You asked for this link from another browser\. Continue only if you did\./);
    assert.equal(userCount(relay), people);
  });

  it('she confirms and is asked to pick a handle to join Gizem\'s circle; still nobody is made', async () => {
    const join = await phone.post(linkPath);
    assert.equal(join.status, 200);
    assert.match(join.html, /<strong>Gizem<\/strong> \(@gizem\) invites you to <strong>demo<\/strong>/);
    assert.match(join.html, /You join as <strong>dana@example\.org<\/strong>\. Pick your handle\./);
    assert.equal(userCount(relay), people);
  });

  it('she picks the handle gizem, which is taken, then dana, and clicks Join: she is made, in the circle, signed in', async () => {
    const taken = await phone.post('/ui/auth/email/join', { handle: 'gizem' });
    assert.equal(taken.status, 409);
    assert.match(taken.html, /That handle is taken or not valid/);
    const joined = await phone.post('/ui/auth/email/join', { handle: 'dana' });
    assert.equal(joined.status, 200);
    assert.equal(joined.url, `${relay.base}/ui`);
    assert.match(joined.html, /Hi, dana/);
    const dana = relay.klatsch.usersByEmail(DANA)[0]!;
    assert.equal(relay.klatsch.memberRole(dana, circle), 'member');
    assert.equal(userCount(relay), people + 1);
  });

  it('the link does not work twice', async () => {
    const again = signedOutBrowser(relay);
    assert.equal((await again.go(linkPath)).status, 404);
  });

  it('Settings shows her address, confirmed by the link she opened', async () => {
    const settings = await phone.go('/ui/settings');
    assert.ok(settings.html.includes(`value="${DANA}"`));
    assert.match(settings.html, /Your address is confirmed\. It is also a sign-in: anyone who can read its mail can sign in as you\./);
  });

  it('later, in a new browser, she asks for a link again and signs in as herself; nothing new is made', async () => {
    const later = signedOutBrowser(relay);
    await later.go('/ui');
    assert.ok((await later.post('/ui/auth/email', { email: DANA })).html.includes(SENT));
    assert.equal(await relay.mailCount(2), 2);
    const path = relay.mails[1]!.text.match(/\/ui\/auth\/email\/[\w-]+/)![0];
    const opened = await later.go(path);
    assert.doesNotMatch(opened.html, /another browser/, 'the browser that asked gets no warning');
    const home = await later.post(path);
    assert.equal(home.url, `${relay.base}/ui`);
    assert.match(home.html, /Hi, dana/);
    assert.equal(userCount(relay), people + 1);
  });

  it('she then hears, content-free, that someone signed in to her account by email: a notification, by mail to her address', async () => {
    assert.ok(relay.notifications.includes('@dana: Someone signed in to your Klatsch account by email. Not you? Change or remove your address in Settings.'));
    assert.equal(await relay.mailCount(3), 3);
    const mail = relay.mails[2]!;
    assert.equal(mail.to[0]!.address, DANA);
    assert.equal(mail.subject, 'Klatsch: something new');
    assert.equal(mail.text, `Someone signed in to your Klatsch account by email. Not you? Change or remove your address in Settings.\n\n${relay.base}/ui\n`);
    assert.equal(mail.html, undefined);
  });

  it('an address nobody here has, asked without an invite, gets the same page and no mail', async () => {
    const stranger = signedOutBrowser(relay);
    await stranger.go('/ui');
    assert.ok((await stranger.post('/ui/auth/email', { email: 'mallory@example.org' })).html.includes(SENT));
    await settle();
    assert.equal(relay.mails.length, 3);
  });

  it('she can also type the six-digit code from the mail instead: only in the browser that asked', async () => {
    const desk = signedOutBrowser(relay);
    await desk.go('/ui');
    const page = await desk.post('/ui/auth/email', { email: DANA });
    assert.match(page.html, /autocomplete="one-time-code"/);
    assert.match(page.html, /Open Gmail/);
    assert.match(page.html, /Open Outlook/);
    assert.equal(await relay.mailCount(4), 4);
    const code = relay.mails[3]!.text.match(/^(\d{6})$/m)![1]!;
    assert.equal(relay.mails[3]!.subject, `Your Klatsch sign-in code: ${code}`);
    const other = signedOutBrowser(relay);
    await other.go('/ui');
    assert.match((await other.post('/ui/auth/email/code', { code })).html, /That code did not work/, 'not in a browser that did not ask');
    const home = await desk.post('/ui/auth/email/code', { code: `${code.slice(0, 3)} ${code.slice(3)}` });
    assert.equal(home.url, `${relay.base}/ui`);
    assert.match(home.html, /Hi, dana/);
    assert.equal(userCount(relay), people + 1);
  });
});
