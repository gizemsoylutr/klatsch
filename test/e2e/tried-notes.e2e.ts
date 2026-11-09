// Bob shares what did not work. Alice, stuck on the same thing, is warned: on her page, in her agent's results,
// in the inbox and in a quote it says this is not a fix, and no intro request goes to Bob by itself.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, personAt, startRelay, type Browser, type Relay } from './harness.ts';

const BOB_FAILED = 'Tried OFFSET with a covering index on Postgres: still slow past page 1000, and rows shift. Do not bother.';
const BOB_FIXED = 'Keyset paging on Postgres: a cursor on (created_at, id) fixed it.';
const ALICE_TEXT = 'Paging in my Node.js API on Postgres gets slow and skips rows.';

describe('tried notes: what did not work reaches others as a warning, never as a fix', () => {
  let relay: Relay;
  let alice = '', bob = '';
  let aliceBrowser: Browser, bobBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>, bobAgent: Awaited<ReturnType<typeof agent>>;
  let tried = '';

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', alice), bob, alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobBrowser = await browser(relay, relay.loginLink(bob));
    const decide = (person: Browser, form: Record<string, string>) => async (url: string) => {
      await person.post(`${new URL(url).pathname}/decide`, form);
    };
    aliceAgent = await agent(relay, relay.agentToken(alice), { onPage: decide(aliceBrowser, { decision: 'approved' }) });
    bobAgent = await agent(relay, relay.agentToken(bob), { onPage: decide(bobBrowser, { decision: 'approved', visibility: 'open' }) });
  });
  after(async () => {
    await aliceAgent.close();
    await bobAgent.close();
    await relay.close();
  });

  it('the approval page says what is being shared, with the same choice of who reads it', async () => {
    const preview = await agent(relay, relay.agentToken(bob), { dialogs: false });
    const asked = await preview.call('update_card', { status: 'tried', tags: ['postgres', 'pagination'], summary: BOB_FAILED, visibility: 'open' });
    assert.equal(asked.data.state, 'pending-approval');
    const page = await bobBrowser.post('/ui/device', { code: asked.data.code });
    assert.ok(page.html.includes('Share what did not work?'));
    assert.ok(page.html.includes('Open to my circle'));
    assert.ok(page.html.includes('<strong>tried</strong>'));
    await bobBrowser.post('/ui/device/decide', { code: asked.data.code, decision: 'declined' });
    await preview.close();
  });

  it('a tried sip carries no link card', async () => {
    const refused = await bobAgent.call('update_card', { status: 'tried', tags: ['postgres'], summary: BOB_FAILED, source: { url: 'https://example.com/post', title: 'A post' } });
    assert.equal(refused.isError, true);
  });

  it('Bob shares it; his card says tried, not solved', async () => {
    const shared = await bobAgent.call('update_card', { status: 'tried', tags: ['postgres', 'pagination'], summary: BOB_FAILED, visibility: 'open' });
    assert.equal(shared.data.state, 'shared');
    tried = shared.data.sip_id;
    const home = await bobBrowser.get('/ui');
    assert.ok(home.html.includes('tried · '));
    assert.ok(home.html.includes('dot tried'));
    const own = await bobAgent.call('find_matches', { tags: ['postgres'] });
    assert.equal(own.data.own[0].status, 'tried', 'and his own agent reads it back as tried');
  });

  it("Alice's agent's search says did not work, never solved, and shows nothing of Bob", async () => {
    const found = await aliceAgent.call('find_matches', { tags: ['pagination'] });
    assert.equal(found.data.matches.length, 1);
    assert.equal(found.data.matches[0].outcome, 'did-not-work');
    assert.match(found.data.matches[0].reason, /did not work/);
    assert.doesNotMatch(found.data.matches[0].reason, /solved/);
    assert.ok(!found.raw.includes(BOB_FAILED) && !found.raw.includes('Bob') && !found.raw.includes('@bob'));
  });

  it('Alice shares a looking sip: no intro request goes to Bob by itself, and her page marks the note', async () => {
    const before = relay.notifications.length;
    const shared = await aliceAgent.call('update_card', { status: 'looking', tags: ['postgres', 'pagination'], summary: ALICE_TEXT });
    assert.equal(shared.data.state, 'shared');
    assert.deepEqual(shared.data.intros ?? [], []);
    assert.equal(shared.data.matches[0].outcome, 'did-not-work');
    assert.match(shared.data.matches[0].note, /tried something on this that did not work/);
    assert.ok(!relay.notifications.slice(before).some((line) => line.includes('has solved this')), 'no notification says solved');
    const home = await aliceBrowser.get('/ui');
    assert.ok(home.html.includes(BOB_FAILED));
    assert.ok(home.html.includes('did not work for them'));
    assert.equal(relay.klatsch.introsOf(bob).length, 0, 'Bob is not asked');
  });

  it('sent to her agent, the quote says it is a warning', async () => {
    assert.ok((await aliceBrowser.post(`/ui/notes/${tried}/send`)).status < 400);
    const events = (await aliceAgent.call('inbox')).data.events as { type?: string; quote?: string; note?: string }[];
    const quote = events.find((event) => event.type === 'quote');
    assert.equal(quote?.quote, BOB_FAILED);
    assert.match(quote!.note!, /did NOT work for them: it is a warning, not a fix/);
  });

  it('a new tried note reaches Alice with an inbox line that says so', async () => {
    const carol = relay.klatsch.ensureUser('carol', 'Carol');
    const circle = relay.klatsch.ensureCircle('demo', alice);
    relay.klatsch.addMember(circle, carol, alice);
    const noted = relay.klatsch.draftSip(carol, { status: 'tried', tags: ['pagination'], summary: 'Tried LIMIT without an order: rows repeat.' }, 'cli');
    relay.klatsch.approveSip(carol, noted.sipId, 'cli');
    const events = (await aliceAgent.call('inbox')).data.events as { kind: string; text: string }[];
    const match = events.find((event) => event.kind === 'match.new');
    assert.match(match!.text, /did not work for them/);
    assert.doesNotMatch(match!.text, /solved/);
    assert.ok(!JSON.stringify(events).includes('Tried LIMIT'));
  });

  it('a real fix still ranks first and still gets the intro or the note as before', async () => {
    const shared = await bobAgent.call('update_card', { status: 'solved', tags: ['postgres', 'pagination'], summary: BOB_FIXED, visibility: 'open' });
    assert.equal(shared.data.state, 'shared');
    const found = await aliceAgent.call('find_matches', { tags: ['pagination'] });
    assert.equal(found.data.matches[0].outcome, undefined, 'the fix comes before the warnings');
    assert.ok(found.data.matches.some((m: { outcome?: string }) => m.outcome === 'did-not-work'));
  });
});
