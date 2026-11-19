/**
 * Phone and desktop notifications through Web Push. Three small same-origin files:
 * - `/ui/push.js`, on Settings only: asks the browser for permission, subscribes with the relay's VAPID key and
 *   posts the subscription back. It writes no HTML and goes only to paths on this relay.
 * - `/ui/sw.js`, the service worker: shows the line the relay sent and opens Klatsch on a tap. It never fetches.
 * - `/ui/manifest.webmanifest`: lets a phone add Klatsch to its home screen, which iPhones need before they allow
 *   notifications from a web page.
 * A notification never carries what someone wrote or who: a fixed line such as "Something new in your circle", and a tap opens Klatsch.
 */
export const PUSH_SCRIPT = `'use strict';
(() => {
  const bytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  const same = (a, b) => a && b && a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === b[i]);
  // On every visit where this browser has them: update the service worker, renew a subscription made with an
  // old key, and re-send it, so a device the relay lost gets notifications again. Never asks for permission.
  window.klatschPushSync = async (key, csrf) => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const registration = await navigator.serviceWorker.getRegistration('/ui/');
    if (!registration) return;
    registration.update().catch(() => {});
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const wanted = bytes(key);
    if (!same(subscription.options && subscription.options.applicationServerKey, wanted)) {
      await subscription.unsubscribe();
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
    }
    const json = subscription.toJSON();
    const response = await fetch('/ui/push/sync', { method: 'POST', body: new URLSearchParams({ csrf, endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth }), credentials: 'same-origin', redirect: 'error' });
    // Turned off from another device: drop it here too, so the page no longer says it is on.
    if (response.ok && (await response.text()) === 'off') await subscription.unsubscribe();
  };
  const sync = document.querySelector('[data-push-sync]');
  if (sync) window.klatschPushSync(sync.dataset.key, sync.dataset.csrf).catch(() => {});
})();
(() => {
  const button = document.querySelector('button[data-push]');
  const off = document.querySelector('button[data-push-off]');
  const status = document.getElementById('push-status');
  if (!button || !status) return;
  const say = (text) => { status.textContent = text; status.hidden = false; };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { say(button.dataset.unsupported); return; }
  const bytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  const post = (path, fields) =>
    fetch(path, { method: 'POST', body: new URLSearchParams({ csrf: button.dataset.csrf, ...fields }), credentials: 'same-origin', redirect: 'error' });
  // This browser already gets them: say so, and offer to turn them off here instead of on.
  const showOn = () => {
    button.hidden = true;
    say(button.dataset.here);
    if (off) off.hidden = false;
  };
  (async () => {
    try {
      await window.klatschPushSync(button.dataset.key, button.dataset.csrf).catch(() => {});
      const registration = await navigator.serviceWorker.getRegistration('/ui/');
      const existing = registration && Notification.permission === 'granted' ? await registration.pushManager.getSubscription() : null;
      if (existing) showOn();
      else button.hidden = false;
    } catch {
      button.hidden = false;
    }
  })();
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if ((await Notification.requestPermission()) !== 'granted') { say(button.dataset.denied); button.disabled = false; return; }
      const registration = await navigator.serviceWorker.register('/ui/sw.js', { scope: '/ui/' });
      await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(button.dataset.key) }));
      const json = subscription.toJSON();
      const response = await post('/ui/push/subscribe', { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth });
      if (!response.ok) throw new Error('refused');
      // The page shows it from the relay's side too (the device count, the offer gone).
      window.location.reload();
    } catch {
      say(button.dataset.failed);
      button.disabled = false;
    }
  });
  if (off) {
    off.addEventListener('click', async () => {
      off.disabled = true;
      try {
        const registration = await navigator.serviceWorker.getRegistration('/ui/');
        const subscription = registration ? await registration.pushManager.getSubscription() : null;
        if (subscription) {
          await post('/ui/push/unsubscribe', { endpoint: subscription.endpoint });
          await subscription.unsubscribe();
        }
        window.location.reload();
      } catch {
        say(button.dataset.failed);
        off.disabled = false;
      }
    });
  }
})();
`;

export const SERVICE_WORKER = `'use strict';
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = typeof data.title === 'string' ? data.title.slice(0, 80) : 'Klatsch';
  const body = typeof data.body === 'string' ? data.body.slice(0, 200) : 'Something new on Klatsch.';
  // One Klatsch entry in the notification centre, but every new one alerts again: without renotify a browser
  // swaps the old entry for the new one in silence, and the person never hears that something arrived.
  event.waitUntil(self.registration.showNotification(title, { body, tag: 'klatsch', renotify: true, icon: '/icon.png', badge: '/icon.png' }));
});
// A fixed worker takes over at once instead of waiting until every Klatsch tab is closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
// A tap brings an open Klatsch tab to the front and shows Home there; only without one does it open a new window.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = open.find((client) => new URL(client.url).pathname.startsWith('/ui'));
    if (tab) {
      await tab.focus();
      if ('navigate' in tab) await tab.navigate('/ui').catch(() => {});
      return;
    }
    await self.clients.openWindow('/ui');
  })());
});
`;

export const MANIFEST = JSON.stringify({
  name: 'Klatsch',
  short_name: 'Klatsch',
  start_url: '/ui',
  scope: '/ui/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#0071e3',
  icons: [
    { src: '/ui/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  ],
});

/** The cup on a blue tile, as the favicon, for the home screen and notifications. */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0071E3"/><g transform="translate(4 3)" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/></g></svg>`;
