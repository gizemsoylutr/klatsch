// Bob's note asks first. Alice and Carol both ask for an intro: Bob allows Alice once, on the page his
// agent opened, and Carol always, on his dashboard. His next note is open to Carol at once and still
// asks for Alice. Alice chooses to always get Bob's notes; Bob revokes Carol's "always" in Settings.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, startRelay, type Browser, type Relay } from './harness.ts';

const BOB_TEXT = 'Cursor paging in a Node.js API on Postgres: use a keyset cursor on (created_at, id) and return next_cursor instead of OFFSET.';
const BOB_LATER = 'For a total count with paging in Postgres, run a separate COUNT query, not one per page.';

describe('ask me first: Bob allows one intro once and another always, per person', () => {
  let relay: Relay;
  let alice = '', bob = '', carol = '';
  let aliceBrowser: Browser, bobBrowser: Browser, carolBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>, bobAgent: Awaited<ReturnType<typeof agent>>;
  let aliceIntro = '', carolIntro = '';
  let bobPage = '';

  before(async () => {
    relay = await startRelay();
    const { klatsch } = relay;
    alice = klatsch.ensureUser('alice', 'Alice');
    bob = klatsch.ensureUser('bob', 'Bob');
    carol = klatsch.ensureUser('carol', 'Carol');
    const circle = klatsch.ensureCircle('demo', alice);
    klatsch.addMember(circle, bob, alice);
    klatsch.addMember(circle, carol, alice);
    for (const [who, text] of [
      [alice, 'Paging in my Node.js API on Postgres returns every row at once.'],
      [carol, 'My React list page loads every row.'],
    ] as const) {
      klatsch.approveSip(who, klatsch.draftSip(who, { status: 'looking', tags: ['pagination', 'express'], summary: text }, 'cli').sipId, 'cli');
    }
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobBrowser = await browser(relay, relay.loginLink(bob));
    carolBrowser = await browser(relay, relay.loginLink(carol));
    const onPage = (person: Browser, form: Record<string, string>) => async (url: string) => {
      const approvalId = new URL(url).pathname.split('/').at(-1)!;
      if (person === bobBrowser) bobPage = (await person.get(`/ui/approvals/${approvalId}`)).html;
      await person.post(`/ui/approvals/${approvalId}/decide`, form);
    };
    aliceAgent = await agent(relay, relay.agentToken(alice), { onPage: onPage(aliceBrowser, { decision: 'approved' }) });
    // Bob's choice of who reads his note counts only where there is one (the share); on an intro it is "Allow once".
    bobAgent = await agent(relay, relay.agentToken(bob), { onPage: onPage(bobBrowser, { decision: 'approved', visibility: 'ask' }) });
  });
  after(async () => {
    await Promise.all([aliceAgent?.close(), bobAgent?.close()]);
    await relay.close();
  });

  it('Bob shares a solved note and picks "Ask me first" on the approval page', async () => {
    const shared = await bobAgent.call('update_card', { status: 'solved', tags: ['pagination', 'express'], summary: BOB_TEXT, visibility: 'ask' });
    assert.equal(shared.data.state, 'shared');
    assert.match(bobPage, /value="ask" checked/, "his agent's proposal is preselected");
    assert.equal((relay.db.prepare('SELECT visibility, summary FROM sips').all() as { visibility: string; summary: string }[]).find((sip) => sip.summary === BOB_TEXT)?.visibility, 'ask');
  });

  it("Alice's agent finds a match without a handle and asks for an intro; Carol asks too", async () => {
    const found = await aliceAgent.call('find_matches', { tags: ['pagination'] });
    assert.equal(found.data.matches[0].from, undefined, 'who solved it stays unknown');
    aliceIntro = (await aliceAgent.call('request_intro', { match_id: found.data.matches[0].match_id })).data.intro_id;
    const match = (relay.db.prepare('SELECT id FROM matches WHERE seeker_id = ?').get(carol) as { id: string }).id;
    carolIntro = relay.klatsch.requestIntro(carol, match).introId;
    assert.ok(aliceIntro && carolIntro);
  });

  it('on the page his agent opens for Alice\'s intro, Bob reads what "Allow always" means and clicks "Allow once"', async () => {
    const answered = await bobAgent.call('respond_intro', { intro_id: aliceIntro });
    assert.equal(answered.data.state, 'accepted');
    assert.match(bobPage, /Allow once[\s\S]*Allow always[\s\S]*They also see the notes you share from now on with these tags in demo, without asking you\. Revoke any time in Settings\./);
    assert.doesNotMatch(bobPage, /Alice|alice/, 'who asks stays unknown until he allows it');
  });

  it("on his dashboard, Bob clicks \"Allow always\" for Carol's intro", async () => {
    const dashboard = (await bobBrowser.get('/ui')).html;
    assert.match(dashboard, new RegExp(`action="/ui/intros/${carolIntro}/allow-always"`));
    assert.equal((await bobBrowser.post(`/ui/intros/${carolIntro}/allow-always`)).status, 303);
    assert.match((await carolBrowser.get('/ui')).html, /Bob<\/span> <span class="m">@bob<\/span>/);
  });

  it("Bob's next note asks first: Carol reads it at once, Alice does not, and Bob is not asked", async () => {
    const wakes = () => (relay.db.prepare('SELECT count(*) AS n FROM events WHERE user_id = ? AND wakes = 1').get(bob) as { n: number }).n;
    const before = wakes();
    relay.klatsch.approveSip(bob, relay.klatsch.draftSip(bob, { status: 'solved', tags: ['express'], summary: BOB_LATER, visibility: 'ask' }, 'cli').sipId, 'cli');
    const carolPage = (await carolBrowser.get('/ui')).html;
    assert.match(carolPage, /Notes from your circle <em>solved, open to you · 1<\/em>/, 'only what he shares after allowing it');
    const notes = carolPage.slice(carolPage.indexOf('Notes from your circle'), carolPage.indexOf('Your card'));
    assert.ok(!notes.includes(BOB_TEXT), 'his earlier note is on her page only through their intro');
    assert.ok(carolPage.includes(BOB_LATER));
    assert.ok(!(await aliceBrowser.get('/ui')).html.includes(BOB_LATER), 'allowed once is once');
    assert.equal(wakes(), before, 'nothing for Bob to answer');
  });

  it(`Alice clicks "Always send @bob's notes to my agent" on her accepted intro; her agent gets his note now`, async () => {
    const dashboard = (await aliceBrowser.get('/ui')).html;
    assert.match(dashboard, new RegExp(`action="/ui/intros/${aliceIntro}/send-always"[\\s\\S]*?Always send @bob&#39;s notes to my agent`));
    assert.equal((await aliceBrowser.post(`/ui/intros/${aliceIntro}/send-always`)).status, 200);
    const quote = (await aliceAgent.call('inbox')).data.events.find((e: { type?: string }) => e.type === 'quote');
    assert.equal(quote.quote, BOB_TEXT);
    assert.match((await aliceBrowser.get('/ui')).html, /@bob&#39;s notes that match what you are looking for reach your agent without asking you\./);
  });

  it("Bob revokes Carol's \"always\" in Settings; his later note stops being open to her", async () => {
    const settings = (await bobBrowser.get('/ui/settings')).html;
    assert.match(settings, /Who reads your notes without asking[\s\S]*Carol \(@carol\)/);
    const grantId = settings.match(/action="\/ui\/grants\/([\w-]+)\/revoke"/)![1]!;
    assert.equal((await bobBrowser.post(`/ui/grants/${grantId}/revoke`)).status, 303);
    assert.ok(!(await carolBrowser.get('/ui')).html.includes(BOB_LATER));
    assert.match((await bobBrowser.get('/ui/settings')).html, /Who reads your notes without asking[\s\S]*Nobody\./);
  });
});
