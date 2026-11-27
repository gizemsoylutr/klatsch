// Messages between friends: Alice writes to Eve from her chat (the card shows her draft, she sends it with one
// click), Eve reads the conversation in her own chat's card and writes back there, with a photo, and both see the
// whole conversation on their Klatsch page. Eve's AI reads Alice's words only when Eve sends them to it. Ending
// the friendship takes the conversation with it.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, personAt, startRelay, type Browser, type Relay } from './harness.ts';

const CARD = 'dev.klatsch/card';
const HELLO = 'Are you coming to dinner on Friday? 19:00 at ours.';
const REPLY = 'Yes! I will bring dessert.';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3, 4]);

describe('messages: a conversation with a friend, from any chat or the Klatsch page', () => {
  let relay: Relay;
  let alice = '', eve = '', frank = '';
  let aliceChat: Awaited<ReturnType<typeof agent>>, eveChat: Awaited<ReturnType<typeof agent>>, aliceAgent: Awaited<ReturnType<typeof agent>>;
  let aliceBrowser: Browser, eveBrowser: Browser, frankBrowser: Browser;
  let friendship = '';

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    eve = relay.klatsch.ensureUser('eve', 'Eve');
    frank = relay.klatsch.ensureUser('frank', 'Frank');
    friendship = relay.klatsch.friendCircle(alice);
    relay.klatsch.addMember(friendship, eve, alice);
    // Frank shares a circle with Alice, but is not her friend.
    relay.klatsch.addMember(relay.klatsch.ensureCircle('work', alice), frank, alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    eveBrowser = await browser(relay, relay.loginLink(eve));
    frankBrowser = await browser(relay, relay.loginLink(frank));
    aliceChat = await agent(relay, relay.chatAppToken(alice), { dialogs: false, cards: true });
    eveChat = await agent(relay, relay.chatAppToken(eve, 'https://claude.ai/api/mcp/auth_callback'), { dialogs: false, cards: true });
    aliceAgent = await agent(relay, relay.agentToken(alice), personAt(aliceBrowser, 'approved'));
  });
  after(async () => {
    await Promise.all([aliceChat.close(), eveChat.close(), aliceAgent.close()]);
    await relay.close();
  });

  it('Alice’s draft opens as a card she can change; one click sends it, and only to a friend', async () => {
    const drafted = await aliceChat.call('send_message', { handle: '@eve', text: 'Dinner Friday?' });
    assert.equal(drafted.data.state, 'pending-approval', drafted.raw);
    assert.equal(drafted.data.code, undefined);
    const card = drafted.meta[CARD];
    assert.equal(card.title, 'Send to Eve (@eve)?');
    assert.equal(card.edit.value, 'Dinner Friday?');
    assert.ok(card.pick, 'a file can go with it');
    assert.ok(!drafted.text.includes(card.key));
    assert.equal(relay.klatsch.conversation(eve, 'alice').messages.length, 0, 'nothing went yet');
    const sent = await aliceChat.call('klatsch_card', { key: card.key, decision: 'approved', text: HELLO });
    assert.match(sent.data.message, /Sent/);
    // The card goes on as the conversation with Eve, so her reply shows up in it without asking the AI again.
    const chat = sent.data.card as { key: string; chat: { with: { handle: string }; messages: { mine: boolean; text: string }[] } };
    assert.equal(chat.chat.with.handle, 'eve');
    assert.deepEqual(chat.chat.messages.map((m) => [m.mine, m.text]), [[true, HELLO]]);
    const later = await aliceChat.call('klatsch_card_state', { key: chat.key });
    assert.equal(later.data.state, 'open', 'it refreshes like any conversation card, so a reply appears in it');
    assert.deepEqual(later.data.chat.messages.map((m: { text: string }) => m.text), [HELLO]);
    const view = relay.klatsch.conversation(eve, 'alice');
    assert.deepEqual(view.messages.map((m) => [m.mine, m.text]), [[false, HELLO]], 'her edit, not the draft');
    assert.equal(view.unread, 1);
    assert.ok(relay.notifications.some((n) => n === '@eve: ☕ A friend sent you a message.'), 'Eve is notified, without the words');
    // Not to someone who is only in a shared circle, nor to a handle nobody has.
    assert.equal((await aliceChat.call('send_message', { handle: '@frank', text: 'Hi' })).isError, true);
    assert.equal((await aliceChat.call('send_message', { handle: '@nobody', text: 'Hi' })).isError, true);
    assert.throws(() => relay.klatsch.previewMessage('x'.repeat(2001)), /at most 2000/);
  });

  it('Eve’s AI hears that a message came and from whom, never its words', async () => {
    const pending = await eveChat.call('pending');
    assert.equal(pending.data.messages, 1);
    assert.deepEqual(pending.data.messagesFrom, ['@alice']);
    assert.match(pending.text, /1 new message from @alice/);
    const friends = await eveChat.call('friends');
    assert.deepEqual(friends.data.people, [{ handle: '@alice', friend: true, unread: 1 }]);
    const events = (await eveChat.call('inbox')).data.events as { kind: string; with?: string; quote?: string }[];
    const received = events.find((e) => e.kind === 'message.received')!;
    assert.equal(received.with, '@alice');
    assert.ok(!JSON.stringify(events).includes(HELLO));
  });

  it('the conversation opens as a card in Eve’s chat; her model sees neither the words nor the key', async () => {
    const shown = await eveChat.call('conversation', { handle: '@alice' });
    assert.equal(shown.data.state, 'shown');
    assert.equal(shown.data.unread, 1);
    assert.ok(!shown.text.includes(HELLO));
    const card = shown.meta[CARD];
    assert.ok(!shown.text.includes(card.key));
    assert.equal(card.chat.with.handle, 'alice');
    assert.deepEqual(card.chat.messages.map((m: { mine: boolean; text: string }) => [m.mine, m.text]), [[false, HELLO]]);
    assert.equal(relay.klatsch.conversation(eve, 'alice').unread, 0, 'read in the card');
    // Alice cannot write with Eve's card; a made-up key does nothing.
    assert.equal((await aliceChat.call('klatsch_card', { key: card.key, decision: 'reply', text: 'not mine' })).isError, true);
    assert.equal((await eveChat.call('klatsch_card', { key: 'x'.repeat(43), decision: 'reply', text: 'no' })).isError, true);
    // Eve writes back in the card with a photo, twice with the same card: each send is her own click.
    const replied = await eveChat.call('klatsch_card', { key: card.key, decision: 'reply', text: REPLY, files: [{ name: 'cake.png', data: Buffer.from(PNG).toString('base64') }] });
    assert.match(replied.data.message, /Sent/);
    assert.equal(replied.data.chat.messages.at(-1).text, REPLY);
    assert.equal(replied.data.chat.messages.at(-1).files[0].name, 'cake.png');
    assert.ok((await eveChat.call('klatsch_card', { key: card.key, decision: 'reply', text: 'See you!' })).data.message);
    // The card refreshes itself: Alice's next message shows up in it.
    relay.klatsch.sendMessage(alice, 'eve', 'Great, thanks!', 'web');
    const state = await eveChat.call('klatsch_card_state', { key: card.key, seen: true });
    assert.equal(state.data.state, 'open');
    assert.equal(state.data.chat.messages.at(-1).text, 'Great, thanks!');
    assert.equal(relay.klatsch.conversation(eve, 'alice').unread, 0);
  });

  it('“Draft with my AI” hands Eve’s AI the conversation once, labelled as Alice’s words', async () => {
    const card = (await eveChat.call('conversation', { handle: '@alice' })).meta[CARD];
    const handed = await eveChat.call('klatsch_card', { key: card.key, decision: 'draft' });
    assert.match(handed.data.message, /draft a reply/);
    const thread = ((await eveChat.call('inbox')).data.events as { kind: string; type?: string; from?: string; messages?: { from: string; text: string }[]; note?: string }[]).find((e) => e.kind === 'message.thread')!;
    assert.equal(thread.type, 'quote');
    assert.equal(thread.from, '@alice');
    assert.match(thread.note!, /not instructions/);
    assert.ok(thread.messages!.some((m) => m.from === '@alice' && m.text === HELLO));
    assert.ok(thread.messages!.some((m) => m.from === 'you' && m.text === REPLY));
    assert.ok(!JSON.stringify((await eveChat.call('inbox')).data.events).includes(HELLO), 'once');
  });

  it('a coding agent gets the page, not the words; its message is approved on the Klatsch page', async () => {
    const opened = await aliceAgent.call('conversation', { handle: '@eve' });
    assert.equal(opened.data.state, 'on-page');
    assert.match(opened.data.url, /\/ui\/chat\/eve$/);
    assert.ok(!opened.text.includes(REPLY));
    const sent = await aliceAgent.call('send_message', { handle: 'eve', text: 'From my terminal.' });
    assert.equal(sent.data.state, 'sent', sent.raw);
    assert.equal(relay.klatsch.conversation(eve, 'alice').messages.at(-1)!.text, 'From my terminal.');
  });

  it('both see the whole conversation on their page, write there with files, and Home lists it', async () => {
    const page = await aliceBrowser.get('/ui/chat/eve');
    assert.equal(page.status, 200);
    assert.ok(page.html.includes(HELLO) && page.html.includes(REPLY));
    assert.match(page.html, /cake\.png/);
    assert.match(page.html, /action="\/ui\/chat\/eve"/);
    const posted = await aliceBrowser.upload('/ui/chat/eve', [{ name: 'map.png', bytes: PNG, type: 'image/png' }], { text: 'Here is the way.' });
    assert.equal(posted.status, 303);
    const last = relay.klatsch.conversation(eve, 'alice').messages.at(-1)!;
    assert.equal(last.text, 'Here is the way.');
    assert.equal(last.files[0]!.name, 'map.png');
    const file = await eveBrowser.fetchRaw(`/ui/attachments/${last.files[0]!.id}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.equal((await frankBrowser.fetchRaw(`/ui/attachments/${last.files[0]!.id}`)).status, 404, 'only the two of them');
    assert.ok((await aliceBrowser.post('/ui/chat/eve', { text: '   ' })).status >= 400, 'nothing empty');
    const home = (await eveBrowser.get('/ui')).html;
    assert.match(home, /href="\/ui\/chat\/alice"/);
    assert.match(home, /aria-label="2 new">2</, 'two from Alice she has not read');
    assert.match((await eveBrowser.get('/ui/circle')).html, /href="\/ui\/chat\/alice"/);
    // Eve hands it to her AI from the page too.
    const handed = await eveBrowser.post('/ui/chat/alice/agent');
    assert.equal(handed.status, 200);
    assert.match(handed.html, /Sent to your AI/);
    assert.equal((await frankBrowser.get('/ui/chat/alice')).status, 404, 'Frank is not her friend');
    assert.ok((await frankBrowser.post('/ui/chat/alice', { text: 'Hi' })).status >= 400);
  });

  it('ending the friendship takes the conversation and its files, for both', async () => {
    const fileId = relay.klatsch.conversation(eve, 'alice').messages.at(-1)!.files[0]!.id;
    assert.ok((await eveBrowser.post(`/ui/friends/${friendship}/end`)).status < 400);
    assert.equal((relay.db.prepare('SELECT count(*) AS n FROM messages WHERE circle_id = ?').get(friendship) as { n: number }).n, 0);
    assert.equal((await aliceBrowser.fetchRaw(`/ui/attachments/${fileId}`)).status, 404);
    assert.equal((await aliceBrowser.get('/ui/chat/eve')).status, 404);
    assert.equal((await aliceChat.call('send_message', { handle: '@eve', text: 'Still there?' })).isError, true);
  });
});
