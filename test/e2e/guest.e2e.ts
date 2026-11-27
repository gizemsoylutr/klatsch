// Guest mode ("Try it without an account"): one click gives a guest for a few hours. It invites a friend by link,
// who joins as a guest with one click, and the two write to each other. Guests and accounts never meet (no links
// either way, no other memberships), a guest adds no sign-in and sends no files, and it goes with everything in it
// when its hours are up. A chat app (ChatGPT, Claude) can connect as a guest, and its token goes with it.
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

/** Two guests who are friends: `a` made the link, `b` joined by it. */
function guestPair(relay: Relay) {
  const a = relay.klatsch.startGuest();
  const link = createInvite(relay.db, relay.secret, relay.klatsch.friendCircle(a), a, relay.base);
  const b = relay.klatsch.startGuest();
  relay.klatsch.acceptInvite(b, findInvite(relay.db, relay.secret, inviteToken(link.link))!);
  return { a, b, aHandle: `@${relay.klatsch.user(a).handle}`, bHandle: `@${relay.klatsch.user(b).handle}` };
}

describe('guest mode: a few hours with a friend who is a guest too, and nobody else', () => {
  let relay: Relay;
  let alice = '';

  before(async () => {
    relay = await startRelay({ guest: true });
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('home', alice);
  });
  after(async () => relay.close());

  it('one click makes a guest; its friend link lets a friend join as a guest with one click, straight into the conversation', async () => {
    assert.match(await (await fetch(`${relay.base}/`, { headers: { Accept: 'text/html' } })).text(), /href="\/ui\/guest">Try it without an account/);
    const first = signedOutBrowser(relay);
    assert.match((await first.go('/ui')).html, /href="\/ui\/guest"/);
    const page = await first.go('/ui/guest');
    assert.match(page.html, new RegExp(`Try Klatsch for ${GUEST_HOURS} hours`));
    assert.match(page.html, /Only the guest you invite reads what you write/);
    const home = await first.post('/ui/guest');
    assert.equal(home.status, 200);
    assert.match(home.html, /You are a guest\. This account and everything in it is deleted in [45] h/);
    assert.match(home.html, /Try it with a friend/);
    const a = guestOf(relay)!;
    const user = relay.klatsch.user(a);
    assert.match(user.handle, /^guest-[a-z0-9]{6}$/);
    assert.match(user.display_name, /^Guest [A-Z0-9]{3}$/);
    assert.deepEqual(relay.klatsch.askablePeople(a), [], 'no demo friend, nobody yet');
    const made = await first.post('/ui/friends/invite');
    const link = made.html.match(/<code class="cmd">([^<]+)<\/code>/)![1]!;
    // The friend opens it signed out: one button, no sign-in choices (accounts cannot join a guest's link).
    const friend = signedOutBrowser(relay);
    const invited = await friend.go(link);
    assert.match(invited.html, new RegExp(`${user.display_name} invited you to try Klatsch together`));
    assert.doesNotMatch(invited.html, /Sign in with|href="\/ui\/guest"/);
    const joined = await friend.post('/ui/guest', { invite: inviteToken(link) });
    assert.equal(joined.status, 200);
    assert.match(joined.url, new RegExp(`/ui/chat/${user.handle}$`));
    const b = guestOf(relay)!;
    assert.notEqual(a, b);
    assert.deepEqual(relay.klatsch.askablePeople(b), [{ handle: `@${user.handle}`, friend: true }]);
    await friend.post(`/ui/chat/${user.handle}`, { text: 'Hi! It works.' });
    assert.equal(relay.klatsch.conversation(a, `@${relay.klatsch.user(b).handle}`).messages.at(-1)!.text, 'Hi! It works.');
    // The link is used: a second visitor gets nothing, and no guest is left behind for it.
    const late = signedOutBrowser(relay);
    await late.go('/ui/guest');
    const before = (relay.db.prepare('SELECT count(*) AS n FROM users WHERE guest_expires_at IS NOT NULL').get() as { n: number }).n;
    assert.equal((await late.post('/ui/guest', { invite: inviteToken(link) })).status, 410);
    assert.equal((relay.db.prepare('SELECT count(*) AS n FROM users WHERE guest_expires_at IS NOT NULL').get() as { n: number }).n, before);
    // No file fields anywhere a guest writes, and Settings is only the way out.
    assert.doesNotMatch((await first.go('/ui')).html, /type="file"/);
    assert.doesNotMatch((await first.go(`/ui/chat/${relay.klatsch.user(b).handle}`)).html, /type="file"/);
    const settings = await first.go('/ui/settings');
    assert.match(settings.html, /End guest session/);
    assert.doesNotMatch(settings.html, /action="\/ui\/(email|auth\/github\/connect|auth\/google\/connect|settings\/delete)"/);
  });

  it('guests and accounts never meet: no links either way, no circles, no sign-ins, no files', async () => {
    const { a, b, aHandle } = guestPair(relay);
    const visitor = await browser(relay, relay.loginLink(a));
    for (const path of ['/ui/email', '/ui/passkeys/options', '/ui/auth/github/connect', '/ui/auth/google/connect', '/ui/settings/delete'])
      assert.equal((await visitor.post(path, { email: 'g@example.org' })).status, 403, path);
    for (const path of ['/ui/notes', '/ui/settings/delete']) assert.equal((await visitor.get(path)).status, 403, path);
    // A guest cannot use an account's link…
    const aliceLink = createInvite(relay.db, relay.secret, relay.klatsch.friendCircle(alice), alice, relay.base);
    assert.throws(() => relay.klatsch.acceptInvite(a, findInvite(relay.db, relay.secret, inviteToken(aliceLink.link))!), /only be friends with another guest/);
    assert.equal((await visitor.get(new URL(aliceLink.link).pathname)).status, 403);
    // …nor an account a guest's link, on the page or by the service.
    const guestLink = createInvite(relay.db, relay.secret, relay.klatsch.friendCircle(a), a, relay.base);
    assert.throws(() => relay.klatsch.acceptInvite(alice, findInvite(relay.db, relay.secret, inviteToken(guestLink.link))!), /This link is from a guest/);
    const aliceBrowser = await browser(relay, relay.loginLink(alice));
    assert.equal((await aliceBrowser.get(new URL(guestLink.link).pathname)).status, 403);
    // An account's link signed out offers no guest way in.
    assert.doesNotMatch((await signedOutBrowser(relay).go(aliceLink.link)).html, /href="\/ui\/guest"|Join as a guest/);
    // No other membership, either way round.
    const pairCircle = relay.klatsch.friendshipOf(a, b)!;
    assert.throws(() => relay.klatsch.addMember(relay.klatsch.ensureCircle('home', alice), a, alice), /only be friends with another guest/);
    assert.throws(() => relay.klatsch.addMember(pairCircle, alice), /This link is from a guest/);
    assert.throws(() => relay.klatsch.ensureCircle('mine', a), /only be friends with another guest/);
    assert.throws(() => relay.klatsch.joinPublic(a, 'anything'), /only be friends with another guest/);
    assert.throws(() => relay.klatsch.setVerifiedEmail(a, 'g@example.org', 'web'), /cannot add a sign-in/);
    assert.throws(() => relay.klatsch.linkGitHub(a, { id: 99, login: 'someone' }), /cannot add a sign-in/);
    // Agents cannot cross either.
    const guestAgent = await agent(relay, relay.agentToken(a), { dialogs: false });
    assert.equal((await guestAgent.call('ask_person', { handle: '@alice', question: 'Hello?' })).isError, true);
    assert.equal((await guestAgent.call('send_message', { handle: '@alice', text: 'Hello?' })).isError, true);
    await guestAgent.close();
    const aliceAgent = await agent(relay, relay.agentToken(alice), { dialogs: false });
    assert.equal((await aliceAgent.call('ask_person', { handle: aHandle, question: 'Hello?' })).isError, true);
    assert.equal((await aliceAgent.call('send_message', { handle: aHandle, text: 'Hello?' })).isError, true);
    await aliceAgent.close();
    // No files, with a message.
    const messageId = relay.klatsch.sendMessage(b, aHandle, 'Hi!');
    assert.throws(() => relay.klatsch.attachToMessage(b, messageId, { name: 'a.png', bytes: new Uint8Array(8) }), /Files need an account/);
    // At most 3 friend links (a made 2 so far).
    relay.klatsch.friendCircle(a);
    assert.throws(() => relay.klatsch.friendCircle(a), /at most 3 friend links/);
    // Nobody else can pick a guest-looking handle.
    assert.equal(reservedHandle('guest-abc123'), true);
    assert.equal(reservedHandle('guesthouse'), false);
  });

  it('a guest sends at most 30 messages and asks at most 5 questions; its cards offer no file picker', async () => {
    const { a, b, bHandle } = guestPair(relay);
    for (let i = 0; i < 30; i++) relay.klatsch.sendMessage(a, bHandle, `Message ${i}`);
    assert.throws(() => relay.klatsch.sendMessage(a, bHandle, 'One more'), /at most 30 messages/);
    const chat = await agent(relay, relay.chatAppToken(a), { dialogs: false, cards: true });
    const shown = await chat.call('conversation', { handle: bHandle });
    assert.equal(shown.meta['dev.klatsch/card'].chat.files, false);
    for (let i = 0; i < 5; i++) {
      const asked = await chat.call('ask_person', { handle: bHandle, question: `Which one, ${i}?` });
      assert.equal(asked.isError, false);
      assert.equal(asked.meta['dev.klatsch/card'].pick, false);
      await chat.call('klatsch_card', { key: asked.meta['dev.klatsch/card'].key, decision: 'approved' });
    }
    assert.equal((await chat.call('ask_person', { handle: bHandle, question: 'And one more?' })).isError, true);
    await chat.close();
    assert.ok(relay.klatsch.asksOf(b).some((k) => k.role === 'helper' && k.state === 'open'));
  });

  it('"End guest session" deletes the guest and its circle for two: the other guest loses that friend at once', async () => {
    const { a, b } = guestPair(relay);
    const circle = relay.klatsch.friendshipOf(a, b)!;
    relay.klatsch.sendMessage(b, `@${relay.klatsch.user(a).handle}`, 'See you!');
    const visitor = await browser(relay, relay.loginLink(a));
    const ended = await visitor.post('/ui/guest/end');
    assert.match(ended.html, /Guest session ended/);
    assert.equal(relay.db.prepare('SELECT 1 FROM users WHERE id = ?').get(a), undefined);
    assert.equal(relay.db.prepare('SELECT 1 FROM circles WHERE id = ?').get(circle), undefined);
    assert.equal((relay.db.prepare('SELECT count(*) AS n FROM messages WHERE circle_id = ?').get(circle) as { n: number }).n, 0);
    assert.deepEqual(relay.klatsch.askablePeople(b), []);
    assert.equal((await visitor.get('/ui')).status, 401, 'the session went with it');
    const real = await browser(relay, relay.loginLink(alice));
    assert.equal((await real.post('/ui/guest/end')).status, 404);
  });

  it('a chat app connects as a guest from its sign-in page; its token works, and goes when the hours are up', async () => {
    // Its own relay: the guests made above used up this network's three for the hour.
    const relay = await startRelay({ guest: true });
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
    assert.deepEqual((await chat.call('friends')).data.people, []);
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
    await relay.close();
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
  it('memberships are written in exactly three places, each of which applies the guest rule', () => {
    const source = readFileSync(new URL('../../src/service.ts', import.meta.url), 'utf8');
    // ensureCircle refuses guests; friendCircle makes a guest the only member of a new pair; addMember applies
    // refuseGuest with the circle. A new place that adds memberships must apply the rule too, and be counted here.
    assert.equal(source.match(/INSERT (OR IGNORE )?INTO memberships/g)?.length, 3);
    const body = (name: string) => source.slice(source.indexOf(`  ${name}(`), source.indexOf(`  ${name}(`) + 700);
    assert.match(body('addMember'), /this\.refuseGuest\(userId, circleId\)/);
    assert.match(body('acceptInvite'), /this\.refuseGuest\(userId, invite\.circleId\)/);
    for (const name of ['ensureCircle', 'joinPublic']) assert.match(body(name), /this\.isGuest\(\w+\)\) throw/, name);
    assert.match(body('friendCircle'), /this\.isGuest\(userId\)/);
  });
});
