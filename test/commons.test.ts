import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createApproval } from '../src/auth/approvals.ts';
import { createInvite, findInvite } from '../src/auth/invites.ts';
import type { Visibility } from '../src/service.ts';
import { openDb } from '../src/store/db.ts';
import { migrations } from '../src/store/migrations.ts';
import { addressKey } from '../src/relay/web.ts';
import { BASE, setup } from './helpers.ts';

const BOB_TEXT = 'Keyset paging: order by (created_at, id) and pass the last pair as the cursor.';
const LOOKING = 'Node.js API on Postgres returns every row at once.';
const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

type T = ReturnType<typeof setup>;

/**
 * The test circle (Alice owns it, Bob is in it) plus a public "commons" Gizem owns, with Bob and a
 * stranger, Carol, in it. Carol shares no private circle with Bob.
 */
function withCommons() {
  const t = setup();
  const gizem = t.klatsch.ensureUser('gizem', 'Gizem');
  const carol = t.klatsch.ensureUser('carol', 'Carol');
  const commons = t.klatsch.ensureCircle('commons', gizem);
  const token = t.klatsch.setJoinLink(gizem, commons, true)!;
  t.klatsch.joinPublic(t.bob, token);
  t.klatsch.joinPublic(carol, token);
  return { ...t, gizem, carol, commons, joinToken: token };
}

function solved(t: T, userId: string, visibility: Visibility, matchIn?: string[], tags = ['postgres', 'pagination']) {
  const draft = t.klatsch.draftSip(userId, { status: 'solved', tags, summary: BOB_TEXT, visibility }, 'cli');
  t.klatsch.approveSip(userId, draft.sipId, 'web', visibility, matchIn);
  return draft.sipId;
}
function looking(t: T, userId: string, matchIn?: string[], tags = ['postgres']) {
  const draft = t.klatsch.draftSip(userId, { status: 'looking', tags, summary: LOOKING }, 'cli');
  t.klatsch.approveSip(userId, draft.sipId, 'web', undefined, matchIn);
  return draft.sipId;
}
const scope = (t: T, sipId: string) =>
  (t.db.prepare('SELECT circle_id, open FROM sip_circles WHERE sip_id = ? ORDER BY circle_id').all(sipId) as { circle_id: string; open: number }[]).map((r) => ({ ...r }));
const sorted = <R extends { circle_id: string }>(rows: R[]) => rows.sort((a, b) => (a.circle_id < b.circle_id ? -1 : 1));

describe('scope: a sip reaches a public circle only when its author ticks it', () => {
  it('without a choice, a note is shared in the private circles only: a stranger in the commons neither reads nor finds it', () => {
    const t = withCommons();
    const sipId = solved(t, t.bob, 'open');
    assert.deepEqual(scope(t, sipId), [{ circle_id: t.circle, open: 1 }]);
    looking(t, t.alice);
    looking(t, t.carol, [t.commons]);
    assert.equal(t.klatsch.visibleNotes(t.alice)[0]?.sipId, sipId, 'Alice shares a private circle where it is open');
    assert.equal(t.klatsch.visibleNotes(t.alice)[0]?.circle, 'test');
    assert.deepEqual(t.klatsch.visibleNotes(t.carol), [], 'the stranger in the commons does not read it');
    assert.deepEqual(t.klatsch.findMatches(t.carol, ['postgres']).matches, [], 'nor does her agent find it');
  });

  it('ticked, the commons reads an open note at once, with the circle it came through', () => {
    const t = withCommons();
    const sipId = solved(t, t.bob, 'open', [t.circle, t.commons]);
    assert.deepEqual(scope(t, sipId), sorted([{ circle_id: t.circle, open: 1 }, { circle_id: t.commons, open: 1 }]));
    const carolSip = looking(t, t.carol, [t.commons]);
    const [note] = t.klatsch.visibleNotes(t.carol);
    assert.equal(note?.sipId, sipId);
    assert.equal(note?.circle, 'commons');
    assert.equal(t.klatsch.findMatches(t.carol, ['postgres'], 'web', carolSip).matches[0]!.from, '@bob');
  });

  it('only the commons ticked: the private circle neither reads nor matches it', () => {
    const t = withCommons();
    solved(t, t.bob, 'open', [t.commons]);
    looking(t, t.alice);
    assert.deepEqual(t.klatsch.visibleNotes(t.alice), []);
    assert.deepEqual(t.klatsch.findMatches(t.alice, ['postgres']).matches, []);
  });

  it('a looking sip kept to a private circle never reaches a commons stranger: no intro, no reading of it, until it is ticked', () => {
    const t = withCommons();
    t.klatsch.joinPublic(t.alice, t.joinToken);
    solved(t, t.carol, 'ask', [t.commons], ['express']);
    const aliceSip = looking(t, t.alice, undefined, ['express']);
    assert.deepEqual(scope(t, aliceSip), [{ circle_id: t.circle, open: 0 }]);
    assert.deepEqual(t.klatsch.findMatches(t.alice, ['express'], 'web', aliceSip).matches, [], 'the share finds nothing in the commons');
    assert.deepEqual(t.klatsch.findMatches(t.alice, ['express']).matches, [], "her agent's own search stays in her private circles");
    assert.deepEqual(t.klatsch.introsOf(t.carol), [], 'Carol never reads what Alice is stuck on');
    const ticked = looking(t, t.alice, [t.circle, t.commons], ['express']);
    const [match] = t.klatsch.findMatches(t.alice, ['express'], 'web', ticked).matches;
    assert.equal(match?.from, undefined, 'ask first: anonymous');
    t.klatsch.requestIntro(t.alice, match!.match_id);
    assert.equal(t.klatsch.introsOf(t.carol)[0]?.request?.summary, LOOKING);
    assert.equal(t.klatsch.introsOf(t.carol)[0]?.request?.circle, 'commons');
  });

  it('request_intro with a looking sip kept to other circles says so plainly', async () => {
    const t = withCommons();
    t.klatsch.joinPublic(t.alice, t.joinToken);
    solved(t, t.carol, 'ask', [t.commons], ['express']);
    const ticked = looking(t, t.alice, [t.commons], ['express']);
    const [match] = t.klatsch.findMatches(t.alice, ['express'], 'web', ticked).matches;
    t.klatsch.retireSip(t.alice, ticked);
    looking(t, t.alice, [t.circle], ['express']);
    const result = await t.tool(t.token(t.alice), 'request_intro', { match_id: match!.match_id });
    assert.equal(result.isError, true);
    assert.match(result.data.message, /is not shared in a circle where this note is, so it was not sent/);
    assert.deepEqual(t.klatsch.introsOf(t.carol), []);
  });

  it("an agent's own search covers the private circles only; the commons only through a looking sip the human ticked there", () => {
    const t = withCommons();
    solved(t, t.carol, 'ask', [t.commons], ['express']);
    const alices = solved(t, t.alice, 'ask', undefined, ['express']);
    assert.equal(t.klatsch.findMatches(t.bob, ['express']).matches.length, 1);
    assert.deepEqual((t.db.prepare('SELECT sip_id FROM matches').all() as { sip_id: string }[]).map((r) => r.sip_id), [alices]);
    const bobSip = looking(t, t.bob, [t.commons], ['express']);
    assert.equal(t.klatsch.findMatches(t.bob, ['express'], 'web', bobSip).matches.length, 1, 'ticked there, the commons answers');
  });

  it('an intro lives in a circle both sips share: Bob solved in P and Q, Alice looks in P only; P going public, or Bob leaving P, declines it', () => {
    for (const end of ['public', 'removed'] as const) {
      const t = setup();
      const q = t.klatsch.ensureCircle('q', t.bob);
      t.klatsch.addMember(q, t.alice, t.bob);
      const ask = solved(t, t.bob, 'ask', [t.circle, q], ['express']);
      looking(t, t.alice, [t.circle], ['express']);
      const match = (t.db.prepare('SELECT id FROM matches WHERE sip_id = ?').get(ask) as { id: string }).id;
      const { introId } = t.klatsch.requestIntro(t.alice, match);
      assert.equal(t.klatsch.introsOf(t.bob)[0]?.request?.circle, 'test');
      if (end === 'public') t.klatsch.setJoinLink(t.alice, t.circle, true);
      else t.klatsch.removeMember(t.alice, t.circle, t.bob);
      assert.equal(t.klatsch.introsOf(t.alice).find((i) => i.id === introId)?.state, 'declined', `${end}: Q alone does not back Alice's looking sip`);
    }
  });

  it('after an accepted intro, the text stays readable only while a circle both sips share backs it', () => {
    const t = setup();
    const q = t.klatsch.ensureCircle('q', t.bob);
    t.klatsch.addMember(q, t.alice, t.bob);
    const ask = solved(t, t.bob, 'ask', [t.circle, q], ['express']);
    looking(t, t.alice, [t.circle], ['express']);
    const match = (t.db.prepare('SELECT id FROM matches WHERE sip_id = ?').get(ask) as { id: string }).id;
    const { introId } = t.klatsch.requestIntro(t.alice, match);
    t.klatsch.approveIntro(t.bob, introId);
    assert.equal(t.klatsch.introOf(t.alice, introId).other?.shared, true);
    t.klatsch.setJoinLink(t.alice, t.circle, true);
    assert.equal(t.klatsch.introOf(t.alice, introId).other?.shared, false, 'Q, where only the solved sip is, does not keep it readable');
  });

  it('nothing ticked is refused, for any sip, and nothing is shared', () => {
    const t = withCommons();
    for (const status of ['solved', 'looking'] as const) {
      const draft = t.klatsch.draftSip(t.bob, { status, tags: ['postgres'], summary: BOB_TEXT, visibility: 'open' }, 'cli');
      assert.throws(() => t.klatsch.approveSip(t.bob, draft.sipId, 'web', 'open', []), /Pick at least one circle/);
      // A circle the person is not in counts as not ticked.
      assert.throws(() => t.klatsch.approveSip(t.bob, draft.sipId, 'web', 'open', ['cir_not_mine']), /Pick at least one circle/);
      assert.equal((t.db.prepare('SELECT state FROM sips WHERE id = ?').get(draft.sipId) as { state: string }).state, 'draft');
      assert.deepEqual(scope(t, draft.sipId), []);
    }
  });

  it('"always send" does not pull a note the commons cannot read: no automatic quote', () => {
    const t = withCommons();
    t.db.prepare(`INSERT INTO grants (id, grantor_id, grantee_id, kind, created_at) VALUES ('g1', ?, ?, 'deliver', 1)`).run(t.carol, t.bob);
    const sipId = solved(t, t.bob, 'open');
    looking(t, t.carol, [t.commons]);
    assert.equal(t.db.prepare('SELECT 1 FROM handoffs').get(), undefined);
    assert.throws(() => t.klatsch.sendNote(t.carol, sipId), /not open to you/);
  });

  it('"allow always" holds only in the circle its intro happened in', () => {
    const t = withCommons();
    t.klatsch.joinPublic(t.alice, t.joinToken);
    const carolSip = looking(t, t.carol, [t.commons], ['django']);
    solved(t, t.alice, 'ask', [t.circle, t.commons], ['django']);
    const [match] = t.klatsch.findMatches(t.carol, ['django'], 'web', carolSip).matches;
    const { introId } = t.klatsch.requestIntro(t.carol, match!.match_id);
    t.klatsch.approveIntro(t.alice, introId, 'web', true);
    assert.equal((t.db.prepare(`SELECT circle_id FROM grants WHERE kind = 'show'`).get() as { circle_id: string }).circle_id, t.commons);
    assert.match(t.klatsch.grantsOf(t.alice)[0]!.circle!, /^commons$/);
    const workOnly = solved(t, t.alice, 'ask', [t.circle], ['django']);
    const inCommons = solved(t, t.alice, 'ask', [t.commons], ['django']);
    looking(t, t.carol, [t.commons], ['django']);
    const readable = t.klatsch.visibleNotes(t.carol).map((n) => n.sipId);
    assert.ok(readable.includes(inCommons));
    assert.ok(!readable.includes(workOnly), 'a note kept to the private circle stays out of the grant');
  });

  it('a circle that goes public loses every sip shared in it before; an intro it backed alone is declined', () => {
    const t = setup();
    const sipId = solved(t, t.bob, 'open');
    looking(t, t.alice);
    assert.equal(t.klatsch.visibleNotes(t.alice).length, 1);
    const ask = solved(t, t.bob, 'ask', undefined, ['express']);
    looking(t, t.alice, undefined, ['express']);
    const match = (t.db.prepare('SELECT id FROM matches WHERE sip_id = ?').get(ask) as { id: string }).id;
    const { introId } = t.klatsch.requestIntro(t.alice, match);
    t.klatsch.setJoinLink(t.alice, t.circle, true);
    assert.deepEqual(scope(t, sipId), []);
    assert.deepEqual(t.klatsch.visibleNotes(t.alice), []);
    assert.equal(t.klatsch.introsOf(t.bob).find((i) => i.id === introId)?.state, 'declined');
    // Off again: the circle stays public; nothing comes back.
    t.klatsch.setJoinLink(t.alice, t.circle, false);
    assert.equal(t.klatsch.sharingCircles(t.bob)[0]?.public, true);
    assert.deepEqual(scope(t, sipId), []);
  });

  it('every approval lists the circles to match in: private ticked, public not, with what ticking means; the form decides', async () => {
    const t = withCommons();
    const bob = await t.human(t.bob);
    const open = async (id: string) => (await t.app.request(`${BASE}/ui/approvals/${id}`, { headers: { Cookie: bob.cookie } })).text();
    const lookingAsk = createApproval(t.db, t.secret, t.bob, 'share_sip', { status: 'looking', tags: '["postgres"]', summary: LOOKING, ask_for_intro: 'true' }).approval;
    const lookingPage = await open(lookingAsk.id);
    assert.match(lookingPage, /Match in/);
    assert.match(lookingPage, /Whoever solved this in the circles you tick below gets an intro request and reads this sip\./);
    assert.match(lookingPage, /Ticked: whoever solved it may be someone in commons \(3 people\) you don&#39;t know/);
    const { approval } = createApproval(t.db, t.secret, t.bob, 'share_sip', { status: 'solved', tags: '["postgres"]', summary: BOB_TEXT, ask_for_intro: 'false', visibility: 'open' });
    const page = await open(approval.id);
    assert.match(page, new RegExp(`name="in_${t.circle}" value="1" checked`));
    assert.match(page, new RegExp(`name="in_${t.commons}" value="1" />`));
    assert.match(page, /Ticked: everyone in commons \(3 people\) who is stuck on this reads it at once, with your name\./);
    const none = await bob.post(`/ui/approvals/${approval.id}/decide`, { csrf: bob.csrf, decision: 'approved', visibility: 'open', scope: '1' });
    assert.equal(none.status, 409);
    assert.match(await none.text(), /Pick at least one circle/);
    // A stale tab (no circle choice posted although Bob has one to make) is refused, not guessed.
    const stale = await bob.post(`/ui/approvals/${approval.id}/decide`, { csrf: bob.csrf, decision: 'approved', visibility: 'open' });
    assert.equal(stale.status, 409);
    assert.match(await stale.text(), /This page is out of date/);
    const both = await bob.post(`/ui/approvals/${approval.id}/decide`, {
      csrf: bob.csrf,
      decision: 'approved',
      visibility: 'open',
      scope: '1',
      [`in_${t.circle}`]: '1',
      [`in_${t.commons}`]: '1',
    });
    assert.equal(both.status, 200, 'the refusals left the approval open');
    const sipId = (t.db.prepare(`SELECT id FROM sips WHERE status = 'solved'`).get() as { id: string }).id;
    assert.deepEqual(scope(t, sipId).map((r) => r.open), [1, 1]);
  });

  it('a draft shared from Home without the circle choice (a stale page) is refused', async () => {
    const t = withCommons();
    const draft = t.klatsch.draftSip(t.bob, { status: 'looking', tags: ['postgres'], summary: LOOKING }, 'cli');
    const bob = await t.human(t.bob);
    assert.match(await bob.page(), new RegExp(`name="in_${t.commons}" value="1" form="share-${draft.sipId}" />`));
    const stale = await bob.post(`/ui/sips/${draft.sipId}/approve`, { csrf: bob.csrf });
    assert.equal(stale.status, 409);
    assert.equal((await bob.post(`/ui/sips/${draft.sipId}/approve`, { csrf: bob.csrf, scope: '1', [`in_${t.circle}`]: '1' })).status, 303);
    assert.deepEqual(scope(t, draft.sipId), [{ circle_id: t.circle, open: 0 }]);
  });

  it('a person in one private circle gets no circle choice, as before', async () => {
    const t = setup();
    const { approval } = createApproval(t.db, t.secret, t.bob, 'share_sip', { status: 'solved', tags: '["postgres"]', summary: BOB_TEXT, ask_for_intro: 'false', visibility: 'open' });
    const bob = await t.human(t.bob);
    const page = await (await t.app.request(`${BASE}/ui/approvals/${approval.id}`, { headers: { Cookie: bob.cookie } })).text();
    assert.doesNotMatch(page, /name="scope"/);
    assert.equal((await bob.post(`/ui/approvals/${approval.id}/decide`, { csrf: bob.csrf, decision: 'approved', visibility: 'open' })).status, 200);
  });

  it('the migration keeps every sip in exactly the circle it was shared in, and gives each "allow always" the first circle the two shared', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klatsch-migration-'));
    try {
      const file = join(dir, 'klatsch.db');
      const old = new DatabaseSync(file);
      old.exec('PRAGMA foreign_keys = ON;');
      const before = migrations.findIndex((sql) => sql.includes('CREATE TABLE sip_circles'));
      for (const sql of migrations.slice(0, before)) old.exec(sql);
      old.exec(`PRAGMA user_version = ${before}`);
      old.exec(`
        INSERT INTO users (id, handle, display_name, created_at) VALUES ('u1', 'alice', 'Alice', 1), ('u2', 'bob', 'Bob', 1);
        INSERT INTO circles (id, name, created_at) VALUES ('c1', 'one', 1), ('c2', 'two', 1);
        INSERT INTO memberships (circle_id, user_id, created_at) VALUES ('c1', 'u2', 1), ('c2', 'u2', 2), ('c2', 'u1', 2);
        INSERT INTO sips (id, user_id, circle_id, status, summary, state, visibility, created_at, approved_at) VALUES
          ('s1', 'u2', 'c1', 'solved', 'open one', 'approved', 'open', 1, 1),
          ('s2', 'u2', 'c1', 'solved', 'ask one', 'approved', 'ask', 1, 1),
          ('s3', 'u2', 'c1', 'solved', 'draft', 'draft', 'open', 1, NULL);
        INSERT INTO grants (id, grantor_id, grantee_id, kind, tags, created_at) VALUES ('g1', 'u2', 'u1', 'show', '["x"]', 1), ('g2', 'u1', 'u2', 'deliver', NULL, 1);
      `);
      old.close();
      const db = openDb(file);
      assert.deepEqual(
        (db.prepare('SELECT sip_id, circle_id, open FROM sip_circles ORDER BY sip_id').all() as object[]).map((r) => ({ ...r })),
        [
          { sip_id: 's1', circle_id: 'c1', open: 1 },
          { sip_id: 's2', circle_id: 'c1', open: 0 },
        ],
      );
      assert.deepEqual(
        (db.prepare('SELECT id, circle_id FROM grants ORDER BY id').all() as object[]).map((r) => ({ ...r })),
        [
          { id: 'g1', circle_id: 'c2' },
          { id: 'g2', circle_id: null },
        ],
      );
      assert.equal((db.prepare('SELECT public FROM circles WHERE id = ?').get('c1') as { public: number }).public, 0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a public join link', () => {
  it('only the owner turns it on, each time at a new random link; off stops joins, members stay', () => {
    const t = setup();
    assert.throws(() => t.klatsch.setJoinLink(t.bob, t.circle, true), /Only the owner/);
    const first = t.klatsch.setJoinLink(t.alice, t.circle, true)!;
    assert.match(first, /^[\w-]{22}$/);
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    assert.equal(t.klatsch.joinPublic(carol, first), 'joined');
    assert.equal(t.klatsch.joinPublic(carol, first), 'already-member');
    t.klatsch.setJoinLink(t.alice, t.circle, false);
    const dave = t.klatsch.ensureUser('dave', 'Dave');
    assert.throws(() => t.klatsch.joinPublic(dave, first), /not valid/);
    assert.equal(t.klatsch.memberRole(carol, t.circle), 'member');
    const second = t.klatsch.setJoinLink(t.alice, t.circle, true)!;
    assert.notEqual(second, first);
    assert.throws(() => t.klatsch.joinPublic(dave, first), /not valid/, 'an old link never comes back');
    assert.equal(t.klatsch.joinPublic(dave, second), 'joined');
    assert.deepEqual(
      (t.db.prepare(`SELECT action FROM audit WHERE action LIKE 'circle.%' ORDER BY id`).all() as { action: string }[]).map((r) => r.action),
      ['circle.public.on', 'circle.join', 'circle.public.off', 'circle.public.on', 'circle.join'],
    );
  });

  it('takes nobody past its cap, and refuses unknown and malformed links alike', () => {
    const t = setup();
    const token = t.klatsch.setJoinLink(t.alice, t.circle, true, { cap: 3 })!;
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    const dave = t.klatsch.ensureUser('dave', 'Dave');
    assert.equal(t.klatsch.joinPublic(carol, token), 'joined');
    assert.throws(() => t.klatsch.joinPublic(dave, token), /This circle is full/);
    for (const bad of ['A'.repeat(22), 'x', "commons'--", '']) assert.throws(() => t.klatsch.joinPublic(dave, bad), /not valid/);
  });

  it('a short name only from the operator: checked, unique, and never the shape of a random link', () => {
    const t = setup();
    const other = t.klatsch.ensureCircle('other', t.bob);
    assert.equal(t.klatsch.setJoinLink(t.alice, t.circle, true, { name: 'commons' }), 'commons');
    assert.throws(() => t.klatsch.setJoinLink(t.bob, other, true, { name: 'commons' }), /taken/);
    for (const name of ['ab', 'Commons', 'a'.repeat(21), '-x-', 'a_b']) assert.throws(() => t.klatsch.setJoinLink(t.bob, other, true, { name }), /3–20/);
  });

  it('a removal sticks: the link does not bring someone back, an invite from the owner does', async () => {
    const t = setup();
    const token = t.klatsch.setJoinLink(t.alice, t.circle, true)!;
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    t.klatsch.joinPublic(carol, token);
    t.klatsch.removeMember(t.alice, t.circle, carol);
    assert.throws(() => t.klatsch.joinPublic(carol, token), /not valid/);
    assert.equal(t.klatsch.memberRole(carol, t.circle), undefined);
  });

  it('members see the owner, themselves and a count; the owner sees everyone, to remove them', async () => {
    const t = withCommons();
    const bob = await t.human(t.bob);
    const circlePage = await (await t.app.request(`${BASE}/ui/circle`, { headers: { Cookie: bob.cookie } })).text();
    const commons = circlePage.slice(circlePage.indexOf('commons <span>'));
    assert.match(commons, /Gizem/);
    assert.match(commons, /Bob/);
    assert.doesNotMatch(commons, /Carol|@carol/);
    assert.match(commons, /1 other/);
    assert.match(commons, new RegExp(`/join/${t.joinToken}`), 'the link is public anyway');
    assert.doesNotMatch(commons, /Turn off/);
    const gizem = await t.human(t.gizem);
    const ownerPage = await (await t.app.request(`${BASE}/ui/circle`, { headers: { Cookie: gizem.cookie } })).text();
    assert.match(ownerPage, /Carol/);
    assert.match(ownerPage, /Turn off/);
  });

  it('on the web: the owner can only turn the link off; a signed-in person joins; joins are rate limited per person', async () => {
    const t = setup();
    const alice = await t.human(t.alice);
    assert.equal((await alice.post(`/ui/circles/${t.circle}/public`, { csrf: alice.csrf, on: '1' })).status, 303);
    assert.equal(t.klatsch.circlesOf(t.alice)[0]!.public, false, 'only the operator makes a circle public');
    const token = t.klatsch.setJoinLink(t.alice, t.circle, true)!;
    const bob = await t.human(t.bob);
    assert.equal((await bob.post(`/ui/circles/${t.circle}/public`, { csrf: bob.csrf })).status, 409, 'not the owner');
    const short = await t.app.request(`${BASE}/join/${token}`);
    assert.equal(short.status, 303);
    assert.equal(short.headers.get('location'), `/ui/join/${token}`);
    const carol = await t.human(t.klatsch.ensureUser('carol', 'Carol'));
    const page = await (await t.app.request(`${BASE}/ui/join/${token}`, { headers: { Cookie: carol.cookie } })).text();
    assert.match(page, /Join test/);
    assert.match(page, /A public circle: 2 people/);
    assert.doesNotMatch(page, /Alice|Bob/, 'no names on the join page');
    const joined = await carol.post(`/ui/join/${token}`, { csrf: carol.csrf });
    assert.equal(joined.status, 200);
    assert.match(await joined.text(), /You joined <strong>test<\/strong>/);
    for (let i = 0; i < 4; i++) assert.equal((await carol.post(`/ui/join/${token}`, { csrf: carol.csrf })).status, 200);
    assert.equal((await carol.post(`/ui/join/${token}`, { csrf: carol.csrf })).status, 429);
    assert.equal((await t.app.request(`${BASE}/ui/join/${'B'.repeat(22)}`, { headers: { Cookie: carol.cookie } })).status, 404);
    // The owner turns it off on the web.
    const circlePage = await (await t.app.request(`${BASE}/ui/circle`, { headers: { Cookie: alice.cookie } })).text();
    assert.match(circlePage, />Turn off<\/button>/);
    assert.doesNotMatch(circlePage, /Turn on/);
    assert.equal((await alice.post(`/ui/circles/${t.circle}/public`, { csrf: alice.csrf })).status, 303);
    assert.equal(t.klatsch.publicCircle(token), undefined);
  });

  it('a removed person gets the same refusal from the join page as from Join', async () => {
    const t = setup();
    const token = t.klatsch.setJoinLink(t.alice, t.circle, true)!;
    const carolId = t.klatsch.ensureUser('carol', 'Carol');
    t.klatsch.joinPublic(carolId, token);
    t.klatsch.removeMember(t.alice, t.circle, carolId);
    t.klatsch.addMember(t.klatsch.ensureCircle('elsewhere', carolId), carolId);
    const carol = await t.human(carolId);
    const page = await t.app.request(`${BASE}/ui/join/${token}`, { headers: { Cookie: carol.cookie } });
    const posted = await carol.post(`/ui/join/${token}`, { csrf: carol.csrf });
    assert.equal(page.status, 404);
    assert.equal(posted.status, 404);
    for (const html of [await page.text(), await posted.text()]) assert.match(html, /Join link not valid/);
  });

  it('in a public circle only the owner invites, and an invite respects the cap; the link being off does not stop an owner invite', async () => {
    const t = setup();
    const byBob = createInvite(t.db, t.secret, t.circle, t.bob, BASE).link.split('/').at(-1)!;
    t.klatsch.setJoinLink(t.alice, t.circle, true, { cap: 3 });
    t.klatsch.setJoinLink(t.alice, t.circle, false);
    assert.equal(t.klatsch.mayInvite(t.bob, t.circle), false);
    const bob = await t.human(t.bob);
    const refused = await bob.post(`/ui/circles/${t.circle}/invites`, { csrf: bob.csrf });
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /only its owner invites people/);
    assert.doesNotMatch(await (await t.app.request(`${BASE}/ui/circle`, { headers: { Cookie: bob.cookie } })).text(), /Invite someone/);
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    assert.throws(() => t.klatsch.acceptInvite(carol, findInvite(t.db, t.secret, byBob)!), /not valid/, "a member's invite from before no longer works");
    const byAlice = createInvite(t.db, t.secret, t.circle, t.alice, BASE).link.split('/').at(-1)!;
    assert.equal(t.klatsch.acceptInvite(carol, findInvite(t.db, t.secret, byAlice)!), 'joined');
    const dave = t.klatsch.ensureUser('dave', 'Dave');
    const again = createInvite(t.db, t.secret, t.circle, t.alice, BASE).link.split('/').at(-1)!;
    assert.throws(() => t.klatsch.acceptInvite(dave, findInvite(t.db, t.secret, again)!), /This circle is full/);
  });

  it('counts joins per address by IPv4 address, or by the /64 of an IPv6 one', () => {
    assert.equal(addressKey('203.0.113.9'), '203.0.113.9');
    assert.equal(addressKey('::ffff:203.0.113.9'), '203.0.113.9');
    assert.equal(addressKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
    assert.equal(addressKey('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
    assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(addressKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
    assert.equal(addressKey('unknown'), 'unknown');
  });
});

describe('klatsch circle public (the operator)', () => {
  it('makes a commons for an owner, with a short name and a cap, and turns it off', () => {
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'klatsch-commons-')));
    try {
      const cli = (args: string[]) => spawnSync('node', [CLI, ...args, '--data', data], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, KLATSCH_PUBLIC_URL: '' } });
      assert.equal(cli(['init', '--user', 'gizem', '--name', 'Gizem', '--circle', 'friends']).status, 0);
      const missing = cli(['circle', 'public', 'commons', '--on']);
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /No circle commons\. Name its owner with --user/);
      const on = cli(['circle', 'public', 'commons', '--on', '--user', 'gizem', '--slug', 'commons', '--cap', '500']);
      assert.equal(on.status, 0, on.stderr);
      assert.match(on.stdout, /Anyone with this link can join commons: http:\/\/127\.0\.0\.1:\d+\/join\/commons/);
      const off = cli(['circle', 'public', 'commons', '--off']);
      assert.equal(off.status, 0, off.stderr);
      const db = openDb(join(data, 'klatsch.db'));
      assert.deepEqual({ ...(db.prepare(`SELECT public, join_token, join_cap FROM circles WHERE name = 'commons'`).get() as object) }, { public: 1, join_token: null, join_cap: 500 });
      db.close();
      assert.notEqual(cli(['circle', 'public', 'commons', '--on', '--off']).status, 0);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
});

describe('klatsch email (the operator)', () => {
  it('confirms an address for a person, who can then sign in by email, and refuses one that is someone else\'s', () => {
    const data = realpathSync(mkdtempSync(join(tmpdir(), 'klatsch-email-')));
    try {
      const cli = (args: string[]) => spawnSync('node', [CLI, ...args, '--data', data], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, KLATSCH_PUBLIC_URL: '' } });
      assert.equal(cli(['init', '--user', 'gizem', '--name', 'Gizem', '--circle', 'friends']).status, 0);
      assert.notEqual(cli(['email', '--user', 'gizem']).status, 0);
      assert.match(cli(['email', '--user', 'nobody', 'x@example.org']).stderr, /No user @nobody/);
      assert.match(cli(['email', '--user', 'gizem', 'not an address']).stderr, /not an email address/);
      const set = cli(['email', '--user', 'gizem', 'G.izem+klatsch@Gmail.com']);
      assert.equal(set.status, 0, set.stderr);
      assert.match(set.stdout, /@gizem can now sign in by email at that address\./);
      assert.doesNotMatch(set.stdout, /gmail/i, 'the address is not echoed into logs');
      const db = openDb(join(data, 'klatsch.db'));
      const row = db.prepare(`SELECT id, email, mailbox, email_verified_at FROM users WHERE handle = 'gizem'`).get() as { id: string; email: string; mailbox: string; email_verified_at: number | null };
      assert.equal(row.email, 'G.izem+klatsch@Gmail.com');
      assert.equal(row.mailbox, 'gizem@gmail.com');
      assert.ok(row.email_verified_at);
      assert.equal((db.prepare('SELECT count(*) n FROM mailbox_history WHERE user_id = ?').get(row.id) as { n: number }).n, 1);
      db.prepare(`INSERT INTO users (id, handle, display_name, created_at) VALUES ('u2', 'other', 'Other', 0)`).run();
      db.close();
      assert.match(cli(['email', '--user', 'other', 'gizem@gmail.com']).stderr, /already belongs to another person/);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
});
