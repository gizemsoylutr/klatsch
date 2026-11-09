// The whole Klatsch story: Alice's agent shares what she is stuck on and asks for an intro; Bob, who
// solved it long ago, accepts in his browser; only then do they see each other's names, and only there.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, CODE, startRelay, type Browser, type Relay } from './harness.ts';

const ALICE_TEXT = 'Paging in my Node.js API on Postgres returns every row at once.';
const BOB_TEXT = 'Cursor paging in a Node.js API on Postgres: use a keyset cursor on (created_at, id) and return next_cursor instead of OFFSET.';

describe('share and intro: Alice asks, Bob accepts, names are exchanged in the browsers only', () => {
  let relay: Relay;
  let alice: string, bob: string;
  let aliceBrowser: Browser, bobBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>, bobAgent: Awaited<ReturnType<typeof agent>>;
  let alicePage = '';
  let bobPage = { status: 0, html: '' };
  let introId = '';

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    const circle = relay.klatsch.ensureCircle('demo', alice);
    relay.klatsch.addMember(circle, bob, alice);
    const solved = relay.klatsch.draftSip(bob, { status: 'solved', tags: ['nodejs', 'express', 'pagination'], summary: BOB_TEXT }, 'cli');
    relay.klatsch.approveSip(bob, solved.sipId, 'cli');
  });
  after(async () => {
    await Promise.all([aliceAgent?.close(), bobAgent?.close()]);
    await relay.close();
  });

  it('each person signs in to their own browser through a one-time login link', async () => {
    const aliceLink = relay.loginLink(alice);
    assert.ok(aliceLink.startsWith(`${relay.base}/ui/login?t=`));
    aliceBrowser = await browser(relay, aliceLink);
    bobBrowser = await browser(relay, relay.loginLink(bob));
    assert.equal(aliceBrowser.loginStatus, 303);
    assert.match((await aliceBrowser.get('/ui')).html, /<h1>Hi, Alice\. /);
    assert.equal((await fetch(aliceLink, { redirect: 'manual' })).status, 401, 'the link works once');
  });

  it("Alice's agent shares what she is stuck on and asks for help; she reads the exact sip and approves in the same call", async () => {
    aliceAgent = await agent(relay, relay.agentToken(alice), {
      onPage: async (url) => {
        const approvalId = new URL(url).pathname.split('/').at(-1)!;
        alicePage = (await aliceBrowser.get(`/ui/approvals/${approvalId}`)).html;
        await aliceBrowser.post(`/ui/approvals/${approvalId}/decide`, { decision: 'approved' });
      },
    });
    const shared = await aliceAgent.call('update_card', { status: 'looking', tags: ['pagination', 'express'], summary: ALICE_TEXT });
    assert.equal(aliceAgent.dialogs.length, 1);
    assert.ok(aliceAgent.dialogs[0]!.url?.startsWith(`${relay.base}/ui/approvals/`), 'the client is asked to open the approval page');
    assert.ok(alicePage.includes(ALICE_TEXT), 'the page shows exactly what will be shared');
    assert.equal(shared.data.state, 'shared', 'the agent gets the outcome in the same call');
    assert.equal(shared.data.note, 'Your human shared it on the approval page, and intro requests went to whoever solved it.');
    assert.equal(shared.data.approve_url, undefined, 'decided, so no page to send her to');
    assert.equal(shared.data.intros?.length, 1, 'one intro request goes to whoever solved it');
    assert.doesNotMatch(shared.raw, CODE, 'the agent never sees the approval code');
  });

  it("Bob's agent hears about it before his next prompt (the reminder hook text)", async () => {
    bobAgent = await agent(relay, relay.agentToken(bob), {
      onPage: async (url) => {
        const approvalId = new URL(url).pathname.split('/').at(-1)!;
        bobPage = await bobBrowser.get(`/ui/approvals/${approvalId}`);
        await bobBrowser.post(`/ui/approvals/${approvalId}/decide`, { decision: 'approved' });
      },
    });
    const reminder = await bobAgent.call('pending');
    assert.match(reminder.text, /^Klatsch notice for your human: 1 intro request waiting for your human\. Start your reply with one short sentence/);
  });

  it("Bob's inbox has the intro request, with neither Alice's name nor her text", async () => {
    const inbox = await bobAgent.call('inbox');
    const request = inbox.data.events.find((e: { kind: string }) => e.kind === 'intro.requested');
    assert.ok(request);
    introId = request.ref;
    assert.doesNotMatch(inbox.raw, /Alice|alice/);
    assert.ok(!inbox.raw.includes(ALICE_TEXT));
  });

  it('Bob reads what she is stuck on, not who she is, and accepts in his browser', async () => {
    const answered = await bobAgent.call('respond_intro', { intro_id: introId });
    assert.equal(bobPage.status, 200);
    assert.ok(bobPage.html.includes(ALICE_TEXT), "the page shows Alice's sip");
    assert.doesNotMatch(bobPage.html, /Alice/, '…but not her name');
    assert.equal(answered.data.state, 'accepted', 'the agent learns only the outcome');
    assert.equal(
      answered.data.note,
      "Your human accepted it on the approval page. You're connected with @alice. You can talk directly; their name and sip are on your human's Klatsch page, not here.",
      'the second round of this call tells what Bob just did, not that it was already accepted',
    );
    assert.equal(answered.data.approve_url, undefined);
    assert.doesNotMatch(answered.raw, /Alice/);
    assert.ok(!answered.raw.includes(ALICE_TEXT));
  });

  it('both people now see each other, in their browsers only', async () => {
    const alicesUi = (await aliceBrowser.get('/ui')).html;
    const bobsUi = (await bobBrowser.get('/ui')).html;
    assert.match(alicesUi, /<span class="t">Bob<\/span> <span class="m">@bob<\/span>/);
    assert.ok(alicesUi.includes(BOB_TEXT), "Alice reads Bob's solution");
    assert.match(bobsUi, /<span class="t">Alice<\/span> <span class="m">@alice<\/span>/);
  });

  it("Alice's agent hears the intro was accepted and Bob's handle, never his name or text", async () => {
    const reminder = (await aliceAgent.call('pending')).text;
    assert.match(reminder, /1 accepted intro \(connected with @bob\)/);
    const inbox = await aliceAgent.call('inbox');
    const accepted = inbox.data.events.find((e: { kind: string }) => e.kind === 'intro.accepted');
    assert.equal(accepted.with, '@bob');
    assert.match(accepted.text, /You're connected with @bob\. You can talk directly/);
    assert.doesNotMatch((reminder + inbox.raw).replaceAll('@bob', ''), /Bob|bob/, 'the handle, and nothing else about him');
    assert.ok(!inbox.raw.includes(BOB_TEXT));
    assert.equal((await aliceAgent.call('pending')).text, '', 'the reminder is empty once everything was read');
  });

  it('notifications to the people carry no content', () => {
    assert.ok(relay.notifications.length > 0);
    for (const n of relay.notifications) assert.doesNotMatch(n.split(': ')[1] ?? '', /nodejs|express|paging|Alice|Bob/i);
  });
});
