// Voice notes in the Klatsch card inside a chat app, like a messenger. The card asks the host for the microphone
// (`permissions.microphone` on its resource). A host that grants it (the frame has `allow="microphone"` and says
// so in its capabilities): hold the button, talk, let go, and the note goes. A host that does not: the same button
// opens the conversation on the Klatsch page, which records. Chromium only for the recording (a fake microphone).
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { agent, startRelay, type Relay } from '../e2e/harness.ts';

/** A chat app's side of MCP Apps for one card; `mic` says whether it gives the card the microphone. */
const host = (mic: boolean) => `<!doctype html><html><body style="margin:0"><iframe id="card" sandbox="allow-scripts" ${mic ? 'allow="microphone"' : ''} style="width:100%;height:600px;border:0"></iframe>
<script>
  const frame = document.getElementById('card');
  window.links = [];
  window.addEventListener('message', async (event) => {
    if (event.source !== frame.contentWindow) return;
    const msg = event.data;
    const reply = (result) => frame.contentWindow.postMessage({ jsonrpc: '2.0', id: msg.id, result }, '*');
    if (msg.method === 'ui/initialize') {
      reply({ protocolVersion: msg.params.protocolVersion, hostInfo: { name: 'test-chat', version: '0' },
        hostCapabilities: { serverTools: {}, updateModelContext: { text: {} }, sandbox: { permissions: ${mic ? '{ microphone: {} }' : '{}'} } }, hostContext: { theme: 'light' } });
    } else if (msg.method === 'ui/notifications/initialized') {
      frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: window.toolResult }, '*');
    } else if (msg.method === 'tools/call') {
      reply(await window.klatschCall(msg.params));
    } else if (msg.method === 'ui/open-link') {
      window.links.push(msg.params.url);
      reply({});
    } else if (msg.id !== undefined) {
      reply({});
    }
  });
</script></body></html>`;

test.describe.serial('voice notes in the card', () => {
  let relay: Relay;
  let aliceChat: Awaited<ReturnType<typeof agent>>;
  let cardPage = '';
  let eve = '';

  test.beforeAll(async () => {
    relay = await startRelay();
    const alice = relay.klatsch.ensureUser('alice', 'Alice');
    eve = relay.klatsch.ensureUser('eve', 'Eve');
    relay.klatsch.addMember(relay.klatsch.friendCircle(alice), eve, alice);
    aliceChat = await agent(relay, relay.chatAppToken(alice), { dialogs: false, cards: true });
    const resource = (await aliceChat.readResource('ui://klatsch/card.html')).contents[0] as { text: string; _meta?: { ui?: { permissions?: unknown } } };
    expect(resource._meta?.ui?.permissions).toEqual({ microphone: {} });
    cardPage = resource.text;
  });
  test.afterAll(async () => {
    await aliceChat.close();
    await relay.close();
  });

  const openCard = async (page: Page, mic: boolean) => {
    const shown = await aliceChat.call('conversation', { handle: '@eve' });
    await page.exposeFunction('klatschCall', async (params: { name: string; arguments: Record<string, unknown> }) => JSON.parse((await aliceChat.call(params.name, params.arguments)).raw));
    await page.setContent(host(mic));
    await page.evaluate(`window.toolResult = ${JSON.stringify(JSON.parse(shown.raw))}; document.getElementById('card').srcdoc = ${JSON.stringify(cardPage)};`);
    return page.frameLocator('#card');
  };

  test('a chat app that gives no microphone: the button opens the conversation on the Klatsch page', async ({ page }) => {
    const card = await openCard(page, false);
    await card.getByRole('button', { name: 'Hold to record a voice note' }).click();
    await expect(card.getByText(/does not let Klatsch use the microphone/)).toBeVisible();
    expect(await page.evaluate<string[]>('window.links')).toEqual([`${relay.base}/ui/chat/eve`]);
  });

  test('a chat app that gives the microphone: hold, talk, let go, and the voice note goes', async ({ browserName }) => {
    test.skip(browserName !== 'chromium', 'Only Chromium has a fake microphone for tests.');
    // Playwright's own Chromium, also locally: the installed Chrome crashes on a sandboxed srcdoc frame (as chat-card.spec shows).
    const withMic: Browser = await chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    const context = await withMic.newContext({ permissions: ['microphone'] });
    const page = await context.newPage();
    const card = await openCard(page, true);
    const mic = card.getByRole('button', { name: 'Hold to record a voice note' });
    await expect(mic).toBeVisible();
    const box = (await mic.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(card.getByText(/Recording 0:0\d/)).toBeVisible();
    await page.waitForTimeout(1500);
    await page.mouse.up();
    await expect(card.getByText(/^Sent/)).toBeVisible();
    await expect(card.getByRole('list', { name: 'Messages' })).toContainText('Voice note');
    const last = relay.klatsch.conversation(eve, '@alice').messages.at(-1)!;
    expect(last.text).toBe('🎤 Voice note');
    expect(last.files[0]!.mime).toMatch(/^audio\//);
    expect(last.files[0]!.size).toBeGreaterThan(1000);
    await context.close();
    await withMic.close();
  });
});
