import type { AgentDefinition } from '@iris/core';
import type {
  PermissionDecision,
  PermissionRule,
  PermissionRuleRepository,
  ToolDefinition,
} from '@iris/tools';

export type AgentToolPolicies = Record<string, PermissionDecision | ''>;

export function agentToolRuleId(agentId: string, toolId: string): string {
  return `agent:${agentId}:tool:${toolId}`;
}

export function editableAgentToolPolicies(
  agent: AgentDefinition | null,
  tools: readonly ToolDefinition[],
  rules: readonly PermissionRule[],
): AgentToolPolicies {
  if (!agent) return {};
  return Object.fromEntries(
    tools.map((tool) => {
      const explicit = rules.find(
        (rule) => rule.agentId === agent.id && rule.toolId === tool.id,
      )?.decision;
      return [tool.id, explicit ?? (agent.toolIds.includes(tool.id) ? 'ask' : '')];
    }),
  );
}

export async function saveAgentToolPolicies(
  repository: PermissionRuleRepository,
  agent: AgentDefinition,
  tools: readonly ToolDefinition[],
  policies: AgentToolPolicies,
): Promise<void> {
  for (const tool of tools) {
    const id = agentToolRuleId(agent.id, tool.id);
    const decision = policies[tool.id] ?? '';
    if (!agent.toolIds.includes(tool.id) || !decision) {
      await repository.remove(id);
      continue;
    }
    await repository.save({
      id,
      agentId: agent.id,
      toolId: tool.id,
      decision,
      reason:
        decision === 'ask'
          ? `${agent.name} requires approval each time it requests ${tool.name}.`
          : decision === 'allow'
            ? `The user explicitly allowed ${tool.name} for ${agent.name}.`
            : `The user explicitly denied ${tool.name} for ${agent.name}.`,
    });
  }
}

export async function ensureAssignedToolsRequireApproval(
  repository: PermissionRuleRepository,
  agents: readonly AgentDefinition[],
  tools: readonly ToolDefinition[],
  rules: readonly PermissionRule[],
): Promise<number> {
  const knownTools = new Map(tools.map((tool) => [tool.id, tool]));
  let createdRules = 0;
  for (const agent of agents) {
    for (const toolId of agent.toolIds) {
      const tool = knownTools.get(toolId);
      if (!tool) continue;
      const hasMatchingRule = rules.some(
        (rule) =>
          (rule.agentId === '*' || rule.agentId === agent.id) &&
          (rule.toolId === '*' || rule.toolId === tool.id),
      );
      if (hasMatchingRule) continue;
      await repository.save({
        id: agentToolRuleId(agent.id, tool.id),
        agentId: agent.id,
        toolId: tool.id,
        decision: 'ask',
        reason: `${agent.name} requires approval each time it requests ${tool.name}.`,
      });
      createdRules += 1;
    }
  }
  return createdRules;
}
