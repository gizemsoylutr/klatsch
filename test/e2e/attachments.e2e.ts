// Files with a direct question and its answer: Alice adds a photo to her question, Eve answers with a voice note;
// only the two of them can open them; the type comes from the bytes; sizes and counts are bounded; sealed at rest.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, personAt, startRelay, type Browser, type Relay } from './harness.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3, 4]);
const OGG = new Uint8Array([...'OggS'].map((c) => c.charCodeAt(0)).concat(Array(40).fill(7)));

describe('attachments: a photo with the question, a voice note with the answer, for the two of them only', () => {
  let relay: Relay;
  let alice = '', eve = '', frank = '';
  let aliceBrowser: Browser, eveBrowser: Browser, frankBrowser: Browser;
  let askId = '';

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    eve = relay.klatsch.ensureUser('eve', 'Eve');
    frank = relay.klatsch.ensureUser('frank', 'Frank');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('pair', alice), eve, alice);
    relay.klatsch.ensureCircle('elsewhere', frank);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    eveBrowser = await browser(relay, relay.loginLink(eve));
    frankBrowser = await browser(relay, relay.loginLink(frank));
    const aliceAgent = await agent(relay, relay.agentToken(alice), personAt(aliceBrowser, 'approved'));
    askId = (await aliceAgent.call('ask_person', { handle: '@eve', question: 'Which plant is this?' })).data.ask_id;
    await aliceAgent.close();
  });
  after(async () => relay.close());

  it('Alice adds a photo to her waiting question; its type is read from the bytes, not the name', async () => {
    assert.ok((await aliceBrowser.post(`/ui/asks/${askId}/attach`)).status >= 400, 'no file, nothing added');
    assert.ok((await aliceBrowser.upload(`/ui/asks/${askId}/attach`, [{ name: 'plant.txt', bytes: PNG, type: 'text/plain' }])).status < 400);
    const [file] = relay.klatsch.attachmentsOf(alice, askId);
    assert.equal(file!.mime, 'image/png');
    assert.equal(file!.name, 'plant.txt');
    const stored = relay.db.prepare('SELECT data, name FROM attachments WHERE id = ?').get(file!.id) as { data: Uint8Array; name: string };
    assert.ok(!Buffer.from(stored.data).includes(Buffer.from(PNG.subarray(0, 8))), 'sealed at rest');
    assert.match((await eveBrowser.get('/ui')).html, new RegExp(`href="/ui/attachments/${file!.id}"`));
  });

  it('only the two of them open it, sandboxed; a file that is not a photo, PDF or voice note is refused', async () => {
    const id = relay.klatsch.attachmentsOf(alice, askId)[0]!.id;
    const opened = await eveBrowser.fetchRaw(`/ui/attachments/${id}`);
    assert.equal(opened.status, 200);
    assert.equal(opened.headers.get('content-type'), 'image/png');
    assert.match(opened.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(opened.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await opened.arrayBuffer()), PNG);
    assert.equal((await frankBrowser.fetchRaw(`/ui/attachments/${id}`)).status, 404, 'not for someone else');
    assert.ok((await aliceBrowser.upload(`/ui/asks/${askId}/attach`, [{ name: 'evil.html', bytes: new TextEncoder().encode('<html><script>alert(1)</script>       ') }])).status >= 400);
  });

  it('Eve answers with a voice note; Alice hears it; at most 5 MB a file and 3 a side', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 10);
    big.set(PNG);
    assert.ok((await aliceBrowser.upload(`/ui/asks/${askId}/attach`, [{ name: 'big.png', bytes: big }])).status >= 400);
    const answered = await eveBrowser.upload(`/ui/asks/${askId}/answer`, [{ name: 'voice.ogg', bytes: OGG }], { answer: 'A monstera, listen.' });
    assert.equal(answered.status, 200);
    const files = relay.klatsch.attachmentsOf(alice, askId);
    assert.deepEqual(files.map((f) => [f.side, f.mime]), [['question', 'image/png'], ['answer', 'audio/ogg']]);
    assert.ok((await aliceBrowser.get('/ui')).html.includes('voice.ogg'));
    for (let i = 0; i < 2; i++) await eveBrowser.upload(`/ui/asks/${askId}/attach`, [{ name: `more${i}.ogg`, bytes: OGG }]);
    assert.ok((await eveBrowser.upload(`/ui/asks/${askId}/attach`, [{ name: 'fourth.ogg', bytes: OGG }])).status >= 400, 'three a side');
  });

  it('they go with the question, and with the account', () => {
    relay.db.prepare('UPDATE attachments SET expires_at = 1').run();
    assert.deepEqual(relay.klatsch.attachmentsOf(alice, askId), []);
    relay.klatsch.deleteAccount(eve, 'cli');
    assert.equal((relay.db.prepare('SELECT count(*) AS n FROM attachments').get() as { n: number }).n, 0);
    void frank;
  });
});
