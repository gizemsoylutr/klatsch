// Guest mode ("Try it without an account"): one click gives a guest for a few hours whose only friend is the demo
// friend, which answers with fixed lines and no model. A guest reaches no real person (no invites, friend links,
// public circles or other memberships), adds no sign-in, sends no files, and goes with everything in it when its
// hours are up. A chat app (ChatGPT, Claude) can connect as the guest, and its token goes with the guest too.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { createInvite, findInvite } from '../../src/auth/invites.ts';
import { GUEST_HOURS, reservedHandle } from '../../src/service.ts';
import { agent, browser, signedOutBrowser, startRelay, unauthorized, type Relay } from './harness.ts';

const verifier = () => randomBytes(32).toString('base64url');
const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url');
const guestOf = (relay: Relay) =>
  (relay.db.prepare('SELECT id FROM users WHERE guest_expires_at IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as { id: string } | undefined)?.id;
const inviteToken = (link: string) => new URL(link).pathname.split('/').at(-1)!;

describe('guest mode is off unless the operator turns it on', () => {
  let relay: Relay;
  before(async () => (relay = await startRelay()));
  after(async () => relay.close());

  it('no guest page, no link on the landing or sign-in page, and the service refuses', async () => {
    assert.equal((await fetch(`${relay.base}/ui/guest`)).status, 404);
    const visitor = signedOutBrowser(relay);
    assert.doesNotMatch((await visitor.go('/ui')).html, /\/ui\/guest/);
    assert.equal((await visitor.post('/ui/guest')).status, 404);
    assert.doesNotMatch(await (await fetch(`${relay.base}/`, { headers: { Accept: 'text/html' } })).text(), /\/ui\/guest/);
    assert.throws(() => relay.klatsch.startGuest(), /not on for this relay/);
  });
});

describe('guest mode: a few hours with the demo friend, and nobody else', () => {
  let relay: Relay;
  let alice = '';

  before(async () => {
    relay = await startRelay({ guest: true });
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('home', alice);
  });
  after(async () => relay.close());

  it('the landing and sign-in pages offer it; one click makes a guest with the demo conversation and question waiting', async () => {
    assert.match(await (await fetch(`${relay.base}/`, { headers: { Accept: 'text/html' } })).text(), /href="\/ui\/guest">Try it without an account/);
    const visitor = signedOutBrowser(relay);
    assert.match((await visitor.go('/ui')).html, /href="\/ui\/guest"/);
    const page = await visitor.go('/ui/guest');
    assert.match(page.html, new RegExp(`Try Klatsch for ${GUEST_HOURS} hours`));
    assert.match(page.html, /not a person and not an AI/);
    const home = await visitor.post('/ui/guest');
    assert.equal(home.status, 200);
    assert.match(home.html, /You are a guest\. This account and everything in it is deleted in [45] h/);
    const guest = guestOf(relay)!;
    const user = relay.klatsch.user(guest);
    assert.match(user.handle, /^guest-[a-z0-9]{6}$/);
    assert.equal(user.display_name, 'Guest');
    assert.deepEqual(relay.klatsch.askablePeople(guest), [{ handle: '@klatsch-demo', friend: true }]);
    assert.equal(relay.klatsch.conversation(guest, '@klatsch-demo').messages.length, 3);
    assert.equal(relay.klatsch.asksOf(guest).filter((k) => k.role === 'helper' && k.state === 'open').length, 1);
    // Writing to the demo friend gets a fixed reply back.
    const chat = await visitor.post('/ui/chat/klatsch-demo', { text: 'Museum on Saturday? I can get tickets.' });
    assert.equal(chat.status, 200);
    assert.match(relay.klatsch.conversation(guest, '@klatsch-demo').messages.at(-1)!.text, /count me in/);
    // Settings is only the way out: no email, passkey, GitHub or Google to add.
    const settings = await visitor.go('/ui/settings');
    assert.match(settings.html, /End guest session/);
    assert.doesNotMatch(settings.html, /action="\/ui\/(email|auth\/github\/connect|auth\/google\/connect|settings\/delete)"/);
  });

  it('a guest reaches no real person: no invites, friend links, public circles or new memberships', async () => {
    const guest = relay.klatsch.startGuest();
    const visitor = await browser(relay, relay.loginLink(guest));
    for (const path of ['/ui/friends/invite', '/ui/email', '/ui/passkeys/options', '/ui/auth/github/connect', '/ui/auth/google/connect', '/ui/settings/delete'])
      assert.equal((await visitor.post(path, { email: 'g@example.org' })).status, 403, path);
    for (const path of ['/ui/notes', '/ui/settings/delete'])
      assert.equal((await visitor.get(path)).status, 403, path);
    const aliceLink = createInvite(relay.db, relay.secret, relay.klatsch.friendCircle(alice), alice, relay.base);
    assert.throws(() => relay.klatsch.acceptInvite(guest, findInvite(relay.db, relay.secret, inviteToken(aliceLink.link))!), /demo friend only/);
    assert.throws(() => relay.klatsch.friendCircle(guest), /demo friend only/);
    assert.throws(() => relay.klatsch.addMember(relay.klatsch.ensureCircle('home', alice), guest, alice), /demo friend only/);
    assert.throws(() => relay.klatsch.ensureCircle('mine', guest), /demo friend only/);
    assert.throws(() => relay.klatsch.setVerifiedEmail(guest, 'g@example.org', 'web'), /cannot add a sign-in/);
    assert.throws(() => relay.klatsch.linkGitHub(guest, { id: 99, login: 'someone' }), /cannot add a sign-in/);
    // Neither side can ask the other: they share no circle.
    const guestAgent = await agent(relay, relay.agentToken(guest), { dialogs: false });
    assert.equal((await guestAgent.call('ask_person', { handle: '@alice', question: 'Hello?' })).isError, true);
    assert.equal((await guestAgent.call('send_message', { handle: '@alice', text: 'Hello?' })).isError, true);
    await guestAgent.close();
    const aliceAgent = await agent(relay, relay.agentToken(alice), { dialogs: false });
    assert.equal((await aliceAgent.call('ask_person', { handle: `@${relay.klatsch.user(guest).handle}`, question: 'Hello?' })).isError, true);
    await aliceAgent.close();
    // No files, with a question or a message.
    const asked = relay.klatsch.asksOf(guest).find((k) => k.role === 'helper')!;
    assert.throws(() => relay.klatsch.attach(guest, asked.id, { name: 'a.png', bytes: new Uint8Array(8) }), /Files need an account/);
    const messageId = relay.klatsch.sendMessage(guest, '@klatsch-demo', 'Hi!');
    assert.throws(() => relay.klatsch.attachToMessage(guest, messageId, { name: 'a.png', bytes: new Uint8Array(8) }), /Files need an account/);
    // Nobody else can pick a guest-looking handle.
    assert.equal(reservedHandle('guest-abc123'), true);
    assert.equal(reservedHandle('guesthouse'), false);
  });

  it('a guest sends at most 30 messages and asks at most 5 questions; the demo friend has no limit', async () => {
    const guest = relay.klatsch.startGuest();
    // Each message gets a reply: the demo friend writes far more than 30 in all and is never stopped.
    for (let i = 0; i < 30; i++) relay.klatsch.sendMessage(guest, '@klatsch-demo', `Message ${i}`);
    assert.throws(() => relay.klatsch.sendMessage(guest, '@klatsch-demo', 'One more'), /at most 30 messages/);
    const chat = await agent(relay, relay.chatAppToken(guest), { dialogs: false, cards: true });
    for (let i = 0; i < 5; i++) {
      const asked = await chat.call('ask_person', { handle: '@klatsch-demo', question: `Which one, ${i}?` });
      assert.equal(asked.isError, false);
      await chat.call('klatsch_card', { key: asked.meta['dev.klatsch/card'].key, decision: 'approved' });
    }
    assert.equal((await chat.call('ask_person', { handle: '@klatsch-demo', question: 'And one more?' })).isError, true);
    await chat.close();
  });

  it('"End guest session" deletes the guest, its pair circle and everything the demo friend wrote to it', async () => {
    const guest = relay.klatsch.startGuest();
    const circle = relay.klatsch.friendshipOf(guest, relay.klatsch.ensureUser('klatsch-demo', 'Klatsch Demo'))!;
    const visitor = await browser(relay, relay.loginLink(guest));
    const ended = await visitor.post('/ui/guest/end');
    assert.match(ended.html, /Guest session ended/);
    assert.equal(relay.db.prepare('SELECT 1 FROM users WHERE id = ?').get(guest), undefined);
    assert.equal(relay.db.prepare('SELECT 1 FROM circles WHERE id = ?').get(circle), undefined);
    assert.equal((relay.db.prepare('SELECT count(*) AS n FROM messages WHERE circle_id = ?').get(circle) as { n: number }).n, 0);
    assert.equal((relay.db.prepare('SELECT count(*) AS n FROM asks WHERE helper_id = ? OR asker_id = ?').get(guest, guest) as { n: number }).n, 0);
    assert.equal((await visitor.get('/ui')).status, 401, 'the session went with it');
    // Not for anyone else.
    const real = await browser(relay, relay.loginLink(alice));
    assert.equal((await real.post('/ui/guest/end')).status, 404);
  });

  it('a chat app connects as a guest from its sign-in page; its token works, and goes when the hours are up', async () => {
    const callback = `${relay.base}/test-app/callback`;
    const registered = (await (
      await fetch(`${relay.base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Test App', redirect_uris: [callback] }) })
    ).json()) as { client_id: string };
    const v = verifier();
    const fields = { client_id: registered.client_id, redirect_uri: callback, code_challenge: challengeOf(v), code_challenge_method: 'S256', response_type: 'code', state: 'g1', resource: `${relay.base}/mcp` };
    const app = signedOutBrowser(relay);
    const signIn = await app.go(`/ui/oauth/authorize?${new URLSearchParams(fields)}`);
    assert.equal(signIn.status, 401);
    assert.match(signIn.html, /href="\/ui\/guest"/);
    await app.go('/ui/guest');
    const consent = await app.post('/ui/guest');
    assert.match(consent.html, /Connect Test App\?/, 'back to the consent page, as a guest');
    assert.match(consent.html, /this connection ends with the guest account/);
    const allowed = await app.post('/ui/oauth/authorize', { ...fields, decision: 'allow' });
    const code = new URL(allowed.hops.at(-1)!).searchParams.get('code')!;
    const traded = (await (
      await fetch(`${relay.base}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: registered.client_id, redirect_uri: callback, code_verifier: v }).toString(),
      })
    ).json()) as { access_token: string; refresh_token: string };
    const guest = guestOf(relay)!;
    const chat = await agent(relay, traded.access_token);
    assert.deepEqual((await chat.call('friends')).data.people.map((f: { handle: string }) => f.handle), ['@klatsch-demo']);
    await chat.close();
    // Its hours are up: the next request finds nothing of it, and neither token works.
    relay.db.prepare('UPDATE users SET guest_expires_at = ? WHERE id = ?').run(Date.now() - 1, guest);
    await assert.rejects(agent(relay, traded.access_token), unauthorized);
    assert.equal(relay.db.prepare('SELECT 1 FROM users WHERE id = ?').get(guest), undefined);
    const refreshed = await fetch(`${relay.base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: traded.refresh_token, client_id: registered.client_id }).toString(),
    });
    assert.equal(refreshed.status, 400);
  });
});

describe('guest mode limits who can make guests, and how many live at once', () => {
  it('three guests an hour from one network, then a busy page', async () => {
    const relay = await startRelay({ guest: true });
    const visitor = signedOutBrowser(relay);
    for (let i = 0; i < 3; i++) {
      await visitor.go('/ui/guest');
      assert.equal((await visitor.post('/ui/guest')).status, 200);
    }
    await visitor.go('/ui/guest');
    const busy = await visitor.post('/ui/guest');
    assert.equal(busy.status, 429);
    assert.match(busy.html, /Guest mode is busy/);
    // Another site cannot make guests for a browser.
    const forged = await fetch(`${relay.base}/ui/guest`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'csrf=x' });
    assert.equal(forged.status, 403);
    await relay.close();
  });

  it('at most 300 live guests on a relay; one whose hours are up makes room', async () => {
    const relay = await startRelay({ guest: true });
    const first = relay.klatsch.startGuest();
    for (let i = 1; i < 300; i++) relay.klatsch.startGuest();
    assert.throws(() => relay.klatsch.startGuest(), /Guest mode is busy/);
    relay.db.prepare('UPDATE users SET guest_expires_at = ? WHERE id = ?').run(Date.now() - 1, first);
    assert.ok(relay.klatsch.startGuest());
    await relay.close();
  });
});

describe('the one rule that keeps guests from real people', () => {
  it('memberships are written in exactly four places, each of which refuses a guest or is the guest’s own start', () => {
    const source = readFileSync(new URL('../../src/service.ts', import.meta.url), 'utf8');
    // ensureCircle, friendCircle and addMember call refuseGuest; startGuest writes the guest's pair circle.
    // A new place that adds memberships must refuse guests too, and then be counted here.
    assert.equal(source.match(/INSERT (OR IGNORE )?INTO memberships/g)?.length, 4);
    for (const name of ['ensureCircle', 'friendCircle', 'addMember', 'joinPublic', 'acceptInvite']) {
      const body = source.slice(source.indexOf(`  ${name}(`), source.indexOf(`  ${name}(`) + 400);
      assert.match(body, /this\.refuseGuest\(/, name);
    }
  });
});
