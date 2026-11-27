import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getUiCapability, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { ClientCapabilities } from '@modelcontextprotocol/server';
import type { Approval } from '../auth/approvals.ts';
import { keyedHash, randomToken } from '../crypto.ts';
import type { ApprovalView } from '../service.ts';
import type { Db } from '../store/db.ts';

/**
 * Cards in the chat (MCP Apps, extension `io.modelcontextprotocol/ui`). In a chat app that shows them (ChatGPT,
 * Claude), an approval or a question for the person opens as Klatsch's own card inside the conversation: the
 * person reads it and decides there, without leaving the chat.
 *
 * What keeps the model from deciding: the card gets a one-time key in the tool result's `_meta`, which hosts give
 * to the card and not to the model, and the only tool that takes the key, `klatsch_card`, is visible to the card
 * only (`visibility: ["app"]`), which hosts leave out of the model's tool list. Both rest on the chat app keeping
 * to the standard, which docs/security-model.md says plainly; where cards are not shown, the Klatsch page or a
 * code decides, as before. A key is bound to its person and to one approval or one question, works once, and
 * lasts as long as the approval.
 */

export const CARD_URI = 'ui://klatsch/card.html';
export const CARD_META = 'dev.klatsch/card';
const KEY_TTL_MS = 10 * 60 * 1000;

/** Whether this client shows MCP Apps cards. */
export function showsCards(capabilities: ClientCapabilities | undefined): boolean {
  return Boolean(getUiCapability(capabilities)?.mimeTypes?.includes(RESOURCE_MIME_TYPE));
}

export interface CardLine {
  label: string;
  text: string;
}
export interface CardAction {
  decision: 'approved' | 'always' | 'declined' | 'answer' | 'draft' | 'friend_link' | 'reply';
  label: string;
  primary?: boolean;
}
/** What the card shows: plain strings only, rendered as text. */
export interface Card {
  key: string;
  title: string;
  lines: CardLine[];
  note: string;
  actions: CardAction[];
  /** The drafted words, editable before sending: the edited text goes with the decision. */
  edit?: { label: string; value: string; max: number };
  /** A text box for the person's own answer, sent with the `answer` action. */
  answerBox?: { label: string; placeholder: string; max: number };
  flags?: string[];
  /** A file picker: photos, PDFs and voice notes go with the decision. */
  pick?: boolean;
  /** A question: once asked, the card waits for the answer and shows it. */
  waitsForAnswer?: boolean;
  /** Files the other person sent, to open in the browser (Klatsch's page, signed in). */
  files?: { name: string; size: number; url: string }[];
  /** Where the person turns on notifications, offered once the card is done: chat apps cannot tell them when an answer comes. */
  notify?: string;
  /** A conversation with one friend: the card shows it, keeps it fresh, and sends the person's replies. */
  chat?: ChatPayload;
}

export interface ChatPayload {
  with: { name: string; handle: string };
  messages: { mine: boolean; text: string; at: number; files: { name: string; url: string }[] }[];
  /** The Klatsch page with this conversation. */
  page: string;
  max: number;
  /** False for a guest, who sends no files: the card shows no file picker. */
  files: boolean;
}

/** A conversation card's key lasts a day and works for every reply in it: each send is the person's own click. */
export const CHAT_KEY_TTL_MS = 24 * 60 * 60 * 1000;

export function issueKey(db: Db, secret: Buffer, userId: string, kind: 'approval' | 'ask' | 'friend' | 'chat', ref: string, expiresAt = Date.now() + KEY_TTL_MS): string {
  const key = randomToken(32);
  // Old keys go; a question shown again keeps only its newest card working.
  db.prepare('DELETE FROM app_keys WHERE expires_at < ?').run(Date.now() - 24 * 60 * 60 * 1000);
  // A conversation is different: every card of it stays live until it expires, so the one a sent message turns
  // into does not close the one opened before.
  if (kind !== 'chat') db.prepare('DELETE FROM app_keys WHERE user_id = ? AND kind = ? AND ref = ? AND used_at IS NULL').run(userId, kind, ref);
  db.prepare('INSERT INTO app_keys (hash, user_id, kind, ref, expires_at) VALUES (?, ?, ?, ?, ?)').run(keyedHash(secret, `app-key ${key}`), userId, kind, ref, expiresAt);
  return key;
}

/**
 * What a card shown again should say: still `open`, `done` with what came of it, or `gone` (decided on the page,
 * withdrawn or expired). Looked up by its own key, for its own person; nothing else is told.
 */
export function keyState(db: Db, secret: Buffer, userId: string, key: string): { state: 'open' | 'done' | 'gone'; outcome?: string; kind?: 'approval' | 'ask' | 'friend' | 'chat'; ref?: string } {
  const row = db.prepare('SELECT user_id, kind, ref, expires_at, used_at, outcome FROM app_keys WHERE hash = ?').get(keyedHash(secret, `app-key ${key}`)) as
    | { user_id: string; kind: 'approval' | 'ask' | 'friend' | 'chat'; ref: string; expires_at: number; used_at: number | null; outcome: string | null }
    | undefined;
  if (!row || row.user_id !== userId) return { state: 'gone' };
  if (row.used_at !== null) return { state: 'done', kind: row.kind, ref: row.ref, ...(row.outcome ? { outcome: row.outcome } : {}) };
  if (row.expires_at <= Date.now()) return { state: 'gone' };
  return { state: 'open', kind: row.kind, ref: row.ref };
}

/** Keeps what came of a decision, for when the chat shows the card again. */
export function keepOutcome(db: Db, secret: Buffer, key: string, outcome: string): void {
  db.prepare('UPDATE app_keys SET outcome = ? WHERE hash = ?').run(outcome, keyedHash(secret, `app-key ${key}`));
}

/** Uses the key once, for its own person; anything else is simply not found. */
export function useKey(db: Db, secret: Buffer, userId: string, key: string): { kind: 'approval' | 'ask' | 'friend' | 'chat'; ref: string } | undefined {
  const hash = keyedHash(secret, `app-key ${key}`);
  const row = db.prepare('SELECT user_id, kind, ref, expires_at, used_at FROM app_keys WHERE hash = ?').get(hash) as
    | { user_id: string; kind: 'approval' | 'ask' | 'friend' | 'chat'; ref: string; expires_at: number; used_at: number | null }
    | undefined;
  if (!row || row.user_id !== userId || row.used_at !== null || row.expires_at <= Date.now()) return undefined;
  const claimed = db.prepare('UPDATE app_keys SET used_at = ? WHERE hash = ? AND used_at IS NULL').run(Date.now(), hash);
  return claimed.changes ? { kind: row.kind, ref: row.ref } : undefined;
}

const flagList = (flags: { kind: string }[]) => (flags.length ? { flags: [...new Set(flags.map((f) => f.kind))] } : {});

/** The card for an approval the person decides in the chat, from the same view the approval page shows. */
export function approvalCard(key: string, view: ApprovalView, approval: Approval): Card | undefined {
  const tags = (list: string[]) => (list.length ? [{ label: 'Tags', text: list.join(', ') }] : []);
  switch (view.action) {
    case 'ask_person':
      return {
        key,
        title: `Ask ${view.to.name} (@${view.to.handle})?`,
        pick: true,
        waitsForAnswer: true,
        lines: tags(view.tags),
        edit: { label: 'Question', value: view.question, max: 500 },
        note: `Only ${view.to.name} reads this, with your name.`,
        actions: [
          { decision: 'declined', label: 'Not now' },
          { decision: 'approved', label: 'Ask', primary: true },
        ],
        ...flagList(view.flags),
      };
    case 'answer_ask':
      return {
        key,
        title: `Send your answer to ${view.from.name}?`,
        pick: true,
        lines: [{ label: 'Their question', text: view.question }],
        edit: { label: 'Your answer', value: view.answer, max: 500 },
        note: `Only ${view.from.name} reads it, and it goes to the AI they asked with.`,
        actions: [
          { decision: 'declined', label: 'Not now' },
          { decision: 'approved', label: 'Send', primary: true },
        ],
        ...flagList(view.flags),
      };
    case 'send_message':
      return {
        key,
        title: `Send to ${view.to.name} (@${view.to.handle})?`,
        pick: true,
        lines: [],
        edit: { label: 'Message', value: view.text, max: 2000 },
        note: `Only ${view.to.name} reads this, with your name.`,
        actions: [
          { decision: 'declined', label: 'Not now' },
          { decision: 'approved', label: 'Send', primary: true },
        ],
        ...flagList(view.flags),
      };
    case 'send_intro':
      return {
        key,
        title: 'Ask for an intro?',
        lines: [{ label: 'What you are stuck on', text: view.summary }, ...tags(view.tags)],
        note: 'Whoever solved this reads it. Names are shared only if they accept.',
        actions: [
          { decision: 'declined', label: 'Not now' },
          { decision: 'approved', label: 'Ask', primary: true },
        ],
      };
    case 'answer_intro':
      return {
        key,
        title: 'Someone would like to compare notes',
        lines: [{ label: 'What they are stuck on', text: view.request }, ...tags(view.tags)],
        note: 'Allowing shares your names.',
        actions: [
          { decision: 'declined', label: 'Decline' },
          { decision: 'always', label: 'Allow always' },
          { decision: 'approved', label: 'Allow once', primary: true },
        ],
      };
    default:
      // Sharing a note asks which circles and who reads it: that stays on the Klatsch page for now.
      void approval;
      return undefined;
  }
}

/** The card for a question someone asked the person directly: its words go to the card only, never the model. */
export function questionCard(key: string, from: { name: string; handle: string }, question: string, files: { name: string; size: number; url: string }[] = []): Card {
  return {
    key,
    pick: true,
    ...(files.length ? { files } : {}),
    title: `${from.name} (@${from.handle}) asks you`,
    lines: [{ label: 'Question', text: question }],
    note: `Only ${from.name} reads your answer, and it goes to the AI they asked with. Your AI here reads the question only if you choose "Draft with my AI".`,
    answerBox: { label: 'Your answer', placeholder: 'Write your answer', max: 500 },
    actions: [
      { decision: 'declined', label: 'Decline' },
      { decision: 'draft', label: 'Draft with my AI' },
      { decision: 'answer', label: 'Send answer', primary: true },
    ],
  };
}

/** A conversation with one friend in the chat: its words go to the card only, never the model. */
export function chatCard(key: string, chat: ChatPayload): Card {
  return {
    key,
    title: `${chat.with.name} (@${chat.with.handle})`,
    lines: [],
    note: `Only you and ${chat.with.name} read this. Your AI here reads it only if you choose "Draft with my AI".`,
    actions: [],
    chat,
  };
}

/** "Add a friend" in the chat: the person's click makes the link, and only the card shows it, to copy and send. */
export function friendCard(key: string): Card {
  return {
    key,
    title: 'Add a friend',
    lines: [],
    note: 'Make a link and send it to your friend by any messenger. It works once, for seven days. When they open it and sign in, you can ask each other anything.',
    actions: [{ decision: 'friend_link', label: 'Make a link', primary: true }],
  };
}

let cached: string | undefined;

/**
 * The card's page: the MCP Apps client bundle, turned from an ES module into a global so it runs inline, and a
 * small script that renders the card from the tool result as text (never as HTML) and sends the decision.
 */
export function cardHtml(): string {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const bundle = readFileSync(require.resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8');
  const exported = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(bundle);
  if (!exported) throw new Error('The MCP Apps bundle changed shape: no final export.');
  const globals = exported[1]!
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/))
    .map(([local, name]) => `${JSON.stringify(name ?? local)}:${local}`)
    .join(',');
  const script = `${bundle.slice(0, exported.index)}\nglobalThis.KlatschApps={${globals}};`;
  cached = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Klatsch</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1d1d1f; --muted: #6e6e73; --line: #e8e8ed; --chip: #f0f0f5; --accent: #0071e3; --ink: #ffffff; --warn: #8a4b00; --warn-soft: #fff4e5; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1c1e; --fg: #f5f5f7; --muted: #a1a1a6; --line: #2c2c2e; --chip: #2c2c2e; --accent: #0a84ff; --warn: #ffb340; --warn-soft: #3a2a12; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
main { padding: 16px 18px; display: grid; gap: 12px; }
.brand { font-size: 12px; font-weight: 600; color: var(--accent); }
h1 { font-size: 18px; margin: 0; line-height: 1.3; }
dl { margin: 0; display: grid; gap: 8px; }
dt { font-size: 12px; color: var(--muted); }
dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.note { font-size: 13px; color: var(--muted); margin: 0; }
.flags { font-size: 13px; color: var(--warn); background: var(--warn-soft); border-radius: 8px; padding: 8px 10px; margin: 0; }
label { font-size: 13px; font-weight: 600; }
input[type=file] { font: inherit; font-size: 13px; color: var(--fg); }
button.mic { width: 40px; height: 40px; padding: 0; border-radius: 999px; font-size: 18px; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
button.mic.on { background: #FF3B30; color: #FFFFFF; }
input[type=text] { width: 100%; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; }
textarea { width: 100%; min-height: 76px; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; resize: vertical; }
.row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
button { font: inherit; font-size: 14px; font-weight: 500; border: 0; border-radius: 999px; padding: 7px 16px; background: var(--chip); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); color: var(--ink); }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.done { font-weight: 600; }
.thread { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; max-height: 340px; overflow-y: auto; }
.msg { max-width: 85%; background: var(--chip); border-radius: 12px 12px 12px 4px; padding: 7px 11px; justify-self: start; display: grid; gap: 2px; }
.msg.mine { justify-self: end; background: var(--accent); color: var(--ink); border-radius: 12px 12px 4px 12px; }
.msg .who { font-size: 11px; opacity: 0.75; }
.msg .text { white-space: pre-wrap; overflow-wrap: anywhere; }
.msg button { font-size: 12px; padding: 2px 8px; justify-self: start; }
</style></head>
<body><main id="card" aria-live="polite"><p class="note">Klatsch</p></main>
<script>${script}</script>
<script>
(() => {
  const { App } = globalThis.KlatschApps;
  const app = new App({ name: 'Klatsch card', version: '1' });
  const root = document.getElementById('card');
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  let current = null;
  /** After a decision: chat apps cannot say when an answer arrives, so the card offers notifications. */
  const notifyOffer = () => {
    if (!current || !current.notify) return [];
    const b = el('button', 'Turn on notifications'); b.type = 'button';
    b.addEventListener('click', () => app.openLink({ url: current.notify }).catch(() => {}));
    const row = el('div', undefined, 'row'); row.append(b);
    return [el('p', 'This chat cannot tell you when they answer. Klatsch can, on your phone or browser.', 'note'), row];
  };
  const finish = (message) => {
    root.replaceChildren(el('p', 'Klatsch', 'brand'), el('p', message, 'done'), ...notifyOffer());
    app.updateModelContext({ content: [{ type: 'text', text: 'Klatsch: ' + message }] }).catch(() => {});
  };
  // The friend link: shown and copied here, never told to the model.
  const showLink = (message, link) => {
    const field = el('input'); field.type = 'text'; field.readOnly = true; field.value = link; field.id = 'link';
    field.addEventListener('focus', () => field.select());
    const copy = el('button', 'Copy link', 'primary'); copy.type = 'button';
    const said = el('p', '', 'note');
    // Chat apps often refuse the clipboard API in a card; the older copy command still works on a click.
    copy.addEventListener('click', async () => {
      field.focus(); field.select(); field.setSelectionRange(0, link.length);
      let copied = false;
      try { await navigator.clipboard.writeText(link); copied = true; } catch {}
      if (!copied) { try { copied = document.execCommand('copy'); } catch {} }
      said.textContent = copied ? 'Copied. Paste it into a message to your friend.' : 'Selected: press Ctrl+C (or Cmd+C) to copy it.';
    });
    // Or straight into a message: the chat app opens the messenger with the link filled in.
    const whatsapp = el('button', 'Send on WhatsApp'); whatsapp.type = 'button';
    whatsapp.addEventListener('click', () => {
      const text = 'Add me as a friend on Klatsch: ' + link;
      app.openLink({ url: 'https://wa.me/?text=' + encodeURIComponent(text) }).catch(() => { said.textContent = 'This chat app cannot open links: copy it instead.'; });
    });
    const mail = el('button', 'Send by email'); mail.type = 'button';
    mail.addEventListener('click', () => {
      app.openLink({ url: 'mailto:?subject=' + encodeURIComponent('Add me on Klatsch') + '&body=' + encodeURIComponent('Add me as a friend on Klatsch: ' + link) }).catch(() => { said.textContent = 'This chat app cannot open links: copy it instead.'; });
    });
    const row = el('div', undefined, 'row'); row.append(mail, whatsapp, copy);
    root.replaceChildren(el('p', 'Klatsch', 'brand'), el('h1', message), field, row, said, ...notifyOffer());
    app.updateModelContext({ content: [{ type: 'text', text: 'Klatsch: your human made a friend link in the card and will send it themselves.' }] }).catch(() => {});
  };
  /** A question asked from the card: it waits there for the answer and shows it when it comes. */
  /** "Draft with my AI": first a word on how to answer and in what tone, then the assistant drafts. */
  const guide = (onGo) => {
    const panel = el('div', undefined, 'guide');
    const label = el('label', 'How should your AI answer? (optional)'); label.htmlFor = 'how';
    const how = el('input'); how.type = 'text'; how.id = 'how'; how.maxLength = 300;
    how.placeholder = 'e.g. "Yes, pick me up at 9" or "No, I am busy that day"';
    let tone = '';
    const tones = el('div', undefined, 'row'); tones.style.justifyContent = 'flex-start';
    const toneButtons = ['Friendly', 'Short', 'Formal'].map((t) => {
      const b = el('button', t); b.type = 'button'; b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        tone = tone === t ? '' : t;
        toneButtons.forEach((x) => { const on = x.textContent === tone; x.setAttribute('aria-pressed', String(on)); x.className = on ? 'primary' : ''; });
      });
      return b;
    });
    tones.append(...toneButtons);
    const go = el('button', 'Draft it', 'primary'); go.type = 'button';
    go.addEventListener('click', () => {
      go.disabled = true;
      const words = how.value.trim();
      onGo((words ? 'How I want to answer: ' + words + '.' : '') + (tone ? ' Tone: ' + tone.toLowerCase() + '.' : ''));
    });
    const row = el('div', undefined, 'row'); row.append(go);
    panel.append(label, how, el('p', 'Tone', 'who'), tones, row);
    setTimeout(() => how.focus(), 0);
    return panel;
  };
  /** An answer sent from the card: the question, the answer, and the friend's reply when it comes. */
  const showAnswered = (a, message) => {
    const parts = [el('p', 'Klatsch', 'brand'), el('h1', 'You answered ' + a.from)];
    if (message) parts.push(el('p', message, 'note'));
    parts.push(el('p', 'Their question', 'who'), el('p', a.question, 'text'), el('p', 'Your answer', 'who'), el('p', a.answer, 'done'));
    if (a.reply) parts.push(el('p', a.from + ' wrote back', 'who'), el('p', a.reply, 'done'));
    else if (a.friend) parts.push(el('p', 'Waiting for ' + a.from + ' to reply…', 'note'));
    root.replaceChildren(...parts, ...notifyOffer());
  };
  const awaitReply = (key) => {
    if (poll) clearInterval(poll);
    poll = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const result = await app.callServerTool({ name: 'klatsch_card_state', arguments: { key } });
        const a = ((result && result.structuredContent) || {}).answered;
        if (!a) { clearInterval(poll); return; }
        if (a.reply) { clearInterval(poll); showAnswered(a, ''); }
      } catch {}
    }, 8000);
  };
  const showAnswer = (ask) => {
    const old = root.querySelector('.answer');
    if (old) old.remove();
    const box = el('div', undefined, 'answer');
    if (ask.waiting) box.append(el('p', 'Waiting for their answer…', 'note'));
    else if (ask.declined) box.append(el('p', ask.from + ' declined to answer.', 'note'));
    else box.append(el('p', ask.from + ' answered:', 'who'), el('p', ask.text, 'done'));
    const brand = root.querySelector('.brand');
    if (brand && brand.nextSibling) brand.nextSibling.after(box); else root.append(box);
  };
  const awaitAnswer = (key) => {
    if (poll) clearInterval(poll);
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const result = await app.callServerTool({ name: 'klatsch_card_state', arguments: { key } });
        const ask = ((result && result.structuredContent) || {}).ask;
        if (!ask) { clearInterval(poll); return; }
        showAnswer(ask);
        if (!ask.waiting) clearInterval(poll);
      } catch {}
    };
    poll = setInterval(check, 8000);
    check();
  };
  /** A conversation: the messages, a box to write back, and a quiet refresh while the card is on screen. */
  let poll = null;
  const renderChat = (card, notice) => {
    current = card;
    const chat = card.chat;
    const list = el('ol', undefined, 'thread');
    list.setAttribute('aria-label', 'Messages');
    const fill = (messages) => {
      const items = messages.map((m) => {
        const li = el('li', undefined, 'msg' + (m.mine ? ' mine' : ''));
        li.append(el('span', (m.mine ? 'You' : chat.with.name) + ' · ' + new Date(m.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }), 'who'));
        if (m.text) li.append(el('span', m.text, 'text'));
        for (const f of m.files || []) {
          const b = el('button', '📎 ' + f.name); b.type = 'button';
          b.addEventListener('click', () => app.openLink({ url: f.url }).catch(() => {}));
          li.append(b);
        }
        return li;
      });
      if (!items.length) items.push(el('li', 'No messages yet. Write the first one below.', 'note'));
      list.replaceChildren(...items);
      list.scrollTop = list.scrollHeight;
    };
    fill(chat.messages);
    const label = el('label', 'Write to ' + chat.with.name); label.htmlFor = 'reply';
    const box = el('textarea'); box.id = 'reply'; box.maxLength = chat.max; box.placeholder = 'Your message';
    // A guest sends no files: no picker at all.
    const flabel = chat.files === false ? null : el('label', 'Add a photo, PDF or voice note (up to 3, 5 MB each)');
    const picker = flabel ? el('input') : null;
    if (picker) {
      flabel.htmlFor = 'files';
      picker.type = 'file'; picker.id = 'files'; picker.multiple = true;
      picker.accept = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,audio/*,.m4a,.mp3,.ogg,.wav,.webm';
    }
    const said = el('p', '', 'note');
    const send = el('button', 'Send', 'primary'); send.type = 'button';
    const draft = el('button', 'Draft with my AI'); draft.type = 'button';
    const page = el('button', 'Open in Klatsch'); page.type = 'button';
    page.addEventListener('click', () => app.openLink({ url: chat.page }).catch(() => {}));
    const fail = (result) => { let why = 'That did not work.'; try { why = JSON.parse(result.content[0].text).message || why; } catch {} said.textContent = why; };
    // Hold to talk, like a messenger. Where the chat app gives the card no microphone, the same button opens the
    // conversation on the Klatsch page, which records.
    const mic = chat.files === false ? null : el('button', '🎤', 'mic');
    if (mic) {
      mic.type = 'button'; mic.title = 'Hold to record a voice note'; mic.setAttribute('aria-label', mic.title);
      const perms = ((app.getHostCapabilities() || {}).sandbox || {}).permissions;
      const noMic = !window.MediaRecorder || !navigator.mediaDevices || (perms && !perms.microphone);
      const elsewhere = () => { said.textContent = 'This chat app does not let Klatsch use the microphone. Record it on your Klatsch page.'; app.openLink({ url: chat.page }).catch(() => {}); };
      let rec = null, stream = null, parts = [], at = 0, held = false, cancel = false, clock = null;
      const free = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; clearInterval(clock); mic.className = 'mic'; };
      const begin = async () => {
        if (noMic) { elsewhere(); return; }
        if (rec) return;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { elsewhere(); return; }
        if (!held) { free(); said.textContent = 'Hold the microphone to record, let go to send.'; return; }
        parts = []; cancel = false;
        const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
        rec = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
        rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
        rec.onstop = deliver;
        rec.start(); at = Date.now(); mic.className = 'mic on';
        const tick = () => { const s = Math.floor((Date.now() - at) / 1000); said.textContent = 'Recording ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ' · let go to send, slide away to cancel'; if (s >= 120) end(false); };
        tick(); clock = setInterval(tick, 250);
      };
      const end = (drop) => { if (!rec) return; cancel = drop || Date.now() - at < 600; const r = rec; rec = null; r.stop(); free(); };
      async function deliver() {
        if (cancel) { said.textContent = 'Cancelled.'; return; }
        const type = (parts[0] && parts[0].type) || 'audio/webm';
        const blob = new Blob(parts, { type });
        if (blob.size > 5 * 1024 * 1024) { said.textContent = 'That is too long for one voice note.'; return; }
        said.textContent = 'Sending…'; mic.disabled = true;
        try {
          const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = reject; r.readAsDataURL(blob); });
          const name = 'voice-note.' + (type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm');
          const result = await app.callServerTool({ name: 'klatsch_card', arguments: { key: card.key, decision: 'reply', text: '', voice: true, files: [{ name, data }] } });
          if (result.isError) { fail(result); return; }
          const sc = result.structuredContent || {};
          said.textContent = sc.message || 'Sent.';
          if (sc.chat) { chat.messages = sc.chat.messages; fill(chat.messages); }
          app.updateModelContext({ content: [{ type: 'text', text: 'Klatsch: your human sent a voice note to @' + chat.with.handle + ' from the card.' }] }).catch(() => {});
        } catch { said.textContent = 'The voice note did not go. Try again, or record it on your Klatsch page.'; }
        finally { mic.disabled = false; }
      }
      mic.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.preventDefault(); held = true; try { mic.setPointerCapture(e.pointerId); } catch {} begin(); });
      mic.addEventListener('pointerup', () => { held = false; end(false); });
      mic.addEventListener('pointercancel', () => { held = false; end(true); });
      mic.addEventListener('pointermove', (e) => { if (!rec) return; const b = mic.getBoundingClientRect(); if (e.clientX < b.left - 60 || e.clientX > b.right + 60 || e.clientY < b.top - 60 || e.clientY > b.bottom + 60) { held = false; end(true); } });
      mic.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    send.addEventListener('click', async () => {
      const text = box.value.trim();
      if (!text) { box.focus(); return; }
      const chosen = picker ? [...picker.files].slice(0, 3) : [];
      if (chosen.some((f) => f.size > 5 * 1024 * 1024)) { said.textContent = 'A file is at most 5 MB.'; return; }
      send.disabled = true; said.textContent = 'Sending…';
      try {
        const read = (f) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = reject; r.readAsDataURL(f); });
        const files = await Promise.all(chosen.map(async (f) => ({ name: f.name, data: await read(f) })));
        const result = await app.callServerTool({ name: 'klatsch_card', arguments: { key: card.key, decision: 'reply', text, ...(files.length ? { files } : {}) } });
        if (result.isError) { fail(result); return; }
        const sc = result.structuredContent || {};
        box.value = ''; if (picker) picker.value = ''; said.textContent = sc.message || 'Sent.';
        if (sc.chat) { chat.messages = sc.chat.messages; fill(chat.messages); }
        app.updateModelContext({ content: [{ type: 'text', text: 'Klatsch: your human sent a message to ' + '@' + chat.with.handle + ' from the card.' }] }).catch(() => {});
      } catch { said.textContent = 'That did not work. Try again, or write on your Klatsch page.'; }
      finally { send.disabled = false; }
    });
    draft.addEventListener('click', () => {
      draft.disabled = true;
      const panel = guide(async (how) => {
        try {
          const result = await app.callServerTool({ name: 'klatsch_card', arguments: { key: card.key, decision: 'draft' } });
          if (result.isError) { fail(result); draft.disabled = false; panel.remove(); return; }
          panel.remove();
          said.textContent = (result.structuredContent || {}).message || 'Sent to your AI.';
          app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Read my conversation with @' + chat.with.handle + ' from my Klatsch inbox and draft a reply for me to send.' + (how ? ' ' + how : '') }] }).catch(() => {});
        } catch { draft.disabled = false; panel.remove(); said.textContent = 'That did not work.'; }
      });
      row.after(panel);
    });
    const row = el('div', undefined, 'row'); row.append(page, draft, ...(mic ? [mic] : []), send);
    if (notice) said.textContent = notice;
    root.replaceChildren(el('p', 'Klatsch', 'brand'), el('h1', card.title), list, label, box, ...(picker ? [flabel, picker] : []), row, said, el('p', card.note, 'note'), ...notifyOffer());
    // New messages show up while the card is on screen; reading them here marks them read.
    if (poll) clearInterval(poll);
    poll = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const result = await app.callServerTool({ name: 'klatsch_card_state', arguments: { key: card.key, seen: true } });
        const sc = (result && result.structuredContent) || {};
        if (sc.state !== 'open') { clearInterval(poll); said.textContent = sc.message || 'Ask your AI to open the conversation again.'; send.disabled = true; return; }
        if (sc.chat && JSON.stringify(sc.chat.messages) !== JSON.stringify(chat.messages)) { chat.messages = sc.chat.messages; fill(chat.messages); }
      } catch {}
    }, 8000);
  };
  const render = (card) => {
    if (card.chat) { renderChat(card); return; }
    current = card;
    const parts = [el('p', 'Klatsch', 'brand'), el('h1', card.title)];
    const dl = el('dl');
    for (const line of card.lines) { dl.append(el('dt', line.label), el('dd', line.text)); }
    parts.push(dl);
    if (card.files && card.files.length) {
      const list = el('div', undefined, 'row');
      list.style.justifyContent = 'flex-start';
      for (const f of card.files) {
        const b = el('button', '📎 ' + f.name); b.type = 'button';
        b.addEventListener('click', () => app.openLink({ url: f.url }).catch(() => {}));
        list.append(b);
      }
      parts.push(el('p', 'Files with it (open in your browser, signed in to Klatsch):', 'note'), list);
    }
    if (card.flags && card.flags.length) parts.push(el('p', 'Check before sending: it may contain ' + card.flags.join(', ') + '.', 'flags'));
    let box;
    let edit;
    if (card.edit) {
      const label = el('label', card.edit.label + ' (you can change it)'); label.htmlFor = 'edit';
      edit = el('textarea'); edit.id = 'edit'; edit.maxLength = card.edit.max; edit.value = card.edit.value;
      parts.push(label, edit);
    }
    if (card.answerBox) {
      const id = 'answer';
      const label = el('label', card.answerBox.label); label.htmlFor = id;
      box = el('textarea'); box.id = id; box.maxLength = card.answerBox.max; box.placeholder = card.answerBox.placeholder;
      parts.push(label, box);
    }
    let picker;
    if (card.pick) {
      const label = el('label', 'Add a photo, PDF or voice note (up to 3, 5 MB each)'); label.htmlFor = 'files';
      picker = el('input'); picker.type = 'file'; picker.id = 'files'; picker.multiple = true;
      picker.accept = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,audio/*,.m4a,.mp3,.ogg,.wav,.webm';
      parts.push(label, picker);
    }
    parts.push(el('p', card.note, 'note'));
    const row = el('div', undefined, 'row');
    const buttons = card.actions.map((action) => {
      const b = el('button', action.label, action.primary ? 'primary' : '');
      b.type = 'button';
      b.addEventListener('click', () => {
        // "Draft with my AI": ask first how to answer, then draft.
        if (action.decision === 'draft') {
          if (root.querySelector('.guide')) return;
          row.after(guide((how) => run(how)));
          return;
        }
        run('');
      });
      const run = async (how) => {
        const answer = box ? box.value.trim() : '';
        if (action.decision === 'answer' && !answer) { box.focus(); return; }
        buttons.forEach((x) => (x.disabled = true));
        try {
          const edited = edit && action.decision !== 'declined' && edit.value.trim() !== card.edit.value.trim() ? { text: edit.value } : {};
          if (edit && action.decision !== 'declined' && !edit.value.trim()) { edit.focus(); buttons.forEach((x) => (x.disabled = false)); return; }
          const chosen = picker && action.decision !== 'declined' && action.decision !== 'draft' ? [...picker.files].slice(0, 3) : [];
          if (chosen.some((f) => f.size > 5 * 1024 * 1024)) { buttons.forEach((x) => (x.disabled = false)); root.append(el('p', 'A file is at most 5 MB.', 'flags error')); return; }
          const read = (f) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = reject; r.readAsDataURL(f); });
          const files = await Promise.all(chosen.map(async (f) => ({ name: f.name, data: await read(f) })));
          const result = await app.callServerTool({ name: 'klatsch_card', arguments: { key: card.key, decision: action.decision, ...(action.decision === 'answer' ? { answer } : {}), ...edited, ...(files.length ? { files } : {}) } });
          if (result.isError) {
            let why = 'That did not work.';
            try { why = JSON.parse(result.content[0].text).message || why; } catch {}
            buttons.forEach((x) => (x.disabled = false));
            const old = root.querySelector('.error');
            if (old) old.remove();
            root.append(el('p', why, 'flags error'));
            return;
          }
          const sc = result.structuredContent || {};
          if (typeof sc.link === 'string') { showLink(sc.message || 'Your link', sc.link); return; }
          // An answer sent: the card shows the question, the answer, and the reply when it comes.
          if (sc.answered) {
            showAnswered(sc.answered, sc.message || '');
            if (!sc.answered.reply && sc.answered.friend) awaitReply(card.key);
            app.updateModelContext({ content: [{ type: 'text', text: 'Klatsch: ' + (sc.message || 'Answer sent.') + ' The card shows the reply when it comes.' }] }).catch(() => {});
            return;
          }
          // A message sent: the card becomes the conversation, so the friend's reply shows up here as it comes.
          if (sc.card && sc.card.chat) {
            renderChat(sc.card, sc.message || 'Sent.');
            app.updateModelContext({ content: [{ type: 'text', text: 'Klatsch: ' + (sc.message || 'Sent.') + ' The card now shows the conversation; a reply appears there.' }] }).catch(() => {});
            return;
          }
          finish(sc.message || 'Done.');
          // A question just asked: the card waits for the answer.
          if (action.decision === 'approved' && card.waitsForAnswer) awaitAnswer(card.key);
          // "Draft with my AI": the person's click asks the assistant to start, so it does not wait for a message.
          if (action.decision === 'draft') {
            app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Read the question I just sent you from my Klatsch inbox and draft an answer for me to approve.' + (how ? ' ' + how : '') }] }).catch(() => {});
          }
        } catch (error) {
          buttons.forEach((x) => (x.disabled = false));
          root.append(el('p', 'That did not work. Try again, or decide on your Klatsch page.', 'flags'));
        }
      };
      return b;
    });
    row.append(...buttons);
    parts.push(row);
    root.replaceChildren(...parts);
  };
  // Shown again (the chat reloaded): ask the relay whether this card was decided already, before offering buttons.
  const show = async (card) => {
    current = card;
    try {
      const result = await app.callServerTool({ name: 'klatsch_card_state', arguments: { key: card.key, seen: true } });
      const sc = (result && result.structuredContent) || {};
      if (card.chat && sc.state === 'open') { if (sc.chat) card.chat.messages = sc.chat.messages; renderChat(card); return; }
      if (sc.state === 'done') {
        root.replaceChildren(el('p', 'Klatsch', 'brand'), el('h1', card.title), el('p', sc.message || 'Done.', 'done'));
        if (sc.ask) { showAnswer(sc.ask); if (sc.ask.waiting) awaitAnswer(card.key); }
        if (sc.answered) { showAnswered(sc.answered, sc.message || ''); if (!sc.answered.reply && sc.answered.friend) awaitReply(card.key); }
        return;
      }
      if (sc.state === 'gone') { root.replaceChildren(el('p', 'Klatsch', 'brand'), el('h1', card.title), el('p', sc.message || 'This card is no longer open.', 'note')); return; }
    } catch {}
    render(card);
  };
  app.ontoolresult = (result) => {
    const card = result && result._meta && result._meta['${CARD_META}'];
    if (card) show(card);
    else root.replaceChildren(el('p', 'Klatsch', 'brand'), el('p', (result && result.structuredContent && result.structuredContent.note) || 'Nothing to decide here.', 'note'));
  };
  app.connect().catch(() => {});
})();
</script></body></html>`;
  return cached;
}
