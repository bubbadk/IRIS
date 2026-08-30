import type { Capability, ProviderDefinition, ReasoningEffort } from '@iris/core';

export type ConfiguredProviderKind =
  'openai-compatible' | 'ollama' | 'anthropic' | 'gemini' | 'cohere' | 'azure-openai';

export type ProviderCatalogId = string;
export type ProviderCredentialMode = 'required' | 'optional' | 'none';

export interface ProviderConnectionField {
  id: string;
  label: string;
  required: boolean;
  secret: boolean;
  placeholder?: string;
  defaultValue?: string;
}

export type ProviderConnectionValues = Record<string, string>;

const requiredApiKeyField: readonly ProviderConnectionField[] = [
  {
    id: 'apiKey',
    label: 'API key',
    required: true,
    secret: true,
  },
];

const optionalApiKeyField: readonly ProviderConnectionField[] = [
  {
    id: 'apiKey',
    label: 'API key',
    required: false,
    secret: true,
  },
];

export interface ProviderCatalogEntry {
  id: ProviderCatalogId;
  name: string;
  description: string;
  kind: ConfiguredProviderKind;
  endpoint: string;
  credentialMode: ProviderCredentialMode;
  credentialNames: string[];
  connectionFields: readonly ProviderConnectionField[];
  supported: boolean;
  supportReason?: string;
  source: 'built-in' | 'models.dev';
}

export const providerCatalog: readonly ProviderCatalogEntry[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'Cloud models through the OpenAI API.',
    kind: 'openai-compatible',
    endpoint: 'https://api.openai.com/v1',
    credentialMode: 'required',
    credentialNames: ['OPENAI_API_KEY'],
    connectionFields: requiredApiKeyField,
    supported: true,
    source: 'built-in',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models through the native Anthropic Messages API.',
    kind: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1',
    credentialMode: 'required',
    credentialNames: ['ANTHROPIC_API_KEY'],
    connectionFields: requiredApiKeyField,
    supported: true,
    source: 'built-in',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    description: 'Gemini models through the native Google Generative Language API.',
    kind: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    credentialMode: 'required',
    credentialNames: ['GEMINI_API_KEY'],
    connectionFields: requiredApiKeyField,
    supported: true,
    source: 'built-in',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    description: 'Command models through the native Cohere V2 Chat API.',
    kind: 'cohere',
    endpoint: 'https://api.cohere.com',
    credentialMode: 'required',
    credentialNames: ['COHERE_API_KEY'],
    connectionFields: requiredApiKeyField,
    supported: true,
    source: 'built-in',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Models served locally by Ollama.',
    kind: 'ollama',
    endpoint: 'http://localhost:11434',
    credentialMode: 'none',
    credentialNames: [],
    connectionFields: [],
    supported: true,
    source: 'built-in',
  },
  {
    id: 'lmstudio-local',
    name: 'LM Studio',
    description: 'Models served locally through LM Studio’s OpenAI-compatible server.',
    kind: 'openai-compatible',
    endpoint: 'http://localhost:1234/v1',
    credentialMode: 'optional',
    credentialNames: ['LM_API_TOKEN'],
    connectionFields: optionalApiKeyField,
    supported: true,
    source: 'built-in',
  },
  {
    id: 'localai-local',
    name: 'LocalAI',
    description: 'Local models through a LocalAI OpenAI-compatible server.',
    kind: 'openai-compatible',
    endpoint: 'http://localhost:8080/v1',
    credentialMode: 'optional',
    credentialNames: ['LOCALAI_API_KEY'],
    connectionFields: optionalApiKeyField,
    supported: true,
    source: 'built-in',
  },
  {
    id: 'vllm-local',
    name: 'vLLM',
    description: 'Self-hosted models through the vLLM OpenAI-compatible server.',
    kind: 'openai-compatible',
    endpoint: 'http://localhost:8000/v1',
    credentialMode: 'optional',
    credentialNames: ['VLLM_API_KEY'],
    connectionFields: optionalApiKeyField,
    supported: true,
    source: 'built-in',
  },
  {
    id: 'llamacpp-local',
    name: 'llama.cpp',
    description: 'A local llama.cpp server using its OpenAI-compatible routes.',
    kind: 'openai-compatible',
    endpoint: 'http://localhost:8080/v1',
    credentialMode: 'optional',
    credentialNames: ['LLAMA_CPP_API_KEY'],
    connectionFields: optionalApiKeyField,
    supported: true,
    source: 'built-in',
  },
  {
    id: 'antigravity-local',
    name: 'Antigravity (agy)',
    description:
      'Google Antigravity subscription through a local agy CLI shim — Gemini, Claude and GPT-OSS ' +
      'models. Chat and reasoning only: the shim flattens every request to a single agy prompt and ' +
      'never returns tool calls, so tools assigned to an agent on this provider will not run.',
    kind: 'openai-compatible',
    endpoint: 'http://127.0.0.1:8788/v1',
    credentialMode: 'none',
    credentialNames: [],
    connectionFields: [],
    supported: true,
    source: 'built-in',
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI-compatible',
    description: 'A custom endpoint that implements the OpenAI API shape.',
    kind: 'openai-compatible',
    endpoint: '',
    credentialMode: 'optional',
    credentialNames: ['API_KEY'],
    connectionFields: optionalApiKeyField,
    supported: true,
    source: 'built-in',
  },
  {
    id: 'anthropic-compatible',
    name: 'Anthropic-compatible',
    description: 'A custom endpoint that implements the Anthropic Messages API shape.',
    kind: 'anthropic',
    endpoint: '',
    credentialMode: 'optional',
    credentialNames: ['API_KEY'],
    connectionFields: optionalApiKeyField,
    supported: true,
    source: 'built-in',
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    description: 'Azure-hosted OpenAI models through a resource endpoint and named deployment.',
    kind: 'azure-openai',
    endpoint: '',
    credentialMode: 'required',
    credentialNames: ['AZURE_RESOURCE_NAME', 'AZURE_API_KEY'],
    connectionFields: [
      {
        id: 'apiKey',
        label: 'API key',
        required: true,
        secret: true,
      },
      {
        id: 'apiVersion',
        label: 'API version',
        required: true,
        secret: false,
        defaultValue: '2024-10-21',
        placeholder: '2024-10-21',
      },
    ],
    supported: true,
    source: 'built-in',
  },
] as const;

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ConfiguredProviderKind;
  endpoint: string;
  model: string;
  connectionFields?: readonly ProviderConnectionField[];
  connectionValues?: ProviderConnectionValues;
  storedSecretFields?: string[];
  /** Legacy in-memory field migrated into connectionValues.apiKey. */
  apiKey?: string;
  /** Legacy keyring marker migrated into storedSecretFields. */
  secretStored?: boolean;
  enabled: boolean;
  catalogId?: ProviderCatalogId;
  credentialMode?: ProviderCredentialMode;
  availableModels?: string[];
  modelsRefreshedAt?: string;
}

export interface PersistedProviderConfig extends Omit<
  ProviderConfig,
  'apiKey' | 'secretStored' | 'connectionValues'
> {
  connectionValues?: ProviderConnectionValues;
  storedSecretFields: string[];
}

interface LegacyPersistedProviderConfig extends Omit<ProviderConfig, 'apiKey'> {
  hasApiKey?: boolean;
}

const storageKey = 'iris.providers.config.v2';
const catalogStorageKey = 'iris.providers.catalog.v1';
const providerDirectoryUrl = 'https://models.dev/api.json';
const providerConfigListeners = new Set<() => void>();

interface ProviderDirectoryRecord {
  name?: unknown;
  npm?: unknown;
  api?: unknown;
  env?: unknown;
}

const providerEndpointOverrides: Readonly<Record<string, string>> = {
  anthropic: 'https://api.anthropic.com/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  cohere: 'https://api.cohere.com',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  perplexity: 'https://api.perplexity.ai',
  togetherai: 'https://api.together.ai/v1',
  vercel: 'https://ai-gateway.vercel.sh/v1',
  xai: 'https://api.x.ai/v1',
};

function protocolForDirectoryPackage(npm: string): ConfiguredProviderKind | null {
  if (
    npm === '@ai-sdk/openai-compatible' ||
    [
      '@ai-sdk/cerebras',
      '@ai-sdk/deepinfra',
      '@ai-sdk/gateway',
      '@ai-sdk/groq',
      '@ai-sdk/mistral',
      '@ai-sdk/openai',
      '@ai-sdk/perplexity',
      '@ai-sdk/togetherai',
      '@ai-sdk/xai',
      '@openrouter/ai-sdk-provider',
    ].includes(npm)
  ) {
    return 'openai-compatible';
  }
  if (npm === '@ai-sdk/anthropic') return 'anthropic';
  if (npm === '@ai-sdk/google') return 'gemini';
  if (npm === '@ai-sdk/cohere') return 'cohere';
  if (npm === '@ai-sdk/azure') return 'azure-openai';
  return null;
}

function connectionFieldsForCredentialMode(
  credentialMode: ProviderCredentialMode,
): readonly ProviderConnectionField[] {
  if (credentialMode === 'none') return [];
  return credentialMode === 'required' ? requiredApiKeyField : optionalApiKeyField;
}

function directoryEntry(id: string, value: ProviderDirectoryRecord): ProviderCatalogEntry | null {
  if (typeof value.name !== 'string' || typeof value.npm !== 'string') return null;
  const protocol = protocolForDirectoryPackage(value.npm);
  const credentialNames = Array.isArray(value.env)
    ? value.env.filter((item): item is string => typeof item === 'string')
    : [];
  const endpoint =
    (typeof value.api === 'string' ? value.api : undefined) ?? providerEndpointOverrides[id] ?? '';
  const supported = Boolean(protocol && endpoint);
  const credentialMode = credentialNames.length ? 'required' : 'optional';
  return {
    id,
    name: value.name,
    description: supported
      ? `Models from ${value.name} through its ${protocol === 'openai-compatible' ? 'OpenAI-compatible' : protocol} API.`
      : `${value.name} is listed in the live directory, but IRIS does not yet have its credential and runtime adapter.`,
    kind: protocol ?? 'openai-compatible',
    endpoint,
    credentialMode,
    credentialNames,
    connectionFields: connectionFieldsForCredentialMode(credentialMode),
    supported,
    supportReason: supported ? undefined : `Adapter required for ${value.npm}.`,
    source: 'models.dev',
  };
}

function mergeProviderCatalog(entries: readonly ProviderCatalogEntry[]): ProviderCatalogEntry[] {
  const merged = new Map(entries.map((entry) => [entry.id, entry]));
  for (const builtIn of providerCatalog) {
    const synced = merged.get(builtIn.id);
    merged.set(builtIn.id, synced ? { ...synced, ...builtIn } : builtIn);
  }
  return [...merged.values()].sort((left, right) => {
    if (left.supported !== right.supported) return left.supported ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export function loadProviderCatalog(): ProviderCatalogEntry[] {
  try {
    const raw = localStorage.getItem(catalogStorageKey);
    if (!raw) return mergeProviderCatalog([]);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return mergeProviderCatalog([]);
    const valid = parsed
      .filter(
        (entry): entry is ProviderCatalogEntry =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof (entry as ProviderCatalogEntry).id === 'string' &&
          typeof (entry as ProviderCatalogEntry).name === 'string' &&
          typeof (entry as ProviderCatalogEntry).endpoint === 'string' &&
          typeof (entry as ProviderCatalogEntry).supported === 'boolean',
      )
      .map((entry) => ({
        ...entry,
        connectionFields: Array.isArray(entry.connectionFields)
          ? entry.connectionFields
          : connectionFieldsForCredentialMode(entry.credentialMode),
      }));
    return mergeProviderCatalog(valid);
  } catch {
    return mergeProviderCatalog([]);
  }
}

export async function refreshProviderCatalog(
  fetcher: typeof fetch = defaultFetch,
): Promise<ProviderCatalogEntry[]> {
  const response = await fetcher(providerDirectoryUrl);
  if (!response.ok) {
    throw new Error(`Provider directory responded with ${response.status}.`);
  }
  const payload = (await response.json()) as unknown;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Provider directory returned an invalid catalog.');
  }
  const entries = Object.entries(payload as Record<string, ProviderDirectoryRecord>).flatMap(
    ([id, value]) => {
      const entry = directoryEntry(id, value);
      return entry ? [entry] : [];
    },
  );
  if (!entries.length) throw new Error('Provider directory returned no providers.');
  const catalog = mergeProviderCatalog(entries);
  localStorage.setItem(catalogStorageKey, JSON.stringify(catalog));
  return catalog;
}

export function getProviderCatalogEntry(
  id: ProviderCatalogId,
  catalog: readonly ProviderCatalogEntry[] = providerCatalog,
): ProviderCatalogEntry {
  const entry = catalog.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown provider catalog entry: ${id}`);
  return entry;
}

export function providerCatalogIdForConfig(
  config: Pick<ProviderConfig, 'kind' | 'endpoint' | 'catalogId'>,
): ProviderCatalogId {
  if (config.catalogId?.trim()) return config.catalogId;
  if (config.kind === 'ollama') return 'ollama';
  const endpoint = config.endpoint.replace(/\/+$/, '');
  if (config.kind === 'anthropic') {
    return endpoint === 'https://api.anthropic.com/v1' ? 'anthropic' : 'anthropic-compatible';
  }
  if (config.kind === 'gemini') return 'google';
  if (config.kind === 'cohere') return 'cohere';
  if (config.kind === 'azure-openai') return 'azure';
  return endpoint === 'https://api.openai.com/v1' ? 'openai' : 'openai-compatible';
}

export function createProviderConfig(
  selection: ProviderCatalogId | ProviderCatalogEntry,
): ProviderConfig {
  const entry = typeof selection === 'string' ? getProviderCatalogEntry(selection) : selection;
  const connectionValues = Object.fromEntries(
    entry.connectionFields.flatMap((field) =>
      field.defaultValue === undefined ? [] : [[field.id, field.defaultValue]],
    ),
  );
  return {
    id: `${entry.id}-${crypto.randomUUID()}`,
    name: entry.id === 'ollama' ? 'Local Ollama' : entry.name,
    kind: entry.kind,
    endpoint: entry.endpoint,
    model: '',
    enabled: true,
    catalogId: entry.id,
    credentialMode: entry.credentialMode,
    connectionFields: entry.connectionFields,
    connectionValues,
  };
}

export function providerConnectionFields(
  config: Pick<ProviderConfig, 'connectionFields' | 'credentialMode'> &
    Partial<Pick<ProviderConfig, 'kind'>>,
): readonly ProviderConnectionField[] {
  if (config.connectionFields) return config.connectionFields;
  const credentialMode = config.credentialMode ?? (config.kind === 'ollama' ? 'none' : 'required');
  return connectionFieldsForCredentialMode(credentialMode);
}

export function providerConnectionValue(
  config: Pick<ProviderConfig, 'connectionValues' | 'apiKey'>,
  fieldId: string,
): string | undefined {
  const value = config.connectionValues?.[fieldId];
  if (value?.trim()) return value.trim();
  return fieldId === 'apiKey' && config.apiKey?.trim() ? config.apiKey.trim() : undefined;
}

export function missingProviderConnectionFields(
  config: Pick<
    ProviderConfig,
    | 'connectionFields'
    | 'connectionValues'
    | 'storedSecretFields'
    | 'credentialMode'
    | 'apiKey'
    | 'secretStored'
  > &
    Partial<Pick<ProviderConfig, 'kind'>>,
): ProviderConnectionField[] {
  const stored = new Set(config.storedSecretFields);
  if (config.secretStored) stored.add('apiKey');
  return providerConnectionFields(config).filter(
    (field) =>
      field.required && !providerConnectionValue(config, field.id) && !stored.has(field.id),
  );
}

export function providerRequiresApiKey(
  config: Pick<ProviderConfig, 'kind' | 'credentialMode' | 'connectionFields'>,
): boolean {
  return providerConnectionFields(config).some((field) => field.id === 'apiKey' && field.required);
}

export function providerAcceptsApiKey(
  config: Pick<ProviderConfig, 'kind' | 'credentialMode' | 'connectionFields'>,
): boolean {
  return providerConnectionFields(config).some((field) => field.id === 'apiKey');
}

export function loadProviderConfigs(): ProviderConfig[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<
      PersistedProviderConfig | LegacyPersistedProviderConfig
    >;
    if (!Array.isArray(parsed)) return [];
    const catalog = loadProviderCatalog();
    return parsed.map((stored) => {
      const legacy = stored as LegacyPersistedProviderConfig;
      const current = stored as PersistedProviderConfig;
      const config = Object.fromEntries(
        Object.entries(stored).filter(
          ([key]) => !['hasApiKey', 'secretStored', 'apiKey'].includes(key),
        ),
      ) as Omit<ProviderConfig, 'apiKey' | 'secretStored'>;
      const availableModels = Array.isArray(config.availableModels)
        ? config.availableModels.filter(
            (model): model is string => typeof model === 'string' && Boolean(model.trim()),
          )
        : undefined;
      const catalogId = providerCatalogIdForConfig(config);
      const entry = catalog.find((candidate) => candidate.id === catalogId);
      const connectionFields = config.connectionFields ?? entry?.connectionFields;
      const legacyApiKey = (stored as { apiKey?: unknown }).apiKey;
      const connectionValues = {
        ...(config.connectionValues ?? {}),
        ...(typeof legacyApiKey === 'string' && legacyApiKey ? { apiKey: legacyApiKey } : {}),
      };
      const storedSecretFields = Array.isArray(current.storedSecretFields)
        ? current.storedSecretFields.filter((field): field is string => typeof field === 'string')
        : legacy.hasApiKey || legacy.secretStored
          ? ['apiKey']
          : [];
      return {
        ...config,
        availableModels,
        connectionFields,
        connectionValues,
        storedSecretFields,
        catalogId,
        credentialMode: config.credentialMode ?? entry?.credentialMode,
      };
    });
  } catch {
    return [];
  }
}

export function saveProviderConfigs(configs: ProviderConfig[]) {
  const persisted: PersistedProviderConfig[] = configs.map((provider) => {
    const { apiKey, secretStored, connectionValues = {}, ...config } = provider;
    const fields = providerConnectionFields(provider);
    const secretFieldIds = new Set(fields.filter((field) => field.secret).map((field) => field.id));
    const safeConnectionValues = Object.fromEntries(
      Object.entries(connectionValues).filter(([fieldId]) => !secretFieldIds.has(fieldId)),
    );
    const storedSecretFields = new Set(provider.storedSecretFields);
    if (secretStored || (apiKey && provider.storedSecretFields?.includes('apiKey'))) {
      storedSecretFields.add('apiKey');
    }
    return {
      ...config,
      connectionValues: safeConnectionValues,
      storedSecretFields: [...storedSecretFields],
    };
  });
  localStorage.setItem(storageKey, JSON.stringify(persisted));
  providerConfigListeners.forEach((listener) => listener());
}

export function subscribeProviderConfigs(listener: () => void): () => void {
  providerConfigListeners.add(listener);
  return () => providerConfigListeners.delete(listener);
}

export function validateProviderConfig(
  config: Pick<ProviderConfig, 'name' | 'endpoint' | 'model'> &
    Partial<
      Pick<
        ProviderConfig,
        | 'connectionFields'
        | 'connectionValues'
        | 'storedSecretFields'
        | 'credentialMode'
        | 'kind'
        | 'apiKey'
        | 'secretStored'
      >
    >,
  options: { requireModel?: boolean } = {},
): string[] {
  const errors: string[] = [];
  if (!config.name.trim()) errors.push('Give this provider a name.');
  if (!config.endpoint.trim()) errors.push('Add an endpoint URL.');
  else {
    try {
      new URL(config.endpoint);
    } catch {
      errors.push('Endpoint must be a valid URL.');
    }
  }
  if (options.requireModel !== false && !config.model.trim()) errors.push('Add a model name.');
  if (config.connectionFields || config.credentialMode || config.kind) {
    for (const field of missingProviderConnectionFields(config)) {
      errors.push(`Add ${field.label.toLowerCase()}.`);
    }
  }
  return errors;
}

export interface ProviderFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
}

export type ProviderFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<ProviderFetchResponse>;

const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

const RETRYABLE_STREAM_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_STREAM_ATTEMPTS = 3;
const STREAM_BACKOFF_BASE_MS = 500;
const STREAM_BACKOFF_CAP_MS = 8000;

function streamRetryDelay(attempt: number): number {
  const exponential = Math.min(STREAM_BACKOFF_CAP_MS, STREAM_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  // Full jitter spreads retries so many agents do not resynchronize on the same server.
  return Math.round(Math.random() * exponential);
}

function retryAfterDelay(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(STREAM_BACKOFF_CAP_MS, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(STREAM_BACKOFF_CAP_MS, date - Date.now()));
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  return new DOMException('The model request was aborted.', 'AbortError');
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Opens a streaming model request, retrying transient failures (network errors, 429/5xx) with
 * jittered backoff. Retries happen only before the first byte is read, so a partially streamed
 * reply is never duplicated. Aborts are never retried.
 */
async function openStream(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  const signal = init.signal ?? undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_STREAM_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw abortError();
    try {
      const response = await fetcher(input, init);
      if (response.ok || !RETRYABLE_STREAM_STATUS.has(response.status)) return response;
      if (attempt === MAX_STREAM_ATTEMPTS) return response;
      const wait = retryAfterDelay(response.headers.get('retry-after')) ?? streamRetryDelay(attempt);
      await response.body?.cancel().catch(() => undefined);
      await sleep(wait, signal);
    } catch (error) {
      if (isAbort(error) || attempt === MAX_STREAM_ATTEMPTS) throw error;
      lastError = error;
      await sleep(streamRetryDelay(attempt), signal);
    }
  }
  throw lastError ?? new Error('The model request could not be started.');
}

interface OpenAiModelsPayload {
  data?: unknown;
}

interface OllamaModelsPayload {
  models?: unknown;
}

function modelIdsFromPayload(kind: ConfiguredProviderKind, payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const candidates =
    kind === 'ollama' || kind === 'gemini' || kind === 'cohere'
      ? (payload as OllamaModelsPayload).models
      : (payload as OpenAiModelsPayload).data;
  if (!Array.isArray(candidates)) return [];

  const ids = candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const value = (() => {
      if (kind === 'ollama') {
        return (
          (candidate as { model?: unknown; name?: unknown }).model ??
          (candidate as { name?: unknown }).name
        );
      }
      if (kind === 'gemini' || kind === 'cohere') {
        return (candidate as { name?: unknown }).name;
      }
      return (candidate as { id?: unknown }).id;
    })();
    if (typeof value !== 'string' || !value.trim()) return [];
    return [kind === 'gemini' ? value.trim().replace(/^models\//, '') : value.trim()];
  });
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

export interface EmbeddingProvider {
  embed(input: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

function connectionUrl(config: Pick<ProviderConfig, 'kind' | 'endpoint'>): string {
  const endpoint = config.endpoint.replace(/\/+$/, '');
  if (config.kind === 'ollama') return `${endpoint}/api/tags`;
  if (config.kind === 'cohere') return `${endpoint}/v1/models?endpoint=chat`;
  if (config.kind === 'azure-openai') {
    const apiVersion = providerConnectionValue(config as ProviderConfig, 'apiVersion');
    if (!apiVersion) throw new Error('Azure OpenAI requires an API version.');
    return `${endpoint}/openai/models?api-version=${encodeURIComponent(apiVersion)}`;
  }
  return `${endpoint}/models`;
}

function providerRequestHeaders(
  config: Pick<ProviderConfig, 'kind' | 'apiKey' | 'connectionValues'>,
  includeContentType = false,
): HeadersInit | undefined {
  const headers: Record<string, string> = {};
  if (includeContentType) headers['Content-Type'] = 'application/json';
  const apiKey = providerConnectionValue(config, 'apiKey');
  if (apiKey) {
    if (config.kind === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (config.kind === 'gemini') {
      headers['x-goog-api-key'] = apiKey;
    } else if (config.kind === 'azure-openai') {
      headers['api-key'] = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }
  return Object.keys(headers).length ? headers : undefined;
}

export async function testProviderConnection(
  config: ProviderConfig,
  fetcher: ProviderFetch = defaultFetch,
): Promise<void> {
  const response = await fetcher(connectionUrl(config), {
    method: 'GET',
    headers: providerRequestHeaders(config),
  });
  if (!response.ok) {
    const detail = response.statusText ? ` ${response.statusText}` : '';
    throw new Error(`Provider responded with ${response.status}.${detail}`);
  }
}

export async function fetchProviderModels(
  config: ProviderConfig,
  fetcher: typeof fetch = defaultFetch,
): Promise<string[]> {
  const response = await fetcher(connectionUrl(config), {
    method: 'GET',
    headers: providerRequestHeaders(config),
  });
  if (!response.ok) {
    const detail = response.statusText ? ` ${response.statusText}` : '';
    throw new Error(`Model discovery failed with ${response.status}.${detail}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Provider returned an unreadable model list.');
  }
  const models = modelIdsFromPayload(config.kind, payload);
  if (!models.length) throw new Error('Provider returned no usable models.');
  return models;
}

/**
 * Returns a provider's dedicated embedding-model list, when it exposes one. Some OpenAI-compatible
 * gateways (for example OpenRouter) keep embedding models out of `/models` and serve them from
 * `/embeddings/models` instead. Returns an empty list when there is no such endpoint, so callers
 * fall back to filtering the general model list by name.
 */
export async function fetchProviderEmbeddingModels(
  config: ProviderConfig,
  fetcher: typeof fetch = defaultFetch,
): Promise<string[]> {
  if (config.kind !== 'openai-compatible') return [];
  const endpoint = config.endpoint.replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetcher(`${endpoint}/embeddings/models`, {
      method: 'GET',
      headers: providerRequestHeaders(config),
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  const payload = await response.json().catch(() => null);
  return modelIdsFromPayload('openai-compatible', payload);
}

export async function refreshProviderModels(
  config: ProviderConfig,
  fetcher: typeof fetch = defaultFetch,
  now: () => Date = () => new Date(),
): Promise<ProviderConfig> {
  const availableModels = await fetchProviderModels(config, fetcher);
  return {
    ...config,
    model:
      config.kind === 'azure-openai'
        ? config.model
        : availableModels.includes(config.model)
          ? config.model
          : availableModels[0],
    availableModels,
    modelsRefreshedAt: now().toISOString(),
  };
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderConfig>();

  constructor(configs: ProviderConfig[] = []) {
    configs.forEach((config) => this.register(config));
  }

  register(config: ProviderConfig): void {
    this.providers.set(config.id, config);
  }

  remove(id: string): void {
    this.providers.delete(id);
  }

  get(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  list(): ProviderConfig[] {
    return [...this.providers.values()];
  }
}

interface OllamaEmbeddingPayload {
  embeddings?: unknown;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly fetcher: typeof fetch = defaultFetch,
  ) {}

  async embed(input: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const response = await this.fetcher(`${this.endpoint.replace(/\/+$/, '')}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input }),
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Embedding request failed with ${response.status} ${response.statusText}`.trim(),
      );
    }
    const payload = (await response.json()) as OllamaEmbeddingPayload;
    if (
      !Array.isArray(payload.embeddings) ||
      payload.embeddings.some(
        (vector) => !Array.isArray(vector) || vector.some((value) => typeof value !== 'number'),
      )
    ) {
      throw new Error('Embedding provider returned invalid vectors.');
    }
    return payload.embeddings as number[][];
  }
}

export function createOllamaEmbeddingProvider(
  config: Pick<ProviderConfig, 'kind' | 'endpoint'>,
  model: string,
  fetcher: typeof fetch = defaultFetch,
): EmbeddingProvider {
  if (config.kind !== 'ollama') {
    throw new Error('Local embedding retrieval requires an Ollama provider.');
  }
  if (!model.trim()) throw new Error('Local embedding retrieval requires a model name.');
  return new OllamaEmbeddingProvider(config.endpoint, model.trim(), fetcher);
}

interface OpenAiEmbeddingPayload {
  data?: Array<{ embedding?: unknown; index?: number }>;
}

type EmbeddingProviderConfig = Pick<
  ProviderConfig,
  'kind' | 'endpoint' | 'apiKey' | 'connectionValues'
>;

/** Embeds through any OpenAI-compatible `/embeddings` endpoint (OpenAI, LM Studio, LiteLLM, Azure, …). */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly config: EmbeddingProviderConfig,
    private readonly model: string,
    private readonly fetcher: typeof fetch = defaultFetch,
  ) {}

  private url(): string {
    const endpoint = this.config.endpoint.replace(/\/+$/, '');
    if (this.config.kind === 'azure-openai') {
      const apiVersion = providerConnectionValue(this.config as ProviderConfig, 'apiVersion');
      if (!apiVersion) throw new Error('Azure OpenAI requires an API version.');
      return `${endpoint}/openai/deployments/${encodeURIComponent(this.model)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`;
    }
    return `${endpoint}/embeddings`;
  }

  async embed(input: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const body =
      this.config.kind === 'azure-openai'
        ? { input }
        : { model: this.model, input };
    const response = await openStream(this.fetcher, this.url(), {
      method: 'POST',
      headers: providerRequestHeaders(this.config, true),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Embedding request failed with ${response.status} ${response.statusText}`.trim(),
      );
    }
    const payload = (await response.json()) as OpenAiEmbeddingPayload;
    const rows = Array.isArray(payload.data) ? payload.data : [];
    if (!rows.length) throw new Error('Embedding provider returned no vectors.');
    const vectors = [...rows]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((row) => row.embedding);
    if (
      vectors.some(
        (vector) => !Array.isArray(vector) || vector.some((value) => typeof value !== 'number'),
      )
    ) {
      throw new Error('Embedding provider returned invalid vectors.');
    }
    return vectors as number[][];
  }
}

const embeddingCapableKinds: ConfiguredProviderKind[] = [
  'ollama',
  'openai-compatible',
  'azure-openai',
];

/** Whether a provider kind exposes an embeddings endpoint IRIS knows how to call. */
export function providerSupportsEmbeddings(kind: ConfiguredProviderKind): boolean {
  return embeddingCapableKinds.includes(kind);
}

/** Builds an embedding provider for any embedding-capable configured provider. */
export function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
  model: string,
  fetcher: typeof fetch = defaultFetch,
): EmbeddingProvider {
  if (!model.trim()) throw new Error('Embedding retrieval requires a model name.');
  if (config.kind === 'ollama') {
    return new OllamaEmbeddingProvider(config.endpoint, model.trim(), fetcher);
  }
  if (config.kind === 'openai-compatible' || config.kind === 'azure-openai') {
    return new OpenAiEmbeddingProvider(config, model.trim(), fetcher);
  }
  throw new Error('This provider type does not support embeddings in IRIS.');
}

type ProviderStreamFormat = 'sse' | 'ndjson';

interface StreamPayload {
  choices?: Array<{
    delta?: {
      content?: string;
      // OpenRouter's unified field is `reasoning`; some other OpenAI-compatible gateways
      // (DeepSeek, vLLM, LiteLLM) mirror OpenAI's naming and use `reasoning_content` instead.
      reasoning?: string;
      reasoning_content?: string;
      // OpenRouter's reasoning-continuity blocks. Each entry's shape depends on the underlying
      // model, so this is never interpreted — only accumulated by `index` and replayed verbatim.
      reasoning_details?: Array<Record<string, unknown>>;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  message?: {
    content?: string;
    // Ollama's `think` option streams the reasoning trace on this field.
    thinking?: string;
    tool_calls?: Array<{
      function?: { name?: string; arguments?: unknown };
    }>;
  };
  done?: boolean;
  // OpenAI-compatible SSE emits usage on a trailing chunk when include_usage is set.
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  // Ollama reports token counts on the final ndjson record.
  prompt_eval_count?: number;
  eval_count?: number;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

function modelUrl(config: ProviderConfig, model: string): string {
  const endpoint = config.endpoint.replace(/\/+$/, '');
  if (config.kind === 'ollama') return `${endpoint}/api/chat`;
  if (config.kind === 'azure-openai') {
    const apiVersion = providerConnectionValue(config, 'apiVersion');
    if (!apiVersion) throw new Error('Azure OpenAI requires an API version.');
    return `${endpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  }
  return `${endpoint}/chat/completions`;
}

async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) yield line;
    }
    buffer += decoder.decode();
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

function parseToolInput(name: string, value: unknown): unknown {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Model returned invalid JSON arguments for tool ${name}.`);
  }
}

function providerMessages(messages: ModelMessage[], format: ProviderStreamFormat): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: message.role,
        content: message.content,
        ...(format === 'sse'
          ? { tool_call_id: message.toolCallId }
          : { tool_name: message.toolName }),
      };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: message.role,
        content: format === 'sse' ? message.content || null : message.content,
        // Sent back exactly as received so a reasoning model routed through OpenRouter keeps the
        // context that led to these tool calls instead of losing it on the next round.
        ...(format === 'sse' && message.reasoningDetails?.length
          ? { reasoning_details: message.reasoningDetails }
          : {}),
        tool_calls: message.toolCalls.map((call) => ({
          ...(format === 'sse' ? { id: call.id, type: 'function' } : {}),
          function: {
            name: call.name,
            arguments: format === 'sse' ? JSON.stringify(call.input) : call.input,
          },
        })),
      };
    }
    if (message.images?.length) {
      return format === 'sse'
        ? {
            role: message.role,
            content: [
              ...(message.content ? [{ type: 'text', text: message.content }] : []),
              ...message.images.map((image) => ({
                type: 'image_url',
                image_url: { url: `data:${image.mimeType};base64,${image.data}` },
              })),
            ],
          }
        : {
            role: message.role,
            content: message.content,
            // Ollama takes images as bare base64 on the message, not a content-block array.
            images: message.images.map((image) => image.data),
          };
    }
    return { role: message.role, content: message.content };
  });
}

function providerTools(tools: ModelToolDefinition[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function isOpenRouterHost(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

/**
 * Reasoning-effort request fields for OpenAI-compatible chat completions. OpenRouter's unified
 * gateway accepts the nested `reasoning.effort` form and translates it for whichever underlying
 * model handles the request; plain OpenAI (and gateways that mirror its API, e.g. vLLM, LiteLLM)
 * expect the flat `reasoning_effort` field instead. Sent only when the caller actually requested
 * a level above 'none'.
 */
function reasoningRequestFields(
  config: Pick<ProviderConfig, 'endpoint'>,
  effort: ReasoningEffort,
): Record<string, unknown> {
  if (isOpenRouterHost(config.endpoint)) return { reasoning: { effort } };
  return { reasoning_effort: effort };
}

// Mirrors the trailing cache_control breakpoint used for native Anthropic (see
// `withTrailingCacheControl`), but for OpenRouter's OpenAI-shaped `messages` array: the system
// prompt gets its own breakpoint (identical every round), and the newest message gets one too, so
// the unchanged prefix between them — which is most of a growing tool-calling turn — reads from
// cache on every later round instead of being billed as fresh input again. OpenRouter documents
// this exact `cache_control`-on-content-part format; scoped to OpenRouter specifically because
// plain OpenAI-compatible endpoints (which cache automatically server-side, no field needed) may
// reject an unrecognized body field outright.
function withOpenRouterCacheControl(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const cacheControl = { type: 'ephemeral' };
  const textBlock = (text: string) => [{ type: 'text', text, cache_control: cacheControl }];
  const marked = messages.map((message) =>
    message.role === 'system' && typeof message.content === 'string' && message.content
      ? { ...message, content: textBlock(message.content) }
      : message,
  );
  if (marked.length === 0) return marked;
  const lastIndex = marked.length - 1;
  const last = marked[lastIndex];
  if (typeof last.content === 'string' && last.content) {
    marked[lastIndex] = { ...last, content: textBlock(last.content) };
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const parts = last.content.slice();
    parts[parts.length - 1] = { ...(parts[parts.length - 1] as object), cache_control: cacheControl };
    marked[lastIndex] = { ...last, content: parts };
  }
  return marked;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Pulls a human-readable message out of a provider's JSON error body, matching the common
 * `{error: {message}}` and `{error: "..."}` shapes without assuming one specific provider. */
function errorMessageFromPayload(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  if (typeof record.error === 'string' && record.error.trim()) return record.error.trim();
  const errorRecord = asRecord(record.error);
  if (typeof errorRecord?.message === 'string' && errorRecord.message.trim()) {
    return errorRecord.message.trim();
  }
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  return undefined;
}

/**
 * Describes a failed streaming response using the provider's own error body when it sent one
 * (OpenRouter and most OpenAI-compatible gateways return real detail — a rate limit reason, a
 * quota message — behind a generic status line), falling back to the bare status otherwise.
 */
async function describeFailedModelResponse(response: Response): Promise<string> {
  const raw = await response
    .text()
    .then((text) => text.trim())
    .catch(() => '');
  let detail: string | undefined;
  if (raw) {
    try {
      detail = errorMessageFromPayload(JSON.parse(raw)) ?? raw.slice(0, 300);
    } catch {
      detail = raw.slice(0, 300);
    }
  }
  // A rate-limit gateway commonly sends this header even with an empty body, so it is worth
  // surfacing on its own — it is the only real, verifiable detail some 429 responses carry.
  const retryAfter = response.headers.get('retry-after')?.trim();
  const retryDetail = retryAfter ? `Retry after ${retryAfter}.` : undefined;
  const combinedDetail = [detail, retryDetail].filter(Boolean).join(' ');
  if (combinedDetail) return `Model request failed with ${response.status}: ${combinedDetail}`;
  const statusText = response.statusText ? ` ${response.statusText}` : '';
  return `Model request failed with ${response.status}${statusText}`.trim();
}

function usageNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Builds a usage record, keeping only the counts a provider actually reported. */
function toUsage(input?: number, output?: number): TokenUsage | undefined {
  if (input === undefined && output === undefined) return undefined;
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

function eventPayload(line: string): unknown | undefined {
  // SSE permits comments and metadata (`event:`, `id:`, `retry:`) between data
  // records. Only data records contain provider JSON.
  if (!/^data:\s*/.test(line)) return undefined;
  const payload = line.replace(/^data:\s*/, '').trim();
  if (!payload || payload === '[DONE]') return undefined;
  return JSON.parse(payload) as unknown;
}

function streamPayload(line: string, format: ProviderStreamFormat): unknown | undefined {
  if (format === 'sse') return eventPayload(line);
  const payload = line.trim();
  if (!payload) return undefined;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    throw new Error('Model provider returned malformed streaming JSON.');
  }
}

// Marks the last content block of the last message with an ephemeral cache breakpoint. Anthropic
// caches everything up to and including a breakpoint, so as the agent loop appends tool calls and
// results turn after turn, moving this single marker onto the newest tail lets every prior byte of
// the (unchanged) prefix hit the cache instead of being billed as fresh input again.
function withTrailingCacheControl(messages: { role: string; content: unknown[] }[]): unknown[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (!Array.isArray(last.content) || last.content.length === 0) return messages;
  const blocks = last.content.slice();
  const lastBlock = blocks[blocks.length - 1] as Record<string, unknown>;
  blocks[blocks.length - 1] = { ...lastBlock, cache_control: { type: 'ephemeral' } };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

function anthropicMessages(messages: ModelMessage[]): {
  system?: unknown[];
  messages: unknown[];
} {
  const systemText = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .filter(Boolean)
    .join('\n\n');
  // The system prompt and the assigned skills/memory it carries are identical on every round of
  // a turn, so it gets its own cache breakpoint independent of the growing conversation below.
  const system = systemText
    ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
    : undefined;
  const converted: { role: string; content: unknown[] }[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      converted.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: message.content,
          },
        ],
      });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      converted.push({
        role: 'assistant',
        content: [
          // Preserved thinking blocks must lead an assistant turn's content, exactly as returned —
          // that is how the API verifies this round's tool calls followed from that reasoning.
          ...(message.thinkingBlocks?.map((block) =>
            block.type === 'thinking'
              ? { type: 'thinking', thinking: block.thinking, signature: block.signature }
              : { type: 'redacted_thinking', data: block.data },
          ) ?? []),
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.input,
          })),
        ],
      });
      continue;
    }
    if (message.images?.length) {
      converted.push({
        role: message.role,
        content: [
          ...message.images.map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mimeType, data: image.data },
          })),
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ],
      });
      continue;
    }
    converted.push({ role: message.role, content: [{ type: 'text', text: message.content }] });
  }
  return { system, messages: withTrailingCacheControl(converted) };
}

function anthropicTools(tools: ModelToolDefinition[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined;
  // A second breakpoint after the (also turn-invariant) tool list caches system+tools together in
  // one prefix, separate from the conversation breakpoint above.
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(index === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));
}

// Anthropic's extended thinking takes a token budget rather than a qualitative level; these are
// the tier midpoints Claude Code itself uses. The API requires budget_tokens < max_tokens and
// rejects an explicit temperature while thinking is enabled, so both are adjusted below.
const anthropicThinkingBudgets: Record<Exclude<ReasoningEffort, 'none'>, number> = {
  low: 2000,
  medium: 6000,
  high: 16000,
};

async function* streamAnthropic(
  config: ProviderConfig,
  request: ModelRequest,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): AsyncGenerator<ModelChunk> {
  const converted = anthropicMessages(request.messages);
  const thinkingBudget =
    request.reasoningEffort && request.reasoningEffort !== 'none'
      ? anthropicThinkingBudgets[request.reasoningEffort]
      : undefined;
  const maxTokens = Math.max(request.maxTokens ?? 4096, thinkingBudget ? thinkingBudget + 2048 : 0);
  // Without this beta header, thinking resets to blank on every tool-result round-trip even when
  // the prior thinking block is sent back — the model can't build on what it already reasoned
  // through, which is exactly the "thinks hard, then goes dark for every later step" complaint this
  // is fixing. With it, thinking carries forward between tool calls within the same turn.
  const baseHeaders = providerRequestHeaders(config, true) as Record<string, string> | undefined;
  const headers = thinkingBudget
    ? { ...baseHeaders, 'anthropic-beta': 'interleaved-thinking-2025-05-14' }
    : baseHeaders;
  const response = await openStream(fetcher, `${config.endpoint.replace(/\/+$/, '')}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: request.model,
      max_tokens: maxTokens,
      system: converted.system,
      messages: converted.messages,
      stream: true,
      tools: anthropicTools(request.tools),
      // Thinking and a custom temperature are mutually exclusive on Anthropic's API.
      temperature: thinkingBudget ? undefined : request.temperature,
      stop_sequences: request.stopSequences,
      thinking: thinkingBudget
        ? { type: 'enabled', budget_tokens: thinkingBudget }
        : undefined,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await describeFailedModelResponse(response));
  }
  if (!response.body) throw new Error('Model provider returned no stream.');

  const pendingToolCalls = new Map<number, PendingToolCall>();
  const pendingThinking = new Map<number, ModelThinkingBlock>();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for await (const line of readLines(response.body)) {
    const event = asRecord(eventPayload(line));
    if (!event) continue;
    if (event.type === 'error') {
      const error = asRecord(event.error);
      throw new Error(
        typeof error?.message === 'string' ? error.message : 'Anthropic stream failed.',
      );
    }
    if (event.type === 'message_start') {
      const usage = asRecord(asRecord(event.message)?.usage);
      // Cache writes/reads are billed (at 1.25x/0.1x) but are real tokens processed, so they count
      // toward the reported input total — otherwise caching would make usage look artificially low.
      const cacheTokens =
        (usageNumber(usage?.cache_creation_input_tokens) ?? 0) +
        (usageNumber(usage?.cache_read_input_tokens) ?? 0);
      const baseInputTokens = usageNumber(usage?.input_tokens);
      inputTokens = baseInputTokens !== undefined ? baseInputTokens + cacheTokens : inputTokens;
      outputTokens = usageNumber(usage?.output_tokens) ?? outputTokens;
    }
    if (event.type === 'message_delta') {
      // Anthropic reports cumulative output tokens on each delta; the last wins.
      outputTokens = usageNumber(asRecord(event.usage)?.output_tokens) ?? outputTokens;
    }
    const index = typeof event.index === 'number' ? event.index : 0;
    if (event.type === 'content_block_start') {
      const block = asRecord(event.content_block);
      if (block?.type === 'tool_use') {
        pendingToolCalls.set(index, {
          id: typeof block.id === 'string' ? block.id : `tool-call-${index}`,
          name: typeof block.name === 'string' ? block.name : '',
          arguments:
            block.input && asRecord(block.input) && Object.keys(asRecord(block.input) ?? {}).length
              ? JSON.stringify(block.input)
              : '',
        });
      }
      if (block?.type === 'thinking') {
        pendingThinking.set(index, { type: 'thinking', thinking: '', signature: '' });
      }
      // A redacted block's whole opaque payload arrives in this one event — no deltas follow it.
      if (block?.type === 'redacted_thinking') {
        pendingThinking.set(index, {
          type: 'redacted_thinking',
          data: typeof block.data === 'string' ? block.data : '',
        });
      }
    }
    if (event.type === 'content_block_delta') {
      const delta = asRecord(event.delta);
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        yield { text: delta.text, done: false };
      }
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        yield { text: '', done: false, reasoningText: delta.thinking };
        const pending = pendingThinking.get(index);
        if (pending?.type === 'thinking') pending.thinking += delta.thinking;
      }
      if (delta?.type === 'signature_delta' && typeof delta.signature === 'string') {
        const pending = pendingThinking.get(index);
        if (pending?.type === 'thinking') pending.signature += delta.signature;
      }
      if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const pending = pendingToolCalls.get(index);
        if (pending) pending.arguments += delta.partial_json;
      }
    }
  }
  const toolCalls = [...pendingToolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => {
      if (!call.name) throw new Error('Model returned a tool call without a name.');
      return { id: call.id, name: call.name, input: parseToolInput(call.name, call.arguments) };
    });
  const thinkingBlocks = [...pendingThinking.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => block);
  const usage = toUsage(inputTokens, outputTokens);
  yield {
    text: '',
    done: true,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(thinkingBlocks.length ? { thinkingBlocks } : {}),
    ...(usage ? { usage } : {}),
  };
}

function geminiContents(messages: ModelMessage[]): unknown[] {
  return messages.flatMap((message) => {
    if (message.role === 'system') return [];
    if (message.role === 'tool') {
      return [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: message.toolName,
                response: { content: message.content },
              },
            },
          ],
        },
      ];
    }
    const parts: unknown[] = message.content ? [{ text: message.content }] : [];
    for (const image of message.images ?? []) {
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    }
    for (const call of message.toolCalls ?? []) {
      parts.push({ functionCall: { name: call.name, args: call.input } });
    }
    return [{ role: message.role === 'assistant' ? 'model' : 'user', parts }];
  });
}

async function* streamGemini(
  config: ProviderConfig,
  request: ModelRequest,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): AsyncGenerator<ModelChunk> {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .filter(Boolean)
    .join('\n\n');
  const tools = request.tools?.length
    ? [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        },
      ]
    : undefined;
  const endpoint = config.endpoint.replace(/\/+$/, '');
  const response = await openStream(
    fetcher,
    `${endpoint}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      headers: providerRequestHeaders(config, true),
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: geminiContents(request.messages),
        tools,
        generationConfig:
          request.temperature === undefined && request.maxTokens === undefined
            ? undefined
            : {
                ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
                ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
              },
      }),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(await describeFailedModelResponse(response));
  }
  if (!response.body) throw new Error('Model provider returned no stream.');

  const toolCalls: ModelToolCall[] = [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for await (const line of readLines(response.body)) {
    const event = asRecord(eventPayload(line));
    if (!event) continue;
    const error = asRecord(event.error);
    if (error) {
      throw new Error(typeof error.message === 'string' ? error.message : 'Gemini stream failed.');
    }
    const usageMetadata = asRecord(event.usageMetadata);
    if (usageMetadata) {
      inputTokens = usageNumber(usageMetadata.promptTokenCount) ?? inputTokens;
      outputTokens = usageNumber(usageMetadata.candidatesTokenCount) ?? outputTokens;
    }
    const candidates = Array.isArray(event.candidates) ? event.candidates : [];
    const candidate = asRecord(candidates[0]);
    const content = asRecord(candidate?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const [index, partValue] of parts.entries()) {
      const part = asRecord(partValue);
      if (typeof part?.text === 'string' && part.text) {
        yield { text: part.text, done: false };
      }
      const functionCall = asRecord(part?.functionCall);
      if (functionCall && typeof functionCall.name === 'string') {
        toolCalls.push({
          id: `gemini-tool-call-${toolCalls.length + index}`,
          name: functionCall.name,
          input: functionCall.args ?? {},
        });
      }
    }
  }
  const usage = toUsage(inputTokens, outputTokens);
  yield { text: '', done: true, ...(toolCalls.length ? { toolCalls } : {}), ...(usage ? { usage } : {}) };
}

function cohereToolDeltas(event: Record<string, unknown>): Array<Record<string, unknown>> {
  const delta = asRecord(event.delta);
  const message = asRecord(delta?.message);
  return Array.isArray(message?.tool_calls)
    ? message.tool_calls.flatMap((value) => (asRecord(value) ? [asRecord(value)!] : []))
    : [];
}

async function* streamCohere(
  config: ProviderConfig,
  request: ModelRequest,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): AsyncGenerator<ModelChunk> {
  const response = await openStream(fetcher, `${config.endpoint.replace(/\/+$/, '')}/v2/chat`, {
    method: 'POST',
    headers: providerRequestHeaders(config, true),
    body: JSON.stringify({
      model: request.model,
      messages: providerMessages(request.messages, 'sse'),
      stream: true,
      tools: providerTools(request.tools),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stop_sequences: request.stopSequences,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await describeFailedModelResponse(response));
  }
  if (!response.body) throw new Error('Model provider returned no stream.');

  const pendingToolCalls = new Map<number, PendingToolCall>();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for await (const line of readLines(response.body)) {
    const event = asRecord(eventPayload(line));
    if (!event) continue;
    if (event.type === 'message-end') {
      const usage = asRecord(asRecord(event.delta)?.usage);
      const tokens = asRecord(usage?.tokens) ?? asRecord(usage?.billed_units);
      inputTokens = usageNumber(tokens?.input_tokens) ?? inputTokens;
      outputTokens = usageNumber(tokens?.output_tokens) ?? outputTokens;
    }
    if (event.type === 'content-delta') {
      const delta = asRecord(event.delta);
      const message = asRecord(delta?.message);
      const content = asRecord(message?.content);
      if (typeof content?.text === 'string' && content.text) {
        yield { text: content.text, done: false };
      }
    }
    for (const [fallbackIndex, toolCall] of cohereToolDeltas(event).entries()) {
      const index = typeof toolCall.index === 'number' ? toolCall.index : fallbackIndex;
      const functionCall = asRecord(toolCall.function);
      const pending = pendingToolCalls.get(index) ?? {
        id: typeof toolCall.id === 'string' ? toolCall.id : `cohere-tool-call-${index}`,
        name: '',
        arguments: '',
      };
      if (typeof toolCall.id === 'string') pending.id = toolCall.id;
      if (typeof functionCall?.name === 'string') pending.name += functionCall.name;
      if (typeof functionCall?.arguments === 'string') {
        pending.arguments += functionCall.arguments;
      }
      pendingToolCalls.set(index, pending);
    }
  }
  const toolCalls = [...pendingToolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => {
      if (!call.name) throw new Error('Model returned a tool call without a name.');
      return { id: call.id, name: call.name, input: parseToolInput(call.name, call.arguments) };
    });
  const usage = toUsage(inputTokens, outputTokens);
  yield { text: '', done: true, ...(toolCalls.length ? { toolCalls } : {}), ...(usage ? { usage } : {}) };
}

export class ConfiguredModelProvider implements ModelProvider {
  readonly definition: ProviderDefinition;
  private readonly streamFormat: ProviderStreamFormat;
  private readonly fetcher: typeof fetch;
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig, fetcher: typeof fetch = defaultFetch) {
    this.config = config;
    this.fetcher = fetcher;
    this.streamFormat = config.kind === 'ollama' ? 'ndjson' : 'sse';
    this.definition = {
      id: config.id,
      name: config.name,
      kind: config.kind,
      capabilities: ['chat', 'streaming', 'tools'],
      local: (() => {
        if (config.kind === 'ollama') return true;
        try {
          const hostname = new URL(config.endpoint).hostname;
          return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
        } catch {
          return false;
        }
      })(),
      reasoningContinuity:
        config.kind === 'anthropic' ||
        (config.kind === 'openai-compatible' && isOpenRouterHost(config.endpoint)),
    };
  }

  capabilities(): Capability[] {
    return this.definition.capabilities;
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    await testProviderConnection(this.config, async (input, init) =>
      this.fetcher(input, { ...init, signal }),
    );
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelChunk> {
    if (this.config.kind === 'anthropic') {
      yield* streamAnthropic(this.config, request, this.fetcher, signal);
      return;
    }
    if (this.config.kind === 'gemini') {
      yield* streamGemini(this.config, request, this.fetcher, signal);
      return;
    }
    if (this.config.kind === 'cohere') {
      yield* streamCohere(this.config, request, this.fetcher, signal);
      return;
    }
    const headers = providerRequestHeaders(this.config, true);
    const reasoningRequested = request.reasoningEffort && request.reasoningEffort !== 'none';
    const sseMessages = providerMessages(request.messages, 'sse') as Array<Record<string, unknown>>;
    const body =
      this.streamFormat === 'ndjson'
        ? {
            model: request.model,
            messages: providerMessages(request.messages, this.streamFormat),
            stream: true,
            tools: providerTools(request.tools),
            // Ollama's reasoning models (deepseek-r1, qwen3, gpt-oss, …) gate their thinking
            // trace behind this flag; effort levels aren't otherwise adjustable there.
            think: reasoningRequested ? true : undefined,
            options:
              request.temperature === undefined && request.maxTokens === undefined
                ? undefined
                : {
                    ...(request.temperature === undefined
                      ? {}
                      : { temperature: request.temperature }),
                    ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens }),
                  },
          }
        : {
            model: this.config.kind === 'azure-openai' ? undefined : request.model,
            messages: isOpenRouterHost(this.config.endpoint)
              ? withOpenRouterCacheControl(sseMessages)
              : sseMessages,
            stream: true,
            // Ask OpenAI-compatible servers to append a final usage-only chunk.
            stream_options: { include_usage: true },
            tools: providerTools(request.tools),
            temperature: request.temperature,
            max_tokens: request.maxTokens,
            stop: request.stopSequences?.length ? request.stopSequences : undefined,
            ...(reasoningRequested
              ? reasoningRequestFields(this.config, request.reasoningEffort as ReasoningEffort)
              : {}),
          };
    const response = await openStream(this.fetcher, modelUrl(this.config, request.model), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new Error(await describeFailedModelResponse(response));
    }
    if (!response.body) throw new Error('Model provider returned no stream.');

    const pendingToolCalls = new Map<number, PendingToolCall>();
    const pendingReasoningDetails = new Map<number, Record<string, unknown>>();
    let ollamaToolCalls: ModelToolCall[] = [];
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    for await (const line of readLines(response.body)) {
      const chunk = streamPayload(line, this.streamFormat) as StreamPayload | undefined;
      if (!chunk) continue;
      // Merge each reasoning-continuity block by its own `index` across chunks: string fields
      // (text, signature, …) accumulate like a normal streamed delta, everything else — a block
      // shape we don't need to understand, only reassemble — is taken as-is from the latest chunk.
      for (const [fallbackIndex, detail] of (
        chunk.choices?.[0]?.delta?.reasoning_details ?? []
      ).entries()) {
        const index = typeof detail.index === 'number' ? detail.index : fallbackIndex;
        const merged = { ...(pendingReasoningDetails.get(index) ?? {}) };
        for (const [key, value] of Object.entries(detail)) {
          merged[key] =
            typeof value === 'string' && typeof merged[key] === 'string'
              ? (merged[key] as string) + value
              : value;
        }
        pendingReasoningDetails.set(index, merged);
      }
      if (chunk.usage) {
        inputTokens = usageNumber(chunk.usage.prompt_tokens) ?? inputTokens;
        outputTokens = usageNumber(chunk.usage.completion_tokens) ?? outputTokens;
      }
      if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined) {
        inputTokens = usageNumber(chunk.prompt_eval_count) ?? inputTokens;
        outputTokens = usageNumber(chunk.eval_count) ?? outputTokens;
      }
      for (const toolCall of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
        const pending = pendingToolCalls.get(toolCall.index) ?? {
          id: toolCall.id ?? `tool-call-${toolCall.index}`,
          name: '',
          arguments: '',
        };
        if (toolCall.id) pending.id = toolCall.id;
        if (toolCall.function?.name) pending.name += toolCall.function.name;
        if (toolCall.function?.arguments) pending.arguments += toolCall.function.arguments;
        pendingToolCalls.set(toolCall.index, pending);
      }
      if (chunk.message?.tool_calls?.length) {
        ollamaToolCalls = chunk.message.tool_calls.map((call, index) => {
          const name = call.function?.name ?? '';
          if (!name) throw new Error('Model returned a tool call without a name.');
          return {
            id: `ollama-tool-call-${index}`,
            name,
            input: parseToolInput(name, call.function?.arguments),
          };
        });
      }
      const text =
        this.streamFormat === 'sse'
          ? (chunk.choices?.[0]?.delta?.content ?? '')
          : (chunk.message?.content ?? '');
      const reasoningText =
        this.streamFormat === 'sse'
          ? (chunk.choices?.[0]?.delta?.reasoning ?? chunk.choices?.[0]?.delta?.reasoning_content ?? '')
          : (chunk.message?.thinking ?? '');
      const done = this.streamFormat === 'sse' ? false : Boolean(chunk.done);
      if (text || reasoningText || done) {
        const usage = done ? toUsage(inputTokens, outputTokens) : undefined;
        yield {
          text,
          done,
          ...(reasoningText ? { reasoningText } : {}),
          ...(done && ollamaToolCalls.length ? { toolCalls: ollamaToolCalls } : {}),
          ...(usage ? { usage } : {}),
        };
      }
    }
    if (this.streamFormat === 'sse') {
      const toolCalls = [...pendingToolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => {
          if (!call.name) throw new Error('Model returned a tool call without a name.');
          return {
            id: call.id,
            name: call.name,
            input: parseToolInput(call.name, call.arguments),
          };
        });
      const reasoningDetails = [...pendingReasoningDetails.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, detail]) => detail);
      const usage = toUsage(inputTokens, outputTokens);
      yield {
        text: '',
        done: true,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(reasoningDetails.length ? { reasoningDetails } : {}),
        ...(usage ? { usage } : {}),
      };
    }
  }
}

export function createModelProvider(
  config: ProviderConfig,
  fetcher: typeof fetch = defaultFetch,
): ModelProvider {
  return new ConfiguredModelProvider(config, fetcher);
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A base64-encoded image attached to a message. `data` carries no `data:` URL prefix. */
export interface ModelImage {
  mimeType: string;
  data: string;
}

/**
 * A verbatim extended-thinking block from Anthropic's interleaved thinking. `signature` (or, for a
 * flagged block, the opaque `data`) is issued by the API and must be preserved byte-for-byte when
 * the block is sent back — it is how the API verifies the thinking wasn't tampered with. Never
 * construct one of these by hand; only ever round-trip what a provider returned.
 */
export type ModelThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ModelToolCall[];
  /**
   * Extended-thinking blocks that accompanied `toolCalls` on this assistant turn, present only for
   * Anthropic's interleaved thinking. Round-tripped verbatim on the next request so the model keeps
   * the reasoning that led to these tool calls instead of starting the next round blind.
   */
  thinkingBlocks?: ModelThinkingBlock[];
  /**
   * OpenRouter's unified `reasoning_details` — the same continuity mechanism as `thinkingBlocks`,
   * for reasoning models routed through OpenRouter. Deliberately untyped: OpenRouter documents
   * several block shapes depending on the underlying model, and this is never interpreted, only
   * captured from a response and replayed verbatim on the next request.
   */
  reasoningDetails?: unknown[];
  /** Vision-capable models only; providers that cannot accept images ignore this. */
  images?: ModelImage[];
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  /** 'none' or unset sends no reasoning request. Providers that cannot honor it ignore it. */
  reasoningEffort?: ReasoningEffort;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelChunk {
  text: string;
  done: boolean;
  toolCalls?: ModelToolCall[];
  /** Present on the final chunk of a stream when the provider reports token counts. */
  usage?: TokenUsage;
  /** A piece of the model's reasoning/thinking trace, when the provider streams one. */
  reasoningText?: string;
  /** Present on the final chunk alongside `toolCalls`, for interleaved thinking. See `ModelMessage.thinkingBlocks`. */
  thinkingBlocks?: ModelThinkingBlock[];
  /** Present on the final chunk alongside `toolCalls`. See `ModelMessage.reasoningDetails`. */
  reasoningDetails?: unknown[];
}

export interface ModelProvider {
  definition: ProviderDefinition;
  capabilities(): Capability[];
  testConnection(signal?: AbortSignal): Promise<void>;
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelChunk>;
}
