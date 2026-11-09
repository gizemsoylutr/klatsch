import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getApproval } from '../src/auth/approvals.ts';
import { createToken, revokeTokens, verifyToken } from '../src/auth/tokens.ts';
import { loadConfig, loadSecret } from '../src/config.ts';
import { seedVocabulary } from '../src/match/vocabulary.ts';
import { createRelay } from '../src/relay/app.ts';
import { Klatsch } from '../src/service.ts';
import { openDb } from '../src/store/db.ts';
import { BASE, setup } from './helpers.ts';

const BOB_TEXT = 'Use a keyset cursor on (created_at, id) and return next_cursor from the route handler.';
const ALICE_TEXT = 'Node.js API on Postgres returns every row at once.';
const CODE = /[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}/;

type T = ReturnType<typeof setup>;
type Answer = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> };
type Dialog = { message: string; url?: string };

/**
 * A real MCP client on the 2026-07-28 protocol, as Claude Code connects.
 * `onDialog` plays the person in front of the terminal; every dialog message is recorded.
 */
async function connect(t: T, token: string, onDialog: (dialog: Dialog, round: number) => Promise<Answer> | Answer) {
  const dialogs: Dialog[] = [];
  const sent: { body: any; headers: Record<string, string> }[] = [];
  const client = new Client(
    { name: 'test-host', version: '0' },
    { capabilities: { elicitation: { form: {}, url: {} } }, versionNegotiation: { mode: 'auto' } },
  );
  client.setRequestHandler('elicitation/create', async (request) => {
    const params = request.params as { message?: string; url?: string };
    const dialog = { message: String(params.message ?? ''), ...(params.url ? { url: params.url } : {}) };
    dialogs.push(dialog);
    return onDialog(dialog, dialogs.length);
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: async (url, init) => {
        if (typeof init?.body === 'string') sent.push({ body: JSON.parse(init.body), headers: Object.fromEntries(new Headers(init.headers).entries()) });
        return t.app.request(String(url), init);
      },
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as { structuredContent?: any; content?: { text?: string }[]; isError?: boolean };
    const text = result.content?.[0]?.text ?? '';
    return { isError: Boolean(result.isError), data: result.structuredContent ?? JSON.parse(text || '{}'), raw: JSON.stringify(result) };
  };
  return { call, dialogs, sent };
}

function bobSolved(t: T) {
  const draft = t.klatsch.draftSip(t.bob, { status: 'solved', tags: ['nodejs', 'express', 'pagination'], summary: BOB_TEXT }, 'cli');
  t.klatsch.approveSip(t.bob, draft.sipId, 'cli');
}

/** The client opens the approval page in the person's browser; they decide there. */
function approvesInBrowser(human: Awaited<ReturnType<T['human']>>, decision: 'approved' | 'declined' = 'approved') {
  return async (dialog: Dialog): Promise<Answer> => {
    await human.openApproval(dialog.url!, decision);
    return { action: 'accept' };
  };
}

describe('approval by code', () => {
  it('shares, and asks for intros, once the human approves the code in their web session', async () => {
    const t = setup();
    bobSolved(t);
    const human = await t.human(t.alice);
    const alice = await connect(t, t.token(t.alice), approvesInBrowser(human));
    const result = await alice.call('update_card', { status: 'looking', tags: ['pagination', 'express'], summary: ALICE_TEXT });
    assert.equal(result.data.state, 'shared');
    assert.equal(result.data.note, 'Your human shared it on the approval page, and intro requests went to whoever solved it.', 'no watch hint: this client cannot run MCP tasks');
    assert.equal(result.data.intros.length, 1);
    assert.match(alice.dialogs[0]!.url!, /\/ui\/approvals\/ap_/, 'URL mode: the client opens the page');
    assert.match(alice.dialogs[0]!.message, CODE, 'the code for another device is in the dialog');
    assert.doesNotMatch(result.raw, CODE, 'and never in what the agent gets');
    assert.equal((t.db.prepare(`SELECT via FROM audit WHERE action = 'sip.approve' AND user_id = ?`).get(t.alice) as { via: string }).via, 'web');
  });

  it('never approves on the agent\'s word: accepting the dialog without the human changes nothing', async () => {
    const t = setup();
    const rogue = await connect(t, t.token(t.alice), () => ({ action: 'accept' }));
    const result = await rogue.call('update_card', { status: 'looking', tags: ['express'], summary: ALICE_TEXT });
    assert.equal(result.data.state, 'pending-approval');
    assert.doesNotMatch(result.raw, CODE);
    assert.equal((t.db.prepare(`SELECT count(*) AS n FROM sips`).get() as { n: number }).n, 0);
  });

  it('opens an approval page only for the user behind the request', async () => {
    const t = setup();
    const alice = await connect(t, t.token(t.alice), () => ({ action: 'cancel' }));
    await alice.call('update_card', { status: 'solved', tags: ['express'], summary: 'x' });
    const bob = await t.human(t.bob);
    const { opened } = await bob.openApproval(alice.dialogs[0]!.url!);
    assert.equal(opened.status, 404);
    const aliceHuman = await t.human(t.alice);
    const own = await aliceHuman.openApproval(alice.dialogs[0]!.url!);
    assert.equal(own.decided?.status, 200);
    assert.equal((await aliceHuman.openApproval(alice.dialogs[0]!.url!)).opened.status, 404, 'single use');
  });

  it('works without dialogs: the agent gets the code, the inbox gets the outcome', async () => {
    const t = setup();
    const token = t.token(t.alice);
    const pending = await t.tool(token, 'update_card', { status: 'solved', tags: ['express'], summary: 'done' });
    assert.equal(pending.data.state, 'pending-approval');
    const human = await t.human(t.alice);
    const { confirmPage } = await human.enterCode(pending.data.code);
    assert.match(confirmPage, /Share (this sip|what you solved)\?/);
    const inbox = await t.tool(token, 'inbox', {});
    assert.ok(inbox.data.events.some((e: { kind: string }) => e.kind === 'approval.approved'));
  });

  it('accepts a code only in its owner\'s session, once, and before it expires', async () => {
    const t = setup();
    const token = t.token(t.alice);
    const first = await t.tool(token, 'update_card', { status: 'solved', tags: ['express'], summary: 'one' });
    const bob = await t.human(t.bob);
    assert.equal((await bob.enterCode(first.data.code)).confirm.status, 404, 'not in another person\'s session');
    const alice = await t.human(t.alice);
    assert.equal((await alice.enterCode(first.data.code)).decided?.status, 200);
    assert.equal((await alice.enterCode(first.data.code)).confirm.status, 404, 'single use');
    const second = await t.tool(token, 'update_card', { status: 'solved', tags: ['javascript'], summary: 'two' });
    t.db.prepare('UPDATE approvals SET expires_at = ?').run(Date.now() - 1);
    assert.equal((await alice.enterCode(second.data.code)).confirm.status, 404, 'expired');
  });

  it('cannot be decided with an agent token, and limits wrong codes', async () => {
    const t = setup();
    const token = t.token(t.alice);
    const pending = await t.tool(token, 'update_card', { status: 'solved', tags: ['express'], summary: 'x' });
    const viaToken = await t.app.request(`${BASE}/ui/device/decide`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: pending.data.code, decision: 'approved' }).toString(),
    });
    assert.equal(viaToken.status, 401);
    const alice = await t.human(t.alice);
    for (let i = 0; i < 10; i++) await alice.enterCode('BBBB-BBBB');
    assert.equal((await alice.enterCode(pending.data.code)).confirm.status, 429);
  });
});

describe('answering an intro by code', () => {
  it('shows the request only in the human\'s session; the agent learns the outcome', async () => {
    const t = setup();
    bobSolved(t);
    const aliceHuman = await t.human(t.alice);
    const alice = await connect(t, t.token(t.alice), approvesInBrowser(aliceHuman));
    await alice.call('update_card', { status: 'looking', tags: ['pagination'], summary: ALICE_TEXT });
    const introId = (t.db.prepare('SELECT id FROM intros').get() as { id: string }).id;

    const bobHuman = await t.human(t.bob);
    let confirmPage = '';
    const bob = await connect(t, t.token(t.bob), async (dialog) => {
      confirmPage = (await bobHuman.openApproval(dialog.url!)).html;
      return { action: 'accept' };
    });
    const answered = await bob.call('respond_intro', { intro_id: introId });
    assert.equal(answered.data.state, 'accepted');
    assert.match(confirmPage, /Node\.js API on Postgres returns every row/, 'the human reads the request');
    assert.doesNotMatch(confirmPage, /Alice/, 'but not who asks');
    assert.doesNotMatch(JSON.stringify(bob.dialogs) + answered.raw, /Node\.js API on Postgres returns|Alice/, 'neither the dialog nor the agent shows it');
    assert.match(await bobHuman.page(), /Alice/, 'names after both accepted');
    assert.equal(answered.data.with, '@alice', 'once both accepted, the agent learns the handle');
    // The second round of this call: told as what the human just did, with no page to go to.
    assert.equal(answered.data.note, "Your human accepted it on the approval page. You're connected with @alice. You can talk directly; their name and sip are on your human's Klatsch page, not here.");
    assert.equal(answered.data.approve_url, undefined);

    // Alice's agent hears it too: the handle only, never the name or Bob's text.
    const aliceToken = t.token(t.alice);
    const reminder = (await t.tool(aliceToken, 'pending', {})).body.result.content[0].text as string;
    assert.match(reminder, /1 accepted intro \(connected with @bob\)/);
    const inbox = await t.tool(aliceToken, 'inbox', {});
    const accepted = inbox.data.events.find((e: { kind: string }) => e.kind === 'intro.accepted');
    assert.equal(accepted.with, '@bob');
    assert.match(accepted.text, /You're connected with @bob\./);
    assert.doesNotMatch(reminder + inbox.raw, /Bob\b|Use a keyset cursor/, 'no display name, no sip text');
  });
});

describe('sealed dialog state', () => {
  it('is not accepted when replayed with other arguments', async () => {
    const t = setup();
    const human = await t.human(t.alice);
    const alice = await connect(t, t.token(t.alice), approvesInBrowser(human));
    await alice.call('update_card', { status: 'solved', tags: ['express'], summary: 'harmless A' });
    const retry = alice.sent.find((s) => s.body.method === 'tools/call' && s.body.params?.requestState)!;
    const params = { ...retry.body.params, arguments: { status: 'looking', tags: ['javascript'], summary: 'customer secret B' } };
    delete params.inputResponses;
    const replay = await t.app.request(`${BASE}/mcp`, {
      method: 'POST',
      headers: retry.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params }),
    });
    assert.doesNotMatch(await replay.text(), /"state":"shared"/, 'the agent is not told B was shared');
    const sips = t.db.prepare('SELECT summary FROM sips').all() as { summary: string }[];
    assert.deepEqual(sips.map((s) => s.summary), ['harmless A']);
  });
});

describe('approval lifetime', () => {
  it('does not open an expired approval page', async () => {
    const t = setup();
    const alice = await connect(t, t.token(t.alice), () => ({ action: 'cancel' }));
    await alice.call('update_card', { status: 'solved', tags: ['express'], summary: 'late' });
    t.db.prepare('UPDATE approvals SET expires_at = ?').run(Date.now() - 1);
    const human = await t.human(t.alice);
    assert.equal((await human.openApproval(alice.dialogs[0]!.url!)).opened.status, 404);
    assert.equal((t.db.prepare('SELECT count(*) AS n FROM sips').get() as { n: number }).n, 0);
  });

  it('never runs an approval that expired between loading and deciding', async () => {
    const t = setup();
    await t.tool(t.token(t.alice), 'update_card', { status: 'solved', tags: ['express'], summary: 'late' });
    const id = (t.db.prepare('SELECT id FROM approvals').get() as { id: string }).id;
    const loaded = getApproval(t.db, t.alice, id)!;
    t.db.prepare('UPDATE approvals SET expires_at = ?').run(Date.now() - 1);
    // The web handlers load and decide in one synchronous step; this is the race they must survive.
    assert.throws(() => t.klatsch.decideApproval(t.alice, loaded, 'approved'));
    assert.equal((t.db.prepare('SELECT count(*) AS n FROM sips').get() as { n: number }).n, 0);
  });

  it('drops approvals that expired more than a day ago', async () => {
    const t = setup();
    const token = t.token(t.alice);
    await t.tool(token, 'update_card', { status: 'solved', tags: ['express'], summary: 'old' });
    t.db.prepare('UPDATE approvals SET expires_at = ?').run(Date.now() - 25 * 60 * 60 * 1000);
    await t.tool(token, 'update_card', { status: 'solved', tags: ['javascript'], summary: 'new' });
    assert.equal((t.db.prepare('SELECT count(*) AS n FROM approvals').get() as { n: number }).n, 1);
  });
});

describe('answering an intro', () => {
  it('refuses respond_intro from the person who asked', async () => {
    const t = setup();
    bobSolved(t);
    const aliceHuman = await t.human(t.alice);
    const alice = await connect(t, t.token(t.alice), approvesInBrowser(aliceHuman));
    await alice.call('update_card', { status: 'looking', tags: ['pagination'], summary: ALICE_TEXT });
    const introId = (t.db.prepare('SELECT id FROM intros').get() as { id: string }).id;
    const result = await alice.call('respond_intro', { intro_id: introId });
    assert.equal(result.isError, true);
  });

  it('records a decline made on the approval page', async () => {
    const t = setup();
    bobSolved(t);
    const aliceHuman = await t.human(t.alice);
    const alice = await connect(t, t.token(t.alice), approvesInBrowser(aliceHuman));
    await alice.call('update_card', { status: 'looking', tags: ['pagination'], summary: ALICE_TEXT });
    const introId = (t.db.prepare('SELECT id FROM intros').get() as { id: string }).id;
    const bobHuman = await t.human(t.bob);
    const bob = await connect(t, t.token(t.bob), approvesInBrowser(bobHuman, 'declined'));
    const answered = await bob.call('respond_intro', { intro_id: introId });
    assert.equal(answered.data.state, 'declined');
    assert.equal(answered.data.with, undefined, 'no handle without both accepting');
    assert.doesNotMatch(await aliceHuman.page(), /Bob/);
  });
});

describe('hosted relay', () => {
  it('checks the Origin host on /mcp', async () => {
    const config = loadConfig({ dataDir: '/nonexistent', host: '0.0.0.0', publicUrl: 'https://klatsch.example' });
    const db = openDb(':memory:');
    seedVocabulary(db);
    const secret = randomBytes(32);
    const klatsch = new Klatsch(db, config, () => {});
    const user = klatsch.ensureUser('alice', 'Alice');
    const { token } = createToken(db, secret, user, { ttlDays: 1 });
    const relay = createRelay(klatsch, secret);
    const call = (origin?: string) =>
      relay.request('https://klatsch.example/mcp', {
        method: 'POST',
        headers: {
          Host: 'klatsch.example',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    assert.equal((await call('https://evil.example')).status, 403);
    assert.equal((await call()).status, 200, 'non-browser clients send no Origin');
  });
});

describe('command line', () => {
  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
  const run = (args: string[]) => {
    try {
      return { status: 0, out: execFileSync('node', [cli, ...args], { stdio: 'pipe' }).toString() };
    } catch (error) {
      const e = error as { status: number; stderr: Buffer };
      return { status: e.status, out: e.stderr.toString() };
    }
  };

  it('refuses to print a login link without a terminal', () => {
    const result = run(['login', '--user', 'alice', '--data', mkdtempSync(join(tmpdir(), 'klatsch-'))]);
    assert.equal(result.status, 1);
    assert.match(result.out, /run it yourself in a terminal/);
  });

  it('revokes every token of a user', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'klatsch-'));
    const db = openDb(join(dataDir, 'klatsch.db'));
    const secret = loadSecret(dataDir);
    const klatsch = new Klatsch(db, loadConfig({ dataDir }), () => {});
    const alice = klatsch.ensureUser('alice', 'Alice');
    const a = createToken(db, secret, alice, { ttlDays: 1, label: 'dir:/a' }).token;
    const b = createToken(db, secret, alice, { ttlDays: 1, label: 'dir:/b' }).token;
    assert.equal(revokeTokens(db, alice, 'dir:/a'), 1, 'connect replaces one directory\'s token');
    assert.ok(verifyToken(db, secret, b));
    db.close();
    assert.match(run(['revoke', '--user', 'alice', '--data', dataDir]).out, /Revoked 1 token/);
    const reopened = openDb(join(dataDir, 'klatsch.db'));
    assert.equal(verifyToken(reopened, secret, a), undefined);
    assert.equal(verifyToken(reopened, secret, b), undefined);
  });
});
