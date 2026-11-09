// The human's dashboard: drafts made in the terminal (`klatsch up --demo` seeds them) are approved or
// rejected there, an intro is accepted there, a sip is retired there, and the person signs out there.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, personAt, startRelay, type Browser, type Relay } from './harness.ts';

const SOLVED = 'Use a keyset cursor on (created_at, id) and return next_cursor from the route handler.';
const FLAGGED = 'Fixed it on prod-erp.acme.internal by raising the batch size.';

describe('dashboard: drafts, intros and the card, decided in the browser', () => {
  let relay: Relay;
  let alice: string;
  let aliceBrowser: Browser;
  let bobAgent: Awaited<ReturnType<typeof agent>>;
  let solved = '', flagged = '';
  const matches = async () => (await bobAgent.call('find_matches', { tags: ['nodejs'] })).data.matches.length;

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    const bob = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', alice), bob, alice);
    solved = relay.klatsch.draftSip(alice, { status: 'solved', tags: ['nodejs', 'express'], summary: SOLVED }, 'cli').sipId;
    flagged = relay.klatsch.draftSip(alice, { status: 'solved', tags: ['nodejs'], summary: FLAGGED }, 'cli').sipId;
    const looking = relay.klatsch.draftSip(bob, { status: 'looking', tags: ['nodejs'], summary: 'Paging returns every row.' }, 'cli');
    relay.klatsch.approveSip(bob, looking.sipId, 'cli');
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobAgent = await agent(relay, relay.agentToken(bob), personAt(await browser(relay, relay.loginLink(bob)), 'approved'));
  });
  after(async () => {
    await bobAgent?.close();
    await relay.close();
  });

  it('drafts wait on the dashboard, with a warning on identifiers, and match nobody yet', async () => {
    const page = (await aliceBrowser.get('/ui')).html;
    assert.match(page, /<b>2<\/b> drafts?<\/li>/);
    assert.ok(page.includes(SOLVED) && page.includes(FLAGGED));
    assert.match(page, /Check before sharing: <code>hostname: prod-erp\.acme\.internal<\/code>/);
    assert.equal(await matches(), 0);
  });

  it('Alice approves one draft, with "Ask me first" picked next to Share: it goes on her card and matches', async () => {
    assert.match((await aliceBrowser.get('/ui')).html, new RegExp(`name="visibility" value="ask" form="share-${solved}" checked />`), 'the draft proposed nothing, so ask first is picked');
    assert.equal((await aliceBrowser.post(`/ui/sips/${solved}/approve`, { visibility: 'ask' })).status, 303);
    assert.match((await aliceBrowser.get('/ui')).html, /<span class="pill">ask me first<\/span>/);
    assert.match((await aliceBrowser.get('/ui')).html, /Your card <em>1<\/em>/);
    assert.equal(await matches(), 1);
  });

  it('she rejects the flagged one; a rejected draft cannot be approved later', async () => {
    assert.equal((await aliceBrowser.post(`/ui/sips/${flagged}/reject`)).status, 303);
    const page = (await aliceBrowser.get('/ui')).html;
    assert.match(page, /<b>0<\/b> drafts?<\/li>/);
    assert.ok(!page.includes(FLAGGED));
    assert.equal((await aliceBrowser.post(`/ui/sips/${flagged}/approve`)).status, 409);
    assert.equal(await matches(), 1);
  });

  it("Bob's agent asks for an intro; Alice accepts it from her dashboard; his agent learns her handle only", async () => {
    const found = await bobAgent.call('find_matches', { tags: ['nodejs'] });
    const asked = await bobAgent.call('request_intro', { match_id: found.data.matches[0].match_id });
    assert.equal(asked.data.state, 'awaiting-solver');
    assert.equal((await aliceBrowser.post(`/ui/intros/${asked.data.intro_id}/approve`)).status, 303);
    assert.match((await aliceBrowser.get('/ui')).html, /<span class="t">Bob<\/span> <span class="m">@bob<\/span>/);
    const inbox = await bobAgent.call('inbox');
    assert.equal(inbox.data.events.find((e: { kind: string }) => e.kind === 'intro.accepted')?.with, '@alice');
    assert.doesNotMatch(inbox.raw.replaceAll('@alice', ''), /Alice|alice/, 'the handle, never the name');
  });

  it('Alice retires the sip; it stops matching', async () => {
    assert.equal((await aliceBrowser.post(`/ui/sips/${solved}/retire`)).status, 303);
    assert.match((await aliceBrowser.get('/ui')).html, /Your card <em>0<\/em>/);
    assert.equal(await matches(), 0);
    assert.equal((await aliceBrowser.post(`/ui/sips/${solved}/retire`)).status, 409, 'retiring twice is refused');
  });

  it('the bare relay address shows a browser what Klatsch is, with Sign in and GitHub links; other clients get one plain line', async () => {
    const opened = await fetch(new URL('/', relay.base), { headers: { Accept: 'text/html' }, redirect: 'manual' });
    assert.equal(opened.status, 200);
    assert.match(opened.headers.get('content-security-policy') ?? '', /^default-src 'none'; style-src 'unsafe-inline';/);
    assert.equal(opened.headers.get('x-content-type-options'), 'nosniff');
    const page = await opened.text();
    assert.match(page, /<h1>Your circle <span>already knows\.<\/span><\/h1>/);
    assert.match(page, /<a class="btn primary lg" href="\/ui">Sign in<\/a>/, 'no GitHub app here, so the button just says Sign in');
    assert.match(page, /<a class="sp" href="https:\/\/github.com\/gizemsoylutr\/klatsch">GitHub<\/a>/);
    assert.match(page, /<figcaption>Example: [^<]+<\/figcaption>\s*<div class="stage" aria-hidden="true">/, 'the terminal and the approval page are an illustration');
    assert.doesNotMatch(page, /<script|<form/, 'no scripts, nothing to post');
    const plain = await fetch(new URL('/', relay.base));
    assert.equal(await plain.text(), 'Klatsch relay. Agents use /mcp, humans use /ui.');
  });

  it('Alice signs out; her browser is no longer signed in', async () => {
    const out = await aliceBrowser.post('/ui/logout');
    assert.equal(out.status, 200);
    assert.match(out.html, /Signed out\./);
    assert.equal((await aliceBrowser.get('/ui')).status, 401);
  });
});
