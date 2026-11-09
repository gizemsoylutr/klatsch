// Records the web half of the demo as docs/assets/demo.gif: the same circle as `klatsch up --demo` (Bob
// solved cursor paging and left his note open to the circle), on a relay of its own on a free port, with
// Alice's agent on the real MCP client. Alice reads the landing page, signs in, her agent asks to share what
// she is stuck on, she clicks Share on the approval page, and Bob's note is on her Home page at once.
//
//   npm run demo:record      (needs Playwright's Chromium or Google Chrome, and ffmpeg on PATH)
//
// The captions are CSS only (`body::after`): the pages run no script, and the recording adds none.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { agent, startRelay } from '../test/e2e/harness.ts';

const OUT = join(import.meta.dirname, '..', 'docs', 'assets', 'demo.gif');
const SIZE = { width: 1100, height: 720 };
const BOB = 'Cursor paging in a Node.js API on Postgres: use a keyset cursor on (created_at, id) and return next_cursor instead of OFFSET.';
const ALICE = 'OFFSET paging in my Node.js API on Postgres gets slow and skips rows.';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A caption bar at the bottom of the page, in CSS only; set again after every navigation. */
async function caption(page: Page, text: string) {
  const content = JSON.stringify(text);
  await page.addStyleTag({
    content: `body::after { content: ${content}; position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); max-width: 90%;
      padding: 10px 18px; border-radius: 10px; background: rgba(29,29,31,0.88); color: #FFFFFF; font: 500 16px/1.4 -apple-system, system-ui, sans-serif; }`,
  });
}

const relay = await startRelay({ approvalWaitMs: 60_000 });
const { klatsch } = relay;
const alice = klatsch.ensureUser('alice', 'Alice');
const bob = klatsch.ensureUser('bob', 'Bob');
klatsch.addMember(klatsch.ensureCircle('demo', alice), bob, alice);
klatsch.approveSip(bob, klatsch.draftSip(bob, { status: 'solved', tags: ['nodejs', 'postgres', 'pagination'], summary: BOB, visibility: 'open' }, 'cli').sipId, 'cli');

const videos = mkdtempSync(join(tmpdir(), 'klatsch-demo-'));
// Playwright's own Chromium when it is installed, else the local Google Chrome (as the UI tests do).
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const context = await browser.newContext({ viewport: SIZE, colorScheme: 'light', recordVideo: { dir: videos, size: SIZE } });
const page = await context.newPage();
try {
  await page.goto(`${relay.base}/`);
  await caption(page, 'Klatsch: your circle already knows.');
  await pause(3000);

  await page.goto(relay.loginLink(alice));
  await caption(page, 'Alice is stuck. She asks her coding agent to share it on Klatsch.');
  await pause(2500);

  // Her agent drafts the sip; the client opens the approval page in her browser, as Claude Code does.
  const aliceAgent = await agent(relay, relay.agentToken(alice), {
    onPage: async (url) => {
      await page.goto(url);
      await caption(page, 'Her agent can only ask. Alice sees exactly what would be shared, and decides.');
      await pause(4000);
      await page.getByRole('button', { name: 'Share' }).click();
      await page.waitForLoadState('load');
      await caption(page, 'Shared. Her agent learns the outcome, never anyone else’s words.');
      await pause(3000);
    },
  });
  await aliceAgent.call('update_card', { status: 'looking', tags: ['pagination', 'postgres', 'nodejs'], summary: ALICE });
  await aliceAgent.close();

  await page.goto(`${relay.base}/ui`);
  await page.getByRole('heading', { name: /^Notes from your circle/ }).scrollIntoViewIfNeeded();
  await caption(page, 'Bob solved it before and left his note open to the circle. Alice reads it at once.');
  await pause(4500);
} finally {
  await context.close();
  await browser.close();
  await relay.close();
}

const [video] = readdirSync(videos).filter((file) => file.endsWith('.webm'));
if (!video) throw new Error('Playwright recorded no video.');
mkdirSync(join(OUT, '..'), { recursive: true });
// Two passes through one filter graph: a palette from the whole clip, then the GIF with it. 12 fps, 900px wide.
execFileSync(
  'ffmpeg',
  ['-y', '-loglevel', 'error', '-i', join(videos, video), '-vf', 'fps=12,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', OUT],
  { stdio: 'inherit' },
);
rmSync(videos, { recursive: true, force: true });
console.log(`Wrote ${OUT}`);
