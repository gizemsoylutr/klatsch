// A client on protocol 2025-06-18 without dialogs or MCP tasks, as Codex connects by default: every tool
// works, approvals fall back to a code and an approve_url the person types into their browser, and
// `watch` answers plainly that the human is reminded when they next type.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { browser, CODE, startRelay, type Browser, type Relay } from './harness.ts';

const BOB_TEXT = 'Cursor paging: use a keyset cursor on (created_at, id) and return next_cursor instead of OFFSET.';
const ALICE_TEXT = 'My Node.js API on Postgres returns every row at once.';

/** An initialize handshake on 2025-06-18, then plain JSON-RPC posts; no capabilities. */
async function legacyAgent(base: string, token: string) {
  let id = 0;
  const post = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const text = await response.text();
    return JSON.parse(text.trimStart().startsWith('{') ? text : (text.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? '{}'));
  };
  const init = await post('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-like', version: '0' } });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await post('tools/call', { name, arguments: args })).result;
    return { result, data: result?.structuredContent, text: result?.content?.[0]?.text as string, raw: JSON.stringify(result) };
  };
  return { init: init.result, post, call };
}

describe('a 2025-06-18 client without dialogs or tasks (Codex by default)', () => {
  let relay: Relay;
  let alice: Awaited<ReturnType<typeof legacyAgent>>;
  let bob: Awaited<ReturnType<typeof legacyAgent>>;
  let aliceBrowser: Browser, bobBrowser: Browser;
  let introId = '';

  before(async () => {
    relay = await startRelay();
    const { klatsch } = relay;
    const a = klatsch.ensureUser('alice', 'Alice');
    const b = klatsch.ensureUser('bob', 'Bob');
    klatsch.addMember(klatsch.ensureCircle('demo', a), b, a);
    klatsch.approveSip(b, klatsch.draftSip(b, { status: 'solved', tags: ['nodejs', 'express'], summary: BOB_TEXT }, 'cli').sipId, 'cli');
    alice = await legacyAgent(relay.base, relay.agentToken(a));
    bob = await legacyAgent(relay.base, relay.agentToken(b));
    aliceBrowser = await browser(relay, relay.loginLink(a));
    bobBrowser = await browser(relay, relay.loginLink(b));
  });
  after(async () => {
    await relay.close();
  });

  it('the agent connects on 2025-06-18 and sees every Klatsch tool', async () => {
    assert.equal(alice.init.protocolVersion, '2025-06-18');
    const tools = (await alice.post('tools/list', {})).result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(tools, ['answer_ask', 'ask_person', 'find_matches', 'friends', 'inbox', 'klatsch_card', 'pending', 'request_intro', 'respond_intro', 'show_question', 'thank_note', 'update_card', 'watch']);
  });

  it("Alice's agent shares with a code; she types it in her browser and shares", async () => {
    const asked = await alice.call('update_card', { status: 'looking', tags: ['nodejs', 'express'], summary: ALICE_TEXT, ask_for_intro: false });
    assert.equal(asked.data.state, 'pending-approval');
    assert.match(asked.data.code, CODE, 'no dialog, so the agent shows the code');
    assert.equal(asked.data.approve_url, `${relay.base}/ui/device`);
    assert.match(asked.data.note, /show your human the code and approve_url/);
    assert.equal((await aliceBrowser.post('/ui/device', { code: asked.data.code })).status, 200);
    assert.equal((await aliceBrowser.post('/ui/device/decide', { code: asked.data.code, decision: 'approved' })).status, 200);
  });

  it('she finds the match and asks for an intro, again with a code', async () => {
    const found = await alice.call('find_matches', { tags: ['nodejs'] });
    assert.equal(found.data.matches.length, 1);
    const asked = await alice.call('request_intro', { match_id: found.data.matches[0].match_id });
    assert.match(asked.data.code, CODE);
    await aliceBrowser.post('/ui/device', { code: asked.data.code });
    assert.equal((await aliceBrowser.post('/ui/device/decide', { code: asked.data.code, decision: 'approved' })).status, 200);
  });

  it("Bob's agent hears of it before his next prompt and answers it with a code; he accepts", async () => {
    assert.match((await bob.call('pending')).text, /^Klatsch notice for your human: 1 intro request waiting/);
    const inbox = await bob.call('inbox');
    introId = inbox.data.events.find((e: { kind: string }) => e.kind === 'intro.requested').ref;
    const answer = await bob.call('respond_intro', { intro_id: introId });
    assert.match(answer.data.code, CODE);
    await bobBrowser.post('/ui/device', { code: answer.data.code });
    assert.equal((await bobBrowser.post('/ui/device/decide', { code: answer.data.code, decision: 'approved' })).status, 200);
    const accepted = (await alice.call('inbox')).data.events.find((e: { kind: string }) => e.kind === 'intro.accepted');
    assert.equal(accepted.with, '@bob');
  });

  it('watch answers plainly: the human is reminded when they next type', async () => {
    const watched = await alice.call('watch');
    assert.equal(watched.result.resultType, undefined, 'no task on 2025-06-18');
    assert.equal(watched.text, "This client can't wait in the background. Klatsch will remind your human when they next type.");
  });
});
