// The slow way to an intro: Alice shares without asking, her agent looks for matches later and asks
// for an intro to one; she approves that too. No intro goes out without an approved "looking" sip.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, CODE, personAt, startRelay, type Browser, type Relay } from './harness.ts';

const BOB_TEXT = 'Use a keyset cursor on (created_at, id) and return next_cursor from the route handler.';
const ALICE_TEXT = 'My Node.js API on Postgres returns every row at once.';

describe('request intro: find matches first, then ask for an intro to one', () => {
  let relay: Relay;
  let alice: string, bob: string;
  let aliceAgent: Awaited<ReturnType<typeof agent>>;
  let alicePage: ReturnType<typeof personAt>;
  let bobBrowser: Browser;
  let matchId = '';

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    const circle = relay.klatsch.ensureCircle('demo', alice);
    relay.klatsch.addMember(circle, bob, alice);
    const solved = relay.klatsch.draftSip(bob, { status: 'solved', tags: ['nodejs', 'express'], summary: BOB_TEXT }, 'cli');
    relay.klatsch.approveSip(bob, solved.sipId, 'cli');
    alicePage = personAt(await browser(relay, relay.loginLink(alice)), 'approved');
    aliceAgent = await agent(relay, relay.agentToken(alice), alicePage);
    bobBrowser = await browser(relay, relay.loginLink(bob));
  });
  after(async () => {
    await aliceAgent?.close();
    await relay.close();
  });

  it("find_matches shows a match by tags only, never who solved it or what they wrote", async () => {
    const found = await aliceAgent.call('find_matches', { tags: ['nodejs'] });
    assert.equal(found.data.matches.length, 1);
    matchId = found.data.matches[0].match_id;
    assert.doesNotMatch(found.raw, /Bob|bob/);
    assert.ok(!found.raw.includes(BOB_TEXT));
  });

  it('an intro request without an approved "looking" sip is refused, and no page is opened', async () => {
    const refused = await aliceAgent.call('request_intro', { match_id: matchId });
    assert.equal(refused.isError, true);
    assert.equal(refused.data.error, 'invalid');
    assert.match(refused.data.message, /approved "looking" sip/);
    assert.equal(aliceAgent.dialogs.length, 0);
  });

  it('Alice shares what she is stuck on without asking for an intro', async () => {
    const shared = await aliceAgent.call('update_card', { status: 'looking', tags: ['nodejs'], summary: ALICE_TEXT, ask_for_intro: false });
    assert.equal(shared.data.state, 'shared');
    assert.deepEqual(shared.data.intros, []);
    assert.doesNotMatch(alicePage.seen[0]!.html, /ask whoever solved this for an intro/, 'the page does not mention an intro');
    assert.match((await bobBrowser.get('/ui')).html, /<b>0<\/b> intro requests?<\/li>/, 'Bob hears nothing yet');
  });

  it('her agent asks for an intro to the match; she reads the request on the page and approves it', async () => {
    const asked = await aliceAgent.call('request_intro', { match_id: matchId });
    const page = alicePage.seen[1]!;
    assert.match(page.html, /Ask for an intro\?[\s\S]*nodejs/);
    assert.ok(page.html.includes(ALICE_TEXT), 'she sees which of her sips the other person will read');
    assert.equal(asked.data.state, 'awaiting-solver');
    assert.equal(asked.data.note, 'Your human asked for the intro on the approval page; the other person decides.', 'the second round tells what she just did');
    assert.equal(asked.data.approve_url, undefined, 'and sends nobody to a page');
    assert.doesNotMatch(asked.raw, CODE);
  });

  it('asking again returns the same intro instead of a second request', async () => {
    const dialogs = aliceAgent.dialogs.length;
    const again = await aliceAgent.call('request_intro', { match_id: matchId });
    assert.equal(again.data.state, 'awaiting-solver');
    assert.equal(again.data.note, 'Your human already asked for this intro; the other person decides.', 'no approval in this call: "already"');
    assert.equal(aliceAgent.dialogs.length, dialogs, 'no new approval');
  });

  it("Bob's agent finds the intro request in his inbox, and his dashboard shows it waiting", async () => {
    const bobAgent = await agent(relay, relay.agentToken(bob), { onPage: async () => {} });
    const inbox = await bobAgent.call('inbox');
    assert.ok(inbox.data.events.some((e: { kind: string }) => e.kind === 'intro.requested'));
    assert.doesNotMatch(inbox.raw, /Alice|alice/);
    await bobAgent.close();
    assert.match((await bobBrowser.get('/ui')).html, /<b>1<\/b> intro requests?<\/li>/);
  });
});
