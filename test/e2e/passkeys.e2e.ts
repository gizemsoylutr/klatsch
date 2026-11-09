// Passkeys over real HTTP: Alice adds one on Settings, signs in with it from another browser, and removes it.
// The relay is opened as `localhost` (a relying party cannot be an IP address); the authenticator is test/webauthn.ts.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createLoginLink } from '../../src/auth/web-sessions.ts';
import { SoftPasskey } from '../webauthn.ts';
import { startRelay, type Relay } from './harness.ts';

/** A browser at `base` that keeps cookies and posts the way the passkey script does. */
function client(base: string) {
  const jar = new Map<string, string>();
  let csrf = '';
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set('Cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await fetch(new URL(path, base), { ...init, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';');
      const [name = '', value = ''] = pair.split('=');
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    const text = await response.text();
    csrf = text.match(/data-csrf="([^"]+)"/)?.[1] ?? text.match(/name="csrf" value="([^"]+)"/)?.[1] ?? csrf;
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, text, json, headers: response.headers };
  };
  const get = (path: string) => send(path);
  const post = (path: string, data?: unknown) =>
    send(path, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, ...(data === undefined ? {} : { data: JSON.stringify(data) }) }).toString(),
    });
  return { get, post, jar };
}

describe('passkeys: add on Settings, sign in from another browser, remove', () => {
  let relay: Relay;
  let base = '';
  let alice = '';
  const passkey = new SoftPasskey({ synced: true });
  let passkeyId = '';

  before(async () => {
    relay = await startRelay();
    base = relay.base.replace('127.0.0.1', 'localhost');
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('demo', alice);
  });
  after(async () => {
    await relay.close();
  });

  it('serves the passkey script same-origin, as JavaScript', async () => {
    const script = await fetch(`${base}/ui/passkey.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.match(await script.text(), /navigator\.credentials\.create/);
  });

  it('Home offers a passkey after sign-in, opening the dialog by itself once, and "Not now" puts it away', async () => {
    const laptop = client(base);
    await laptop.get(createLoginLink(relay.db, relay.secret, alice, base));
    const first = await laptop.get('/ui');
    assert.match(first.text, /data-passkey-offer data-passkey-auto="1"/);
    const second = await laptop.get('/ui');
    assert.match(second.text, /data-passkey-offer hidden/);
    assert.equal((await laptop.post('/ui/passkeys/offer/dismiss')).status, 303);
    assert.doesNotMatch((await laptop.get('/ui')).text, /data-passkey-offer/);
    relay.db.prepare('UPDATE users SET passkey_offer_dismissed_at = NULL').run();
  });

  it('Alice adds a passkey on Settings', async () => {
    const laptop = client(base);
    await laptop.get(createLoginLink(relay.db, relay.secret, alice, base));
    const settings = await laptop.get('/ui/settings');
    assert.match(settings.text, /data-passkey="add"/);
    const options = await laptop.post('/ui/passkeys/options');
    assert.equal(options.status, 200);
    assert.equal(options.json.options.rp.id, 'localhost');
    assert.equal(options.json.options.authenticatorSelection.userVerification, 'required');
    const added = await laptop.post('/ui/passkeys', { key: options.json.key, credential: passkey.register(options.json.options, base) });
    assert.deepEqual(added.json, { next: '/ui/settings#passkeys' });
    assert.ok(relay.notifications.some((n) => /^@alice: A passkey can now sign in/.test(n)));
    passkeyId = (relay.db.prepare('SELECT id FROM passkeys').get() as { id: string }).id;
  });

  it('a new browser signs in as Alice with it', async () => {
    const phone = client(base);
    assert.equal((await phone.get('/ui')).status, 401);
    const options = await phone.post('/ui/auth/passkey/options');
    assert.equal(options.status, 200);
    assert.deepEqual(options.json.options.allowCredentials ?? [], [], 'discoverable: the browser picks the passkey');
    const signedIn = await phone.post('/ui/auth/passkey', { key: options.json.key, credential: passkey.assert(options.json.options, base) });
    assert.deepEqual(signedIn.json, { next: '/ui' });
    const again = await phone.post('/ui/auth/passkey', { key: options.json.key, credential: passkey.assert(options.json.options, base) });
    assert.equal(again.status, 400, 'the challenge works once');
    assert.equal((await phone.get('/ui')).status, 200);
  });

  it('Alice removes it, and it no longer signs in', async () => {
    const laptop = client(base);
    await laptop.get(createLoginLink(relay.db, relay.secret, alice, base));
    await laptop.get('/ui/settings');
    assert.equal((await laptop.post(`/ui/passkeys/${passkeyId}/delete`)).status, 303);
    const phone = client(base);
    await phone.get('/ui');
    const options = await phone.post('/ui/auth/passkey/options');
    assert.equal((await phone.post('/ui/auth/passkey', { key: options.json.key, credential: passkey.assert(options.json.options, base) })).status, 400);
  });
});
