import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '@iris/core';
import type { AgentProviderResolver, AgentRepository, AgentToolRuntime } from '@iris/agents';
import type { ModelProvider } from '@iris/providers';
import { createSubAgentTool, validateSubAgentInput, subAgentToolId } from './subagentTool';

function createMockProvider(output = 'Sub-agent analysis complete.'): ModelProvider {
  return {
    definition: {
      id: 'mock-provider',
      name: 'Mock Provider',
      kind: 'openai-compatible',
      capabilities: ['chat', 'streaming'],
      local: true,
    },
    capabilities: () => ['chat', 'streaming'],
    testConnection: async () => {},
    async *stream() {
      yield { text: output, done: false };
      yield { text: '', done: true };
    },
  };
}

describe('subagentTool input validation', () => {
  it('accepts valid sub-agent input with role, objective and instructions', () => {
    expect(
      validateSubAgentInput({
        role: 'Code Reviewer',
        objective: 'Review security rules',
        instructions: 'Check for open write access',
      }),
    ).toBe(true);
  });

  it('rejects missing or empty required fields', () => {
    expect(validateSubAgentInput(null)).toBe(false);
    expect(validateSubAgentInput({})).toBe(false);
    expect(
      validateSubAgentInput({
        role: '',
        objective: 'Analyze',
        instructions: 'Do work',
      }),
    ).toBe(false);
    expect(
      validateSubAgentInput({
        role: 'Researcher',
        objective: '',
        instructions: 'Do work',
      }),
    ).toBe(false);
  });
});

describe('subagentTool execution', () => {
  const parentAgent: AgentDefinition = {
    id: 'parent-agent-1',
    name: 'Lead Architect',
    providerPolicyId: 'mock-provider',
    model: 'mock-model',
    persona: 'Lead Architect',
    reasoningEffort: 'medium',
    autonomy: 'operate',
    approvalMode: 'ask',
    toolIds: [subAgentToolId, 'workspace.read'],
    skillIds: [],
  };

  const agentRepository: AgentRepository = {
    list: async () => [parentAgent],
    get: async (id) => (id === parentAgent.id ? parentAgent : null),
    save: async () => {},
    remove: async () => {},
  };

  it('executes a specialized sub-agent and aggregates its result', async () => {
    const mockProvider = createMockProvider('Found 3 security findings.');
    const resolver: AgentProviderResolver = {
      resolve: async () => ({ provider: mockProvider, model: 'mock-model' }),
    };
    const toolRuntime: AgentToolRuntime = {
      definitions: () => [],
      execute: async () => ({ status: 'completed', output: 'ok' }),
      resolve: async () => ({ status: 'completed', output: 'ok' }),
    };

    const tool = createSubAgentTool({
      agentRepository,
      providerResolver: resolver,
      agentToolRuntime: toolRuntime,
    });

    const result = await tool.run(
      {
        role: 'Security Reviewer',
        objective: 'Audit permissions',
        instructions: 'Check for wildcards',
      },
      { agentId: parentAgent.id, agentName: parentAgent.name },
    );

    expect(result).toMatchObject({
      status: 'completed',
      role: 'Security Reviewer',
      objective: 'Audit permissions',
      output: 'Found 3 security findings.',
    });
  });

  it('enforces recursion depth limits to prevent infinite sub-agent loops', async () => {
    const mockProvider = createMockProvider('Done');
    const resolver: AgentProviderResolver = {
      resolve: async () => ({ provider: mockProvider, model: 'mock-model' }),
    };
    const toolRuntime: AgentToolRuntime = {
      definitions: () => [],
      execute: async () => ({ status: 'completed', output: 'ok' }),
      resolve: async () => ({ status: 'completed', output: 'ok' }),
    };

    const tool = createSubAgentTool({
      agentRepository,
      providerResolver: resolver,
      agentToolRuntime: toolRuntime,
      maxRecursionDepth: 2,
    });

    const result = await tool.run(
      {
        role: 'Deep Subagent',
        objective: 'Go deeper',
        instructions: 'Recurse',
        _depth: 2,
      },
      { agentId: parentAgent.id, agentName: parentAgent.name },
    );

    expect(result).toMatchObject({
      status: 'failed',
    });
    expect((result as { output: string }).output).toContain('recursion depth limit exceeded');
  });
});
