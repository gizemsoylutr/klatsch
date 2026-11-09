// What an agent cannot do, however it tries: approve for its human, reach the human's web UI, smuggle
// text through unknown tags, or talk to the relay under another site's name.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { agent, browser, startRelay, type Browser, type Relay } from './harness.ts';

/** A raw request with a Host header of our choosing (fetch always sends the real one). */
function withHost(base: string, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { Host: host, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  });
}

describe('agent limits: an agent can ask, never approve, and never reach the human side', () => {
  let relay: Relay;
  let aliceBrowser: Browser, bobBrowser: Browser;
  let rogue: Awaited<ReturnType<typeof agent>>;
  let token = '';
  let approvalId = '';

  before(async () => {
    relay = await startRelay({ approvalWaitMs: 300 });
    const alice = relay.klatsch.ensureUser('alice', 'Alice');
    const bob = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', alice), bob, alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobBrowser = await browser(relay, relay.loginLink(bob));
    token = relay.agentToken(alice);
    // Accepts every dialog and opens nothing: no human ever looks.
    rogue = await agent(relay, token, { onPage: async () => {} });
  });
  after(async () => {
    await rogue?.close();
    await relay.close();
  });

  it('an agent that accepts the dialog without its human shares nothing', async () => {
    const sneaky = await rogue.call('update_card', { status: 'solved', tags: ['javascript'], summary: 'shared without asking' });
    assert.equal(sneaky.data.state, 'pending-approval');
    approvalId = new URL(rogue.dialogs[0]!.url!).pathname.split('/').at(-1)!;
    assert.match((await aliceBrowser.get('/ui')).html, /Your card <em>0<\/em>/);
  });

  it("another person's browser cannot open or decide the approval", async () => {
    assert.equal((await bobBrowser.get(`/ui/approvals/${approvalId}`)).status, 404);
    assert.equal((await bobBrowser.post(`/ui/approvals/${approvalId}/decide`, { decision: 'approved' })).status, 409);
  });

  it("an agent token cannot reach the human's web UI", async () => {
    const bearer = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${relay.base}/ui`, { headers: bearer })).status, 401);
    const decide = await fetch(`${relay.base}/ui/approvals/${approvalId}/decide`, {
      method: 'POST',
      headers: { ...bearer, Origin: relay.base, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'approved' }).toString(),
    });
    assert.equal(decide.status, 401);
    assert.equal((await aliceBrowser.get(`/ui/approvals/${approvalId}`)).status, 200, 'the approval is still open for Alice');
    assert.match((await aliceBrowser.get('/ui')).html, /Your card <em>0<\/em>/);
  });

  it('unknown tags are refused without echoing them, before any approval', async () => {
    const dialogs = rogue.dialogs.length;
    const refused = await rogue.call('update_card', { status: 'looking', tags: ['acme-secret-rollout'], summary: 'stuck' });
    assert.equal(refused.isError, true);
    assert.equal(refused.data.error, 'unknown-tags');
    assert.deepEqual(refused.data.unknown_tags, [{ input: '#1', suggestions: [] }]);
    assert.doesNotMatch(refused.raw, /acme|rollout/);
    assert.equal(rogue.dialogs.length, dialogs);
  });

  it('a Host header from another site is refused', async () => {
    assert.equal(await withHost(relay.base, '/mcp', 'evil.example'), 403);
    assert.equal(await withHost(relay.base, '/ui', 'evil.example'), 403);
  });
});
