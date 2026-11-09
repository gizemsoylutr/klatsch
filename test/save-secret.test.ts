// deploy/save-secret.sh with stand-ins for ssh and the clipboard: the secret reaches the clipboard and nothing else.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = join(import.meta.dirname, '..', 'deploy', 'save-secret.sh');
const SECRET = randomBytes(32).toString('base64');

function world(answer: string, sshExit = 0, clipboard = true) {
  const bin = mkdtempSync(join(tmpdir(), 'klatsch-save-'));
  const args = join(bin, 'ssh.args');
  const clip = join(bin, 'clip.log');
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$*" > '${args}'\nprintf '%s\\n' '${answer}'\nexit ${sshExit}\n`);
  chmodSync(join(bin, 'ssh'), 0o755);
  if (clipboard) {
    writeFileSync(join(bin, 'pbcopy'), `#!/bin/sh\ncat > '${clip}.now'\ncat '${clip}.now' >> '${clip}'\nprintf '\\n' >> '${clip}'\n`);
    chmodSync(join(bin, 'pbcopy'), 0o755);
  }
  const run = (argv: string[] = ['ada@relay.example', '-i', 'key'], env: Record<string, string> = {}) =>
    spawnSync('/bin/sh', [SCRIPT, ...argv], { encoding: 'utf8', input: '\n', env: { PATH: `${bin}:/usr/bin:/bin`, ...env } });
  return { run, args, clip, now: `${clip}.now`, ssh: join(bin, 'ssh') };
}

describe('deploy/save-secret.sh', () => {
  it('puts the secret on the clipboard, shows it nowhere, and clears the clipboard after Enter', () => {
    const w = world(SECRET);
    const done = w.run();
    assert.equal(done.status, 0, done.stderr);
    assert.ok(!(done.stdout + done.stderr).includes(SECRET), 'on no screen');
    assert.ok(readFileSync(w.clip, 'utf8').startsWith(`${SECRET}\n`), 'on the clipboard');
    assert.equal(readFileSync(w.now, 'utf8'), '', 'cleared at the end');
    assert.match(done.stdout, /Clipboard cleared/);
  });

  it('passes the ssh options on and asks the default folder, or the one named', () => {
    const w = world(SECRET);
    w.run();
    assert.match(readFileSync(w.args, 'utf8'), /^-i key ada@relay\.example cd '\/opt\/klatsch\/deploy' && docker compose exec -T klatsch base64 \/data\/secret/);
    w.run(undefined, { KLATSCH_REMOTE_DIR: '/srv/klatsch' });
    assert.match(readFileSync(w.args, 'utf8'), /cd '\/srv\/klatsch'/);
  });

  it('copies nothing when the answer is not 32 bytes, and does not print it', () => {
    for (const answer of ['no configuration file provided', randomBytes(16).toString('base64'), '']) {
      const w = world(answer);
      const done = w.run();
      assert.notEqual(done.status, 0, answer);
      assert.equal(existsSync(w.clip), false, answer);
      if (answer) assert.ok(!(done.stdout + done.stderr).includes(answer), 'not shown');
    }
  });

  it('copies nothing when ssh fails, even if something came back', () => {
    const w = world(SECRET, 255);
    assert.notEqual(w.run().status, 0);
    assert.equal(existsSync(w.clip), false);
  });

  it('needs a target, a plain folder and a clipboard, before it fetches anything', () => {
    assert.match(world(SECRET).run([]).stderr, /Usage/);
    const quoted = world(SECRET);
    assert.notEqual(quoted.run(undefined, { KLATSCH_REMOTE_DIR: "/x'; rm -rf /; '" }).status, 0);
    assert.equal(existsSync(quoted.args), false);
    // Only what the check itself needs on PATH, so a real clipboard tool on this machine is not found.
    const none = world(SECRET, 0, false);
    const only = mkdtempSync(join(tmpdir(), 'klatsch-save-path-'));
    symlinkSync('/usr/bin/grep', join(only, 'grep'));
    symlinkSync(none.ssh, join(only, 'ssh'));
    const done = none.run(undefined, { PATH: only });
    assert.notEqual(done.status, 0);
    assert.match(done.stderr, /No clipboard tool/);
    assert.equal(existsSync(none.args), false, 'not fetched');
  });
});
