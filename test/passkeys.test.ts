import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLoginLink } from '../src/auth/web-sessions.ts';
import { BASE, setup } from './helpers.ts';
import { SoftPasskey } from './webauthn.ts';

const LOCAL = 'http://localhost:7417';
const SCRIPT_CSP = "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src data:; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

type T = ReturnType<typeof setup>;

/** A browser with a cookie jar at `base`, posting the way the passkey script does (form fields, `data` as JSON). */
function browser(t: T, base = LOCAL) {
  const jar = new Map<string, string>();
  let csrf = '';
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set('Cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await t.app.request(path.startsWith('http') ? path : `${base}${path}`, { ...init, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = cookie.split(';');
      const [name = '', value = ''] = pair.split('=');
      if (!value || attributes.some((a) => /^\s*max-age=0$/i.test(a))) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await response.text();
    csrf = text.match(/data-csrf="([^"]+)"/)?.[1] ?? text.match(/name="csrf" value="([^"]+)"/)?.[1] ?? csrf;
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, text, json, csp: response.headers.get('content-security-policy'), location: response.headers.get('location') };
  };
  const post = (path: string, data?: unknown, origin = base, token = csrf) =>
    request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
      body: new URLSearchParams({ csrf: token, ...(data === undefined ? {} : { data: JSON.stringify(data) }) }).toString(),
    });
  const signInAs = async (userId: string) => request(createLoginLink(t.db, t.secret, userId, base));
  return { request, post, signInAs, jar, csrf: () => csrf };
}

/** Alice adds a passkey on Settings: options, the authenticator's answer, stored. */
async function addPasskey(t: T, passkey = new SoftPasskey()) {
  const b = browser(t);
  await b.signInAs(t.alice);
  await b.request('/ui/settings');
  const options = await b.post('/ui/passkeys/options');
  assert.equal(options.status, 200, options.text);
  const added = await b.post('/ui/passkeys', { key: options.json.key, credential: passkey.register(options.json.options, LOCAL) });
  assert.equal(added.status, 200, added.text);
  return { b, passkey };
}

/** A signed-out browser signs in with `passkey`; `tamper` changes the answer before it goes. */
async function signIn(t: T, passkey: SoftPasskey, tamper: (answer: any, options: any) => any = (a) => a) {
  const b = browser(t);
  await b.request('/ui');
  const options = await b.post('/ui/auth/passkey/options');
  assert.equal(options.status, 200, options.text);
  const answer = tamper(passkey.assert(options.json.options, LOCAL), options.json.options);
  return { b, options, result: await b.post('/ui/auth/passkey', { key: options.json.key, credential: answer }) };
}

describe('passkeys', () => {
  it('are offered only on localhost or the https public URL, with the script allowed only on those pages', async () => {
    const t = setup();
    const local = browser(t);
    const page = await local.request('/ui');
    assert.equal(page.status, 401);
    assert.match(page.text, /data-passkey="signin"/);
    assert.match(page.text, /<div class="passkey" data-passkey-box hidden>/, 'hidden until the script finds passkeys work');
    assert.match(page.text, /<script src="\/ui\/passkey\.js" defer><\/script>/);
    assert.doesNotMatch(page.text, /<script>|onclick=/, 'no inline script');
    assert.equal(page.csp, SCRIPT_CSP);
    const ip = await browser(t, BASE).request('/ui');
    assert.doesNotMatch(ip.text, /data-passkey|passkey\.js/, 'not at 127.0.0.1: an IP address cannot be a relying party');
    assert.equal(ip.csp, PAGE_CSP);
    assert.equal((await browser(t, BASE).post('/ui/auth/passkey/options')).status, 404);
    const landing = await t.app.request(`${LOCAL}/`, { headers: { Accept: 'text/html' } });
    assert.equal(landing.headers.get('content-security-policy'), PAGE_CSP);
    const script = await t.app.request(`${LOCAL}/ui/passkey.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.equal(script.headers.get('x-content-type-options'), 'nosniff');
    const source = await script.text();
    assert.doesNotMatch(source, /innerHTML|eval\(|new Function|document\.write/);

    const hosted = setup({ config: { host: '0.0.0.0', publicUrl: 'https://klatsch.example' } });
    assert.match(await (await hosted.app.request('https://klatsch.example/ui')).text(), /data-passkey="signin"/);
    const plain = setup({ config: { host: '0.0.0.0', publicUrl: 'http://klatsch.example' } });
    assert.doesNotMatch(await (await plain.app.request('http://klatsch.example/ui')).text(), /data-passkey/, 'not over plain http');
  });

  it('Alice adds a passkey on Settings, is told, and signs in with it from a new browser', async () => {
    const t = setup();
    const { b, passkey } = await addPasskey(t, new SoftPasskey({ synced: true }));
    const settings = await b.request('/ui/settings');
    assert.equal(settings.csp, SCRIPT_CSP);
    assert.match(settings.text, /Sign in with Face ID, Touch ID or your phone\. Klatsch stores only a public key\./);
    assert.match(settings.text, /Synced passkey/);
    assert.match(settings.text, /not used yet/);
    assert.ok(t.notifications.some((n) => /A passkey can now sign in to your Klatsch account/.test(n)));
    const row = t.db.prepare('SELECT user_id, counter, transports, synced FROM passkeys').get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { user_id: t.alice, counter: 0, transports: '["internal"]', synced: 1 });

    const { b: phone, result } = await signIn(t, passkey);
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(result.json, { next: '/ui' });
    assert.ok(phone.jar.has('klatsch_session'));
    assert.ok(phone.jar.has('klatsch_known'), 'a passkey sign-in counts as a known browser');
    assert.equal((await phone.request('/ui')).status, 200);
    assert.match((await phone.request('/ui/settings')).text, /last used \d{4}-\d{2}-\d{2}/);
    assert.equal((t.db.prepare('SELECT counter FROM passkeys').get() as { counter: number }).counter, 1);
    assert.ok(t.db.prepare(`SELECT 1 FROM audit WHERE action = 'passkey.signin' AND user_id = ?`).get(t.alice));
  });

  it('refuses posts without the form token or from another origin', async () => {
    const t = setup();
    const b = browser(t);
    await b.request('/ui');
    assert.equal((await b.post('/ui/auth/passkey/options', undefined, 'https://evil.example')).status, 403);
    assert.equal((await b.post('/ui/auth/passkey/options', undefined, LOCAL, 'wrong')).status, 403);
    await b.signInAs(t.alice);
    await b.request('/ui/settings');
    assert.equal((await b.post('/ui/passkeys/options', undefined, 'https://evil.example')).status, 403);
    assert.equal((await b.post('/ui/passkeys/options', undefined, LOCAL, 'wrong')).status, 403);
  });

  it('uses a challenge once, only for the browser or session that asked', async () => {
    const t = setup();
    const { passkey } = await addPasskey(t);
    const { b, options } = await signIn(t, passkey);
    const again = await b.post('/ui/auth/passkey', { key: options.json.key, credential: passkey.assert(options.json.options, LOCAL) });
    assert.equal(again.status, 400, 'a replayed challenge is refused');
    assert.deepEqual(again.json, { error: 'That passkey did not work here. Try again, or sign in another way.' });

    // A challenge handed to one browser does not work from another.
    const asker = browser(t);
    await asker.request('/ui');
    const theirs = await asker.post('/ui/auth/passkey/options');
    const other = browser(t);
    await other.request('/ui');
    const stolen = await other.post('/ui/auth/passkey', { key: theirs.json.key, credential: passkey.assert(theirs.json.options, LOCAL) });
    assert.equal(stolen.status, 400);

    // Registration: a challenge for Alice's session does not register for Bob's.
    const alice = browser(t);
    await alice.signInAs(t.alice);
    await alice.request('/ui/settings');
    const forAlice = await alice.post('/ui/passkeys/options');
    const bob = browser(t);
    await bob.signInAs(t.bob);
    await bob.request('/ui/settings');
    const added = await bob.post('/ui/passkeys', { key: forAlice.json.key, credential: new SoftPasskey().register(forAlice.json.options, LOCAL) });
    assert.equal(added.status, 400);
    assert.equal((t.db.prepare('SELECT count(*) n FROM passkeys WHERE user_id = ?').get(t.bob) as { n: number }).n, 0);
  });

  it('refuses a wrong origin, a wrong relying party, no user verification, an unknown passkey and someone else\'s handle', async () => {
    const t = setup();
    const { passkey } = await addPasskey(t);
    const wrongOrigin = await signIn(t, passkey, (_, options) => passkey.assert(options, 'https://evil.example', { rpID: 'localhost' }));
    assert.equal(wrongOrigin.result.status, 400);
    const wrongRp = await signIn(t, passkey, (_, options) => passkey.assert(options, LOCAL, { rpID: 'evil.example' }));
    assert.equal(wrongRp.result.status, 400);
    const unknown = await signIn(t, new SoftPasskey());
    assert.equal(unknown.result.status, 400);
    assert.deepEqual(unknown.result.json, wrongOrigin.result.json, 'the same answer for an unknown passkey');
    const handle = await signIn(t, passkey, (answer) => ({ ...answer, response: { ...answer.response, userHandle: Buffer.from(t.bob).toString('base64url') } }));
    assert.equal(handle.result.status, 400);
    (passkey.options as { verified?: boolean }).verified = false;
    assert.equal((await signIn(t, passkey)).result.status, 400, 'a sign-in without user verification is refused');
    (passkey.options as { verified?: boolean }).verified = true;
    const unverified = new SoftPasskey({ verified: false });
    const b = browser(t);
    await b.signInAs(t.alice);
    await b.request('/ui/settings');
    const options = await b.post('/ui/passkeys/options');
    assert.equal((await b.post('/ui/passkeys', { key: options.json.key, credential: unverified.register(options.json.options, LOCAL) })).status, 400, 'no user verification, no passkey');
    assert.equal((await b.post('/ui/passkeys', { key: 'x', credential: 'not json' })).status, 400);
    assert.equal(
      (await b.request('/ui/passkeys', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: LOCAL }, body: `csrf=${b.csrf()}&data=%7Bnot` })).status,
      400,
    );
  });

  it('refuses a counter that went backwards', async () => {
    const t = setup();
    const { passkey } = await addPasskey(t);
    assert.equal((await signIn(t, passkey, (_, options) => passkey.assert(options, LOCAL, { counter: 5 }))).result.status, 200);
    assert.equal((await signIn(t, passkey, (_, options) => passkey.assert(options, LOCAL, { counter: 3 }))).result.status, 400, 'a cloned passkey');
    assert.equal((t.db.prepare('SELECT counter FROM passkeys').get() as { counter: number }).counter, 5);
  });

  it('removes only the person\'s own passkey, and caps how many one person has', async () => {
    const t = setup();
    const { b } = await addPasskey(t);
    const id = (t.db.prepare('SELECT id FROM passkeys').get() as { id: string }).id;
    const bob = browser(t);
    await bob.signInAs(t.bob);
    await bob.request('/ui/settings');
    assert.notEqual((await bob.post(`/ui/passkeys/${id}/delete`)).status, 303);
    assert.ok(t.db.prepare('SELECT 1 FROM passkeys WHERE id = ?').get(id), 'Bob cannot remove Alice\'s passkey');
    await b.request('/ui/settings');
    assert.equal((await b.post(`/ui/passkeys/${id}/delete`)).status, 303);
    assert.equal(t.db.prepare('SELECT 1 FROM passkeys WHERE id = ?').get(id), undefined);
    assert.ok(t.notifications.some((n) => /A passkey was removed/.test(n)));

    for (let i = 0; i < 10; i++) await addPasskey(t);
    const extra = browser(t);
    await extra.signInAs(t.alice);
    await extra.request('/ui/settings');
    const options = await extra.post('/ui/passkeys/options');
    const over = await extra.post('/ui/passkeys', { key: options.json.key, credential: new SoftPasskey().register(options.json.options, LOCAL) });
    assert.equal(over.status, 409);
    assert.match(over.json.error, /You have 10 passkeys; remove one first\./);
  });

  it('limits passkey sign-in tries per address', async () => {
    const t = setup();
    const b = browser(t);
    await b.request('/ui');
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await b.post('/ui/auth/passkey/options')).status);
    assert.equal(statuses.filter((s) => s === 200).length, 30);
    assert.equal(statuses.at(-1), 429);
  });
});

describe('the passkey offer on Home', () => {
  it('shows once where passkeys work, with the script, to someone without a passkey, until they say Not now', async () => {
    const t = setup();
    // The notifications offer would bring its own script: put it away, to see the passkey offer's policy alone.
    t.klatsch.dismissPushOffer(t.alice);
    const b = browser(t);
    await b.signInAs(t.alice);
    const home = await b.request('/ui');
    assert.equal(home.status, 200);
    assert.match(home.text, /<section class="offer" data-passkey-box data-passkey-offer/);
    assert.match(home.text, /Sign in faster next time/);
    assert.match(home.text, /data-passkey="add" data-back="home"/);
    assert.match(home.text, /data-passkey-offer data-passkey-auto="1" hidden/, 'the first Home after signing in opens the dialog by itself');
    const again = await b.request('/ui');
    assert.match(again.text, /<section class="offer" data-passkey-box data-passkey-offer hidden/, 'later loads show the card only');
    assert.doesNotMatch(again.text, /data-passkey-auto/);
    await b.signInAs(t.alice);
    assert.match((await b.request('/ui')).text, /data-passkey-auto="1"/, 'a new sign-in offers it by itself once more');
    assert.match(home.text, /<script src="\/ui\/passkey\.js" defer><\/script>/);
    assert.equal(home.csp, SCRIPT_CSP);
    assert.equal((await b.post('/ui/passkeys/offer/dismiss', undefined, 'https://evil.example')).status, 403, 'another origin is refused');
    const dismissed = await b.post('/ui/passkeys/offer/dismiss');
    assert.equal(dismissed.status, 303);
    assert.equal(dismissed.location, '/ui');
    const after = await b.request('/ui');
    assert.doesNotMatch(after.text, /data-passkey-offer|passkey\.js/);
    assert.equal(after.csp, PAGE_CSP, 'Home without the offer keeps the plain policy');
    assert.equal(t.db.prepare(`SELECT count(*) n FROM audit WHERE action = 'passkey.offer.dismiss'`).get()!.n, 1);
    assert.match((await b.request('/ui/settings')).text, /data-passkey="add"/, 'Settings still offers it');
  });

  it('is not offered at 127.0.0.1, where passkeys cannot work', async () => {
    const t = setup();
    t.klatsch.dismissPushOffer(t.alice);
    const b = browser(t, BASE);
    await b.signInAs(t.alice);
    const home = await b.request('/ui');
    assert.doesNotMatch(home.text, /data-passkey-offer/);
    assert.equal(home.csp, PAGE_CSP);
  });

  it('goes away once there is a passkey, and a passkey saved from it leads back to Home', async () => {
    const t = setup();
    const b = browser(t);
    await b.signInAs(t.alice);
    await b.request('/ui');
    const options = await b.post('/ui/passkeys/options');
    const added = await b.post('/ui/passkeys', { key: options.json.key, back: 'home', credential: new SoftPasskey().register(options.json.options, LOCAL) });
    assert.equal(added.status, 200, added.text);
    assert.deepEqual(added.json, { next: '/ui' });
    assert.doesNotMatch((await b.request('/ui')).text, /data-passkey-offer/);
    const other = await addPasskey(t);
    assert.ok(other);
  });

  it('sends a passkey saved elsewhere to Settings, whatever else the page asks for', async () => {
    const t = setup();
    const b = browser(t);
    await b.signInAs(t.alice);
    await b.request('/ui/settings');
    const options = await b.post('/ui/passkeys/options');
    const added = await b.post('/ui/passkeys', { key: options.json.key, back: 'https://evil.example/', credential: new SoftPasskey().register(options.json.options, LOCAL) });
    assert.deepEqual(added.json, { next: '/ui/settings#passkeys' });
  });
});
