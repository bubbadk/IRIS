import type { AgentDefinition } from '@iris/core';
import type { ProviderConfig } from '@iris/providers';

export function selectableAgentModels(
  provider: Pick<ProviderConfig, 'model' | 'availableModels'>,
): string[] {
  return [
    ...new Set(
      [...(provider.availableModels ?? []), provider.model]
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
}

export function displayedAgentModel(
  agent: Pick<AgentDefinition, 'providerPolicyId' | 'model'>,
  providers: readonly Pick<ProviderConfig, 'id' | 'model'>[],
): string | null {
  const configured = agent.model?.trim();
  if (configured) return configured;
  return providers.find((provider) => provider.id === agent.providerPolicyId)?.model.trim() || null;
}
