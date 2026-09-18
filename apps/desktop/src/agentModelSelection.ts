import type { AgentDefinition } from '@iris/core';
import {
  catalogModelsFromIds,
  chatSelectableModelIds,
  dedupeModelIds,
  NO_COMPATIBLE_CHAT_MODEL,
  type ModelCatalogMetadata,
  type ProviderConfig,
} from '@iris/providers';

type SelectableProvider = Pick<ProviderConfig, 'model' | 'availableModels' | 'modelMetadata'>;

/**
 * The models an agent may be assigned on this provider: the catalog models that are actually
 * conversational, de-duplicated and deterministic. A stale hardcoded allow-list is never consulted,
 * so a model the provider newly advertises — DeepSeek variants included — appears here without a
 * code change; capability metadata (or the documented conservative fallback) decides what is
 * compatible, not the model's name appearing in a list written earlier.
 *
 * The provider's currently selected model is always kept visible even when it classifies as
 * non-chat, because hiding the value that is actually stored would misrepresent the configuration.
 */
export function selectableAgentModels(provider: SelectableProvider): string[] {
  const models = dedupeModelIds([...(provider.availableModels ?? []), provider.model]);
  const chatModels = chatSelectableModelIds(
    catalogModelsFromIds(models, provider.modelMetadata),
  );
  const selected = provider.model.trim();
  return selected && !chatModels.includes(selected)
    ? dedupeModelIds([...chatModels, selected])
    : chatModels;
}

/**
 * Every model the provider advertises, unfiltered, for callers that must show the whole catalog
 * (for example an advanced model picker) rather than only chat-compatible entries.
 */
export function catalogAgentModels(provider: SelectableProvider): string[] {
  return dedupeModelIds([...(provider.availableModels ?? []), provider.model]);
}

/**
 * The controlled state a provider is in when it has no chat-compatible model: `model` stays empty
 * and the UI shows the message instead of preselecting an image, audio or embedding model.
 */
export function providerChatModelState(provider: SelectableProvider): {
  model: string;
  message?: string;
} {
  const models = selectableAgentModels(provider);
  const model = provider.model.trim() || models[0] || '';
  return model ? { model } : { model: '', message: NO_COMPATIBLE_CHAT_MODEL };
}

export function displayProviderModelName(
  model: string,
  metadata?: ModelCatalogMetadata,
): string {
  const directoryName = metadata?.name?.trim();
  if (directoryName) return directoryName;
  return model === 'deepseek-flash' ? 'DeepSeek V4.1 Flash' : model;
}

export function displayedAgentModel(
  agent: Pick<AgentDefinition, 'providerPolicyId' | 'model'>,
  providers: readonly Pick<ProviderConfig, 'id' | 'model'>[],
): string | null {
  const configured = agent.model?.trim();
  if (configured) return configured;
  return providers.find((provider) => provider.id === agent.providerPolicyId)?.model.trim() || null;
}
