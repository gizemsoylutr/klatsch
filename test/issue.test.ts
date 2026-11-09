import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkRepo, issueLinks, repoFromPackage, repoOfNpmPackage } from '../src/issue.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

describe('klatsch issue', () => {
  it('reads the repository from the forms npm accepts', () => {
    for (const form of ['git+https://github.com/o/r.git', 'https://github.com/o/r', 'https://github.com/o/r/tree/main/packages/x', 'git://github.com/o/r.git', 'git@github.com:o/r.git', 'git+ssh://git@github.com/o/r.git', 'github:o/r', 'o/r', { url: 'git+https://github.com/o/r.git', directory: 'x' }])
      assert.equal(repoFromPackage(form), 'o/r', JSON.stringify(form));
  });

  it('takes only github.com: a look-alike host or odd parts in a package’s metadata give no link', () => {
    for (const form of ['https://github.com.evil.example/o/r', 'https://evil.example/github.com/o/r', 'https://gitlab.com/o/r', 'gitlab:o/r', 'https://github.com/o', 'https://github.com/../r', '../../r', 'o/r/../x', 'o/r?x=1', 'o/r#x', 7, null, {}])
      assert.equal(repoFromPackage(form), undefined, JSON.stringify(form));
    for (const bad of ['o', 'o/r/x', 'o/..', '-o/r', 'o/r r', 'o/r?a'])
      assert.equal(checkRepo(bad), undefined, bad);
  });

  it('prefers the installed copy and asks the registry nothing then', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'klatsch-issue-'));
    mkdirSync(join(dir, 'node_modules', '@a', 'b'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '@a', 'b', 'package.json'), JSON.stringify({ repository: 'github:o/r' }));
    const never = (async () => assert.fail('no network')) as unknown as typeof fetch;
    assert.equal(await repoOfNpmPackage('@a/b', dir, never), 'o/r');
  });

  it('asks the registry only for the name, with no redirects, when it is not installed', async () => {
    const seen: { url: string; redirect?: string }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      seen.push({ url, redirect: init?.redirect as string });
      return new Response(JSON.stringify({ repository: { url: 'https://github.com/o/r.git' } }));
    }) as unknown as typeof fetch;
    assert.equal(await repoOfNpmPackage('@a/b', mkdtempSync(join(tmpdir(), 'klatsch-issue-')), fake), 'o/r');
    assert.deepEqual(seen, [{ url: 'https://registry.npmjs.org/@a%2Fb/latest', redirect: 'error' }]);
    await assert.rejects(repoOfNpmPackage('../evil', '/tmp', fake), /npm package name/);
  });

  it('builds a page to read, not a post: encoded links on github.com with the words in the query', () => {
    const links = issueLinks('o/r', 'Crash & burn on "x"', 'Steps:\n1. run it\n\nFix: use y #1');
    const page = new URL(links.new_issue_url);
    assert.equal(page.origin + page.pathname, 'https://github.com/o/r/issues/new');
    assert.equal(page.searchParams.get('title'), 'Crash & burn on "x"');
    assert.equal(page.searchParams.get('body'), 'Steps:\n1. run it\n\nFix: use y #1');
    assert.equal(new URL(links.search_url).searchParams.get('q'), 'is:issue Crash & burn on "x"');
    assert.match(links.note, /Nothing was posted/);
  });

  it('flags identifiers, and refuses hidden characters, a broken title and a body too long for a link', () => {
    assert.deepEqual(issueLinks('o/r', 'Fails', 'on db.acme.internal').flags.map((f) => f.kind), ['hostname']);
    assert.throws(() => issueLinks('o/r', 'Fails', 'see​this'), /invisible/);
    assert.throws(() => issueLinks('o/r', 'two\nlines', 'x'), /one line/);
    assert.throws(() => issueLinks('o/r', 'Fails', ' '), /--body/);
    assert.throws(() => issueLinks('o/r', 'Fails', 'x'.repeat(9000)), /too long/);
  });

  it('the command prints links and posts nothing: the source has no credential and no write', () => {
    const done = spawnSync(process.execPath, [CLI, 'issue', '--github', 'o/r', '--title', 'Fails', '--body', 'Steps'], { encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
    const output = JSON.parse(done.stdout) as { new_issue_url: string; repo: string };
    assert.equal(output.repo, 'o/r');
    assert.notEqual(spawnSync(process.execPath, [CLI, 'issue', '--github', 'o/r/x', '--title', 'F', '--body', 'S'], { encoding: 'utf8' }).status, 0);
    const none = spawnSync(process.execPath, [CLI, 'issue', '--title', 'F', '--body', 'S'], { encoding: 'utf8' });
    assert.match(none.stderr, /--package|--github/);
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'issue.ts'), 'utf8');
    assert.doesNotMatch(source, /method:|api\.github\.com|Authorization|execFile|spawn/);
  });
});
