import { describe, expect, it } from 'vitest';
import { MemoryService, type MemoryRecord, type MemoryRepository } from '@iris/memory';
import { createRememberMemoryTool } from './memoryTool';

class InMemoryRepository implements MemoryRepository {
  records: MemoryRecord[] = [];

  async list() {
    return this.records;
  }

  async get(id: string) {
    return this.records.find((record) => record.id === id) ?? null;
  }

  async save(record: MemoryRecord) {
    this.records = [record, ...this.records.filter((item) => item.id !== record.id)];
  }

  async remove(id: string) {
    this.records = this.records.filter((record) => record.id !== id);
  }
}

function context(
  overrides: Partial<Parameters<ReturnType<typeof createRememberMemoryTool>['run']>[1]> = {},
) {
  return {
    agentId: 'agent-1',
    agentName: 'Researcher',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    ...overrides,
  };
}

describe('agent memory tool', () => {
  it('stores the exact agent and turn provenance through the memory service', async () => {
    const repository = new InMemoryRepository();
    const memory = new MemoryService(repository, {
      createId: () => 'memory-1',
      now: () => new Date('2026-08-27T13:00:00.000Z'),
    });
    const tool = createRememberMemoryTool(memory);

    await expect(tool.run({ content: '  The user prefers Danish.  ' }, context())).resolves.toEqual(
      {
        saved: true,
        memoryId: 'memory-1',
        capturedAt: '2026-08-27T13:00:00.000Z',
      },
    );
    expect(repository.records[0]).toMatchObject({
      content: 'The user prefers Danish.',
      provenance: {
        source: 'agent',
        actorId: 'agent-1',
        actorName: 'Researcher',
        turnId: 'turn-1',
        toolCallId: 'call-1',
      },
    });
  });

  it('refuses manual invocations without a real agent turn', async () => {
    const tool = createRememberMemoryTool(new MemoryService(new InMemoryRepository()));
    await expect(
      tool.run({ content: 'A fact' }, context({ turnId: undefined, toolCallId: undefined })),
    ).rejects.toThrow('only inside an agent turn');
  });

  it('rejects empty or unexpected input rather than storing partial data', async () => {
    const tool = createRememberMemoryTool(new MemoryService(new InMemoryRepository()));
    await expect(tool.run({ content: ' ' }, context())).rejects.toThrow('non-empty content');
    await expect(tool.run({ content: 'Fact', confidence: 1 }, context())).rejects.toThrow(
      'accepts only content',
    );
  });
});
