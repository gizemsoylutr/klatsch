// deploy/setup.sh, against a stand-in for Docker: what it writes and what it runs. The real stack is checked by
// scripts/deploy-check.sh, which needs Docker.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = join(import.meta.dirname, '..', 'deploy', 'setup.sh');
const KEY = 'pa$$word/with+chars';
const ANSWERS = {
  KLATSCH_DOMAIN: 'klatsch.team.example',
  TEAM_HANDLE: 'ada',
  TEAM_NAME: 'Ada Lovelace',
  TEAM_CIRCLE: 'backend-team',
  LITESTREAM_ENDPOINT: 'https://s3.example.eu',
  LITESTREAM_REGION: 'eu-central-1',
  LITESTREAM_BUCKET: 'team-backup',
  LITESTREAM_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  LITESTREAM_SECRET_ACCESS_KEY: KEY,
};

function world(dockerWorks = true) {
  const dir = mkdtempSync(join(tmpdir(), 'klatsch-setup-'));
  const bin = mkdtempSync(join(tmpdir(), 'klatsch-setup-bin-'));
  const log = join(bin, 'docker.log');
  copyFileSync(SCRIPT, join(dir, 'setup.sh'));
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${dockerWorks ? '' : 'exit 1\n'}`);
  chmodSync(join(bin, 'docker'), 0o755);
  const run = (env: Record<string, string> = ANSWERS, input = '') =>
    spawnSync('sh', [join(dir, 'setup.sh')], { encoding: 'utf8', input, env: { PATH: `${bin}:/usr/bin:/bin`, ...env } });
  return { dir, log, run, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

describe('deploy/setup.sh', () => {
  it('writes .env for this user only, starts the stack, makes the first person and prints a sign-in', () => {
    const w = world();
    const done = w.run();
    assert.equal(done.status, 0, done.stderr);
    const env = join(w.dir, '.env');
    assert.equal(statSync(env).mode & 0o777, 0o600);
    const text = readFileSync(env, 'utf8');
    assert.ok(text.includes(`LITESTREAM_SECRET_ACCESS_KEY='${KEY}'`), 'quoted, so Compose keeps the $ literally');
    assert.ok(text.includes(`KLATSCH_DOMAIN='klatsch.team.example'`));
    const calls = w.calls();
    assert.match(calls, /compose up -d --wait/);
    assert.match(calls, /klatsch init --user ada --name Ada Lovelace --circle backend-team/);
    assert.match(calls, /klatsch login --user ada/);
    assert.ok(!calls.includes(KEY), 'the key is on no command line');
    assert.ok(!(done.stdout + done.stderr).includes(KEY), 'and on no screen');
    assert.match(done.stdout, /Save the server secret/);
    assert.match(done.stdout, /npx klatsch connect --url https:\/\/klatsch\.team\.example/);
  });

  it('takes answers typed in order', () => {
    const w = world();
    const typed = ['klatsch.team.example', 'ada', 'Ada', 'team', 'https://s3.example.eu', '', 'bucket', 'id', 'key'].join('\n');
    const done = w.run({}, `${typed}\n`);
    assert.equal(done.status, 0, done.stderr);
    assert.match(readFileSync(join(w.dir, '.env'), 'utf8'), /LITESTREAM_REGION='eu-central-1'/);
  });

  it('refuses bad answers before anything exists', () => {
    for (const bad of [{ KLATSCH_DOMAIN: 'https://klatsch.example' }, { KLATSCH_DOMAIN: 'x.example/path' }, { KLATSCH_DOMAIN: 'x.example; rm -rf /' }, { TEAM_HANDLE: 'Ada Lovelace' }, { TEAM_CIRCLE: '$(id)' }, { LITESTREAM_SECRET_ACCESS_KEY: "it's" }]) {
      const w = world();
      const done = w.run({ ...ANSWERS, ...bad });
      assert.notEqual(done.status, 0, JSON.stringify(bad));
      assert.equal(existsSync(join(w.dir, '.env')), false, JSON.stringify(bad));
      assert.equal(w.calls().includes('up -d'), false);
    }
  });

  it('never overwrites an existing .env: run again, it only starts and signs in', () => {
    const w = world();
    writeFileSync(join(w.dir, '.env'), 'KEEP=me\n');
    const done = w.run({ TEAM_HANDLE: 'ada' });
    assert.equal(done.status, 0, done.stderr);
    assert.equal(readFileSync(join(w.dir, '.env'), 'utf8'), 'KEEP=me\n');
    assert.ok(!w.calls().includes('klatsch init'));
    assert.match(w.calls(), /klatsch login --user ada/);
  });

  it('says what is missing without Docker, and writes nothing', () => {
    const w = world(false);
    const done = w.run();
    assert.notEqual(done.status, 0);
    assert.match(done.stderr, /Docker Engine/);
    assert.equal(existsSync(join(w.dir, '.env')), false);
  });

  it('keeps .env out of git, and the guide and the README point here', () => {
    const root = join(import.meta.dirname, '..');
    assert.equal(spawnSync('git', ['check-ignore', '-q', 'deploy/.env'], { cwd: root }).status, 0);
    assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /docs\/team-relay\.md/);
    assert.match(readFileSync(join(root, 'docs', 'team-relay.md'), 'utf8'), /sh deploy\/setup\.sh/);
  });
});
