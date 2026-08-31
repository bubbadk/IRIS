import { describe, expect, it } from 'vitest';
import { applyAgentConfiguration } from './agentConfiguration';

describe('agent configuration', () => {
  it('updates editable configuration while preserving identity and stored skill assignments', () => {
    expect(
      applyAgentConfiguration(
        {
          id: 'agent-1',
          name: 'Old name',
          description: 'Old description',
          providerPolicyId: 'old-provider',
          model: 'old-model',
          autonomy: 'observe',
          memoryAccess: 'none',
          skillIds: ['stored-skill'],
          toolIds: [],
        },
        {
          name: '  Researcher  ',
          description: '  Investigates local material.  ',
          providerPolicyId: ' provider-1 ',
          model: ' model-1 ',
          autonomy: 'assist',
          memoryAccess: 'read',
          approvalMode: 'ask',
          reasoningEffort: 'none',
          toolIds: ['workspace.read', 'workspace.search', 'workspace.read'],
        },
      ),
    ).toEqual({
      id: 'agent-1',
      name: 'Researcher',
      description: 'Investigates local material.',
      providerPolicyId: 'provider-1',
      model: 'model-1',
      takeoverProviderPolicyId: undefined,
      takeoverModel: undefined,
      autonomy: 'assist',
      memoryAccess: 'read',
      approvalMode: 'ask',
      reasoningEffort: undefined,
      skillIds: ['stored-skill'],
      toolIds: ['workspace.read', 'workspace.search'],
    });
  });

  it('stores a chosen reasoning effort and treats none as unset', () => {
    const agent = {
      id: 'agent-1',
      name: 'Researcher',
      autonomy: 'assist' as const,
      skillIds: [],
      toolIds: [],
    };
    const base = {
      name: 'Researcher',
      description: '',
      providerPolicyId: '',
      model: '',
      autonomy: 'assist' as const,
      memoryAccess: 'none' as const,
      approvalMode: 'ask' as const,
      toolIds: [],
    };

    expect(
      applyAgentConfiguration(agent, { ...base, reasoningEffort: 'high' }).reasoningEffort,
    ).toBe('high');
    expect(
      applyAgentConfiguration(agent, { ...base, reasoningEffort: 'none' }).reasoningEffort,
    ).toBeUndefined();
  });

  it('replaces skill assignments only when the editor supplies them', () => {
    const agent = {
      id: 'agent-1',
      name: 'Researcher',
      autonomy: 'assist' as const,
      memoryAccess: 'none' as const,
      approvalMode: 'ask' as const,
      skillIds: ['stored-skill'],
      toolIds: [],
    };
    const base = {
      name: 'Researcher',
      description: '',
      providerPolicyId: '',
      model: '',
      autonomy: 'assist' as const,
      memoryAccess: 'none' as const,
      approvalMode: 'ask' as const,
      reasoningEffort: 'none' as const,
      toolIds: [],
    };

    expect(
      applyAgentConfiguration(agent, {
        ...base,
        skillIds: ['skill-a', 'skill-b', 'skill-a'],
      }).skillIds,
    ).toEqual(['skill-a', 'skill-b']);
    expect(applyAgentConfiguration(agent, { ...base, skillIds: [] }).skillIds).toEqual([]);
    expect(applyAgentConfiguration(agent, base).skillIds).toEqual(['stored-skill']);
  });

  it('persists YOLO as an explicit per-agent approval mode', () => {
    const agent = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'act' as const,
      skillIds: [],
      toolIds: ['files.read'],
    };

    expect(
      applyAgentConfiguration(agent, {
        name: 'Operator',
        description: '',
        providerPolicyId: '',
        model: '',
        autonomy: 'act',
        memoryAccess: 'none',
        approvalMode: 'yolo',
        reasoningEffort: 'none',
        toolIds: ['files.read'],
      }).approvalMode,
    ).toBe('yolo');
  });

  it('clears optional text fields without inventing configuration', () => {
    expect(
      applyAgentConfiguration(
        {
          id: 'agent-1',
          name: 'Agent',
          description: 'Description',
          providerPolicyId: 'provider-1',
          model: 'model-1',
          autonomy: 'assist',
          skillIds: [],
          toolIds: [],
        },
        {
          name: 'Agent',
          description: ' ',
          providerPolicyId: '',
          model: '',
          autonomy: 'assist',
          memoryAccess: 'none',
          approvalMode: 'ask',
          reasoningEffort: 'none',
          toolIds: [],
        },
      ),
    ).toMatchObject({
      description: undefined,
      providerPolicyId: undefined,
      model: undefined,
    });
  });

  it('rejects a blank agent name', () => {
    expect(() =>
      applyAgentConfiguration(
        {
          id: 'agent-1',
          name: 'Agent',
          autonomy: 'assist',
          skillIds: [],
          toolIds: [],
        },
        {
          name: '   ',
          description: '',
          providerPolicyId: '',
          model: '',
          autonomy: 'assist',
          memoryAccess: 'none',
          approvalMode: 'ask',
          reasoningEffort: 'none',
          toolIds: [],
        },
      ),
    ).toThrow('Give your agent a name.');
  });
});
