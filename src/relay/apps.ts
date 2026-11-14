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
  decision: 'approved' | 'always' | 'declined' | 'answer' | 'draft' | 'friend_link';
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
  /** A text box for the person's own answer, sent with the `answer` action. */
  answerBox?: { label: string; placeholder: string; max: number };
  flags?: string[];
}

export function issueKey(db: Db, secret: Buffer, userId: string, kind: 'approval' | 'ask' | 'friend', ref: string, expiresAt = Date.now() + KEY_TTL_MS): string {
  const key = randomToken(32);
  // Old keys go; a question shown again keeps only its newest card working.
  db.prepare('DELETE FROM app_keys WHERE expires_at < ?').run(Date.now() - 24 * 60 * 60 * 1000);
  db.prepare('DELETE FROM app_keys WHERE user_id = ? AND kind = ? AND ref = ? AND used_at IS NULL').run(userId, kind, ref);
  db.prepare('INSERT INTO app_keys (hash, user_id, kind, ref, expires_at) VALUES (?, ?, ?, ?, ?)').run(keyedHash(secret, `app-key ${key}`), userId, kind, ref, expiresAt);
  return key;
}

/** Uses the key once, for its own person; anything else is simply not found. */
export function useKey(db: Db, secret: Buffer, userId: string, key: string): { kind: 'approval' | 'ask' | 'friend'; ref: string } | undefined {
  const hash = keyedHash(secret, `app-key ${key}`);
  const row = db.prepare('SELECT user_id, kind, ref, expires_at, used_at FROM app_keys WHERE hash = ?').get(hash) as
    | { user_id: string; kind: 'approval' | 'ask' | 'friend'; ref: string; expires_at: number; used_at: number | null }
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
        lines: [{ label: 'Question', text: view.question }, ...tags(view.tags)],
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
        lines: [
          { label: 'Their question', text: view.question },
          { label: 'Your answer', text: view.answer },
        ],
        note: `Only ${view.from.name} reads it, and it goes to the AI they asked with.`,
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
export function questionCard(key: string, from: { name: string; handle: string }, question: string): Card {
  return {
    key,
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
input[type=text] { width: 100%; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; }
textarea { width: 100%; min-height: 76px; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; resize: vertical; }
.row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
button { font: inherit; font-size: 14px; font-weight: 500; border: 0; border-radius: 999px; padding: 7px 16px; background: var(--chip); color: var(--fg); cursor: pointer; }
button.primary { background: var(--accent); color: var(--ink); }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.done { font-weight: 600; }
</style></head>
<body><main id="card" aria-live="polite"><p class="note">Klatsch</p></main>
<script>${script}</script>
<script>
(() => {
  const { App } = globalThis.KlatschApps;
  const app = new App({ name: 'Klatsch card', version: '1' });
  const root = document.getElementById('card');
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const finish = (message) => {
    root.replaceChildren(el('p', 'Klatsch', 'brand'), el('p', message, 'done'));
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
    root.replaceChildren(el('p', 'Klatsch', 'brand'), el('h1', message), field, row, said);
    app.updateModelContext({ content: [{ type: 'text', text: 'Klatsch: your human made a friend link in the card and will send it themselves.' }] }).catch(() => {});
  };
  const render = (card) => {
    const parts = [el('p', 'Klatsch', 'brand'), el('h1', card.title)];
    const dl = el('dl');
    for (const line of card.lines) { dl.append(el('dt', line.label), el('dd', line.text)); }
    parts.push(dl);
    if (card.flags && card.flags.length) parts.push(el('p', 'Check before sending: it may contain ' + card.flags.join(', ') + '.', 'flags'));
    let box;
    if (card.answerBox) {
      const id = 'answer';
      const label = el('label', card.answerBox.label); label.htmlFor = id;
      box = el('textarea'); box.id = id; box.maxLength = card.answerBox.max; box.placeholder = card.answerBox.placeholder;
      parts.push(label, box);
    }
    parts.push(el('p', card.note, 'note'));
    const row = el('div', undefined, 'row');
    const buttons = card.actions.map((action) => {
      const b = el('button', action.label, action.primary ? 'primary' : '');
      b.type = 'button';
      b.addEventListener('click', async () => {
        const answer = box ? box.value.trim() : '';
        if (action.decision === 'answer' && !answer) { box.focus(); return; }
        buttons.forEach((x) => (x.disabled = true));
        try {
          const result = await app.callServerTool({ name: 'klatsch_card', arguments: { key: card.key, decision: action.decision, ...(action.decision === 'answer' ? { answer } : {}) } });
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
          finish(sc.message || 'Done.');
          // "Draft with my AI": the person's click asks the assistant to start, so it does not wait for a message.
          if (action.decision === 'draft') {
            app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Read the question I just sent you from my Klatsch inbox and draft an answer for me to approve.' }] }).catch(() => {});
          }
        } catch (error) {
          buttons.forEach((x) => (x.disabled = false));
          root.append(el('p', 'That did not work. Try again, or decide on your Klatsch page.', 'flags'));
        }
      });
      return b;
    });
    row.append(...buttons);
    parts.push(row);
    root.replaceChildren(...parts);
  };
  app.ontoolresult = (result) => {
    const card = result && result._meta && result._meta['${CARD_META}'];
    if (card) render(card);
    else root.replaceChildren(el('p', 'Klatsch', 'brand'), el('p', (result && result.structuredContent && result.structuredContent.note) || 'Nothing to decide here.', 'note'));
  };
  app.connect().catch(() => {});
})();
</script></body></html>`;
  return cached;
}
