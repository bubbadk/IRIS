import { describe, expect, it } from 'vitest';
import type {
  MemoryEmbeddingIndex,
  MemoryEmbeddingIndexRepository,
  MemoryEmbeddingScope,
  MemoryRecord,
  MemoryRepository,
  MemoryRetriever,
} from './index';
import {
  embeddingQueryCharacterLimit,
  EmbeddingMemoryRetriever,
  IndexedEmbeddingMemoryRetriever,
  LocalLexicalMemoryRetriever,
  MemoryEmbeddingIndexService,
  MemoryService,
} from './index';

class InMemoryRepository implements MemoryRepository {
  records: MemoryRecord[] = [];

  async list(): Promise<MemoryRecord[]> {
    return this.records.map((record) => ({ ...record, provenance: { ...record.provenance } }));
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.records.find((record) => record.id === id) ?? null;
  }

  async save(record: MemoryRecord): Promise<void> {
    this.records = [record, ...this.records.filter((item) => item.id !== record.id)];
  }

  async remove(id: string): Promise<void> {
    this.records = this.records.filter((record) => record.id !== id);
  }
}

class InMemoryEmbeddingIndexRepository implements MemoryEmbeddingIndexRepository {
  index: MemoryEmbeddingIndex | null = null;
  saves: MemoryEmbeddingIndex[] = [];

  async get(scope: MemoryEmbeddingScope): Promise<MemoryEmbeddingIndex | null> {
    return this.index?.scope.providerId === scope.providerId &&
      this.index.scope.model === scope.model
      ? this.index
      : null;
  }

  async save(index: MemoryEmbeddingIndex): Promise<void> {
    this.index = structuredClone(index);
    this.saves.push(structuredClone(index));
  }

  async clear(): Promise<void> {
    this.index = null;
  }
}

const baseAgent = {
  id: 'agent-1',
  name: 'Researcher',
  autonomy: 'assist' as const,
  skillIds: [],
  toolIds: [],
};

describe('memory service', () => {
  it('stores normalized content with truthful user provenance', async () => {
    const repository = new InMemoryRepository();
    const service = new MemoryService(repository, {
      createId: () => 'memory-1',
      now: () => new Date('2026-08-27T12:00:00.000Z'),
    });

    await expect(service.remember('  The project language is Danish.  ')).resolves.toEqual({
      id: 'memory-1',
      content: 'The project language is Danish.',
      createdAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
      provenance: {
        source: 'user',
        actorId: 'workspace-user',
        actorName: 'Workspace user',
        capturedAt: '2026-08-27T12:00:00.000Z',
      },
    });
  });

  it('denies memory reads unless the agent has explicit read access', async () => {
    const repository = new InMemoryRepository();
    const service = new MemoryService(repository, { createId: () => 'memory-1' });
    await service.remember('A real saved memory.');

    await expect(service.listForAgent(baseAgent)).resolves.toEqual([]);
    await expect(service.listForAgent({ ...baseAgent, memoryAccess: 'none' })).resolves.toEqual([]);
    await expect(
      service.listForAgent({ ...baseAgent, memoryAccess: 'read' }),
    ).resolves.toHaveLength(1);
  });

  it('retrieves bounded query-relevant records with deterministic local ranking', async () => {
    const retriever = new LocalLexicalMemoryRetriever();
    const records: MemoryRecord[] = [
      {
        id: 'new-language',
        content: 'The project language is Danish and the interface uses Danish labels.',
        createdAt: '2026-08-27T12:00:00.000Z',
        updatedAt: '2026-08-27T12:00:00.000Z',
        provenance: {
          source: 'user',
          actorId: 'workspace-user',
          actorName: 'Workspace user',
          capturedAt: '2026-08-27T12:00:00.000Z',
        },
      },
      {
        id: 'unrelated',
        content: 'AppImage is a required Linux release artifact.',
        createdAt: '2026-08-27T11:00:00.000Z',
        updatedAt: '2026-08-27T11:00:00.000Z',
        provenance: {
          source: 'user',
          actorId: 'workspace-user',
          actorName: 'Workspace user',
          capturedAt: '2026-08-27T11:00:00.000Z',
        },
      },
      {
        id: 'old-language',
        content: 'Danish is the preferred language.',
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

    await expect(
      retriever.retrieve(records, { query: 'What is the project language?', limit: 2 }),
    ).resolves.toEqual([records[0], records[2]]);
    await expect(
      retriever.retrieve(records, { query: 'Which database is configured?', limit: 2 }),
    ).resolves.toEqual([]);
  });

  it('ranks embedding matches by cosine similarity with a deterministic recency tie-break', async () => {
    const records: MemoryRecord[] = [
      {
        id: 'older-close-match',
        content: 'Danish interface language.',
        createdAt: '2026-08-27T10:00:00.000Z',
        updatedAt: '2026-08-27T10:00:00.000Z',
        provenance: {
          source: 'user',
          actorId: 'workspace-user',
          actorName: 'Workspace user',
          capturedAt: '2026-08-27T10:00:00.000Z',
        },
      },
      {
        id: 'newer-close-match',
        content: 'Use Danish labels.',
        createdAt: '2026-08-27T11:00:00.000Z',
        updatedAt: '2026-08-27T11:00:00.000Z',
        provenance: {
          source: 'user',
          actorId: 'workspace-user',
          actorName: 'Workspace user',
          capturedAt: '2026-08-27T11:00:00.000Z',
        },
      },
      {
        id: 'unrelated',
        content: 'AppImage release.',
        createdAt: '2026-08-27T12:00:00.000Z',
        updatedAt: '2026-08-27T12:00:00.000Z',
        provenance: {
          source: 'user',
          actorId: 'workspace-user',
          actorName: 'Workspace user',
          capturedAt: '2026-08-27T12:00:00.000Z',
        },
      },
    ];
    const retriever = new EmbeddingMemoryRetriever(
      {
        embed: async (input) => {
          expect(input).toEqual([
            'What language should the interface use?',
            ...records.map((record) => record.content),
          ]);
          return [
            [1, 0],
            [0.8, 0.6],
            [0.8, 0.6],
            [-1, 0],
          ];
        },
      },
      { minimumSimilarity: 0.5 },
    );

    await expect(
      retriever.retrieve(records, { query: 'What language should the interface use?', limit: 2 }),
    ).resolves.toEqual([records[1], records[0]]);
  });

  it('clamps an oversized query instead of sending it whole to the embedding provider', async () => {
    const record: MemoryRecord = {
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
    };
    const longPrompt = 'a'.repeat(embeddingQueryCharacterLimit + 500);
    let sentQuery: string | undefined;
    const retriever = new EmbeddingMemoryRetriever({
      embed: async (input) => {
        sentQuery = input[0];
        return [
          [1, 0],
          [1, 0],
        ];
      },
    });

    await retriever.retrieve([record], { query: longPrompt, limit: 1 });

    expect(sentQuery).toHaveLength(embeddingQueryCharacterLimit);
    expect(longPrompt.startsWith(sentQuery!)).toBe(true);
  });

  it('rejects malformed embedding batches instead of presenting lexical results as semantic', async () => {
    const service = new MemoryService(new InMemoryRepository(), {
      retriever: new EmbeddingMemoryRetriever({ embed: async () => [[1, 0]] }),
    });
    await service.remember('A saved memory.');

    await expect(
      service.recallForAgent({ ...baseAgent, memoryAccess: 'read' }, 'memory', 4),
    ).rejects.toThrow('unexpected number of vectors');
  });

  it('persists a model-scoped embedding index and embeds only the query during recall', async () => {
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
      {
        id: 'memory-release',
        content: 'AppImage is the release artifact.',
        createdAt: '2026-08-27T11:00:00.000Z',
        updatedAt: '2026-08-27T11:00:00.000Z',
        provenance: {
          source: 'user',
          actorId: 'workspace-user',
          actorName: 'Workspace user',
          capturedAt: '2026-08-27T11:00:00.000Z',
        },
      },
    ];
    const scope = { providerId: 'ollama-local', model: 'embeddinggemma' };
    const repository = new InMemoryEmbeddingIndexRepository();
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const embedder = {
      embed: async (input: readonly string[]) => {
        mutableCalls.push([...input]);
        return input[0] === records[1]!.content ? [[0, 1]] : [[1, 0]];
      },
    };
    const service = new MemoryEmbeddingIndexService(repository, {
      now: () => new Date('2026-08-27T12:00:00.000Z'),
    });

    await expect(service.status(records, scope)).resolves.toEqual({
      state: 'needs-rebuild',
      reason: 'missing',
      recordCount: 2,
      readyCount: 0,
      pendingCount: 2,
      failedCount: 0,
      records: records.map((record) => ({ memoryId: record.id, state: 'pending' })),
    });
    await service.rebuild(records, scope, embedder);
    await expect(service.status(records, scope)).resolves.toEqual({
      state: 'ready',
      builtAt: '2026-08-27T12:00:00.000Z',
      recordCount: 2,
      readyCount: 2,
      pendingCount: 0,
      failedCount: 0,
      records: records.map((record) => ({ memoryId: record.id, state: 'ready' })),
    });
    await expect(
      new IndexedEmbeddingMemoryRetriever(embedder, repository, scope).retrieve(records, {
        query: 'Which language?',
        limit: 1,
      }),
    ).resolves.toEqual([records[0]]);
    expect(calls).toEqual([[records[0]!.content], [records[1]!.content], ['Which language?']]);
  });

  it('reports a stale index but self-heals on retrieval when records change', async () => {
    const record: MemoryRecord = {
      id: 'memory-1',
      content: 'Original content.',
      createdAt: '2026-08-27T10:00:00.000Z',
      updatedAt: '2026-08-27T10:00:00.000Z',
      provenance: {
        source: 'user',
        actorId: 'workspace-user',
        actorName: 'Workspace user',
        capturedAt: '2026-08-27T10:00:00.000Z',
      },
    };
    const scope = { providerId: 'ollama-local', model: 'embeddinggemma' };
    const repository = new InMemoryEmbeddingIndexRepository();
    const embedder = { embed: async () => [[1, 0]] };
    const indexService = new MemoryEmbeddingIndexService(repository);
    await indexService.rebuild([record], scope, embedder);

    await expect(
      indexService.status([{ ...record, content: 'Changed without a timestamp.' }], scope),
    ).resolves.toMatchObject({ state: 'needs-rebuild', reason: 'records-changed' });
    await expect(
      indexService.status([record], { ...scope, model: 'nomic-embed-text' }),
    ).resolves.toMatchObject({ state: 'needs-rebuild', reason: 'missing' });
    // A stale index self-heals on retrieval instead of failing, so a memory written mid-session is
    // recalled without a manual rebuild.
    const changed = { ...record, content: 'Changed without a timestamp.' };
    await expect(
      new IndexedEmbeddingMemoryRetriever(embedder, repository, scope).retrieve([changed], {
        query: 'Changed',
        limit: 1,
      }),
    ).resolves.toEqual([changed]);
    await expect(indexService.status([changed], scope)).resolves.toMatchObject({ state: 'ready' });
  });

  it('clamps an oversized query so a long chat prompt still gets memory recall', async () => {
    const record: MemoryRecord = {
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
    };
    const scope = { providerId: 'ollama-local', model: 'embeddinggemma' };
    const repository = new InMemoryEmbeddingIndexRepository();
    let sentQuery: string | undefined;
    const embedder = {
      embed: async (input: readonly string[]) => {
        if (input[0] !== record.content) sentQuery = input[0];
        return input.map(() => [1, 0]);
      },
    };
    await new MemoryEmbeddingIndexService(repository).rebuild([record], scope, embedder);

    const longPrompt = 'Testing IRIS end to end. '.repeat(400);
    expect(longPrompt.length).toBeGreaterThan(embeddingQueryCharacterLimit);
    await expect(
      new IndexedEmbeddingMemoryRetriever(embedder, repository, scope).retrieve([record], {
        query: longPrompt,
        limit: 1,
      }),
    ).resolves.toEqual([record]);
    expect(sentQuery).toHaveLength(embeddingQueryCharacterLimit);
  });

  it('recalls a memory added after indexing without a manual rebuild', async () => {
    const existing: MemoryRecord = {
      id: 'memory-old',
      content: 'The deploy target is the .10 Unraid host.',
      createdAt: '2026-08-27T10:00:00.000Z',
      updatedAt: '2026-08-27T10:00:00.000Z',
      provenance: {
        source: 'user',
        actorId: 'u',
        actorName: 'User',
        capturedAt: '2026-08-27T10:00:00.000Z',
      },
    };
    const fresh: MemoryRecord = {
      ...existing,
      id: 'memory-new',
      content: 'Container 143 exit codes are a clean stop, not a crash.',
    };
    const scope = { providerId: 'ollama-local', model: 'embeddinggemma' };
    const repository = new InMemoryEmbeddingIndexRepository();
    // The query matches the fresh record, everything else is orthogonal.
    const embedder = {
      embed: async (input: readonly string[]) =>
        [input[0] === fresh.content || input[0]?.includes('exit') ? [0, 1] : [1, 0]] as number[][],
    };
    // Index only the old record first (as if it was built earlier)…
    await new MemoryEmbeddingIndexService(repository).rebuild([existing], scope, embedder);

    // …then an agent saves a new memory and recall happens on the very next turn.
    const recalled = await new IndexedEmbeddingMemoryRetriever(embedder, repository, scope).retrieve(
      [fresh, existing],
      { query: 'what do exit codes mean?', limit: 1 },
    );
    expect(recalled).toEqual([fresh]);
    await expect(
      new MemoryEmbeddingIndexService(repository).status([fresh, existing], scope),
    ).resolves.toMatchObject({ state: 'ready' });
  });

  it('retains validated vectors and checkpoints each changed record incrementally', async () => {
    const first = {
      id: 'memory-1',
      content: 'Keep this vector.',
      createdAt: '2026-08-27T10:00:00.000Z',
      updatedAt: '2026-08-27T10:00:00.000Z',
      provenance: {
        source: 'user' as const,
        actorId: 'workspace-user',
        actorName: 'Workspace user',
        capturedAt: '2026-08-27T10:00:00.000Z',
      },
    };
    const second = {
      ...first,
      id: 'memory-2',
      content: 'This record will change.',
    };
    const scope = { providerId: 'ollama-local', model: 'embeddinggemma' };
    const repository = new InMemoryEmbeddingIndexRepository();
    const service = new MemoryEmbeddingIndexService(repository);
    await service.rebuild([first, second], scope, {
      embed: async (input) => (input[0] === first.content ? [[1, 0]] : [[0, 1]]),
    });
    const retainedVector = repository.index!.entries.find(
      (entry) => entry.memoryId === first.id,
    )!.vector;
    const changed = {
      ...second,
      content: 'Changed content.',
      updatedAt: '2026-08-27T11:00:00.000Z',
    };
    const third = { ...first, id: 'memory-3', content: 'A new record.' };
    const calls: string[] = [];
    const progress: Array<{ readyCount: number; currentMemoryId: string | null }> = [];

    await service.rebuild(
      [first, changed, third],
      scope,
      {
        embed: async (input) => {
          calls.push(input[0]!);
          if (input[0] === third.content) {
            expect(repository.index?.entries.map((entry) => entry.memoryId)).toEqual([
              first.id,
              changed.id,
            ]);
          }
          return [[0.5, 0.5]];
        },
      },
      (update) =>
        progress.push({ readyCount: update.readyCount, currentMemoryId: update.currentMemoryId }),
    );

    expect(calls).toEqual([changed.content, third.content]);
    expect(repository.index?.entries.find((entry) => entry.memoryId === first.id)?.vector).toEqual(
      retainedVector,
    );
    expect(repository.index?.builtAt).not.toBeNull();
    expect(progress).toContainEqual({ readyCount: 1, currentMemoryId: changed.id });
    expect(progress.at(-1)).toEqual({ readyCount: 3, currentMemoryId: null });
  });

  it('persists per-record failures and retries only unfinished records', async () => {
    const first = {
      id: 'memory-1',
      content: 'Completed record.',
      createdAt: '2026-08-27T10:00:00.000Z',
      updatedAt: '2026-08-27T10:00:00.000Z',
      provenance: {
        source: 'user' as const,
        actorId: 'workspace-user',
        actorName: 'Workspace user',
        capturedAt: '2026-08-27T10:00:00.000Z',
      },
    };
    const second = { ...first, id: 'memory-2', content: 'Retry this record.' };
    const records = [first, second];
    const scope = { providerId: 'ollama-local', model: 'embeddinggemma' };
    const repository = new InMemoryEmbeddingIndexRepository();
    const service = new MemoryEmbeddingIndexService(repository, {
      now: () => new Date('2026-08-27T12:00:00.000Z'),
    });

    await service.rebuild(records, scope, {
      embed: async (input) => {
        if (input[0] === second.content) throw new Error('Ollama model is unavailable.');
        return [[1, 0]];
      },
    });
    await expect(service.status(records, scope)).resolves.toMatchObject({
      state: 'needs-rebuild',
      reason: 'failed',
      readyCount: 1,
      pendingCount: 0,
      failedCount: 1,
      records: [
        { memoryId: first.id, state: 'ready' },
        {
          memoryId: second.id,
          state: 'failed',
          attempts: 1,
          error: 'Ollama model is unavailable.',
        },
      ],
    });

    const retried: string[] = [];
    await service.rebuild(records, scope, {
      embed: async (input) => {
        retried.push(input[0]!);
        return [[0, 1]];
      },
    });

    expect(retried).toEqual([second.content]);
    await expect(service.status(records, scope)).resolves.toMatchObject({
      state: 'ready',
      readyCount: 2,
      failedCount: 0,
    });
  });

  it('gates retrieval before invoking a replaceable retriever', async () => {
    const repository = new InMemoryRepository();
    const calls: string[] = [];
    const retriever: MemoryRetriever = {
      retrieve: async (records, request) => {
        calls.push(request.query);
        return records.slice(0, request.limit);
      },
    };
    const service = new MemoryService(repository, { retriever });
    await service.remember('A real saved memory.');

    await expect(service.recallForAgent(baseAgent, 'memory', 4)).resolves.toEqual([]);
    expect(calls).toEqual([]);
    await expect(
      service.recallForAgent({ ...baseAgent, memoryAccess: 'read' }, 'memory', 4),
    ).resolves.toHaveLength(1);
    expect(calls).toEqual(['memory']);
  });

  it('stores agent-authored memory with the originating agent, turn and tool call', async () => {
    const repository = new InMemoryRepository();
    const service = new MemoryService(repository, {
      createId: () => 'memory-agent-1',
      now: () => new Date('2026-08-27T12:30:00.000Z'),
    });

    await expect(
      service.rememberForAgent('  Prefer compact status updates.  ', baseAgent, 'turn-7', 'call-2'),
    ).resolves.toEqual({
      id: 'memory-agent-1',
      content: 'Prefer compact status updates.',
      createdAt: '2026-08-27T12:30:00.000Z',
      updatedAt: '2026-08-27T12:30:00.000Z',
      provenance: {
        source: 'agent',
        actorId: 'agent-1',
        actorName: 'Researcher',
        capturedAt: '2026-08-27T12:30:00.000Z',
        turnId: 'turn-7',
        toolCallId: 'call-2',
      },
    });
  });

  it('rejects agent memory without durable turn provenance', async () => {
    const service = new MemoryService(new InMemoryRepository());
    await expect(service.rememberForAgent('Fact', baseAgent, ' ', 'call-1')).rejects.toThrow(
      'originating turn',
    );
    await expect(service.rememberForAgent('Fact', baseAgent, 'turn-1', ' ')).rejects.toThrow(
      'originating tool call',
    );
  });

  it('rejects empty records and removes existing records', async () => {
    const repository = new InMemoryRepository();
    const service = new MemoryService(repository, { createId: () => 'memory-1' });
    await expect(service.remember('   ')).rejects.toThrow('Memory content cannot be empty.');
    await service.remember('Temporary context.');
    await service.forget('memory-1');
    await expect(service.list()).resolves.toEqual([]);
  });
});
