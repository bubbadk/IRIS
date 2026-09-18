import { afterEach, expect, it, vi } from 'vitest';
import { createKnowledgeTools } from './knowledgeTools';
import { LocalKnowledgeRepository, knowledgeRepository } from './knowledge';
import { createProjectGraph } from '@iris/workflows';
import { SnapshotStorage } from './repositoryStorage';
import { agentRepository, projectGraphRepository } from './persistence';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('stores real agent proposals but cannot activate them or bypass memory access', async () => {
  vi.stubGlobal('localStorage', new SnapshotStorage());
  const tools = createKnowledgeTools(),
    context = { agentId: 'writer', agentName: 'Writer', turnId: 'turn', toolCallId: 'call' };
  vi.spyOn(agentRepository, 'get').mockResolvedValue({
    id: 'writer',
    name: 'Writer',
    memoryAccess: 'read',
    autonomy: 'assist',
    skillIds: [],
    toolIds: [],
  });
  const result = await tools[0].run(
    {
      scope: 'global',
      kind: 'preference',
      topic: 'Writing language',
      content: 'English',
      sourceReference: 'User request',
    },
    context,
  );
  expect(result).toMatchObject({ status: 'proposed', active: false });
  expect(await tools[1].run({ scope: 'global' }, context)).toEqual({ selected: [], omitted: 0 });
  const repository = new LocalKnowledgeRepository(),
    entry = (await repository.list())[0];
  expect(entry.provenance).toMatchObject({
    source: 'agent',
    actorId: 'writer',
    turnId: 'turn',
    toolCallId: 'call',
  });
  await repository.review(entry.id, 1, 'activate', {});
  expect(await tools[1].run({ scope: 'global' }, context)).toMatchObject({
    selected: [{ id: entry.id, content: 'English' }],
  });
  vi.spyOn(agentRepository, 'get').mockResolvedValue({
    id: 'writer',
    name: 'Writer',
    memoryAccess: 'none',
    autonomy: 'assist',
    skillIds: [],
    toolIds: [],
  });
  await expect(tools[1].run({ scope: 'global' }, context)).rejects.toThrow('no memory read access');
  await expect(
    tools[0].run(
      { scope: 'global', kind: 'fact', topic: 'Bypass', content: 'Not approved', status: 'active' },
      context,
    ),
  ).rejects.toThrow('Unsupported');
});
it('H-10: production project search excludes a higher-scoring overridden global entry', async () => {
  vi.stubGlobal('localStorage', new SnapshotStorage());
  vi.spyOn(agentRepository, 'get').mockResolvedValue({
    id: 'writer', name: 'Writer', memoryAccess: 'read', autonomy: 'assist', skillIds: [], toolIds: [],
  });
  const now = new Date().toISOString();
  vi.spyOn(projectGraphRepository, 'get').mockResolvedValue(
    createProjectGraph({ id: 'p', title: 'Project', objective: 'Test', createdAt: now }),
  );
  for (const id of ['global', 'project']) {
    await knowledgeRepository.propose({
      id,
      scope: id === 'global' ? { kind: 'global' } : { kind: 'project', projectId: 'p' },
      kind: 'preference', topic: 'Writing language',
      content: id === 'global' ? 'English writing language' : 'Danish',
      createdAt: now,
      provenance: { source: 'user', actorId: 'user', actorName: 'You', capturedAt: now },
    });
    await knowledgeRepository.review(id, 1, 'activate', {});
  }
  const result = await createKnowledgeTools()[1].run(
    { scope: 'project', projectId: 'p', query: 'writing language English' },
    { agentId: 'writer', agentName: 'Writer' },
  );
  expect(result).toMatchObject({ selected: [{ id: 'project', content: 'Danish' }], omitted: 0 });
});
it('requires real project identity and an originating tool call', async () => {
  vi.stubGlobal('localStorage', new SnapshotStorage());
  const propose = createKnowledgeTools()[0],
    input = {
      scope: 'project',
      projectId: 'missing',
      kind: 'fact',
      topic: 'Test',
      content: 'Test',
    };
  await expect(propose.run(input, { agentId: 'writer', agentName: 'Writer' })).rejects.toThrow(
    'actual agent turn',
  );
  vi.spyOn(projectGraphRepository, 'get').mockResolvedValue(null);
  await expect(
    propose.run(input, {
      agentId: 'writer',
      agentName: 'Writer',
      turnId: 'turn',
      toolCallId: 'call',
    }),
  ).rejects.toThrow('project is unavailable');
  expect(await new LocalKnowledgeRepository().list()).toEqual([]);
});
