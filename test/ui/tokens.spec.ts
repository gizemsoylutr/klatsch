// Agent tokens in a real browser: Alice clicks "Connect an agent", sees the `claude mcp add` command once,
// her agent connects with it, and she revokes the token on the same page.
import { expect, test } from '@playwright/test';
import { agent, startRelay, unauthorized, type Relay } from '../e2e/harness.ts';
import { person, type Person } from './people.ts';

test.describe.serial('tokens: create and revoke in the browser', () => {
  let relay: Relay;
  let alice: Person, dave: Person;
  let aliceAgent: Awaited<ReturnType<typeof agent>>;
  let token = '';

  test.beforeAll(async ({ browser }) => {
    relay = await startRelay();
    const a = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('demo', a);
    const d = relay.klatsch.ensureUser('dave', 'Dave');
    alice = await person(browser, relay, 'Alice', import.meta.filename, relay.loginLink(a));
    dave = await person(browser, relay, 'Dave', import.meta.filename, relay.loginLink(d), { member: false });
  });
  test.afterAll(async () => {
    await aliceAgent?.close().catch(() => {});
    await Promise.all([alice, dave].map((p) => p?.context.close()));
    await relay.close();
  });

  test('Alice opens "Agent tokens" and clicks "Connect an agent"; the command is shown once', async () => {
    await alice.goTo('Tokens');
    await expect(alice.page).toHaveTitle('Agent tokens · Klatsch');
    const created = await alice.click(alice.page.getByRole('button', { name: 'Connect an agent' }));
    expect(created.status()).toBe(200);
    const command = await alice.page.locator('code').innerText();
    const parts = command.match(/^claude mcp add --scope local --transport http klatsch (\S+)\/mcp --header "Authorization: Bearer (klt_[\w-]+)"$/);
    expect(parts, command).not.toBeNull();
    expect(parts![1]).toBe(relay.base);
    token = parts![2]!;
    await alice.shot('tokens-command.png');
  });

  test('Alice picks Codex, then Copilot, on the Tokens page; each shows its own connect command', async () => {
    await alice.click(alice.page.getByRole('link', { name: 'Back to your agent tokens' }));
    const picker = alice.page.getByRole('navigation', { name: 'Agent client' });
    await alice.click(picker.getByRole('link', { name: 'Codex' }));
    await expect(picker.getByRole('link', { name: 'Codex' })).toHaveAttribute('aria-current', 'true');
    await expect(alice.page.locator('code')).toHaveText('npx klatsch connect --user alice --client codex');
    await alice.shot('tokens-codex.png');
    await alice.click(picker.getByRole('link', { name: 'Copilot' }));
    await expect(alice.page.locator('code')).toHaveText(['npx klatsch connect --user alice --client copilot-vscode', 'npx klatsch connect --user alice --client copilot-cli']);
  });

  test('the agent connects with that token', async () => {
    aliceAgent = await agent(relay, token, { onPage: async () => {} });
    expect((await aliceAgent.call('inbox')).isError).toBe(false);
  });

  test('the token list shows it live, never the token again', async () => {
    const item = alice.page.locator('.item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(/web:\d{4}-\d{2}-\d{2} live/);
    expect(await alice.page.content()).not.toContain(token);
    await alice.shot('tokens-list.png');
  });

  test('Alice clicks Revoke; the token is revoked and the agent is shut out', async () => {
    const revoked = await alice.click(alice.page.locator('.item').getByRole('button', { name: 'Revoke' }));
    expect(revoked.status()).toBe(200);
    expect(alice.page.url()).toBe(`${relay.base}/ui/tokens`);
    await expect(alice.page.locator('.item')).toContainText('revoked');
    await expect(alice.page.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
    await alice.shot('tokens-revoked.png');
    expect(unauthorized(await aliceAgent.call('inbox').catch((error: unknown) => error)), 'the agent gets 401').toBe(true);
  });

  test('someone in no circle clicks "Connect an agent" and is told why not', async () => {
    await dave.open(`${relay.base}/ui/tokens`);
    const refused = await dave.click(dave.page.getByRole('button', { name: 'Connect an agent' }));
    expect(refused.status()).toBe(409);
    await expect(dave.page.getByText('You are in no circle, so an agent would have nothing to do.')).toBeVisible();
    await expect(dave.page.locator('code')).toHaveCount(0);
  });

  test('no CSP violations, and every form post carried the page origin', async () => {
    for (const p of [alice, dave]) await p.expectCleanBrowser();
  });
});
