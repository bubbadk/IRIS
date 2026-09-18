import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '@iris/core';
import type {
  MemoryEmbeddingIndex,
  MemoryEmbeddingIndexRepository,
  MemoryEmbeddingScope,
  MemoryRecord,
} from '@iris/memory';
import { loadProviderConfigs, missingProviderConnectionFields } from '@iris/providers';

/**
 * M-29 credential precedence, exercised through production callers rather than only the merge
 * helper. The trusted store is the real `credentials.ts` implementation talking to a fake Tauri
 * `invoke` — so parsing, keyring lookup and rotation are all the production code path. No real API
 * is contacted: every network request goes to a stubbed fetch.
 */

const { invoke, keyring } = vi.hoisted(() => ({
  invoke: vi.fn(),
  keyring: new Map<string, string>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: Record<string, unknown>) => invoke(command, args),
  isTauri: () => true,
}));

import { resolveProviderConnection } from './credentials';
import { ConfiguredMemoryRetriever } from './memoryRetrieval';
import { providerResolver } from './agentRuntime';

const providerStorageKey = 'iris.providers.config.v2';
const memoryStorageKey = 'iris.memory.retrieval.v1';
const subtitleStorageKey = 'iris.subtitles.session.v1';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

/** A stored provider document carrying a stale legacy plaintext credential. */
function seedProvider(id: string, overrides: Record<string, unknown> = {}) {
  const stored = {
    id,
    name: id,
    kind: 'openai-compatible',
    endpoint: 'https://api.example.test/v1',
    model: 'gpt-4o',
    availableModels: ['gpt-4o', 'gpt-4o-mini'],
    enabled: true,
    credentialMode: 'required',
    connectionFields: [{ id: 'apiKey', label: 'API key', required: true, secret: true }],
    apiKey: 'OLD_PLAINTEXT_KEY',
    ...overrides,
  };
  localStorage.setItem(providerStorageKey, JSON.stringify([stored]));
}

function providerConfig(id: string) {
  const config = loadProviderConfigs().find((candidate) => candidate.id === id);
  if (!config) throw new Error(`seeded provider missing: ${id}`);
  return config;
}

interface CapturedRequest {
  url: string;
  method?: string;
  authorization?: string;
  body: unknown;
}

function stubFetch(
  captured: CapturedRequest[],
  respond: (request: CapturedRequest) => Response,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const request: CapturedRequest = {
        url: String(url),
        method: init?.method,
        authorization: headers.Authorization ?? headers['api-key'],
        body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
      };
      captured.push(request);
      return respond(request);
    }),
  );
}

class FakeIndexRepository implements MemoryEmbeddingIndexRepository {
  index: MemoryEmbeddingIndex | null = null;
  async get(scope: MemoryEmbeddingScope): Promise<MemoryEmbeddingIndex | null> {
    return this.index?.scope.providerId === scope.providerId &&
      this.index.scope.model === scope.model
      ? this.index
      : null;
  }
  async save(index: MemoryEmbeddingIndex): Promise<void> {
    this.index = index;
  }
  async clear(): Promise<void> {
    this.index = null;
  }
}

const memoryRecords: MemoryRecord[] = [
  {
    id: 'memory-1',
    content: 'The interface language is Danish.',
    createdAt: '2026-08-27T10:00:00.000Z',
    updatedAt: '2026-08-27T10:00:00.000Z',
    provenance: {
      source: 'user',
      actorId: 'workspace-user',
      actorName: 'Workspace user',
      capturedAt: '2026-08-27T10:00:00.000Z',
    },
  },
];

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
  keyring.clear();
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'get_provider_secret') {
      const value = keyring.get(String(args?.providerId ?? ''));
      return value === undefined ? null : JSON.stringify({ version: 1, values: { apiKey: value } });
    }
    if (command === 'set_provider_secret') {
      const payload = JSON.parse(String(args?.secret)) as { values?: { apiKey?: string } };
      const apiKey = payload.values?.apiKey;
      if (apiKey !== undefined) keyring.set(String(args?.providerId ?? ''), apiKey);
      return undefined;
    }
    return undefined;
  });
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('M-29 credential precedence matrix', () => {
  it('uses the keyring credential when legacy plaintext is also present', async () => {
    seedProvider('p-keyring');
    keyring.set('p-keyring', 'KEY_A');
    const resolved = await resolveProviderConnection(providerConfig('p-keyring'));
    expect(resolved.connectionValues?.apiKey).toBe('KEY_A');
  });

  it('uses the keyring credential when no legacy plaintext exists', async () => {
    seedProvider('p-only-keyring', { apiKey: undefined });
    keyring.set('p-only-keyring', 'KEY_A');
    const resolved = await resolveProviderConnection(providerConfig('p-only-keyring'));
    expect(resolved.connectionValues?.apiKey).toBe('KEY_A');
  });

  it('follows a rotated keyring credential without restarting', async () => {
    seedProvider('p-rotated');
    keyring.set('p-rotated', 'KEY_A');
    expect((await resolveProviderConnection(providerConfig('p-rotated'))).connectionValues?.apiKey).toBe(
      'KEY_A',
    );
    keyring.set('p-rotated', 'NEWER_KEY');
    expect((await resolveProviderConnection(providerConfig('p-rotated'))).connectionValues?.apiKey).toBe(
      'NEWER_KEY',
    );
  });

  it('keeps the documented legacy migration behaviour when the keyring holds nothing', async () => {
    seedProvider('p-legacy-only');
    const resolved = await resolveProviderConnection(providerConfig('p-legacy-only'));
    expect(resolved.connectionValues?.apiKey).toBe('OLD_PLAINTEXT_KEY');
  });

  it('lets a safe keyring credential win over a corrupt legacy value', async () => {
    seedProvider('p-corrupt', { connectionValues: { apiKey: 42, tenantId: 'tenant' } });
    keyring.set('p-corrupt', 'KEY_A');
    const resolved = await resolveProviderConnection(providerConfig('p-corrupt'));
    expect(resolved.connectionValues?.apiKey).toBe('KEY_A');
    expect(resolved.connectionValues?.tenantId).toBe('tenant');
  });

  it('reports a controlled missing-credential error when neither source has one', async () => {
    seedProvider('p-missing', { apiKey: undefined });
    const resolved = await resolveProviderConnection(providerConfig('p-missing'));
    expect(resolved.connectionValues?.apiKey).toBeUndefined();
    const missing = missingProviderConnectionFields({ ...resolved, storedSecretFields: [] });
    expect(missing.map((field) => field.id)).toEqual(['apiKey']);
    // No fallback secret was invented.
    expect(JSON.stringify(resolved)).not.toContain('KEY_');
  });
});

describe('M-29 through the agent/provider execution path', () => {
  const agent = { providerPolicyId: 'p-agent', model: '' } as unknown as AgentDefinition;

  it('sends the trusted keyring credential, not the stale plaintext one', async () => {
    seedProvider('p-agent');
    keyring.set('p-agent', 'NEW_KEY');
    const captured: CapturedRequest[] = [];
    stubFetch(captured, () => new Response('data: [DONE]\n\n', { status: 200 }));

    const { provider } = await providerResolver.resolve(agent, undefined);
    for await (const chunk of provider.stream({ model: 'gpt-4o', messages: [] })) void chunk;

    expect(captured).toHaveLength(1);
    expect(captured[0].authorization).toBe('Bearer NEW_KEY');
    expect(JSON.stringify(captured)).not.toContain('OLD_PLAINTEXT_KEY');
    // The selected provider model is exactly what the execution path received.
    expect((captured[0].body as { model?: string }).model).toBe('gpt-4o');
  });

  it('applies a rotated keyring credential to the next turn', async () => {
    seedProvider('p-agent');
    keyring.set('p-agent', 'NEW_KEY');
    const captured: CapturedRequest[] = [];
    stubFetch(captured, () => new Response('data: [DONE]\n\n', { status: 200 }));

    const first = await providerResolver.resolve(agent, undefined);
    for await (const chunk of first.provider.stream({ model: 'gpt-4o', messages: [] })) void chunk;
    keyring.set('p-agent', 'NEWER_KEY');
    const second = await providerResolver.resolve(agent, undefined);
    for await (const chunk of second.provider.stream({ model: 'gpt-4o', messages: [] })) void chunk;

    expect(captured.map((request) => request.authorization)).toEqual([
      'Bearer NEW_KEY',
      'Bearer NEWER_KEY',
    ]);
  });

  it('fails with a controlled error when no credential exists instead of calling the provider', async () => {
    seedProvider('p-agent', { apiKey: undefined });
    const captured: CapturedRequest[] = [];
    stubFetch(captured, () => new Response('{}', { status: 200 }));

    await expect(providerResolver.resolve(agent, undefined)).rejects.toThrow(/needs api key/i);
    expect(captured).toHaveLength(0);
  });

  it('passes an explicit agent model through unchanged', async () => {
    seedProvider('p-agent');
    keyring.set('p-agent', 'NEW_KEY');
    const captured: CapturedRequest[] = [];
    stubFetch(captured, () => new Response('data: [DONE]\n\n', { status: 200 }));

    const selected = { providerPolicyId: 'p-agent', model: 'gpt-4o-mini' } as unknown as AgentDefinition;
    const { provider, model } = await providerResolver.resolve(selected, undefined);
    for await (const chunk of provider.stream({ model, messages: [] })) void chunk;

    expect(model).toBe('gpt-4o-mini');
    expect((captured[0].body as { model?: string }).model).toBe('gpt-4o-mini');
  });
});

describe('M-29 secret leakage', () => {
  const agent = { providerPolicyId: 'p-leak', model: '' } as unknown as AgentDefinition;

  it('never writes the keyring credential into plaintext provider storage', async () => {
    seedProvider('p-leak');
    keyring.set('p-leak', 'KEY_A');
    const captured: CapturedRequest[] = [];
    stubFetch(captured, () => new Response('data: [DONE]\n\n', { status: 200 }));

    const { provider } = await providerResolver.resolve(agent, undefined);
    for await (const chunk of provider.stream({ model: 'gpt-4o', messages: [] })) void chunk;

    const persisted = localStorage.getItem(providerStorageKey) ?? '';
    expect(persisted).not.toContain('KEY_A');
    // The legacy plaintext stays where it was; it is never promoted, copied or re-sent.
    expect(JSON.stringify(captured)).not.toContain('OLD_PLAINTEXT_KEY');
  });

  it('keeps credentials out of provider error strings', async () => {
    seedProvider('p-leak');
    keyring.set('p-leak', 'KEY_A');
    const captured: CapturedRequest[] = [];
    stubFetch(captured, () => new Response('upstream exploded', { status: 500 }));

    const { provider } = await providerResolver.resolve(agent, undefined);
    const consume = async () => {
      for await (const chunk of provider.stream({ model: 'gpt-4o', messages: [] })) void chunk;
    };
    await expect(consume()).rejects.toThrow(/Model request failed with 500/);
    let message = '';
    try {
      await consume();
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain('KEY_A');
  });

  it('routes credentials through the Phase 2D redaction helper', async () => {
    const { redactInlineSecrets } = await import('@iris/tools');
    const redacted = redactInlineSecrets('Authorization: Bearer KEY_A_super_secret_value');
    expect(redacted).not.toContain('KEY_A_super_secret_value');
    expect(redacted).toContain('[REDACTED]');
  });
});

describe('M-29 through the memory embedding path', () => {
  it('embeds with the trusted keyring credential over stale plaintext', async () => {
    seedProvider('p-memory');
    keyring.set('p-memory', 'KEY_A');
    localStorage.setItem(
      memoryStorageKey,
      JSON.stringify({ strategy: 'embedding', providerId: 'p-memory', model: 'text-embedding-3-small' }),
    );
    const captured: CapturedRequest[] = [];
    stubFetch(
      captured,
      () =>
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }), {
          status: 200,
        }),
    );

    const retriever = new ConfiguredMemoryRetriever(
      undefined,
      undefined,
      undefined,
      new FakeIndexRepository(),
    );
    await retriever.retrieve(memoryRecords, { query: 'language', limit: 5 });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].url).toBe('https://api.example.test/v1/embeddings');
    expect(captured[0].authorization).toBe('Bearer KEY_A');
    expect(JSON.stringify(captured)).not.toContain('OLD_PLAINTEXT_KEY');
  });
});

describe('M-29 through the subtitle translation path', () => {
  it('translates with the trusted keyring credential over stale plaintext', async () => {
    seedProvider('p-subtitles');
    keyring.set('p-subtitles', 'KEY_A');
    localStorage.setItem(
      subtitleStorageKey,
      JSON.stringify({
        version: 1,
        fileName: 'episode.srt',
        parsedFile: {
          format: 'srt',
          cues: [
            {
              id: 1,
              startTime: '00:00:01,000',
              endTime: '00:00:03,000',
              rawTimeLine: '00:00:01,000 --> 00:00:03,000',
              text: 'Hello there.',
            },
          ],
        },
        translated: [],
        activeCueId: null,
        progress: {
          status: 'idle',
          currentChunk: 0,
          totalChunks: 0,
          translatedCuesCount: 0,
          totalCuesCount: 1,
          percent: 0,
        },
      }),
    );
    const captured: CapturedRequest[] = [];
    stubFetch(captured, () => new Response('data: [DONE]\n\n', { status: 200 }));

    const { startSubtitleTranslation } = await import('./subtitleRuntime');
    await startSubtitleTranslation({
      providerId: 'p-subtitles',
      model: 'gpt-4o',
      targetLanguage: 'Danish',
    });

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].url).toBe('https://api.example.test/v1/chat/completions');
    expect(captured[0].authorization).toBe('Bearer KEY_A');
    expect(JSON.stringify(captured)).not.toContain('OLD_PLAINTEXT_KEY');
  });
});
