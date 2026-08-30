import { describe, expect, it } from 'vitest';
import { renderContextPack } from '@iris/cortex';
import { MemoryService, type MemoryRecord, type MemoryRepository } from '@iris/memory';
import type { SkillDefinition } from '@iris/skills';
import { createAgentContextBuilder } from './memory';

class InMemoryRepository implements MemoryRepository {
  private records: MemoryRecord[];

  constructor(records: MemoryRecord[]) {
    this.records = records;
  }

  async list(): Promise<MemoryRecord[]> {
    return this.records;
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

function skillStore(skills: SkillDefinition[] = []) {
  return { list: async () => skills };
}

const agent = {
  id: 'agent-1',
  name: 'Researcher',
  autonomy: 'assist' as const,
  memoryAccess: 'read' as const,
  skillIds: [],
  toolIds: [],
};

const provenance = {
  source: 'user' as const,
  actorId: 'workspace-user',
  actorName: 'Workspace user',
  capturedAt: '2026-08-27T10:00:00.000Z',
};

describe('desktop Cortex context builder', () => {
  it('packs only query-relevant records with their truthful provenance', async () => {
    const service = new MemoryService(
      new InMemoryRepository([
        {
          id: 'memory-language',
          content: 'The workspace language is Danish.',
          createdAt: '2026-08-27T10:00:00.000Z',
          updatedAt: '2026-08-27T10:00:00.000Z',
          provenance,
        },
        {
          id: 'memory-release',
          content: 'AppImage is the required Linux release artifact.',
          createdAt: '2026-08-27T11:00:00.000Z',
          updatedAt: '2026-08-27T11:00:00.000Z',
          provenance: { ...provenance, capturedAt: '2026-08-27T11:00:00.000Z' },
        },
      ]),
    );
    const context = createAgentContextBuilder(service, skillStore(), 1);

    const pack = await context.build(agent, {
      prompt: 'Which Linux release artifact is required?',
      turnId: 'turn-release',
    });
    const modelContext = renderContextPack(pack);

    expect(pack.selections.map((item) => item.sourceId)).toEqual(['memory-release']);
    expect(pack.selections[0]?.provenance).toMatchObject({
      source: 'user',
      actorId: 'workspace-user',
      capturedAt: '2026-08-27T11:00:00.000Z',
    });
    expect(modelContext).toContain('memory-release');
    expect(modelContext).not.toContain('memory-language');
  });

  it('returns an honest no-match pack when no saved record is relevant', async () => {
    const service = new MemoryService(
      new InMemoryRepository([
        {
          id: 'memory-language',
          content: 'The workspace language is Danish.',
          createdAt: '2026-08-27T10:00:00.000Z',
          updatedAt: '2026-08-27T10:00:00.000Z',
          provenance,
        },
      ]),
    );

    const pack = await createAgentContextBuilder(service, skillStore()).build(agent, {
      prompt: 'Which database is active?',
      turnId: 'turn-database',
    });
    expect(pack.selections).toEqual([]);
    expect(pack.sources.find((source) => source.source === 'memory')?.state).toBe('no-match');
    expect(renderContextPack(pack)).toBeNull();
  });

  it('injects assigned enabled skills alongside memory in one inspectable pack', async () => {
    const service = new MemoryService(
      new InMemoryRepository([
        {
          id: 'memory-release',
          content: 'AppImage is the required Linux release artifact.',
          createdAt: '2026-08-27T11:00:00.000Z',
          updatedAt: '2026-08-27T11:00:00.000Z',
          provenance,
        },
      ]),
    );
    const skills: SkillDefinition[] = [
      {
        version: 1,
        id: 'skill-release',
        name: 'Release checklist',
        summary: 'How IRIS ships a Linux build.',
        instructions: 'Always build the AppImage before announcing a release.',
        enabled: true,
        createdAt: '2026-08-27T09:00:00.000Z',
        updatedAt: '2026-08-27T09:30:00.000Z',
      },
      {
        version: 1,
        id: 'skill-draft',
        name: 'Unfinished skill',
        summary: '',
        instructions: 'Never inject this while it is disabled.',
        enabled: false,
        createdAt: '2026-08-27T09:00:00.000Z',
        updatedAt: '2026-08-27T09:00:00.000Z',
      },
    ];

    const pack = await createAgentContextBuilder(service, skillStore(skills)).build(
      { ...agent, skillIds: ['skill-release', 'skill-draft', 'skill-removed'] },
      { prompt: 'Which Linux release artifact is required?', turnId: 'turn-skills' },
    );
    const modelContext = renderContextPack(pack) ?? '';

    expect(pack.selections.filter((item) => item.source === 'skill')).toHaveLength(1);
    expect(pack.selections[0]).toMatchObject({
      source: 'skill',
      sourceId: 'skill-release',
      provenance: { source: 'skill', actorName: 'Release checklist' },
    });
    expect(pack.sources.find((source) => source.source === 'skill')?.detail).toContain(
      '1 assigned skill is disabled and was not injected',
    );
    expect(modelContext).toContain('Always build the AppImage before announcing a release.');
    expect(modelContext).not.toContain('Never inject this while it is disabled.');
    expect(modelContext).toContain('memory-release');
  });

  it('reports an honest unassigned skill source without injecting instructions', async () => {
    const service = new MemoryService(new InMemoryRepository([]));

    const pack = await createAgentContextBuilder(service, skillStore()).build(agent, {
      prompt: 'Anything?',
      turnId: 'turn-no-skills',
    });

    expect(pack.sources.find((source) => source.source === 'skill')).toMatchObject({
      state: 'not-authorized',
      detail: 'No skill is assigned to this agent.',
    });
    expect(renderContextPack(pack)).toBeNull();
  });
});
