// What a release publishes besides the code: the npm manifest, the MCP Registry entry (server.json) and the
// Claude Code plugin. They name one version, the same package and endpoint, and carry no credential.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..');
const json = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const pkg = json('package.json');
const server = json('server.json');
const plugin = json('plugin/.claude-plugin/plugin.json');
const pluginMcp = json('plugin/.mcp.json');
const marketplace = json('.claude-plugin/marketplace.json');

describe('release metadata', () => {
  it('npm: public, a JavaScript bin, the files allow-list and the registry name', () => {
    assert.equal(pkg.private, undefined);
    assert.deepEqual(pkg.bin, { klatsch: 'dist/cli.js' }, 'Node does not strip types under node_modules');
    assert.ok(pkg.files.includes('dist/') && pkg.files.includes('schema/'));
    assert.ok(!pkg.files.some((entry: string) => /^(src|test|deploy|docs|scripts)\b/.test(entry)));
    assert.equal(pkg.repository.url, 'git+https://github.com/gizemsoylutr/klatsch.git', 'npm Trusted Publishing checks it against the workflow');
    assert.equal(pkg.mcpName, server.name, 'the MCP Registry verifies the npm package by mcpName');
  });

  it('one version everywhere', () => {
    assert.equal(server.version, pkg.version);
    assert.equal(server.packages[0].version, pkg.version);
    assert.equal(plugin.version, pkg.version);
    assert.equal(pluginMcp.mcpServers.klatsch.args[1], `klatsch@${pkg.version}`);
  });

  it('server.json: the dated schema, the domain namespace, the hosted endpoint and the npm package', () => {
    assert.match(server.$schema, /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/);
    assert.equal(server.name, 'dev.klatsch/klatsch');
    assert.ok(server.description.length <= 100, 'the registry allows 100 characters');
    assert.deepEqual(
      server.remotes.map((remote: { type: string; url: string }) => [remote.type, remote.url]),
      [['streamable-http', 'https://klatsch.dev/mcp']],
    );
    assert.equal(server.packages[0].registryType, 'npm');
    assert.equal(server.packages[0].identifier, pkg.name);
  });

  it('the plugin runs the proxy for the hosted relay, with no path or token in it', () => {
    assert.equal(marketplace.plugins[0].source, './plugin');
    assert.equal(plugin.name, marketplace.plugins[0].name);
    // A stdio server: Claude Code starts it in the project with CLAUDE_PROJECT_DIR set, and passes the
    // arguments without a shell. A headersHelper would run in the plugin's folder, through a shell.
    assert.deepEqual(pluginMcp.mcpServers.klatsch, { type: 'stdio', command: 'npx', args: ['-y', `klatsch@${pkg.version}`, 'mcp-proxy', '--url', 'https://klatsch.dev'] });
    for (const file of ['plugin/.mcp.json', 'plugin/.claude-plugin/plugin.json', 'plugin/skills/klatsch/SKILL.md']) {
      assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /klt_|Bearer /, `${file} holds no token`);
    }
  });
});
