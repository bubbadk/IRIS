import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProviderConfig,
  createOllamaEmbeddingProvider,
  createModelProvider,
  fetchProviderModels,
  loadProviderCatalog,
  loadProviderConfigs,
  missingProviderConnectionFields,
  providerCatalog,
  providerAcceptsApiKey,
  providerRequiresApiKey,
  ProviderRegistry,
  refreshProviderCatalog,
  refreshProviderModels,
  saveProviderConfigs,
  subscribeProviderConfigs,
  testProviderConnection,
  validateProviderConfig,
  type ProviderConfig,
} from './index';

const provider: ProviderConfig = {
  id: 'openai-1',
  name: 'Work models',
  kind: 'openai-compatible',
  endpoint: 'https://example.com/v1',
  model: 'example-model',
  apiKey: 'secret-value',
  enabled: true,
};

beforeEach(() => {
  const values = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
});

afterEach(() => vi.unstubAllGlobals());

describe('provider configuration', () => {
  it('offers every implemented provider path through a first-class catalog', () => {
    expect(providerCatalog.map((entry) => entry.id)).toEqual([
      'openai',
      'anthropic',
      'google',
      'cohere',
      'ollama',
      'lmstudio-local',
      'localai-local',
      'vllm-local',
      'llamacpp-local',
      'antigravity-local',
      'openai-compatible',
      'anthropic-compatible',
      'azure',
    ]);
    expect(createProviderConfig('openai')).toMatchObject({
      name: 'OpenAI',
      kind: 'openai-compatible',
      endpoint: 'https://api.openai.com/v1',
      model: '',
      catalogId: 'openai',
    });
    expect(createProviderConfig('ollama')).toMatchObject({
      name: 'Local Ollama',
      kind: 'ollama',
      endpoint: 'http://localhost:11434',
      model: '',
      catalogId: 'ollama',
    });
    expect(createProviderConfig('antigravity-local')).toMatchObject({
      name: 'Antigravity (agy)',
      kind: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8788/v1',
      model: '',
      catalogId: 'antigravity-local',
    });
    expect(providerRequiresApiKey(createProviderConfig('antigravity-local'))).toBe(false);
    expect(providerAcceptsApiKey(createProviderConfig('antigravity-local'))).toBe(false);
    expect(createProviderConfig('anthropic')).toMatchObject({
      kind: 'anthropic',
      credentialMode: 'required',
      endpoint: 'https://api.anthropic.com/v1',
    });
    expect(createProviderConfig('azure')).toMatchObject({
      kind: 'azure-openai',
      endpoint: '',
      model: '',
      connectionValues: { apiVersion: '2024-10-21' },
      connectionFields: [
        { id: 'apiKey', secret: true, required: true },
        { id: 'apiVersion', secret: false, required: true },
      ],
    });
  });

  it('syncs and caches the complete provider directory without claiming unsupported adapters', async () => {
    const catalog = await refreshProviderCatalog(async (input) => {
      expect(String(input)).toBe('https://models.dev/api.json');
      return new Response(
        JSON.stringify({
          'alpha-cloud': {
            name: 'Alpha Cloud',
            npm: '@ai-sdk/openai-compatible',
            api: 'https://api.alpha.example/v1',
            env: ['ALPHA_API_KEY'],
          },
          'bedrock-example': {
            name: 'Bedrock Example',
            npm: '@ai-sdk/amazon-bedrock',
            env: ['AWS_ACCESS_KEY_ID'],
          },
        }),
      );
    });

    expect(catalog.find((entry) => entry.id === 'alpha-cloud')).toMatchObject({
      kind: 'openai-compatible',
      endpoint: 'https://api.alpha.example/v1',
      credentialMode: 'required',
      supported: true,
      source: 'models.dev',
    });
    expect(catalog.find((entry) => entry.id === 'bedrock-example')).toMatchObject({
      supported: false,
      supportReason: 'Adapter required for @ai-sdk/amazon-bedrock.',
    });
    expect(loadProviderCatalog()).toEqual(catalog);
  });

  it('derives credential requirements from the catalog instead of provider branding', () => {
    expect(providerRequiresApiKey(createProviderConfig('openai'))).toBe(true);
    expect(providerRequiresApiKey(createProviderConfig('ollama'))).toBe(false);
    expect(providerAcceptsApiKey(createProviderConfig('lmstudio-local'))).toBe(true);
    expect(providerRequiresApiKey(createProviderConfig('lmstudio-local'))).toBe(false);
  });

  it('validates required fields and endpoint URLs', () => {
    expect(validateProviderConfig({ name: '', endpoint: 'not-a-url', model: '' })).toEqual([
      'Give this provider a name.',
      'Endpoint must be a valid URL.',
      'Add a model name.',
    ]);
  });

  it('persists configuration metadata without secrets', () => {
    saveProviderConfigs([
      {
        ...provider,
        availableModels: ['example-model', 'other-model'],
        modelsRefreshedAt: '2026-08-27T10:00:00.000Z',
      },
    ]);

    expect(localStorage.getItem('iris.providers.config.v2')).not.toContain('secret-value');
    expect(loadProviderConfigs()).toEqual([
      expect.objectContaining({
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        endpoint: provider.endpoint,
        model: provider.model,
        enabled: provider.enabled,
        catalogId: 'openai-compatible',
        credentialMode: 'optional',
        availableModels: ['example-model', 'other-model'],
        modelsRefreshedAt: '2026-08-27T10:00:00.000Z',
        connectionValues: {},
        storedSecretFields: [],
      }),
    ]);
  });

  it('persists non-secret connection fields and strips structured secrets', () => {
    const azure = createProviderConfig('azure');
    saveProviderConfigs([
      {
        ...azure,
        endpoint: 'https://iris-resource.openai.azure.com',
        model: 'iris-chat',
        connectionValues: { apiKey: 'azure-secret', apiVersion: '2024-10-21' },
      },
    ]);

    const stored = localStorage.getItem('iris.providers.config.v2') ?? '';
    expect(stored).not.toContain('azure-secret');
    expect(stored).toContain('2024-10-21');
    expect(loadProviderConfigs()[0]).toMatchObject({
      connectionValues: { apiVersion: '2024-10-21' },
      storedSecretFields: [],
    });
  });

  it('persists only explicit credential-store markers', () => {
    saveProviderConfigs([
      {
        ...provider,
        apiKey: undefined,
        connectionValues: { apiKey: 'keyring-copy' },
        storedSecretFields: ['apiKey'],
      },
    ]);

    const stored = localStorage.getItem('iris.providers.config.v2') ?? '';
    expect(stored).not.toContain('keyring-copy');
    expect(loadProviderConfigs()[0]?.storedSecretFields).toEqual(['apiKey']);
  });

  it('validates Azure deployment, API version, and API key independently', () => {
    const azure = {
      ...createProviderConfig('azure'),
      endpoint: 'https://iris-resource.openai.azure.com',
    };
    expect(validateProviderConfig(azure)).toEqual(['Add a model name.', 'Add api key.']);
    expect(missingProviderConnectionFields(azure).map((field) => field.id)).toEqual(['apiKey']);
  });

  it('keeps multiple provider configurations and notifies live consumers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProviderConfigs(listener);
    const ollama: ProviderConfig = {
      id: 'ollama-local',
      name: 'Local Ollama',
      kind: 'ollama',
      endpoint: 'http://localhost:11434',
      model: 'qwen3:8b',
      enabled: true,
      catalogId: 'ollama',
    };

    saveProviderConfigs([provider, ollama]);

    expect(loadProviderConfigs()).toHaveLength(2);
    expect(loadProviderConfigs().map((config) => config.id)).toEqual(['openai-1', 'ollama-local']);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    saveProviderConfigs([ollama]);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('discovers and normalizes real OpenAI-compatible model identifiers', async () => {
    const models = await fetchProviderModels(provider, async (input, init) => {
      expect(String(input)).toBe('https://example.com/v1/models');
      expect(init?.headers).toEqual({ Authorization: 'Bearer secret-value' });
      return new Response(
        JSON.stringify({
          data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'alpha' }, { missing: 'id' }],
        }),
      );
    });

    expect(models).toEqual(['alpha', 'zeta']);
  });

  it('uses native discovery routes and credentials for Anthropic, Gemini, and Cohere', async () => {
    const cases: Array<{
      config: ProviderConfig;
      url: string;
      headers: HeadersInit;
      payload: unknown;
      models: string[];
    }> = [
      {
        config: { ...provider, kind: 'anthropic', endpoint: 'https://api.anthropic.com/v1' },
        url: 'https://api.anthropic.com/v1/models',
        headers: { 'x-api-key': 'secret-value', 'anthropic-version': '2023-06-01' },
        payload: { data: [{ id: 'claude-sonnet' }] },
        models: ['claude-sonnet'],
      },
      {
        config: {
          ...provider,
          kind: 'gemini',
          endpoint: 'https://generativelanguage.googleapis.com/v1beta',
        },
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        headers: { 'x-goog-api-key': 'secret-value' },
        payload: { models: [{ name: 'models/gemini-pro' }] },
        models: ['gemini-pro'],
      },
      {
        config: { ...provider, kind: 'cohere', endpoint: 'https://api.cohere.com' },
        url: 'https://api.cohere.com/v1/models?endpoint=chat',
        headers: { Authorization: 'Bearer secret-value' },
        payload: { models: [{ name: 'command-r' }] },
        models: ['command-r'],
      },
    ];

    for (const testCase of cases) {
      await expect(
        fetchProviderModels(testCase.config, async (input, init) => {
          expect(String(input)).toBe(testCase.url);
          expect(init?.headers).toEqual(testCase.headers);
          return new Response(JSON.stringify(testCase.payload));
        }),
      ).resolves.toEqual(testCase.models);
    }
  });

  it('discovers Azure catalog models with the resource API version and key header', async () => {
    const azure: ProviderConfig = {
      ...createProviderConfig('azure'),
      id: 'azure-1',
      endpoint: 'https://iris-resource.openai.azure.com/',
      model: 'iris-chat-deployment',
      connectionValues: { apiKey: 'azure-secret', apiVersion: '2024-10-21' },
    };

    const refreshed = await refreshProviderModels(
      azure,
      async (input, init) => {
        expect(String(input)).toBe(
          'https://iris-resource.openai.azure.com/openai/models?api-version=2024-10-21',
        );
        expect(init?.headers).toEqual({ 'api-key': 'azure-secret' });
        return new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1' }] }));
      },
      () => new Date('2026-08-27T12:00:00.000Z'),
    );

    expect(refreshed).toMatchObject({
      model: 'iris-chat-deployment',
      availableModels: ['gpt-4.1', 'gpt-4o'],
      modelsRefreshedAt: '2026-08-27T12:00:00.000Z',
    });
  });

  it('reports Azure authentication failures without masking the provider response', async () => {
    const azure: ProviderConfig = {
      ...createProviderConfig('azure'),
      endpoint: 'https://iris-resource.openai.azure.com',
      model: 'iris-chat-deployment',
      connectionValues: { apiKey: 'invalid', apiVersion: '2024-10-21' },
    };
    await expect(
      fetchProviderModels(
        azure,
        async () =>
          new Response(null, {
            status: 401,
            statusText: 'Access denied due to invalid subscription key',
          }),
      ),
    ).rejects.toThrow(
      'Model discovery failed with 401. Access denied due to invalid subscription key',
    );
  });

  it('discovers Ollama model names and keeps an existing valid selection', async () => {
    const refreshed = await refreshProviderModels(
      {
        ...provider,
        kind: 'ollama',
        endpoint: 'http://localhost:11434/',
        model: 'qwen3:8b',
        apiKey: undefined,
      },
      async (input) => {
        expect(String(input)).toBe('http://localhost:11434/api/tags');
        return new Response(
          JSON.stringify({ models: [{ name: 'llama3.2:latest' }, { model: 'qwen3:8b' }] }),
        );
      },
      () => new Date('2026-08-27T10:00:00.000Z'),
    );

    expect(refreshed).toMatchObject({
      model: 'qwen3:8b',
      availableModels: ['llama3.2:latest', 'qwen3:8b'],
      modelsRefreshedAt: '2026-08-27T10:00:00.000Z',
    });
  });

  it('reports failed and empty model discovery without inventing availability', async () => {
    await expect(
      fetchProviderModels(provider, async () =>
        Promise.resolve(new Response(null, { status: 401, statusText: 'Unauthorized' })),
      ),
    ).rejects.toThrow('Model discovery failed with 401. Unauthorized');

    await expect(
      fetchProviderModels(provider, async () => new Response(JSON.stringify({ data: [] }))),
    ).rejects.toThrow('Provider returned no usable models.');
  });

  it('tests an OpenAI-compatible endpoint with an authorization header', async () => {
    let requestedUrl = '';
    let requestedHeaders: HeadersInit | undefined;
    await testProviderConnection(provider, async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = init?.headers;
      return { ok: true, status: 200, statusText: 'OK' };
    });

    expect(requestedUrl).toBe('https://example.com/v1/models');
    expect(requestedHeaders).toEqual({ Authorization: 'Bearer secret-value' });
  });

  it('tests Ollama through its tags endpoint and reports failed responses', async () => {
    await expect(
      testProviderConnection(
        { ...provider, kind: 'ollama', endpoint: 'http://localhost:11434/' },
        async (input) => {
          expect(String(input)).toBe('http://localhost:11434/api/tags');
          return { ok: false, status: 503, statusText: 'Unavailable' };
        },
      ),
    ).rejects.toThrow('Provider responded with 503. Unavailable');
  });

  it('keeps provider registration replaceable and isolated from the UI', () => {
    const registry = new ProviderRegistry([provider]);
    expect(registry.get(provider.id)).toEqual(provider);
    registry.register({ ...provider, name: 'Updated' });
    expect(registry.list()).toHaveLength(1);
    expect(registry.get(provider.id)?.name).toBe('Updated');
    registry.remove(provider.id);
    expect(registry.list()).toEqual([]);
  });

  it('generates a real batch through the Ollama embedding endpoint', async () => {
    const embedder = createOllamaEmbeddingProvider(
      { kind: 'ollama', endpoint: 'http://localhost:11434/' },
      'embeddinggemma',
      async (input, init) => {
        expect(String(input)).toBe('http://localhost:11434/api/embed');
        expect(init?.method).toBe('POST');
        expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(JSON.parse(String(init?.body))).toEqual({
          model: 'embeddinggemma',
          input: ['query', 'saved record'],
        });
        return new Response(
          JSON.stringify({
            embeddings: [
              [1, 0],
              [0.8, 0.2],
            ],
          }),
        );
      },
    );

    await expect(embedder.embed(['query', 'saved record'])).resolves.toEqual([
      [1, 0],
      [0.8, 0.2],
    ]);
  });

  it('reports unavailable and malformed Ollama embedding responses honestly', async () => {
    const unavailable = createOllamaEmbeddingProvider(
      { kind: 'ollama', endpoint: 'http://localhost:11434' },
      'embeddinggemma',
      async () => new Response(null, { status: 503, statusText: 'Unavailable' }),
    );
    await expect(unavailable.embed(['query'])).rejects.toThrow(
      'Embedding request failed with 503 Unavailable',
    );

    const malformed = createOllamaEmbeddingProvider(
      { kind: 'ollama', endpoint: 'http://localhost:11434' },
      'embeddinggemma',
      async () => new Response(JSON.stringify({ embeddings: [['not-a-number']] })),
    );
    await expect(malformed.embed(['query'])).rejects.toThrow('returned invalid vectors');
  });

  it('streams OpenAI-compatible SSE content and closes on DONE', async () => {
    const providerInstance = createModelProvider(provider, async (input, init) => {
      expect(String(input)).toBe('https://example.com/v1/chat/completions');
      expect(init?.method).toBe('POST');
      return new Response(
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":" IRIS"}}]}\n\n' +
          'data: [DONE]\n\n',
        { status: 200 },
      );
    });

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: provider.model,
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { text: 'Hello', done: false },
      { text: ' IRIS', done: false },
      { text: '', done: true },
    ]);
  });

  it('ignores SSE metadata lines used by providers and keeps parsing data records', async () => {
    const providerInstance = createModelProvider(
      provider,
      async () =>
        new Response(
          ': keep-alive\n' +
            'event: message\n' +
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n' +
            'data: [DONE]\n',
          { status: 200 },
        ),
    );
    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: provider.model,
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { text: 'Hello', done: false },
      { text: '', done: true },
    ]);
  });

  it('streams Azure deployment chat and normalizes tool calls', async () => {
    const azure: ProviderConfig = {
      ...createProviderConfig('azure'),
      id: 'azure-1',
      endpoint: 'https://iris-resource.openai.azure.com',
      model: 'iris chat',
      connectionValues: { apiKey: 'azure-secret', apiVersion: '2024-10-21' },
    };
    const providerInstance = createModelProvider(azure, async (input, init) => {
      expect(String(input)).toBe(
        'https://iris-resource.openai.azure.com/openai/deployments/iris%20chat/chat/completions?api-version=2024-10-21',
      );
      expect(init?.headers).toEqual({
        'Content-Type': 'application/json',
        'api-key': 'azure-secret',
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        stream: true,
        messages: [{ role: 'user', content: 'Inspect.' }],
        tools: [{ type: 'function', function: { name: 'inspect' } }],
      });
      expect(JSON.parse(String(init?.body))).not.toHaveProperty('model');
      return new Response(
        'data: {"choices":[{"delta":{"content":"Checking."}}]}\n\n' +
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-azure","function":{"name":"inspect","arguments":"{\\"detail\\":true}"}}]}}]}\n\n' +
          'data: [DONE]\n\n',
      );
    });

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: azure.model,
      messages: [{ role: 'user', content: 'Inspect.' }],
      tools: [{ name: 'inspect', description: 'Inspect host.', inputSchema: { type: 'object' } }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { text: 'Checking.', done: false },
      {
        text: '',
        done: true,
        toolCalls: [{ id: 'call-azure', name: 'inspect', input: { detail: true } }],
      },
    ]);
  });

  it('sends tool definitions and assembles streamed OpenAI tool arguments', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(provider, async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"system_inspect_host","arguments":"{\\"detail\\":"}}]}}]}\n\n' +
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"true}"}}]}}]}\n\n' +
          'data: [DONE]\n\n',
        { status: 200 },
      );
    });

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: provider.model,
      messages: [
        { role: 'user', content: 'Inspect this machine' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'previous-call', name: 'system_inspect_host', input: {} }],
        },
        {
          role: 'tool',
          content: '{}',
          toolCallId: 'previous-call',
          toolName: 'system_inspect_host',
        },
      ],
      tools: [
        {
          name: 'system_inspect_host',
          description: 'Reads host information.',
          inputSchema: { type: 'object' },
        },
      ],
    })) {
      chunks.push(chunk);
    }

    expect(requestBody).toMatchObject({
      messages: [
        { role: 'user', content: 'Inspect this machine' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'previous-call',
              type: 'function',
              function: { name: 'system_inspect_host', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'previous-call', content: '{}' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'system_inspect_host',
            description: 'Reads host information.',
            parameters: { type: 'object' },
          },
        },
      ],
    });
    // The model must be free to request several independent tool calls in one round — sending
    // `parallel_tool_calls: false` here would silence that and force everything back to one call
    // at a time, defeating the agent loop's own parallel execution.
    expect(requestBody).not.toHaveProperty('parallel_tool_calls');
    expect(chunks).toEqual([
      {
        text: '',
        done: true,
        toolCalls: [{ id: 'call-1', name: 'system_inspect_host', input: { detail: true } }],
      },
    ]);
  });

  it('caches the system prompt and the newest message for an OpenRouter endpoint', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(
      { ...provider, endpoint: 'https://openrouter.ai/api/v1' },
      async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response('data: [DONE]\n\n');
      },
    );
    for await (const _chunk of providerInstance.stream({
      model: provider.model,
      messages: [
        { role: 'system', content: 'Be precise.' },
        { role: 'user', content: 'Inspect this machine' },
      ],
    })) {
      void _chunk;
    }
    expect(requestBody.messages).toEqual([
      {
        role: 'system',
        content: [{ type: 'text', text: 'Be precise.', cache_control: { type: 'ephemeral' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this machine', cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);
  });

  it('sends no cache_control to a plain (non-OpenRouter) OpenAI-compatible endpoint', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(provider, async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('data: [DONE]\n\n');
    });
    for await (const _chunk of providerInstance.stream({
      model: provider.model,
      messages: [
        { role: 'system', content: 'Be precise.' },
        { role: 'user', content: 'Inspect this machine' },
      ],
    })) {
      void _chunk;
    }
    expect(requestBody.messages).toEqual([
      { role: 'system', content: 'Be precise.' },
      { role: 'user', content: 'Inspect this machine' },
    ]);
  });

  it('accumulates OpenRouter reasoning_details across chunks and replays them on the next request', async () => {
    const requests: Record<string, unknown>[] = [];
    let round = 0;
    const providerInstance = createModelProvider(
      { ...provider, endpoint: 'https://openrouter.ai/api/v1' },
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        round += 1;
        if (round === 1) {
          return new Response(
            'data: {"choices":[{"delta":{"reasoning_details":[{"index":0,"type":"reasoning.text","text":"Step "}]}}]}\n\n' +
              'data: {"choices":[{"delta":{"reasoning_details":[{"index":0,"text":"one."}]}}]}\n\n' +
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"step","arguments":"{}"}}]}}]}\n\n' +
              'data: [DONE]\n\n',
          );
        }
        return new Response('data: {"choices":[{"delta":{"content":"Done."}}]}\n\ndata: [DONE]\n\n');
      },
    );

    const firstChunks = [];
    for await (const chunk of providerInstance.stream({
      model: provider.model,
      messages: [{ role: 'user', content: 'Do it.' }],
      tools: [{ name: 'step', description: 'One step.', inputSchema: { type: 'object' } }],
    })) {
      firstChunks.push(chunk);
    }
    expect(firstChunks.at(-1)).toMatchObject({
      toolCalls: [{ id: 'call-1', name: 'step', input: {} }],
      reasoningDetails: [{ index: 0, type: 'reasoning.text', text: 'Step one.' }],
    });

    for await (const _chunk of providerInstance.stream({
      model: provider.model,
      messages: [
        { role: 'user', content: 'Do it.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'step', input: {} }],
          reasoningDetails: [{ index: 0, type: 'reasoning.text', text: 'Step one.' }],
        },
        { role: 'tool', content: 'ok', toolCallId: 'call-1', toolName: 'step' },
      ],
    })) {
      void _chunk;
    }
    const secondRequestMessages = requests[1]?.messages as Array<Record<string, unknown>>;
    const carriedAssistant = secondRequestMessages.find(
      (message) => message.role === 'assistant' && (message as { tool_calls?: unknown[] }).tool_calls,
    );
    expect(carriedAssistant?.reasoning_details).toEqual([
      { index: 0, type: 'reasoning.text', text: 'Step one.' },
    ]);
  });

  it('streams native Anthropic text and tool use', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(
      {
        ...provider,
        kind: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet',
      },
      async (input, init) => {
        expect(String(input)).toBe('https://api.anthropic.com/v1/messages');
        expect(init?.headers).toEqual({
          'Content-Type': 'application/json',
          'x-api-key': 'secret-value',
          'anthropic-version': '2023-06-01',
        });
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check."}}\n\n' +
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-a","name":"inspect","input":{}}}\n\n' +
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"detail\\":"}}\n\n' +
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"true}"}}\n\n' +
            'data: {"type":"message_stop"}\n\n',
        );
      },
    );

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: 'claude-sonnet',
      messages: [
        { role: 'system', content: 'Be precise.' },
        { role: 'user', content: 'Inspect.' },
      ],
      tools: [{ name: 'inspect', description: 'Inspect host.', inputSchema: { type: 'object' } }],
    })) {
      chunks.push(chunk);
    }

    expect(requestBody).toMatchObject({
      system: [{ type: 'text', text: 'Be precise.', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Inspect.', cache_control: { type: 'ephemeral' } }],
        },
      ],
      tools: [
        { name: 'inspect', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
      ],
    });
    expect(chunks).toEqual([
      { text: 'Let me check.', done: false },
      {
        text: '',
        done: true,
        toolCalls: [{ id: 'call-a', name: 'inspect', input: { detail: true } }],
      },
    ]);
  });

  it('requests interleaved thinking and captures thinking blocks alongside tool calls', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(
      {
        ...provider,
        kind: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet',
      },
      async (input, init) => {
        expect(init?.headers).toMatchObject({
          'anthropic-beta': 'interleaved-thinking-2025-05-14',
        });
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n' +
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I should "}}\n\n' +
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"inspect first."}}\n\n' +
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-abc"}}\n\n' +
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque-blob"}}\n\n' +
            'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call-a","name":"inspect","input":{}}}\n\n' +
            'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n' +
            'data: {"type":"message_stop"}\n\n',
        );
      },
    );

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'Inspect.' }],
      tools: [{ name: 'inspect', description: 'Inspect host.', inputSchema: { type: 'object' } }],
      reasoningEffort: 'high',
    })) {
      chunks.push(chunk);
    }

    expect(requestBody.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    expect(chunks.at(-1)).toEqual({
      text: '',
      done: true,
      toolCalls: [{ id: 'call-a', name: 'inspect', input: {} }],
      thinkingBlocks: [
        { type: 'thinking', thinking: 'I should inspect first.', signature: 'sig-abc' },
        { type: 'redacted_thinking', data: 'opaque-blob' },
      ],
    });
  });

  it('sends no thinking beta header when reasoning is off', async () => {
    const providerInstance = createModelProvider(
      {
        ...provider,
        kind: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet',
      },
      async (_input, init) => {
        expect(init?.headers).not.toHaveProperty('anthropic-beta');
        return new Response('data: {"type":"message_stop"}\n\n');
      },
    );
    for await (const _chunk of providerInstance.stream({
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'Hi.' }],
    })) {
      void _chunk;
    }
  });

  it('round-trips a preserved thinking block ahead of the tool calls it led to', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(
      {
        ...provider,
        kind: 'anthropic',
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet',
      },
      async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response('data: {"type":"message_stop"}\n\n');
      },
    );
    for await (const _chunk of providerInstance.stream({
      model: 'claude-sonnet',
      messages: [
        { role: 'user', content: 'Build it.' },
        {
          role: 'assistant',
          content: '',
          thinkingBlocks: [
            { type: 'thinking', thinking: 'Step one, then step two.', signature: 'sig-xyz' },
          ],
          toolCalls: [{ id: 'call-a', name: 'write_file', input: { path: 'a.txt' } }],
        },
        { role: 'tool', content: 'ok', toolCallId: 'call-a', toolName: 'write_file' },
      ],
      reasoningEffort: 'high',
    })) {
      void _chunk;
    }

    const assistantMessage = (requestBody.messages as Array<Record<string, unknown>>)[1];
    expect(assistantMessage.content).toEqual([
      { type: 'thinking', thinking: 'Step one, then step two.', signature: 'sig-xyz' },
      { type: 'tool_use', id: 'call-a', name: 'write_file', input: { path: 'a.txt' } },
    ]);
  });

  it('streams native Gemini content and function calls', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(
      {
        ...provider,
        kind: 'gemini',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemini-2.5-pro',
      },
      async (input, init) => {
        expect(String(input)).toBe(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
        );
        expect(init?.headers).toEqual({
          'Content-Type': 'application/json',
          'x-goog-api-key': 'secret-value',
        });
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          'data: {"candidates":[{"content":{"parts":[{"text":"Checking."}]}}]}\n\n' +
            'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"inspect","args":{"detail":true}}}]},"finishReason":"STOP"}]}\n\n',
        );
      },
    );

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'system', content: 'Be precise.' },
        { role: 'user', content: 'Inspect.' },
      ],
      tools: [{ name: 'inspect', description: 'Inspect host.', inputSchema: { type: 'object' } }],
    })) {
      chunks.push(chunk);
    }

    expect(requestBody).toMatchObject({
      systemInstruction: { parts: [{ text: 'Be precise.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Inspect.' }] }],
      tools: [{ functionDeclarations: [{ name: 'inspect', parameters: { type: 'object' } }] }],
    });
    expect(chunks).toEqual([
      { text: 'Checking.', done: false },
      {
        text: '',
        done: true,
        toolCalls: [{ id: 'gemini-tool-call-0', name: 'inspect', input: { detail: true } }],
      },
    ]);
  });

  it('streams native Cohere content and tool calls', async () => {
    const providerInstance = createModelProvider(
      {
        ...provider,
        kind: 'cohere',
        endpoint: 'https://api.cohere.com',
        model: 'command-r',
      },
      async (input, init) => {
        expect(String(input)).toBe('https://api.cohere.com/v2/chat');
        expect(init?.headers).toEqual({
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-value',
        });
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'command-r',
          stream: true,
          messages: [{ role: 'user', content: 'Inspect.' }],
        });
        return new Response(
          'data: {"type":"content-delta","delta":{"message":{"content":{"text":"Checking."}}}}\n\n' +
            'data: {"type":"tool-call-start","delta":{"message":{"tool_calls":[{"index":0,"id":"call-c","function":{"name":"inspect","arguments":"{\\"detail\\":"}}]}}}\n\n' +
            'data: {"type":"tool-call-delta","delta":{"message":{"tool_calls":[{"index":0,"function":{"arguments":"true}"}}]}}}\n\n' +
            'data: {"type":"message-end"}\n\n',
        );
      },
    );

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: 'command-r',
      messages: [{ role: 'user', content: 'Inspect.' }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { text: 'Checking.', done: false },
      {
        text: '',
        done: true,
        toolCalls: [{ id: 'call-c', name: 'inspect', input: { detail: true } }],
      },
    ]);
  });

  it('streams Ollama NDJSON content and forwards local requests', async () => {
    const providerInstance = createModelProvider(
      { ...provider, kind: 'ollama', endpoint: 'http://localhost:11434', apiKey: undefined },
      async (input, init) => {
        expect(String(input)).toBe('http://localhost:11434/api/chat');
        expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
        return new Response(
          '{"message":{"content":"Local"},"done":false}\n' +
            '{"message":{"content":" model"},"done":true}\n',
          { status: 200 },
        );
      },
    );

    const chunks = [];
    for await (const chunk of providerInstance.stream({ model: 'llama3.2', messages: [] })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { text: 'Local', done: false },
      { text: ' model', done: true },
    ]);
  });

  it('sends a flat reasoning_effort for generic OpenAI-compatible endpoints and streams the trace', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(provider, async (input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"choices":[{"delta":{"reasoning":"Weighing options."}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"Answer."}}]}\n\n' +
          'data: [DONE]\n\n',
      );
    });

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: provider.model,
      messages: [{ role: 'user', content: 'Hi' }],
      reasoningEffort: 'high',
    })) {
      chunks.push(chunk);
    }
    expect(requestBody).toMatchObject({ reasoning_effort: 'high' });
    expect(requestBody).not.toHaveProperty('reasoning');
    expect(chunks).toEqual([
      { text: '', done: false, reasoningText: 'Weighing options.' },
      { text: 'Answer.', done: false },
      { text: '', done: true },
    ]);
  });

  it('sends OpenRouter the nested reasoning.effort field instead of the flat one', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(
      { ...provider, endpoint: 'https://openrouter.ai/api/v1' },
      async (input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n');
      },
    );

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: provider.model,
      messages: [{ role: 'user', content: 'Hi' }],
      reasoningEffort: 'low',
    })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(requestBody).toMatchObject({ reasoning: { effort: 'low' } });
    expect(requestBody).not.toHaveProperty('reasoning_effort');
  });

  it('omits the reasoning field entirely when effort is none or unset', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(provider, async (input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n');
    });

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: provider.model,
      messages: [{ role: 'user', content: 'Hi' }],
      reasoningEffort: 'none',
    })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(requestBody).not.toHaveProperty('reasoning');
    expect(requestBody).not.toHaveProperty('reasoning_effort');
  });

  it('enables Anthropic extended thinking with a token budget and streams the trace', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(
      { ...provider, kind: 'anthropic', endpoint: 'https://api.anthropic.com/v1', model: 'claude-sonnet' },
      async (input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Considering the request."}}\n\n' +
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done."}}\n\n' +
            'data: {"type":"message_stop"}\n\n',
        );
      },
    );

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: 'claude-sonnet',
      messages: [{ role: 'user', content: 'Inspect.' }],
      temperature: 0.7,
      reasoningEffort: 'medium',
    })) {
      chunks.push(chunk);
    }
    expect(requestBody).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 6000 } });
    // Anthropic rejects an explicit temperature while thinking is enabled.
    expect(requestBody).not.toHaveProperty('temperature');
    expect(requestBody.max_tokens).toBeGreaterThan(6000);
    expect(chunks).toEqual([
      { text: '', done: false, reasoningText: 'Considering the request.' },
      { text: 'Done.', done: false },
      { text: '', done: true },
    ]);
  });

  it('enables Ollama thinking mode for reasoning-capable local models', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(
      { ...provider, kind: 'ollama', endpoint: 'http://localhost:11434', apiKey: undefined },
      async (input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          '{"message":{"thinking":"Hmm."},"done":false}\n' +
            '{"message":{"content":"Answer."},"done":true}\n',
        );
      },
    );

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: 'deepseek-r1',
      messages: [],
      reasoningEffort: 'high',
    })) {
      chunks.push(chunk);
    }
    expect(requestBody).toMatchObject({ think: true });
    expect(chunks).toEqual([
      { text: '', done: false, reasoningText: 'Hmm.' },
      { text: 'Answer.', done: true },
    ]);
  });

  it('sends an image as an OpenAI-compatible image_url content block', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(provider, async (input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('data: {"choices":[{"delta":{"content":"I see a cat."}}]}\n\ndata: [DONE]\n\n');
    });

    for await (const _chunk of providerInstance.stream({
      model: provider.model,
      messages: [
        {
          role: 'user',
          content: 'What is this?',
          images: [{ mimeType: 'image/png', data: 'AAAA' }],
        },
      ],
    })) {
      void _chunk;
    }
    expect(requestBody.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);
  });

  it('sends an image as a native Anthropic base64 image block', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(
      { ...provider, kind: 'anthropic', endpoint: 'https://api.anthropic.com/v1', model: 'claude-sonnet' },
      async (input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response('data: {"type":"message_stop"}\n\n');
      },
    );

    for await (const _chunk of providerInstance.stream({
      model: 'claude-sonnet',
      messages: [
        {
          role: 'user',
          content: 'What is this?',
          images: [{ mimeType: 'image/jpeg', data: 'BBBB' }],
        },
      ],
    })) {
      void _chunk;
    }
    expect(requestBody.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
          { type: 'text', text: 'What is this?', cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);
  });

  it('sends an image as bare base64 on the Ollama message', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(
      { ...provider, kind: 'ollama', endpoint: 'http://localhost:11434', apiKey: undefined },
      async (input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response('{"message":{"content":"I see a cat."},"done":true}\n');
      },
    );

    for await (const _chunk of providerInstance.stream({
      model: 'llava',
      messages: [
        { role: 'user', content: 'What is this?', images: [{ mimeType: 'image/png', data: 'CCCC' }] },
      ],
    })) {
      void _chunk;
    }
    expect(requestBody.messages).toEqual([
      { role: 'user', content: 'What is this?', images: ['CCCC'] },
    ]);
  });

  it('keeps the browser fetch receiver valid when using the default transport', async () => {
    vi.stubGlobal('fetch', function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(
        new Response(
          `${JSON.stringify({ message: { content: 'Local response.' }, done: true })}\n`,
          { status: 200 },
        ),
      );
    } as typeof fetch);
    const providerInstance = createModelProvider({
      id: 'ollama-local',
      name: 'Local Ollama',
      kind: 'ollama',
      endpoint: 'http://127.0.0.1:11434',
      model: 'iris-local',
      enabled: true,
    });

    const chunks = [];
    for await (const chunk of providerInstance.stream({ model: 'iris-local', messages: [] })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ text: 'Local response.', done: true }]);
  });

  it('normalizes Ollama tool calls', async () => {
    const providerInstance = createModelProvider(
      { ...provider, kind: 'ollama', endpoint: 'http://localhost:11434', apiKey: undefined },
      async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          messages: [
            { role: 'user', content: 'Inspect this machine' },
            {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'system_inspect_host', arguments: {} } }],
            },
            {
              role: 'tool',
              tool_name: 'system_inspect_host',
              content: '{"operatingSystem":"linux"}',
            },
          ],
          tools: [
            {
              type: 'function',
              function: { name: 'system_inspect_host' },
            },
          ],
        });
        return new Response(
          '{"message":{"content":"","tool_calls":[{"function":{"name":"system_inspect_host","arguments":{}}}]},"done":true}\n',
          { status: 200 },
        );
      },
    );

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: 'llama3.2',
      messages: [
        { role: 'user', content: 'Inspect this machine' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'system_inspect_host', input: {} }],
        },
        {
          role: 'tool',
          content: '{"operatingSystem":"linux"}',
          toolCallId: 'call-1',
          toolName: 'system_inspect_host',
        },
      ],
      tools: [
        {
          name: 'system_inspect_host',
          description: 'Reads host information.',
          inputSchema: { type: 'object' },
        },
      ],
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      {
        text: '',
        done: true,
        toolCalls: [{ id: 'ollama-tool-call-0', name: 'system_inspect_host', input: {} }],
      },
    ]);
  });

  it('embeds through an OpenAI-compatible /embeddings endpoint with ordered vectors', async () => {
    const { createEmbeddingProvider } = await import('./index');
    let requestUrl = '';
    let requestBody: Record<string, unknown> = {};
    const embedder = createEmbeddingProvider(
      { ...provider, kind: 'openai-compatible', endpoint: 'https://openrouter.ai/api/v1' },
      'text-embedding-3-small',
      async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0, 1] },
              { index: 0, embedding: [1, 0] },
            ],
          }),
          { status: 200 },
        );
      },
    );

    await expect(embedder.embed(['a', 'b'])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(requestUrl).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(requestBody).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'] });
  });

  it('lists dedicated embedding models from an /embeddings/models endpoint', async () => {
    const { fetchProviderEmbeddingModels } = await import('./index');
    let requestUrl = '';
    const models = await fetchProviderEmbeddingModels(
      { ...provider, kind: 'openai-compatible', endpoint: 'https://openrouter.ai/api/v1' },
      async (input) => {
        requestUrl = String(input);
        return new Response(
          JSON.stringify({
            data: [{ id: 'liquid/lfm2.5-embedding-350m' }, { id: 'voyageai/voyage-4' }],
          }),
          { status: 200 },
        );
      },
    );
    expect(requestUrl).toBe('https://openrouter.ai/api/v1/embeddings/models');
    expect(models).toEqual(['liquid/lfm2.5-embedding-350m', 'voyageai/voyage-4']);
  });

  it('returns no dedicated embedding models when the endpoint is absent', async () => {
    const { fetchProviderEmbeddingModels } = await import('./index');
    const models = await fetchProviderEmbeddingModels(
      { ...provider, kind: 'openai-compatible', endpoint: 'https://api.openai.com/v1' },
      async () => new Response('not found', { status: 404 }),
    );
    expect(models).toEqual([]);
  });

  it('refuses to build an embedder for a provider type without embeddings', async () => {
    const { createEmbeddingProvider } = await import('./index');
    expect(() =>
      createEmbeddingProvider({ ...provider, kind: 'anthropic' }, 'x'),
    ).toThrow('does not support embeddings');
  });

  it('reports OpenAI-compatible token usage on the final chunk', async () => {
    let requestBody: Record<string, unknown> = {};
    const providerInstance = createModelProvider(provider, async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":4}}\n\n' +
          'data: [DONE]\n\n',
        { status: 200 },
      );
    });

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: provider.model,
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      chunks.push(chunk);
    }

    expect(requestBody).toMatchObject({ stream_options: { include_usage: true } });
    expect(chunks).toEqual([
      { text: 'Hi', done: false },
      { text: '', done: true, usage: { inputTokens: 11, outputTokens: 4 } },
    ]);
  });

  it('reports native Anthropic and Ollama token usage', async () => {
    const anthropic = createModelProvider(
      { ...provider, kind: 'anthropic', endpoint: 'https://api.anthropic.com/v1' },
      async () =>
        new Response(
          'event: message_start\n' +
            'data: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n' +
            'event: content_block_delta\n' +
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hej"}}\n\n' +
            'event: message_delta\n' +
            'data: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
          { status: 200 },
        ),
    );
    const anthropicChunks = [];
    for await (const chunk of anthropic.stream({
      model: 'claude',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      anthropicChunks.push(chunk);
    }
    expect(anthropicChunks.at(-1)).toEqual({
      text: '',
      done: true,
      usage: { inputTokens: 25, outputTokens: 9 },
    });

    const ollama = createModelProvider(
      { ...provider, kind: 'ollama', endpoint: 'http://localhost:11434', apiKey: undefined },
      async () =>
        new Response(
          '{"message":{"content":"Hi"},"done":false}\n' +
            '{"message":{"content":""},"done":true,"prompt_eval_count":17,"eval_count":3}\n',
          { status: 200 },
        ),
    );
    const ollamaChunks = [];
    for await (const chunk of ollama.stream({ model: 'llama3.2', messages: [] })) {
      ollamaChunks.push(chunk);
    }
    expect(ollamaChunks.at(-1)).toEqual({
      text: '',
      done: true,
      usage: { inputTokens: 17, outputTokens: 3 },
    });
  });

  it('retries a transient 503 before streaming, then succeeds', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let attempts = 0;
    const providerInstance = createModelProvider(provider, async () => {
      attempts += 1;
      if (attempts === 1) return new Response('overloaded', { status: 503 });
      return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
      });
    });

    const chunks = [];
    for await (const chunk of providerInstance.stream({
      model: provider.model,
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      chunks.push(chunk);
    }

    expect(attempts).toBe(2);
    expect(chunks).toEqual([
      { text: 'OK', done: false },
      { text: '', done: true },
    ]);
  });

  it('does not retry a non-retryable 400 and surfaces the failure', async () => {
    let attempts = 0;
    const providerInstance = createModelProvider(provider, async () => {
      attempts += 1;
      return new Response('bad request', { status: 400, statusText: 'Bad Request' });
    });

    await expect(async () => {
      for await (const _chunk of providerInstance.stream({
        model: provider.model,
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        void _chunk;
      }
    }).rejects.toThrow(/400/);
    expect(attempts).toBe(1);
  });

  it('surfaces a gateway rate-limit body instead of a generic status line', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const providerInstance = createModelProvider(provider, async () =>
      new Response(
        JSON.stringify({
          error: { message: 'Rate limit exceeded: free-tier limit is 20 requests per minute.' },
        }),
        { status: 429, statusText: 'Unknown Error' },
      ),
    );

    await expect(async () => {
      for await (const _chunk of providerInstance.stream({
        model: provider.model,
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        void _chunk;
      }
    }).rejects.toThrow(
      'Model request failed with 429: Rate limit exceeded: free-tier limit is 20 requests per minute.',
    );
  });

  it('surfaces a bare Retry-After header when a rate limit carries no error body at all', async () => {
    // A retry-after of 0 keeps the built-in retry backoff instant so the test itself stays fast.
    const providerInstance = createModelProvider(provider, async () =>
      new Response(null, {
        status: 429,
        statusText: 'Unknown Error',
        headers: { 'retry-after': '0' },
      }),
    );

    await expect(async () => {
      for await (const _chunk of providerInstance.stream({
        model: provider.model,
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        void _chunk;
      }
    }).rejects.toThrow('Model request failed with 429: Retry after 0.');
  });
});
