// With semantic matching on, two people who picked different tags still meet, in a private circle, only through
// sips a human approved. The model here is a stand-in with fixed answers; the real one is measured by hand
// (see SEMANTIC_THRESHOLD), because it is an optional library of about 470 MB.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Embedder } from '../../src/match/semantic.ts';
import { agent, browser, startRelay, type Browser, type Relay } from './harness.ts';

const STUCK = 'Two workers process the same job twice from our queue.';
const FIX = 'Take the row with SELECT FOR UPDATE SKIP LOCKED so only one worker claims it.';
const OTHER = 'Set the content paths so unused classes are purged.';
const SECRET = 'A private note that must stay out of every tool result.';

/** A stand-in: the words about jobs and workers point one way, everything else the other. */
const embedder: Embedder = {
  model: 'test-model',
  embed: async (text) => {
    const about = /worker|job/i.test(text);
    return Float32Array.from(about ? [1, 0] : [0, 1]);
  },
};

describe('semantic matching: different tags, the same problem', () => {
  let relay: Relay;
  let alice = '', bob = '', carol = '';
  let aliceBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>;

  const shareAs = (user: string, status: 'solved' | 'looking', tags: string[], summary: string, visibility?: 'open' | 'ask', matchIn?: string[]) => {
    const draft = relay.klatsch.draftSip(user, { status, tags, summary, ...(visibility ? { visibility } : {}) }, 'cli');
    relay.klatsch.approveSip(user, draft.sipId, 'cli', visibility, matchIn);
    return draft.sipId;
  };

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    carol = relay.klatsch.ensureUser('carol', 'Carol');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', alice), bob, alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    aliceAgent = await agent(relay, relay.agentToken(alice), {
      onPage: async (url) => void (await aliceBrowser.post(`${new URL(url).pathname}/decide`, { decision: 'approved' })),
    });
  });
  after(async () => {
    await aliceAgent.close();
    await relay.close();
  });

  it('off by default: nothing is compared, nothing is stored, and the page does not mention it', async () => {
    shareAs(bob, 'solved', ['concurrency'], FIX, 'ask');
    await relay.klatsch.semanticSettled();
    assert.equal((relay.db.prepare('SELECT count(*) AS n FROM sip_vectors').get() as { n: number }).n, 0);
    const ask = await agent(relay, relay.agentToken(alice), { dialogs: false });
    const asked = await ask.call('update_card', { status: 'looking', tags: ['background-jobs'], summary: STUCK });
    const page = await aliceBrowser.post('/ui/device', { code: asked.data.code });
    assert.ok(!page.html.includes('compares your words'));
    await aliceBrowser.post('/ui/device/decide', { code: asked.data.code, decision: 'declined' });
    await ask.close();
    relay.db.exec(`UPDATE sips SET state = 'retired'`);
  });

  it('on: the approval page says so before the person decides', async () => {
    relay.klatsch.useEmbedder(embedder);
    const ask = await agent(relay, relay.agentToken(alice), { dialogs: false });
    const asked = await ask.call('update_card', { status: 'looking', tags: ['background-jobs'], summary: STUCK });
    const page = await aliceBrowser.post('/ui/device', { code: asked.data.code });
    assert.ok(page.html.includes('compares your words'));
    await aliceBrowser.post('/ui/device/decide', { code: asked.data.code, decision: 'declined' });
    await ask.close();
  });

  it('an approved note and an approved looking sip that say the same meet without a shared tag', async () => {
    shareAs(bob, 'solved', ['concurrency'], FIX, 'ask');
    await relay.klatsch.semanticSettled();
    const none = await aliceAgent.call('find_matches', { tags: ['background-jobs'] });
    assert.equal(none.data.matches.length, 0, 'a search by tags still finds only tags: no probe');
    const shared = await aliceAgent.call('update_card', { status: 'looking', tags: ['background-jobs'], summary: STUCK, ask_for_intro: false });
    assert.equal(shared.data.state, 'shared');
    await relay.klatsch.semanticSettled();
    const events = (await aliceAgent.call('inbox')).data.events as { kind: string; text: string; ref: string }[];
    const match = events.find((event) => event.kind === 'match.new');
    assert.ok(match, 'the match arrives as news');
    assert.match(match.text, /concurrency/);
    assert.ok(!JSON.stringify(events).includes(FIX) && !JSON.stringify(events).includes('Bob'), 'tags and an id, never the words or the name');
    assert.equal(relay.klatsch.introsOf(bob).length, 0, 'no automatic intro');
    const intro = await aliceAgent.call('request_intro', { match_id: match.ref });
    assert.equal(intro.data.state, 'awaiting-solver', `and from here the usual consent applies: ${intro.raw}`);
  });

  it('a note written later finds the looking sip the same way, and says nothing else matches', async () => {
    shareAs(bob, 'solved', ['css'], OTHER, 'open');
    await relay.klatsch.semanticSettled();
    const events = (await aliceAgent.call('inbox')).data.events as { kind: string }[];
    assert.ok(!events.some((event) => event.kind === 'match.new'), 'an unrelated note makes no match');
  });

  it('a person in no shared circle is never compared', async () => {
    relay.klatsch.ensureCircle('elsewhere', carol);
    shareAs(carol, 'solved', ['concurrency'], `${FIX} ${SECRET}`, 'open');
    await relay.klatsch.semanticSettled();
    const events = (await aliceAgent.call('inbox')).data.events;
    assert.deepEqual(events.filter((event: { kind: string }) => event.kind === 'match.new'), []);
  });

  it('a public circle is left out, also when both people ticked it', async () => {
    const commons = relay.klatsch.ensureCircle('commons', alice);
    relay.klatsch.addMember(commons, carol, alice);
    relay.klatsch.setJoinLink(alice, commons, true, {});
    const carolNote = shareAs(carol, 'solved', ['concurrency'], FIX, 'open', [commons]);
    const looking = shareAs(alice, 'looking', ['background-jobs'], STUCK, undefined, [commons]);
    await relay.klatsch.semanticSettled();
    assert.equal(relay.db.prepare('SELECT 1 FROM matches WHERE seeker_id = ? AND sip_id = ?').get(alice, carolNote), undefined);
    relay.klatsch.retireSip(alice, looking);
  });

  it('a retired sip takes its vector with it, and a failing model only stops the comparing', async () => {
    const sipId = shareAs(bob, 'solved', ['concurrency'], FIX, 'ask');
    await relay.klatsch.semanticSettled();
    assert.ok(relay.db.prepare('SELECT 1 FROM sip_vectors WHERE sip_id = ?').get(sipId));
    relay.klatsch.retireSip(bob, sipId);
    assert.equal(relay.db.prepare('SELECT 1 FROM sip_vectors WHERE sip_id = ?').get(sipId), undefined);
    relay.klatsch.useEmbedder({ model: 'broken', embed: async () => { throw new Error('no model'); } });
    const printed = console.error;
    const lines: string[] = [];
    console.error = (line: string) => void lines.push(line);
    const still = shareAs(bob, 'solved', ['concurrency'], `${SECRET} again`, 'ask');
    await relay.klatsch.semanticSettled();
    console.error = printed;
    assert.ok(relay.db.prepare(`SELECT 1 FROM sips WHERE id = ? AND state = 'approved'`).get(still), 'the share stands');
    assert.ok(lines.length && !lines.join().includes(SECRET), 'the log names no text');
  });
});
