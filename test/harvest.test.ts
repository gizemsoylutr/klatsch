import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { harvest } from '../src/harvest.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function repo(): { dir: string; commit: (subject: string, file: string, author?: string) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'klatsch-harvest-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'me@example.test');
  git('config', 'user.name', 'Me');
  git('config', 'commit.gpgsign', 'false');
  let n = 0;
  return {
    dir,
    commit(subject, file, author = 'Me <me@example.test>') {
      const path = join(dir, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(++n));
      git('add', '.');
      git('commit', '-q', '-m', subject, `--author=${author}`);
    },
  };
}

describe('klatsch harvest', () => {
  it('lists only my own fix commits, newest first, with tags from words and files', () => {
    const r = repo();
    r.commit('Add a landing page', 'index.html');
    r.commit('Fix keyset pagination on Postgres', 'src/db.ts');
    r.commit('Fix the build for someone else', 'build.ts', 'Other <other@example.test>');
    r.commit('Workaround for a Docker DNS bug', 'Dockerfile');
    const found = harvest(r.dir);
    assert.deepEqual(found.map((c) => c.subject), ['Workaround for a Docker DNS bug', 'Fix keyset pagination on Postgres']);
    assert.ok(found[1]!.tags.includes('postgres'));
    assert.ok(found[1]!.tags.includes('typescript'));
    assert.ok(found[0]!.tags.includes('docker'));
    assert.match(found[0]!.commit, /^[0-9a-f]{7,}$/);
  });

  it('does not take a commit from an author whose address only contains mine', () => {
    const r = repo();
    r.commit('Fix a race', 'a.ts', 'Near <notme@example.test>');
    assert.deepEqual(harvest(r.dir), []);
  });

  it('flags identifiers in a subject and keeps the subject for the human to read', () => {
    const r = repo();
    r.commit('Fix login on db.acme.internal', 'a.ts');
    const [candidate] = harvest(r.dir);
    assert.deepEqual(candidate!.flags.map((f) => f.kind), ['hostname']);
    assert.equal(candidate!.subject, 'Fix login on db.acme.internal');
  });

  it('caps the list, drops repeated subjects, and takes no tag outside the vocabulary', () => {
    const r = repo();
    for (let i = 0; i < 4; i++) r.commit(`Fix issue ${i} in acmecorp`, `f${i}.txt`);
    r.commit('Fix issue 3 in acmecorp', 'again.txt');
    const found = harvest(r.dir, { limit: 2 });
    assert.equal(found.length, 2);
    assert.equal(new Set(found.map((c) => c.subject)).size, 2);
    assert.deepEqual(found[0]!.tags, []);
  });

  it('refuses a bad --since or --limit, a folder that is no repository, and a repository with no email', () => {
    const r = repo();
    assert.throws(() => harvest(r.dir, { since: '--all' }), /--since/);
    assert.throws(() => harvest(r.dir, { limit: 0 }), /--limit/);
    assert.throws(() => harvest(mkdtempSync(join(tmpdir(), 'klatsch-plain-'))), /git repository/);
    const home = mkdtempSync(join(tmpdir(), 'klatsch-home-'));
    execFileSync('git', ['-C', r.dir, 'config', '--unset', 'user.email']);
    const previous = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, SYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
    Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' });
    try {
      assert.throws(() => harvest(r.dir), /user\.email/);
    } finally {
      for (const [key, name] of [['HOME', 'HOME'], ['XDG', 'XDG_CONFIG_HOME'], ['SYSTEM', 'GIT_CONFIG_NOSYSTEM']] as const) {
        if (previous[key] === undefined) delete process.env[name];
        else process.env[name] = previous[key];
      }
    }
  });

  it('the command needs a named repository; none is ever assumed, not even the current one', () => {
    const r = repo();
    r.commit('Fix a race', 'a.ts');
    const none = spawnSync(process.execPath, [CLI, 'harvest'], { cwd: r.dir, encoding: 'utf8' });
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /Name the one repository/);
    assert.doesNotMatch(none.stdout, /Fix a race/);
    const named = spawnSync(process.execPath, [CLI, 'harvest', '--repo', r.dir], { encoding: 'utf8' });
    assert.equal(named.status, 0, named.stderr);
    const output = JSON.parse(named.stdout) as { candidates: { subject: string }[]; note: string };
    assert.deepEqual(output.candidates.map((c) => c.subject), ['Fix a race']);
    assert.match(output.note, /Nothing has left this machine/);
  });

  it('has no network code, and no way to share: the source imports only git, the detectors and the vocabulary', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'harvest.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(imports, ['node:child_process', './detect/detectors.ts', './match/vocabulary.ts']);
    assert.doesNotMatch(source, /\bfetch\(/);
  });
});
