import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KLATSCH_TOOLS, withKlatsch, withoutKlatsch } from '../src/claude-settings.ts';

const HOOK = "'/usr/bin/node' '/k/src/cli.ts' pending --hook '--user' 'bob'";

describe('connect: Claude Code settings', () => {
  const theirs = {
    model: 'opus',
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }] },
    permissions: { allow: ['Bash(npm test)'], deny: ['Bash(rm *)'] },
  };

  it('adds one reminder hook and the allow rules for exactly the Klatsch tools, keeping everything else', () => {
    const next = withKlatsch(theirs, HOOK);
    assert.deepEqual(KLATSCH_TOOLS, [
      'mcp__klatsch__update_card',
      'mcp__klatsch__find_matches',
      'mcp__klatsch__request_intro',
      'mcp__klatsch__respond_intro',
      'mcp__klatsch__ask_person',
      'mcp__klatsch__answer_ask',
      'mcp__klatsch__friends',
      'mcp__klatsch__add_friend',
      'mcp__klatsch__show_question',
      'mcp__klatsch__pending',
      'mcp__klatsch__inbox',
      'mcp__klatsch__watch',
      'mcp__klatsch__thank_note',
    ]);
    assert.deepEqual(next.permissions, { allow: ['Bash(npm test)', ...KLATSCH_TOOLS], deny: ['Bash(rm *)'] });
    assert.deepEqual((next.hooks as any).UserPromptSubmit, [
      { hooks: [{ type: 'command', command: 'echo mine' }] },
      { hooks: [{ type: 'command', command: HOOK, timeout: 10 }] },
    ]);
    assert.deepEqual((next.hooks as any).Stop, theirs.hooks.Stop);
    assert.equal(next.model, 'opus');
    assert.deepEqual(theirs.permissions.allow, ['Bash(npm test)'], 'the input is not changed');
  });

  it('is idempotent, and replaces an older mcp_tool hook', () => {
    const once = withKlatsch(theirs, HOOK);
    assert.deepEqual(withKlatsch(once, HOOK), once);
    const old = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'mcp_tool', server: 'klatsch', tool: 'pending', timeout: 5 }] }] } };
    assert.deepEqual((withKlatsch(old, HOOK).hooks as any).UserPromptSubmit, [{ hooks: [{ type: 'command', command: HOOK, timeout: 10 }] }]);
  });

  it('leaves shapes it does not expect alone when removing, and refuses to merge into them', () => {
    for (const odd of [{ hooks: null }, { hooks: { UserPromptSubmit: 'x' } }, { hooks: { UserPromptSubmit: [null, { hooks: 'x' }] } }, { permissions: { allow: 'x' } }, { permissions: null }]) {
      assert.deepEqual(withoutKlatsch(odd), odd, JSON.stringify(odd));
    }
    assert.throws(() => withKlatsch({ hooks: 'x' }, HOOK), /"hooks" in the settings is not an object/);
    assert.throws(() => withKlatsch({ permissions: { allow: 'x' } }, HOOK), /"permissions.allow" in the settings is not a list/);
  });

  it('disconnect removes exactly what connect added', () => {
    assert.deepEqual(withoutKlatsch(withKlatsch(theirs, HOOK)), theirs);
    assert.deepEqual(withoutKlatsch(withKlatsch({}, HOOK)), {});
    assert.deepEqual(withoutKlatsch({ permissions: { allow: ['mcp__klatsch__inbox', 'mcp__other__inbox'] } }), { permissions: { allow: ['mcp__other__inbox'] } });
  });
});
