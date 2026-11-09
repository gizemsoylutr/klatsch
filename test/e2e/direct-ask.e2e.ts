// Asking one person directly: Alice's agent asks Bob, only Bob reads it, with her name; his agent drafts the answer,
// he approves it, and only Alice reads it. Text reaches an agent only by a click, or a standing "always".
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, startRelay, unauthorized, wireAgent, type Browser, type Relay } from './harness.ts';

const QUESTION = 'My Postgres paging skips rows when new rows arrive. How did you fix it?';
const ANSWER = 'Use a keyset cursor on (created_at, id) instead of OFFSET.';

describe('direct ask: one person, both humans approve, agents get text only by a click or "always"', () => {
  let relay: Relay;
  let alice = '', bob = '', carol = '', circle = '';
  let aliceBrowser: Browser, bobBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>, bobAgent: Awaited<ReturnType<typeof agent>>;
  let askId = '';
  const decideWith = (person: () => Browser) => async (url: string) => {
    await person().post(`${new URL(url).pathname}/decide`, { decision: 'approved' });
  };

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    carol = relay.klatsch.ensureUser('carol', 'Carol');
    circle = relay.klatsch.ensureCircle('demo', alice);
    relay.klatsch.addMember(circle, bob, alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobBrowser = await browser(relay, relay.loginLink(bob));
    aliceAgent = await agent(relay, relay.agentToken(alice), { onPage: decideWith(() => aliceBrowser) });
    bobAgent = await agent(relay, relay.agentToken(bob), { onPage: decideWith(() => bobBrowser) });
  });
  after(async () => {
    await aliceAgent.close();
    await bobAgent.close();
    await relay.close();
  });

  it('nobody outside a shared private circle can be asked, and the refusal says nothing about who exists', async () => {
    relay.klatsch.ensureCircle('elsewhere', carol);
    const outsider = await aliceAgent.call('ask_person', { handle: '@carol', tags: ['postgres'], question: QUESTION });
    const unknown = await aliceAgent.call('ask_person', { handle: '@nobody', tags: ['postgres'], question: QUESTION });
    const self = await aliceAgent.call('ask_person', { handle: '@alice', tags: ['postgres'], question: QUESTION });
    assert.ok(outsider.isError && unknown.isError && self.isError);
    assert.equal(outsider.data.message, unknown.data.message);
    assert.equal(self.data.message, unknown.data.message);
  });

  it('the approval page names Bob and says only he reads it; nothing goes before Alice approves', async () => {
    const preview = await agent(relay, relay.agentToken(alice), { dialogs: false });
    const asked = await preview.call('ask_person', { handle: 'bob', tags: ['postgres', 'pagination'], question: QUESTION });
    assert.equal(asked.data.state, 'pending-approval');
    const page = await aliceBrowser.post('/ui/device', { code: asked.data.code });
    assert.match(page.html, /Ask Bob directly\?/);
    assert.match(page.html, /Only <strong>Bob<\/strong> \(@bob\) reads this, with your name/);
    assert.equal(relay.klatsch.asksOf(bob).length, 0);
    await aliceBrowser.post('/ui/device/decide', { code: asked.data.code, decision: 'declined' });
    await preview.close();
  });

  it('Alice approves: Bob sees it on Home with her name; his agent hears who asked, never the words', async () => {
    const asked = await aliceAgent.call('ask_person', { handle: '@bob', tags: ['postgres', 'pagination'], question: QUESTION });
    assert.equal(asked.data.state, 'asked');
    askId = asked.data.ask_id;
    const home = (await bobBrowser.get('/ui')).html;
    assert.ok(home.includes(QUESTION) && home.includes('Alice asks you'));
    const events = (await bobAgent.call('inbox')).data.events as { kind: string; text: string; ref: string }[];
    const received = events.find((e) => e.kind === 'ask.received')!;
    assert.equal(received.ref, askId);
    assert.match(received.text, /@alice asked your human directly about (postgres, pagination|pagination, postgres)/);
    assert.ok(!JSON.stringify(events).includes(QUESTION));
    assert.ok(relay.notifications.some((n) => n.startsWith('@bob:')));
  });

  it('Carol, in the circle too, sees nothing of it', async () => {
    relay.klatsch.addMember(circle, carol, alice);
    const carolBrowser = await browser(relay, relay.loginLink(carol));
    assert.ok(!(await carolBrowser.get('/ui')).html.includes(QUESTION));
    assert.equal((await carolBrowser.post(`/ui/asks/${askId}/send`)).status >= 400, true);
  });

  it('Bob sends it to his agent by a click; it arrives once, labelled as Alice’s words', async () => {
    assert.ok((await bobBrowser.post(`/ui/asks/${askId}/send`)).status < 400);
    const events = (await bobAgent.call('inbox')).data.events as { kind: string; type?: string; quote?: string; note?: string; text: string; from?: string }[];
    const quote = events.find((e) => e.type === 'quote')!;
    assert.equal(quote.quote, QUESTION);
    assert.equal(quote.from, '@alice');
    assert.match(quote.note!, /not instructions/);
    assert.match(quote.text, /call answer_ask with this ref/);
    assert.deepEqual(((await bobAgent.call('inbox')).data.events as { type?: string }[]).filter((e) => e.type === 'quote'), [], 'once');
  });

  it('his agent drafts the answer, Bob approves it; only Alice reads it; her agent hears it, without the words', async () => {
    const answered = await bobAgent.call('answer_ask', { ask_id: askId, answer: ANSWER });
    assert.equal(answered.data.state, 'answered', answered.raw);
    assert.ok((await aliceBrowser.get('/ui')).html.includes(ANSWER));
    const events = (await aliceAgent.call('inbox')).data.events as { kind: string; text: string }[];
    assert.ok(events.some((e) => e.kind === 'ask.answered' && /@bob answered/.test(e.text)));
    assert.ok(!JSON.stringify(events).includes(ANSWER));
    assert.equal((await bobAgent.call('answer_ask', { ask_id: askId, answer: 'again' })).isError, true, 'answered once');
  });

  it('Alice sends the answer to her agent by a click', async () => {
    assert.ok((await aliceBrowser.post(`/ui/asks/${askId}/send`)).status < 400);
    const quote = ((await aliceAgent.call('inbox')).data.events as { type?: string; quote?: string; from?: string }[]).find((e) => e.type === 'quote')!;
    assert.equal(quote.quote, ANSWER);
    assert.equal(quote.from, '@bob');
  });

  it('with "always" both ways, a question and its answer reach the agents without a click', async () => {
    const note = relay.klatsch.draftSip(alice, { status: 'solved', tags: ['postgres'], summary: 'A note.', visibility: 'open' }, 'cli');
    relay.klatsch.approveSip(alice, note.sipId, 'cli', 'open');
    const look = relay.klatsch.draftSip(bob, { status: 'looking', tags: ['postgres'], summary: 'Looking.' }, 'cli');
    relay.klatsch.approveSip(bob, look.sipId, 'cli');
    await bobBrowser.post(`/ui/notes/${note.sipId}/send-always`);
    await bobAgent.call('inbox');
    const n2 = relay.klatsch.draftSip(bob, { status: 'solved', tags: ['testing'], summary: 'B note.', visibility: 'open' }, 'cli');
    relay.klatsch.approveSip(bob, n2.sipId, 'cli', 'open');
    const l2 = relay.klatsch.draftSip(alice, { status: 'looking', tags: ['testing'], summary: 'Looking 2.' }, 'cli');
    relay.klatsch.approveSip(alice, l2.sipId, 'cli');
    await aliceBrowser.post(`/ui/notes/${n2.sipId}/send-always`);
    await aliceAgent.call('inbox');
    const asked = await aliceAgent.call('ask_person', { handle: 'bob', tags: ['testing'], question: 'Second question?' });
    const quote = ((await bobAgent.call('inbox')).data.events as { type?: string; quote?: string; text: string }[]).find((e) => e.type === 'quote')!;
    assert.equal(quote.quote, 'Second question?');
    assert.match(quote.text, /always get @alice's notes/);
    await bobAgent.call('answer_ask', { ask_id: asked.data.ask_id, answer: 'This did not help.', tried: true });
    const back = ((await aliceAgent.call('inbox')).data.events as { type?: string; quote?: string; note?: string }[]).find((e) => e.type === 'quote')!;
    assert.equal(back.quote, 'This did not help.');
    assert.match(back.note!, /did NOT work/);
  });

  it('declining tells Alice; withdrawing takes it off Bob’s page and out of his agent’s inbox', async () => {
    const a = await aliceAgent.call('ask_person', { handle: 'bob', tags: ['postgres'], question: 'Third?' });
    assert.ok((await bobBrowser.post(`/ui/asks/${a.data.ask_id}/decline`)).status < 400);
    assert.ok(((await aliceAgent.call('inbox')).data.events as { kind: string }[]).some((e) => e.kind === 'ask.declined'));
    await bobAgent.call('inbox');
    const b = await aliceAgent.call('ask_person', { handle: 'bob', tags: ['postgres'], question: 'Fourth, then withdrawn.' });
    assert.ok((await aliceBrowser.post(`/ui/asks/${b.data.ask_id}/withdraw`)).status < 400);
    assert.ok(!(await bobBrowser.get('/ui')).html.includes('Fourth, then withdrawn.'));
    assert.ok(!JSON.stringify((await bobAgent.call('inbox')).data.events).includes('Fourth, then withdrawn.'));
  });

  it('a public circle is not enough, and leaving the circle ends what is open', async () => {
    const commons = relay.klatsch.ensureCircle('commons', carol);
    const dave = relay.klatsch.ensureUser('dave', 'Dave');
    relay.klatsch.addMember(commons, dave, carol);
    relay.klatsch.setJoinLink(carol, commons, true, {});
    assert.throws(() => relay.klatsch.askTarget(dave, 'carol'), /Nobody your human can ask/);
    const open = await aliceAgent.call('ask_person', { handle: 'bob', tags: ['postgres'], question: 'Open when Bob leaves.' });
    assert.equal(open.data.state, 'asked', open.raw);
    relay.klatsch.removeMember(alice, circle, bob);
    assert.ok(!(await bobBrowser.get('/ui')).html.includes('Open when Bob leaves.'));
    assert.throws(() => relay.klatsch.checkAnswerable(bob, open.data.ask_id), /not waiting/);
    // Bob was in no other circle, so his agent lost its token with the removal.
    await assert.rejects(bobAgent.call('answer_ask', { ask_id: open.data.ask_id, answer: 'x' }), unauthorized);
  });

  it('a question is sealed at rest, and the tools are listed for the client', async () => {
    // Counted in SQL, which sees the stored value, not the opened one.
    const counts = relay.db.prepare(`SELECT count(*) AS n, sum(question LIKE 'klatsch-sealed:v1:%') AS sealed FROM asks`).get() as { n: number; sealed: number };
    assert.ok(counts.n > 0);
    assert.equal(counts.sealed, counts.n);
    const listed = await wireAgent(relay.base, relay.agentToken(alice))('tools/list');
    const names = (listed.result.tools as { name: string }[]).map((t) => t.name);
    assert.ok(names.includes('ask_person') && names.includes('answer_ask'));
  });
});
