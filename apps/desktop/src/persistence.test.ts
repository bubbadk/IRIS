import { beforeEach, describe, expect, it } from 'vitest';
import {
  LocalAgentRepository,
  LocalConversationRepository,
  LocalContextPackRepository,
  LocalCortexTurnRepository,
  LocalCortexTurnStepRepository,
  LocalMemoryRepository,
  LocalMemoryEmbeddingIndexRepository,
  LocalMcpServerRequestPolicyRepository,
  LocalPermissionAuditRepository,
  LocalPermissionRuleRepository,
  LocalProjectGraphRepository,
  LocalProjectTaskRunRepository,
  LocalSkillRepository,
  LocalSuspendedAgentTurnRepository,
  LocalToolApprovalRepository,
  LocalWorkspaceRepository,
} from './persistence';

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

let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
});

describe('MCP server-request policy persistence', () => {
  it('persists supported policies and replaces the same server method', async () => {
    const repository = new LocalMcpServerRequestPolicyRepository(storage);
    await repository.save({
      version: 1,
      id: 'policy-1',
      serverId: 'mcp-local',
      method: 'roots/list',
      decision: 'allow',
      updatedAt: '2026-08-28T10:00:00.000Z',
    });
    await repository.save({
      version: 1,
      id: 'policy-2',
      serverId: 'mcp-local',
      method: 'roots/list',
      decision: 'deny',
      updatedAt: '2026-08-28T10:01:00.000Z',
    });
    expect(await repository.get('mcp-local', 'roots/list')).toMatchObject({
      id: 'policy-2',
      decision: 'deny',
    });
  });

  it('round-trips a sampling/createMessage decision across a reload', async () => {
    const repository = new LocalMcpServerRequestPolicyRepository(storage);
    await repository.save({
      version: 1,
      id: 'policy-sampling',
      serverId: 'mcp-hindsight',
      method: 'sampling/createMessage',
      decision: 'allow',
      updatedAt: '2026-08-29T10:00:00.000Z',
    });
    // A fresh repository instance simulates reopening the Connections panel: the decision must
    // still read back as 'allow' instead of silently reverting to the deny default.
    const reopened = new LocalMcpServerRequestPolicyRepository(storage);
    expect(await reopened.get('mcp-hindsight', 'sampling/createMessage')).toMatchObject({
      decision: 'allow',
    });
  });

  it('drops malformed or unsupported stored policies', async () => {
    storage.setItem(
      'iris.mcp.server-request-policies.v1',
      JSON.stringify([
        {
          version: 1,
          id: 'ok',
          serverId: 'mcp',
          method: 'roots/list',
          decision: 'allow',
          updatedAt: 'now',
        },
        {
          version: 1,
          id: 'bad',
          serverId: 'mcp',
          method: 'notifications/unknown',
          decision: 'allow',
          updatedAt: 'now',
        },
      ]),
    );
    const repository = new LocalMcpServerRequestPolicyRepository(storage);
    expect(await repository.list()).toHaveLength(1);
    await repository.remove('mcp', 'roots/list');
    expect(await repository.list()).toEqual([]);
  });
});

describe('local agent persistence', () => {
  it('saves and updates agent definitions by id', async () => {
    const repository = new LocalAgentRepository(storage);
    const agent = {
      id: 'agent-1',
      name: 'Researcher',
      autonomy: 'assist' as const,
      skillIds: [],
      toolIds: [],
    };
    await repository.save(agent);
    await repository.save({ ...agent, name: 'Senior Researcher', model: 'deepseek-v4-pro' });
    expect(await repository.list()).toEqual([
      { ...agent, name: 'Senior Researcher', model: 'deepseek-v4-pro' },
    ]);
    expect(repository.listSync()).toEqual([
      { ...agent, name: 'Senior Researcher', model: 'deepseek-v4-pro' },
    ]);
  });

  it('migrates valid legacy agents, drops malformed records, and repairs v2 storage', async () => {
    storage.setItem(
      'iris.agents.config.v1',
      JSON.stringify([
        {
          id: 'legacy-agent',
          name: 'Legacy agent',
          autonomy: 'assist',
          skillIds: [],
          toolIds: [],
        },
        { id: 'broken', name: 'Missing runtime fields' },
      ]),
    );
    const repository = new LocalAgentRepository(storage);
    await expect(repository.list()).resolves.toEqual([
      {
        id: 'legacy-agent',
        name: 'Legacy agent',
        autonomy: 'assist',
        skillIds: [],
        toolIds: [],
      },
    ]);
    expect(storage.getItem('iris.agents.config.v2')).toContain('legacy-agent');

    storage.setItem(
      'iris.agents.config.v2',
      JSON.stringify([
        { id: 'valid', name: 'Valid', autonomy: 'observe', skillIds: [], toolIds: [] },
        { id: 'invalid', name: 'Invalid', autonomy: 'unknown', skillIds: [], toolIds: [] },
      ]),
    );
    await expect(repository.list()).resolves.toHaveLength(1);
    expect(storage.getItem('iris.agents.config.v2')).not.toContain('invalid');
  });

  it('rejects invalid writes and returns defensive capability arrays', async () => {
    const repository = new LocalAgentRepository(storage);
    await expect(
      repository.save({
        id: 'invalid',
        name: 'Invalid',
        autonomy: 'assist',
        skillIds: ['ok', 4] as unknown as string[],
        toolIds: [],
      }),
    ).rejects.toThrow('invalid agent');

    const agent = {
      id: 'agent-1',
      name: 'Agent',
      autonomy: 'assist' as const,
      skillIds: ['skill-1'],
      toolIds: ['tool-1'],
    };
    await repository.save(agent);
    const loaded = await repository.get(agent.id);
    loaded!.skillIds.push('mutated');
    loaded!.toolIds.push('mutated');
    await expect(repository.get(agent.id)).resolves.toMatchObject({
      skillIds: ['skill-1'],
      toolIds: ['tool-1'],
    });
  });

  it('keeps conversation history isolated per agent', async () => {
    const repository = new LocalConversationRepository(storage);
    await repository.save('agent-1', [
      { role: 'user', content: 'Remember this', turnId: 'turn-1' },
    ]);
    await repository.save('agent-2', [{ role: 'assistant', content: 'Separate thread' }]);
    expect(await repository.list('agent-1')).toEqual([
      { role: 'user', content: 'Remember this', turnId: 'turn-1' },
    ]);
    await repository.clear('agent-1');
    expect(await repository.list('agent-1')).toEqual([]);
    expect(await repository.list('agent-2')).toHaveLength(1);
  });

  it('safely recovers when storage encounters quota limits by stripping heavy images', async () => {
    const values = new Map<string, string>();
    const constrainedStorage: Storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (value.length > 500) {
          throw new Error('QuotaExceededError');
        }
        values.set(key, value);
      },
      removeItem: (key) => values.delete(key),
      clear: () => values.clear(),
      key: (index) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    };

    const repository = new LocalConversationRepository(constrainedStorage);
    const hugeImage = 'a'.repeat(2000);
    const messages = [
      {
        role: 'user' as const,
        content: 'Check this image',
        images: [{ mimeType: 'image/png', data: hugeImage }],
      },
      {
        role: 'assistant' as const,
        content: 'I see it.',
      },
    ];

    await expect(repository.save('agent-1', messages)).resolves.not.toThrow();
    const saved = await repository.list('agent-1');
    expect(saved).toHaveLength(2);
    expect(saved[0].content).toBe('Check this image');
  });

  it('stores one resumable tool turn per agent and removes it by approval', async () => {
    const repository = new LocalSuspendedAgentTurnRepository(storage);
    const turn = {
      version: 2 as const,
      agentId: 'agent-1',
      providerId: 'provider-1',
      model: 'model-1',
      conversation: [{ role: 'user' as const, content: 'Inspect this host' }],
      modelHistory: [{ role: 'user' as const, content: 'Inspect this host' }],
      pending: {
        turnId: 'turn-1',
        call: { id: 'call-1', name: 'system_inspect_host', input: {} },
        approval: {
          id: 'approval-1',
          toolId: 'system.inspect-host',
          toolName: 'Inspect IRIS host',
          reason: 'Ask every time.',
        },
        remainingCalls: [],
        assistantText: '',
      },
    };

    await repository.save(turn);
    await expect(repository.getByAgentId('agent-1')).resolves.toEqual(turn);
    await expect(repository.getByApprovalId('approval-1')).resolves.toEqual(turn);

    await repository.save({
      ...turn,
      pending: {
        ...turn.pending,
        approval: { ...turn.pending.approval, id: 'approval-2' },
      },
    });
    await expect(repository.getByApprovalId('approval-1')).resolves.toBeNull();
    await repository.remove('approval-2');
    await expect(repository.getByAgentId('agent-1')).resolves.toBeNull();
  });

  it('stores inspectable Cortex context packs newest-first per agent', async () => {
    const repository = new LocalContextPackRepository(storage);
    const pack = {
      version: 2 as const,
      id: 'context-1',
      agentId: 'agent-1',
      turnId: 'turn-1',
      prompt: 'Which artifact is required?',
      createdAt: '2026-08-27T12:00:00.000Z',
      sources: [
        {
          source: 'memory' as const,
          state: 'selected' as const,
          detail: '1 saved record was selected for this prompt.',
        },
      ],
      selections: [
        {
          source: 'memory' as const,
          sourceId: 'memory-1',
          content: 'AppImage is required.',
          reason: 'Selected at rank 1.',
          provenance: {
            source: 'user' as const,
            actorId: 'workspace-user',
            actorName: 'Workspace user',
            capturedAt: '2026-08-27T11:00:00.000Z',
          },
        },
      ],
    };

    await repository.save(pack);
    const loaded = await repository.latest('agent-1');
    expect(loaded).toEqual(pack);
    loaded!.selections[0]!.provenance.actorName = 'Changed copy';
    expect((await repository.latest('agent-1'))?.selections[0]?.provenance.actorName).toBe(
      'Workspace user',
    );
    const newer = { ...pack, id: 'context-2', turnId: 'turn-2', prompt: 'A newer turn' };
    await repository.save(newer);
    await expect(repository.latest('agent-1')).resolves.toMatchObject({ id: 'context-2' });
    await expect(repository.list('agent-1')).resolves.toEqual([newer, pack]);
    await repository.clear('agent-1');
    await expect(repository.latest('agent-1')).resolves.toBeNull();
  });

  it('bounds context history independently for each agent', async () => {
    const repository = new LocalContextPackRepository(storage);
    const basePack = {
      version: 2 as const,
      agentId: 'agent-1',
      prompt: 'Prompt',
      createdAt: '2026-08-27T12:00:00.000Z',
      sources: [],
      selections: [],
    };
    await repository.save({ ...basePack, id: 'other-1', turnId: 'other-turn', agentId: 'agent-2' });
    for (let index = 0; index < 45; index += 1) {
      await repository.save({
        ...basePack,
        id: `context-${index}`,
        turnId: `turn-${index}`,
      });
    }

    const history = await repository.list('agent-1');
    expect(history).toHaveLength(40);
    expect(history[0]?.turnId).toBe('turn-44');
    expect(history.at(-1)?.turnId).toBe('turn-5');
    expect(await repository.list('agent-2')).toHaveLength(1);
  });

  it('keeps legacy latest-only packs inspectable without claiming an answer link', async () => {
    storage.setItem(
      'iris.cortex.context-packs.v1',
      JSON.stringify([
        {
          version: 1,
          id: 'context-legacy',
          agentId: 'agent-1',
          prompt: 'Old prompt',
          createdAt: '2026-08-26T12:00:00.000Z',
          sources: [],
          selections: [],
        },
      ]),
    );

    await expect(new LocalContextPackRepository(storage).latest('agent-1')).resolves.toMatchObject({
      version: 2,
      id: 'context-legacy',
      turnId: 'legacy-context:context-legacy',
    });
  });

  it('stores bounded Cortex turn lifecycle records independently per agent', async () => {
    const repository = new LocalCortexTurnRepository(storage);
    const running = {
      version: 1 as const,
      turnId: 'turn-1',
      agentId: 'agent-1',
      contextPackId: 'context-1',
      providerId: 'provider-1',
      model: 'model-1',
      status: 'running' as const,
      startedAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
    };
    await repository.save(running);
    await repository.save({
      ...running,
      status: 'failed',
      failedAt: '2026-08-27T12:00:04.000Z',
      updatedAt: '2026-08-27T12:00:04.000Z',
      failure: { message: 'Provider disconnected.' },
    });
    const loaded = await repository.get('turn-1');
    expect(loaded).toMatchObject({
      status: 'failed',
      contextPackId: 'context-1',
      failure: { message: 'Provider disconnected.' },
    });
    if (loaded?.status === 'failed') loaded.failure.message = 'Changed copy';
    await expect(repository.get('turn-1')).resolves.toMatchObject({
      failure: { message: 'Provider disconnected.' },
    });

    await repository.save({ ...running, turnId: 'other-turn', agentId: 'agent-2' });
    for (let index = 0; index < 45; index += 1) {
      await repository.save({ ...running, turnId: `turn-${index + 2}` });
    }
    const history = await repository.list('agent-1');
    expect(history).toHaveLength(40);
    expect(history[0]?.turnId).toBe('turn-46');
    expect(await repository.list('agent-2')).toHaveLength(1);
    await repository.clear('agent-1');
    await expect(repository.list('agent-1')).resolves.toEqual([]);
    await expect(repository.list('agent-2')).resolves.toHaveLength(1);
  });

  it('stores a real per-turn tool-call trace, ordered and upserted by call id', async () => {
    const repository = new LocalCortexTurnStepRepository(storage);
    const base = {
      version: 1 as const,
      turnId: 'turn-1',
      agentId: 'agent-1',
      toolCallId: 'call-1',
      toolName: 'workspace.readFile',
      input: { path: 'README.md' },
      status: 'running' as const,
      startedAt: '2026-08-27T12:00:01.000Z',
      updatedAt: '2026-08-27T12:00:01.000Z',
    };
    await repository.save(base);
    await repository.save({
      ...base,
      toolCallId: 'call-2',
      toolName: 'system.inspect-host',
      startedAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
    });
    // Re-saving the same turn+toolCallId updates the step in place instead of duplicating it.
    await repository.save({
      ...base,
      status: 'completed',
      output: { content: 'hello' },
      updatedAt: '2026-08-27T12:00:03.000Z',
    });

    const steps = await repository.list('turn-1');
    expect(steps).toHaveLength(2);
    // Ordered by start time, not save order.
    expect(steps.map((step) => step.toolCallId)).toEqual(['call-2', 'call-1']);
    expect(steps[1]).toMatchObject({ status: 'completed', output: { content: 'hello' } });

    expect(await repository.listForAgent('agent-1')).toHaveLength(2);
    await repository.clear('agent-1');
    await expect(repository.list('turn-1')).resolves.toEqual([]);
  });
});

describe('local project graph persistence', () => {
  it('saves validated graphs newest-first and returns defensive copies', async () => {
    const repository = new LocalProjectGraphRepository(storage);
    const first = {
      version: 1 as const,
      id: 'project-1',
      title: 'Release IRIS',
      objective: 'Produce a verified release.',
      tasks: [
        {
          id: 'task-1',
          title: 'Verify build',
          dependencyIds: [],
          createdAt: '2026-08-27T12:00:00.000Z',
        },
      ],
      createdAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
    };
    const second = {
      ...first,
      id: 'project-2',
      title: 'Document IRIS',
      tasks: [],
    };

    await repository.save(first);
    await repository.save(second);
    const listed = await repository.list();
    expect(listed.map((graph) => graph.id)).toEqual(['project-2', 'project-1']);
    listed[1]!.tasks[0]!.dependencyIds.push('mutation');
    await expect(repository.get('project-1')).resolves.toEqual(first);
  });

  it('ignores malformed stored graphs and removes only the requested project', async () => {
    const repository = new LocalProjectGraphRepository(storage);
    const valid = {
      version: 1 as const,
      id: 'project-1',
      title: 'Release IRIS',
      objective: 'Produce a verified release.',
      tasks: [],
      createdAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
    };
    storage.setItem('iris.projects.graphs.v1', JSON.stringify([{ broken: true }, valid]));

    await expect(repository.list()).resolves.toEqual([valid]);
    await repository.remove('project-1');
    await expect(repository.list()).resolves.toEqual([]);
  });

  it('persists truthful task-run history independently per project', async () => {
    const repository = new LocalProjectTaskRunRepository(storage);
    const run = {
      version: 1 as const,
      id: 'run-1',
      projectId: 'project-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      agentName: 'Release worker',
      status: 'suspended' as const,
      createdAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:02:00.000Z',
      startedAt: '2026-08-27T12:01:00.000Z',
      runtimeTurnId: 'turn-1',
      suspendedAt: '2026-08-27T12:02:00.000Z',
      approval: {
        id: 'approval-1',
        toolId: 'system.inspect-host',
        toolName: 'Inspect IRIS host',
        reason: 'Ask every time.',
      },
    };
    await repository.save(run);
    await repository.save({ ...run, id: 'run-2', projectId: 'project-2' });

    const listed = await repository.list('project-1');
    expect(listed).toEqual([run]);
    listed[0]!.approval!.reason = 'Changed copy';
    await expect(repository.get('run-1')).resolves.toEqual(run);
  });
});

describe('local workspace persistence', () => {
  it('stores one validated local mount and returns defensive copies', async () => {
    const repository = new LocalWorkspaceRepository(storage);
    const mount = {
      version: 1 as const,
      id: 'workspace-1',
      name: 'IRIS',
      rootPath: '/home/user/IRIS',
      connectedAt: '2026-08-27T12:00:00.000Z',
      verifiedAt: '2026-08-27T12:00:00.000Z',
    };
    await repository.save(mount);
    const loaded = await repository.get();
    expect(loaded).toEqual(mount);
    loaded!.name = 'Changed copy';
    await expect(repository.get()).resolves.toEqual(mount);
    await repository.clear();
    await expect(repository.get()).resolves.toBeNull();
  });
});

describe('local skill persistence', () => {
  const skill = {
    version: 1 as const,
    id: 'skill-1',
    name: 'Release checklist',
    summary: 'How IRIS ships a Linux build.',
    instructions: 'Always build the AppImage before announcing a release.',
    enabled: true,
    createdAt: '2026-08-27T09:00:00.000Z',
    updatedAt: '2026-08-27T09:00:00.000Z',
  };

  it('saves, updates and removes validated skills by id', async () => {
    const repository = new LocalSkillRepository(storage);
    await repository.save(skill);
    await repository.save({ ...skill, id: 'skill-2', name: 'Review checklist' });
    await repository.save({ ...skill, enabled: false, updatedAt: '2026-08-28T09:00:00.000Z' });

    const stored = await repository.list();
    expect(stored).toHaveLength(2);
    expect(await repository.get('skill-1')).toMatchObject({ enabled: false });

    await repository.remove('skill-1');
    expect((await repository.list()).map((item) => item.id)).toEqual(['skill-2']);
  });

  it('returns defensive copies and drops malformed persisted values', async () => {
    const repository = new LocalSkillRepository(storage);
    await repository.save(skill);
    const loaded = await repository.get('skill-1');
    loaded!.name = 'Changed copy';
    expect(await repository.get('skill-1')).toMatchObject({ name: 'Release checklist' });

    storage.setItem(
      'iris.skills.definitions.v1',
      JSON.stringify([skill, { ...skill, id: 'broken', instructions: '' }, { nonsense: true }]),
    );
    expect((await repository.list()).map((item) => item.id)).toEqual(['skill-1']);
  });

  it('refuses to persist an invalid skill instead of storing unusable state', async () => {
    const repository = new LocalSkillRepository(storage);
    await expect(repository.save({ ...skill, name: '  ' })).rejects.toThrow(
      'Cannot persist an invalid skill.',
    );
    expect(await repository.list()).toEqual([]);
  });
});

describe('local permission persistence', () => {
  it('saves and removes explicit rules by id', async () => {
    const repository = new LocalPermissionRuleRepository(storage);
    const rule = {
      id: 'agent-1:files.read',
      agentId: 'agent-1',
      toolId: 'files.read',
      decision: 'ask' as const,
    };
    await repository.save(rule);
    await repository.save({ ...rule, decision: 'allow' });
    expect(await repository.list()).toEqual([{ ...rule, decision: 'allow' }]);
    await repository.remove(rule.id);
    expect(await repository.list()).toEqual([]);
  });

  it('keeps newest audit decisions first and clears them independently', async () => {
    const repository = new LocalPermissionAuditRepository(storage);
    const first = {
      id: 'audit-1',
      timestamp: '2026-08-27T10:00:00.000Z',
      source: 'inspection' as const,
      agentId: 'agent-1',
      agentName: 'Operator',
      toolId: 'files.read',
      toolName: 'Read file',
      decision: 'deny' as const,
      reason: 'Tool is not assigned to this agent.',
    };
    await repository.append(first);
    await repository.append({ ...first, id: 'audit-2', decision: 'ask' });
    expect((await repository.list()).map((event) => event.id)).toEqual(['audit-2', 'audit-1']);
    await repository.clear();
    expect(await repository.list()).toEqual([]);
  });

  it('persists approval transitions and only clears resolved requests', async () => {
    const repository = new LocalToolApprovalRepository(storage);
    const pending = {
      id: 'approval-1',
      createdAt: '2026-08-27T10:00:00.000Z',
      updatedAt: '2026-08-27T10:00:00.000Z',
      status: 'pending' as const,
      agentId: 'agent-1',
      agentName: 'Operator',
      toolId: 'system.inspect-host',
      toolName: 'Inspect IRIS host',
      input: {},
      evaluation: {
        decision: 'ask' as const,
        reason: 'Ask before local inspection.',
        ruleId: 'confirm-host',
      },
    };
    await repository.save(pending);
    await repository.save({
      ...pending,
      id: 'approval-2',
      status: 'completed',
      resolvedAt: '2026-08-27T10:01:00.000Z',
    });
    await repository.save({
      ...pending,
      status: 'approved',
      resolvedAt: '2026-08-27T10:02:00.000Z',
    });
    expect(await repository.get('approval-1')).toMatchObject({ status: 'approved' });
    await repository.clearResolved();
    expect((await repository.list()).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'approval-1', status: 'approved' },
    ]);
  });
});

describe('local memory persistence', () => {
  it('persists records newest-first with independent provenance copies', async () => {
    const repository = new LocalMemoryRepository(storage);
    const first = {
      id: 'memory-1',
      content: 'First saved fact.',
      createdAt: '2026-08-27T10:00:00.000Z',
      updatedAt: '2026-08-27T10:00:00.000Z',
      provenance: {
        source: 'user' as const,
        actorId: 'workspace-user',
        actorName: 'Workspace user',
        capturedAt: '2026-08-27T10:00:00.000Z',
      },
    };
    await repository.save(first);
    await repository.save({
      ...first,
      id: 'memory-2',
      content: 'Second saved fact.',
    });

    const records = await repository.list();
    expect(records.map((record) => record.id)).toEqual(['memory-2', 'memory-1']);
    records[0]!.provenance.actorName = 'Changed copy';
    expect((await repository.get('memory-2'))?.provenance.actorName).toBe('Workspace user');
    await repository.remove('memory-1');
    expect((await repository.list()).map((record) => record.id)).toEqual(['memory-2']);
  });

  it('persists model-scoped checkpoints across record changes for incremental rebuilds', async () => {
    const indexes = new LocalMemoryEmbeddingIndexRepository(storage);
    const memories = new LocalMemoryRepository(storage);
    const scope = { providerId: 'ollama-local', model: 'embeddinggemma' };
    await indexes.save({
      scope,
      builtAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
      entries: [{ memoryId: 'memory-1', sourceFingerprint: 'abc123', vector: [1, 0] }],
      failures: [
        {
          memoryId: 'memory-2',
          sourceFingerprint: 'def456',
          attempts: 2,
          error: 'Embedding model unavailable.',
          lastAttemptAt: '2026-08-27T12:00:00.000Z',
        },
      ],
    });
    const loaded = await indexes.get(scope);
    expect(loaded).toEqual({
      scope,
      builtAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
      entries: [{ memoryId: 'memory-1', sourceFingerprint: 'abc123', vector: [1, 0] }],
      failures: [
        {
          memoryId: 'memory-2',
          sourceFingerprint: 'def456',
          attempts: 2,
          error: 'Embedding model unavailable.',
          lastAttemptAt: '2026-08-27T12:00:00.000Z',
        },
      ],
    });
    loaded!.entries[0]!.vector[0] = 0;
    loaded!.failures[0]!.error = 'Changed copy';
    expect((await indexes.get(scope))?.entries[0]?.vector).toEqual([1, 0]);
    expect((await indexes.get(scope))?.failures[0]?.error).toBe('Embedding model unavailable.');

    await memories.save({
      id: 'memory-1',
      content: 'A changed memory invalidates stored vectors.',
      createdAt: '2026-08-27T12:05:00.000Z',
      updatedAt: '2026-08-27T12:05:00.000Z',
      provenance: {
        source: 'user',
        actorId: 'workspace-user',
        actorName: 'Workspace user',
        capturedAt: '2026-08-27T12:05:00.000Z',
      },
    });
    await expect(indexes.get(scope)).resolves.toMatchObject({
      scope,
      entries: [{ memoryId: 'memory-1', vector: [1, 0] }],
    });
  });

  it('loads completed legacy indexes as valid checkpoints without losing vectors', async () => {
    const scope = { providerId: 'ollama-local', model: 'embeddinggemma' };
    storage.setItem(
      'iris.memory.embedding-indexes.v1',
      JSON.stringify([
        {
          scope,
          builtAt: '2026-08-27T12:00:00.000Z',
          entries: [{ memoryId: 'memory-1', sourceFingerprint: 'abc123', vector: [1, 0] }],
        },
      ]),
    );

    await expect(new LocalMemoryEmbeddingIndexRepository(storage).get(scope)).resolves.toEqual({
      scope,
      builtAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
      entries: [{ memoryId: 'memory-1', sourceFingerprint: 'abc123', vector: [1, 0] }],
      failures: [],
    });
  });
});
