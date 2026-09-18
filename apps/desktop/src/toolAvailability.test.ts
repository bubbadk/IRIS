import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '@iris/core';
import type { ToolDefinition } from '@iris/tools';
import { unavailableAgentTools } from './toolAvailability';

function agent(id: string, name: string, toolIds: string[]): AgentDefinition {
  return { id, name, autonomy: 'assist', skillIds: [], toolIds };
}

function published(id: string): ToolDefinition {
  return {
    id,
    name: id,
    description: `${id} description`,
    risk: 'read',
    providerName: id,
    inputSchema: { type: 'object', additionalProperties: false },
  };
}

describe('unavailable assigned tools', () => {
  it('reports every assignment no connected provider publishes', () => {
    const tools = unavailableAgentTools(
      [
        agent('a1', 'Tekniker', ['workspace.read', 'mcp.s1.search_email']),
        agent('a2', 'test', ['workspace.read', 'mcp.s1.search_email', 'mcp.s2.latest_news']),
      ],
      [published('workspace.read')],
    );
    expect(tools).toEqual([
      { agentId: 'a1', agentName: 'Tekniker', toolId: 'mcp.s1.search_email' },
      { agentId: 'a2', agentName: 'test', toolId: 'mcp.s1.search_email' },
      { agentId: 'a2', agentName: 'test', toolId: 'mcp.s2.latest_news' },
    ]);
  });

  it('reports each assignment once per agent and nothing when all are published', () => {
    expect(
      unavailableAgentTools([agent('a1', 'IRIS', ['workspace.read', 'workspace.read'])], [
        published('workspace.read'),
      ]),
    ).toEqual([]);
  });
});
