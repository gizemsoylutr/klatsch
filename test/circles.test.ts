import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { createTransport } from 'nodemailer';
import { findInvite } from '../src/auth/invites.ts';
import { createLoginLink } from '../src/auth/web-sessions.ts';
import { loadConfig } from '../src/config.ts';
import { confirmationMailer, emailFromEnv, emailNotifier, smtpUrl, type MailTransport } from '../src/notify/email.ts';
import { Klatsch, type Notifier } from '../src/service.ts';
import { openDb } from '../src/store/db.ts';
import { migrations } from '../src/store/migrations.ts';
import { BASE, setup } from './helpers.ts';

type T = ReturnType<typeof setup>;
type Human = Awaited<ReturnType<T['human']>>;

const BOB_TEXT = 'Use a keyset cursor on (created_at, id) and return next_cursor from the route handler.';

async function get(t: T, human: Human, path: string) {
  const response = await t.app.request(`${BASE}${path}`, { headers: { Cookie: human.cookie } });
  return { status: response.status, html: await response.text() };
}

async function invite(human: Human, circleId: string): Promise<string> {
  const response = await human.post(`/ui/circles/${circleId}/invites`);
  assert.equal(response.status, 200);
  const token = (await response.text()).match(/\/ui\/invite\/([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token, 'the inviter sees the link');
  return token;
}

function bobSolved(t: T) {
  const draft = t.klatsch.draftSip(t.bob, { status: 'solved', tags: ['nodejs', 'express'], summary: BOB_TEXT }, 'cli');
  t.klatsch.approveSip(t.bob, draft.sipId, 'cli');
}

/** Lets the clock move on, so a record made next is strictly later than the one before. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

/** nodemailer's JSON transport builds the real message without sending it. */
function mailbox() {
  const json = createTransport({ jsonTransport: true });
  const sent: { to: { address: string }[]; subject: string; text: string; from: { address: string } }[] = [];
  const transport: MailTransport = {
    async sendMail(message) {
      const info = await json.sendMail(message);
      sent.push(JSON.parse(info.message));
      return info;
    },
  };
  return { transport, sent };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

const audited = (t: T, action: string) => (t.db.prepare('SELECT count(*) AS n FROM audit WHERE action = ?').get(action) as { n: number }).n;

describe('invites', () => {
  it('lets a member invite someone once; only a keyed hash is stored', async () => {
    const t = setup();
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    const bob = await t.human(t.bob);
    const token = await invite(bob, t.circle);
    const stored = t.db.prepare('SELECT token_hash, created_by, expires_at - created_at AS ttl FROM invites').get() as { token_hash: string; created_by: string; ttl: number };
    assert.notEqual(stored.token_hash, token);
    assert.equal(stored.created_by, t.bob);
    assert.equal(stored.ttl, 7 * 24 * 60 * 60 * 1000);

    const carolHuman = await t.human(carol);
    const shown = await get(t, carolHuman, `/ui/invite/${token}`);
    assert.equal(shown.status, 200);
    assert.match(shown.html, /Bob/);
    assert.match(shown.html, /test/);

    const joined = await carolHuman.post(`/ui/invite/${token}`);
    assert.equal(joined.status, 200);
    assert.match(await joined.text(), /You joined/);
    const membership = t.db.prepare('SELECT invited_by, role FROM memberships WHERE user_id = ?').get(carol) as { invited_by: string; role: string };
    assert.deepEqual({ ...membership }, { invited_by: t.bob, role: 'member' });
    assert.equal(audited(t, 'invite.create'), 1);
    assert.equal(audited(t, 'invite.accept'), 1);

    const daveId = t.klatsch.ensureUser('dave', 'Dave');
    const dave = await t.human(daveId);
    assert.equal((await dave.post(`/ui/invite/${token}`)).status, 404, 'single use');
    assert.equal(t.klatsch.memberRole(daveId, t.circle), undefined);
  });

  it('shows one neutral page for unknown, used and expired invites', async () => {
    const t = setup();
    const alice = await t.human(t.alice);
    const carol = await t.human(t.klatsch.ensureUser('carol', 'Carol'));
    const expired = await invite(alice, t.circle);
    t.db.prepare('UPDATE invites SET expires_at = ?').run(Date.now() - 1);
    const used = await invite(alice, t.circle);
    assert.equal((await carol.post(`/ui/invite/${used}`)).status, 200);

    const pages = await Promise.all(['not-a-real-token', expired, used].map((token) => get(t, carol, `/ui/invite/${token}`)));
    for (const shown of pages) {
      assert.equal(shown.status, 404);
      assert.doesNotMatch(shown.html, /Alice|test/);
    }
    assert.equal(new Set(pages.map((p) => p.html)).size, 1, 'the same page whatever the reason');
    assert.equal((await carol.post(`/ui/invite/${expired}`)).status, 404);
  });

  it('does not consume an invite for someone already in the circle', async () => {
    const t = setup();
    const alice = await t.human(t.alice);
    const token = await invite(alice, t.circle);
    const bob = await t.human(t.bob);
    assert.match((await get(t, bob, `/ui/invite/${token}`)).html, /already in/);
    assert.match(await (await bob.post(`/ui/invite/${token}`)).text(), /already in/);
    assert.equal((t.db.prepare('SELECT count(*) AS n FROM memberships').get() as { n: number }).n, 2);
    assert.equal((t.db.prepare('SELECT used_at FROM invites').get() as { used_at: number | null }).used_at, null);
    const carol = await t.human(t.klatsch.ensureUser('carol', 'Carol'));
    assert.match(await (await carol.post(`/ui/invite/${token}`)).text(), /You joined/);
  });

  it('only lets members invite, only through a form post', async () => {
    const t = setup();
    const carol = await t.human(t.klatsch.ensureUser('carol', 'Carol'));
    assert.equal((await carol.post(`/ui/circles/${t.circle}/invites`)).status, 409);
    const alice = await t.human(t.alice);
    assert.equal((await alice.post(`/ui/circles/${t.circle}/invites`, { csrf: 'wrong' })).status, 403);
    assert.equal((await get(t, alice, `/ui/circles/${t.circle}/invites`)).status, 404, 'no invite by GET');
    assert.equal(audited(t, 'invite.create'), 0);
  });

  it('needs a signed-in human to see or accept an invite', async () => {
    const t = setup();
    const token = await invite(await t.human(t.alice), t.circle);
    const anonymous = await t.app.request(`${BASE}/ui/invite/${token}`);
    assert.equal(anonymous.status, 401);
    assert.doesNotMatch(await anonymous.text(), /Alice/);
  });
});

describe('circle members', () => {
  it('shows who invited whom, and Remove only to the owner', async () => {
    const t = setup();
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    t.klatsch.addMember(t.circle, carol, t.bob);
    const alice = await t.human(t.alice);
    const page = (await get(t, alice, '/ui/circle')).html;
    assert.match(page, /Alice<\/span> <span class="m">@alice<\/span><\/span><span class="m">owner · you<\/span>[\s\S]*<ul class="list">[\s\S]*Bob[\s\S]*<ul class="list">[\s\S]*Carol/);
    assert.match(page, new RegExp(`/members/${t.bob}/remove`));
    assert.doesNotMatch(page, new RegExp(`/members/${t.alice}/remove`), 'not themselves');
    assert.match(page, /Invite someone/);

    const bob = await t.human(t.bob);
    assert.doesNotMatch((await get(t, bob, '/ui/circle')).html, /Remove/);
    assert.equal((await bob.post(`/ui/circles/${t.circle}/members/${carol}/remove`)).status, 409);
    assert.equal((await alice.post(`/ui/circles/${t.circle}/members/${t.alice}/remove`)).status, 409);
    assert.equal(t.klatsch.memberRole(carol, t.circle), 'member');
  });

  it('removing a member stops their sips matching, closes their intros and revokes their tokens', async () => {
    const t = setup();
    bobSolved(t);
    const aliceToken = t.token(t.alice);
    const bobToken = t.token(t.bob);
    const matchId = (await t.tool(aliceToken, 'find_matches', { tags: ['nodejs'] })).data.matches[0].match_id;
    const bobInvite = await invite(await t.human(t.bob), t.circle);

    const alice = await t.human(t.alice);
    assert.equal((await alice.post(`/ui/circles/${t.circle}/members/${t.bob}/remove`)).status, 303);
    assert.equal(t.klatsch.memberRole(t.bob, t.circle), undefined);
    assert.equal(audited(t, 'member.remove'), 1);

    assert.equal((await t.tool(aliceToken, 'find_matches', { tags: ['nodejs'] })).data.matches.length, 0, 'removed sips stop matching');
    const looking = t.klatsch.draftSip(t.alice, { status: 'looking', tags: ['nodejs'], summary: 'stuck' }, 'cli');
    t.klatsch.approveSip(t.alice, looking.sipId, 'cli');
    assert.equal((await t.tool(aliceToken, 'request_intro', { match_id: matchId })).isError, true, 'an old match is dead too');
    assert.throws(() => t.klatsch.requestIntro(t.alice, matchId));
    assert.equal((await t.mcp(bobToken, 'tools/list')).status, 401, 'in no circle: tokens revoked');
    const carol = await t.human(t.klatsch.ensureUser('carol', 'Carol'));
    assert.equal((await carol.post(`/ui/invite/${bobInvite}`)).status, 404, 'their invites stop working');
  });

  it('declines the open intros of a removed member, so they cannot accept and learn a name', async () => {
    const t = setup();
    bobSolved(t);
    const looking = t.klatsch.draftSip(t.alice, { status: 'looking', tags: ['nodejs'], summary: 'Alice is stuck' }, 'cli');
    t.klatsch.approveSip(t.alice, looking.sipId, 'cli');
    const matchId = (t.db.prepare('SELECT id FROM matches').get() as { id: string }).id;
    const { introId } = t.klatsch.requestIntro(t.alice, matchId);
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    const bob = await t.human(t.bob);
    assert.doesNotMatch(await bob.page(), /Alice is stuck/);
    assert.equal((await bob.post(`/ui/intros/${introId}/approve`)).status, 409);
    assert.equal((t.db.prepare('SELECT state FROM intros').get() as { state: string }).state, 'declined');
  });

  it('a removed member who solves something later does not match the old circle', async () => {
    const t = setup();
    const looking = t.klatsch.draftSip(t.alice, { status: 'looking', tags: ['express'], summary: 'stuck' }, 'cli');
    t.klatsch.approveSip(t.alice, looking.sipId, 'cli');
    const draft = t.klatsch.draftSip(t.bob, { status: 'solved', tags: ['express'], summary: 'done' }, 'cli');
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    assert.throws(() => t.klatsch.approveSip(t.bob, draft.sipId, 'cli'), /Pick at least one circle/, 'in no circle, there is nowhere to share it');
    assert.equal((t.db.prepare('SELECT count(*) AS n FROM matches').get() as { n: number }).n, 0);
    assert.deepEqual(t.notifications, []);
  });

  it('shows the owner members in an invite cycle, so they can be removed', async () => {
    const t = setup();
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    t.klatsch.addMember(t.circle, carol, t.bob);
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    t.klatsch.addMember(t.circle, t.bob, carol); // Bob and Carol now each invited the other
    const alice = await t.human(t.alice);
    const page = (await get(t, alice, '/ui/circle')).html;
    assert.match(page, /test <span>· 3 people<\/span>/);
    for (const id of [t.bob, carol]) assert.match(page, new RegExp(`/members/${id}/remove`));
    assert.equal(page.match(/<span class="t">Bob<\/span>/g)?.length, 1);
    assert.equal(page.match(/<span class="t">Carol<\/span>/g)?.length, 1);
    assert.equal((await alice.post(`/ui/circles/${t.circle}/members/${carol}/remove`)).status, 303);
  });

  it('tells a seeker their open intro was declined when the solver is removed, as a decline would', async () => {
    const t = setup();
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    t.klatsch.addMember(t.circle, carol, t.alice);
    bobSolved(t);
    const looking = t.klatsch.draftSip(carol, { status: 'looking', tags: ['nodejs'], summary: 'stuck' }, 'cli');
    t.klatsch.approveSip(carol, looking.sipId, 'cli');
    const matchId = (t.db.prepare('SELECT id FROM matches WHERE seeker_id = ?').get(carol) as { id: string }).id;
    const { introId } = t.klatsch.requestIntro(carol, matchId);
    const carolToken = t.token(carol);
    await t.tool(carolToken, 'inbox', {});
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    const events = (await t.tool(carolToken, 'inbox', {})).data.events as { kind: string; ref: string }[];
    assert.deepEqual(events.map((e) => [e.kind, e.ref]), [['intro.declined', introId]]);
  });

  it('tells nobody when the removed member was the seeker', () => {
    const t = setup();
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    t.klatsch.addMember(t.circle, carol, t.alice);
    bobSolved(t);
    const looking = t.klatsch.draftSip(carol, { status: 'looking', tags: ['nodejs'], summary: 'stuck' }, 'cli');
    t.klatsch.approveSip(carol, looking.sipId, 'cli');
    const matchId = (t.db.prepare('SELECT id FROM matches WHERE seeker_id = ?').get(carol) as { id: string }).id;
    t.klatsch.requestIntro(carol, matchId);
    t.klatsch.removeMember(t.alice, t.circle, carol);
    assert.equal((t.db.prepare(`SELECT state FROM intros`).get() as { state: string }).state, 'declined');
    assert.equal(t.db.prepare(`SELECT 1 FROM events WHERE kind = 'intro.declined'`).get(), undefined);
  });

  it('keeps the tokens of a removed member who is still in another circle', async () => {
    const t = setup();
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    const other = t.klatsch.ensureCircle('other', carol);
    t.klatsch.addMember(other, t.bob, carol);
    const bobToken = t.token(t.bob);
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    assert.equal((await t.mcp(bobToken, 'tools/list')).status, 200);
  });
});

describe('removal sticks', () => {
  it('lets only the owner invite a removed person back, and that clears the removal', async () => {
    const t = setup();
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    t.klatsch.addMember(t.circle, carol, t.alice);
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    assert.deepEqual(
      { ...(t.db.prepare('SELECT removed_by FROM removals WHERE circle_id = ? AND user_id = ?').get(t.circle, t.bob) as object) },
      { removed_by: t.alice },
    );

    const bob = await t.human(t.bob);
    const fromCarol = await invite(await t.human(carol), t.circle);
    assert.equal((await bob.post(`/ui/invite/${fromCarol}`)).status, 404, 'a member cannot re-admit');
    assert.equal(t.klatsch.memberRole(t.bob, t.circle), undefined);

    await tick();
    const fromOwner = await invite(await t.human(t.alice), t.circle);
    assert.match(await (await bob.post(`/ui/invite/${fromOwner}`)).text(), /You joined/);
    assert.equal(t.klatsch.memberRole(t.bob, t.circle), 'member');
    assert.equal(t.db.prepare('SELECT 1 FROM removals').get(), undefined, 'the owner re-admitted deliberately');
  });

  it('ends the web sessions of someone left in no circle, and keeps them otherwise', async () => {
    const t = setup();
    const bob = await t.human(t.bob);
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    assert.equal((await get(t, bob, '/ui')).status, 401);

    const u = setup();
    const carol = u.klatsch.ensureUser('carol', 'Carol');
    u.klatsch.addMember(u.klatsch.ensureCircle('other', carol), u.bob, carol);
    const bobAgain = await u.human(u.bob);
    u.klatsch.removeMember(u.alice, u.circle, u.bob);
    assert.equal((await get(u, bobAgain, '/ui')).status, 200);
  });

  it('gives no agent token in the web UI to someone in no circle', async () => {
    const t = setup();
    const carol = await t.human(t.klatsch.ensureUser('carol', 'Carol'));
    assert.equal((await carol.post('/ui/tokens')).status, 409);
    const bob = await t.human(t.bob);
    t.klatsch.addMember(t.klatsch.ensureCircle('other', t.alice), t.bob, t.alice);
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    assert.equal((await bob.post('/ui/tokens')).status, 200, 'still in another circle');
    assert.equal((t.db.prepare('SELECT count(*) AS n FROM tokens').get() as { n: number }).n, 1);
  });

  it('gives no agent token on the command line to someone in no circle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klatsch-cli-'));
    try {
      const klatsch = new Klatsch(openDb(join(dir, 'klatsch.db')), loadConfig({ dataDir: dir }), () => {});
      klatsch.ensureUser('carol', 'Carol');
      klatsch.db.close();
      const env = { ...process.env, KLATSCH_SMTP_URL: '', KLATSCH_MAIL_FROM: '' };
      for (const command of ['token', 'connect']) {
        const run = spawnSync(process.execPath, [join(import.meta.dirname, '../src/cli.ts'), command, '--user', 'carol', '--data', dir], { cwd: dir, env, encoding: 'utf8' });
        assert.notEqual(run.status, 0, command);
        assert.match(run.stderr, /@carol is in no circle/);
        assert.doesNotMatch(run.stdout, /klt_/);
      }
      const db = openDb(join(dir, 'klatsch.db'));
      assert.equal((db.prepare('SELECT count(*) AS n FROM tokens').get() as { n: number }).n, 0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The EXISTS in claimInvite is defense in depth that only an internal test can reach: the POST handler finds and claims in one synchronous tick.
  it('refuses an invite whose inviter was removed between opening and joining', async () => {
    const t = setup();
    const token = await invite(await t.human(t.bob), t.circle);
    const opened = findInvite(t.db, t.secret, token);
    assert.ok(opened);
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    assert.throws(() => t.klatsch.acceptInvite(carol, opened));
    assert.equal(t.klatsch.memberRole(carol, t.circle), undefined);
  });

  it('voids the unused login links of someone left in no circle', async () => {
    const t = setup();
    const link = createLoginLink(t.db, t.secret, t.bob, t.config.publicUrl);
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    const login = await t.app.request(link);
    assert.equal(login.status, 401);
    assert.equal(login.headers.get('set-cookie'), null);
  });

  it('does not re-admit a removed person on an owner invite made before the removal', async () => {
    const t = setup();
    const alice = await t.human(t.alice);
    const before = await invite(alice, t.circle);
    await tick();
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    const bob = await t.human(t.bob);
    const unknown = await get(t, bob, '/ui/invite/not-a-real-token');
    const shown = await get(t, bob, `/ui/invite/${before}`);
    assert.equal(shown.status, 404);
    assert.equal(shown.html, unknown.html, 'the neutral page, no Join button');
    assert.equal((await bob.post(`/ui/invite/${before}`)).status, 404);
    assert.equal(t.klatsch.memberRole(t.bob, t.circle), undefined);
    assert.equal((t.db.prepare('SELECT used_at FROM invites').get() as { used_at: number | null }).used_at, null, 'still usable by someone else');
  });

  it('shows a removed person the neutral page, not Join, for a member invite', async () => {
    const t = setup();
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    t.klatsch.addMember(t.circle, carol, t.alice);
    t.klatsch.removeMember(t.alice, t.circle, t.bob);
    const fromCarol = await invite(await t.human(carol), t.circle);
    const bob = await t.human(t.bob);
    const shown = await get(t, bob, `/ui/invite/${fromCarol}`);
    assert.equal(shown.status, 404);
    assert.doesNotMatch(shown.html, /Join|Carol/);
  });
});

describe('matching across circles', () => {
  it('does not match a sip with someone outside the circles it was shared in (joining a circle later does not widen it)', () => {
    const t = setup();
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    const other = t.klatsch.ensureCircle('other', carol);
    const looking = t.klatsch.draftSip(carol, { status: 'looking', tags: ['nodejs'], summary: 'stuck' }, 'cli');
    t.klatsch.approveSip(carol, looking.sipId, 'cli');
    bobSolved(t);
    t.klatsch.addMember(other, t.bob, carol);
    assert.deepEqual(
      (t.db.prepare('SELECT sc.circle_id FROM sip_circles sc JOIN sips s ON s.id = sc.sip_id WHERE s.user_id = ?').all(t.bob) as { circle_id: string }[]).map((r) => r.circle_id),
      [t.circle],
    );
    assert.equal(t.klatsch.findMatches(carol, ['nodejs']).matches.length, 0);
    assert.equal((t.db.prepare('SELECT count(*) AS n FROM matches').get() as { n: number }).n, 0);
    assert.ok(!t.notifications.some((n) => n.startsWith('carol:')));
  });

  it('matches a sip in every circle its author was in when it was shared', () => {
    const t = setup();
    const carol = t.klatsch.ensureUser('carol', 'Carol');
    t.klatsch.addMember(t.klatsch.ensureCircle('other', carol), t.bob, carol);
    const looking = t.klatsch.draftSip(carol, { status: 'looking', tags: ['nodejs'], summary: 'stuck' }, 'cli');
    t.klatsch.approveSip(carol, looking.sipId, 'cli');
    bobSolved(t);
    assert.equal((t.db.prepare('SELECT count(*) AS n FROM matches').get() as { n: number }).n, 1);
    assert.ok(t.notifications.some((n) => n.startsWith('carol:')));
  });
});

describe('migration 7', () => {
  it('gives every existing circle exactly one owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klatsch-migrate-'));
    try {
      const path = join(dir, 'klatsch.db');
      const old = new DatabaseSync(path);
      for (const migration of migrations.slice(0, 6)) old.exec(migration);
      old.exec('PRAGMA user_version = 6');
      for (const u of ['a', 'b', 'c']) old.prepare('INSERT INTO users (id, handle, display_name, created_at) VALUES (?, ?, ?, 0)').run(u, u, u);
      const member = old.prepare('INSERT INTO memberships (circle_id, user_id, invited_by, created_at) VALUES (?, ?, ?, ?)');
      const circles: Record<string, [string, string | null, number][]> = {
        tie: [['a', null, 5], ['b', null, 5]], // two uninvited members joined at the same moment
        invitedFirst: [['a', 'c', 1], ['b', null, 2]], // the earliest row has an inviter
        allInvited: [['b', 'a', 3], ['c', 'a', 2]],
        plain: [['a', null, 1], ['b', 'a', 2], ['c', 'b', 3]],
      };
      for (const [id, rows] of Object.entries(circles)) {
        old.prepare('INSERT INTO circles (id, name, created_at) VALUES (?, ?, 0)').run(id, id);
        for (const [user, by, at] of rows) member.run(id, user, by, at);
      }
      old.close();

      const db = openDb(path);
      const owners = db.prepare(`SELECT circle_id, group_concat(user_id) AS users FROM memberships WHERE role = 'owner' GROUP BY circle_id ORDER BY circle_id`).all();
      assert.deepEqual(
        owners.map((o) => ({ ...o })),
        [
          { circle_id: 'allInvited', users: 'c' },
          { circle_id: 'invitedFirst', users: 'b' },
          { circle_id: 'plain', users: 'a' },
          { circle_id: 'tie', users: 'a' },
        ],
      );
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('agent tokens in the web UI', () => {
  it('connects an agent with a token shown once, lists tokens without secrets and revokes them', async () => {
    const t = setup();
    const alice = await t.human(t.alice);
    const created = await (await alice.post('/ui/tokens')).text();
    const token = created.match(/Bearer (klt_[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(token);
    assert.ok(created.includes(`claude mcp add --scope local --transport http klatsch ${t.config.publicUrl}/mcp --header &quot;Authorization: Bearer ${token}&quot;`));
    assert.equal((await t.mcp(token, 'tools/list')).status, 200);
    const row = t.db.prepare('SELECT id, hash, label, scopes FROM tokens WHERE user_id = ?').get(t.alice) as { id: string; hash: string; label: string; scopes: string };
    assert.match(row.label, /^web:\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(JSON.parse(row.scopes), ['card:write', 'matches:read', 'inbox:read', 'intro:request', 'intro:respond', 'thanks:write']);
    assert.equal(audited(t, 'token.create'), 1);

    const list = (await get(t, alice, '/ui/tokens')).html;
    assert.match(list, new RegExp(row.label));
    assert.ok(!list.includes(token) && !list.includes(row.hash), 'never the token or its hash');

    const bob = await t.human(t.bob);
    assert.equal((await bob.post(`/ui/tokens/${row.id}/revoke`)).status, 409, 'only your own');
    assert.equal((await alice.post(`/ui/tokens/${row.id}/revoke`)).status, 303);
    assert.equal((await t.mcp(token, 'tools/list')).status, 401);
    assert.match((await get(t, alice, '/ui/tokens')).html, /revoked/);
    assert.equal(audited(t, 'token.revoke'), 1);
  });

  it('creates tokens only through a form post from the relay', async () => {
    const t = setup();
    const alice = await t.human(t.alice);
    assert.equal((await alice.post('/ui/tokens', { csrf: alice.csrf }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await t.app.request(`${BASE}/ui/tokens`, { method: 'POST', headers: { Authorization: `Bearer ${t.token(t.alice)}` } })).status, 401);
    assert.equal((t.db.prepare(`SELECT count(*) AS n FROM tokens WHERE label LIKE 'web:%'`).get() as { n: number }).n, 0);
  });
});

describe('email notifications', () => {
  function withEmail(transport: MailTransport) {
    let notify: Notifier = () => {};
    const t = setup({ notify: (user, message) => notify(user, message), mailer: confirmationMailer(transport, 'klatsch@relay.test') });
    notify = emailNotifier(t.db, transport, 'klatsch@relay.test', () => t.config.publicUrl);
    t.klatsch.setVerifiedEmail(t.alice, 'alice@example.test', 'cli');
    return t;
  }

  function aliceGetsAMatch(t: T) {
    bobSolved(t);
    const looking = t.klatsch.draftSip(t.alice, { status: 'looking', tags: ['nodejs'], summary: 'Express paging is broken' }, 'cli');
    t.klatsch.approveSip(t.alice, looking.sipId, 'cli');
  }

  it('sends a fixed message and a link, with no names, tags or summaries', async () => {
    const { transport, sent } = mailbox();
    const t = withEmail(transport);
    aliceGetsAMatch(t);
    await until(() => sent.length > 0);
    assert.equal(sent.length, 1);
    const mail = sent[0]!;
    assert.equal(mail.to[0]!.address, 'alice@example.test');
    assert.equal(mail.subject, 'Klatsch: something new');
    assert.equal(mail.text, `☕ Someone in your circle has solved this before.\n\n${t.config.publicUrl}/ui\n`);
    assert.doesNotMatch(`${mail.subject}\n${mail.text}`, /bob|alice|nodejs|express|paging|keyset/i);

    const matchId = (t.db.prepare('SELECT id FROM matches').get() as { id: string }).id;
    t.klatsch.requestIntro(t.alice, matchId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(t.notifications.some((n) => n.startsWith('bob:')));
    assert.equal(sent.length, 1, 'Bob has no address: no mail');
  });

  it('can be turned off and on by the human', async () => {
    const { transport, sent } = mailbox();
    const t = withEmail(transport);
    const alice = await t.human(t.alice);
    assert.match(await alice.settings(), /role="switch" aria-checked="true"/);
    assert.equal((await alice.post('/ui/notifications/email', { csrf: alice.csrf, on: '0' })).status, 303);
    assert.match(await alice.settings(), /role="switch" aria-checked="false"/);
    aliceGetsAMatch(t);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sent.length, 0);
    assert.equal(t.notifications.length, 1, 'the local notifier still ran');

    assert.equal((await alice.post('/ui/notifications/email', { csrf: alice.csrf, on: '1' })).status, 303);
    const again = t.klatsch.draftSip(t.alice, { status: 'looking', tags: ['express'], summary: 'again' }, 'cli');
    t.db.prepare('DELETE FROM matches').run();
    t.klatsch.approveSip(t.alice, again.sipId, 'cli');
    await until(() => sent.length > 0);
    assert.equal(sent.length, 1);
  });

  it('logs a failed send by its codes only and never fails the request that caused it', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (text: string) => void errors.push(text);
    try {
      for (const transport of [
        { sendMail: () => Promise.reject(new Error('smtp down')) },
        {
          sendMail: () => {
            throw new Error('bad config');
          },
        },
      ]) {
        const t = withEmail(transport);
        bobSolved(t);
        const looking = t.klatsch.draftSip(t.alice, { status: 'looking', tags: ['nodejs'], summary: 'stuck' }, 'cli');
        const alice = await t.human(t.alice);
        assert.equal((await alice.post(`/ui/sips/${looking.sipId}/approve`)).status, 303);
      }
      await until(() => errors.length >= 2);
      assert.equal(errors.length, 2);
      // Only the codes: an error's text can quote the address or the server's reply.
      assert.deepEqual(errors, ['[klatsch] email notification to @alice failed: error', '[klatsch] email notification to @alice failed: error']);
    } finally {
      console.error = original;
    }
  });
});

describe('email address', () => {
  const stored = (t: T) => (t.db.prepare('SELECT email FROM users WHERE id = ?').get(t.alice) as { email: string | null }).email;

  it('is set and cleared by the human, through a form post', async () => {
    const t = setup({ mailer: () => {} });
    const alice = await t.human(t.alice);
    assert.match(await alice.settings(), /action="\/ui\/email"/);
    assert.equal((await alice.post('/ui/email', { csrf: alice.csrf, email: 'alice@example.test' })).status, 303);
    assert.equal(stored(t), 'alice@example.test');
    assert.match(await alice.settings(), /value="alice@example.test"/);
    assert.equal((await alice.post('/ui/email', { csrf: 'wrong', email: 'x@example.test' })).status, 403);
    assert.equal((await alice.post('/ui/email', { csrf: alice.csrf, email: 'x@example.test' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal(stored(t), 'alice@example.test');
    assert.equal((await alice.post('/ui/email', { csrf: alice.csrf, email: '' })).status, 303);
    assert.equal(stored(t), null);
  });

  it('refuses anything but one plain address, without echoing it', async () => {
    const t = setup();
    const alice = await t.human(t.alice);
    const bad = [
      'alice@example.test\r\nBcc: zz@evil.test',
      'alice@example.test\n',
      'a@example.test, b@example.test',
      'a@example.test;b@example.test',
      'Alice <alice@example.test>',
      'zz-no-at-sign.test',
      'zz@localhost',
      `${'a'.repeat(250)}@example.test`,
    ];
    for (const email of bad) {
      const response = await alice.post('/ui/email', { csrf: alice.csrf, email });
      assert.equal(response.status, 409, JSON.stringify(email));
      const text = await response.text();
      assert.ok(!text.includes('zz') && !text.includes('example.test'), 'not echoed');
    }
    assert.equal(stored(t), null);
  });

  it('requires TLS to any SMTP server but this machine, and both settings or neither', () => {
    const options = (url: string) => createTransport(smtpUrl(url)).options;
    const remote = options('smtp://user:pass@mail.example.test:587?requireTLS=false&ignoreTLS=true');
    assert.deepEqual([remote.host, remote.requireTLS, remote.ignoreTLS], ['mail.example.test', true, undefined]);
    for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(options(`smtp://${host}:25`).requireTLS, undefined, host);

    const unchecked = 'smtp://user:pass@mail.example.test:465?tls.rejectUnauthorized=false&tls.minVersion=TLSv1&secure=false';
    assert.deepEqual([options(unchecked).tls, options(unchecked).requireTLS], [undefined, true], 'the URL cannot switch off certificate checks');
    assert.doesNotMatch(smtpUrl(unchecked), /secure|tls\./);
    assert.equal(options('smtp://localhost:25?tls.rejectUnauthorized=false').tls?.rejectUnauthorized, false, 'this machine may use its own certificate');
    for (const host of ['mail.example.test', 'localhost']) {
      assert.doesNotMatch(smtpUrl(`smtp://${host}:25?debug=true&logger=true&transactionLog=true`), /debug|logger|transactionLog/, `no SMTP transcript in logs (${host})`);
    }

    const db = setup().db;
    assert.throws(() => emailFromEnv({ KLATSCH_SMTP_URL: 'smtp://localhost:25' }, db, () => BASE), /need both KLATSCH_SMTP_URL and KLATSCH_MAIL_FROM; only one is set/);
    assert.throws(() => emailFromEnv({ KLATSCH_MAIL_FROM: 'klatsch@relay.test' }, db, () => BASE), /need both KLATSCH_SMTP_URL and KLATSCH_MAIL_FROM; only one is set/);
    assert.equal(emailFromEnv({}, db, () => BASE), undefined);
    const email = emailFromEnv({ KLATSCH_SMTP_URL: 'smtp://localhost:25', KLATSCH_MAIL_FROM: 'klatsch@relay.test' }, db, () => BASE);
    assert.deepEqual([typeof email?.notify, typeof email?.confirm], ['function', 'function']);
  });
});

describe('email confirmation', () => {
  const state = (t: T) => t.db.prepare('SELECT email, email_verified_at FROM users WHERE id = ?').get(t.alice) as { email: string | null; email_verified_at: number | null };

  /** A relay with email: confirmation mails land in `sent`, notifications in `sent` too. */
  function withMail() {
    const { transport, sent } = mailbox();
    let notify: Notifier = () => {};
    const t = setup({ notify: (user, message) => notify(user, message), mailer: confirmationMailer(transport, 'klatsch@relay.test') });
    notify = emailNotifier(t.db, transport, 'klatsch@relay.test', () => t.config.publicUrl);
    return { t, sent };
  }

  async function linkFor(sent: ReturnType<typeof mailbox>['sent'], count: number): Promise<string> {
    await until(() => sent.length >= count);
    const token = sent[count - 1]!.text.match(/\/ui\/email\/confirm\/([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(token);
    return token;
  }

  it('keeps the last link working when the same address is saved again at the daily cap', async () => {
    const { t, sent } = withMail();
    const alice = await t.human(t.alice);
    for (let i = 0; i < 3; i++) assert.equal((await alice.post('/ui/email', { csrf: alice.csrf, email: 'alice@example.test' })).status, 303);
    const last = await linkFor(sent, 3);
    assert.equal((await alice.post('/ui/email', { csrf: alice.csrf, email: 'alice@example.test' })).status, 409, 'over the cap: saved, no new link');
    assert.equal((await get(t, alice, `/ui/email/confirm/${last}`)).status, 200, 'the last link still works');
    assert.equal((await alice.post(`/ui/email/confirm/${last}`, { csrf: alice.csrf })).status, 200);
    assert.notEqual(state(t).email_verified_at, null);
  });

  it('mails one content-free link to a new address, and sends notifications only once it is confirmed', async () => {
    const { t, sent } = withMail();
    const alice = await t.human(t.alice);
    assert.equal((await alice.post('/ui/email', { csrf: alice.csrf, email: 'alice@example.test' })).status, 303);
    const token = await linkFor(sent, 1);
    const mail = sent[0]!;
    assert.equal(mail.to[0]!.address, 'alice@example.test');
    assert.equal(mail.subject, 'Klatsch: confirm your email address');
    assert.equal(
      mail.text,
      `To get Klatsch notifications at this address, open this link while signed in to Klatsch; if you did not ask for this, ignore this mail.\n\n${t.config.publicUrl}/ui/email/confirm/${token}\n`,
    );
    assert.equal(state(t).email_verified_at, null);
    const stored = t.db.prepare('SELECT token_hash, expires_at - created_at AS ttl FROM email_confirmations').get() as { token_hash: string; ttl: number };
    assert.notEqual(stored.token_hash, token);
    assert.equal(stored.ttl, 24 * 60 * 60 * 1000);
    assert.match(await alice.settings(), /not confirmed yet/);

    bobSolved(t);
    const looking = t.klatsch.draftSip(t.alice, { status: 'looking', tags: ['nodejs'], summary: 'stuck' }, 'cli');
    t.klatsch.approveSip(t.alice, looking.sipId, 'cli');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sent.length, 1, 'no notification to an unconfirmed address');

    const shown = await get(t, alice, `/ui/email/confirm/${token}`);
    assert.equal(shown.status, 200);
    assert.match(shown.html, /alice@example.test[\s\S]*Confirm/);
    assert.equal(state(t).email_verified_at, null, 'GET changes nothing');
    assert.equal((await alice.post(`/ui/email/confirm/${token}`, { csrf: 'wrong' })).status, 403);
    assert.equal((await alice.post(`/ui/email/confirm/${token}`, { csrf: alice.csrf }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal(state(t).email_verified_at, null);
    assert.equal((await alice.post(`/ui/email/confirm/${token}`)).status, 200);
    assert.notEqual(state(t).email_verified_at, null);
    assert.match(await alice.settings(), /address is confirmed/);
    assert.equal(audited(t, 'email.verify'), 1);
    assert.equal((await alice.post(`/ui/email/confirm/${token}`)).status, 404, 'single use');

    t.db.prepare('DELETE FROM matches').run();
    const again = t.klatsch.draftSip(t.alice, { status: 'looking', tags: ['express'], summary: 'again' }, 'cli');
    t.klatsch.approveSip(t.alice, again.sipId, 'cli');
    await until(() => sent.length > 1);
    assert.equal(sent[1]!.subject, 'Klatsch: something new');
  });

  it('shows one neutral page for unknown, used, expired, replaced and other people\'s links', async () => {
    const { t, sent } = withMail();
    const alice = await t.human(t.alice);
    const bob = await t.human(t.bob);
    await alice.post('/ui/email', { csrf: alice.csrf, email: 'old@example.test' });
    const replaced = await linkFor(sent, 1);
    await alice.post('/ui/email', { csrf: alice.csrf, email: 'alice@example.test' });
    const expired = await linkFor(sent, 2);
    t.db.prepare('UPDATE email_confirmations SET expires_at = ? WHERE email = ?').run(Date.now() - 1, 'alice@example.test');
    await alice.post('/ui/email', { csrf: alice.csrf, email: 'alice@example.test' });
    const live = await linkFor(sent, 3);

    const unknown = await get(t, alice, '/ui/email/confirm/not-a-real-token');
    assert.equal(unknown.status, 404);
    for (const token of [replaced, expired]) {
      const shown = await get(t, alice, `/ui/email/confirm/${token}`);
      assert.equal(shown.status, 404);
      assert.equal(shown.html, unknown.html);
      assert.equal((await alice.post(`/ui/email/confirm/${token}`)).status, 404);
    }
    const otherUser = await get(t, bob, `/ui/email/confirm/${live}`);
    assert.equal(otherUser.html, unknown.html, 'Bob cannot confirm Alice\'s address');
    assert.doesNotMatch(otherUser.html, /alice@example.test/);
    assert.equal((await bob.post(`/ui/email/confirm/${live}`)).status, 404);
    const anonymous = await t.app.request(`${BASE}/ui/email/confirm/${live}`);
    assert.equal(anonymous.status, 401);
    assert.equal(state(t).email_verified_at, null);
    assert.equal((await alice.post(`/ui/email/confirm/${live}`)).status, 200);
  });

  it('resets confirmation when the address changes, and keeps it when the same address is saved again', async () => {
    const { t, sent } = withMail();
    const alice = await t.human(t.alice);
    t.klatsch.setVerifiedEmail(t.alice, 'alice@example.test', 'cli');
    assert.equal((await alice.post('/ui/email', { csrf: alice.csrf, email: 'alice@example.test' })).status, 303);
    assert.notEqual(state(t).email_verified_at, null);
    assert.equal(sent.length, 0, 'nothing to confirm');
    assert.equal((await alice.post('/ui/email', { csrf: alice.csrf, email: 'someone-else@example.test' })).status, 303);
    assert.deepEqual({ ...state(t) }, { email: 'someone-else@example.test', email_verified_at: null });
    await linkFor(sent, 1);
    assert.equal(sent[0]!.to[0]!.address, 'someone-else@example.test');
  });

  it('sends at most three confirmation mails a day', async () => {
    const { t, sent } = withMail();
    const alice = await t.human(t.alice);
    for (let i = 0; i < 3; i++) assert.equal((await alice.post('/ui/email', { csrf: alice.csrf, email: `a${i}@example.test` })).status, 303);
    const capped = await alice.post('/ui/email', { csrf: alice.csrf, email: 'victim@example.test' });
    assert.equal(capped.status, 409);
    assert.match(await capped.text(), /at most three a day/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sent.length, 3);
    assert.deepEqual({ ...state(t) }, { email: 'victim@example.test', email_verified_at: null });
  });

  it('hides email settings while the relay sends no email', async () => {
    const t = setup();
    const alice = await t.human(t.alice);
    const page = await alice.settings();
    assert.doesNotMatch(page, /action="\/ui\/email"|\/ui\/notifications\/email/);
    assert.equal((await alice.post('/ui/email', { csrf: alice.csrf, email: 'alice@example.test' })).status, 303);
    assert.equal(t.db.prepare('SELECT 1 FROM email_confirmations').get(), undefined);
  });
});
