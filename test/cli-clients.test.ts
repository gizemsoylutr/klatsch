import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { agentTokenPath, readAgentToken } from '../src/agent-token.ts';
import { tokensOf, verifyToken } from '../src/auth/tokens.ts';
import { TOOL_NAMES } from '../src/claude-settings.ts';
import { loadConfig, loadSecret } from '../src/config.ts';
import { seedVocabulary } from '../src/match/vocabulary.ts';
import { Klatsch } from '../src/service.ts';
import { openDb } from '../src/store/db.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'klatsch-clients-')));
const TOKEN = `klt_${'B'.repeat(43)}`;

/** Every file under `dir`, recursively, as text. */
const allText = (dir: string): string =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), 'utf8')).join('\n') : '';

/**
 * A data dir with Bob in a circle, a project dir, a temp HOME and COPILOT_HOME (never the real ones), and fake
 * `claude`, `codex`, `code` and `copilot` on PATH that record any call: only Claude Code is set up by a command.
 */
function world() {
  const data = fresh();
  const project = fresh();
  const home = fresh();
  const bin = fresh();
  const log = join(bin, 'calls.log');
  for (const name of ['claude', 'codex', 'code', 'copilot']) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> '${log}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\necho ---- >> '${log}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const db = openDb(join(data, 'klatsch.db'));
  seedVocabulary(db);
  const klatsch = new Klatsch(db, loadConfig({ dataDir: data }), () => {});
  const bob = klatsch.ensureUser('bob', 'Bob');
  klatsch.addMember(klatsch.ensureCircle('demo', bob), klatsch.ensureUser('carol', 'Carol'), bob);
  db.close();
  const env = { ...process.env, HOME: home, COPILOT_HOME: join(home, '.copilot'), KLATSCH_TOKEN: '', PATH: `${bin}:${process.env.PATH}`, PWD: project };
  const run = (args: string[], input = '', cwd = project) => spawnSync('node', [CLI, ...args, '--data', data], { cwd, encoding: 'utf8', input, env: { ...env, PWD: cwd }, timeout: 15_000 });
  const cli = (...args: string[]) => run([...args, '--user', 'bob']);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  const json = (path: string) => JSON.parse(readFileSync(join(project, path), 'utf8'));
  const live = (token: string) => {
    const check = openDb(join(data, 'klatsch.db'));
    const verified = verifyToken(check, loadSecret(data), token);
    check.close();
    return Boolean(verified);
  };
  /** Nothing connect wrote, in the project or in HOME, holds the token. */
  const noTokenWritten = () => {
    const token = readAgentToken(data, project)?.token ?? TOKEN;
    for (const where of [project, home]) assert.ok(!allText(where).includes(token), `no token under ${where}`);
    assert.doesNotMatch(calls(), /klt_/, 'no token on any command line');
  };
  return { data, project, home, env, run, cli, calls, json, live, noTokenWritten };
}

describe('klatsch connect --client', () => {
  it('codex: a project .codex/config.toml block with the header helper and tool approvals, and the reminder hook', () => {
    const w = world();
    const connected = w.cli('connect', '--client', 'codex');
    assert.equal(connected.status, 0, connected.stderr);
    assert.match(connected.stdout, /run \/hooks to trust the Klatsch hook/);
    assert.doesNotMatch(connected.stdout + connected.stderr, /klt_/);
    assert.equal(w.calls(), '', 'no client command was run');
    w.noTokenWritten();

    const toml = readFileSync(join(w.project, '.codex', 'config.toml'), 'utf8');
    const helper = JSON.parse(toml.match(/^http_headers_helper = (".*")$/m)![1]!) as string;
    assert.equal(helper, `node '${CLI}' token-header --url 'http://127.0.0.1:7417' --data '${w.data}' --dir '${w.project}'`);
    assert.match(toml, /^url = "http:\/\/127\.0\.0\.1:7417\/mcp"$/m);
    assert.deepEqual([...toml.matchAll(/^\[mcp_servers\.klatsch\.tools\.(\w+)\]\napproval_mode = "approve"$/gm)].map((m) => m[1]), TOOL_NAMES);
    // As Codex runs it: `sh -c`, from another directory, with only a few variables of the environment.
    const header = execFileSync('sh', ['-c', helper], { cwd: w.home, env: { PATH: process.env.PATH!, HOME: w.home }, encoding: 'utf8' });
    const agent = readAgentToken(w.data, w.project)!;
    assert.deepEqual(JSON.parse(header), { Authorization: `Bearer ${agent.token}` });
    assert.ok(w.live(agent.token));
    assert.deepEqual(w.json('.codex/hooks.json'), {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node '${CLI}' pending --hook --data '${w.data}' --dir '${w.project}'`, timeout: 10 }] }] },
    });

    const disconnected = w.cli('disconnect', '--client', 'codex');
    assert.equal(disconnected.status, 0, disconnected.stderr);
    assert.equal(existsSync(join(w.project, '.codex')), false, 'connect created .codex/, disconnect removes it');
    assert.equal(existsSync(agentTokenPath(w.data, w.project)), false);
    assert.equal(w.live(agent.token), false);
  });

  it('codex: their config and hooks stay as they were; a klatsch server it did not add stops connect before any change', () => {
    const w = world();
    mkdirSync(join(w.project, '.codex'));
    const theirs = 'model = "o5"\n\n[mcp_servers.docs]\nurl = "https://docs.example/mcp"\n';
    const hooks = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] } };
    writeFileSync(join(w.project, '.codex', 'config.toml'), theirs);
    writeFileSync(join(w.project, '.codex', 'hooks.json'), JSON.stringify(hooks));
    assert.equal(w.cli('connect', '--client', 'codex').status, 0);
    assert.equal(w.cli('connect', '--client', 'codex').status, 0, 'again: idempotent');
    assert.equal(w.cli('disconnect').status, 0, 'without --client: every connected client');
    assert.equal(readFileSync(join(w.project, '.codex', 'config.toml'), 'utf8'), theirs);
    assert.deepEqual(w.json('.codex/hooks.json'), hooks);

    writeFileSync(join(w.project, '.codex', 'config.toml'), `${theirs}\n[mcp_servers.klatsch]\nurl = "https://elsewhere.example/mcp"\n`);
    const refused = w.cli('connect', '--client', 'codex');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /config\.toml already has a klatsch MCP server that klatsch connect did not add/);
    assert.equal(existsSync(agentTokenPath(w.data, w.project)), false, 'no token file');
  });

  it('copilot-vscode: a stdio proxy server in .vscode/mcp.json, no token, no header; JSONC is refused, not rewritten', () => {
    const w = world();
    const connected = w.cli('connect', '--client', 'copilot-vscode');
    assert.equal(connected.status, 0, connected.stderr);
    assert.match(connected.stdout, /Always allow/);
    assert.equal(w.calls(), '');
    w.noTokenWritten();
    assert.deepEqual(w.json('.vscode/mcp.json'), {
      servers: { klatsch: { type: 'stdio', command: 'node', args: [CLI, 'mcp-proxy', '--url', 'http://127.0.0.1:7417', '--data', w.data, '--dir', w.project] } },
    });
    assert.equal(w.cli('disconnect', '--client', 'copilot-vscode').status, 0);
    assert.equal(existsSync(join(w.project, '.vscode')), false);

    const jsonc = '{\n  // my servers\n  "servers": {},\n}\n';
    mkdirSync(join(w.project, '.vscode'));
    writeFileSync(join(w.project, '.vscode', 'mcp.json'), jsonc);
    const refused = w.cli('connect', '--client', 'copilot-vscode');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /mcp\.json is not plain JSON \(comments or trailing commas\?\): klatsch connect does not rewrite it/);
    assert.equal(readFileSync(join(w.project, '.vscode', 'mcp.json'), 'utf8'), jsonc);
    assert.equal(existsSync(agentTokenPath(w.data, w.project)), false);
    assert.equal(w.cli('disconnect').status, 0, 'a JSONC file with nothing of ours does not stop disconnect');
  });

  it('copilot-cli: .mcp.json with the proxy, and saved approvals for exactly the Klatsch tools in COPILOT_HOME', () => {
    const w = world();
    const connected = w.cli('connect', '--client', 'copilot-cli');
    assert.equal(connected.status, 0, connected.stderr);
    assert.equal(w.calls(), '');
    w.noTokenWritten();
    assert.deepEqual(w.json('.mcp.json').mcpServers.klatsch, {
      type: 'stdio',
      command: 'node',
      args: [CLI, 'mcp-proxy', '--url', 'http://127.0.0.1:7417', '--data', w.data, '--dir', w.project],
      tools: ['*'],
      timeout: 180_000,
    });
    const permissions = JSON.parse(readFileSync(join(w.home, '.copilot', 'permissions-config.json'), 'utf8'));
    assert.deepEqual(permissions, { locations: { [w.project]: { tool_approvals: TOOL_NAMES.map((toolName) => ({ kind: 'mcp', serverName: 'klatsch', toolName })) } } });

    assert.equal(w.cli('disconnect', '--client', 'copilot-cli').status, 0);
    assert.equal(existsSync(join(w.project, '.mcp.json')), false);
    assert.ok(existsSync(w.project), 'the (now empty) project folder itself stays');
    assert.equal(existsSync(join(w.home, '.copilot', 'permissions-config.json')), false);
  });

  it('two clients in one directory share the token: disconnecting one keeps it, the last one revokes it', () => {
    const w = world();
    assert.equal(w.cli('connect').status, 0);
    const connected = w.cli('connect', '--client', 'codex');
    assert.match(connected.stdout, /also for claude, with the new token/);
    const token = readAgentToken(w.data, w.project)!.token;

    const one = w.cli('disconnect', '--client', 'codex');
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, /kept the token, still used here by claude/);
    assert.ok(w.live(token));
    assert.equal(readAgentToken(w.data, w.project)?.token, token);
    assert.ok(w.json('.claude/settings.local.json').hooks, 'Claude Code is still connected');

    const last = w.cli('disconnect');
    assert.equal(last.status, 0, last.stderr);
    assert.match(last.stdout, /revoked 1 token\(s\)/);
    assert.equal(w.live(token), false);
    assert.equal(existsSync(agentTokenPath(w.data, w.project)), false);
  });

  it('records for the Tokens page which clients a token serves and the folder\'s name, never its path', () => {
    const w = world();
    assert.equal(w.cli('connect').status, 0);
    assert.equal(w.cli('connect', '--client', 'codex').status, 0);
    const db = openDb(join(w.data, 'klatsch.db'));
    const bob = (db.prepare("SELECT id FROM users WHERE handle = 'bob'").get() as { id: string }).id;
    const stored = db.prepare('SELECT clients, project FROM tokens WHERE revoked_at IS NULL').all() as { clients: string; project: string }[];
    const [live, replaced] = tokensOf(db, bob);
    db.close();
    assert.deepEqual(stored.map((row) => ({ ...row })), [{ clients: '["codex","claude"]', project: basename(w.project) }], 'both clients here read the one token');
    assert.deepEqual({ name: live!.name, clients: live!.clients }, { name: basename(w.project), clients: ['codex', 'claude'] });
    assert.deepEqual({ name: replaced!.name, clients: replaced!.clients }, { name: basename(w.project), clients: ['claude'] });
    assert.ok(!JSON.stringify(stored).includes(w.project), 'no path is recorded for the page');
  });

  it('a hosted relay works for every client, with the token from stdin; an unknown client is refused', () => {
    for (const client of ['codex', 'copilot-vscode', 'copilot-cli']) {
      const w = world();
      const connected = w.run(['connect', '--url', 'https://klatsch.example', '--token', '-', '--client', client], `${TOKEN}\n`);
      assert.equal(connected.status, 0, connected.stderr);
      assert.deepEqual(readAgentToken(w.data, w.project), { url: 'https://klatsch.example', token: TOKEN });
      w.noTokenWritten();
      const disconnected = w.run(['disconnect', '--client', client]);
      assert.match(disconnected.stdout, /Revoke the token on https:\/\/klatsch\.example\/ui\/tokens/);
      assert.equal(existsSync(agentTokenPath(w.data, w.project)), false);
    }
    const w = world();
    const refused = w.cli('connect', '--client', 'cursor');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /--client is one of claude, codex, copilot-vscode, copilot-cli/);
  });

  it('copilot-cli: approvals cover the whole repository, so disconnecting one folder in it keeps them and says so', () => {
    const w = world();
    execFileSync('git', ['init', '-q', w.project]);
    const a = join(w.project, 'a');
    const b = join(w.project, 'b');
    mkdirSync(a);
    mkdirSync(b);
    for (const dir of [a, b]) assert.equal(w.run(['connect', '--client', 'copilot-cli', '--user', 'bob'], '', dir).status, 0);
    const path = join(w.home, '.copilot', 'permissions-config.json');
    const saved = readFileSync(path, 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(saved).locations), [w.project], 'keyed by the git root, once');

    const one = w.run(['disconnect', '--client', 'copilot-cli', '--user', 'bob'], '', a);
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, /Kept the Klatsch tool approvals for .* they cover the whole repository/);
    assert.equal(readFileSync(path, 'utf8'), saved, 'b still uses them');
    assert.equal(existsSync(join(a, '.mcp.json')), false);
    assert.ok(existsSync(join(b, '.mcp.json')));
  });

  it('warns when a file connect wrote is not ignored by git, and not once it is', () => {
    const w = world();
    execFileSync('git', ['init', '-q', w.project]);
    const warned = w.cli('connect', '--client', 'codex');
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stderr, /\.codex\/config\.toml is not ignored by git\. It holds paths on this machine, not the token/);
    writeFileSync(join(w.project, '.git', 'info', 'exclude'), '.codex/\n');
    assert.doesNotMatch(w.cli('connect', '--client', 'codex').stderr, /not ignored by git/);
    const outside = world();
    assert.doesNotMatch(outside.cli('connect', '--client', 'codex').stderr, /git/, 'outside a repository, nothing to say');
  });

  it('disconnect cleans leftovers: approvals after .mcp.json was deleted; a file that turned JSONC with our entry is refused by name', () => {
    const w = world();
    assert.equal(w.cli('connect', '--client', 'copilot-cli').status, 0);
    rmSync(join(w.project, '.mcp.json'));
    assert.equal(w.cli('disconnect').status, 0);
    assert.equal(existsSync(join(w.home, '.copilot', 'permissions-config.json')), false, 'the approvals went too');

    assert.equal(w.cli('connect', '--client', 'copilot-vscode').status, 0);
    const path = join(w.project, '.vscode', 'mcp.json');
    writeFileSync(path, `// mine\n${readFileSync(path, 'utf8')}`);
    const refused = w.cli('disconnect');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /mcp\.json still has what klatsch connect added, but is no longer plain JSON/);
  });

  it("connecting a directory as another person revokes the previous person's token for it", () => {
    const w = world();
    assert.equal(w.cli('connect').status, 0);
    const bobs = readAgentToken(w.data, w.project)!.token;
    assert.equal(w.run(['connect', '--user', 'carol']).status, 0);
    assert.equal(w.live(bobs), false, "Bob's token for this directory is revoked");
    assert.ok(w.live(readAgentToken(w.data, w.project)!.token));
  });

  it("run from npx's cache, connect writes `npx -y klatsch@<version>`, never a path into the cache", () => {
    const w = world();
    // The package as npx unpacks it: a folder under `_npx` (outside node_modules, so Node runs the .ts sources).
    const root = join(import.meta.dirname, '..');
    const cached = join(fresh(), '_npx', 'f00d', 'klatsch');
    mkdirSync(cached, { recursive: true });
    cpSync(join(root, 'src'), join(cached, 'src'), { recursive: true });
    cpSync(join(root, 'package.json'), join(cached, 'package.json'));
    // The dependencies where this checkout resolves them (its own node_modules or one further up).
    const modules = fileURLToPath(import.meta.resolve('hono')).replace(/(\/node_modules)\/.*$/, '$1');
    symlinkSync(modules, join(cached, 'node_modules'));
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
    const connected = spawnSync('node', [join(cached, 'src', 'cli.ts'), 'connect', '--user', 'bob', '--client', 'codex', '--data', w.data], {
      cwd: w.project,
      encoding: 'utf8',
      env: w.env,
    });
    assert.equal(connected.status, 0, connected.stderr);
    const toml = readFileSync(join(w.project, '.codex', 'config.toml'), 'utf8');
    assert.equal(JSON.parse(toml.match(/^http_headers_helper = (".*")$/m)![1]!), `npx -y klatsch@${version} token-header --url 'http://127.0.0.1:7417' --data '${w.data}' --dir '${w.project}'`);
    assert.ok(!allText(join(w.project, '.codex')).includes('_npx'), 'no path into the cache');
  });
});
