// A message's own menu, like a messenger: star (for oneself, listed under Starred messages), pin (for both, one at
// a time, at the top of the conversation), delete for me (only my side), and delete for everyone (its sender, within
// two days: its words and files go for both, and no agent gets it from then on). Only the two people can do any of it.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, startRelay, type Browser, type Relay } from './harness.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3, 4]);

describe('message actions: star, pin, delete for me, delete for everyone', () => {
  let relay: Relay;
  let alice = '', eve = '', frank = '';
  let aliceBrowser: Browser, eveBrowser: Browser, frankBrowser: Browser;

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    eve = relay.klatsch.ensureUser('eve', 'Eve');
    frank = relay.klatsch.ensureUser('frank', 'Frank');
    relay.klatsch.addMember(relay.klatsch.friendCircle(alice), eve, alice);
    relay.klatsch.addMember(relay.klatsch.friendCircle(alice), frank, alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    eveBrowser = await browser(relay, relay.loginLink(eve));
    frankBrowser = await browser(relay, relay.loginLink(frank));
  });
  after(async () => relay.close());

  it('every bubble has its menu; a star is mine alone and lists under Starred messages', async () => {
    const id = relay.klatsch.sendMessage(eve, '@alice', 'The museum opens at 10.');
    const page = (await aliceBrowser.get('/ui/chat/eve')).html;
    assert.match(page, new RegExp(`id="m-${id}"[\\s\\S]*?<details class="msgmenu">[\\s\\S]*?action="/ui/messages/${id}/star"`));
    assert.equal((await aliceBrowser.post(`/ui/messages/${id}/star`)).status, 303);
    assert.equal(relay.klatsch.conversation(alice, '@eve').messages.at(-1)!.starred, true);
    assert.equal(relay.klatsch.conversation(eve, '@alice').messages.at(-1)!.starred, false, 'not starred for Eve');
    const starred = (await aliceBrowser.get('/ui/starred')).html;
    assert.match(starred, /The museum opens at 10\./);
    assert.match(starred, new RegExp(`href="/ui/chat/eve#m-${id}"`));
    await aliceBrowser.post(`/ui/messages/${id}/unstar`);
    // The chat list beside it still shows the line as the last message; the starred list no longer has it.
    assert.match((await aliceBrowser.get('/ui/starred')).html, /No starred messages yet/);
  });

  it('a pin shows at the top for both, one at a time', async () => {
    const first = relay.klatsch.sendMessage(alice, '@eve', 'Address: Museumsinsel 1');
    const second = relay.klatsch.sendMessage(alice, '@eve', 'Tickets: row 4');
    await aliceBrowser.post(`/ui/messages/${first}/pin`);
    assert.match((await eveBrowser.get('/ui/chat/alice')).html, new RegExp(`<a class="pinbar" href="#m-${first}">[\\s\\S]*Address: Museumsinsel 1`));
    await eveBrowser.post(`/ui/messages/${second}/pin`);
    const page = (await aliceBrowser.get('/ui/chat/eve')).html;
    assert.match(page, new RegExp(`<a class="pinbar" href="#m-${second}">`));
    assert.doesNotMatch(page, new RegExp(`<a class="pinbar" href="#m-${first}">`));
    await aliceBrowser.post(`/ui/messages/${second}/unpin`);
    assert.doesNotMatch((await eveBrowser.get('/ui/chat/alice')).html, /class="pinbar"/);
  });

  it('delete for me hides it on my side only', async () => {
    const id = relay.klatsch.sendMessage(eve, '@alice', 'Only Alice hides this.');
    await aliceBrowser.post(`/ui/messages/${id}/hide`);
    assert.ok(!relay.klatsch.conversation(alice, '@eve').messages.some((m) => m.id === id));
    assert.ok(relay.klatsch.conversation(eve, '@alice').messages.some((m) => m.id === id), 'Eve still has it');
  });

  it('delete for everyone: the sender only, within two days; words and files go for both, and agents never get it', async () => {
    const sent = await aliceBrowser.upload('/ui/chat/eve', [{ name: 'map.png', bytes: PNG, type: 'image/png' }], { text: 'Wrong chat, sorry' });
    assert.ok(sent.status < 400);
    const id = relay.klatsch.conversation(alice, '@eve').messages.at(-1)!.id;
    assert.ok((await eveBrowser.post(`/ui/messages/${id}/delete`)).status >= 400, 'not the sender');
    assert.equal((await aliceBrowser.post(`/ui/messages/${id}/delete`)).status, 303);
    const seen = relay.klatsch.conversation(eve, '@alice').messages.find((m) => m.id === id)!;
    assert.equal(seen.deleted, true);
    assert.equal(seen.text, '');
    assert.deepEqual(seen.files, []);
    assert.match((await eveBrowser.get('/ui/chat/alice')).html, /This message was deleted/);
    assert.equal((relay.db.prepare('SELECT count(*) AS n FROM message_files WHERE message_id = ?').get(id) as { n: number }).n, 0);
    // Eve hands the conversation to her AI: the deleted message is not in it.
    await eveBrowser.post('/ui/chat/alice/agent');
    const eveAgent = await agent(relay, relay.agentToken(eve), { dialogs: false });
    const thread = ((await eveAgent.call('inbox')).data.events as { kind: string; quote?: string }[]).find((e) => e.kind === 'message.thread');
    assert.ok(!thread?.quote?.includes('Wrong chat'));
    await eveAgent.close();
    // Older than two days: too late for everyone (still fine for me).
    const old = relay.klatsch.sendMessage(alice, '@eve', 'An old one');
    relay.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now() - 3 * 24 * 60 * 60 * 1000, old);
    assert.throws(() => relay.klatsch.deleteMessageForEveryone(alice, old), /within two days/);
  });

  it('nobody outside the conversation can touch a message', async () => {
    const id = relay.klatsch.sendMessage(alice, '@eve', 'Between us.');
    for (const action of ['star', 'pin', 'hide', 'delete']) assert.ok((await frankBrowser.post(`/ui/messages/${id}/${action}`)).status >= 400, action);
    assert.equal((await aliceBrowser.post(`/ui/messages/${id}/explode`)).status, 404);
  });
});
