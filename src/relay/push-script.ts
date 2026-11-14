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
  const button = document.querySelector('button[data-push]');
  const status = document.getElementById('push-status');
  if (!button || !status) return;
  const say = (text) => { status.textContent = text; status.hidden = false; };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { say(button.dataset.unsupported); return; }
  const bytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  button.hidden = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if ((await Notification.requestPermission()) !== 'granted') { say(button.dataset.denied); button.disabled = false; return; }
      const registration = await navigator.serviceWorker.register('/ui/sw.js', { scope: '/ui/' });
      await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(button.dataset.key) }));
      const json = subscription.toJSON();
      const body = new URLSearchParams({ csrf: button.dataset.csrf, endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth });
      const response = await fetch('/ui/push/subscribe', { method: 'POST', body, credentials: 'same-origin', redirect: 'error' });
      if (!response.ok) throw new Error('refused');
      say(button.dataset.done);
    } catch {
      say(button.dataset.failed);
      button.disabled = false;
    }
  });
})();
`;

export const SERVICE_WORKER = `'use strict';
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = typeof data.title === 'string' ? data.title.slice(0, 80) : 'Klatsch';
  const body = typeof data.body === 'string' ? data.body.slice(0, 200) : 'Something new on Klatsch.';
  event.waitUntil(self.registration.showNotification(title, { body, tag: 'klatsch', icon: '/ui/icon.svg' }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/ui'));
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
