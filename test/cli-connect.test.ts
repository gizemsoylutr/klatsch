import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { agentTokenPath, readAgentToken } from '../src/agent-token.ts';
import { verifyToken } from '../src/auth/tokens.ts';
import { KLATSCH_TOOLS } from '../src/claude-settings.ts';
import { loadConfig, loadSecret } from '../src/config.ts';
import { seedVocabulary } from '../src/match/vocabulary.ts';
import { Klatsch } from '../src/service.ts';
import { openDb } from '../src/store/db.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'klatsch-cli-')));

/** A data dir with Bob in a circle, a project dir, and a fake `claude` on PATH that records its arguments. */
function world() {
  const data = fresh();
  const project = fresh();
  const bin = fresh();
  const log = join(bin, 'calls.log');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\necho ---- >> '${log}'\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const db = openDb(join(data, 'klatsch.db'));
  seedVocabulary(db);
  const klatsch = new Klatsch(db, loadConfig({ dataDir: data }), () => {});
  const bob = klatsch.ensureUser('bob', 'Bob');
  klatsch.ensureCircle('demo', bob);
  db.close();
  const cli = (...args: string[]) =>
    spawnSync('node', [CLI, ...args, '--user', 'bob', '--data', data], { cwd: project, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PWD: project } });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  const settings = () => JSON.parse(readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8'));
  const live = (token: string) => {
    const check = openDb(join(data, 'klatsch.db'));
    const verified = verifyToken(check, loadSecret(data), token);
    check.close();
    return Boolean(verified);
  };
  return { data, project, cli, calls, settings, live };
}

describe('klatsch connect and disconnect', () => {
  it('connect keeps the token in a 0600 file and off every command line; disconnect takes everything back', () => {
    const w = world();
    const connected = w.cli('connect');
    assert.equal(connected.status, 0, connected.stderr);
    assert.doesNotMatch(connected.stdout + connected.stderr, /klt_/, 'never printed');

    const agent = readAgentToken(w.data, w.project)!;
    assert.match(agent.token, /^klt_/);
    assert.equal(agent.url, 'http://127.0.0.1:7417');
    assert.equal(statSync(agentTokenPath(w.data, w.project)).mode & 0o777, 0o600);
    assert.ok(w.live(agent.token));

    const calls = w.calls();
    assert.doesNotMatch(calls, /klt_/, 'no token in any claude argument');
    const json = calls.split('\n').find((line) => line.startsWith('{'))!;
    assert.deepEqual(JSON.parse(json), {
      type: 'http',
      url: 'http://127.0.0.1:7417/mcp',
      headersHelper: `node '${CLI}' token-header --url 'http://127.0.0.1:7417' --data '${w.data}' --dir '${w.project}'`,
    });
    assert.match(calls, /^add-json\n--scope\nlocal\nklatsch$/m);

    const settings = w.settings();
    assert.deepEqual(settings.permissions.allow, KLATSCH_TOOLS);
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, `node '${CLI}' pending --hook --data '${w.data}' --dir '${w.project}'`);

    const disconnected = w.cli('disconnect');
    assert.equal(disconnected.status, 0, disconnected.stderr);
    assert.equal(existsSync(agentTokenPath(w.data, w.project)), false, 'the token file is gone');
    assert.deepEqual(w.settings(), {}, 'the hook and the allow rules are gone');
    assert.equal(w.live(agent.token), false, 'and the token is revoked');
    assert.match(w.calls(), /^remove\nklatsch\n-s\nlocal\n----$/m);
  });

  it('stops before any change when the settings file cannot be merged', () => {
    const w = world();
    mkdirSync(join(w.project, '.claude'));
    writeFileSync(join(w.project, '.claude', 'settings.local.json'), '{ not json');
    const connected = w.cli('connect');
    assert.notEqual(connected.status, 0);
    assert.match(connected.stderr, /settings\.local\.json is not valid JSON: fix or delete it/);
    assert.equal(w.calls(), '', 'claude was not called');
    assert.equal(existsSync(agentTokenPath(w.data, w.project)), false, 'no token file');
    const db = openDb(join(w.data, 'klatsch.db'));
    assert.equal((db.prepare('SELECT count(*) AS n FROM tokens').get() as { n: number }).n, 0, 'no token made');
    db.close();
  });
});
