import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLoginLink } from '../src/auth/web-sessions.ts';
import { checkServing, envConfig, isHosted, loadConfig } from '../src/config.ts';
import { setup } from './helpers.ts';

const PUBLIC = 'https://klatsch.example';

describe('serving settings', () => {
  it('reads the container settings from the environment, ignoring empty ones', () => {
    assert.deepEqual(envConfig({ KLATSCH_PUBLIC_URL: PUBLIC, KLATSCH_HOST: '0.0.0.0', KLATSCH_PORT: '8080', KLATSCH_DATA_DIR: '/data' }), {
      publicUrl: PUBLIC,
      host: '0.0.0.0',
      port: 8080,
      dataDir: '/data',
    });
    assert.deepEqual(envConfig({ KLATSCH_PUBLIC_URL: '', KLATSCH_PORT: '' }), {});
  });

  it('starts hosted only on an https origin, bound where its proxy can reach it', () => {
    const hosted = (publicUrl: string, host = '0.0.0.0') => () => checkServing(loadConfig({ publicUrl, host }));
    assert.doesNotThrow(hosted(PUBLIC));
    assert.doesNotThrow(hosted(PUBLIC, '::'));
    assert.throws(hosted('http://klatsch.example'), /https public URL/);
    assert.throws(hosted(`${PUBLIC}/`), /origin only/);
    assert.throws(hosted(`${PUBLIC}/relay`), /origin only/);
    assert.throws(hosted(PUBLIC, '127.0.0.1'), /non-loopback address/);
    assert.throws(hosted(PUBLIC, '::1'), /non-loopback address/);
    assert.throws(hosted('not a url'), /not a URL/);
  });

  it('keeps a local relay on loopback', () => {
    assert.doesNotThrow(() => checkServing(loadConfig()));
    assert.equal(isHosted(loadConfig()), false);
    assert.throws(() => checkServing(loadConfig({ host: '0.0.0.0', publicUrl: 'http://127.0.0.1:7417' })), /binds to loopback only/);
    assert.throws(() => checkServing(loadConfig({ port: 70000 })), /port/);
  });
});

describe('hosted relay behind a proxy', () => {
  /** A signed-in human on the hosted relay, as the browser reaches it through the proxy (Host is the public host). */
  async function hostedHuman() {
    const t = setup({ config: { host: '0.0.0.0', publicUrl: PUBLIC } });
    const link = createLoginLink(t.db, t.secret, t.alice, PUBLIC);
    const cookie = ((await t.app.request(link)).headers.get('set-cookie') ?? '').split(';')[0]!;
    const csrf = (await (await t.app.request(`${PUBLIC}/ui`, { headers: { Cookie: cookie } })).text()).match(/name="csrf" value="([^"]+)"/)?.[1] ?? '';
    const post = (path: string, headers: Record<string, string> = {}) =>
      t.app.request(`${PUBLIC}${path}`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Origin: PUBLIC, ...headers },
        body: new URLSearchParams({ csrf }).toString(),
      });
    return { t, cookie, post };
  }

  it('sets a Secure session cookie', async () => {
    const t = setup({ config: { host: '0.0.0.0', publicUrl: PUBLIC } });
    const login = await t.app.request(createLoginLink(t.db, t.secret, t.bob, PUBLIC));
    assert.match(login.headers.get('set-cookie') ?? '', /^klatsch_session=.*; Secure/);
  });

  it('shows the hosted connect command with the token apart, and ignores forwarded host headers', async () => {
    const { post } = await hostedHuman();
    const response = await post('/ui/tokens', { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'http' });
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.ok(page.includes(`<code class="cmd">npx klatsch connect --url ${PUBLIC} --token - --client claude</code>`), 'the connect command reads the token from stdin');
    const token = page.match(/<code class="cmd">(klt_[\w-]{43})<\/code>/)?.[1];
    assert.ok(token, 'the token is shown once, on its own line');
    assert.doesNotMatch(page, /--token klt_/, 'never inside the command, where it would land in the shell history');
    assert.doesNotMatch(page, /evil\.example|http:\/\/klatsch/, 'links come from the public URL only');
  });

  it('shows each client its own connect command: picked by a plain link, carried by the Connect form', async () => {
    const { t, cookie, post } = await hostedHuman();
    const page = async (query: string) => (await t.app.request(`${PUBLIC}/ui/tokens${query}`, { headers: { Cookie: cookie } })).text();
    assert.match(await page(''), /<a href="\/ui\/tokens\?client=claude" aria-current="true">Claude Code<\/a>/);
    assert.ok((await page('')).includes(`npx klatsch connect --url ${PUBLIC} --token - --client claude</code>`));
    const codex = await page('?client=codex');
    assert.ok(codex.includes(`npx klatsch connect --url ${PUBLIC} --token - --client codex</code>`));
    assert.match(codex, /<input type="hidden" name="client" value="codex" \/>/, 'the Connect button remembers the pick');
    const copilot = await page('?client=copilot');
    for (const client of ['copilot-vscode', 'copilot-cli']) assert.ok(copilot.includes(`--token - --client ${client}</code>`), client);
    for (const odd of ['<script>', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const shown = await page(`?client=${encodeURIComponent(odd)}`);
      assert.ok(shown.includes('--client claude</code>'), `${odd}: anything else is Claude Code`);
      assert.ok(!shown.includes(`--client ${odd}`) && !shown.includes(`value="${odd}"`), `${odd}: never echoed`);
    }
    assert.doesNotMatch(await page('?client=%3Cscript%3E'), /<script/);
    const created = await (await t.app.request(`${PUBLIC}/ui/tokens`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Origin: PUBLIC },
      body: new URLSearchParams({ csrf: (await page('')).match(/name="csrf" value="([^"]+)"/)![1]!, client: 'codex' }).toString(),
    })).text();
    assert.ok(created.includes(`npx klatsch connect --url ${PUBLIC} --token - --client codex</code>`));
    assert.doesNotMatch(created, /claude mcp add/, 'the Claude Code fallback only for Claude Code');
    const csrf = (await page('')).match(/name="csrf" value="([^"]+)"/)![1]!;
    for (const odd of ['toString', 'constructor', '__proto__']) {
      const made = await (await t.app.request(`${PUBLIC}/ui/tokens`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Origin: PUBLIC },
        body: new URLSearchParams({ csrf, client: odd }).toString(),
      })).text();
      assert.ok(made.includes('--token - --client claude</code>') && !made.includes(`--client ${odd}`), `${odd} in the form is Claude Code, never echoed`);
    }
    assert.equal((await post('/ui/tokens')).status, 200);
  });

  it('refuses a form post whose Origin is not the public origin, whatever the proxy adds', async () => {
    const { post } = await hostedHuman();
    assert.equal((await post('/ui/tokens', { Origin: 'http://klatsch.example', 'X-Forwarded-Proto': 'https' })).status, 403);
  });

  it('answers only on the public host name', async () => {
    const { t } = await hostedHuman();
    assert.equal((await t.app.request(`${PUBLIC}/`, { headers: { Host: 'klatsch:7417' } })).status, 403, 'not on the container name');
    assert.equal((await t.app.request(`${PUBLIC}/`, { headers: { Host: 'klatsch.example', 'X-Forwarded-Host': 'evil.example' } })).status, 200);
  });
});
