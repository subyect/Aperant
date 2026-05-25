import { describe, expect, it } from 'vitest';

import { buildToolRegistry } from '../build-registry';
import type { SecurityProfile } from '../../security/bash-validator';

const securityProfile: SecurityProfile = {
  baseCommands: new Set(),
  stackCommands: new Set(),
  scriptCommands: new Set(),
  customCommands: new Set(),
  customScripts: { shellScripts: [] },
  getAllAllowedCommands() {
    return new Set();
  },
};

describe('buildToolRegistry', () => {
  it('registers auto-claude status tools as in-process tools', () => {
    const registry = buildToolRegistry();
    const names = registry.getRegisteredNames();

    expect(names).toContain('mcp__auto-claude__update_subtask_status');
    expect(names).toContain('mcp__auto-claude__get_build_progress');
    expect(names).toContain('mcp__auto-claude__get_session_context');
  });

  it('exposes auto-claude tools to agents that are allowed to use them', () => {
    const registry = buildToolRegistry();
    const tools = registry.getToolsForAgent('coder', {
      cwd: '/tmp/project',
      projectDir: '/tmp/project',
      specDir: '/tmp/project/.auto-claude/specs/001-demo',
      securityProfile,
    });

    expect(Object.keys(tools)).toContain('mcp__auto-claude__update_subtask_status');
  });

  it('does not expose auto-claude tools to read-only insights chat', () => {
    const registry = buildToolRegistry();
    const tools = registry.getToolsForAgent('insights', {
      cwd: '/tmp/project',
      projectDir: '/tmp/project',
      specDir: '/tmp/project/.auto-claude/specs/001-demo',
      securityProfile,
    });

    expect(Object.keys(tools)).not.toContain('mcp__auto-claude__update_subtask_status');
  });
});
