import type {
  AgentApprovalMode,
  AgentAutonomy,
  AgentDefinition,
  AgentMemoryAccess,
  ReasoningEffort,
} from '@iris/core';

export interface EditableAgentConfiguration {
  name: string;
  description: string;
  persona?: string;
  providerPolicyId: string;
  model: string;
  autonomy: AgentAutonomy;
  memoryAccess: AgentMemoryAccess;
  approvalMode: AgentApprovalMode;
  reasoningEffort: ReasoningEffort;
  skillIds?: readonly string[];
  toolIds: readonly string[];
}

export function applyAgentConfiguration(
  agent: AgentDefinition,
  configuration: EditableAgentConfiguration,
): AgentDefinition {
  const name = configuration.name.trim();
  if (!name) throw new Error('Give your agent a name.');

  const description = configuration.description.trim();
  const persona = (configuration.persona ?? '').trim();
  const providerPolicyId = configuration.providerPolicyId.trim();
  const model = configuration.model.trim();

  return {
    ...agent,
    name,
    description: description || undefined,
    persona: persona || undefined,
    providerPolicyId: providerPolicyId || undefined,
    model: model || undefined,
    autonomy: configuration.autonomy,
    memoryAccess: configuration.memoryAccess,
    approvalMode: configuration.approvalMode,
    reasoningEffort:
      configuration.reasoningEffort === 'none' ? undefined : configuration.reasoningEffort,
    skillIds: [...new Set(configuration.skillIds ?? agent.skillIds)],
    toolIds: [...new Set(configuration.toolIds)],
  };
}
