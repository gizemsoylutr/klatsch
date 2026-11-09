// An idle session that hears back by itself: Alice's agent calls `watch` on a client with MCP tasks and
// gets a task at once; it completes when Bob accepts her intro, with counts and his handle only. Only the
// token that started it can see it; it survives a relay restart; revoking the token ends it.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { agent, browser, startRelay, wireAgent, type Relay } from './harness.ts';
import { VERSION } from '../../src/version.ts';

const BOB_TEXT = 'Cursor paging: use a keyset cursor on (created_at, id) and return next_cursor instead of OFFSET.';
const ALICE_TEXT = 'My Node.js API on Postgres returns every row at once.';
const UNKNOWN = -32602;

describe('watch: an idle session hears back when Bob accepts', () => {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'klatsch-watch-')), 'klatsch.db');
  const secret = randomBytes(32);
  let relay: Relay;
  let alice = '';
  let bob = '';
  let aliceToken = '';
  let introId = '';
  let taskId = '';
  let call: ReturnType<typeof wireAgent>;

  before(async () => {
    relay = await startRelay({ dbFile, secret });
    const { klatsch } = relay;
    alice = klatsch.ensureUser('alice', 'Alice');
    bob = klatsch.ensureUser('bob', 'Bob');
    klatsch.addMember(klatsch.ensureCircle('demo', alice), bob, alice);
    klatsch.approveSip(bob, klatsch.draftSip(bob, { status: 'solved', tags: ['nodejs', 'express'], summary: BOB_TEXT }, 'cli').sipId, 'cli');
    klatsch.approveSip(alice, klatsch.draftSip(alice, { status: 'looking', tags: ['nodejs', 'express'], summary: ALICE_TEXT }, 'cli').sipId, 'cli');
    introId = klatsch.requestIntro(alice, (relay.db.prepare('SELECT id FROM matches').get() as { id: string }).id).introId;
    klatsch.inbox(alice);
    aliceToken = relay.agentToken(alice);
    call = wireAgent(relay.base, aliceToken, { tasks: true });
  });
  after(async () => {
    await relay.close();
  });

  it('the relay lists the MCP tasks extension in server/discover', async () => {
    const discovered = await wireAgent(relay.base, aliceToken)('server/discover');
    assert.deepEqual(discovered.result.capabilities.extensions, { 'io.modelcontextprotocol/tasks': {} });
  });

  it("Alice's agent calls watch on a client with MCP tasks and gets a working task at once", async () => {
    const answer = await call('tools/call', { name: 'watch', arguments: {} });
    const task = answer.result;
    assert.equal(task.resultType, 'task');
    assert.equal(task.status, 'working');
    assert.match(task.taskId, /^[\w-]{22}$/, '128 random bits');
    for (const field of ['createdAt', 'lastUpdatedAt']) assert.ok(!Number.isNaN(Date.parse(task[field])), field);
    assert.equal(task.ttlMs, null);
    assert.equal(task.pollIntervalMs, 5000);
    taskId = task.taskId;
    assert.equal((await call('tools/call', { name: 'watch', arguments: {} })).result.taskId, taskId, 'a second call returns the same task');
  });

  it('tasks/get says working while nothing happens', async () => {
    const polled = (await call('tasks/get', { taskId })).result;
    assert.equal(polled.resultType, 'complete');
    assert.equal(polled.status, 'working');
    assert.equal(polled.result, undefined);
  });

  it("only the token that started it can see the task: Bob's token and Alice's other token get unknown-task", async () => {
    for (const token of [relay.agentToken(bob), relay.agentToken(alice)]) {
      const other = wireAgent(relay.base, token, { tasks: true });
      assert.equal((await other('tasks/get', { taskId })).error?.code, UNKNOWN);
      assert.equal((await other('tasks/cancel', { taskId })).error?.code, UNKNOWN);
    }
    assert.equal((await call('tasks/get', { taskId: 'made-up-id' })).error?.code, UNKNOWN);
  });

  it('the task survives a relay restart', async () => {
    await relay.close();
    relay = await startRelay({ dbFile, secret });
    call = wireAgent(relay.base, aliceToken, { tasks: true });
    assert.equal((await call('tasks/get', { taskId })).result.status, 'working');
  });

  it("Bob accepts in his browser; Alice's task completes with counts and his handle, never his name or text", async () => {
    const bobBrowser = await browser(relay, relay.loginLink(bob));
    assert.equal((await bobBrowser.post(`/ui/intros/${introId}/approve`)).status, 303);
    const done = (await call('tasks/get', { taskId })).result;
    assert.equal(done.status, 'completed');
    const text: string = done.result.content[0].text;
    assert.match(text, /^Klatsch notice for your human: 1 accepted intro \(connected with @bob\)\./);
    assert.match(text, /Call watch again to keep listening\.$/);
    assert.doesNotMatch(text.replaceAll('@bob', ''), /Bob|bob|keyset|every row/);
  });

  it("Alice's own share does not wake her own watch: one wake per event, and only for news from someone else", async () => {
    const { klatsch } = relay;
    const watching = (await call('tools/call', { name: 'watch', arguments: {} })).result.taskId;
    klatsch.approveSip(bob, klatsch.draftSip(bob, { status: 'solved', tags: ['pagination'], summary: 'Paged it.' }, 'cli').sipId, 'cli');
    // Alice's own looking sip on the same topic: it finds Bob's, but she did that herself.
    klatsch.approveSip(alice, klatsch.draftSip(alice, { status: 'looking', tags: ['pagination'], summary: 'Paging again.' }, 'cli').sipId, 'cli');
    assert.equal((await call('tasks/get', { taskId: watching })).result.status, 'working');
    await call('tasks/cancel', { taskId: watching });
    assert.equal((await call('tools/call', { name: 'watch', arguments: {} })).result.status, 'working', 'and her next watch does not count it as missed news');
    const open = (await call('tools/call', { name: 'watch', arguments: {} })).result.taskId;
    await call('tasks/cancel', { taskId: open });
  });

  it('news that arrives before the agent calls watch again is not lost, and is told once', async () => {
    const { klatsch } = relay;
    klatsch.approveSip(bob, klatsch.draftSip(bob, { status: 'solved', tags: ['express'], summary: 'Another solved one.' }, 'cli').sipId, 'cli');
    const rearmed = (await call('tools/call', { name: 'watch', arguments: {} })).result;
    assert.equal(rearmed.status, 'completed', 'completed at once with the news it missed');
    assert.match((await call('tasks/get', { taskId: rearmed.taskId })).result.result.content[0].text, /\d new match/);
    const next = (await call('tools/call', { name: 'watch', arguments: {} })).result;
    assert.equal(next.status, 'working', 'the same news does not complete it again');
    assert.notEqual(next.taskId, rearmed.taskId);
  });

  it('suggests watch only to a client that can run it', async () => {
    assert.match((await call('tools/call', { name: 'pending', arguments: {} })).result.content[0].text, /Call watch so you hear back without your human asking\.$/);
    const plain = wireAgent(relay.base, aliceToken);
    assert.doesNotMatch((await plain('tools/call', { name: 'pending', arguments: {} })).result.content[0].text, /Call watch/);
  });

  it('the client can stop a watch; stopping and starting again leaves at most two finished rows', async () => {
    const own = wireAgent(relay.base, relay.agentToken(alice), { tasks: true });
    let last = '';
    for (let i = 0; i < 5; i++) {
      last = (await own('tools/call', { name: 'watch', arguments: {} })).result.taskId;
      assert.deepEqual((await own('tasks/cancel', { taskId: last })).result, { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'klatsch', version: VERSION } } });
    }
    const stopped = (await own('tasks/get', { taskId: last })).result;
    assert.equal(stopped.status, 'cancelled');
    assert.equal(stopped.statusMessage, 'Stopped.');
    const tokenId = (relay.db.prepare('SELECT token_id FROM watches WHERE id = ?').get(last) as { token_id: string }).token_id;
    assert.ok((relay.db.prepare('SELECT count(*) AS n FROM watches WHERE token_id = ?').get(tokenId) as { n: number }).n <= 2);
  });

  it('Alice revokes the token in her browser; its watch ends and the token gets no answer any more', async () => {
    const token = relay.agentToken(alice);
    const own = wireAgent(relay.base, token, { tasks: true });
    const watching = (await own('tools/call', { name: 'watch', arguments: {} })).result.taskId;
    const tokenId = (relay.db.prepare('SELECT token_id FROM watches WHERE id = ?').get(watching) as { token_id: string }).token_id;
    const aliceBrowser = await browser(relay, relay.loginLink(alice));
    assert.equal((await aliceBrowser.post(`/ui/tokens/${tokenId}/revoke`)).status, 303);
    assert.equal((relay.db.prepare('SELECT status FROM watches WHERE id = ?').get(watching) as { status: string }).status, 'cancelled');
    const after = await fetch(`${relay.base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(after.status, 401, 'a revoked token is refused before any task is looked up');
  });

  it('at most five sessions of one person listen at a time', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await wireAgent(relay.base, relay.agentToken(bob), { tasks: true })('tools/call', { name: 'watch', arguments: {} }));
    assert.deepEqual(
      results.map((r) => (r.result.isError ? 'error' : r.result.resultType)),
      ['task', 'task', 'task', 'task', 'task', 'error'],
    );
    assert.match(results[5]!.result.content[0].text, /Five sessions are already listening on Klatsch for your human/);
  });

  it('a client without MCP tasks gets a plain answer: the human is reminded when they next type', async () => {
    const plain = await agent(relay, relay.agentToken(alice));
    assert.equal((await plain.call('watch')).text, "This client can't wait in the background. Klatsch will remind your human when they next type.");
    await plain.close();
  });
});
