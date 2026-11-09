import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { agentTokenPath, readAgentToken } from '../src/agent-token.ts';
import { KLATSCH_TOOLS } from '../src/claude-settings.ts';
import { openDb } from '../src/store/db.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'klatsch-hosted-')));
const TOKEN = `klt_${'A'.repeat(43)}`;
// Never the port of a relay that may be running on this machine.
const SPARE_PORT = '47917';

/** A data dir (no relay database: a hosted connect never opens one), a project dir and a fake `claude` that records its arguments. */
function world() {
  const data = fresh();
  const project = fresh();
  const bin = fresh();
  const log = join(bin, 'calls.log');
  writeFileSync(
    join(bin, 'claude'),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\n[ -z "\${KLATSCH_TOKEN-}" ] || echo inherited-KLATSCH_TOKEN >> '${log}'\necho ---- >> '${log}'\n`,
  );
  chmodSync(join(bin, 'claude'), 0o755);
  const cli = (args: string[], options: { input?: string; env?: Record<string, string> } = {}) =>
    spawnSync('node', [CLI, ...args, '--data', data], {
      cwd: project,
      encoding: 'utf8',
      input: options.input ?? '',
      timeout: 15_000,
      env: { ...process.env, KLATSCH_TOKEN: '', PATH: `${bin}:${process.env.PATH}`, PWD: project, ...options.env },
    });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  const settings = () => JSON.parse(readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8'));
  return { data, project, cli, calls, settings };
}

describe('klatsch connect to a hosted relay', () => {
  it('reads the token from stdin and connects exactly like a local connect, never passing the token on', () => {
    const w = world();
    const connected = w.cli(['connect', '--url', 'https://klatsch.example', '--token', '-'], { input: `${TOKEN}\n` });
    assert.equal(connected.status, 0, connected.stderr);
    assert.doesNotMatch(connected.stdout + connected.stderr, /klt_/, 'never printed');
    assert.equal(existsSync(join(w.data, 'klatsch.db')), false, 'no relay database on this machine');

    assert.deepEqual(readAgentToken(w.data, w.project), { url: 'https://klatsch.example', token: TOKEN });
    assert.equal(statSync(agentTokenPath(w.data, w.project)).mode & 0o777, 0o600);
    assert.equal(statSync(join(w.data, 'agents')).mode & 0o777, 0o700);

    const calls = w.calls();
    assert.doesNotMatch(calls, /klt_/, 'no token in any claude argument');
    const json = calls.split('\n').find((line) => line.startsWith('{'))!;
    assert.deepEqual(JSON.parse(json), {
      type: 'http',
      url: 'https://klatsch.example/mcp',
      headersHelper: `node '${CLI}' token-header --url 'https://klatsch.example' --data '${w.data}' --dir '${w.project}'`,
    });
    const settings = w.settings();
    assert.deepEqual(settings.permissions.allow, KLATSCH_TOOLS);
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, `node '${CLI}' pending --hook --data '${w.data}' --dir '${w.project}'`);

    const header = w.cli(['token-header', '--dir', w.project]);
    assert.deepEqual(JSON.parse(header.stdout), { Authorization: `Bearer ${TOKEN}` }, 'the headersHelper hands it to Claude Code');
  });

  it('takes the token from KLATSCH_TOKEN without handing it to claude, and warns that the flag form shows in history and ps', () => {
    const fromEnv = world();
    assert.equal(fromEnv.cli(['connect', '--url', 'https://klatsch.example'], { env: { KLATSCH_TOKEN: TOKEN } }).status, 0);
    assert.equal(readAgentToken(fromEnv.data, fromEnv.project)?.token, TOKEN);
    assert.match(fromEnv.calls(), /add-json/);
    assert.doesNotMatch(fromEnv.calls(), /inherited-KLATSCH_TOKEN/, 'the child process environment has no token');

    const fromFlag = world();
    const connected = fromFlag.cli(['connect', '--url', 'https://klatsch.example', '--token', TOKEN]);
    assert.equal(connected.status, 0, connected.stderr);
    assert.match(connected.stderr, /shell history and was visible in ps/);
    assert.doesNotMatch(connected.stdout + connected.stderr, /klt_/);
  });

  it('refuses anything that is not a token without showing it, before changing anything', () => {
    const w = world();
    for (const input of ['', 'hunter2-not-a-token\n', `${TOKEN}x\n`]) {
      const refused = w.cli(['connect', '--url', 'https://klatsch.example', '--token', '-'], { input });
      assert.notEqual(refused.status, 0);
      assert.doesNotMatch(refused.stdout + refused.stderr, /hunter2|klt_A/, 'what was pasted is not echoed');
    }
    assert.equal(w.calls(), '', 'claude was not called');
    assert.equal(existsSync(agentTokenPath(w.data, w.project)), false, 'no token file');
    assert.equal(existsSync(join(w.project, '.claude')), false, 'no settings');
  });

  it('accepts only an https origin (or a loopback relay)', () => {
    const w = world();
    for (const url of ['http://klatsch.example', 'https://klatsch.example/relay', 'https://user:pw@klatsch.example', 'https://klatsch.example/?x=1', 'nonsense']) {
      const refused = w.cli(['connect', '--url', url, '--token', '-'], { input: `${TOKEN}\n` });
      assert.notEqual(refused.status, 0, url);
      assert.match(refused.stderr, /--url must be/);
    }
    assert.equal(w.calls(), '');
    assert.equal(w.cli(['connect', '--url', 'https://klatsch.example/', '--token', '-'], { input: TOKEN }).status, 0, 'a trailing slash is fine');
    assert.equal(readAgentToken(w.data, w.project)?.url, 'https://klatsch.example');
    assert.equal(w.cli(['connect', '--url', 'http://127.0.0.1:7417', '--token', '-'], { input: TOKEN }).status, 0);
  });

  it('disconnect without --user removes everything here and says where to revoke the token', () => {
    const w = world();
    assert.equal(w.cli(['connect', '--url', 'https://klatsch.example', '--token', '-'], { input: TOKEN }).status, 0);
    const disconnected = w.cli(['disconnect']);
    assert.equal(disconnected.status, 0, disconnected.stderr);
    assert.match(disconnected.stdout, /Revoke the token on https:\/\/klatsch\.example\/ui\/tokens/);
    assert.equal(existsSync(agentTokenPath(w.data, w.project)), false);
    assert.deepEqual(w.settings(), {});
    assert.match(w.calls(), /^remove\nklatsch\n-s\nlocal\n----$/m);
  });
});

describe('klatsch up and init for a hosted relay', () => {
  const env = (extra: Record<string, string>) => ({ KLATSCH_PORT: SPARE_PORT, ...extra });

  it('refuses to start hosted on loopback, on plain http, or with the demo', () => {
    const w = world();
    const up = (extra: Record<string, string>, args: string[] = []) => w.cli(['up', ...args], { env: env(extra) });
    assert.match(up({ KLATSCH_PUBLIC_URL: 'https://klatsch.example' }).stderr, /non-loopback address/);
    assert.match(up({ KLATSCH_PUBLIC_URL: 'http://klatsch.example', KLATSCH_HOST: '0.0.0.0' }).stderr, /https public URL/);
    assert.match(up({ KLATSCH_PUBLIC_URL: 'https://klatsch.example', KLATSCH_HOST: '0.0.0.0' }, ['--demo']).stderr, /--demo runs on a loopback/);
    assert.match(up({ KLATSCH_PUBLIC_URL: `http://127.0.0.1:${SPARE_PORT}`, KLATSCH_HOST: '0.0.0.0' }).stderr, /binds to loopback only/);
  });

  it('init adds the first person and a circle they own; --data wins over KLATSCH_DATA_DIR', () => {
    const w = world();
    const fromEnv = fresh();
    const init = w.cli(['init', '--user', 'gizem', '--name', 'Gizem', '--circle', 'friends'], { env: { KLATSCH_DATA_DIR: fromEnv } });
    assert.equal(init.status, 0, init.stderr);
    assert.equal(existsSync(join(fromEnv, 'klatsch.db')), false, 'the flag, not the environment, chose the data dir');
    const db = openDb(join(w.data, 'klatsch.db'));
    const row = db
      .prepare(`SELECT u.handle, c.name, m.role FROM users u JOIN memberships m ON m.user_id = u.id JOIN circles c ON c.id = m.circle_id`)
      .get() as { handle: string; name: string; role: string };
    db.close();
    assert.deepEqual({ ...row }, { handle: 'gizem', name: 'friends', role: 'owner' });
    assert.match(w.cli(['init', '--user', 'Not A Handle', '--name', 'X', '--circle', 'c']).stderr, /handle is 1–39/);
  });

  it('init is for the first person only: an existing circle is refused, nobody is added', () => {
    const w = world();
    assert.equal(w.cli(['init', '--user', 'gizem', '--name', 'Gizem', '--circle', 'friends']).status, 0);
    const again = w.cli(['init', '--user', 'mallory', '--name', 'Mallory', '--circle', 'friends']);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /Circle friends already exists; others join it by an invite/);
    const db = openDb(join(w.data, 'klatsch.db'));
    const users = db.prepare('SELECT handle FROM users').all() as { handle: string }[];
    db.close();
    assert.deepEqual(users.map((u) => u.handle), ['gizem']);
  });

  it('up stops cleanly on SIGTERM, closing the server and the database', async () => {
    const data = fresh();
    const port = String(40000 + Math.floor(Math.random() * 9000));
    const child = spawn('node', [CLI, 'up', '--data', data, '--port', port], { env: { ...process.env, KLATSCH_PUBLIC_URL: '' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    for (let i = 0; i < 100 && !out.includes('Klatsch relay on'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(out, /Klatsch relay on http:\/\/127\.0\.0\.1:/);
    child.kill('SIGTERM');
    const [code, signal] = (await once(child, 'exit')) as [number | null, string | null];
    assert.equal(signal, null, 'exited by itself, not killed by the signal');
    assert.equal(code, 0, err);
    assert.equal(err, '');
    assert.equal(existsSync(join(data, 'klatsch.db-wal')), false, 'closing the database checkpointed and removed the WAL');
  });
});
