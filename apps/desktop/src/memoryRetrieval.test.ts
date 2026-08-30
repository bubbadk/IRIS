import { describe, expect, it } from 'vitest';
import type {
  MemoryEmbeddingIndex,
  MemoryEmbeddingIndexRepository,
  MemoryEmbeddingScope,
  MemoryRecord,
} from '@iris/memory';
import type { ProviderConfig } from '@iris/providers';
import {
  ConfiguredMemoryRetriever,
  getMemoryEmbeddingIndexStatus,
  loadMemoryRetrievalConfig,
  rebuildMemoryEmbeddingIndex,
  saveMemoryRetrievalConfig,
  selectEmbeddingModels,
  testMemoryRetrievalConfig,
  validateMemoryRetrievalConfig,
} from './memoryRetrieval';
import { LocalMemoryEmbeddingIndexRepository } from './persistence';

class InMemoryEmbeddingIndexRepository implements MemoryEmbeddingIndexRepository {
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

const ollamaProvider: ProviderConfig = {
  id: 'ollama-local',
  name: 'Local Ollama',
  kind: 'ollama',
  endpoint: 'http://localhost:11434',
  model: 'llama3.2',
  enabled: true,
};

const records: MemoryRecord[] = [
  {
    id: 'memory-language',
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

describe('desktop memory retrieval configuration', () => {
  it('defaults safely to lexical and persists an explicit embedding selection', async () => {
    const storage = memoryStorage();
    expect(loadMemoryRetrievalConfig(storage)).toEqual({ strategy: 'lexical' });

    await saveMemoryRetrievalConfig(
      { strategy: 'embedding', providerId: ollamaProvider.id, model: 'embeddinggemma' },
      storage,
    );
    expect(loadMemoryRetrievalConfig(storage)).toEqual({
      strategy: 'embedding',
      providerId: ollamaProvider.id,
      model: 'embeddinggemma',
    });
  });

  it('keeps only embedding models and drops chat, audio and image models', () => {
    const models = selectEmbeddingModels([
      'openai/gpt-5.2',
      'text-embedding-3-small',
      'openai/gpt-5.4-image-2',
      'nomic-embed-text',
      'whisper-1',
      'bge-m3',
      'intfloat/e5-large',
      'voyage-3',
    ]);
    expect(models).toEqual([
      'bge-m3',
      'intfloat/e5-large',
      'nomic-embed-text',
      'text-embedding-3-small',
      'voyage-3',
    ]);
  });

  it('returns nothing for a chat-only provider instead of suggesting chat models', () => {
    expect(
      selectEmbeddingModels(['openai/gpt-5.2', 'openai/gpt-5.4-mini', 'anthropic/claude']),
    ).toEqual([]);
  });

  it('migrates the legacy ollama-embedding strategy name to embedding', () => {
    const storage = memoryStorage();
    storage.setItem(
      'iris.memory.retrieval.v1',
      JSON.stringify({ strategy: 'ollama-embedding', providerId: 'openrouter-1', model: 'nomic' }),
    );
    expect(loadMemoryRetrievalConfig(storage)).toEqual({
      strategy: 'embedding',
      providerId: 'openrouter-1',
      model: 'nomic',
    });
  });

  it('accepts an OpenAI-compatible provider for embeddings and rejects a chat-only kind', () => {
    const openaiCompatible: ProviderConfig = {
      id: 'openrouter-1',
      name: 'OpenRouter',
      kind: 'openai-compatible',
      endpoint: 'https://openrouter.ai/api/v1',
      model: 'x',
      enabled: true,
    };
    expect(
      validateMemoryRetrievalConfig(
        { strategy: 'embedding', providerId: 'openrouter-1', model: 'text-embedding-3-small' },
        [openaiCompatible],
      ),
    ).toEqual([]);

    const anthropic: ProviderConfig = { ...openaiCompatible, kind: 'anthropic' };
    expect(
      validateMemoryRetrievalConfig(
        { strategy: 'embedding', providerId: 'openrouter-1', model: 'm' },
        [anthropic],
      ),
    ).toContain('That provider type does not support embeddings. Use an OpenAI-compatible or Ollama provider.');
  });

  it('keeps deterministic lexical retrieval active without embedding configuration', async () => {
    const retriever = new ConfiguredMemoryRetriever(
      () => ({ strategy: 'lexical' }),
      () => [],
    );
    await expect(
      retriever.retrieve(records, { query: 'What is the interface language?', limit: 2 }),
    ).resolves.toEqual(records);
  });

  it('uses the selected Ollama provider and embedding model for semantic ranking', async () => {
    const calls: Array<{ providerId: string; model: string; input: readonly string[] }> = [];
    const indexes = new InMemoryEmbeddingIndexRepository();
    await rebuildMemoryEmbeddingIndex(
      {
        strategy: 'embedding',
        providerId: ollamaProvider.id,
        model: 'embeddinggemma',
      },
      records,
      [ollamaProvider],
      indexes,
      (provider, model) => ({
        embed: async (input) => {
          calls.push({ providerId: provider.id, model, input });
          return [[0.9, 0.1]];
        },
      }),
    );
    const retriever = new ConfiguredMemoryRetriever(
      () => ({
        strategy: 'embedding',
        providerId: ollamaProvider.id,
        model: 'embeddinggemma',
      }),
      () => [ollamaProvider],
      (provider, model) => ({
        embed: async (input) => {
          calls.push({ providerId: provider.id, model, input });
          return [[1, 0]];
        },
      }),
      indexes,
    );

    await expect(retriever.retrieve(records, { query: 'language', limit: 1 })).resolves.toEqual(
      records,
    );
    expect(calls).toEqual([
      {
        providerId: ollamaProvider.id,
        model: 'embeddinggemma',
        input: [records[0]!.content],
      },
      {
        providerId: ollamaProvider.id,
        model: 'embeddinggemma',
        input: ['language'],
      },
    ]);
  });

  it('keeps model-scoped checkpoints independent while the active strategy changes', async () => {
    const storage = memoryStorage();
    const indexes = new LocalMemoryEmbeddingIndexRepository(storage);
    const scope = { providerId: ollamaProvider.id, model: 'embeddinggemma' };
    await indexes.save({
      scope: { providerId: ollamaProvider.id, model: 'embeddinggemma' },
      builtAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
      entries: [],
      failures: [],
    });
    await saveMemoryRetrievalConfig(
      { strategy: 'embedding', providerId: ollamaProvider.id, model: 'embeddinggemma' },
      storage,
    );
    await saveMemoryRetrievalConfig({ strategy: 'lexical' }, storage);
    await saveMemoryRetrievalConfig(
      { strategy: 'embedding', providerId: ollamaProvider.id, model: 'nomic-embed-text' },
      storage,
    );

    await expect(indexes.get(scope)).resolves.not.toBeNull();
    await expect(indexes.get({ ...scope, model: 'nomic-embed-text' })).resolves.toBeNull();
  });

  it('reports rebuild state and makes a persistent index ready explicitly', async () => {
    const indexes = new InMemoryEmbeddingIndexRepository();
    const config = {
      strategy: 'embedding' as const,
      providerId: ollamaProvider.id,
      model: 'embeddinggemma',
    };
    await expect(getMemoryEmbeddingIndexStatus(config, records, indexes)).resolves.toMatchObject({
      state: 'needs-rebuild',
      reason: 'missing',
    });
    await expect(
      rebuildMemoryEmbeddingIndex(config, records, [ollamaProvider], indexes, () => ({
        embed: async () => [[1, 0]],
      })),
    ).resolves.toMatchObject({ state: 'ready', recordCount: 1 });
    await expect(getMemoryEmbeddingIndexStatus(config, records, indexes)).resolves.toMatchObject({
      state: 'ready',
      recordCount: 1,
    });
  });

  it('reports an unavailable configured provider and tests real vectors', async () => {
    const config = {
      strategy: 'embedding' as const,
      providerId: ollamaProvider.id,
      model: 'embeddinggemma',
    };
    await expect(
      new ConfiguredMemoryRetriever(
        () => config,
        () => [],
      ).retrieve(records, {
        query: 'language',
        limit: 1,
      }),
    ).rejects.toThrow('Choose an enabled provider.');

    await expect(
      testMemoryRetrievalConfig(config, [ollamaProvider], () => ({
        embed: async (input) => {
          expect(input).toEqual(['IRIS local memory retrieval connection test.']);
          return [[1, 0, 0]];
        },
      })),
    ).resolves.toBeUndefined();
  });
});
