/**
 * The conversation page's own script, `/ui/record.js` (same-origin, that page only), like a messenger:
 * - Enter sends the message on a computer; Shift+Enter starts a new line. On a touch screen Enter is a new line.
 * - Voice notes: hold the microphone to record and let go to send; slide off the button to cancel. Hands-free: a
 *   tap starts recording without holding, and so does sliding up while holding (the recording locks); then a tap on
 *   the microphone sends and ✕ (or Esc) cancels. With a keyboard, Enter or Space starts and the next one sends.
 * The note is posted like the page's own form (its form token, same origin), as the message's file, and the page
 * reloads to show it. Nothing is recorded before the person presses, and the microphone is released as soon as the
 * recording ends. It writes no HTML from what it records, and goes only to this relay.
 */
export const RECORD_SCRIPT = `'use strict';
(() => {
  // Enter sends, as in a messenger on a computer. Not while an input method composes, and not on touch screens.
  const text = document.querySelector('form.typebar textarea');
  if (text && !matchMedia('(pointer: coarse)').matches) {
    text.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing) return;
      e.preventDefault();
      if (text.value.trim()) text.form.requestSubmit();
    });
  }

  // A room shows new messages while it is on screen: the page asks for itself every 8 seconds and swaps the list.
  const live = document.querySelector('[data-live]');
  if (live) {
    setInterval(async () => {
      if (document.visibilityState !== 'visible' || (text && text.value)) return;
      try {
        const res = await fetch(location.pathname, { credentials: 'same-origin' });
        if (!res.ok) return;
        const next = new DOMParser().parseFromString(await res.text(), 'text/html').querySelector('[data-live]');
        if (next && next.innerHTML !== live.innerHTML) live.innerHTML = next.innerHTML;
      } catch {}
    }, 8000);
  }

  const button = document.querySelector('[data-record]');
  if (!button) return;
  const cancelButton = document.querySelector('[data-record-cancel]');
  const status = document.querySelector('[data-record-status]');
  const say = (line) => { if (status) status.textContent = line; };
  if (!window.MediaRecorder || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    button.hidden = true;
    return;
  }
  const MAX_MS = 120000;
  const MIN_MS = 600;
  const LOCK_PX = 60;
  const kinds = [['audio/webm;codecs=opus', 'webm'], ['audio/mp4', 'm4a'], ['audio/ogg;codecs=opus', 'ogg'], ['audio/webm', 'webm']];
  const kind = kinds.find(([type]) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) || ['', 'webm'];
  let recorder = null, stream = null, chunks = [], started = 0, timer = null, held = false, locked = false, cancelled = false, busy = false, startY = 0;

  const release = () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    clearInterval(timer);
    button.classList.remove('on', 'locked');
    button.setAttribute('aria-pressed', 'false');
    if (cancelButton) cancelButton.hidden = true;
  };
  const lock = () => {
    if (locked) return;
    locked = true;
    held = false;
    button.classList.add('locked');
    if (cancelButton) cancelButton.hidden = false;
    tick();
  };
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    const time = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    say((locked ? button.dataset.locked : button.dataset.recording).replace('{t}', time));
    if (Date.now() - started >= MAX_MS) stop(false);
  };
  const start = async () => {
    if (recorder || busy) return;
    cancelled = false;
    locked = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      say(button.dataset.denied);
      return;
    }
    chunks = [];
    recorder = kind[0] ? new MediaRecorder(stream, { mimeType: kind[0] }) : new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = send;
    recorder.start();
    started = Date.now();
    button.classList.add('on');
    button.setAttribute('aria-pressed', 'true');
    // Let go while the browser was still asking for the microphone, or a tap: record hands-free.
    if (!held) lock();
    tick();
    timer = setInterval(tick, 250);
  };
  const stop = (cancel) => {
    if (!recorder) return;
    cancelled = cancel || Date.now() - started < MIN_MS;
    const r = recorder;
    recorder = null;
    locked = false;
    r.stop();
    release();
  };
  async function send() {
    if (cancelled) { say(button.dataset.cancelled); return; }
    const type = (chunks[0] && chunks[0].type) || kind[0] || 'audio/webm';
    const blob = new Blob(chunks, { type });
    if (blob.size > 5 * 1024 * 1024) { say(button.dataset.tooLong); return; }
    busy = true;
    say(button.dataset.sending);
    const body = new FormData();
    body.set('csrf', button.dataset.csrf);
    body.set('text', '');
    body.set('voice', '1');
    body.append('file', blob, 'voice-note.' + (type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'));
    try {
      const res = await fetch(button.dataset.action, { method: 'POST', body, credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      location.replace(location.pathname + '#end');
      location.reload();
    } catch {
      busy = false;
      say(button.dataset.failed);
    }
  }

  // Hold to talk; a tap, or sliding up while holding, records hands-free; in hands-free a tap sends.
  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (recorder && locked) { stop(false); return; }
    held = true;
    startY = e.clientY;
    try { button.setPointerCapture(e.pointerId); } catch {}
    start();
  });
  button.addEventListener('pointerup', () => {
    if (!held) return;
    held = false;
    if (!recorder) return;
    // A short press is a tap: keep recording, hands-free. A longer hold sends when let go.
    if (Date.now() - started < MIN_MS) lock(); else stop(false);
  });
  button.addEventListener('pointercancel', () => { if (held) { held = false; stop(true); } });
  button.addEventListener('pointermove', (e) => {
    if (!recorder || !held) return;
    if (startY - e.clientY > LOCK_PX) { lock(); return; }
    const box = button.getBoundingClientRect();
    const away = e.clientX < box.left - 60 || e.clientX > box.right + 60 || e.clientY > box.bottom + 60;
    if (away) { held = false; stop(true); }
  });
  if (cancelButton) cancelButton.addEventListener('click', () => stop(true));
  // Keyboards and screen readers: one press starts (hands-free), the next one sends.
  button.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (recorder) stop(false); else { held = false; start(); }
  });
  button.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && recorder) stop(true); });
})();
`;
