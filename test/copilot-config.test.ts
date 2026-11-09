import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TOOL_NAMES } from '../src/claude-settings.ts';
import {
  copilotLocation,
  copilotPermissionsPath,
  hasCopilotServer,
  hasVscodeServer,
  withCopilotApprovals,
  withCopilotServer,
  withoutCopilotApprovals,
  withoutCopilotServer,
  withoutVscodeServer,
  withVscodeServer,
} from '../src/copilot-config.ts';

const PROXY = { command: 'node', args: ['/k/src/cli.ts', 'mcp-proxy', '--data', '/h/.klatsch', '--dir', '/p'] };

describe('connect: GitHub Copilot configs', () => {
  it('VS Code: one stdio proxy server in "servers", keeping theirs; disconnect removes exactly it', () => {
    const theirs = { inputs: [{ id: 'k', type: 'promptString', password: true }], servers: { docs: { type: 'http', url: 'https://docs.example/mcp' } } };
    const next = withVscodeServer(theirs, PROXY);
    assert.deepEqual(next.servers, { ...theirs.servers, klatsch: { type: 'stdio', ...PROXY } });
    assert.deepEqual(next.inputs, theirs.inputs);
    assert.ok(hasVscodeServer(next));
    assert.deepEqual(withVscodeServer(next, PROXY), next, 'idempotent');
    assert.deepEqual(withoutVscodeServer(next), theirs);
    assert.deepEqual(withoutVscodeServer(withVscodeServer({}, PROXY)), {});
    assert.doesNotMatch(JSON.stringify(next), /klt_|Authorization|headers/, 'no token and no header');
  });

  it('refuses a klatsch server it did not add, and leaves it alone on disconnect', () => {
    const manual = { servers: { klatsch: { type: 'http', url: 'https://k.example/mcp', headers: { Authorization: 'Bearer ${input:k}' } } } };
    assert.throws(() => withVscodeServer(manual, PROXY), /klatsch server that klatsch connect did not add/);
    assert.deepEqual(withoutVscodeServer(manual), manual);
    assert.equal(hasVscodeServer(manual), false);
    assert.throws(() => withVscodeServer({ servers: [] }, PROXY), /"servers" is not an object/);
  });

  it('Copilot CLI: "mcpServers" with tools and a timeout for a waiting approval; the bare format is refused', () => {
    const theirs = { mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp', tools: ['*'] } } };
    const next = withCopilotServer(theirs, PROXY);
    assert.deepEqual((next.mcpServers as any).klatsch, { type: 'stdio', ...PROXY, tools: ['*'], timeout: 180_000 });
    assert.ok(hasCopilotServer(next));
    assert.deepEqual(withoutCopilotServer(next), theirs);
    assert.deepEqual(withoutCopilotServer(withCopilotServer({}, PROXY)), {});
    assert.throws(() => withCopilotServer({ docs: { command: 'x', args: [] } }, PROXY), /without "mcpServers"/);
  });

  it('saved approvals: exactly the Klatsch tools at one location, removed again without touching others', () => {
    const theirs = {
      locations: {
        '/p': { tool_approvals: [{ kind: 'commands', commandIdentifiers: ['git status'] }], allowed_directories: ['/tmp'] },
        '/q': { tool_approvals: [{ kind: 'mcp', serverName: 'klatsch', toolName: 'inbox' }] },
      },
    };
    const next = withCopilotApprovals(theirs, '/p');
    const here = (next.locations as any)['/p'];
    assert.deepEqual(
      here.tool_approvals.slice(1),
      TOOL_NAMES.map((toolName) => ({ kind: 'mcp', serverName: 'klatsch', toolName })),
    );
    assert.deepEqual(withCopilotApprovals(next, '/p'), next, 'idempotent');
    assert.deepEqual(withoutCopilotApprovals(next, '/p'), theirs, 'only this location, everything else kept');
    assert.deepEqual(withoutCopilotApprovals(withCopilotApprovals({}, '/p'), '/p'), {});
    assert.throws(() => withCopilotApprovals({ locations: { '/p': { tool_approvals: 'x' } } }, '/p'), /"tool_approvals" is not a list/);
  });

  it('approvals are keyed by the Git root above the directory, else the directory; COPILOT_HOME moves the file', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'klatsch-copilot-')));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, 'app', 'web'), { recursive: true });
    assert.equal(copilotLocation(join(repo, 'app', 'web')), repo);
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'klatsch-copilot-')));
    assert.equal(copilotLocation(plain), plain);
    assert.equal(copilotPermissionsPath({ COPILOT_HOME: '/c' }), '/c/permissions-config.json');
    assert.equal(copilotPermissionsPath({ HOME: '/x' }).endsWith('/.copilot/permissions-config.json'), true);
  });
});
