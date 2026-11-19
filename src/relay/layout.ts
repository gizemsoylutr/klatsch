import { legal, type Operator } from '../copy/legal.ts';
import { html, raw } from 'hono/html';
import { copy } from './copy.ts';

/**
 * Contrast (WCAG AA): --soft only on text of 22px and more; smaller grey text is --muted. White button text sits
 * on --button, which stays #0071E3 in dark mode too (#0A84FF would give 3.7:1); accent text on --accent-soft
 * uses --accent-text.
 *
 * The look of every web page: a white canvas, two-tone headings (the second half in a soft grey), pill
 * buttons, one blue accent, dark mode from the system setting. Inline stylesheets only, constants (the CSP
 * allows inline styles and nothing else), the system font stack, no web fonts, no scripts. Icons are inline
 * SVG, which needs no source. Never purple and never Inter: klatch.dev is another product and looks like that.
 */
const TOKENS = `
:root {
  color-scheme: light dark;
  --bg: #FFFFFF; --sunk: #F5F5F7; --fg: #1D1D1F; --soft: #86868B; --muted: #6E6E73; --line: #E8E8ED;
  --accent: #0071E3; --accent-soft: #E8F1FC; --accent-text: #0058B0; --button: #0071E3; --ink: #FFFFFF; --chip: #F0F0F5;
  --good: #1E7A34; --good-soft: #E8F6EC; --warn: #8A4B00; --warn-soft: #FFF4E5; --look: #FF9F0A;
  --bar: rgba(255,255,255,0.82);
  --sheet: 0 20px 50px -20px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.05);
  --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #000000; --sunk: #1C1C1E; --fg: #F5F5F7; --soft: #6E6E73; --muted: #A1A1A6; --line: #2C2C2E;
    --accent: #0A84FF; --accent-soft: #0A2A4A; --accent-text: #6CB4FF; --chip: #2C2C2E;
    --good: #30D158; --good-soft: #12301B; --warn: #FFB340; --warn-soft: #3A2A12;
    --bar: rgba(0,0,0,0.78);
    --sheet: 0 20px 50px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.1);
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--fg);
  font: 15px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
a:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
h1, h2, h3, p, ul, ol { margin: 0; }
h1 span, h2 span { color: var(--soft); }
.cup { width: 28px; height: 28px; border-radius: 8px; background: var(--accent); color: #FFFFFF; display: grid; place-items: center; flex-shrink: 0; }
.cup.lg { width: 52px; height: 52px; border-radius: 14px; padding: 0; min-height: 0; }
`;

const STYLE = `${TOKENS}
code, .cmd { font: 13px/1.6 var(--mono); }
.top { position: sticky; top: 0; z-index: 1; background: var(--bar); border-bottom: 1px solid var(--line);
  -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px); }
.top-in { max-width: 1080px; margin: 0 auto; min-height: 56px; padding: 8px 24px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; }
.mark { display: flex; align-items: center; gap: 9px; color: var(--fg); font-size: 16px; font-weight: 600; }
.mark:hover, .tabs a:hover { text-decoration: none; }
.tabs { display: flex; gap: 2px; }
.tabs a { padding: 6px 12px; border-radius: 8px; color: var(--muted); font-size: 14px; text-align: center; }
.tabs a:hover { color: var(--fg); }
.tabs a[aria-current="page"] { color: var(--fg); background: var(--chip); font-weight: 500; }
.me { margin-left: auto; display: flex; align-items: center; gap: 8px; font-size: 14px; min-width: 0; }
.me .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.avatar { width: 30px; height: 30px; border-radius: 999px; background: var(--chip); color: var(--fg); display: inline-grid; place-items: center;
  font-size: 13px; font-weight: 600; flex-shrink: 0; }
.avatar.blue { background: var(--accent); color: var(--ink); }
.avatar.lg { width: 44px; height: 44px; font-size: 18px; }

main.page { width: 100%; max-width: 980px; margin: 0 auto; padding: 40px 24px 64px; }
.ph { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 16px; }
.ph h1 { font: 700 34px/1.12 var(--display); letter-spacing: -0.025em; overflow-wrap: anywhere; }
.ph .end { margin-left: auto; }
.chips { list-style: none; padding: 0; margin-top: 14px; display: flex; flex-wrap: wrap; gap: 8px; }
.chips li { font-size: 13px; padding: 5px 12px; border-radius: 999px; background: var(--chip); color: var(--muted); }
.chips b { color: var(--fg); }
.chips .hot { background: var(--accent-soft); color: var(--accent-text); }
.chips .hot b { color: var(--accent-text); }
.sec { margin-top: 36px; min-width: 0; }
.sec > h2 { font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 10px; }
.sec > h2 em { font-style: normal; font-weight: 400; color: var(--muted); }
.sec > h2.big { font: 600 22px/1.2 var(--display); letter-spacing: -0.015em; color: var(--fg); margin-bottom: 0; }
.list { list-style: none; padding: 0; border-top: 1px solid var(--line); }
.list .list { border-top: none; padding-left: 28px; }
.list.plain { border-top: none; }
.item { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: flex-start; padding: 16px 0; border-bottom: 1px solid var(--line); }
.list .list .item { border-bottom: none; border-top: 1px solid var(--line); }
.main { flex: 999 1 260px; min-width: 0; display: grid; gap: 4px; overflow-wrap: anywhere; }
.t { font-weight: 600; }
.m { font-size: 13px; color: var(--muted); font-weight: 400; }
.acts { flex: 1 1 auto; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; }
.item form.answer { flex: 1 1 100%; display: grid; gap: 8px; margin-left: 50px; }
.item form.answer label { font-weight: 600; font-size: 14px; }
.item form.answer textarea { width: 100%; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; resize: vertical; }
.item form.answer button { justify-self: start; }
.item .files { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.item form.answer input[type=file] { font: inherit; font-size: 13px; }
.kind { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; flex-shrink: 0; font-size: 14px; font-weight: 600; }
.kind.ask { background: var(--accent-soft); color: var(--accent-text); }
.kind.draft { background: var(--warn-soft); color: var(--warn); }
.dot { width: 8px; height: 8px; margin-top: 7px; border-radius: 999px; background: var(--soft); flex-shrink: 0; }
.dot.looking { background: var(--look); }
.dot.solved, .dot.live { background: var(--good); }
.dot.want-to-discuss { background: var(--accent); }
.dot.tried { background: var(--warn); }
.pill { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px; background: var(--chip); color: var(--muted); }
.pill.open { background: var(--good-soft); color: var(--good); }
.pill.warn { background: var(--warn-soft); color: var(--warn); align-self: flex-start; }
.flag { padding: 6px 10px; border-radius: 8px; background: var(--warn-soft); color: var(--warn); font-size: 13px; text-align: left; justify-self: start; overflow-wrap: anywhere; }
.flag code { font-size: 12px; }
.offer { display: flex; flex-wrap: wrap; align-items: center; gap: 14px 20px; padding: 18px 20px; margin-bottom: 28px; border-radius: 14px; background: var(--sunk); }
.offer .main { flex: 1 1 280px; min-width: 0; }
.offer h2 { font: 600 17px/1.3 var(--display); }
.offer p { color: var(--muted); font-size: 14px; margin-top: 4px; }
.offer .acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.offer form { display: contents; }
.hint { font-size: 13px; color: var(--muted); margin-top: 10px; max-width: 72ch; }
.split { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 0 32px; }
.thread { list-style: none; padding: 0; margin: 0 0 16px; display: grid; gap: 10px; }
.msg { max-width: min(80%, 560px); background: var(--sunk); border-radius: 14px 14px 14px 4px; padding: 10px 14px; display: grid; gap: 4px; overflow-wrap: anywhere; justify-self: start; }
.msg.mine { justify-self: end; background: var(--chip); border-radius: 14px 14px 4px 14px; }
.msg p { white-space: pre-wrap; }
.msg .files a { font-size: 14px; }
.reply { display: grid; gap: 8px; margin-top: 8px; }
.reply textarea { min-height: 80px; width: 100%; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; resize: vertical; }
.reply input[type=file] { font: inherit; font-size: 13px; }
.reply .acts { display: flex; justify-content: flex-end; }
.conn { background: var(--sunk); border-radius: 14px; padding: 16px; display: grid; gap: 10px; overflow-wrap: anywhere; }
.conn + .conn { margin-top: 12px; }
.conn .who { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.conn .who .main { flex-basis: 140px; gap: 0; }
.group { border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
.row { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: center; padding: 14px 16px; }
.row + .row { border-top: 1px solid var(--line); }
.row .main { gap: 2px; }
.cmd { display: block; background: var(--sunk); border-radius: 10px; padding: 12px 14px; white-space: pre-wrap; overflow-wrap: anywhere; text-align: left; }
.cmd + .cmd, .hint + .cmd { margin-top: 10px; }
.seg { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: 9px; background: var(--chip); }
.seg a { padding: 5px 12px; border-radius: 7px; color: var(--muted); font-size: 13px; }
.seg a:hover { text-decoration: none; color: var(--fg); }
.seg a[aria-current="true"] { background: var(--bg); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,0.12); }

form { display: inline; margin: 0; }
button, a.button { font: inherit; font-size: 13px; font-weight: 500; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 32px; padding: 6px 14px; border-radius: 999px; border: none; background: var(--chip); color: var(--fg); cursor: pointer; text-align: center; }
a.button:hover { text-decoration: none; }
button.primary, a.button.primary { background: var(--button); color: var(--ink); }
button.link { background: transparent; color: var(--accent); padding: 4px 6px; min-height: 28px; border-radius: 6px; font-weight: 400; }
button.link:hover { text-decoration: underline; }
.lg, .sheet button, .sheet a.button { min-height: 44px; padding: 10px 22px; font-size: 15px; }
input[type="email"], input[name="code"], input[name="handle"] { font: inherit; width: 100%; min-height: 42px; padding: 8px 12px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--sunk); color: var(--fg); }
input[name="code"] { font: 600 22px var(--mono); letter-spacing: 0.15em; text-align: center; text-transform: uppercase; min-height: 52px; }
.field { display: flex; flex-wrap: wrap; gap: 8px; }
.field input { flex: 1 1 220px; width: auto; }

.switch { position: relative; width: 51px; height: 31px; min-height: 31px; padding: 0; border-radius: 999px; background: var(--chip); flex-shrink: 0; }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 27px; height: 27px; border-radius: 999px; background: #FFFFFF; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
.switch[aria-checked="true"] { background: var(--good); }
.switch[aria-checked="true"]::after { left: 22px; }

/* Thanks: the author's own count on Home, and the button that becomes a quiet "Thanked". */
.helped { display: flex; flex-wrap: wrap; gap: 10px 12px; align-items: center; margin-top: 18px; padding: 12px 16px; border-radius: 14px; background: var(--sunk); }
.helped .main { flex-basis: 200px; gap: 0; }
.helped .end { margin-left: auto; font-size: 13px; }
.heart { width: 34px; height: 34px; border-radius: 999px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-text); flex-shrink: 0; }
button.thanks { background: var(--accent-soft); color: var(--accent-text); }
.thanked { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 6px 14px; border-radius: 999px; font-size: 13px; color: var(--muted); box-shadow: 0 0 0 1px var(--line) inset; }
.sheet .thanked { justify-content: center; min-height: 44px; }
/* What the agent thanked for the person, each with an Undo. */
.agent-thanks { margin-top: 12px; padding: 10px 16px; border-radius: 14px; background: var(--sunk); font-size: 14px; }
.agent-thanks ul { list-style: none; margin: 0; padding: 0; }
.agent-thanks li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--fg); }
.agent-thanks li svg { color: var(--accent-text); }
.agent-thanks p { margin: 6px 0 0; font-size: 13px; }

.choice { border: none; margin: 0; padding: 0; min-width: 0; display: grid; gap: 8px; justify-items: start; text-align: left; }
.choice legend { padding: 0; margin-bottom: 8px; font-size: 13px; color: var(--muted); }
.choice .options { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: 9px; background: var(--chip); }
.choice label { display: block; position: relative; cursor: pointer; }
.choice label > span { display: block; padding: 6px 14px; border-radius: 7px; font-size: 13px; color: var(--muted); }
.choice input { position: absolute; inset: 0; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.choice .why label { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
.choice .why input { position: static; opacity: 1; width: auto; height: auto; margin: 3px 0 0; flex-shrink: 0; }
/* The radio sits right before its text: sibling selectors work in every browser, unlike :has(). */
.choice input:checked + span { background: var(--bg); color: var(--fg); font-weight: 500; box-shadow: 0 0 0 1px var(--line), 0 1px 2px rgba(0,0,0,0.12); }
.choice input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
.choice .why { font-size: 12px; color: var(--muted); margin: 0; }
/* Only where :has() works is the note of the other option hidden; elsewhere both notes show. */
.choice:has(input[value="open"]:checked) .why-ask, .choice:has(input[value="ask"]:checked) .why-open { display: none; }

/* Where an open note is readable: one checkbox per circle. */
.circles { border: none; margin: 0; padding: 0; min-width: 0; display: grid; gap: 6px; justify-items: start; text-align: left; }
.circles legend { padding: 0; margin-bottom: 6px; font-size: 13px; color: var(--muted); }
.circles label { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.circles input { width: 18px; height: 18px; margin: 0; accent-color: var(--button); flex-shrink: 0; }
.circles .why { font-size: 12px; color: var(--muted); margin: -2px 0 0 26px; }
/* For a solved sip, what ticking a public circle means follows the picked visibility, where :has() works. */
:is(form, .item):has(input[name="visibility"][value="open"]:checked) .circles .why-ask,
:is(form, .item):has(input[name="visibility"][value="ask"]:checked) .circles .why-open { display: none; }

/* A link card: the title, and the host on a line of its own, so a title cannot pass for another site. */
.src { text-align: left; display: grid; gap: 2px; padding: 12px 14px; border-radius: 12px; box-shadow: 0 0 0 1px var(--line) inset; overflow-wrap: anywhere; }
.src-k { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.src .url { font-size: 11px; color: var(--muted); margin-top: 4px; }
.srcline { font-size: 14px; }
.host { color: var(--fg); font-weight: 600; }

main.center { flex-grow: 1; display: grid; place-items: center; padding: 48px 16px; }
.sheet { width: min(420px, 100%); border-radius: 18px; box-shadow: var(--sheet); background: var(--bg); padding: 30px 28px 26px;
  display: grid; gap: 14px; text-align: center; overflow-wrap: anywhere; }
.sheet > .cup, .sheet > .ok, .sheet > .pair { justify-self: center; }
.sheet h1 { font: 600 22px/1.25 var(--display); letter-spacing: -0.01em; }
.sheet .sub { color: var(--muted); }
.sheet .quote { text-align: left; background: var(--sunk); border-radius: 12px; padding: 12px 14px; }
.sheet .quote .m { display: block; font-size: 12px; }
.sheet .fine { font-size: 12px; color: var(--muted); }
.sheet .flag { justify-self: stretch; }
.sheet ul.sub { text-align: left; margin: 0; padding-left: 20px; display: grid; gap: 6px; }
.sheet form { display: grid; gap: 10px; }
.mailapps { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.sheet .mailapps a.button { min-height: 36px; padding: 6px 14px; font-size: 13px; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; list-style: none; padding: 0; }
.tags li { font-size: 12px; padding: 2px 9px; border-radius: 999px; background: var(--chip); color: var(--muted); }
.two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.two button { width: 100%; }
.pair { display: flex; }
.pair .avatar + .avatar { margin-left: -8px; box-shadow: 0 0 0 3px var(--bg); }
.ok { width: 52px; height: 52px; border-radius: 999px; background: var(--good-soft); color: var(--good); display: grid; place-items: center; font-size: 26px; }
.ok.muted { background: var(--chip); color: var(--muted); }

/* One centred block, not two halves of the screen: the words on the left, the way in on a card beside them. */
main.signin { flex-grow: 1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 440px); gap: 72px; align-items: center; width: 100%; max-width: 1080px; margin: 0 auto; padding: 56px 24px; }
.signin .left { display: grid; justify-items: start; gap: 16px; }
.signin .left .wordmark { font: 700 22px/1.2 var(--display); letter-spacing: -0.02em; margin-top: 12px; }
.signin .left h1 { font: 700 38px/1.08 var(--display); letter-spacing: -0.03em; max-width: 13ch; }
.signin .left p { color: var(--muted); max-width: 38ch; }
.signin .right { background: var(--sunk); border-radius: 20px; padding: 36px 32px; display: grid; justify-items: start; gap: 14px; }
.signin .right h2 { font: 600 24px/1.2 var(--display); }
.signin .right p { font-size: 13px; color: var(--muted); }
.signin .right .lead { font-size: 15px; color: var(--fg); }
a.gh { width: 100%; min-height: 46px; background: var(--fg); color: var(--bg); font-size: 15px; }
.signin .right form { width: 100%; display: grid; gap: 10px; }
.signin .right form button { min-height: 46px; font-size: 15px; }
.or { width: 100%; display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12px; }
.or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--line); }
[hidden] { display: none !important; }
.passkey { width: 100%; display: grid; gap: 14px; }
.passkey button { width: 100%; min-height: 46px; font-size: 15px; }

@media (max-width: 600px) {
  .item form.answer { margin-left: 0; }
  .top-in { padding: 8px 16px; }
  .tabs { order: 3; width: 100%; }
  .tabs a { flex: 1; padding: 6px 4px; }
  .me .name { display: none; }
  main.page { padding: 28px 16px 56px; }
  .ph h1 { font-size: 28px; }
  .ph .end { margin-left: 0; }
  .split, main.signin { grid-template-columns: minmax(0, 1fr); }
  .acts { justify-content: flex-start; }
  .sheet { padding: 26px 20px 22px; }
  main.signin { gap: 28px; padding: 32px 16px 48px; align-items: start; align-content: start; }
  .signin .left .cup { display: none; }
  .signin .right { padding: 28px 20px; }
  .signin .left h1 { font-size: 32px; }
}
`;

/** The landing page's own rules on the same tokens: a wider column, product windows, bands. */
const LANDING_STYLE = `${TOKENS}
:root { --band: #F5F5F7; --win: #FFFFFF; --win-bar: #ECECEF; --term: #1D1D1F; --term-fg: #E8E8ED; --term-dim: #8E8E93; --term-ok: #63D17A; --term-acc: #64B5FF;
  --shadow: 0 30px 60px -20px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.06); }
@media (prefers-color-scheme: dark) {
  :root { --band: #111113; --win: #1C1C1E; --win-bar: #2C2C2E; --term: #0B0B0C; --shadow: 0 30px 60px -20px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.08); }
}
body { font-size: 16px; }
a.btn:hover, .nav a:hover, footer a:hover { text-decoration: none; }
.wrap { width: 100%; max-width: 1080px; margin: 0 auto; padding-left: max(20px, env(safe-area-inset-left, 0px)); padding-right: max(20px, env(safe-area-inset-right, 0px)); }
.nav { position: sticky; top: 0; z-index: 5; background: var(--bar); border-bottom: 1px solid var(--line);
  -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px); }
.nav .wrap { display: flex; align-items: center; gap: 22px; height: 56px; }
.mark { display: flex; align-items: center; gap: 9px; font-weight: 600; font-size: 17px; color: var(--fg); }
.links { display: flex; gap: 20px; margin-left: auto; font-size: 14px; }
.links a { color: var(--muted); }
.links a:hover { color: var(--fg); }
.btn { display: inline-flex; align-items: center; height: 36px; padding: 0 16px; border-radius: 999px; font-size: 14px; font-weight: 500; white-space: nowrap; }
.btn.primary { background: var(--button); color: var(--ink); }
.btn.quiet { background: var(--chip); color: var(--fg); }
.btn.lg { height: 46px; padding: 0 24px; font-size: 16px; }
.hero { padding-top: 88px; text-align: center; }
.wordmark { font: 700 28px/1.1 var(--display); letter-spacing: -0.02em; margin-bottom: 14px; }
.eyebrow { display: inline-flex; flex-wrap: wrap; justify-content: center; gap: 4px 8px; font-size: 13px; color: var(--muted); background: var(--chip); padding: 5px 12px; border-radius: 999px; }
.eyebrow b { color: var(--fg); font-weight: 600; }
h1 { font: 700 clamp(40px, 7vw, 72px)/1.04 var(--display); letter-spacing: -0.035em; margin: 22px auto 0; max-width: 15ch; text-wrap: balance; }
.lead { font-size: clamp(17px, 2.2vw, 20px); color: var(--muted); max-width: 40ch; margin: 22px auto 0; text-wrap: balance; }
.ctas { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 32px; }
.hero .cmd { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 6px 10px; font-size: 14px; color: var(--muted); margin-top: 18px; }
.hero .cmd code { font: 14px var(--mono); color: var(--fg); background: var(--chip); padding: 4px 10px; border-radius: 8px; }
figure { margin: 56px 0 0; text-align: left; }
figcaption { font-size: 12px; color: var(--muted); text-align: center; margin-bottom: 14px; }
.stage { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 24px; align-items: start; }
.win { background: var(--win); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; min-width: 0; }
.bar { height: 34px; background: var(--win-bar); display: flex; align-items: center; gap: 7px; padding: 0 13px; position: relative; }
.bar i { width: 11px; height: 11px; border-radius: 50%; display: block; }
.bar i:nth-child(1) { background: #FF5F57; } .bar i:nth-child(2) { background: #FEBC2E; } .bar i:nth-child(3) { background: #28C840; }
.bar span { position: absolute; inset: 0; display: grid; place-items: center; font-size: 12px; color: var(--muted); }
.term { background: var(--term); color: var(--term-fg); font: 13px/1.65 var(--mono); padding: 18px 20px 22px; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
.term .d { color: var(--term-dim); } .term .ok { color: var(--term-ok); } .term .a { color: var(--term-acc); } .term b { font-weight: 700; }
.shot { padding: 26px 24px 24px; display: grid; gap: 14px; }
.shot .k, .small { font-size: 12px; color: var(--muted); margin: 0; }
.shot h3 { font: 600 20px/1.25 var(--display); margin: 0; letter-spacing: -0.01em; }
.quote { background: var(--band); border-radius: 10px; padding: 12px 14px; font-size: 14px; }
.tags { display: flex; gap: 6px; flex-wrap: wrap; list-style: none; padding: 0; margin: 0; }
.tags li { font-size: 12px; background: var(--chip); color: var(--muted); padding: 2px 9px; border-radius: 999px; }
.row2 { display: flex; gap: 10px; flex-wrap: wrap; }
.row2 .btn { height: 34px; }
section.block { padding-top: 96px; }
.kicker { font-size: 14px; font-weight: 600; color: var(--accent); }
h2 { font: 700 clamp(30px, 4.4vw, 44px)/1.1 var(--display); letter-spacing: -0.025em; margin: 8px 0 0; max-width: 20ch; text-wrap: balance; }
.sub { color: var(--muted); font-size: 18px; max-width: 52ch; margin: 14px 0 0; }
.steps { list-style: none; padding: 0; display: grid; gap: 72px; margin: 56px 0 0; }
.step { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); gap: 48px; align-items: center; }
.step:nth-child(even) .copy { order: 2; }
.num { font: 600 13px var(--mono); color: var(--accent); }
.step h3 { font: 600 26px/1.2 var(--display); letter-spacing: -0.015em; margin: 8px 0 10px; }
.step p { color: var(--muted); margin: 0; max-width: 42ch; }
.card { padding: 18px 20px; display: grid; gap: 12px; }
.person { display: flex; gap: 12px; align-items: center; }
.av { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font-weight: 600; font-size: 14px; background: var(--chip); flex-shrink: 0; }
.person .who { display: grid; min-width: 0; } .person .who small { color: var(--muted); font-size: 12px; }
.state { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--good); }
.state.quiet { color: var(--muted); }
.band { background: var(--band); margin-top: 110px; padding: 88px 0; }
.grid3 { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin: 40px 0 0; }
.tile { background: var(--win); border-radius: 14px; padding: 22px; display: grid; gap: 8px; align-content: start; }
.band .tile { background: var(--bg); }
section.block .tile { background: var(--sunk); }
.tile h3 { margin: 0; font-size: 17px; }
.tile p { margin: 0; color: var(--muted); font-size: 15px; }
.tile .st { font-size: 12px; font-weight: 600; color: var(--good); }
.tile .st.part { color: var(--muted); }
.final { text-align: center; padding: 110px 0; }
.final h2, .final .sub { margin-left: auto; margin-right: auto; }
.legal { max-width: 680px; padding-top: 40px; padding-bottom: 64px; text-align: left; }
.legal h1 { margin: 0; font-size: 40px; text-align: left; max-width: none; }
.legal h2 { margin: 32px 0 8px; font-size: 20px; }
.legal p, .legal li { line-height: 1.6; margin: 0 0 10px; color: var(--fg); }
.legal ul { padding-left: 20px; margin: 0 0 10px; }
.legal .updated { color: var(--muted); font-size: 13px; }
footer { border-top: 1px solid var(--line); padding: 26px 0 40px; font-size: 13px; color: var(--muted); }
footer .wrap { display: flex; gap: 18px; flex-wrap: wrap; }
footer a { color: var(--muted); }
footer a:hover { color: var(--fg); }
footer .sp { margin-left: auto; }
@media (max-width: 820px) {
  .links { display: none; }
  .nav .btn { margin-left: auto; }
  .stage, .step, .grid3 { grid-template-columns: minmax(0, 1fr); }
  .step:nth-child(even) .copy { order: 0; }
  .hero { padding-top: 56px; }
  section.block { padding-top: 72px; }
  .steps { gap: 56px; }
  footer .sp { margin-left: 0; }
}
`;

const CUP = (size: number) =>
  html`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g transform="translate(0 -2)"><path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"></path><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"></path></g></svg>`;

const GITHUB_MARK = html`<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>`;

/** A small heart next to "Thanks" and in the count on Home; decorative, the words carry the meaning. */
export const heart = (size = 14) =>
  html`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.1C.9 8.6 2.8 4.5 6.7 4.5c2.2 0 3.9 1.2 5.3 3 1.4-1.8 3.1-3 5.3-3 3.9 0 5.8 4.1 4.3 7.4C19.5 16.4 12 21 12 21z"></path></svg>`;

/** The cup on top of a sheet. */
export const icon = () => html`<span class="cup lg" aria-hidden="true">${CUP(28)}</span>`;

/** The mark on top of a result: a tick for good news, a dash for anything else. */
export const outcome = (good: boolean) => html`<span class="ok${good ? '' : ' muted'}" aria-hidden="true">${good ? '✓' : '–'}</span>`;

/** A round initial for a person; `blue` once names are exchanged. */
export const avatar = (name: string, { blue = false, large = false } = {}) =>
  html`<span class="avatar${blue ? ' blue' : ''}${large ? ' lg' : ''}" aria-hidden="true">${[...name.trim()][0]?.toUpperCase() ?? '?'}</span>`;

/** Two people side by side on a sheet: "?" for someone not known yet. */
export const pair = (left: string, right: string, { leftBlue = false, rightBlue = true } = {}) =>
  html`<span class="pair" aria-hidden="true">${avatar(left, { blue: leftBlue, large: true })}${avatar(right, { blue: rightBlue, large: true })}</span>`;

/** Tags as chips. */
export const tagList = (tags: string[]) => html`<ul class="tags">${tags.map((tag) => html`<li>${tag}</li>`)}</ul>`;

/** Who is signed in: their name for the top bar, and the form token for its Sign out button. */
export interface Viewer {
  name: string;
  csrf: string;
}

export type Tab = 'home' | 'notes' | 'circle' | 'tokens' | 'settings';

/** The tab icon: the brand's white cup on its blue tile, inline so it costs no request or route. */
const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0071E3"/>' +
      '<g transform="translate(4 3)" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/></g></svg>',
  );

/** `title` is often the page's heading; the tab drops its closing full stop. */
function document(title: string, style: string, header: unknown, main: unknown, footer: unknown = '') {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>${title.replace(/\.$/, '')} · ${copy.layout.brand}</title>
        <link rel="icon" type="image/svg+xml" href="${FAVICON}" />
        <link rel="manifest" href="/ui/manifest.webmanifest" />
        <meta name="theme-color" content="#0071e3" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Klatsch" />
        <style>${raw(style)}</style>
      </head>
      <body>
        ${header}${main}${footer}
      </body>
    </html>`;
}

const brand = (href: string) => html`<a class="mark" href="${href}"><span class="cup" aria-hidden="true">${CUP(16)}</span><span>${copy.layout.brand}</span></a>`;

/** A page in the main column, under the top bar with the Home / Circle / Tokens / Settings tabs and Sign out. */
export function screen(title: string, viewer: Viewer, tab: Tab, body: unknown) {
  const nav = copy.layout.nav;
  const link = (href: string, name: Tab, label: string) => html`<a href="${href}"${tab === name ? html` aria-current="page"` : ''}>${label}</a>`;
  const header = html`<header class="top">
    <div class="top-in">
      ${brand('/ui')}
      <nav class="tabs" aria-label="${nav.label}">${link('/ui', 'home', nav.home)}${link('/ui/notes', 'notes', nav.notes)}${link('/ui/circle', 'circle', nav.circle)}${link('/ui/tokens', 'tokens', nav.tokens)}${link('/ui/settings', 'settings', nav.settings)}</nav>
      <div class="me">${avatar(viewer.name)}<span class="name">${viewer.name}</span>${button('/ui/logout', copy.dashboard.signOut, viewer.csrf, 'link')}</div>
    </div>
  </header>`;
  return document(title, STYLE, header, html`<main class="page">${body}</main>`);
}

/** A centred sheet: approvals, codes, intros, results and errors. Without a viewer, no name in the bar. */
export function dialog(title: string, viewer: Viewer | undefined, body: unknown) {
  const header = html`<header class="top">
    <div class="top-in">${brand('/ui')}${viewer ? html`<div class="me">${avatar(viewer.name)}<span class="name">${viewer.name}</span></div>` : ''}</div>
  </header>`;
  // A page, not a modal: a labelled section, so assistive tech does not announce a dialog.
  return document(title, STYLE, header, html`<main class="center"><section class="sheet" aria-labelledby="title">${body}</section></main>`);
}

/** A visitor without a session: what Klatsch is on the left, how to get in on the right. */
export function signInScreen(title: string, body: unknown) {
  const t = copy.signIn;
  return document(
    title,
    STYLE,
    html`<header class="top"><div class="top-in">${brand('/')}</div></header>`,
    html`<main class="signin">
      <div class="left">${icon()}<p class="wordmark">${copy.landing.name}</p><h1>${t.headline[0]} <span>${t.headline[1]}</span></h1><p>${t.tagline}</p></div>
      <section class="right" aria-labelledby="title"><h2 id="title">${title}</h2>${body}</section>
    </main>`,
  );
}

const GOOGLE_MARK = html`<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.7 1.2 9.2 3.6l6.9-6.9C35.9 2.4 30.5 0 24 0 14.6 0 6.5 5.4 2.6 13.2l8 6.2C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 2.9-2.2 5.4-4.7 7l7.3 5.7c4.3-4 7.2-9.9 7.2-17.2z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-8-6.2C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l8-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8L32.6 36.500c-2.100 1.400-4.800 2.300-8 2.300-6.200 0-11.500-4.100-13.400-9.800l-8 6.200C6.500 42.600 14.600 48 24 48z"/></svg>`;

/** The privacy notice or the terms, on the landing page's look, so they read the same signed out. */
export function legalPage(page: 'privacy' | 'terms', operator: Operator) {
  const t = copy.landing;
  const title = page === 'privacy' ? legal.privacyTitle : legal.termsTitle;
  return document(
    title,
    LANDING_STYLE,
    html`<header class="nav"><div class="wrap">${brand('/')}<a class="btn primary" href="/ui">${t.signIn}</a></div></header>`,
    html`<main class="wrap legal"><h1>${title}</h1><p class="updated">${legal.updated}</p>${page === 'privacy' ? legal.privacy(operator) : legal.terms(operator)}</main>`,
    html`<footer><div class="wrap"><span>${t.footer.line}</span><a class="sp" href="/privacy">${legal.footerPrivacy}</a><a href="/terms">${legal.footerTerms}</a></div></footer>`,
  );
}

/** "Sign in with Google", beside GitHub's on the sign-in page. */
export const googleLink = (href: string, label: string) => html`<a class="button gh" href="${href}">${GOOGLE_MARK}<span>${label}</span></a>`;

/** "Sign in with GitHub", as the dark pill of the sign-in page. */
export const githubLink = (href: string, label: string) => html`<a class="button gh" href="${href}">${GITHUB_MARK}<span>${label}</span></a>`;

/** A form with one button; `kind` picks the style (secondary when omitted). */
export function button(action: string, label: string, csrf: string, kind?: 'primary' | 'link') {
  return html`<form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}" /><button${kind ? html` class="${kind}"` : ''}>${label}</button></form>`;
}

/**
 * The bare relay address for a visitor: what Klatsch is. The terminal and the approval page in the hero
 * are an illustration (captioned as an example, with made-up data), not a live view of anything.
 * `github`: GitHub is the only way in, so the buttons say "Sign in with GitHub".
 */
export function landing(github: boolean, hasLegal = false, mcpUrl = '') {
  const t = copy.landing;
  const signIn = github ? t.signInGitHub : t.signIn;
  const dots = html`<i></i><i></i><i></i>`;
  const win = (title: string, body: unknown) => html`<div class="win"><div class="bar">${dots}<span>${title}</span></div>${body}</div>`;
  const steps = t.how.steps.map(
    (step, index) => html`<li class="step">
      <div class="copy"><span class="num">${String(index + 1).padStart(2, '0')}</span><h3>${step.title}</h3><p>${step.line}</p></div>
      ${win(step.window, html`<div class="card" aria-hidden="true">${step.example}</div>`)}
    </li>`,
  );
  const tiles = (list: readonly { title: string; line: string; state?: string; part?: boolean }[]) =>
    html`<ul class="grid3">${list.map(
      (tile) => html`<li class="tile">${tile.state ? html`<span class="st${tile.part ? ' part' : ''}">${tile.state}</span>` : ''}<h3>${tile.title}</h3><p>${tile.line}</p></li>`,
    )}</ul>`;
  return document(
    t.title,
    LANDING_STYLE,
    html`<header class="nav"><div class="wrap">
      ${brand('#top')}
      <nav class="links" aria-label="${t.nav.label}"><a href="#how">${t.nav.how}</a><a href="#safe">${t.nav.privacy}</a><a href="#tools">${t.nav.tools}</a><a href="#self">${t.nav.selfHost}</a></nav>
      <a class="btn primary" href="/ui">${signIn}</a>
    </div></header>`,
    html`<main id="top">
      <section class="hero wrap">
        <p class="wordmark">${t.name}</p>
        <p class="eyebrow"><b>${t.eyebrow[0]}</b> ${t.eyebrow[1]}</p>
        <h1>${t.headline[0]} <span>${t.headline[1]}</span></h1>
        <p class="lead">${t.lead}</p>
        <div class="ctas"><a class="btn primary lg" href="/ui">${signIn}</a><a class="btn quiet lg" href="#how">${t.howLink}</a></div>
        ${mcpUrl ? html`<p class="cmd"><code>${t.connector(mcpUrl)[0]}</code><span>${t.connector(mcpUrl)[1]}</span></p>` : ''}
        <p class="cmd"><code>${t.demo[0]}</code><span>${t.demo[1]}</span></p>
        <figure>
          <figcaption>${t.example.caption}</figcaption>
          <div class="stage" aria-hidden="true">
            ${win(t.example.terminalTitle, html`<pre class="term">${t.example.terminal}</pre>`)}
            ${win(
              t.example.pageTitle,
              html`<div class="shot">
                <span class="k">${t.example.pageKicker}</span>
                <h3>${t.example.summary}</h3>
                ${tagList([...t.example.tags])}
                <div class="quote">${t.example.pageNote}</div>
                <div class="row2"><span class="btn primary">${t.example.share}</span><span class="btn quiet">${t.example.notNow}</span></div>
                <p class="small">${t.example.circle}</p>
              </div>`,
            )}
          </div>
        </figure>
      </section>

      <section class="block wrap" id="how" aria-labelledby="how-title">
        <span class="kicker">${t.how.kicker}</span>
        <h2 id="how-title">${t.how.heading[0]} <span>${t.how.heading[1]}</span></h2>
        <p class="sub">${t.how.sub}</p>
        <ol class="steps">${steps}</ol>
      </section>

      <section class="band" id="safe" aria-labelledby="safe-title"><div class="wrap">
        <span class="kicker">${t.privacy.kicker}</span>
        <h2 id="safe-title">${t.privacy.heading[0]} <span>${t.privacy.heading[1]}</span></h2>
        ${tiles(t.privacy.tiles)}
      </div></section>

      <section class="block wrap" id="tools" aria-labelledby="tools-title">
        <span class="kicker">${t.tools.kicker}</span>
        <h2 id="tools-title">${t.tools.heading}</h2>
        ${tiles(t.tools.tiles)}
      </section>

      <section class="final wrap" id="self" aria-labelledby="self-title">
        <h2 id="self-title">${t.selfHost.heading[0]} <span>${t.selfHost.heading[1]}</span></h2>
        <p class="sub">${t.selfHost.sub}</p>
        <div class="ctas"><a class="btn primary lg" href="/ui">${signIn}</a><a class="btn quiet lg" href="${t.links.selfHosting}">${t.selfHost.guide}</a></div>
      </section>
    </main>`,
    html`<footer><div class="wrap"><span>${t.footer.line}</span><a class="sp" href="${t.links.github}">${t.footer.github}</a><a href="${t.links.security}">${t.footer.security}</a><a href="${t.links.docs}">${t.footer.docs}</a>${hasLegal ? html`<a href="/privacy">${legal.footerPrivacy}</a><a href="/terms">${legal.footerTerms}</a>` : ''}</div></footer>`,
  );
}
