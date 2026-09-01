import {
  HybridMemoryRetriever,
  IndexedEmbeddingMemoryRetriever,
  LocalLexicalMemoryRetriever,
  MemoryEmbeddingIndexService,
  type MemoryEmbedder,
  type MemoryEmbeddingIndexBuildProgress,
  type MemoryEmbeddingIndexRepository,
  type MemoryEmbeddingIndexStatus,
  type MemoryRecord,
  type MemoryRetrievalRequest,
  type MemoryRetriever,
} from '@iris/memory';
import { invoke } from '@tauri-apps/api/core';
import {
  createEmbeddingProvider,
  fetchProviderEmbeddingModels,
  loadProviderConfigs,
  providerConnectionFields,
  providerConnectionValue,
  providerSupportsEmbeddings,
  refreshProviderModels,
  type ProviderConfig,
} from '@iris/providers';
import { isTauriRuntime, loadProviderSecrets } from './credentials';
import { memoryEmbeddingIndexRepository } from './persistence';

export type MemoryRetrievalConfig =
  | { strategy: 'lexical' }
  | { strategy: 'embedding'; providerId: string; model: string }
  | { strategy: 'hybrid'; providerId: string; model: string };

const storageKey = 'iris.memory.retrieval.v1';
export const defaultMemoryRetrievalConfig: MemoryRetrievalConfig = { strategy: 'lexical' };

export function loadMemoryRetrievalConfig(
  storage: Storage = globalThis.localStorage,
): MemoryRetrievalConfig {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) ?? 'null') as unknown;
    if (!parsed || typeof parsed !== 'object' || !('strategy' in parsed)) {
      return defaultMemoryRetrievalConfig;
    }
    if (parsed.strategy === 'lexical') return defaultMemoryRetrievalConfig;
    // 'ollama-embedding' is the legacy name for the provider-backed embedding strategy.
    if (
      (parsed.strategy === 'embedding' ||
        parsed.strategy === 'hybrid' ||
        parsed.strategy === 'ollama-embedding') &&
      'providerId' in parsed &&
      typeof parsed.providerId === 'string' &&
      'model' in parsed &&
      typeof parsed.model === 'string'
    ) {
      return {
        strategy: parsed.strategy === 'hybrid' ? 'hybrid' : 'embedding',
        providerId: parsed.providerId,
        model: parsed.model,
      };
    }
  } catch {
    // Invalid local metadata must not accidentally enable a network-backed retriever.
  }
  return defaultMemoryRetrievalConfig;
}

export async function saveMemoryRetrievalConfig(
  config: MemoryRetrievalConfig,
  storage: Storage = globalThis.localStorage,
): Promise<void> {
  storage.setItem(storageKey, JSON.stringify(config));
}

export function validateMemoryRetrievalConfig(
  config: MemoryRetrievalConfig,
  providers: readonly ProviderConfig[],
): string[] {
  if (config.strategy === 'lexical') return [];  const errors: string[] = [];
  const provider = providers.find(
    (candidate) => candidate.id === config.providerId && candidate.enabled,
  );
  if (!provider) {
    errors.push('Choose an enabled provider.');
  } else if (!providerSupportsEmbeddings(provider.kind)) {
    errors.push('That provider type does not support embeddings. Use an OpenAI-compatible or Ollama provider.');
  }
  if (!config.model.trim()) errors.push('Add the embedding model name.');
  return errors;
}

async function connectProvider(provider: ProviderConfig): Promise<ProviderConfig> {
  const hasSecretFields = providerConnectionFields(provider).some((field) => field.secret);
  const storedSecrets =
    hasSecretFields || provider.storedSecretFields?.length
      ? await loadProviderSecrets(provider.id)
      : null;
  return {
    ...provider,
    connectionValues: {
      ...(storedSecrets ?? {}),
      ...(provider.connectionValues ?? {}),
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    },
  };
}

// Model-name families that identify an embedding model across the common providers. `/models`
// returns chat, audio and image models too, so the picker filters down to these.
const embeddingModelPattern =
  /(embed|bge[-_]|gte[-_]|(^|[-_/])e5[-_]|nomic|mxbai|arctic-embed|minilm|jina|voyage|sfr-embedding|instructor)/i;

export function isEmbeddingModelName(model: string): boolean {
  return embeddingModelPattern.test(model);
}

/**
 * Narrows a provider's full model list to embedding models. When none are recognized — for example
 * a chat-only provider such as OpenRouter — this returns an empty list rather than the chat models,
 * so the picker never suggests a model that cannot embed. The field still accepts a typed name.
 */
export function selectEmbeddingModels(models: readonly string[]): string[] {
  return [...models.filter(isEmbeddingModelName)].sort((left, right) => left.localeCompare(right));
}

/**
 * Fetches a provider's model list for the embedding picker, filtered to embedding models so the
 * user chooses from real names instead of guessing. Credentials are loaded the same way the runtime
 * resolves them.
 */
function parseEmbeddingModelIds(body: string): string[] {
  try {
    const payload = JSON.parse(body) as { data?: Array<{ id?: unknown }> };
    const ids = (payload.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

/**
 * Lists a provider's dedicated embedding models. Prefers a native GET so it works even when the
 * listing endpoint sends no CORS headers (OpenRouter's `/embeddings/models` is one such case that
 * the webview cannot read directly), and falls back to a browser request outside the desktop app.
 */
async function dedicatedEmbeddingModels(connected: ProviderConfig): Promise<string[]> {
  if (connected.kind !== 'openai-compatible') return [];
  const url = `${connected.endpoint.replace(/\/+$/, '')}/embeddings/models`;
  if (isTauriRuntime()) {
    try {
      const token = providerConnectionValue(connected, 'apiKey') || null;
      const result = await invoke<{ status: number; body: string }>('provider_http_get_json', {
        url,
        token,
      });
      if (result.status >= 200 && result.status < 300) return parseEmbeddingModelIds(result.body);
    } catch {
      // Fall through to the browser request below.
    }
  }
  try {
    return await fetchProviderEmbeddingModels(connected);
  } catch {
    return [];
  }
}

export async function fetchEmbeddingModelOptions(
  providerId: string,
  providers: readonly ProviderConfig[] = loadProviderConfigs(),
): Promise<string[]> {
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider) return [];
  const connected = await connectProvider(provider);
  // Prefer a dedicated embeddings-model endpoint (e.g. OpenRouter); those are all embeddings.
  const dedicated = await dedicatedEmbeddingModels(connected);
  if (dedicated.length) return [...dedicated].sort((left, right) => left.localeCompare(right));
  // Otherwise filter the general model list by name (OpenAI, Ollama, LM Studio, …).
  const refreshed = await refreshProviderModels(connected);
  return selectEmbeddingModels(refreshed.availableModels ?? []);
}

type EmbedderFactory = (provider: ProviderConfig, model: string) => MemoryEmbedder;

function defaultEmbedderFactory(provider: ProviderConfig, model: string): MemoryEmbedder {
  // Load the provider secret lazily at embed time so the request carries its API key. The stored
  // configs from loadProviderConfigs() omit the secret, which otherwise yields a 401.
  return {
    embed: async (input: readonly string[]) => {
      const connected = await connectProvider(provider);
      return createEmbeddingProvider(connected, model).embed(input);
    },
  };
}

export class ConfiguredMemoryRetriever implements MemoryRetriever {
  private readonly lexical = new LocalLexicalMemoryRetriever();

  constructor(
    private readonly getConfig: () => MemoryRetrievalConfig = loadMemoryRetrievalConfig,
    private readonly getProviders: () => ProviderConfig[] = loadProviderConfigs,
    private readonly createEmbedder: EmbedderFactory = defaultEmbedderFactory,
    private readonly indexRepository: MemoryEmbeddingIndexRepository = memoryEmbeddingIndexRepository,
  ) {}

  async retrieve(
    records: readonly MemoryRecord[],
    request: MemoryRetrievalRequest,
  ): Promise<MemoryRecord[]> {
    const config = this.getConfig();
    if (config.strategy === 'lexical') return this.lexical.retrieve(records, request);

    const providers = this.getProviders();
    const errors = validateMemoryRetrievalConfig(config, providers);
    if (errors.length) throw new Error(errors.join(' '));
    const provider = providers.find((candidate) => candidate.id === config.providerId);
    if (!provider) throw new Error('The configured embedding provider is unavailable.');
    const embedding = new IndexedEmbeddingMemoryRetriever(
      this.createEmbedder(provider, config.model),
      this.indexRepository,
      { providerId: config.providerId, model: config.model },
    );
    if (config.strategy === 'embedding') return embedding.retrieve(records, request);

    // Hybrid: lexical precision on names and terms, embedding recall on
    // paraphrases, fused by reciprocal rank fusion. HybridMemoryRetriever
    // degrades to lexical-only when the embedding provider is unreachable.
    return new HybridMemoryRetriever(this.lexical, embedding).retrieve(records, request);
  }
}

export async function getMemoryEmbeddingIndexStatus(
  config: MemoryRetrievalConfig,
  records: readonly MemoryRecord[],
  indexRepository: MemoryEmbeddingIndexRepository = memoryEmbeddingIndexRepository,
): Promise<MemoryEmbeddingIndexStatus | null> {
  if (config.strategy !== 'embedding' && config.strategy !== 'hybrid') return null;
  return new MemoryEmbeddingIndexService(indexRepository).status(records, {
    providerId: config.providerId,
    model: config.model,
  });
}

export async function rebuildMemoryEmbeddingIndex(
  config: MemoryRetrievalConfig,
  records: readonly MemoryRecord[],
  providers: readonly ProviderConfig[],
  indexRepository: MemoryEmbeddingIndexRepository = memoryEmbeddingIndexRepository,
  createEmbedder: EmbedderFactory = defaultEmbedderFactory,
  onProgress?: (progress: MemoryEmbeddingIndexBuildProgress) => void,
): Promise<MemoryEmbeddingIndexStatus> {
  if (config.strategy !== 'embedding' && config.strategy !== 'hybrid') {
    throw new Error('Embedding retrieval is not selected.');
  }
  const errors = validateMemoryRetrievalConfig(config, providers);
  if (errors.length) throw new Error(errors.join(' '));
  const provider = providers.find((candidate) => candidate.id === config.providerId);
  if (!provider) throw new Error('The configured embedding provider is unavailable.');
  const scope = { providerId: config.providerId, model: config.model };
  const service = new MemoryEmbeddingIndexService(indexRepository);
  await service.rebuild(records, scope, createEmbedder(provider, config.model), onProgress);
  return service.status(records, scope);
}

export async function testMemoryRetrievalConfig(
  config: MemoryRetrievalConfig,
  providers: readonly ProviderConfig[],
  createEmbedder: EmbedderFactory = defaultEmbedderFactory,
): Promise<void> {
  if (config.strategy !== 'embedding' && config.strategy !== 'hybrid') {
    throw new Error('Embedding retrieval is not selected.');
  }
  const errors = validateMemoryRetrievalConfig(config, providers);
  if (errors.length) throw new Error(errors.join(' '));
  const provider = providers.find((candidate) => candidate.id === config.providerId);
  if (!provider) throw new Error('The configured embedding provider is unavailable.');
  const vectors = await createEmbedder(provider, config.model).embed([
    'IRIS local memory retrieval connection test.',
  ]);
  if (vectors.length !== 1 || !vectors[0]?.length) {
    throw new Error('Embedding provider returned no test vector.');
  }
}
