// Deleting an account: Bob asks for it in Settings, types his handle, and everything that was his goes at once,
// including what others saw of it. A circle he owned with others passes on; one with nobody else goes.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, personAt, startRelay, unauthorized, type Browser, type Relay } from './harness.ts';

const BOB_NOTE = 'Use a keyset cursor on (created_at, id) instead of OFFSET when paging Postgres.';
const ALICE_LOOKING = 'Paging a Postgres export skips rows when new rows arrive.';
const QUESTION = 'How did you keep the cursor stable when rows were inserted?';

describe('account deletion: everything of the person goes, others keep working', () => {
  let relay: Relay;
  let alice = '', bob = '', carol = '';
  let aliceBrowser: Browser, bobBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>, bobAgent: Awaited<ReturnType<typeof agent>>;
  let bobsCircle = '', soloCircle = '', introId = '', askId = '';

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    carol = relay.klatsch.ensureUser('carol', 'Carol');
    const demo = relay.klatsch.ensureCircle('demo', alice);
    relay.klatsch.addMember(demo, bob, alice);
    relay.klatsch.addMember(demo, carol, alice);
    const solved = relay.klatsch.draftSip(bob, { status: 'solved', tags: ['postgres', 'pagination'], summary: BOB_NOTE }, 'cli');
    relay.klatsch.approveSip(bob, solved.sipId, 'cli');
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobBrowser = await browser(relay, relay.loginLink(bob));
    aliceAgent = await agent(relay, relay.agentToken(alice), personAt(aliceBrowser, 'approved'));
    bobAgent = await agent(relay, relay.agentToken(bob), personAt(bobBrowser, 'approved'));
  });
  after(async () => {
    await Promise.all([aliceAgent?.close(), bobAgent?.close()]);
    await relay.close();
  });

  it('before: Alice and Bob share an intro and a question, so there is something of Bob on her side', async () => {
    const shared = await aliceAgent.call('update_card', { status: 'looking', tags: ['postgres', 'pagination'], summary: ALICE_LOOKING });
    assert.equal(shared.data.state, 'shared');
    introId = (await bobAgent.call('inbox')).data.events.find((e: { kind: string }) => e.kind === 'intro.requested').ref;
    assert.equal((await bobAgent.call('respond_intro', { intro_id: introId })).data.state, 'accepted');
    const asked = await aliceAgent.call('ask_person', { handle: '@bob', tags: ['postgres'], question: QUESTION });
    askId = asked.data.ask_id;
    assert.ok(askId);
    assert.ok((await aliceBrowser.get('/ui')).html.includes('Bob'));
    // Later, so the approvals above have one circle to pick: Bob's own circles, one with others and one without.
    bobsCircle = relay.klatsch.ensureCircle('bobs-team', bob);
    relay.klatsch.addMember(bobsCircle, alice, bob);
    await new Promise((resolve) => setTimeout(resolve, 5));
    relay.klatsch.addMember(bobsCircle, carol, bob);
    soloCircle = relay.klatsch.ensureCircle('bobs-notes', bob);
  });

  it('Settings links to a page that says what goes and which circle passes on', async () => {
    assert.match((await bobBrowser.get('/ui/settings')).html, /href="\/ui\/settings\/delete"/);
    const page = (await bobBrowser.get('/ui/settings/delete')).html;
    assert.match(page, /Delete your account\?/);
    assert.match(page, /Circles you own pass to their longest-standing member: bobs-team\./);
    assert.ok(!page.includes('bobs-notes, '), 'a circle with nobody else is not handed on');
    assert.match(page, /Type bob to confirm/);
  });

  it('a wrong handle deletes nothing', async () => {
    const refused = await bobBrowser.post('/ui/settings/delete', { handle: 'alice' });
    assert.equal(refused.status, 400);
    assert.match(refused.html, /That is not your handle, so nothing was deleted\./);
    assert.equal(relay.klatsch.user(bob).handle, 'bob');
  });

  it('the right handle deletes the account at once and signs him out', async () => {
    const done = await bobBrowser.post('/ui/settings/delete', { handle: '@Bob' });
    assert.equal(done.status, 200);
    assert.match(done.html, /Your account is deleted/);
    assert.throws(() => relay.klatsch.user(bob));
    assert.notEqual((await bobBrowser.get('/ui')).status, 200, 'the session is gone');
    await assert.rejects(bobAgent.call('inbox'), unauthorized, 'the agent token is gone');
  });

  it('no table keeps his id, and the database is consistent', () => {
    const tables = (relay.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((t) => t.name);
    for (const table of tables) {
      const columns = (relay.db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
      for (const column of columns) {
        const hit = relay.db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE CAST("${column}" AS TEXT) LIKE ?`).get(`%${bob}%`) as { n: number };
        assert.equal(hit.n, 0, `${table}.${column} still mentions Bob`);
      }
    }
    for (const gone of [introId, askId, soloCircle]) {
      for (const table of ['events', 'audit']) {
        const left = relay.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ref LIKE ?`).get(`%${gone}%`) as { n: number };
        assert.equal(left.n, 0, `${table} still points at ${gone}`);
      }
    }
    assert.deepEqual(relay.db.prepare('PRAGMA foreign_key_check').all(), []);
    const log = relay.db.prepare(`SELECT user_id, ref FROM audit WHERE action = 'account.delete'`).all() as { user_id: string | null; ref: string | null }[];
    assert.deepEqual(log.map((l) => ({ ...l })), [{ user_id: null, ref: null }], 'one line, without a name');
  });

  it('his circle with others passes to the longest-standing member; the one with nobody else is gone', () => {
    const owner = relay.db.prepare(`SELECT user_id FROM memberships WHERE circle_id = ? AND role = 'owner'`).all(bobsCircle) as { user_id: string }[];
    assert.deepEqual(owner.map((o) => o.user_id), [alice]);
    assert.equal(relay.db.prepare('SELECT 1 FROM circles WHERE id = ?').get(soloCircle), undefined);
  });

  it('Alice and Carol keep working, and nothing of Bob is left on their pages or in their agents', async () => {
    const home = await aliceBrowser.get('/ui');
    assert.equal(home.status, 200);
    assert.ok(!home.html.includes(BOB_NOTE) && !home.html.includes('@bob'));
    const inbox = await aliceAgent.call('inbox');
    assert.ok(!inbox.raw.includes('@bob'));
    assert.equal((await aliceAgent.call('pending')).isError, false);
    const carolBrowser = await browser(relay, relay.loginLink(carol));
    assert.equal((await carolBrowser.get('/ui/circle')).status, 200);
  });
});
