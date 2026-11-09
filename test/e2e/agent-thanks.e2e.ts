// Bob sends Alice's open note to his agent with Send once. The fix works, so his agent says thanks: Alice's
// count goes to 1, numbers only. Bob sees "Your agent thanked Alice" on Home and takes it back with Undo; the
// count drops to 0 and his agent cannot thank for that note again. With the switch off in Settings, the agent
// is refused plainly.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, startRelay, type Browser, type Relay } from './harness.ts';

const ALICE_OPEN = 'Cursor paging in a Node.js API on Postgres: use a keyset cursor on (created_at, id) and return next_cursor instead of OFFSET.';
const ALICE_LATER = 'For a total count with paging on Postgres, run one COUNT query per list, not one per page.';
const BOB_TEXT = 'Paging in my Node.js API on Postgres returns every row at once.';

describe("agent thanks: Bob's agent thanks Alice for the note that fixed his problem; Bob sees it on Home and takes it back", () => {
  let relay: Relay;
  let alice = '', bob = '';
  let aliceBrowser: Browser, bobBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>, bobAgent: Awaited<ReturnType<typeof agent>>;
  let sipId = '', laterId = '', quoteId = '', laterQuote = '';

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', alice), bob, alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobBrowser = await browser(relay, relay.loginLink(bob));
    const decide = (person: Browser) => async (url: string) => {
      await person.post(`${new URL(url).pathname}/decide`, { decision: 'approved', visibility: 'open' });
    };
    aliceAgent = await agent(relay, relay.agentToken(alice), { onPage: decide(aliceBrowser) });
    bobAgent = await agent(relay, relay.agentToken(bob), { onPage: decide(bobBrowser) });
  });
  after(async () => {
    await Promise.all([aliceAgent?.close(), bobAgent?.close()]);
    await relay.close();
  });

  it("Alice's agent shares two solved notes open to the circle; Bob's agent shares what he is stuck on", async () => {
    sipId = (await aliceAgent.call('update_card', { status: 'solved', tags: ['pagination'], summary: ALICE_OPEN })).data.sip_id;
    laterId = (await aliceAgent.call('update_card', { status: 'solved', tags: ['pagination'], summary: ALICE_LATER })).data.sip_id;
    const shared = await bobAgent.call('update_card', { status: 'looking', tags: ['pagination'], summary: BOB_TEXT, ask_for_intro: false });
    assert.equal(shared.data.state, 'shared');
  });

  it("Bob sends Alice's note to his agent with Send once; his agent reads the quote in its inbox", async () => {
    assert.equal((await bobBrowser.post(`/ui/notes/${sipId}/send`)).status, 200);
    const inbox = await bobAgent.call('inbox');
    const quote = inbox.data.events.find((e: { type?: string }) => e.type === 'quote');
    assert.equal(quote.quote, ALICE_OPEN);
    quoteId = quote.ref;
  });

  it("Bob's agent calls thank_note once the fix worked; Alice's Home says her notes helped 1 person, with no names", async () => {
    const thanked = await bobAgent.call('thank_note', { quote_id: quoteId });
    assert.equal(thanked.data.state, 'thanked');
    assert.doesNotMatch(thanked.raw, /Alice|helped/);
    const page = (await aliceBrowser.get('/ui')).html;
    assert.match(page, /Your notes helped 1 person this month\./);
    assert.doesNotMatch(page, /Bob|Your agent thanked/);
  });

  it('a second call changes nothing: the agent hears it already thanked', async () => {
    assert.equal((await bobAgent.call('thank_note', { quote_id: quoteId })).data.state, 'already-thanked');
    assert.equal((relay.db.prepare('SELECT count(*) AS n FROM thanks').get() as { n: number }).n, 1);
  });

  it('Bob sees "Your agent thanked Alice" with Undo on his page, and Thanked on the note', async () => {
    const page = (await bobBrowser.get('/ui')).html;
    assert.match(page, /Your agent thanked Alice<\/span>[\s\S]*>Undo<\/button>/);
    assert.match(page, new RegExp(`action="/ui/notes/${sipId}/send"[\\s\\S]*<span class="thanked">`));
  });

  it("Bob clicks Undo: the thanks is gone and Alice's count is back to 0", async () => {
    const id = (relay.db.prepare('SELECT id FROM thanks').get() as { id: string }).id;
    assert.equal((await bobBrowser.post(`/ui/thanks/${id}/undo`)).status, 303);
    assert.doesNotMatch((await bobBrowser.get('/ui')).html, /Your agent thanked/);
    assert.doesNotMatch((await aliceBrowser.get('/ui')).html, /Your notes helped/);
    assert.match((await aliceBrowser.get('/ui/settings')).html, /Your notes helped 0 people/);
  });

  it("Bob's agent cannot thank for that note again", async () => {
    const again = await bobAgent.call('thank_note', { quote_id: quoteId });
    assert.equal(again.isError, true);
    assert.match(again.data.message, /Your human took back the thanks for this note, so it is not given again\./);
    assert.equal((relay.db.prepare('SELECT count(*) AS n FROM thanks').get() as { n: number }).n, 0);
  });

  it('Bob turns agent thanks off in Settings; his agent is refused plainly for the next note', async () => {
    assert.match((await bobBrowser.get('/ui/settings')).html, /Let my agent say thanks when a note fixed the problem<\/span><span class="m">On\./);
    assert.equal((await bobBrowser.post('/ui/settings/agent-thanks', { on: '0' })).status, 303);
    assert.equal((await bobBrowser.post(`/ui/notes/${laterId}/send`)).status, 200);
    laterQuote = (await bobAgent.call('inbox')).data.events.find((e: { type?: string }) => e.type === 'quote').ref;
    const off = await bobAgent.call('thank_note', { quote_id: laterQuote });
    assert.equal(off.isError, true);
    assert.match(off.data.message, /Your human turned off thanks from their agent in Klatsch Settings\./);
  });

  it('Bob turns it on again; his agent thanks Alice for the next note', async () => {
    assert.equal((await bobBrowser.post('/ui/settings/agent-thanks', { on: '1' })).status, 303);
    assert.equal((await bobAgent.call('thank_note', { quote_id: laterQuote })).data.state, 'thanked');
    assert.match((await aliceBrowser.get('/ui')).html, /Your notes helped 1 person this month\./);
  });
});
