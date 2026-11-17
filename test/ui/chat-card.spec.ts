// The Klatsch card in a real browser, inside a stand-in for a chat app (a page that speaks the MCP Apps host side
// of the protocol and forwards the card's tool calls to the relay): Alice approves her question in the card, Eve
// answers in hers, and the card shows what happened. No console errors, nothing rendered as HTML from the data.
import { expect, test, type Page } from '@playwright/test';
import { agent, startRelay, type Relay } from '../e2e/harness.ts';
import { person } from './people.ts';

const QUESTION = 'Which bakery near the station did you like? <b>not bold</b>';

/** A chat app's side of MCP Apps, just enough for one card: initialize, the tool result, tools/call, model context. */
const HOST = `<!doctype html><html><body style="margin:0"><iframe id="card" sandbox="allow-scripts" style="width:100%;height:600px;border:0"></iframe>
<script>
  const frame = document.getElementById('card');
  window.modelContext = [];
  window.addEventListener('message', async (event) => {
    if (event.source !== frame.contentWindow) return;
    const msg = event.data;
    const reply = (result) => frame.contentWindow.postMessage({ jsonrpc: '2.0', id: msg.id, result }, '*');
    if (msg.method === 'ui/initialize') {
      reply({ protocolVersion: msg.params.protocolVersion, hostInfo: { name: 'test-chat', version: '0' }, hostCapabilities: { serverTools: {}, updateModelContext: { text: {} } }, hostContext: { theme: 'light' } });
    } else if (msg.method === 'ui/notifications/initialized') {
      frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: window.toolResult }, '*');
    } else if (msg.method === 'tools/call') {
      reply(await window.klatschCall(msg.params));
    } else if (msg.method === 'ui/open-link') {
      window.links = (window.links || []).concat([msg.params.url]);
      reply({});
    } else if (msg.method === 'ui/message') {
      window.messages = (window.messages || []).concat([msg.params]);
      reply({});
    } else if (msg.method === 'ui/update-model-context') {
      window.modelContext.push(msg.params);
      reply({});
    } else if (msg.id !== undefined) {
      reply({});
    }
  });
</script></body></html>`;

test.describe.serial('the Klatsch card in a chat app', () => {
  let relay: Relay;
  let aliceChat: Awaited<ReturnType<typeof agent>>, eveChat: Awaited<ReturnType<typeof agent>>;
  let cardPage = '';
  let aliceId = '', eveId = '';

  test.beforeAll(async () => {
    relay = await startRelay();
    const alice = (aliceId = relay.klatsch.ensureUser('alice', 'Alice'));
    const eve = (eveId = relay.klatsch.ensureUser('eve', 'Eve'));
    relay.klatsch.addMember(relay.klatsch.ensureCircle('pair', alice), eve, alice);
    aliceChat = await agent(relay, relay.chatAppToken(alice), { dialogs: false, cards: true });
    eveChat = await agent(relay, relay.chatAppToken(eve), { dialogs: false, cards: true });
    cardPage = ((await aliceChat.readResource('ui://klatsch/card.html')).contents[0] as { text: string }).text;
  });
  test.afterAll(async () => {
    await Promise.all([aliceChat.close(), eveChat.close()]);
    await relay.close();
  });

  /** Opens the card for a tool result in the stand-in chat app; the card's tool calls go to `chat`. */
  const openCard = async (page: Page, chat: typeof aliceChat, result: unknown) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    await page.exposeFunction('klatschCall', async (params: { name: string; arguments: Record<string, unknown> }) => JSON.parse((await chat.call(params.name, params.arguments)).raw));
    await page.setContent(HOST);
    await page.evaluate(`window.toolResult = ${JSON.stringify(result)}; document.getElementById('card').srcdoc = ${JSON.stringify(cardPage)};`);
    return { card: page.frameLocator('#card'), errors };
  };

  test('Alice approves her question in the card; the card says it was asked and tells the model', async ({ page }) => {
    const asked = await aliceChat.call('ask_person', { handle: '@eve', question: QUESTION });
    const { card, errors } = await openCard(page, aliceChat, JSON.parse(asked.raw));
    await expect(card.getByRole('heading', { name: 'Ask Eve (@eve)?' })).toBeVisible();
    await expect(card.getByLabel('Question (you can change it)')).toHaveValue(QUESTION);
    await expect(card.locator('b')).toHaveCount(0);
    await page.screenshot({ path: 'test/ui/screenshots/chat-card-ask.png' });
    await card.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(card.getByText('Asked. Only they read it; their answer comes back here.')).toBeVisible();
    // The chat cannot say when the answer comes: the card offers notifications, on Klatsch's Settings page.
    await card.getByRole('button', { name: 'Turn on notifications' }).click();
    await expect.poll(() => page.evaluate<string>('(window.links || []).join()')).toMatch(/\/ui\/settings#notifications$/);
    expect(await page.evaluate<number>('window.modelContext.length')).toBe(1);
    expect(errors).toEqual([]);
  });

  test('Eve answers in her card; her model never saw the question', async ({ page }) => {
    const ask = ((await eveChat.call('inbox')).data.events as { kind: string; ref: string }[]).find((e) => e.kind === 'ask.received')!;
    const shown = await eveChat.call('show_question', { ask_id: ask.ref });
    expect(shown.text).not.toContain('bakery');
    const { card, errors } = await openCard(page, eveChat, JSON.parse(shown.raw));
    await expect(card.getByText(QUESTION)).toBeVisible();
    await card.getByLabel('Your answer').fill('The small one on the corner.');
    await page.screenshot({ path: 'test/ui/screenshots/chat-card-answer.png' });
    await card.getByRole('button', { name: 'Send answer' }).click();
    await expect(card.getByText('Answer sent. Only they read it.')).toBeVisible();
    const quote = ((await aliceChat.call('inbox')).data.events as { type?: string; quote?: string }[]).find((e) => e.type === 'quote')!;
    expect(quote.quote).toBe('The small one on the corner.');
    expect(errors).toEqual([]);
    // Alice's Klatsch page shows the same answer, already sent to her AI.
    const alice = await person(page.context().browser()!, relay, 'Alice', import.meta.filename, relay.loginLink(aliceId));
    await alice.open(`${relay.base}/ui`);
    await expect(alice.page.getByText('The small one on the corner.')).toBeVisible();
    await expect(alice.page.getByText('Sent to your AI')).toBeVisible();
    await alice.expectCleanBrowser();
    await alice.context.close();
  });

  test('when the answer cannot go (Alice withdrew it), the card says so and keeps its buttons', async ({ page }) => {
    const asked = await aliceChat.call('ask_person', { handle: '@eve', question: 'Withdrawn before Eve answers?' });
    await aliceChat.call('klatsch_card', { key: asked.meta['dev.klatsch/card'].key, decision: 'approved' });
    const ask = relay.klatsch.asksOf(eveId).find((k) => k.question === 'Withdrawn before Eve answers?')!;
    const shown = await eveChat.call('show_question', { ask_id: ask.id });
    const { card, errors } = await openCard(page, eveChat, JSON.parse(shown.raw));
    await expect(card.getByLabel('Your answer')).toBeVisible();
    // Alice withdraws it while Eve's card is open.
    relay.klatsch.withdrawAsk(aliceId, ask.id);
    await card.getByLabel('Your answer').fill('Too late.');
    await card.getByRole('button', { name: 'Send answer' }).click();
    await expect(card.getByText('This question is not waiting for your human.')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Send answer' })).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test('Alice makes a friend link in the card and copies it', async ({ page }) => {
    const shown = await aliceChat.call('add_friend');
    const { card, errors } = await openCard(page, aliceChat, JSON.parse(shown.raw));
    await expect(card.getByRole('heading', { name: 'Add a friend' })).toBeVisible();
    await card.getByRole('button', { name: 'Make a link' }).click();
    await expect(card.getByRole('heading', { name: 'Your friend link' })).toBeVisible();
    const link = await card.locator('#link').inputValue();
    expect(link).toMatch(new RegExp(`^${relay.base}/ui/invite/[\\w-]+$`));
    await card.getByRole('button', { name: 'Copy link' }).click();
    await expect(card.getByText(/Copied|Selected/)).toBeVisible();
    await page.screenshot({ path: 'test/ui/screenshots/chat-card-friend.png' });
    const context = await page.evaluate<string>('JSON.stringify(window.modelContext)');
    expect(context).not.toContain('/ui/invite/');
    expect(errors).toEqual([]);
  });

  test('"Draft with my AI" sends the question to Eve’s AI and asks it to start, so nobody has to type', async ({ page }) => {
    const asked = await aliceChat.call('ask_person', { handle: '@eve', question: 'Draft this one?' });
    await aliceChat.call('klatsch_card', { key: asked.meta['dev.klatsch/card'].key, decision: 'approved' });
    const ask = relay.klatsch.asksOf(eveId).find((k) => k.question === 'Draft this one?')!;
    const shown = await eveChat.call('show_question', { ask_id: ask.id });
    const { card, errors } = await openCard(page, eveChat, JSON.parse(shown.raw));
    await card.getByRole('button', { name: 'Draft with my AI' }).click();
    await expect(card.getByText(/Sent to your AI/)).toBeVisible();
    await expect.poll(() => page.evaluate<number>('(window.messages || []).length')).toBe(1);
    const quote = ((await eveChat.call('inbox')).data.events as { type?: string; quote?: string }[]).find((e) => e.type === 'quote')!;
    expect(quote.quote).toBe('Draft this one?');
    expect(errors).toEqual([]);
  });

  test('a card the chat shows again, after it was decided, shows what came of it and no buttons', async ({ page }) => {
    const asked = await aliceChat.call('ask_person', { handle: '@eve', question: 'Reloaded later?' });
    await aliceChat.call('klatsch_card', { key: asked.meta['dev.klatsch/card'].key, decision: 'approved' });
    const { card, errors } = await openCard(page, aliceChat, JSON.parse(asked.raw));
    await expect(card.getByText('Asked. Only they read it; their answer comes back here.')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Ask', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a question withdrawn before the card is shown again: the card says it is closed', async ({ page }) => {
    const asked = await aliceChat.call('ask_person', { handle: '@eve', question: 'Withdrawn, then shown?' });
    await aliceChat.call('klatsch_card', { key: asked.meta['dev.klatsch/card'].key, decision: 'approved' });
    const ask = relay.klatsch.asksOf(eveId).find((k) => k.question === 'Withdrawn, then shown?')!;
    const shown = await eveChat.call('show_question', { ask_id: ask.id });
    relay.klatsch.withdrawAsk(aliceId, ask.id);
    const { card, errors } = await openCard(page, eveChat, JSON.parse(shown.raw));
    await expect(card.getByText(/Not open any more/)).toBeVisible();
    await expect(card.getByRole('button', { name: 'Send answer' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('Alice changes her question in the card and sends it with one click', async ({ page }) => {
    const asked = await aliceChat.call('ask_person', { handle: '@eve', question: 'Drafted by the AI?' });
    const { card, errors } = await openCard(page, aliceChat, JSON.parse(asked.raw));
    const box = card.getByLabel('Question (you can change it)');
    await expect(box).toHaveValue('Drafted by the AI?');
    await box.fill('Written by Alice herself?');
    await page.screenshot({ path: 'test/ui/screenshots/chat-card-edit.png' });
    await card.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(card.getByText(/^Asked\./)).toBeVisible();
    expect(relay.klatsch.asksOf(eveId).some((k) => k.question === 'Written by Alice herself?')).toBe(true);
    expect(errors).toEqual([]);
  });

  test('Alice picks a photo in the card; it goes with her question', async ({ page }) => {
    const asked = await aliceChat.call('ask_person', { handle: '@eve', question: 'With a photo from the card?' });
    const { card, errors } = await openCard(page, aliceChat, JSON.parse(asked.raw));
    await card.getByLabel(/Add a photo, PDF or voice note/).setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]) });
    await card.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(card.getByText(/^Asked\./)).toBeVisible();
    const ask = relay.klatsch.asksOf(eveId).find((k) => k.question === 'With a photo from the card?')!;
    expect(ask.attachments.map((f) => f.name)).toEqual(['card.png']);
    expect(errors).toEqual([]);
  });
});
