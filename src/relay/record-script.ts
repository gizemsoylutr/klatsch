/**
 * Voice notes like a messenger: `/ui/record.js`, on a conversation page only. Hold the microphone button to record,
 * let go to send, slide off the button to cancel; a tap (or Enter/Space) starts and a second one sends, for
 * keyboards and screen readers. The note is posted like the page's own form (its form token, same origin), as the
 * message's file, and the page reloads to show it. Nothing is recorded before the person presses, and the
 * microphone is released as soon as they let go. It writes no HTML from what it records, and goes only to this relay.
 */
export const RECORD_SCRIPT = `'use strict';
(() => {
  const button = document.querySelector('[data-record]');
  if (!button) return;
  const status = document.querySelector('[data-record-status]');
  const say = (text) => { if (status) status.textContent = text; };
  if (!window.MediaRecorder || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    button.hidden = true;
    return;
  }
  const MAX_MS = 120000;
  const MIN_MS = 600;
  const kinds = [['audio/webm;codecs=opus', 'webm'], ['audio/mp4', 'm4a'], ['audio/ogg;codecs=opus', 'ogg'], ['audio/webm', 'webm']];
  const kind = kinds.find(([type]) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) || ['', 'webm'];
  let recorder = null, stream = null, chunks = [], started = 0, timer = null, held = false, cancelled = false, busy = false;

  const release = () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    clearInterval(timer);
    button.classList.remove('on');
    button.setAttribute('aria-pressed', 'false');
  };
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    say(button.dataset.recording.replace('{t}', Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')));
    if (Date.now() - started >= MAX_MS) stop(false);
  };
  const start = async () => {
    if (recorder || busy) return;
    cancelled = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      say(button.dataset.denied);
      return;
    }
    // Let go while the browser was still asking for the microphone: nothing to send yet.
    if (!held && button.dataset.mode === 'hold') { release(); say(button.dataset.hint); return; }
    chunks = [];
    recorder = kind[0] ? new MediaRecorder(stream, { mimeType: kind[0] }) : new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = send;
    recorder.start();
    started = Date.now();
    button.classList.add('on');
    button.setAttribute('aria-pressed', 'true');
    tick();
    timer = setInterval(tick, 250);
  };
  const stop = (cancel) => {
    if (!recorder) return;
    cancelled = cancel || Date.now() - started < MIN_MS;
    const r = recorder;
    recorder = null;
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

  // Hold to talk: press starts, letting go sends, leaving the button cancels.
  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    button.dataset.mode = 'hold';
    held = true;
    try { button.setPointerCapture(e.pointerId); } catch {}
    start();
  });
  button.addEventListener('pointerup', () => { held = false; if (button.dataset.mode === 'hold') stop(false); });
  button.addEventListener('pointercancel', () => { held = false; stop(true); });
  button.addEventListener('pointermove', (e) => {
    if (!recorder || button.dataset.mode !== 'hold') return;
    const box = button.getBoundingClientRect();
    const away = e.clientX < box.left - 60 || e.clientX > box.right + 60 || e.clientY < box.top - 60 || e.clientY > box.bottom + 60;
    if (away) { held = false; stop(true); }
  });
  // Keyboards and screen readers: one press starts, the next one sends.
  button.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    button.dataset.mode = 'tap';
    if (recorder) stop(false); else start();
  });
  button.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && recorder) stop(true); });
  say(button.dataset.hint);
})();
`;
