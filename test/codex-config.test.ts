import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasKlatschToml, withKlatschToml, withoutKlatschToml } from '../src/codex-config.ts';
import { TOOL_NAMES } from '../src/claude-settings.ts';

const URL = 'http://127.0.0.1:7417/mcp';
const HELPER = "node '/k/src/cli.ts' token-header --data '/h/.klatsch' --dir '/p/it''s \"here\"'";

describe('connect: Codex config.toml', () => {
  const theirs = 'model = "o5"\n\n[mcp_servers.docs]\nurl = "https://docs.example/mcp"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo stop"\n';

  it('appends one block with the server, the header helper and approve for exactly the Klatsch tools', () => {
    const next = withKlatschToml(theirs, URL, HELPER);
    assert.ok(next.startsWith(theirs), 'their text stays byte for byte');
    const block = next.slice(theirs.length);
    assert.match(block, /^\n# >>> klatsch:/);
    assert.match(block, /\n\[mcp_servers\.klatsch\]\nurl = "http:\/\/127\.0\.0\.1:7417\/mcp"\n/);
    assert.ok(block.includes(`http_headers_helper = ${JSON.stringify(HELPER)}\n`), 'the helper as a TOML basic string');
    assert.deepEqual(
      [...block.matchAll(/^\[mcp_servers\.klatsch\.tools\.([a-z_]+)\]\napproval_mode = "approve"$/gm)].map((m) => m[1]),
      TOOL_NAMES,
    );
    assert.doesNotMatch(block, /klt_|bearer|http_headers =/i, 'no token and no static header');
    assert.ok(hasKlatschToml(next));
  });

  it('is idempotent, and disconnect removes exactly the block', () => {
    const once = withKlatschToml(theirs, URL, HELPER);
    assert.equal(withKlatschToml(once, URL, HELPER), once);
    assert.equal(withoutKlatschToml(once), theirs);
    assert.equal(withoutKlatschToml(withKlatschToml('', URL, HELPER)), '');
    assert.equal(withoutKlatschToml(theirs), theirs);
    assert.equal(hasKlatschToml(theirs), false);
    const moved = withKlatschToml(once, 'https://klatsch.example/mcp', HELPER);
    assert.equal((moved.match(/\[mcp_servers\.klatsch\]/g) ?? []).length, 1, 'a reconnect replaces the block');
    assert.match(moved, /url = "https:\/\/klatsch\.example\/mcp"/);
  });

  it('refuses a klatsch server it did not add, and an inline mcp_servers table', () => {
    for (const toml of [
      '[mcp_servers.klatsch]\nurl = "x"\n',
      '[mcp_servers."klatsch"]\nurl = "x"\n',
      '[mcp_servers.klatsch.tools.inbox]\napproval_mode = "prompt"\n',
      '[mcp_servers]\nklatsch = { url = "x" }\n',
      'mcp_servers.klatsch.url = "x"\n',
      'mcp_servers = { docs = { url = "x" } }\n',
    ]) {
      assert.throws(() => withKlatschToml(toml, URL, HELPER), /klatsch MCP server that klatsch connect did not add|mcp_servers inline/, toml);
    }
    assert.doesNotThrow(() => withKlatschToml('[projects."/home/me/klatsch"]\ntrust_level = "trusted"\nnotify = ["klatsch"]\n', URL, HELPER));
  });
});
