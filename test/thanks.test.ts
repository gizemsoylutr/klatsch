import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { badgeSvg } from '../src/relay/badge.ts';
import { openDb } from '../src/store/db.ts';
import { migrations } from '../src/store/migrations.ts';
import { BASE, setup } from './helpers.ts';

const ALICE_TEXT = 'Use a keyset cursor on (created_at, id) and return next_cursor from the route handler.';
const ALICE_LATER = 'For a total count with paging, run a separate COUNT query, not one per page.';
const BOB_TEXT = 'Paging in my Node.js API on Postgres returns every row at once.';

type T = ReturnType<typeof setup>;

function solved(t: T, userId: string, tags: string[], summary = ALICE_TEXT, visibility: 'open' | 'ask' = 'open') {
  const draft = t.klatsch.draftSip(userId, { status: 'solved', tags, summary, visibility }, 'cli');
  t.klatsch.approveSip(userId, draft.sipId);
  return draft.sipId;
}
function looking(t: T, userId: string, tags: string[], summary = BOB_TEXT) {
  const draft = t.klatsch.draftSip(userId, { status: 'looking', tags, summary }, 'cli');
  t.klatsch.approveSip(userId, draft.sipId);
  return draft.sipId;
}
const rows = (t: T) => t.db.prepare('SELECT from_user_id, to_user_id, sip_id, intro_id FROM thanks ORDER BY created_at, rowid').all().map((r) => ({ ...r }));
const audited = (t: T) => (t.db.prepare(`SELECT action FROM audit WHERE action LIKE 'thanks.%' OR action LIKE 'badge.%' ORDER BY rowid`).all() as { action: string }[]).map((r) => r.action);
/** Alice's note open to the circle; Bob, stuck on it, reads it on his page. */
function openNote(t: T) {
  const sipId = solved(t, t.alice, ['nodejs']);
  looking(t, t.bob, ['nodejs']);
  assert.equal(t.klatsch.visibleNotes(t.bob)[0]?.sipId, sipId);
  return sipId;
}
/** An intro on Alice's ask-first note that she allowed: Bob asked, both accepted. */
function acceptedIntro(t: T) {
  solved(t, t.alice, ['express'], ALICE_TEXT, 'ask');
  looking(t, t.bob, ['express']);
  const introId = t.klatsch.requestIntro(t.bob, (t.db.prepare('SELECT id FROM matches').get() as { id: string }).id).introId;
  return introId;
}
/** Alice's open note, sent by Bob to his agent, which read it: the quote's id, as the agent knows it. */
function delivered(t: T) {
  const sipId = openNote(t);
  t.klatsch.sendNote(t.bob, sipId);
  const quote = t.klatsch.inbox(t.bob).find((e) => e.type === 'quote');
  assert.ok(quote);
  return { sipId, quoteId: quote.ref };
}
const NOT_RECEIVED = /You can thank someone only for a note that reached you/;
const givenBy = (t: T) => (t.db.prepare('SELECT given_by FROM thanks ORDER BY created_at, rowid').all() as { given_by: string }[]).map((r) => r.given_by);
const badgeId = async (t: T, browser: Awaited<ReturnType<T['human']>>) => (await browser.settings()).match(/\/badge\/([\w-]+)\.svg/)?.[1];

describe('thanks: a click in the human session for a note that reached them', () => {
  it('Bob thanks the open note he read; Alice sees 1 on Home and Settings, Bob sees "Thanked"', async () => {
    const t = setup();
    const sipId = openNote(t);
    const bob = await t.human(t.bob);
    assert.match(await bob.page(), new RegExp(`action="/ui/notes/${sipId}/thanks"`));
    const thanked = await bob.post(`/ui/notes/${sipId}/thanks`);
    assert.equal(thanked.status, 303);
    assert.equal(thanked.headers.get('location'), '/ui');
    assert.deepEqual(rows(t), [{ from_user_id: t.bob, to_user_id: t.alice, sip_id: sipId, intro_id: null }]);
    assert.deepEqual(t.klatsch.helped(t.alice), { month: 1, total: 1 });
    const page = await bob.page();
    assert.doesNotMatch(page, new RegExp(`action="/ui/notes/${sipId}/thanks"`), 'the button is gone');
    assert.match(page, /<span class="thanked">.*Thanked<\/span>/);
    const alice = await t.human(t.alice);
    assert.match(await alice.page(), /Your notes helped 1 person this month\.[\s\S]*1 since you joined · only you see this/);
    assert.match(await alice.settings(), /Your notes helped 1 person<\/span><span class="m">1 this month · only you see this/);
  });

  it('is idempotent: a second click changes nothing and is not audited again', async () => {
    const t = setup();
    const sipId = openNote(t);
    const bob = await t.human(t.bob);
    for (let i = 0; i < 3; i++) assert.equal((await bob.post(`/ui/notes/${sipId}/thanks`)).status, 303);
    assert.equal(rows(t).length, 1);
    assert.deepEqual(audited(t), ['thanks.give']);
    assert.deepEqual(t.klatsch.helped(t.alice), { month: 1, total: 1 });
  });

  it('refuses thanking yourself', async () => {
    const t = setup();
    const sipId = openNote(t);
    const alice = await t.human(t.alice);
    const refused = await alice.post(`/ui/notes/${sipId}/thanks`);
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /You cannot thank yourself\./);
    assert.throws(() => t.db.prepare('INSERT INTO thanks (id, from_user_id, to_user_id, sip_id, created_at) VALUES (?, ?, ?, ?, ?)').run('t_x', t.alice, t.alice, sipId, 1), /CHECK/);
    // The service's own statement: ON CONFLICT DO NOTHING swallows a repeat, never a self-thanks.
    assert.throws(
      () => t.db.prepare('INSERT INTO thanks (id, from_user_id, to_user_id, sip_id, intro_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run('t_y', t.alice, t.alice, sipId, null, 1),
      /CHECK/,
    );
    assert.deepEqual(rows(t), []);
  });

  it('refuses a note that never reached the person: not matched, found only by an agent search, unknown, or retired', async () => {
    const t = setup();
    const sipId = solved(t, t.alice, ['nodejs']);
    const bob = await t.human(t.bob);
    const refuse = async (id: string) => {
      const response = await bob.post(`/ui/notes/${id}/thanks`);
      assert.equal(response.status, 409, id);
      assert.match(await response.text(), /You can thank someone only for a note that reached you/);
    };
    await refuse(sipId);
    // A search by his agent alone puts nothing on his page, so there is nothing to thank for.
    await t.tool(t.token(t.bob), 'find_matches', { tags: ['nodejs'] });
    await refuse(sipId);
    await refuse('sip_unknown');
    const ask = solved(t, t.alice, ['express'], ALICE_LATER, 'ask');
    looking(t, t.bob, ['express', 'nodejs']);
    await refuse(ask);
    t.klatsch.retireSip(t.alice, sipId);
    await refuse(sipId);
    assert.deepEqual(rows(t), []);
  });

  it('a note sent to the agent can be thanked after it is no longer on the page; the thanks keeps nothing readable', async () => {
    const t = setup();
    const sipId = openNote(t);
    t.klatsch.sendNote(t.bob, sipId);
    t.klatsch.retireSip(t.alice, sipId);
    assert.deepEqual(t.klatsch.visibleNotes(t.bob), []);
    const bob = await t.human(t.bob);
    assert.equal((await bob.post(`/ui/notes/${sipId}/thanks`)).status, 303);
    assert.deepEqual(t.klatsch.helped(t.alice), { month: 1, total: 1 });
    assert.deepEqual(t.klatsch.visibleNotes(t.bob), [], 'still not readable');
    assert.ok(!(await bob.page()).includes(ALICE_TEXT));
  });

  it('counts distinct people, not clicks: two notes from Bob are one person, Carol makes two', async () => {
    const t = setup();
    const first = openNote(t);
    const second = solved(t, t.alice, ['nodejs'], ALICE_LATER);
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    t.klatsch.addMember(t.circle, carol, t.alice);
    looking(t, carol, ['nodejs'], 'Carol is stuck on Node.js paging too.');
    t.klatsch.thankNote(t.bob, first);
    t.klatsch.thankNote(t.bob, second);
    assert.deepEqual(t.klatsch.helped(t.alice), { month: 1, total: 1 });
    t.klatsch.thankNote(carol, second);
    assert.deepEqual(t.klatsch.helped(t.alice), { month: 2, total: 2 });
    assert.deepEqual(t.klatsch.helped(t.bob), { month: 0, total: 0 });
  });

  it('a month is a calendar month in UTC: a thanks just before the first counts only in the total', () => {
    const t = setup();
    const first = openNote(t);
    const second = solved(t, t.alice, ['nodejs'], ALICE_LATER);
    t.klatsch.thankNote(t.bob, first);
    const now = new Date();
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    t.db.prepare('UPDATE thanks SET created_at = ?').run(monthStart - 1);
    assert.deepEqual(t.klatsch.helped(t.alice), { month: 0, total: 1 });
    t.db.prepare('UPDATE thanks SET created_at = ?').run(monthStart);
    assert.deepEqual(t.klatsch.helped(t.alice), { month: 1, total: 1 });
    // Bob thanked last month and again this month: one person in each, one in all.
    t.db.prepare('UPDATE thanks SET created_at = ?').run(monthStart - 1);
    t.klatsch.thankNote(t.bob, second);
    assert.deepEqual(t.klatsch.helped(t.alice), { month: 1, total: 1 });
  });

  it('needs a form post from the page: no Origin, another Origin or a wrong form token is refused', async () => {
    const t = setup();
    const sipId = openNote(t);
    const bob = await t.human(t.bob);
    assert.equal((await bob.post(`/ui/notes/${sipId}/thanks`, { csrf: bob.csrf }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await bob.post(`/ui/notes/${sipId}/thanks`, { csrf: 'wrong' })).status, 403);
    const noOrigin = await t.app.request(`${BASE}/ui/notes/${sipId}/thanks`, {
      method: 'POST',
      headers: { Cookie: bob.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: bob.csrf }).toString(),
    });
    assert.equal(noOrigin.status, 403);
    assert.deepEqual(rows(t), []);
  });
});

describe('thanks for an intro', () => {
  it('either person in an accepted intro thanks the other, once; nobody else, and not before it is accepted', async () => {
    const t = setup();
    const introId = acceptedIntro(t);
    const bob = await t.human(t.bob);
    const alice = await t.human(t.alice);
    assert.equal((await bob.post(`/ui/intros/${introId}/thanks`)).status, 409, 'not accepted yet');
    t.klatsch.approveIntro(t.alice, introId);
    assert.match(await bob.page(), new RegExp(`action="/ui/intros/${introId}/thanks"`));
    assert.equal((await bob.post(`/ui/intros/${introId}/thanks`)).status, 303);
    assert.equal((await bob.post(`/ui/intros/${introId}/thanks`)).status, 303);
    assert.equal((await alice.post(`/ui/intros/${introId}/thanks`)).status, 303);
    assert.deepEqual(rows(t), [
      { from_user_id: t.bob, to_user_id: t.alice, sip_id: null, intro_id: introId },
      { from_user_id: t.alice, to_user_id: t.bob, sip_id: null, intro_id: introId },
    ]);
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    t.klatsch.addMember(t.circle, carol, t.alice);
    const outsider = await (await t.human(carol)).post(`/ui/intros/${introId}/thanks`);
    assert.equal(outsider.status, 409);
    assert.equal(rows(t).length, 2);
    assert.match(await bob.page(), /<span class="thanked">.*Thanked<\/span>/);
  });

  it('the connected page right after accepting offers "Thanks, this helped"', async () => {
    const t = setup();
    const introId = acceptedIntro(t);
    const { createApproval } = await import('../src/auth/approvals.ts');
    const answer = createApproval(t.db, t.secret, t.alice, 'answer_intro', { intro_id: introId });
    const alice = await t.human(t.alice);
    const decided = await alice.post(`/ui/approvals/${answer.approval.id}/decide`, { csrf: alice.csrf, decision: 'approved' });
    const page = await decided.text();
    assert.match(page, new RegExp(`action="/ui/intros/${introId}/thanks"[^>]*>.*Thanks, this helped</button>`));
    assert.match(page, /Bob sees a thanks count with no names and no message\. After an intro, they can often tell it was you\./);
  });

  it('is refused once the two no longer share a circle', async () => {
    const t = setup();
    const introId = acceptedIntro(t);
    t.klatsch.approveIntro(t.alice, introId);
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    const other = t.klatsch.ensureCircle('other', carol);
    t.klatsch.addMember(other, t.alice, carol);
    const alice = await t.human(t.alice);
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    assert.throws(() => t.klatsch.thankIntro(t.bob, introId), /only for a note that reached you, or an intro/);
    const refused = await alice.post(`/ui/intros/${introId}/thanks`);
    assert.equal(refused.status, 409, 'Alice is still in a circle, but not one with Bob');
    assert.doesNotMatch(await alice.page(), new RegExp(`action="/ui/intros/${introId}/thanks"`), 'no button either');
    assert.deepEqual(rows(t), []);
  });
});

describe('thanks stay private', () => {
  it("nobody sees another person's count or who thanked whom; agents can give a thanks but never read one", async () => {
    const t = setup();
    const sipId = openNote(t);
    const token = t.token(t.alice);
    const before = await t.tool(token, 'pending', {});
    t.klatsch.thankNote(t.bob, sipId);
    // Bob sees only that he thanked; nothing about Alice's count.
    const bobPage = await (await t.human(t.bob)).page();
    assert.doesNotMatch(bobPage, /Your notes helped/);
    assert.doesNotMatch(await (await t.human(t.bob)).settings(), /helped 1/);
    // Alice sees a number, no names.
    const aliceSettings = await (await t.human(t.alice)).settings();
    const thanksSection = aliceSettings.slice(aliceSettings.indexOf('id="thanks"'));
    assert.doesNotMatch(thanksSection.slice(0, thanksSection.indexOf('</section>')), /Bob|bob/);
    // No tool, event, wake or notification carries it.
    assert.deepEqual((await t.tool(token, 'pending', {})).data, before.data);
    assert.deepEqual(t.klatsch.inbox(t.alice).filter((e) => /thank/i.test(e.kind + e.text)), []);
    assert.equal(t.db.prepare(`SELECT 1 FROM events WHERE kind LIKE '%thank%'`).get(), undefined);
    assert.ok(!t.notifications.some((n) => n.startsWith('alice:') && /thank/i.test(n)));
    const tools = (await t.mcp(token, 'tools/list')).body.result.tools as { name: string; description: string }[];
    assert.deepEqual(tools.filter((tool) => /thank/i.test(tool.name + tool.description)).map((tool) => tool.name), ['thank_note'], 'one tool gives a thanks; none reads one');
  });

  it('a person removed from every circle can no longer thank; thanks they gave stay counted; their badge goes', async () => {
    const t = setup();
    const sipId = openNote(t);
    const second = solved(t, t.alice, ['nodejs'], ALICE_LATER);
    t.klatsch.thankNote(t.bob, sipId);
    t.klatsch.setBadge(t.bob, true);
    const bobBadge = t.klatsch.user(t.bob).badge_id!;
    const bob = await t.human(t.bob);
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    assert.throws(() => t.klatsch.thankNote(t.bob, second), /only for a note that reached you/);
    assert.equal((await bob.post(`/ui/notes/${second}/thanks`)).status, 401, 'his sessions ended with the removal');
    assert.deepEqual(t.klatsch.helped(t.alice), { month: 1, total: 1 }, 'a removal does not show in the count');
    assert.equal(t.klatsch.user(t.bob).badge_id, null);
    assert.equal((await t.app.request(`${BASE}/badge/${bobBadge}.svg`)).status, 404);
    assert.throws(() => t.klatsch.setBadge(t.bob, true), /no circle/);
  });
});

describe('the badge: opt-in, a number only, at a random link', () => {
  it('is off by default; on, it serves "Helped N people on Klatsch" with strict headers; off, 404; on again, a new link', async () => {
    const t = setup();
    t.klatsch.thankNote(t.bob, openNote(t));
    const alice = await t.human(t.alice);
    const off = await alice.settings();
    assert.match(off, /Show a badge<\/span><span class="m">Off\./);
    assert.match(off, /action="\/ui\/settings\/badge"[\s\S]*name="on" value="1"[\s\S]*aria-checked="false"/);
    assert.equal(await badgeId(t, alice), undefined);

    const turnedOn = await alice.post('/ui/settings/badge', { csrf: alice.csrf, on: '1' });
    assert.equal(turnedOn.status, 303);
    const settings = await alice.settings();
    const id = await badgeId(t, alice);
    assert.ok(id && /^[\w-]{22}$/.test(id));
    assert.ok(settings.includes(`<code class="cmd">${BASE}/badge/${id}.svg</code>`));
    assert.ok(settings.includes(`[![Helped people on Klatsch](${BASE}/badge/${id}.svg)](${BASE})`));
    assert.match(settings, /aria-checked="true"/);

    const badge = await t.app.request(`${BASE}/badge/${id}.svg`);
    assert.equal(badge.status, 200);
    assert.equal(badge.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    assert.equal(badge.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(badge.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(badge.headers.get('cache-control'), 'public, max-age=300');
    const svg = await badge.text();
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /<text [^>]*>Helped 1 person on Klatsch<\/text>/);
    assert.doesNotMatch(svg, /alice|Alice|<script|<style|<a |href|on\w+=/i);
    // Signed out, anyone can load it: it is an image for a README. HEAD gives the same headers and no body.
    assert.equal((await t.app.request(`${BASE}/badge/${id}.svg`, { headers: { Cookie: '' } })).status, 200);
    const head = await t.app.request(`${BASE}/badge/${id}.svg`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    assert.equal(head.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(await head.text(), '');
    // Another site's Origin is refused by the relay-wide Origin check; an <img> or GitHub's proxy sends none.
    assert.equal((await t.app.request(`${BASE}/badge/${id}.svg`, { headers: { Origin: 'https://evil.example' } })).status, 403);

    assert.equal((await alice.post('/ui/settings/badge', { csrf: alice.csrf, on: '0' })).status, 303);
    const gone = await t.app.request(`${BASE}/badge/${id}.svg`);
    assert.equal(gone.status, 404);
    assert.equal(gone.headers.get('cache-control'), 'no-store');
    assert.equal(await badgeId(t, alice), undefined);
    await alice.post('/ui/settings/badge', { csrf: alice.csrf, on: '1' });
    const again = await badgeId(t, alice);
    assert.ok(again && again !== id, 'a new link each time it is turned on');
    assert.equal((await t.app.request(`${BASE}/badge/${id}.svg`)).status, 404);
    assert.equal((await t.app.request(`${BASE}/badge/${again}.svg`)).status, 200);
    assert.deepEqual(audited(t), ['thanks.give', 'badge.on', 'badge.off', 'badge.on']);
  });

  it('unknown, malformed and extension-less ids get the same 404; turning it on needs a form post', async () => {
    const t = setup();
    for (const path of ['/badge/AAAAAAAAAAAAAAAAAAAAAA.svg', '/badge/x.svg', '/badge/%3Cscript%3E.svg', '/badge/AAAAAAAAAAAAAAAAAAAAAA']) {
      const response = await t.app.request(`${BASE}${path}`);
      assert.equal(response.status, 404, path);
      assert.equal(await response.text(), 'Not found.');
    }
    const alice = await t.human(t.alice);
    assert.equal((await alice.post('/ui/settings/badge', { csrf: 'wrong', on: '1' })).status, 403);
    assert.equal((await alice.post('/ui/settings/badge', { csrf: alice.csrf, on: '1' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal(t.klatsch.user(t.alice).badge_id, null);
  });

  it('the image is fixed markup with one number in it', () => {
    assert.match(badgeSvg(0), />Helped 0 people on Klatsch</);
    assert.match(badgeSvg(12), />Helped 12 people on Klatsch</);
    assert.doesNotMatch(badgeSvg(12), /<script|<style|href|on\w+=/i);
  });
});

describe('thanks from the agent (thank_note): for a note it received, while the human lets it', () => {
  it("Bob's agent thanks Alice for the note it got; she counts 1; Bob sees it on Home with Undo; the agent learns no count", async () => {
    const t = setup();
    const { sipId, quoteId } = delivered(t);
    const thanked = await t.tool(t.token(t.bob), 'thank_note', { quote_id: quoteId });
    assert.equal(thanked.isError, false);
    assert.equal(thanked.data.state, 'thanked');
    assert.match(thanked.data.note, /Tell your human in your reply that you thanked the author of the note/);
    assert.doesNotMatch(thanked.raw, /Alice|alice|helped|\b1 person/);
    assert.deepEqual(rows(t), [{ from_user_id: t.bob, to_user_id: t.alice, sip_id: sipId, intro_id: null }]);
    assert.deepEqual(givenBy(t), ['agent']);
    assert.deepEqual(t.klatsch.helped(t.alice), { month: 1, total: 1 });
    assert.equal((t.db.prepare(`SELECT via FROM audit WHERE action = 'thanks.give'`).get() as { via: string }).via, 'mcp');
    const id = (t.db.prepare('SELECT id FROM thanks').get() as { id: string }).id;
    const page = await (await t.human(t.bob)).page();
    assert.match(page, new RegExp(`Your agent thanked Alice</span><span class="m">nodejs</span>[\\s\\S]*action="/ui/thanks/${id}/undo"[\\s\\S]*>Undo</button>`));
    assert.match(page, /<span class="thanked">.*Thanked<\/span>/, 'the note shows Thanked, as after a click');
    // Alice still sees a number and nothing else: no name, and nothing says it was an agent.
    const alice = await (await t.human(t.alice)).page();
    assert.match(alice, /Your notes helped 1 person this month\./);
    assert.doesNotMatch(alice, /Your agent thanked|Bob/);
  });

  it('one thanks per person and note, shared with the click: either way round, the second is "already thanked"', async () => {
    const t = setup();
    const { sipId, quoteId } = delivered(t);
    const bob = await t.human(t.bob);
    assert.equal((await bob.post(`/ui/notes/${sipId}/thanks`)).status, 303);
    const again = await t.tool(t.token(t.bob), 'thank_note', { quote_id: quoteId });
    assert.equal(again.isError, false);
    assert.equal(again.data.state, 'already-thanked');
    assert.deepEqual(givenBy(t), ['human']);
    assert.doesNotMatch(await bob.page(), /Your agent thanked/, 'a click is not shown as the agent');

    const u = setup();
    const other = delivered(u);
    assert.equal((await u.tool(u.token(u.bob), 'thank_note', { quote_id: other.quoteId })).data.state, 'thanked');
    assert.equal((await u.tool(u.token(u.bob), 'thank_note', { quote_id: other.quoteId })).data.state, 'already-thanked');
    // Bob's click on a note his agent thanked makes the thanks his own: final, off the Undo list.
    const ubob = await u.human(u.bob);
    assert.match(await ubob.page(), /Your agent thanked Alice/);
    assert.equal((await ubob.post(`/ui/notes/${other.sipId}/thanks`)).status, 303);
    assert.deepEqual(givenBy(u), ['human']);
    assert.doesNotMatch(await ubob.page(), /Your agent thanked/);
    const id = (u.db.prepare('SELECT id FROM thanks').get() as { id: string }).id;
    assert.equal((await ubob.post(`/ui/thanks/${id}/undo`)).status, 409, 'no longer undoable');
    assert.deepEqual(u.klatsch.helped(u.alice), { month: 1, total: 1 });
    assert.equal((await ubob.post(`/ui/notes/${other.sipId}/thanks`)).status, 303);
    assert.deepEqual((u.db.prepare(`SELECT action FROM audit WHERE action LIKE 'thanks.%'`).all() as { action: string }[]).map((r) => r.action), ['thanks.give', 'thanks.confirm']);
  });

  it("refuses, with the web path's one answer, any id but a quote this agent read: unread, open but never sent, someone else's, unknown, or no shared circle", async () => {
    const t = setup();
    const sipId = openNote(t);
    let token = t.token(t.bob);
    const refuse = async (quote_id: string, why: string) => {
      const result = await t.tool(token, 'thank_note', { quote_id });
      assert.equal(result.isError, true, why);
      assert.equal(result.data.error, 'forbidden', why);
      assert.match(result.data.message, NOT_RECEIVED, why);
      assert.ok(!result.raw.includes(quote_id), `${why}: the id is not echoed`);
    };
    // Open to Bob and on his page, but never sent to his agent: it has no quote id, and a made-up one is unknown.
    await refuse('q_AAAAAAAAAAAAAAAAAAAAAA'.slice(0, 18), 'open, not sent');
    // Sent, but the agent has not read it yet.
    t.klatsch.sendNote(t.bob, sipId);
    const unread = (t.db.prepare('SELECT id FROM handoffs WHERE user_id = ?').get(t.bob) as { id: string }).id;
    await refuse(unread, 'not delivered yet');
    // Carol's agent read a quote of the same note; its id is not Bob's.
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    t.klatsch.addMember(t.circle, carol, t.alice);
    looking(t, carol, ['nodejs'], 'Carol is stuck on Node.js paging too.');
    t.klatsch.sendNote(carol, sipId);
    const carols = t.klatsch.inbox(carol).find((e) => e.type === 'quote')!.ref;
    await refuse(carols, "someone else's quote");
    // Read now, but Alice and Bob no longer share a circle.
    t.klatsch.inbox(t.bob);
    const other = t.klatsch.ensureCircle('other', carol);
    t.klatsch.addMember(other, t.alice, carol);
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    // The removal revoked his tokens; a new one gets as far as the check.
    token = t.token(t.bob);
    await refuse(unread, 'no shared circle');
    assert.deepEqual(rows(t), []);
    // A malformed id never reaches the service; an intro id is not a quote id.
    for (const quote_id of ['sip_x', 'i_AAAAAAAAAAAAAAAA', '']) assert.equal((await t.tool(token, 'thank_note', { quote_id })).isError, true);
  });

  it('is on by default; off in Settings, the tool refuses plainly; on again, it works', async () => {
    const t = setup();
    const { quoteId } = delivered(t);
    const bob = await t.human(t.bob);
    const settings = await bob.settings();
    assert.match(settings, /Let my agent say thanks when a note fixed the problem<\/span><span class="m">On\./);
    assert.match(settings, /action="\/ui\/settings\/agent-thanks"[\s\S]*?name="on" value="0"[\s\S]*?aria-checked="true"/);
    assert.equal((await bob.post('/ui/settings/agent-thanks', { csrf: 'wrong', on: '0' })).status, 403);
    assert.equal((await bob.post('/ui/settings/agent-thanks', { csrf: bob.csrf, on: '0' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await bob.post('/ui/settings/agent-thanks', { csrf: bob.csrf, on: '0' })).status, 303);
    assert.match(await bob.settings(), /Let my agent say thanks when a note fixed the problem<\/span><span class="m">Off\./);
    const off = await t.tool(t.token(t.bob), 'thank_note', { quote_id: quoteId });
    assert.equal(off.isError, true);
    assert.match(off.data.message, /Your human turned off thanks from their agent in Klatsch Settings\. Nothing was sent\./);
    assert.deepEqual(rows(t), []);
    assert.equal((await bob.post('/ui/settings/agent-thanks', { csrf: bob.csrf, on: '1' })).status, 303);
    assert.equal((await t.tool(t.token(t.bob), 'thank_note', { quote_id: quoteId })).data.state, 'thanked');
    assert.deepEqual(
      (t.db.prepare(`SELECT action FROM audit WHERE action LIKE 'thanks.%' ORDER BY rowid`).all() as { action: string }[]).map((r) => r.action),
      ['thanks.agent.off', 'thanks.agent.on', 'thanks.give'],
    );
  });

  it('at most 10 agent thanks in 24 hours, an undone one included; the human can still click', async () => {
    const t = setup();
    looking(t, t.bob, ['nodejs']);
    const quotes: string[] = [];
    for (let i = 0; i < 11; i++) {
      const sipId = solved(t, t.alice, ['nodejs'], `Note ${i}: keyset paging on Postgres.`);
      const id = `q_${String(i).padStart(16, 'x')}`;
      t.db.prepare('INSERT INTO handoffs (id, user_id, from_user_id, sip_id, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, t.bob, t.alice, sipId, Date.now(), Date.now());
      quotes.push(id);
    }
    const token = t.token(t.bob);
    for (const quote_id of quotes.slice(0, 10)) assert.equal((await t.tool(token, 'thank_note', { quote_id })).data.state, 'thanked');
    const bob = await t.human(t.bob);
    const first = (t.db.prepare('SELECT id FROM thanks ORDER BY created_at, rowid').get() as { id: string }).id;
    assert.equal((await bob.post(`/ui/thanks/${first}/undo`)).status, 303);
    const over = await t.tool(token, 'thank_note', { quote_id: quotes[10]! });
    assert.equal(over.isError, true);
    assert.match(over.data.message, /You already gave 10 thanks in the last 24 hours\./);
    assert.equal(rows(t).length, 9);
    // A day later the window has moved on.
    t.db.prepare('UPDATE thanks SET created_at = created_at - ?').run(24 * 60 * 60 * 1000 + 1);
    t.db.prepare('UPDATE thanks_undone SET thanked_at = thanked_at - ?').run(24 * 60 * 60 * 1000 + 1);
    assert.equal((await t.tool(token, 'thank_note', { quote_id: quotes[10]! })).data.state, 'thanked');
  });

  it('Undo on Home takes the thanks back (a form post); the agent cannot give it again, the human still can', async () => {
    const t = setup();
    const { sipId, quoteId } = delivered(t);
    await t.tool(t.token(t.bob), 'thank_note', { quote_id: quoteId });
    const id = (t.db.prepare('SELECT id FROM thanks').get() as { id: string }).id;
    const bob = await t.human(t.bob);
    assert.equal((await bob.post(`/ui/thanks/${id}/undo`, { csrf: 'wrong' })).status, 403);
    assert.equal((await bob.post(`/ui/thanks/${id}/undo`, { csrf: bob.csrf }, { Origin: 'https://evil.example' })).status, 403);
    // Only the thanker: Alice cannot undo it, and nobody can undo a thanks that does not exist.
    const alice = await t.human(t.alice);
    for (const path of [`/ui/thanks/${id}/undo`, '/ui/thanks/t_unknown/undo']) {
      const refused = await alice.post(path);
      assert.equal(refused.status, 409, path);
      assert.match(await refused.text(), /There is no thanks from your agent to undo here\./);
    }
    const undone = await bob.post(`/ui/thanks/${id}/undo`);
    assert.equal(undone.status, 303);
    assert.equal(undone.headers.get('location'), '/ui');
    assert.deepEqual(rows(t), []);
    assert.deepEqual(t.klatsch.helped(t.alice), { month: 0, total: 0 });
    assert.doesNotMatch(await bob.page(), /Your agent thanked/);
    assert.equal((await bob.post(`/ui/thanks/${id}/undo`)).status, 409, 'once');
    const again = await t.tool(t.token(t.bob), 'thank_note', { quote_id: quoteId });
    assert.equal(again.isError, true);
    assert.match(again.data.message, /Your human took back the thanks for this note, so it is not given again\./);
    assert.deepEqual(rows(t), []);
    // The human's own click is still theirs to give, and is final: no Undo for it.
    assert.equal((await bob.post(`/ui/notes/${sipId}/thanks`)).status, 303);
    assert.deepEqual(givenBy(t), ['human']);
    const human = (t.db.prepare('SELECT id FROM thanks').get() as { id: string }).id;
    assert.equal((await bob.post(`/ui/thanks/${human}/undo`)).status, 409);
    assert.deepEqual(t.klatsch.helped(t.alice), { month: 1, total: 1 });
    assert.deepEqual(
      (t.db.prepare(`SELECT action FROM audit WHERE action LIKE 'thanks.%' ORDER BY rowid`).all() as { action: string }[]).map((r) => r.action),
      ['thanks.give', 'thanks.undo', 'thanks.give'],
    );
  });
});

describe('thank_note: its scope, the Home list and the migration', () => {
  it('needs the thanks:write scope; an inbox-only token is refused', async () => {
    const t = setup();
    const { quoteId } = delivered(t);
    const inboxOnly = await t.tool(t.token(t.bob, ['inbox:read']), 'thank_note', { quote_id: quoteId });
    assert.equal(inboxOnly.status, 403);
    assert.match(inboxOnly.headers.get('www-authenticate') ?? '', /insufficient_scope/);
    assert.deepEqual(rows(t), []);
    assert.equal((await t.tool(t.token(t.bob, ['thanks:write']), 'thank_note', { quote_id: quoteId })).data.state, 'thanked');
  });

  it('Home lists every agent thanks of the last seven days, more than ten over two days, each with Undo', async () => {
    const t = setup();
    looking(t, t.bob, ['nodejs']);
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 14; i++) {
      const sipId = solved(t, t.alice, ['nodejs'], `Note ${i}: keyset paging on Postgres.`);
      const id = `q_${String(i).padStart(16, 'y')}`;
      t.db.prepare('INSERT INTO handoffs (id, user_id, from_user_id, sip_id, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, t.bob, t.alice, sipId, Date.now(), Date.now());
      assert.equal(t.klatsch.agentThankNote(t.bob, id), true);
      // The first ten were yesterday, so the daily limit lets the rest through today.
      if (i === 9) t.db.prepare('UPDATE thanks SET created_at = created_at - ?').run(day + 1);
    }
    const page = await (await t.human(t.bob)).page();
    const ids = (t.db.prepare('SELECT id FROM thanks').all() as { id: string }[]).map((r) => r.id);
    assert.equal(ids.length, 14);
    for (const id of ids) assert.ok(page.includes(`action="/ui/thanks/${id}/undo"`), id);
    // Older than seven days, a thanks stays counted but leaves the list.
    t.db.prepare('UPDATE thanks SET created_at = ?').run(Date.now() - 7 * day - 1);
    assert.doesNotMatch(await (await t.human(t.bob)).page(), /Your agent thanked/);
    assert.deepEqual(t.klatsch.helped(t.alice).total, 1);
  });

  it('the migration gives thanks:write to tokens that could read the inbox, marks old thanks human, turns agent thanks on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klatsch-migration-'));
    try {
      const file = join(dir, 'klatsch.db');
      const old = new DatabaseSync(file);
      old.exec('PRAGMA foreign_keys = ON;');
      // Every migration before the one that added agent thanks.
      const before = migrations.findIndex((sql) => sql.includes('CREATE TABLE thanks_undone'));
      for (const sql of migrations.slice(0, before)) old.exec(sql);
      old.exec(`PRAGMA user_version = ${before}`);
      old.exec(`
        INSERT INTO users (id, handle, display_name, created_at) VALUES ('u1', 'alice', 'Alice', 1), ('u2', 'bob', 'Bob', 1);
        INSERT INTO circles (id, name, created_at) VALUES ('c1', 'demo', 1);
        INSERT INTO sips (id, user_id, circle_id, status, summary, state, created_at, approved_at) VALUES ('s1', 'u1', 'c1', 'solved', 'old', 'approved', 1, 1);
        INSERT INTO thanks (id, from_user_id, to_user_id, sip_id, created_at) VALUES ('t1', 'u2', 'u1', 's1', 1);
        INSERT INTO tokens (id, user_id, hash, scopes, expires_at, created_at) VALUES
          ('k1', 'u2', 'h1', '["card:write","inbox:read"]', 9, 1),
          ('k2', 'u2', 'h2', '["card:write"]', 9, 1);
      `);
      old.close();
      const db = openDb(file);
      const scopes = (id: string) => JSON.parse((db.prepare('SELECT scopes FROM tokens WHERE id = ?').get(id) as { scopes: string }).scopes);
      assert.deepEqual(scopes('k1'), ['card:write', 'inbox:read', 'thanks:write']);
      assert.deepEqual(scopes('k2'), ['card:write']);
      assert.equal((db.prepare('SELECT given_by FROM thanks').get() as { given_by: string }).given_by, 'human');
      assert.equal((db.prepare(`SELECT agent_thanks FROM users WHERE id = 'u2'`).get() as { agent_thanks: number }).agent_thanks, 1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
