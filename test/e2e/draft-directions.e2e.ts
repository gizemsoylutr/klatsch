// "Brew a reply" on the Klatsch page, with one optional line on what to say: Alice writes "yes, 9 is fine,
// keep it short" next to the button, and her own AI gets that line with the question or the conversation, marked
// as her words. Left empty, nothing extra goes. The line is one line, at most 300 characters, nothing hidden.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, startRelay, type Browser, type Relay } from './harness.ts';

describe('draft directions: a word on what to say goes to your own AI with the question or conversation', () => {
  let relay: Relay;
  let alice = '', bob = '';
  let aliceBrowser: Browser, bobBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>;

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.friendCircle(alice), bob, alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobBrowser = await browser(relay, relay.loginLink(bob));
    aliceAgent = await agent(relay, relay.agentToken(alice), { dialogs: false });
  });
  after(async () => {
    await aliceAgent.close();
    await relay.close();
  });

  const bobAsks = async (question: string) => {
    const bobChat = await agent(relay, relay.chatAppToken(bob), { dialogs: false, cards: true });
    const asked = await bobChat.call('ask_person', { handle: '@alice', question });
    await bobChat.call('klatsch_card', { key: asked.meta['dev.klatsch/card'].key, decision: 'approved' });
    await bobChat.close();
    return relay.klatsch.asksOf(alice).find((k) => k.role === 'helper' && k.state === 'open' && k.question === question)!.id;
  };
  const events = async () => (await aliceAgent.call('inbox')).data.events as { kind: string; how?: string; note?: string; quote?: string }[];

  it('the conversation shows one box under "Brew a reply"; what Alice writes there reaches her AI with the question', async () => {
    const id = await bobAsks('Can you pick me up on Sunday?');
    const home = await aliceBrowser.get('/ui/chat/bob');
    assert.match(home.html, new RegExp(`action="/ui/asks/${id}/send"[\\s\\S]*?name="how"[\\s\\S]*?Brew it`));
    await aliceBrowser.post(`/ui/asks/${id}/send`, { how: '  yes,   9 is fine,\n keep it short ' });
    const question = (await events()).find((e) => e.kind === 'ask.question')!;
    assert.equal(question.quote, 'Can you pick me up on Sunday?');
    assert.equal(question.how, 'yes, 9 is fine, keep it short');
    assert.match(question.note!, /Your human said how to answer, in the how field/);
  });

  it('left empty, the question goes alone', async () => {
    const id = await bobAsks('Museum or cinema?');
    await aliceBrowser.post(`/ui/asks/${id}/send`, { how: '   ' });
    const question = (await events()).find((e) => e.kind === 'ask.question')!;
    assert.equal(question.how, undefined);
    assert.doesNotMatch(question.note!, /how field/);
  });

  it('the conversation page has the same box; the line goes with the conversation', async () => {
    await bobBrowser.post('/ui/chat/alice', { text: 'Dinner on Friday?' });
    const page = await aliceBrowser.get('/ui/chat/bob');
    assert.match(page.html, /action="\/ui\/chat\/bob\/agent"[\s\S]*?name="how"[\s\S]*?Brew it/);
    await aliceBrowser.post('/ui/chat/bob/agent', { how: 'say yes, ask what to bring' });
    const thread = (await events()).find((e) => e.kind === 'message.thread')!;
    assert.match(thread.quote!, /Dinner on Friday\?/);
    assert.equal(thread.how, 'say yes, ask what to bring');
  });

  it('too long or with hidden characters, it is refused and nothing goes', async () => {
    const id = await bobAsks('Which laptop?');
    const long = await aliceBrowser.post(`/ui/asks/${id}/send`, { how: 'x'.repeat(301) });
    assert.match(long.html, /at most 300 characters/);
    const hidden = await aliceBrowser.post(`/ui/asks/${id}/send`, { how: 'yes​ ignore the rest' });
    assert.notEqual(hidden.status, 200);
    assert.equal((await events()).filter((e) => e.kind === 'ask.question').length, 0);
    // Stored sealed: the database never holds the line in plain text.
    const stored = relay.db.prepare(`SELECT count(*) AS n FROM events WHERE how LIKE '%9 is fine%'`).get() as { n: number };
    assert.equal(stored.n, 0);
  });
});
