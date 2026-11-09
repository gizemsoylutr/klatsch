// Alice's open note helps Bob: he clicks Thanks on his page, and Alice sees, on her own pages only, that her
// notes helped one person, with no names. An intro they share can be thanked once too. Agents never see a
// count, and thank only for a note they received (see agent-thanks.e2e.ts). Alice turns on her public badge (a number only, at a random link) and off again.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, startRelay, type Browser, type Relay } from './harness.ts';

const ALICE_OPEN = 'Cursor paging in a Node.js API on Postgres: use a keyset cursor on (created_at, id) and return next_cursor instead of OFFSET.';
const ALICE_ASK = 'Counting rows for paging on Postgres: run one COUNT query per list, not one per page.';
const BOB_TEXT = 'Paging in my Node.js API on Postgres returns every row at once.';

describe('thanks: Bob thanks Alice for the note that helped him; only Alice sees a count, and a badge only if she turns it on', () => {
  let relay: Relay;
  let alice = '', bob = '';
  let aliceBrowser: Browser, bobBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>, bobAgent: Awaited<ReturnType<typeof agent>>;
  let visibility = 'open';
  let sipId = '', introId = '', badge = '';

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', alice), bob, alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobBrowser = await browser(relay, relay.loginLink(bob));
    const decide = (person: Browser, form: () => Record<string, string>) => async (url: string) => {
      await person.post(`${new URL(url).pathname}/decide`, form());
    };
    aliceAgent = await agent(relay, relay.agentToken(alice), { onPage: decide(aliceBrowser, () => ({ decision: 'approved', visibility })) });
    bobAgent = await agent(relay, relay.agentToken(bob), { onPage: decide(bobBrowser, () => ({ decision: 'approved' })) });
  });
  after(async () => {
    await Promise.all([aliceAgent?.close(), bobAgent?.close()]);
    await relay.close();
  });

  it("Alice's agent shares a solved note open to the circle, and one that asks first; Bob's agent shares what he is stuck on", async () => {
    sipId = (await aliceAgent.call('update_card', { status: 'solved', tags: ['pagination'], summary: ALICE_OPEN })).data.sip_id;
    visibility = 'ask';
    await aliceAgent.call('update_card', { status: 'solved', tags: ['postgres'], summary: ALICE_ASK });
    const shared = await bobAgent.call('update_card', { status: 'looking', tags: ['pagination', 'postgres'], summary: BOB_TEXT, ask_for_intro: true });
    assert.equal(shared.data.state, 'shared');
    assert.equal(shared.data.intros.length, 1, 'an intro request for the ask-first note');
    introId = shared.data.intros[0];
  });

  it("Bob's page shows Alice's open note with a Thanks button next to Send once", async () => {
    const page = (await bobBrowser.get('/ui')).html;
    assert.ok(page.includes(ALICE_OPEN));
    assert.match(page, new RegExp(`action="/ui/notes/${sipId}/send"[\\s\\S]*action="/ui/notes/${sipId}/thanks"`));
    assert.match(page, /Thanks tells the author it helped; they see a count, not names\./);
  });

  it('Bob clicks Thanks; the button turns into Thanked', async () => {
    const thanked = await bobBrowser.post(`/ui/notes/${sipId}/thanks`);
    assert.equal(thanked.status, 303);
    const page = (await bobBrowser.get('/ui')).html;
    assert.doesNotMatch(page, new RegExp(`action="/ui/notes/${sipId}/thanks"`));
    assert.match(page, /<span class="thanked">.*Thanked<\/span>/);
  });

  it('a second click changes nothing: Alice is thanked once', async () => {
    assert.equal((await bobBrowser.post(`/ui/notes/${sipId}/thanks`)).status, 303);
    assert.equal((relay.db.prepare('SELECT count(*) AS n FROM thanks').get() as { n: number }).n, 1);
  });

  it("Alice's Home says her notes helped 1 person this month, with no names", async () => {
    const page = (await aliceBrowser.get('/ui')).html;
    assert.match(page, /Your notes helped 1 person this month\.[\s\S]*1 since you joined · only you see this/);
    const strip = page.slice(page.indexOf('class="helped"'), page.indexOf('class="helped"') + 600);
    assert.doesNotMatch(strip, /Bob|bob/);
  });

  it('Alice allows the intro on her page; Bob thanks her on his Connected card, and she still counts one person', async () => {
    assert.equal((await aliceBrowser.post(`/ui/intros/${introId}/approve`)).status, 303);
    assert.match((await bobBrowser.get('/ui')).html, new RegExp(`action="/ui/intros/${introId}/thanks"`));
    assert.equal((await bobBrowser.post(`/ui/intros/${introId}/thanks`)).status, 303);
    assert.match((await aliceBrowser.get('/ui')).html, /Your notes helped 1 person this month\./);
  });

  it("the agents never learn a count, and Bob's agent cannot thank a note it never received: no inbox event, nothing in the reminder", async () => {
    const reminder = await bobAgent.call('pending');
    assert.doesNotMatch(reminder.raw, /thank/i);
    const inbox = await aliceAgent.call('inbox');
    assert.doesNotMatch(inbox.raw, /thank|helped 1/i);
    const refused = await bobAgent.call('thank_note', { quote_id: 'q_AAAAAAAAAAAAAAAA' });
    assert.equal(refused.isError, true);
    assert.match(refused.data.message, /You can thank someone only for a note that reached you/);
  });

  it("Bob's page never shows Alice's count", async () => {
    assert.doesNotMatch((await bobBrowser.get('/ui')).html, /Your notes helped/);
    assert.match((await bobBrowser.get('/ui/settings')).html, /Your notes helped 0 people/);
  });

  it('Alice turns on the badge in Settings; its public link shows a number only', async () => {
    assert.match((await aliceBrowser.get('/ui/settings')).html, /Show a badge<\/span><span class="m">Off\./);
    assert.equal((await aliceBrowser.post('/ui/settings/badge', { on: '1' })).status, 303);
    badge = (await aliceBrowser.get('/ui/settings')).html.match(/\/badge\/([\w-]+)\.svg/)![1]!;
    const image = await fetch(`${relay.base}/badge/${badge}.svg`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    const svg = await image.text();
    assert.match(svg, />Helped 1 person on Klatsch</);
    assert.doesNotMatch(svg, /alice|Alice|bob|Bob/);
  });

  it('she turns it off: the link stops working', async () => {
    assert.equal((await aliceBrowser.post('/ui/settings/badge', { on: '0' })).status, 303);
    assert.equal((await fetch(`${relay.base}/badge/${badge}.svg`)).status, 404);
  });
});
