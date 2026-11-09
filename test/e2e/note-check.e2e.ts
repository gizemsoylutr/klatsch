// A note gets old. Its readers see the day it was last looked at, its author is asked on Home after 90 days and
// says it still holds or retires it; no tool can make an old note look fresh.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { agent, browser, startRelay, wireAgent, type Browser, type Relay } from './harness.ts';

const DAY = 24 * 60 * 60 * 1000;
const BOB_TEXT = 'Keyset paging on Postgres: a cursor on (created_at, id) fixed it.';

describe('note check: an old note shows its age and asks its author', () => {
  let relay: Relay;
  let alice = '', bob = '';
  let aliceBrowser: Browser, bobBrowser: Browser;
  let aliceAgent: Awaited<ReturnType<typeof agent>>;
  let sipId = '';
  const old = Date.now() - 120 * DAY;
  const oldDay = new Date(old).toISOString().slice(0, 10);

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    bob = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.addMember(relay.klatsch.ensureCircle('demo', alice), bob, alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
    bobBrowser = await browser(relay, relay.loginLink(bob));
    const draft = relay.klatsch.draftSip(bob, { status: 'solved', tags: ['postgres', 'pagination'], summary: BOB_TEXT, visibility: 'open' }, 'cli');
    relay.klatsch.approveSip(bob, draft.sipId, 'cli');
    sipId = draft.sipId;
    aliceAgent = await agent(relay, relay.agentToken(alice), {
      onPage: async (url) => {
        await aliceBrowser.post(`${new URL(url).pathname}/decide`, { decision: 'approved' });
      },
    });
  });
  after(async () => {
    await aliceAgent.close();
    await relay.close();
  });

  it('a new note asks nothing', async () => {
    assert.ok(!(await bobBrowser.get('/ui')).html.includes('Still holds'));
  });

  it('after 90 days Home asks its author, and the reader sees how old it is', async () => {
    relay.db.prepare('UPDATE sips SET approved_at = ? WHERE id = ?').run(old, sipId);
    const before = relay.notifications.length;
    const home = (await bobBrowser.get('/ui')).html;
    assert.ok(home.includes(`Last looked at ${oldDay}. Does it still hold?`));
    assert.ok(home.includes('Still holds'));
    assert.equal(relay.notifications.length, before, 'asking wakes nobody');
    await aliceAgent.call('update_card', { status: 'looking', tags: ['pagination'], summary: 'Paging skips rows.' });
    assert.ok((await aliceBrowser.get('/ui')).html.includes(`as of ${oldDay}`));
  });

  it('a quote tells the agent the day, and only a quote: a search does not', async () => {
    const found = await aliceAgent.call('find_matches', { tags: ['pagination'] });
    assert.ok(!found.raw.includes(oldDay));
    assert.ok((await aliceBrowser.post(`/ui/notes/${sipId}/send`)).status < 400);
    const events = (await aliceAgent.call('inbox')).data.events as { type?: string; as_of?: string }[];
    assert.equal(events.find((event) => event.type === 'quote')?.as_of, oldDay);
  });

  it('nobody else can confirm it, and no agent tool exists for it', async () => {
    await aliceBrowser.post(`/ui/sips/${sipId}/confirm`);
    assert.equal((relay.db.prepare('SELECT checked_at FROM sips WHERE id = ?').get(sipId) as { checked_at: number | null }).checked_at, null);
    const listed = await wireAgent(relay.base, relay.agentToken(alice))('tools/list');
    const names = (listed.result.tools as { name: string }[]).map((tool) => tool.name);
    assert.ok(names.includes('update_card'));
    assert.deepEqual(names.filter((name) => /confirm|check|retire/.test(name)), []);
  });

  it('the author says it still holds: the date moves on, Home stops asking, the reader sees today', async () => {
    assert.ok((await bobBrowser.post(`/ui/sips/${sipId}/confirm`)).status < 400);
    const home = (await bobBrowser.get('/ui')).html;
    assert.ok(!home.includes('Does it still hold?'));
    const today = new Date().toISOString().slice(0, 10);
    assert.ok((await aliceBrowser.get('/ui')).html.includes(`as of ${today}`));
    const audited = relay.db.prepare(`SELECT 1 FROM audit WHERE action = 'sip.confirm'`).get();
    assert.ok(audited);
  });

  it('a retired note cannot be confirmed', async () => {
    assert.ok((await bobBrowser.post(`/ui/sips/${sipId}/retire`)).status < 400);
    relay.db.prepare('UPDATE sips SET checked_at = NULL WHERE id = ?').run(sipId);
    await bobBrowser.post(`/ui/sips/${sipId}/confirm`);
    assert.equal((relay.db.prepare('SELECT checked_at FROM sips WHERE id = ?').get(sipId) as { checked_at: number | null }).checked_at, null);
  });
});
