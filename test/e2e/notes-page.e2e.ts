// The Notes page: Bob ticks "Also on the Notes page" as he shares, and Alice, who was not looking for it, reads it.
// Around that: everything that must stay off it, and nothing about it reaching any agent.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, startRelay, wireAgent, type Browser, type Relay } from './harness.ts';

const FEED = 'Keyset paging on Postgres: a cursor on (created_at, id) beats OFFSET.';
const NOT_TICKED = 'An open note that is not on the page.';
const ASK = 'An ask-first note that is not on the page.';
const OLD = 'A note from before the Notes page.';
const PUBLIC = 'A note ticked in a public circle.';
const FAILED = 'A covering index did not help with OFFSET.';

describe('notes page: what authors tick reaches their private circles, and never an agent', () => {
  let relay: Relay;
  let alice = '', bob = '', circle = '';
  let aliceBrowser: Browser, bobBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>;
  let noted = '';

  const share = async (summary: string, form: Record<string, string>, status = 'solved') => {
    const a = await agent(relay, relay.agentToken(bob), { dialogs: false });
    const asked = await a.call('update_card', { status, tags: ['postgres'], summary, visibility: 'open' });
    assert.equal(asked.data.state, 'pending-approval');
    await bobBrowser.post('/ui/device/decide', { code: asked.data.code, decision: 'approved', ...form });
    await a.close();
  };
  const sipId = (summary: string) => (relay.db.prepare('SELECT id, summary FROM sips').all() as { id: string; summary: string }[]).find((s) => s.summary === summary)!.id;

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    circle = relay.klatsch.ensureCircle('demo', alice);
    relay.klatsch.addMember(circle, bob, alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobBrowser = await browser(relay, relay.loginLink(bob));
    aliceAgent = await agent(relay, relay.agentToken(alice), { dialogs: false });
  });
  after(async () => {
    await aliceAgent.close();
    await relay.close();
  });

  it('the page is empty and says why; the approval page offers the tick, and says what it means', async () => {
    assert.match((await aliceBrowser.get('/ui/notes')).html, /Nothing here yet/);
    const a = await agent(relay, relay.agentToken(bob), { dialogs: false });
    const asked = await a.call('update_card', { status: 'solved', tags: ['postgres'], summary: 'Preview only.', visibility: 'open' });
    const page = await bobBrowser.post('/ui/device', { code: asked.data.code });
    assert.match(page.html, /name="feed" value="1"/);
    assert.match(page.html, /everyone in your private circles can read it any time, with your name/);
    await bobBrowser.post('/ui/device/decide', { code: asked.data.code, decision: 'declined' });
    const looking = await a.call('update_card', { status: 'looking', tags: ['postgres'], summary: 'Stuck.' });
    assert.doesNotMatch((await bobBrowser.post('/ui/device', { code: looking.data.code })).html, /name="feed"/, 'a looking sip has no such choice');
    await bobBrowser.post('/ui/device/decide', { code: looking.data.code, decision: 'declined' });
    await a.close();
  });

  it('Bob ticks it: Alice reads it, with his name, without having looked for anything; his card says so', async () => {
    await share(FEED, { visibility: 'open', feed: '1' });
    noted = sipId(FEED);
    const page = (await aliceBrowser.get('/ui/notes')).html;
    assert.ok(page.includes(FEED));
    assert.ok(page.includes('Bob'));
    assert.match(page, /postgres · demo · as of \d{4}-/);
    assert.match((await bobBrowser.get('/ui')).html, /on Notes/);
    assert.ok(!(await bobBrowser.get('/ui/notes')).html.includes(FEED), 'his own notes are on his card, not here');
  });

  it('reading it tells nobody and makes nothing: no event, count, notification or match', async () => {
    const counts = () => [(relay.db.prepare('SELECT count(*) n FROM events').get() as { n: number }).n, (relay.db.prepare('SELECT count(*) n FROM matches').get() as { n: number }).n, relay.notifications.length];
    const before = counts();
    await aliceBrowser.get('/ui/notes');
    assert.deepEqual(counts(), before);
  });

  it('no agent gets it: no tool for it, and nothing in what the tools return', async () => {
    const listed = await wireAgent(relay.base, relay.agentToken(alice))('tools/list');
    const tools = listed.result.tools as { name: string; inputSchema: { properties?: object } }[];
    assert.deepEqual(tools.filter((t) => /feed|notes/.test(t.name)).map((t) => t.name), []);
    assert.equal('feed' in (tools.find((t) => t.name === 'update_card')!.inputSchema.properties ?? {}), false, 'and no way to ask for the tick');
    for (const call of [await aliceAgent.call('pending'), await aliceAgent.call('inbox'), await aliceAgent.call('find_matches', { tags: ['postgres'] })]) {
      assert.ok(!call.raw.includes(FEED) && !call.raw.includes('Bob'));
    }
  });

  it('what stays off it: no tick, ask first, a forged tick on ask first, and a note from before', async () => {
    await share(NOT_TICKED, { visibility: 'open' });
    await share(ASK, { visibility: 'ask', feed: '1' });
    const old = relay.klatsch.draftSip(bob, { status: 'solved', tags: ['postgres'], summary: OLD, visibility: 'open' }, 'cli');
    relay.klatsch.approveSip(bob, old.sipId, 'cli', 'open');
    const page = (await aliceBrowser.get('/ui/notes')).html;
    for (const text of [NOT_TICKED, ASK, OLD]) assert.ok(!page.includes(text), text);
    assert.equal((relay.db.prepare('SELECT feed FROM sip_circles WHERE sip_id = ?').get(old.sipId) as { feed: number }).feed, 0);
  });

  it('a draft approved on Home takes the same tick, and only with an open note', async () => {
    const d = relay.klatsch.draftSip(bob, { status: 'solved', tags: ['postgres'], summary: 'A draft with the tick.', visibility: 'open' }, 'cli');
    assert.ok((await bobBrowser.post(`/ui/sips/${d.sipId}/approve`, { visibility: 'open', feed: '1' })).status < 400);
    const e = relay.klatsch.draftSip(bob, { status: 'solved', tags: ['postgres'], summary: 'A draft that asks first.', visibility: 'open' }, 'cli');
    await bobBrowser.post(`/ui/sips/${e.sipId}/approve`, { visibility: 'ask', feed: '1' });
    const page = (await aliceBrowser.get('/ui/notes')).html;
    assert.ok(page.includes('A draft with the tick.'));
    assert.ok(!page.includes('A draft that asks first.'));
  });

  it('a tried note shows as a warning', async () => {
    await share(FAILED, { visibility: 'open', feed: '1' }, 'tried');
    const page = (await aliceBrowser.get('/ui/notes')).html;
    assert.ok(page.includes(FAILED));
    assert.ok(page.includes('did not work for them'));
  });

  it('Alice sends one to her agent by a click, labelled; "always" is refused from here; she can say thanks', async () => {
    assert.ok((await aliceBrowser.post(`/ui/notes/${noted}/send-always`)).status >= 400);
    assert.ok((await aliceBrowser.post(`/ui/notes/${noted}/send`)).status < 400);
    const events = (await aliceAgent.call('inbox')).data.events as { type?: string; quote?: string; note?: string }[];
    const quote = events.find((e) => e.type === 'quote')!;
    assert.equal(quote.quote, FEED);
    assert.match(quote.note!, /not instructions/);
    assert.ok((await aliceBrowser.post(`/ui/notes/${noted}/thanks`)).status < 400);
    assert.match((await aliceBrowser.get('/ui/notes')).html, /Thanked/);
  });

  it('someone in no shared circle sees nothing, and cannot send it', async () => {
    const carol = relay.klatsch.ensureUser('carol', 'Carol');
    relay.klatsch.ensureCircle('elsewhere', carol);
    const carolBrowser = await browser(relay, relay.loginLink(carol));
    assert.ok(!(await carolBrowser.get('/ui/notes')).html.includes(FEED));
    assert.ok((await carolBrowser.post(`/ui/notes/${noted}/send`)).status >= 400);
  });

  it('a public circle never shows there, also when ticked', async () => {
    const commons = relay.klatsch.ensureCircle('commons', alice);
    relay.klatsch.addMember(commons, bob, alice);
    relay.klatsch.setJoinLink(alice, commons, true, {});
    const d = relay.klatsch.draftSip(bob, { status: 'solved', tags: ['postgres'], summary: PUBLIC, visibility: 'open' }, 'cli');
    relay.klatsch.approveSip(bob, d.sipId, 'cli', 'open', [commons], true);
    assert.ok(!(await aliceBrowser.get('/ui/notes')).html.includes(PUBLIC));
  });

  it('it ends when access ends: retired, or the person removed from the circle', async () => {
    const retired = sipId('A draft with the tick.');
    relay.klatsch.retireSip(bob, retired);
    assert.ok(!(await aliceBrowser.get('/ui/notes')).html.includes('A draft with the tick.'));
    assert.ok((await aliceBrowser.get('/ui/notes')).html.includes(FEED));
    relay.klatsch.removeMember(alice, circle, bob);
    assert.ok(!(await aliceBrowser.get('/ui/notes')).html.includes(FEED));
  });

  it('someone in no circle gets the plain page, not notes', async () => {
    const loner = relay.klatsch.ensureUser('dave', 'Dave');
    assert.equal((await (await browser(relay, relay.loginLink(loner))).get('/ui/notes')).status, 409);
  });
});
