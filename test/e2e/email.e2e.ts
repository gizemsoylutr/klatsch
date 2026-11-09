// Email notifications: Alice saves an address in the web UI, gets one confirmation mail, confirms it
// in her browser, and only then do notifications reach her by mail, without any content.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, personAt, startRelay, type Browser, type Relay } from './harness.ts';

const ADDRESS = 'alice@example.test';

describe('email: confirm an address in the browser, then content-free notifications', () => {
  let relay: Relay;
  let aliceBrowser: Browser, bobBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>, bobAgent: Awaited<ReturnType<typeof agent>>;
  let confirmToken = '';
  /** Bob shares a solution on a tag Alice is looking for, which tells her about a new match. */
  const bobSolves = async (tag: string) => {
    const shared = await bobAgent.call('update_card', { status: 'solved', tags: [tag], summary: `Solved ${tag} with Acme paging.` });
    assert.equal(shared.data.state, 'shared');
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  before(async () => {
    relay = await startRelay({ mail: true });
    const alice = relay.klatsch.ensureUser('alice', 'Alice');
    const bob = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', alice), bob, alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobBrowser = await browser(relay, relay.loginLink(bob));
    aliceAgent = await agent(relay, relay.agentToken(alice), personAt(aliceBrowser, 'approved'));
    bobAgent = await agent(relay, relay.agentToken(bob), personAt(bobBrowser, 'approved'));
    const looking = await aliceAgent.call('update_card', { status: 'looking', tags: ['nodejs', 'express', 'javascript'], summary: 'Paging in Express.', ask_for_intro: false });
    assert.equal(looking.data.state, 'shared');
  });
  after(async () => {
    await Promise.all([aliceAgent?.close(), bobAgent?.close()]);
    await relay.close();
  });

  it('Alice saves her address in the web UI; it is not confirmed yet', async () => {
    assert.equal((await aliceBrowser.post('/ui/email', { email: ADDRESS })).status, 303);
    assert.match((await aliceBrowser.get('/ui/settings')).html, /not confirmed yet/);
  });

  it('one confirmation mail goes to that address: a fixed sentence and the link', async () => {
    assert.equal(await relay.mailCount(1), 1);
    const mail = relay.mails[0]!;
    assert.equal(mail.to[0]!.address, ADDRESS);
    assert.equal(mail.subject, 'Klatsch: confirm your email address');
    confirmToken = mail.text.match(/\/ui\/email\/confirm\/([\w-]+)/)?.[1] ?? '';
    assert.ok(mail.text.endsWith(`${relay.base}/ui/email/confirm/${confirmToken}\n`));
  });

  it('a notification before confirmation sends no mail', async () => {
    await bobSolves('nodejs');
    await settle();
    assert.ok(relay.notifications.includes('@alice: ☕ Someone in your circle has solved this before.'));
    assert.equal(relay.mails.length, 1);
  });

  it("the link does nothing in another person's browser", async () => {
    const foreign = await bobBrowser.get(`/ui/email/confirm/${confirmToken}`);
    assert.equal(foreign.status, 404);
    assert.ok(!foreign.html.includes(ADDRESS));
    assert.equal((await bobBrowser.post(`/ui/email/confirm/${confirmToken}`)).status, 404);
  });

  it('Alice opens the link in her browser, sees the address, and confirms it', async () => {
    const shown = await aliceBrowser.get(`/ui/email/confirm/${confirmToken}`);
    assert.equal(shown.status, 200);
    assert.ok(shown.html.includes(ADDRESS));
    const confirmed = await aliceBrowser.post(`/ui/email/confirm/${confirmToken}`);
    assert.equal(confirmed.status, 200);
    assert.match(confirmed.html, /Confirmed\./);
    assert.match((await aliceBrowser.get('/ui/settings')).html, /Your address is confirmed/);
    assert.equal((await aliceBrowser.post(`/ui/email/confirm/${confirmToken}`)).status, 404, 'the link works once');
  });

  it('the next notification arrives by mail and carries no content', async () => {
    await bobSolves('express');
    assert.equal(await relay.mailCount(2), 2);
    const mail = relay.mails[1]!;
    assert.equal(mail.to[0]!.address, ADDRESS);
    assert.equal(mail.subject, 'Klatsch: something new');
    assert.equal(mail.text, `☕ Someone in your circle has solved this before.\n\n${relay.base}/ui\n`);
    assert.doesNotMatch(mail.text, /Bob|express|Acme|paging/i);
  });

  it('Alice turns email notifications off; nothing more is mailed', async () => {
    assert.equal((await aliceBrowser.post('/ui/notifications/email', { on: '0' })).status, 303);
    assert.match((await aliceBrowser.get('/ui/settings')).html, /role="switch" aria-checked="false"/);
    const notified = relay.notifications.length;
    await bobSolves('javascript');
    await settle();
    assert.equal(relay.notifications.at(notified), '@alice: ☕ Someone in your circle has solved this before.', 'she was notified');
    assert.equal(relay.mails.length, 2, '…but not by mail');
  });
});
