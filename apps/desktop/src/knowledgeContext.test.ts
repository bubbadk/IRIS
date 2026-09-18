import { CompositeContextPackBuilder, renderContextPack } from '@iris/cortex';
import { LocalContextPackRepository } from './persistence';
import { SnapshotStorage } from './repositoryStorage';
import { describe, expect, it, vi } from 'vitest';
import { proposeKnowledge, reviewKnowledge } from '@iris/memory';
import { GlobalKnowledgeContributor, projectKnowledgeContext } from './knowledgeContext';
const now = '2026-09-08T10:00:00Z';
const agent = {
  id: 'agent',
  name: 'Worker',
  memoryAccess: 'read' as const,
  autonomy: 'assist' as const,
  skillIds: [],
  toolIds: [],
};
function entry(id: string, projectId?: string) {
  const proposed = proposeKnowledge({
    id,
    scope: projectId ? { kind: 'project', projectId } : { kind: 'global' },
    kind: 'preference',
    topic: 'Writing language',
    content: id,
    createdAt: now,
    provenance: { source: 'user', actorId: 'user', actorName: 'You', capturedAt: now },
  });
  return reviewKnowledge([proposed], id, 1, 'activate', {}, now)[0];
}
describe('knowledge used in agent turns', () => {
  it('respects memory permissions without reading the repository', async () => {
    const list = vi.fn(async () => [entry('global')]);
    const blocked = { ...agent, memoryAccess: 'none' as const };
    expect((await new GlobalKnowledgeContributor({ list }).contribute(blocked)).selections).toEqual(
      [],
    );
    expect(await projectKnowledgeContext(blocked, 'p', { list })).toContain(
      'no memory read access',
    );
    expect(list).not.toHaveBeenCalled();
  });
  it('injects actual current project revisions and never another project or a superseded global preference', async () => {
    let records = [entry('global'), entry('project', 'p'), entry('other', 'another')];
    const repository = { list: async () => records };
    const first = await projectKnowledgeContext(agent, 'p', repository);
    expect(first).toContain('id project; revision 2');
    expect(first).not.toContain('id global;');
    expect(first).not.toContain('id other;');
    records = [
      ...records.filter((value) => value.id !== 'project'),
      { ...entry('revised', 'p'), content: 'A newer preference' },
    ];
    const second = await projectKnowledgeContext(agent, 'p', repository);
    expect(second).toContain('A newer preference');
    expect(second).not.toContain('id project;');
    expect(
      (await new GlobalKnowledgeContributor(repository).contribute(agent)).selections.map(
        (value) => value.sourceId,
      ),
    ).toEqual(['global']);
  });
  it('does not quietly drop approved constraints when the knowledge store fails', async () => {
    await expect(
      projectKnowledgeContext(agent, 'p', {
        list: async () => {
          throw new Error('Database unavailable');
        },
      }),
    ).rejects.toThrow('Database unavailable');
  });
});

it('retains the exact knowledge source in the inspectable context history', async () => {
  const context = new CompositeContextPackBuilder([
    new GlobalKnowledgeContributor({ list: async () => [entry('global')] }),
  ]);
  const pack = await context.build(agent, {
    turnId: 'knowledge-turn',
    prompt: 'Prepare the next task.',
  });
  const storage = new SnapshotStorage();
  await new LocalContextPackRepository(storage).save(pack);
  const saved = await new LocalContextPackRepository(storage).latest(agent.id);
  expect(saved?.sources[0].source).toBe('knowledge');
  expect(saved?.selections[0]).toMatchObject({
    source: 'knowledge',
    sourceId: 'global',
    provenance: { actorName: 'You' },
  });
  expect(renderContextPack(saved!)).toContain('Current user-approved global knowledge');
  expect(renderContextPack(saved!)).toContain('revision 2');
});
