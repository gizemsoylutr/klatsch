// The approval page opens in a browser that is not signed in yet. The relay remembers the page, the human
// follows a fresh login link, lands on that same approval and decides it there; the agent gets the outcome.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, startRelay, type Relay } from './harness.ts';

const ALICE_TEXT = 'My Node.js API on Postgres returns every row at once.';

describe('return after sign-in: an approval opened signed out is decided after the login link', () => {
  let relay: Relay;
  let alice: string;
  const seen: { status: number; html: string; location?: string | null }[] = [];
  let shared: Awaited<ReturnType<Awaited<ReturnType<typeof agent>>['call']>>;

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('demo', alice);
  });
  after(async () => {
    await relay.close();
  });

  it("Alice's agent asks to share; the page opens in a browser without a session", async () => {
    const aliceAgent = await agent(relay, relay.agentToken(alice), {
      onPage: async (url) => {
        // As a browser opens a link from another app: no session yet, Sec-Fetch-Site none.
        const signedOut = await fetch(url, { headers: { 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
        const next = (signedOut.headers.get('set-cookie') ?? '').split(';')[0]!;
        seen.push({ status: signedOut.status, html: await signedOut.text() });
        // The login link, followed in that browser, carries the remembered page.
        const login = await fetch(relay.loginLink(alice), { headers: { Cookie: next }, redirect: 'manual' });
        const session = (login.headers.getSetCookie().find((c) => c.startsWith('klatsch_session=')) ?? '').split(';')[0]!;
        seen.push({ status: login.status, html: '', location: login.headers.get('location') });
        const page = await fetch(new URL(login.headers.get('location') ?? '/ui', relay.base), { headers: { Cookie: session } });
        const html = await page.text();
        seen.push({ status: page.status, html });
        const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? '';
        const decided = await fetch(`${url}/decide`, {
          method: 'POST',
          headers: { Cookie: session, Origin: relay.base, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf, decision: 'approved' }).toString(),
        });
        seen.push({ status: decided.status, html: await decided.text() });
      },
    });
    shared = await aliceAgent.call('update_card', { status: 'looking', tags: ['nodejs', 'express'], summary: ALICE_TEXT, ask_for_intro: false });
    await aliceAgent.close();
    assert.equal(seen[0]!.status, 401);
    assert.ok(!seen[0]!.html.includes(ALICE_TEXT), 'nothing is shown before signing in');
  });

  it('she follows a fresh login link and lands on that approval, not on the dashboard', () => {
    assert.equal(seen[1]!.status, 303);
    assert.match(seen[1]!.location ?? '', /^\/ui\/approvals\/[\w-]+$/);
    assert.equal(seen[2]!.status, 200);
    assert.ok(seen[2]!.html.includes(ALICE_TEXT), 'the page shows exactly what will be shared');
  });

  it('she decides there, and the agent gets the outcome', () => {
    assert.equal(seen[3]!.status, 200);
    assert.equal(shared.data.state, 'shared');
  });
});
