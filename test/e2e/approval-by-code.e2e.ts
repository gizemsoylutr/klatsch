// A client that shows no dialogs: the agent gets a code to show its human, who types it at
// /ui/device in their own browser and decides there. The agent learns the outcome from its inbox.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, CODE, startRelay, type Browser, type Relay } from './harness.ts';

const ALICE_TEXT = 'My Node.js API on Postgres returns every row at once.';

describe('approval by code: no dialog, the human types the code in their browser', () => {
  let relay: Relay;
  let alice: string;
  let aliceBrowser: Browser, bobBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>;
  let code = '';

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    const bob = relay.klatsch.ensureUser('bob', 'Bob');
    const circle = relay.klatsch.ensureCircle('demo', alice);
    relay.klatsch.addMember(circle, bob, alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobBrowser = await browser(relay, relay.loginLink(bob));
    aliceAgent = await agent(relay, relay.agentToken(alice), { dialogs: false });
  });
  after(async () => {
    await aliceAgent?.close();
    await relay.close();
  });

  it('the agent asks to share and gets a code and the page to enter it on, nothing shared yet', async () => {
    const asked = await aliceAgent.call('update_card', { status: 'looking', tags: ['nodejs'], summary: ALICE_TEXT });
    assert.equal(asked.data.state, 'pending-approval');
    assert.equal(asked.data.approve_url, `${relay.base}/ui/device`);
    assert.match(asked.data.code, CODE);
    code = asked.data.code;
    assert.doesNotMatch((await aliceBrowser.get('/ui')).html, /Your card <em>[1-9]/, 'nothing on her card');
    assert.ok(!relay.klatsch.sipsOf(alice).some((s) => s.state === 'approved'), 'nothing shared');
  });

  it('Alice opens the page from her dashboard', async () => {
    assert.match((await aliceBrowser.get('/ui')).html, /href="\/ui\/device"/);
    assert.match((await aliceBrowser.get('/ui/device')).html, /Enter the code your agent showed/);
  });

  it('a wrong code finds nothing', async () => {
    const wrong = await aliceBrowser.post('/ui/device', { code: 'BBBB-CCCC' });
    assert.equal(wrong.status, 404);
    assert.match(wrong.html, /No open request with this code\. Check it in your terminal; codes last 10 minutes\./);
  });

  it("the code does nothing in another person's browser", async () => {
    const foreign = await bobBrowser.post('/ui/device', { code });
    assert.equal(foreign.status, 404);
    assert.match(foreign.html, /No open request with this code\./, 'the same line as for a wrong code');
    assert.ok(!foreign.html.includes(ALICE_TEXT));
    assert.equal((await bobBrowser.post('/ui/device/decide', { code, decision: 'approved' })).status, 409);
  });

  it('Alice enters the code, reads exactly what will be shared, and approves', async () => {
    const shown = await aliceBrowser.post('/ui/device', { code: code.toLowerCase().replace('-', ' ') });
    assert.equal(shown.status, 200, 'the code is forgiving about case and separators');
    assert.ok(shown.html.includes(ALICE_TEXT));
    const decided = await aliceBrowser.post('/ui/device/decide', { code, decision: 'approved' });
    assert.equal(decided.status, 200);
    assert.match(decided.html, /Shared\./);
    assert.match((await aliceBrowser.get('/ui')).html, /Your card <em>1<\/em>/);
  });

  it('the agent learns the outcome from its inbox, without the text', async () => {
    const inbox = await aliceAgent.call('inbox');
    assert.ok(inbox.data.events.some((e: { kind: string }) => e.kind === 'approval.approved'));
    assert.doesNotMatch(inbox.raw, CODE);
    assert.ok(!inbox.raw.includes(ALICE_TEXT));
  });

  it('a used code cannot decide again', async () => {
    assert.equal((await aliceBrowser.post('/ui/device', { code })).status, 404);
    assert.equal((await aliceBrowser.post('/ui/device/decide', { code, decision: 'declined' })).status, 409);
  });

  it('an expired approval cannot be decided', async () => {
    const asked = await aliceAgent.call('update_card', { status: 'solved', tags: ['express'], summary: 'Paged with a keyset cursor.' });
    // Ten minutes pass.
    relay.db.prepare('UPDATE approvals SET expires_at = ? WHERE state = ?').run(Date.now() - 1, 'pending');
    assert.equal((await aliceBrowser.post('/ui/device', { code: asked.data.code })).status, 404);
    assert.equal((await aliceBrowser.post('/ui/device/decide', { code: asked.data.code, decision: 'approved' })).status, 409);
    assert.match((await aliceBrowser.get('/ui')).html, /Your card <em>1<\/em>/, 'nothing more was shared');
  });

  it("a decline in the browser reaches the agent's inbox too", async () => {
    const asked = await aliceAgent.call('update_card', { status: 'solved', tags: ['express'], summary: 'Paged with a keyset cursor.' });
    await aliceBrowser.post('/ui/device', { code: asked.data.code });
    assert.match((await aliceBrowser.post('/ui/device/decide', { code: asked.data.code, decision: 'declined' })).html, /Not this time\./);
    const inbox = await aliceAgent.call('inbox');
    assert.ok(inbox.data.events.some((e: { kind: string }) => e.kind === 'approval.declined'));
  });
});
