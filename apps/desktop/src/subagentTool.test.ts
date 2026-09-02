import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '@iris/core';
import type { AgentProviderResolver, AgentRepository, AgentToolRuntime } from '@iris/agents';
import type { ModelProvider } from '@iris/providers';
import { createSubAgentTool, createSubAgentTeamTool, validateSubAgentTeamInput, validateSubAgentInput, subAgentToolId } from './subagentTool';

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

describe('subagentTeamTool input validation', () => {
  it('accepts a non-empty tasks array with valid members', () => {
    expect(
      validateSubAgentTeamInput({
        tasks: [
          { role: 'Researcher', objective: 'Find facts', instructions: 'Search the web' },
          { role: 'Reviewer', objective: 'Review draft', instructions: 'Check claims' },
        ],
      }),
    ).toBe(true);
  });

  it('rejects empty or malformed task arrays', () => {
    expect(validateSubAgentTeamInput({ tasks: [] })).toBe(false);
    expect(validateSubAgentTeamInput({ tasks: 'nope' })).toBe(false);
    expect(validateSubAgentTeamInput(null)).toBe(false);
    expect(
      validateSubAgentTeamInput({
        tasks: [{ role: '', objective: 'X', instructions: 'Y' }],
      }),
    ).toBe(false);
  });
});

describe('subagentTeamTool execution', () => {
  const parentAgent: AgentDefinition = {
    id: 'parent-team-1',
    name: 'Team Lead',
    providerPolicyId: 'mock-provider',
    model: 'mock-model',
    persona: 'Team Lead',
    autonomy: 'operate',
    approvalMode: 'ask',
    toolIds: [subAgentToolId],
    skillIds: [],
  };

  const agentRepository: AgentRepository = {
    list: async () => [parentAgent],
    get: async (id) => (id === parentAgent.id ? parentAgent : null),
    save: async () => {},
    remove: async () => {},
  };

  const toolRuntime: AgentToolRuntime = {
    definitions: () => [],
    execute: async () => ({ status: 'completed', output: 'ok' }),
    resolve: async () => ({ status: 'completed', output: 'ok' }),
  };

  function toolWithResolver(resolve: AgentProviderResolver['resolve']) {
    return createSubAgentTeamTool({
      agentRepository,
      providerResolver: { resolve },
      agentToolRuntime: toolRuntime,
    });
  }

  it('runs all members in parallel and reports completed', async () => {
    let concurrent = 0;
    let peak = 0;
    const tool = toolWithResolver(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      try {
        // Yield so the second member's resolve can overlap with this one.
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
        return { provider: createMockProvider('member done'), model: 'mock-model' };
      } finally {
        concurrent -= 1;
      }
    });

    const result = (await tool.run(
      {
        tasks: [
          { role: 'Researcher', objective: 'Gather', instructions: 'Search' },
          { role: 'Reviewer', objective: 'Check', instructions: 'Review' },
        ],
      },
      { agentId: parentAgent.id, agentName: parentAgent.name },
    )) as { status: string; results: { status: string; output: string }[] };

    expect(result.status).toBe('completed');
    expect(result.results).toHaveLength(2);
    expect(result.results.every((member) => member.output === 'member done')).toBe(true);
    expect(peak).toBe(2);
  });

  it('reports failed when every member fails', async () => {
    const tool = toolWithResolver(async () => {
      throw new Error('no provider configured');
    });

    const result = (await tool.run(
      {
        tasks: [
          { role: 'A', objective: 'a', instructions: 'x' },
          { role: 'B', objective: 'b', instructions: 'y' },
        ],
      },
      { agentId: parentAgent.id, agentName: parentAgent.name },
    )) as { status: string; results: { status: string; output: string }[] };

    expect(result.status).toBe('failed');
    expect(result.results.every((member) => member.status === 'failed')).toBe(true);
  });

  it('rejects more than the maximum team size', async () => {
    const tool = toolWithResolver(async () => ({
      provider: createMockProvider(),
      model: 'mock-model',
    }));
    await expect(
      tool.run(
        {
          tasks: Array.from({ length: 5 }, (_, index) => ({
            role: `R${index}`,
            objective: 'o',
            instructions: 'i',
          })),
        },
        { agentId: parentAgent.id, agentName: parentAgent.name },
      ),
    ).rejects.toThrow(/at most 4/);
  });
});
