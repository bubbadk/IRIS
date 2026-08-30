import { describe, expect, it, vi } from 'vitest';
import type { PermissionRule, PermissionRuleRepository, ToolDefinition } from '@iris/tools';
import {
  agentToolRuleId,
  editableAgentToolPolicies,
  ensureAssignedToolsRequireApproval,
  saveAgentToolPolicies,
} from './agentPermissions';

const tools: ToolDefinition[] = [
  { id: 'memory.remember', name: 'Remember', description: 'Writes memory.', risk: 'write' },
  { id: 'workspace.read', name: 'Read file', description: 'Reads a file.', risk: 'read' },
];

const agent = {
  id: 'agent-1',
  name: 'IRIS',
  autonomy: 'assist' as const,
  skillIds: [],
  toolIds: ['memory.remember'],
};

describe('agent tool policies', () => {
  it('defaults assigned tools without a rule to explicit per-invocation approval', () => {
    expect(editableAgentToolPolicies(agent, tools, [])).toEqual({
      'memory.remember': 'ask',
      'workspace.read': '',
    });
    expect(
      editableAgentToolPolicies(agent, tools, [
        {
          id: agentToolRuleId(agent.id, 'memory.remember'),
          agentId: agent.id,
          toolId: 'memory.remember',
          decision: 'allow',
        },
      ]),
    ).toMatchObject({ 'memory.remember': 'allow' });
  });

  it('persists policies only for assigned tools and removes latent authority', async () => {
    const stored: PermissionRule[] = [];
    const repository: PermissionRuleRepository = {
      list: async () => stored,
      save: vi.fn(async (rule) => {
        stored.push(rule);
      }),
      remove: vi.fn(async () => undefined),
    };

    await saveAgentToolPolicies(repository, agent, tools, {
      'memory.remember': 'ask',
      'workspace.read': 'allow',
    });

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent:agent-1:tool:memory.remember',
        decision: 'ask',
        reason: expect.stringContaining('approval each time'),
      }),
    );
    expect(repository.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ toolId: 'workspace.read' }),
    );
    expect(repository.remove).toHaveBeenCalledWith('agent:agent-1:tool:workspace.read');
  });

  it('migrates assigned tools without authority to safe inline approval', async () => {
    const repository: PermissionRuleRepository = {
      list: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    await ensureAssignedToolsRequireApproval(repository, [agent], tools, []);
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent:agent-1:tool:memory.remember',
        decision: 'ask',
      }),
    );

    vi.mocked(repository.save).mockClear();
    await ensureAssignedToolsRequireApproval(repository, [agent], tools, [
      { id: 'global-deny', agentId: '*', toolId: '*', decision: 'deny' },
    ]);
    expect(repository.save).not.toHaveBeenCalled();
  });
});
