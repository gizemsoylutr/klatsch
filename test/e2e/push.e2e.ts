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

  it('Home offers notifications once, until a device has them or the person says Not now', async () => {
    assert.match((await aliceBrowser.get('/ui')).html, /Know when a friend asks you/);
    assert.ok((await aliceBrowser.post('/ui/push/offer/dismiss')).status < 400);
    assert.ok(!(await aliceBrowser.get('/ui')).html.includes('Know when a friend asks you'));
    // The friend link page says it too.
    assert.match((await aliceBrowser.post('/ui/friends/invite')).html, /Chat apps cannot tell you when your friend asks or answers\./);
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

  it('"Turn off here" forgets this device only, and only for its own person', async () => {
    const mine = subscription();
    await aliceBrowser.post('/ui/push/subscribe', mine);
    const before = relay.klatsch.pushSubscriptionsOf(alice).length;
    const bob = relay.klatsch.ensureUser('bob', 'Bob');
    const bobBrowser = await browser(relay, relay.loginLink(bob));
    await bobBrowser.post('/ui/push/unsubscribe', { endpoint: mine.endpoint });
    assert.equal(relay.klatsch.pushSubscriptionsOf(alice).length, before, 'not by someone else');
    assert.equal((await aliceBrowser.post('/ui/push/unsubscribe', { endpoint: mine.endpoint })).status, 200);
    assert.equal(relay.klatsch.pushSubscriptionsOf(alice).length, before - 1);
    assert.match((await aliceBrowser.get('/ui/settings')).html, /data-push-off hidden>Turn off here</);
  });

  it('at most ten devices; "Turn off everywhere" forgets them all', async () => {
    for (let i = 0; i < 12; i++) await aliceBrowser.post('/ui/push/subscribe', subscription());
    assert.equal(relay.klatsch.pushSubscriptionsOf(alice).length, 10);
    assert.ok((await aliceBrowser.post('/ui/push/off')).status < 400);
    assert.equal(relay.klatsch.pushSubscriptionsOf(alice).length, 0);
  });

  it('"Send a test notification" reaches every device of hers, says how it went, and cannot be spammed', async () => {
    assert.match((await aliceBrowser.post('/ui/push/test')).html, /No device gets notifications yet/);
    await aliceBrowser.post('/ui/push/subscribe', subscription());
    await aliceBrowser.post('/ui/push/subscribe', subscription());
    assert.match((await aliceBrowser.get('/ui/settings')).html, /action="\/ui\/push\/test"/);
    const seen: number[] = [];
    relay.klatsch.pushTest = async (subs) => {
      seen.push(subs.length);
      return ['sent', 'gone'];
    };
    const tested = await aliceBrowser.post('/ui/push/test');
    assert.equal(tested.status, 200);
    assert.deepEqual(seen, [2]);
    assert.match(tested.html, /Sent to 1 device; 1 no longer exist/);
    assert.match(tested.html, /Focus or Do Not Disturb/);
    assert.equal((await aliceBrowser.post('/ui/push/test')).status, 429, 'not twice in half a minute');
    assert.deepEqual(seen, [2]);
  });

  it('the service worker alerts again for every new notification', async () => {
    const sw = await (await fetch(`${relay.base}/ui/sw.js`)).text();
    assert.match(sw, /renotify: true/);
  });

  it('Home re-sends a device’s subscription on each visit; one turned off elsewhere is told "off" and stays off', async () => {
    const mine = subscription();
    await aliceBrowser.post('/ui/push/subscribe', mine);
    const home = (await aliceBrowser.get('/ui')).html;
    assert.match(home, /data-push-sync data-key="[\w-]+"/);
    assert.match(home, /<script src="\/ui\/push\.js" defer><\/script>/);
    relay.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(mine.endpoint);
    const back = await aliceBrowser.post('/ui/push/sync', mine);
    assert.equal(back.html, 'on', 'a device the relay lost comes back');
    assert.ok(relay.klatsch.pushSubscriptionsOf(alice).some((s) => s.endpoint === mine.endpoint));
    await aliceBrowser.post('/ui/push/off');
    assert.equal((await aliceBrowser.post('/ui/push/sync', mine)).html, 'off');
    assert.equal(relay.klatsch.pushSubscriptionsOf(alice).length, 0, 'turning off everywhere holds');
    assert.equal((await aliceBrowser.post('/ui/push/subscribe', mine)).status, 200, 'turning it on here again works');
    assert.equal((await aliceBrowser.post('/ui/push/sync', mine)).html, 'on');
  });

  it('the service worker takes over at once and a tap brings an open Klatsch tab to the front', async () => {
    const sw = await (await fetch(`${relay.base}/ui/sw.js`)).text();
    assert.match(sw, /skipWaiting\(\)/);
    assert.match(sw, /clients\.claim\(\)/);
    assert.match(sw, /\.focus\(\)/);
  });
});
