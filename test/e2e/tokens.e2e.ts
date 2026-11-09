// Agent tokens from the web UI: Alice connects an agent with the command the page shows once,
// the agent works, she revokes the token on the same page, and the agent is shut out.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, startRelay, unauthorized, type Browser, type Relay } from './harness.ts';

describe('tokens: create in the web UI, use from an agent, revoke in the web UI', () => {
  let relay: Relay;
  let aliceBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>;
  let token = '';
  let tokenId = '';

  before(async () => {
    relay = await startRelay();
    const alice = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('demo', alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
  });
  after(async () => {
    await aliceAgent?.close().catch(() => {});
    await relay.close();
  });

  it('someone in no circle gets no token', async () => {
    const loner = relay.klatsch.ensureUser('dave', 'Dave');
    const daveBrowser = await browser(relay, relay.loginLink(loner));
    assert.equal((await daveBrowser.post('/ui/tokens')).status, 409);
  });

  it('Alice connects an agent: the page shows the Claude Code command with the token, once', async () => {
    assert.match((await aliceBrowser.get('/ui')).html, /href="\/ui\/tokens"/);
    const created = await aliceBrowser.post('/ui/tokens');
    assert.equal(created.status, 200);
    const command = created.html.match(/claude mcp add --scope local --transport http klatsch (\S+)\/mcp --header &quot;Authorization: Bearer (klt_[\w-]+)&quot;/);
    assert.ok(command, 'the page shows the command');
    assert.equal(command[1], relay.base);
    token = command[2]!;
    const listed = (await aliceBrowser.get('/ui/tokens')).html;
    assert.match(listed, /web:\d{4}-\d{2}-\d{2}<\/span> <span class="m">live/);
    assert.ok(!listed.includes(token), 'the list never shows the token again');
    tokenId = listed.match(/\/ui\/tokens\/([\w-]+)\/revoke/)?.[1] ?? '';
    assert.ok(tokenId);
  });

  it('the agent uses the token', async () => {
    aliceAgent = await agent(relay, token, { onPage: async () => {} });
    const inbox = await aliceAgent.call('inbox');
    assert.equal(inbox.isError, false);
  });

  it('Alice revokes it in the web UI', async () => {
    assert.equal((await aliceBrowser.post(`/ui/tokens/${tokenId}/revoke`)).status, 303);
    const listed = (await aliceBrowser.get('/ui/tokens')).html;
    assert.match(listed, /<span class="m">revoked/);
    assert.ok(!listed.includes(`/ui/tokens/${tokenId}/revoke`), 'no revoke button for a revoked token');
    assert.equal((await aliceBrowser.post(`/ui/tokens/${tokenId}/revoke`)).status, 409, 'revoking twice is refused');
  });

  it('the agent now gets 401', async () => {
    await assert.rejects(aliceAgent.call('inbox'), unauthorized);
    await assert.rejects(agent(relay, token), unauthorized, 'and cannot reconnect');
  });
});
