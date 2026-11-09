// Circles grow by invite links and shrink when the owner removes someone. A removed person's agent stops
// working, their sips stop matching, and only an invite the owner made after the removal brings them back.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, personAt, startRelay, unauthorized, type Browser, type Relay } from './harness.ts';

const inviteToken = (html: string) => html.match(/\/ui\/invite\/([\w-]+)/)?.[1] ?? '';

describe('invites and removal: the owner invites Carol, then removes her', () => {
  let relay: Relay;
  let alice: string, bob: string, carol: string, dave: string;
  let circle = '';
  let aliceBrowser: Browser, bobBrowser: Browser, carolBrowser: Browser;
  let bobAgent: Awaited<ReturnType<typeof agent>>, carolAgent: Awaited<ReturnType<typeof agent>>;
  let carolToken = '';
  let token = '';
  let staleInvite = '';

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    carol = relay.klatsch.ensureUser('carol', 'Carol');
    dave = relay.klatsch.ensureUser('dave', 'Dave');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', alice), bob, alice);
    const looking = relay.klatsch.draftSip(bob, { status: 'looking', tags: ['nodejs'], summary: 'Paging returns every row.' }, 'cli');
    relay.klatsch.approveSip(bob, looking.sipId, 'cli');
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobBrowser = await browser(relay, relay.loginLink(bob));
    carolBrowser = await browser(relay, relay.loginLink(carol));
    bobAgent = await agent(relay, relay.agentToken(bob), { onPage: async () => {} });
  });
  after(async () => {
    await Promise.all([bobAgent?.close(), carolAgent?.close().catch(() => {})]);
    await relay.close();
  });

  it('Alice, the owner, sees her circle and invites someone; the link is shown once', async () => {
    const page = await aliceBrowser.get('/ui/circle');
    assert.match(page.html, /demo <span>· 2 people<\/span>/);
    circle = page.html.match(/\/ui\/circles\/([\w-]+)\/invites/)?.[1] ?? '';
    const invited = await aliceBrowser.post(`/ui/circles/${circle}/invites`);
    assert.equal(invited.status, 200);
    assert.match(invited.html, /shown only now/);
    token = inviteToken(invited.html);
    assert.ok(token);
    assert.ok(!(await aliceBrowser.get('/ui/circle')).html.includes(token), 'the circle page does not show it again');
  });

  it('Carol opens the link signed in, sees who invites her to which circle, and joins', async () => {
    const shown = await carolBrowser.get(`/ui/invite/${token}`);
    assert.equal(shown.status, 200);
    assert.match(shown.html, /<strong>Alice<\/strong> \(@alice\) invites you to <strong>demo<\/strong>/);
    const joined = await carolBrowser.post(`/ui/invite/${token}`);
    assert.match(joined.html, /You joined <strong>demo<\/strong>/);
  });

  it('the invite works once', async () => {
    const daveBrowser = await browser(relay, relay.loginLink(dave));
    assert.equal((await daveBrowser.get(`/ui/invite/${token}`)).status, 404);
    assert.equal((await daveBrowser.post(`/ui/invite/${token}`)).status, 404);
  });

  it('the member tree shows Carol under Alice; only the owner gets remove buttons', async () => {
    const tree = (await aliceBrowser.get('/ui/circle')).html;
    assert.match(tree, /demo <span>· 3 people<\/span>/);
    assert.match(tree, /<span class="t">Alice<\/span>[\s\S]*<ul class="list">[\s\S]*<span class="t">Carol<\/span>/);
    assert.ok(tree.includes(`/ui/circles/${circle}/members/${carol}/remove`));
    assert.ok(!(await bobBrowser.get('/ui/circle')).html.includes('/remove'));
  });

  it("Carol's agent shares a solution, and it matches what Bob is looking for", async () => {
    carolToken = relay.agentToken(carol);
    carolAgent = await agent(relay, carolToken, personAt(carolBrowser, 'approved'));
    const shared = await carolAgent.call('update_card', { status: 'solved', tags: ['nodejs'], summary: 'Return next_cursor.' });
    assert.equal(shared.data.state, 'shared');
    assert.equal((await bobAgent.call('find_matches', { tags: ['nodejs'] })).data.matches.length, 1);
  });

  it('a member who is not the owner cannot remove anyone', async () => {
    assert.equal((await bobBrowser.post(`/ui/circles/${circle}/members/${carol}/remove`)).status, 409);
  });

  it('Alice invites again before deciding to remove Carol', async () => {
    staleInvite = inviteToken((await aliceBrowser.post(`/ui/circles/${circle}/invites`)).html);
    assert.ok(staleInvite);
  });

  it('Alice removes Carol from the circle', async () => {
    assert.equal((await aliceBrowser.post(`/ui/circles/${circle}/members/${carol}/remove`)).status, 303);
    assert.match((await aliceBrowser.get('/ui/circle')).html, /demo <span>· 2 people<\/span>/);
  });

  it("Carol's agent token stops working at /mcp", async () => {
    await assert.rejects(carolAgent.call('inbox'), unauthorized);
    const direct = await fetch(`${relay.base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${carolToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(direct.status, 401);
  });

  it('her browser session ends with it', async () => {
    assert.equal((await carolBrowser.get('/ui')).status, 401);
  });

  it("Carol's sips stop matching", async () => {
    assert.equal((await bobAgent.call('find_matches', { tags: ['nodejs'] })).data.matches.length, 0);
  });

  it("neither a member's invite nor one the owner made before the removal lets her back in", async () => {
    carolBrowser = await browser(relay, relay.loginLink(carol));
    const bobsInvite = inviteToken((await bobBrowser.post(`/ui/circles/${circle}/invites`)).html);
    for (const invite of [bobsInvite, staleInvite]) {
      assert.equal((await carolBrowser.get(`/ui/invite/${invite}`)).status, 404);
      assert.equal((await carolBrowser.post(`/ui/invite/${invite}`)).status, 404);
    }
  });

  it('an invite the owner makes after the removal re-admits her', async () => {
    const fresh = inviteToken((await aliceBrowser.post(`/ui/circles/${circle}/invites`)).html);
    assert.match((await carolBrowser.post(`/ui/invite/${fresh}`)).html, /You joined <strong>demo<\/strong>/);
    assert.match((await aliceBrowser.get('/ui/circle')).html, /demo <span>· 3 people<\/span>/);
    await assert.rejects(agent(relay, carolToken), unauthorized, 'her old token stays revoked');
  });
});
