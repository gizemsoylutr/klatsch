// Notifications on a phone or browser (Web Push): Settings offers them with the relay's key, a browser's
// subscription is checked and kept per device, and one click turns them off everywhere. What a home screen and
// the service worker need is served without a session.
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { vapidFromSecret } from '../../src/notify/push.ts';
import { browser, startRelay, type Browser, type Relay } from './harness.ts';

const subscription = () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${Math.random().toString(36).slice(2)}`, p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') };
};

describe('push notifications: offered in Settings, one subscription per device, off in one click', () => {
  let relay: Relay;
  let alice = '';
  let aliceBrowser: Browser;

  before(async () => {
    relay = await startRelay();
    alice = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('home', alice);
    aliceBrowser = await browser(relay, relay.loginLink(alice));
  });
  after(async () => relay.close());

  it('the service worker, the page script, the manifest and the icon need no session', async () => {
    for (const [path, type] of [
      ['/ui/sw.js', 'text/javascript'],
      ['/ui/push.js', 'text/javascript'],
      ['/ui/manifest.webmanifest', 'application/manifest+json'],
      ['/ui/icon.svg', 'image/svg+xml'],
    ] as const) {
      const response = await fetch(`${relay.base}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type') ?? '', new RegExp(type.replace('+', '\\+')));
    }
    const manifest = (await (await fetch(`${relay.base}/ui/manifest.webmanifest`)).json()) as { start_url: string };
    assert.equal(manifest.start_url, '/ui');
    const worker = await (await fetch(`${relay.base}/ui/sw.js`)).text();
    assert.ok(!worker.includes('fetch('), 'the worker never fetches');
  });

  it('Settings offers it with the relay’s public key and its same-origin script', async () => {
    const page = await aliceBrowser.get('/ui/settings');
    assert.ok(page.html.includes(`data-key="${vapidFromSecret(relay.secret).publicKey}"`));
    assert.match(page.html, /Off on every device\./);
    assert.match(page.html, /<script src="\/ui\/push\.js" defer><\/script>/);
  });

  it('a browser’s subscription is kept; anything not from a push service, or with wrong keys, is refused', async () => {
    const good = subscription();
    assert.equal((await aliceBrowser.post('/ui/push/subscribe', good)).status, 200);
    assert.equal((await aliceBrowser.post('/ui/push/subscribe', good)).status, 200, 'the same device again');
    assert.equal(relay.klatsch.pushSubscriptionsOf(alice).length, 1);
    assert.equal((await aliceBrowser.post('/ui/push/subscribe', { ...subscription(), endpoint: 'https://evil.example/push' })).status, 400);
    assert.equal((await aliceBrowser.post('/ui/push/subscribe', { ...subscription(), auth: 'short' })).status, 400);
    assert.equal((await aliceBrowser.post('/ui/push/subscribe', { ...subscription(), p256dh: Buffer.alloc(65, 1).toString('base64url') })).status, 400);
    assert.match((await aliceBrowser.get('/ui/settings')).html, /On for 1 device\./);
    // Another person cannot take over this device's subscription by posting its endpoint.
    const bob = relay.klatsch.ensureUser('bob', 'Bob');
    relay.klatsch.ensureCircle('bobs', bob);
    const bobBrowser = await browser(relay, relay.loginLink(bob));
    assert.equal((await bobBrowser.post('/ui/push/subscribe', good)).status, 400);
    assert.equal(relay.klatsch.pushSubscriptionsOf(alice).length, 1);
    // Without the page's form token, nothing is saved.
    const forged = await fetch(`${relay.base}/ui/push/subscribe`, { method: 'POST', body: new URLSearchParams(subscription()), headers: { Origin: 'https://evil.example' } });
    assert.ok(forged.status >= 400);
  });

  it('at most ten devices; "Turn off everywhere" forgets them all', async () => {
    for (let i = 0; i < 12; i++) await aliceBrowser.post('/ui/push/subscribe', subscription());
    assert.equal(relay.klatsch.pushSubscriptionsOf(alice).length, 10);
    assert.ok((await aliceBrowser.post('/ui/push/off')).status < 400);
    assert.equal(relay.klatsch.pushSubscriptionsOf(alice).length, 0);
  });
});
