// Cards in the chat (MCP Apps): in a chat app that shows them, Alice approves her question in Klatsch's card, Eve
// reads it in hers and answers there, and the answer reaches Alice's agent. The model never gets the card's key
// or Eve's question, and the card's tool is for the card only.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { registerClient } from '../../src/auth/oauth.ts';
import { createToken } from '../../src/auth/tokens.ts';
import { agent, startRelay, type Relay } from './harness.ts';

const QUESTION = 'Which bakery near the station did you like?';
const ANSWER = 'The small one on the corner, before 9.';
const CARD = 'dev.klatsch/card';

describe('cards in the chat: decide and answer without leaving the conversation', () => {
  let relay: Relay;
  let alice = '', eve = '';
  let aliceChat: Awaited<ReturnType<typeof agent>>, eveChat: Awaited<ReturnType<typeof agent>>, plain: Awaited<ReturnType<typeof agent>>;
  let askId = '';

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    eve = relay.klatsch.ensureUser('eve', 'Eve');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('pair', alice), eve, alice);
    aliceChat = await agent(relay, relay.chatAppToken(alice), { dialogs: false, cards: true });
    eveChat = await agent(relay, relay.chatAppToken(eve, 'https://claude.ai/api/mcp/auth_callback'), { dialogs: false, cards: true });
    plain = await agent(relay, relay.agentToken(alice), { dialogs: false });
  });
  after(async () => {
    await Promise.all([aliceChat.close(), eveChat.close(), plain.close()]);
    await relay.close();
  });

  it('a chat app that shows cards gets the card page, and the card tool is marked for the card only', async () => {
    const tools = (await aliceChat.listTools()).tools;
    const card = tools.find((t) => t.name === 'klatsch_card')!;
    assert.deepEqual((card._meta as any).ui.visibility, ['app'], 'for the card only, never the model');
    assert.equal(((tools.find((t) => t.name === 'ask_person')!._meta as any).ui.resourceUri), 'ui://klatsch/card.html');
    const page = await aliceChat.readResource('ui://klatsch/card.html');
    const content = page.contents[0] as { mimeType: string; text: string };
    assert.equal(content.mimeType, 'text/html;profile=mcp-app');
    assert.match(content.text, /globalThis\.KlatschApps=/);
    assert.ok(!content.text.includes('innerHTML'), 'the card renders text, never HTML');
  });

  it('Alice’s question opens as a card; the model is told to wait and gets no code and no key', async () => {
    const asked = await aliceChat.call('ask_person', { handle: '@eve', question: QUESTION });
    assert.equal(asked.data.state, 'pending-approval');
    assert.match(asked.data.note, /Klatsch card shown in this chat/);
    assert.equal(asked.data.code, undefined);
    const card = asked.meta[CARD];
    assert.equal(card.title, 'Ask Eve (@eve)?');
    assert.ok(!asked.text.includes(card.key), 'the key is in _meta only, for the card');
    assert.equal(relay.klatsch.asksOf(eve).length, 0, 'nothing went yet');
    // The model cannot decide with a made-up key; the card's real key decides once.
    assert.equal((await aliceChat.call('klatsch_card', { key: 'x'.repeat(43), decision: 'approved' })).isError, true);
    const decided = await aliceChat.call('klatsch_card', { key: card.key, decision: 'approved' });
    assert.match(decided.data.message, /Asked/);
    assert.equal((await aliceChat.call('klatsch_card', { key: card.key, decision: 'approved' })).isError, true, 'once');
    askId = relay.klatsch.asksOf(eve)[0]!.id;
  });

  it('Eve’s chat shows her the question in a card; her model gets neither the words nor who asked', async () => {
    const shown = await eveChat.call('show_question', { ask_id: askId });
    assert.ok(!shown.text.includes(QUESTION), 'not for the model');
    assert.ok(!shown.text.includes('alice'), 'nor who asked');
    const card = shown.meta[CARD];
    assert.equal(card.lines[0].text, QUESTION);
    assert.ok(card.answerBox);
    // Alice cannot use Eve's card.
    assert.equal((await aliceChat.call('klatsch_card', { key: card.key, decision: 'answer', answer: 'mine' })).isError, true);
    const sent = await eveChat.call('klatsch_card', { key: card.key, decision: 'answer', answer: ANSWER });
    assert.match(sent.data.message, /Answer sent/);
    const quote = ((await aliceChat.call('inbox')).data.events as { type?: string; quote?: string }[]).find((e) => e.type === 'quote')!;
    assert.equal(quote.quote, ANSWER);
  });

  it('a client without cards gets the code and the page, as before', async () => {
    const asked = await plain.call('ask_person', { handle: '@eve', question: 'Another one?' });
    assert.equal(asked.data.state, 'pending-approval');
    assert.ok(asked.data.code);
    assert.equal(asked.meta[CARD], undefined);
    const other = await agent(relay, relay.agentToken(eve), { dialogs: false });
    const ask = relay.klatsch.asksOf(eve).find((k) => k.state === 'open');
    if (ask) assert.equal((await other.call('show_question', { ask_id: ask.id })).data.state, 'not-shown');
    await other.close();
  });

  it('an agent that only says it shows cards gets the code and the page, never a key', async () => {
    // The attack the review found: an agent token, with a client that declares the MCP Apps extension.
    const pretender = await agent(relay, relay.agentToken(alice), { dialogs: false, cards: true });
    const asked = await pretender.call('ask_person', { handle: '@eve', question: 'Approve myself?' });
    assert.ok(asked.data.code, 'the person decides on the page');
    assert.equal(asked.meta[CARD], undefined);
    // Nor does an OAuth client that also registered a redirect of its own.
    const mixed = registerClient(relay.db, { client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/cb', 'https://evil.example/cb'] }) as { client_id: string };
    const token = createToken(relay.db, relay.secret, alice, { ttlDays: 1, label: `oauth:${mixed.client_id}` }).token;
    const sneaky = await agent(relay, token, { dialogs: false, cards: true });
    assert.equal((await sneaky.call('ask_person', { handle: '@eve', question: 'Approve myself?' })).meta[CARD], undefined);
    await Promise.all([pretender.close(), sneaky.close()]);
  });

  it('a refused answer leaves the card usable; a card offers only its own buttons', async () => {
    const asked = await aliceChat.call('ask_person', { handle: '@eve', question: 'One more?' });
    const approve = asked.meta[CARD];
    assert.equal((await aliceChat.call('klatsch_card', { key: approve.key, decision: 'answer', answer: 'x' })).isError, true, 'not offered on an ask card');
    assert.equal((await aliceChat.call('klatsch_card', { key: approve.key, decision: 'always' })).isError, true, '"always" is for intros only');
    assert.match((await aliceChat.call('klatsch_card', { key: approve.key, decision: 'approved' })).data.message, /Asked/, 'the key survived the refusals');
    const ask = relay.klatsch.asksOf(eve).find((k) => k.question === 'One more?')!;
    const card = (await eveChat.call('show_question', { ask_id: ask.id })).meta[CARD];
    assert.equal((await eveChat.call('klatsch_card', { key: card.key, decision: 'answer', answer: 'Hidden\u200bwords' })).isError, true, 'refused: hidden characters');
    assert.match((await eveChat.call('klatsch_card', { key: card.key, decision: 'answer', answer: 'Yes, fine.' })).data.message, /Answer sent/);
  });
});
