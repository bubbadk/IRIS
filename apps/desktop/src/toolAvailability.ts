import type { AgentDefinition } from '@iris/core';
import type { ToolDefinition } from '@iris/tools';

export interface UnavailableAgentTool {
  agentId: string;
  agentName: string;
  toolId: string;
}

/**
 * Tools an agent is configured to use that the registry does not publish right now — typically an
 * MCP server that is not connected. The assignment stays in durable data; this only reports it, so
 * an unreachable provider is visible instead of looking like a lost configuration.
 */
export function unavailableAgentTools(
  agents: readonly AgentDefinition[],
  availableTools: readonly ToolDefinition[],
): UnavailableAgentTool[] {
  const registered = new Set(availableTools.map((tool) => tool.id));
  return agents.flatMap((agent) =>
    [...new Set(agent.toolIds)]
      .filter((toolId) => !registered.has(toolId))
      .map((toolId) => ({ agentId: agent.id, agentName: agent.name, toolId })),
  );
}
