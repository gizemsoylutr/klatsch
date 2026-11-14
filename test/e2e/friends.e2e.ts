// Friends: Alice adds Eve with a link she sends by any messenger; Eve opens it and they are friends, a private
// circle of two. Alice's agent asks Eve anything (no tags), Eve types the answer on her page, and it goes straight to
// the agent that asked. Either of them ends the friendship, and then neither can ask the other.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, personAt, startRelay, type Browser, type Relay } from './harness.ts';

const QUESTION = 'Which bakery near the station did you like?';
const ANSWER = 'The small one on the corner, before 9.';

describe('friends: a link, a question about anything, an answer typed by hand that reaches the agent that asked', () => {
  let relay: Relay;
  let alice = '', eve = '', frank = '';
  let aliceBrowser: Browser, eveBrowser: Browser, frankBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>;
  let link = '', friendship = '', askId = '';

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    eve = relay.klatsch.ensureUser('eve', 'Eve');
    frank = relay.klatsch.ensureUser('frank', 'Frank');
    relay.klatsch.ensureCircle('home', alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    eveBrowser = await browser(relay, relay.loginLink(eve));
    frankBrowser = await browser(relay, relay.loginLink(frank));
    aliceAgent = await agent(relay, relay.agentToken(alice), personAt(aliceBrowser, 'approved'));
  });
  after(async () => {
    await aliceAgent.close();
    await relay.close();
  });

  it('"Add a friend" on the Circle page gives a link, shown once', async () => {
    assert.match((await aliceBrowser.get('/ui/circle')).html, /action="\/ui\/friends\/invite"/);
    const page = await aliceBrowser.post('/ui/friends/invite');
    assert.equal(page.status, 200);
    link = page.html.match(/<code class="cmd">([^<]+)<\/code>/)![1]!;
    assert.match(link, /\/ui\/invite\//);
    assert.match(page.html, /Send this link to your friend/);
  });

  it('Eve opens it: "Add as a friend?", and after one click they are friends, on both pages and for the agent', async () => {
    const path = new URL(link).pathname;
    const invite = await eveBrowser.get(path);
    assert.match(invite.html, /Add as a friend\?/);
    assert.match(invite.html, /<strong>Alice<\/strong> \(@alice\) wants to add you as a friend/);
    assert.ok((await eveBrowser.post(path)).status < 400);
    friendship = relay.klatsch.circlesOf(alice).find((c) => c.pair)!.id;
    assert.match((await aliceBrowser.get('/ui/circle')).html, /Eve <span class="m">@eve<\/span>/);
    assert.match((await eveBrowser.get('/ui/circle')).html, /Alice <span class="m">@alice<\/span>/);
    const friends = await aliceAgent.call('friends');
    assert.deepEqual(friends.data.people, [{ handle: '@eve', friend: true }], 'handles only, never names');
    assert.ok(!friends.raw.includes('Eve'));
    // A friend is there to be asked: a note Alice shares is not matched in the friendship unless she ticks it.
    const scope = relay.klatsch.sharingCircles(alice);
    assert.ok(scope.some((c) => c.pair && c.name === '@eve'));
    const note = relay.klatsch.draftSip(alice, { status: 'solved', tags: ['postgres'], summary: 'A note for the home circle.' }, 'cli');
    relay.klatsch.approveSip(alice, note.sipId, 'cli');
    assert.equal((relay.db.prepare('SELECT count(*) AS n FROM sip_circles WHERE sip_id = ? AND circle_id = ?').get(note.sipId, friendship) as { n: number }).n, 0);
  });

  it('a second link between the same two people adds nothing: they are friends already', async () => {
    const second = (await aliceBrowser.post('/ui/friends/invite')).html.match(/<code class="cmd">([^<]+)<\/code>/)![1]!;
    const answer = await eveBrowser.post(new URL(second).pathname);
    assert.match(answer.html, /You and @alice are already friends\. Nothing changed\./);
    assert.equal(relay.klatsch.circlesOf(alice).filter((c) => c.pair).length, 1);
    assert.equal(relay.klatsch.circlesOf(eve).filter((c) => c.pair).length, 1);
  });

  it('the link worked once, and a friendship takes nobody else', async () => {
    assert.equal((await frankBrowser.get(new URL(link).pathname)).status, 404);
    assert.equal((await eveBrowser.post(`/ui/circles/${friendship}/invites`)).status, 409, 'Eve cannot invite a third person');
    assert.equal((await aliceBrowser.post(`/ui/circles/${friendship}/invites`)).status, 409, 'nor can Alice: it is a circle of two');
    assert.throws(() => relay.klatsch.setJoinLink(alice, friendship, true, {}), /cannot have a public join link/);
    assert.ok((await aliceBrowser.post(`/ui/circles/${friendship}/members/${eve}/remove`)).status >= 400, 'a friendship ends only with Remove friend');
    assert.ok(relay.klatsch.memberRole(eve, friendship));
  });

  it('Alice’s agent asks Eve about anything, without tags; Eve reads it with Alice’s name', async () => {
    const asked = await aliceAgent.call('ask_person', { handle: '@eve', question: QUESTION });
    assert.equal(asked.data.state, 'asked', asked.raw);
    askId = asked.data.ask_id;
    const home = (await eveBrowser.get('/ui')).html;
    assert.ok(home.includes(QUESTION));
    assert.match(home, /action="\/ui\/asks\/[^"]+\/answer"/);
    assert.match(home, /Only @alice reads it, and it goes straight to the AI they asked with\./);
  });

  it('an empty answer sends nothing; Eve’s typed answer goes straight to Alice’s agent', async () => {
    assert.ok((await eveBrowser.post(`/ui/asks/${askId}/answer`, { answer: '   ' })).status >= 400);
    assert.ok((await eveBrowser.post(`/ui/asks/${askId}/answer`, { answer: 'x'.repeat(501) })).status >= 400, 'at most 500 characters');
    assert.ok((await aliceBrowser.post(`/ui/asks/${askId}/answer`, { answer: 'I answer myself.' })).status >= 400, 'only the person asked answers');
    assert.equal(relay.klatsch.asksOf(alice)[0]!.state, 'open', 'nothing was sent');
    const sent = await eveBrowser.post(`/ui/asks/${askId}/answer`, { answer: ANSWER });
    assert.equal(sent.status, 200);
    assert.match(sent.html, /Answer sent/);
    const quote = ((await aliceAgent.call('inbox')).data.events as { type?: string; quote?: string; from?: string; text: string }[]).find((e) => e.type === 'quote')!;
    assert.equal(quote.quote, ANSWER);
    assert.equal(quote.from, '@eve');
    assert.match((await aliceBrowser.get('/ui')).html, /Sent to your AI/);
    assert.ok((await eveBrowser.post(`/ui/asks/${askId}/answer`, { answer: 'again' })).status >= 400, 'answered once');
    await aliceBrowser.post(`/ui/asks/${askId}/send`);
    assert.ok(!JSON.stringify((await aliceAgent.call('inbox')).data.events).includes(ANSWER), 'a click on an old page does not send it twice');
  });

  it('Eve ends the friendship: gone from both pages, and neither can ask the other', async () => {
    assert.ok((await eveBrowser.post(`/ui/friends/${friendship}/end`)).status < 400);
    assert.ok(!(await aliceBrowser.get('/ui/circle')).html.includes('@eve'));
    assert.deepEqual((await aliceAgent.call('friends')).data.people, []);
    assert.equal((await aliceAgent.call('ask_person', { handle: '@eve', question: 'Still there?' })).isError, true);
    assert.equal((await eveBrowser.get('/ui/circle')).status, 200, 'Eve stays signed in, and can add another friend');
    assert.ok((await eveBrowser.post(`/ui/friends/${friendship}/end`)).status >= 400, 'ended once');
    assert.ok((await frankBrowser.post(`/ui/friends/${friendship}/end`)).status >= 400, 'not his');
  });

  it('a waiting link does not let someone back in, an ended friendship frees its place, and the limits hold', async () => {
    // Frank is in no circle: a link nobody opened does not make him a member of anything.
    await frankBrowser.post('/ui/friends/invite');
    assert.equal(relay.klatsch.inAnyCircle(frank), false);
    assert.equal((await frankBrowser.post('/ui/tokens')).status >= 400, true, 'no agent tokens from a lonely link');
    // Twenty waiting links at most; ended or used ones do not count.
    for (let i = 1; i < 20; i++) assert.equal((await frankBrowser.post('/ui/friends/invite')).status, 200);
    const refused = await frankBrowser.post('/ui/friends/invite');
    assert.equal(refused.status, 409);
    assert.match(refused.html, /20 friend links nobody opened yet/);
    const first = relay.klatsch.circlesOf(frank).find((c) => c.pair)!;
    assert.ok((await frankBrowser.post(`/ui/friends/${first.id}/end`)).status < 400);
    assert.equal((await frankBrowser.post('/ui/friends/invite')).status, 200, 'ending one frees its place');
    assert.equal(relay.klatsch.inAnyCircle(frank), false);
  });
});
