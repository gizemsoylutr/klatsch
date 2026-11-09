// Connecting without a token: `klatsch connect --url` shows a code, the person signs in to the relay in their
// browser, types it, reads what it means and clicks Connect; the command then collects a new agent token, once.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { agent, browser, CODE, startRelay, type Browser, type Relay } from './harness.ts';

const CLI = join(import.meta.dirname, '..', '..', 'src', 'cli.ts');
const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'klatsch-browser-connect-')));

describe('browser connect: a code from the command, typed in the signed-in browser', () => {
  let relay: Relay;
  let alice: Browser;
  let aliceId = '';

  /** As the waiting command sends it: JSON, no cookie, no Origin. */
  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${relay.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const start = async (client = 'claude', headers: Record<string, string> = {}) => {
    const response = await post('/ui/connect/start', JSON.stringify({ client }), headers);
    return { status: response.status, body: (await response.json()) as Record<string, string> };
  };
  const poll = async (device: string) => {
    const response = await post('/ui/connect/poll', JSON.stringify({ device_code: device }));
    return { status: response.status, body: (await response.json()) as Record<string, string> };
  };

  before(async () => {
    relay = await startRelay();
    aliceId = relay.klatsch.ensureUser('alice', 'Alice');
    relay.klatsch.ensureCircle('demo', aliceId);
    alice = await browser(relay, relay.loginLink(aliceId));
  });
  after(async () => {
    await relay.close();
  });

  it('the real command shows a code, the person types it and connects, and the agent works with the token', async () => {
    const project = fresh();
    const data = fresh();
    const bin = fresh();
    const log = join(bin, 'claude.log');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    const command = spawn(process.execPath, [CLI, 'connect', '--url', relay.base, '--data', data], {
      cwd: project,
      env: { ...process.env, KLATSCH_TOKEN: '', PATH: `${bin}:${process.env.PATH}`, PWD: project },
    });
    let output = '';
    command.stdout.on('data', (chunk) => (output += chunk));
    command.stderr.on('data', (chunk) => (output += chunk));
    const code = await new Promise<string>((resolve, reject) => {
      const seen = setInterval(() => {
        const match = output.match(CODE);
        if (match) {
          clearInterval(seen);
          resolve(match[0]);
        }
      }, 20);
      command.once('exit', () => {
        clearInterval(seen);
        reject(new Error(`connect ended early: ${output}`));
      });
    });
    assert.ok(output.includes(`${relay.base}/ui/connect`));

    const form = await alice.get('/ui/connect');
    assert.equal(form.status, 200);
    assert.ok(form.html.includes('Type the code'));
    const page = await alice.post('/ui/connect', { code });
    assert.equal(page.status, 200);
    assert.ok(page.html.includes('Connect Claude Code to your Klatsch account?'));
    assert.ok(page.html.includes('Only continue if you ran klatsch connect yourself'), 'the page warns against a code someone else sent');
    assert.equal((await alice.post('/ui/connect/decide', { code, decision: 'approved' })).status, 200);
    assert.ok(relay.notifications.some((line) => line.includes('A new agent was connected')), 'the person hears of it');

    const status = await new Promise<number | null>((resolve) => command.once('exit', resolve));
    assert.equal(status, 0, output);
    assert.doesNotMatch(output, /klt_/, 'the token is never printed');
    assert.doesNotMatch(readFileSync(log, 'utf8'), /klt_/, 'and on no command line');
    const [file] = readdirSync(join(data, 'agents'));
    const { token } = JSON.parse(readFileSync(join(data, 'agents', file!), 'utf8')) as { token: string };
    const connected = await agent(relay, token);
    assert.equal((await connected.call('pending')).isError, false);
    await connected.close();
    const tokens = await alice.get('/ui/tokens');
    assert.ok(tokens.html.includes('Claude Code'), 'the Agents page names what it serves');
    assert.doesNotMatch(tokens.html, new RegExp(project.split('/').at(-1)!), 'never the folder: the relay was not told it');
  });

  it('the token comes out once; a second poll gets nothing', async () => {
    const { body } = await start();
    assert.equal((await poll(body.device_code!)).body.state, 'pending');
    assert.equal((await alice.post('/ui/connect/decide', { code: body.user_code!, decision: 'approved' })).status, 200);
    const first = await poll(body.device_code!);
    assert.match(first.body.token!, /^klt_/);
    const second = await poll(body.device_code!);
    assert.equal(second.body.state, 'expired');
    assert.equal(second.body.token, undefined);
  });

  it('nothing is stored that could be used: no plain token and no plain code in the database', async () => {
    const { body } = await start();
    await alice.post('/ui/connect/decide', { code: body.user_code!, decision: 'approved' });
    const dump = JSON.stringify(relay.db.prepare('SELECT * FROM connect_requests').all());
    assert.ok(!dump.includes(body.user_code!) && !dump.includes(body.device_code!) && !dump.includes('klt_'));
  });

  it('the link carries no code and connects nothing: a GET never decides', async () => {
    const { body } = await start();
    assert.doesNotMatch(body.verification_url!, /[B-DF-HJ-NP-TV-XZ]{4}-/);
    assert.equal((await alice.get(`/ui/connect?code=${body.user_code}`)).html.includes(body.user_code!), false);
    assert.equal((await poll(body.device_code!)).body.state, 'pending');
  });

  it('Decline connects nothing, and the command hears it', async () => {
    const { body } = await start('codex');
    const page = await alice.post('/ui/connect', { code: body.user_code! });
    assert.ok(page.html.includes('Connect Codex'));
    assert.equal((await alice.post('/ui/connect/decide', { code: body.user_code!, decision: 'declined' })).status, 200);
    const outcome = await poll(body.device_code!);
    assert.equal(outcome.body.state, 'declined');
    assert.equal(outcome.body.token, undefined);
    assert.equal((await alice.post('/ui/connect/decide', { code: body.user_code!, decision: 'approved' })).status, 409, 'a decided request cannot be decided again');
  });

  it('a wrong code gets one neutral line, and ten wrong codes stop the session', async () => {
    const wrongIn = await browser(relay, relay.loginLink(aliceId));
    const wrong = await wrongIn.post('/ui/connect', { code: 'BBBB-CCCC' });
    assert.equal(wrong.status, 404);
    assert.ok(wrong.html.includes('No open request with this code.'));
    for (let i = 0; i < 9; i++) await wrongIn.post('/ui/connect', { code: 'BBBB-CCCC' });
    assert.equal((await wrongIn.post('/ui/connect', { code: 'BBBB-CCCC' })).status, 429);
  });

  it('someone in no circle cannot connect: no page, no decision', async () => {
    const dave = relay.klatsch.ensureUser('dave', 'Dave');
    const daveBrowser = await browser(relay, relay.loginLink(dave));
    const { body } = await start();
    assert.equal((await daveBrowser.get('/ui/connect')).status, 409);
    assert.equal((await daveBrowser.post('/ui/connect/decide', { code: body.user_code!, decision: 'approved' })).status, 409);
    assert.equal((await poll(body.device_code!)).body.state, 'pending');
  });

  it('a person removed from every circle after deciding gets no token', async () => {
    const bob = relay.klatsch.ensureUser('bob', 'Bob');
    const circle = relay.klatsch.ensureCircle('demo', aliceId);
    relay.klatsch.addMember(circle, bob, aliceId);
    const bobBrowser = await browser(relay, relay.loginLink(bob));
    const { body } = await start();
    assert.equal((await bobBrowser.post('/ui/connect/decide', { code: body.user_code!, decision: 'approved' })).status, 200);
    relay.klatsch.removeMember(aliceId, circle, bob);
    const outcome = await poll(body.device_code!);
    assert.equal(outcome.body.state, 'declined');
    assert.equal(outcome.body.token, undefined);
  });

  it('another site cannot start or collect: a request with an Origin is refused', async () => {
    assert.equal((await start('claude', { Origin: 'https://evil.example' })).status, 403);
    const form = await post('/ui/connect/poll', 'device_code=x', { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 403, 'nor a form post, which a page can send without preflight');
  });

  it('an unknown client is refused, an unknown device code hears nothing about anyone', async () => {
    assert.equal((await start('<script>')).status, 400);
    assert.equal((await poll('nope')).body.state, 'expired');
  });

  it('the page and the decision need the session and its form token', async () => {
    const { body } = await start();
    const noSession = await fetch(`${relay.base}/ui/connect/decide`, {
      method: 'POST',
      headers: { Origin: relay.base, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: body.user_code!, decision: 'approved' }).toString(),
    });
    assert.equal(noSession.status, 401);
    assert.equal((await poll(body.device_code!)).body.state, 'pending');
  });

  it('with no token and an unreachable relay the command fails cleanly', () => {
    const project = fresh();
    const done = spawnSync(process.execPath, [CLI, 'connect', '--url', 'http://127.0.0.1:9', '--data', fresh()], { cwd: project, encoding: 'utf8', env: { ...process.env, KLATSCH_TOKEN: '' } });
    assert.notEqual(done.status, 0);
    assert.doesNotMatch(done.stdout, /klt_/);
  });
});
