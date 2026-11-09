/**
 * The one script the web UI has, served same-origin at /ui/passkey.js and allowed only on the pages with a passkey
 * button (sign-in, Settings, and Home while it offers one). It does what a form cannot: hand the relay's challenge to the browser's passkey
 * prompt and post the answer back. Buttons stay hidden without it, or where the browser has no passkeys. It writes
 * no HTML and goes only to paths on this relay.
 */
export const PASSKEY_SCRIPT = `'use strict';
(() => {
  if (!window.PublicKeyCredential || !navigator.credentials) return;
  const bytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  const text = (buffer) => {
    let out = '';
    for (const byte of new Uint8Array(buffer)) out += String.fromCharCode(byte);
    return btoa(out).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  };
  const post = async (path, csrf, data) => {
    const body = new URLSearchParams({ csrf });
    if (data) body.set('data', JSON.stringify(data));
    const response = await fetch(path, { method: 'POST', body, credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json' } });
    const answer = await response.json();
    if (!response.ok || !answer || typeof answer !== 'object') throw new Error('refused');
    return answer;
  };
  const go = (answer) => {
    if (typeof answer.next !== 'string' || !answer.next.startsWith('/ui')) throw new Error('refused');
    const next = new URL(answer.next, window.location.href);
    if (next.origin !== window.location.origin) throw new Error('refused');
    // Back on the same page (Settings), only the fragment would change: load it again to show the new passkey.
    if (next.pathname === window.location.pathname && next.search === window.location.search) {
      window.location.hash = next.hash;
      window.location.reload();
    } else window.location.assign(next.href);
  };
  const register = async (csrf, back) => {
    const { key, options } = await post('/ui/passkeys/options', csrf);
    const publicKey = {
      ...options,
      challenge: bytes(options.challenge),
      user: { ...options.user, id: bytes(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: bytes(c.id) })),
    };
    const made = await navigator.credentials.create({ publicKey });
    const response = made.response;
    go(await post('/ui/passkeys', csrf, {
      key,
      back,
      credential: {
        id: made.id,
        rawId: text(made.rawId),
        type: made.type,
        clientExtensionResults: made.getClientExtensionResults(),
        response: {
          clientDataJSON: text(response.clientDataJSON),
          attestationObject: text(response.attestationObject),
          transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
        },
      },
    }));
  };
  const signIn = async (csrf) => {
    const { key, options } = await post('/ui/auth/passkey/options', csrf);
    const got = await navigator.credentials.get({ publicKey: { ...options, challenge: bytes(options.challenge), allowCredentials: [] } });
    const response = got.response;
    go(await post('/ui/auth/passkey', csrf, {
      key,
      credential: {
        id: got.id,
        rawId: text(got.rawId),
        type: got.type,
        clientExtensionResults: got.getClientExtensionResults(),
        response: {
          clientDataJSON: text(response.clientDataJSON),
          authenticatorData: text(response.authenticatorData),
          signature: text(response.signature),
          ...(response.userHandle ? { userHandle: text(response.userHandle) } : {}),
        },
      },
    }));
  };
  for (const button of document.querySelectorAll('button[data-passkey]')) {
    const error = document.getElementById('passkey-error');
    const box = button.closest('[data-passkey-box]');
    if (box) box.hidden = false;
    button.addEventListener('click', async () => {
      if (error) error.hidden = true;
      button.disabled = true;
      try {
        await (button.dataset.passkey === 'add' ? register : signIn)(button.dataset.csrf || '', button.dataset.back || '');
      } catch {
        if (error) error.hidden = false;
        button.disabled = false;
      }
    });
  }
  // Home's offer, on its first load after a sign-in: open the browser's own dialog once, by itself. Nothing is
  // made without the person's Face ID, Touch ID or screen lock. A browser that wants a click first (Safari), a
  // cancel or any failure is quiet: the card and its button stay.
  const auto = document.querySelector('[data-passkey-auto="1"] button[data-passkey="add"]');
  if (auto) {
    auto.disabled = true;
    register(auto.dataset.csrf || '', auto.dataset.back || '').catch(() => {
      auto.disabled = false;
    });
  }
})();
`;
