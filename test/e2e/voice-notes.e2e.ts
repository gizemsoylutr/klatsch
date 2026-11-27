// Voice notes like a messenger: the conversation page has a microphone button (hold to record, let go to send),
// run by /ui/record.js. The note goes as a message of its own ("🎤 Voice note" for Home and the friend's AI) with
// the recording as its file, and both people hear it in the conversation. A browser's own recording formats
// (WebM, and Safari's MP4) are taken. Guests have no button, since they send no files.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, startRelay, type Browser, type Relay } from './harness.ts';

const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...Array(60).fill(3)]);
// What Safari's MediaRecorder writes: an ISO media file of brand iso5.
const SAFARI_M4A = new Uint8Array([0, 0, 0, 24, ...[...'ftypiso5'].map((c) => c.charCodeAt(0)), ...Array(60).fill(5)]);

describe('voice notes: hold the microphone, let go, and the friend hears it', () => {
  let relay: Relay;
  let alice = '', eve = '';
  let aliceBrowser: Browser, eveBrowser: Browser;

  before(async () => {
    relay = await startRelay({ guest: true });
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    eve = relay.klatsch.ensureUser('eve', 'Eve');
    relay.klatsch.addMember(relay.klatsch.friendCircle(alice), eve, alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    eveBrowser = await browser(relay, relay.loginLink(eve));
  });
  after(async () => relay.close());

  it('the conversation page has the microphone button and runs the same-origin recorder script', async () => {
    const response = await fetch(`${relay.base}/ui/chat/eve`, { headers: { Cookie: '' } });
    assert.equal(response.status, 401, 'signed out: the sign-in page');
    const page = await aliceBrowser.get('/ui/chat/eve');
    assert.match(page.html, /<button type="button" class="mic" data-record data-action="\/ui\/chat\/eve"/);
    assert.match(page.html, /<script src="\/ui\/record\.js" defer><\/script>/);
    const raw = await aliceBrowser.fetchRaw('/ui/chat/eve');
    const csp = raw.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /media-src 'self'/);
    const script = await fetch(`${relay.base}/ui/record.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /javascript/);
    assert.match(await script.text(), /MediaRecorder/);
  });

  it('a voice note alone is a message of its own; both of them hear it in the conversation', async () => {
    const sent = await aliceBrowser.upload('/ui/chat/eve', [{ name: 'voice-note.webm', bytes: WEBM, type: 'audio/webm' }], { text: '', voice: '1' });
    assert.ok(sent.status < 400, sent.html);
    const last = relay.klatsch.conversation(eve, '@alice').messages.at(-1)!;
    assert.equal(last.text, '🎤 Voice note');
    assert.equal(last.files[0]!.mime, 'audio/webm');
    for (const [who, other] of [[aliceBrowser, 'eve'], [eveBrowser, 'alice']] as const) {
      assert.match((await who.get(`/ui/chat/${other}`)).html, new RegExp(`<audio controls preload="metadata" src="/ui/attachments/${last.files[0]!.id}"`));
    }
    assert.match(relay.klatsch.conversationsOf(eve)[0]!.last!.text, /Voice note/);
  });

  it('Safari’s recording (MP4, brand iso5) is taken as a voice note too', async () => {
    const sent = await eveBrowser.upload('/ui/chat/alice', [{ name: 'voice-note.m4a', bytes: SAFARI_M4A, type: 'audio/mp4' }], { text: '', voice: '1' });
    assert.ok(sent.status < 400, sent.html);
    assert.equal(relay.klatsch.conversation(alice, '@eve').messages.at(-1)!.files[0]!.mime, 'audio/mp4');
  });

  it('a file alone says so; nothing at all is still refused', async () => {
    await aliceBrowser.upload('/ui/chat/eve', [{ name: 'note.webm', bytes: WEBM }], { text: '' });
    assert.equal(relay.klatsch.conversation(eve, '@alice').messages.at(-1)!.text, '📎 File');
    const before = relay.klatsch.conversation(eve, '@alice').messages.length;
    const empty = await aliceBrowser.post('/ui/chat/eve', { text: '   ' });
    assert.notEqual(empty.status, 303);
    assert.equal(relay.klatsch.conversation(eve, '@alice').messages.length, before);
  });

  it('from the card in a chat app: the card asks for the microphone, and a voice note alone is a message', async () => {
    const chat = await agent(relay, relay.chatAppToken(alice), { dialogs: false, cards: true });
    const resource = (await chat.readResource('ui://klatsch/card.html')).contents[0] as { _meta?: { ui?: { permissions?: unknown } } };
    assert.deepEqual(resource._meta?.ui?.permissions, { microphone: {} });
    const shown = await chat.call('conversation', { handle: '@eve' });
    const key = shown.meta['dev.klatsch/card'].key;
    const sent = await chat.call('klatsch_card', { key, decision: 'reply', text: '', voice: true, files: [{ name: 'voice-note.webm', data: Buffer.from(WEBM).toString('base64') }] });
    assert.equal(sent.isError, false, sent.raw);
    const last = relay.klatsch.conversation(eve, '@alice').messages.at(-1)!;
    assert.equal(last.text, '🎤 Voice note');
    assert.equal(last.files[0]!.mime, 'audio/webm');
    // Nothing at all from the card is still refused.
    assert.equal((await chat.call('klatsch_card', { key, decision: 'reply', text: '' })).isError, true);
    await chat.close();
  });

  it('a guest has no microphone button (guests send no files)', async () => {
    const a = relay.klatsch.startGuest();
    const link = relay.klatsch.friendCircle(a);
    const b = relay.klatsch.startGuest();
    relay.klatsch.addMember(link, b, a);
    const guest = await browser(relay, relay.loginLink(a));
    const page = await guest.get(`/ui/chat/${relay.klatsch.user(b).handle}`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.html, /data-record|record\.js/);
  });
});
