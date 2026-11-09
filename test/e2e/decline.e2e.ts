// A solver says no: on the approval page their agent opened, or from the dashboard. The seeker's agent
// hears "declined" and nobody learns a name.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, personAt, startRelay, type Browser, type Relay } from './harness.ts';

const ALICE_TEXT = 'My Node.js API on Postgres returns every row at once.';

describe('decline: the solvers say no, the seeker hears so, no names are exchanged', () => {
  let relay: Relay;
  let alice: string, bob: string, carol: string;
  let aliceBrowser: Browser, bobBrowser: Browser, carolBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>, bobAgent: Awaited<ReturnType<typeof agent>>;
  let bobDecides: ReturnType<typeof personAt>;
  let intros: string[] = [];
  let bobsIntro = '';

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    carol = relay.klatsch.ensureUser('carol', 'Carol');
    const circle = relay.klatsch.ensureCircle('demo', alice);
    relay.klatsch.addMember(circle, bob, alice);
    relay.klatsch.addMember(circle, carol, alice);
    for (const [solver, text] of [
      [bob, 'Use a keyset cursor and return next_cursor.'],
      [carol, 'Use keyset paging in the route handler.'],
    ] as const) {
      const solved = relay.klatsch.draftSip(solver, { status: 'solved', tags: ['nodejs', 'express'], summary: text }, 'cli');
      relay.klatsch.approveSip(solver, solved.sipId, 'cli');
    }
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobBrowser = await browser(relay, relay.loginLink(bob));
    carolBrowser = await browser(relay, relay.loginLink(carol));
    bobDecides = personAt(bobBrowser, 'declined');
  });
  after(async () => {
    await Promise.all([aliceAgent?.close(), bobAgent?.close()]);
    await relay.close();
  });

  it("Alice shares what she is stuck on; intro requests go to both people who solved it", async () => {
    aliceAgent = await agent(relay, relay.agentToken(alice), personAt(aliceBrowser, 'approved'));
    const shared = await aliceAgent.call('update_card', { status: 'looking', tags: ['nodejs'], summary: ALICE_TEXT });
    assert.equal(shared.data.state, 'shared');
    intros = shared.data.intros;
    assert.equal(intros.length, 2);
  });

  it("Bob's agent asks him; he reads her sip on the page and declines it there", async () => {
    bobAgent = await agent(relay, relay.agentToken(bob), bobDecides);
    const inbox = await bobAgent.call('inbox');
    bobsIntro = inbox.data.events.find((e: { kind: string }) => e.kind === 'intro.requested').ref;
    const answered = await bobAgent.call('respond_intro', { intro_id: bobsIntro });
    assert.ok(bobDecides.seen[0]!.html.includes(ALICE_TEXT));
    assert.equal(answered.data.state, 'declined', "Bob's agent learns only the outcome");
    assert.doesNotMatch(answered.raw, /Alice/);
  });

  it('a declined intro cannot be answered again', async () => {
    const again = await bobAgent.call('respond_intro', { intro_id: bobsIntro });
    assert.equal(again.isError, true);
    assert.equal(again.data.error, 'forbidden');
  });

  it('Carol declines from her dashboard, where she also reads the sip but not the name', async () => {
    const dashboard = (await carolBrowser.get('/ui')).html;
    assert.ok(dashboard.includes(ALICE_TEXT));
    assert.doesNotMatch(dashboard, /Alice/);
    const introId = dashboard.match(/\/ui\/intros\/([\w-]+)\/decline/)?.[1];
    assert.ok(introId);
    assert.equal((await carolBrowser.post(`/ui/intros/${introId}/decline`)).status, 303);
    assert.equal((await carolBrowser.post(`/ui/intros/${introId}/approve`)).status, 409, 'a declined intro cannot be accepted afterwards');
  });

  it("Alice's agent hears both intros were declined, and nothing about who", async () => {
    const inbox = await aliceAgent.call('inbox');
    const declined = inbox.data.events.filter((e: { kind: string }) => e.kind === 'intro.declined');
    assert.deepEqual(declined.map((e: { ref: string }) => e.ref).sort(), [...intros].sort());
    assert.doesNotMatch(inbox.raw, /Bob|Carol|bob|carol/);
  });

  it('no browser shows anyone else\'s name', async () => {
    assert.doesNotMatch((await aliceBrowser.get('/ui')).html, /Bob|Carol/);
    assert.doesNotMatch((await bobBrowser.get('/ui')).html, /Alice/);
    assert.doesNotMatch((await carolBrowser.get('/ui')).html, /Alice/);
  });
});
