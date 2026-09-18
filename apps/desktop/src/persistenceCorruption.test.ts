import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentCheckpoint, SuspendedAgentTurn } from '@iris/agents';
import type { ContextPack, CortexTurnRecord, CortexTurnStep } from '@iris/cortex';
import type { McpServerConnection } from '@iris/mcp';
import type { MemoryEmbeddingIndex, MemoryRecord } from '@iris/memory';
import type { SkillDefinition } from '@iris/skills';
import type {
  PermissionAuditEvent,
  PermissionRule,
  ToolApprovalRequest,
} from '@iris/tools';
import type {
  ProjectGraph,
  ProjectQueueEntry,
  ProjectTaskRun,
  ScheduleDefinition,
  ScheduledRun,
} from '@iris/workflows';
import type { WorkspaceChange, WorkspaceMount } from '@iris/workspaces';
import { PersistedDataError } from './persistenceIntegrity';
import {
  LocalAgentRepository,
  LocalContextPackRepository,
  LocalConversationRepository,
  LocalCortexTurnRepository,
  LocalCortexTurnStepRepository,
  LocalMcpServerRepository,
  LocalMcpServerRequestPolicyRepository,
  LocalMemoryEmbeddingIndexRepository,
  LocalMemoryRepository,
  LocalPermissionAuditRepository,
  LocalPermissionRuleRepository,
  LocalProjectGraphRepository,
  LocalProjectQueueRepository,
  LocalProjectTaskRunRepository,
  LocalScheduleRepository,
  LocalScheduledRunRepository,
  LocalSkillRepository,
  LocalSuspendedAgentTurnRepository,
  LocalToolApprovalRepository,
  LocalWorkspaceChangeRepository,
  LocalWorkspaceRepository,
} from './persistence';
import { LocalProjectCheckpointRepository } from './projectCheckpoints';
import { LocalScheduledQueue } from './scheduledQueue';

const AT = '2026-09-09T12:00:00.000Z';

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

const checkpoint: AgentCheckpoint = {
  version: 1,
  agentId: 'agent',
  providerId: 'provider',
  model: 'model',
  turnId: 'turn',
  conversation: [{ role: 'assistant', content: 'Report', turnId: 'turn' }],
  modelHistory: [
    { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'write', input: {} }] },
    { role: 'tool', toolCallId: 'call', content: 'Written.' },
    { role: 'assistant', content: 'Report' },
  ],
};

const graph: ProjectGraph = {
  version: 1,
  id: 'project',
  title: 'Project',
  objective: 'Objective',
  tasks: [],
  createdAt: AT,
  updatedAt: AT,
};

const taskRun: ProjectTaskRun = {
  version: 1,
  id: 'run',
  projectId: 'project',
  taskId: 'task',
  agentId: 'agent',
  agentName: 'Worker',
  status: 'queued',
  createdAt: AT,
  updatedAt: AT,
};

const queueEntry: ProjectQueueEntry = {
  version: 1,
  id: 'entry',
  projectId: 'project',
  taskId: 'task',
  agentId: 'agent',
  status: 'queued',
  queuedAt: AT,
  updatedAt: AT,
};

const schedule: ScheduleDefinition = {
  version: 1,
  id: 'schedule',
  name: 'Schedule',
  agentId: 'agent',
  prompt: 'Do work',
  recurrence: 'daily',
  timeOfDay: '09:00',
  timeZone: 'UTC',
  enabled: true,
  createdAt: AT,
  updatedAt: AT,
};

const scheduledRun: ScheduledRun = {
  version: 1,
  queueVersion: 1,
  id: 'scheduled-run',
  scheduleId: 'schedule',
  agentId: 'agent',
  prompt: 'Do work',
  status: 'queued',
  scheduledFor: AT,
  createdAt: AT,
  updatedAt: AT,
};

const skill: SkillDefinition = {
  version: 1,
  id: 'skill',
  name: 'Skill',
  summary: 'Summary',
  instructions: 'Do the thing.',
  enabled: true,
  createdAt: AT,
  updatedAt: AT,
};

const mcpServer: McpServerConnection = {
  version: 1,
  id: 'mcp',
  name: 'MCP',
  url: 'http://127.0.0.1:3333/mcp',
  transport: 'http',
  hasToken: false,
  createdAt: AT,
  verifiedAt: null,
};

const memoryRecord: MemoryRecord = {
  id: 'memory',
  content: 'A durable fact.',
  createdAt: AT,
  updatedAt: AT,
  provenance: { source: 'user', actorId: 'user', actorName: 'User', capturedAt: AT },
};

const permissionRule: PermissionRule = {
  id: 'rule',
  agentId: '*',
  toolId: '*',
  decision: 'allow',
};

const permissionAudit: PermissionAuditEvent = {
  id: 'audit',
  timestamp: AT,
  source: 'execution',
  agentId: 'agent',
  agentName: 'Agent',
  toolId: 'tool',
  toolName: 'Tool',
  decision: 'allow',
  reason: 'Allowed.',
};

const toolApproval: ToolApprovalRequest = {
  id: 'approval',
  createdAt: AT,
  updatedAt: AT,
  status: 'pending',
  agentId: 'agent',
  agentName: 'Agent',
  toolId: 'tool',
  toolName: 'Tool',
  input: {},
  evaluation: { decision: 'ask', reason: 'Ask.' },
};

const workspaceMount: WorkspaceMount = {
  version: 1,
  id: 'workspace',
  name: 'Workspace',
  rootPath: '/tmp/iris',
  connectedAt: AT,
  verifiedAt: AT,
};

const workspaceChange: WorkspaceChange = {
  version: 1,
  id: 'change',
  timestamp: AT,
  workspaceId: 'workspace',
  agentId: 'agent',
  agentName: 'Agent',
  path: '/tmp/iris/file.txt',
  kind: 'file-written',
};

const contextPack: ContextPack = {
  version: 2,
  id: 'pack',
  agentId: 'agent',
  turnId: 'turn',
  prompt: 'Prompt',
  createdAt: AT,
  sources: [],
  selections: [],
};

const cortexTurn: CortexTurnRecord = {
  version: 1,
  turnId: 'turn',
  agentId: 'agent',
  providerId: 'provider',
  model: 'model',
  startedAt: AT,
  updatedAt: AT,
  status: 'running',
};

const cortexStep: CortexTurnStep = {
  version: 1,
  turnId: 'turn',
  agentId: 'agent',
  toolCallId: 'call',
  toolName: 'tool',
  input: {},
  startedAt: AT,
  updatedAt: AT,
  status: 'completed',
};

const suspendedTurn: SuspendedAgentTurn = {
  version: 4,
  agentId: 'agent',
  providerId: 'provider',
  model: 'model',
  conversation: [{ role: 'user', content: 'Hello' }],
  modelHistory: [{ role: 'user', content: 'Hello' }],
  pending: {
    kind: 'tool-approval',
    turnId: 'turn',
    call: { id: 'call', name: 'tool', input: {} },
    approval: { id: 'approval', toolId: 'tool', toolName: 'Tool', reason: 'Ask.' },
    remainingCalls: [],
    assistantText: '',
  },
};

const embeddingIndex: MemoryEmbeddingIndex = {
  scope: { providerId: 'provider', model: 'model' },
  builtAt: null,
  updatedAt: AT,
  entries: [],
  failures: [],
};

interface PersistenceCase {
  name: string;
  key: string;
  root: 'array' | 'object' | 'single';
  /** A valid stored document for this key. */
  document: unknown;
  /** Reads through the real repository path. */
  read: (storage: Storage) => Promise<unknown>;
  /** Performs a normal read-modify-write through the real repository path. */
  write?: (storage: Storage) => Promise<unknown>;
  /** The repository's legitimate state when the key has never been written. */
  empty: unknown;
}

const cases: PersistenceCase[] = [
  {
    name: 'agent configurations',
    key: 'iris.agents.config.v2',
    root: 'array',
    document: [
      { id: 'agent', name: 'Agent', autonomy: 'assist', skillIds: [], toolIds: [] },
    ],
    read: (storage) => new LocalAgentRepository(storage).list(),
    write: (storage) =>
      new LocalAgentRepository(storage).save({
        id: 'other',
        name: 'Other',
        autonomy: 'assist',
        skillIds: [],
        toolIds: [],
      }),
    empty: [],
  },
  {
    name: 'project graphs',
    key: 'iris.projects.graphs.v1',
    root: 'array',
    document: [graph],
    read: (storage) => new LocalProjectGraphRepository(storage).list(),
    write: (storage) => new LocalProjectGraphRepository(storage).save(graph),
    empty: [],
  },
  {
    name: 'project task runs',
    key: 'iris.projects.task-runs.v1',
    root: 'array',
    document: [taskRun],
    read: (storage) => new LocalProjectTaskRunRepository(storage).list(),
    write: (storage) => new LocalProjectTaskRunRepository(storage).save(taskRun),
    empty: [],
  },
  {
    name: 'project queue',
    key: 'iris.projects.queue.v1',
    root: 'array',
    document: [queueEntry],
    read: (storage) => new LocalProjectQueueRepository(storage).list(),
    write: (storage) => new LocalProjectQueueRepository(storage).save(queueEntry),
    empty: [],
  },
  {
    name: 'schedules',
    key: 'iris.schedules.v1',
    root: 'array',
    document: [schedule],
    read: (storage) => new LocalScheduleRepository(storage).list(),
    write: (storage) => new LocalScheduleRepository(storage).save(schedule),
    empty: [],
  },
  {
    name: 'scheduled runs',
    key: 'iris.schedules.runs.v1',
    root: 'array',
    document: [scheduledRun],
    read: (storage) => new LocalScheduledRunRepository(storage).list(),
    write: (storage) => new LocalScheduledRunRepository(storage).save(scheduledRun),
    empty: [],
  },
  {
    name: 'workspace mount',
    key: 'iris.workspace.mount.v1',
    root: 'single',
    document: workspaceMount,
    read: (storage) => new LocalWorkspaceRepository(storage).get(),
    write: (storage) => new LocalWorkspaceRepository(storage).save(workspaceMount),
    empty: null,
  },
  {
    name: 'workspace changes',
    key: 'iris.workspace.changes.v1',
    root: 'array',
    document: [workspaceChange],
    read: (storage) => new LocalWorkspaceChangeRepository(storage).list(),
    write: (storage) => new LocalWorkspaceChangeRepository(storage).append(workspaceChange),
    empty: [],
  },
  {
    name: 'skills',
    key: 'iris.skills.definitions.v1',
    root: 'array',
    document: [skill],
    read: (storage) => new LocalSkillRepository(storage).list(),
    write: (storage) => new LocalSkillRepository(storage).save(skill),
    empty: [],
  },
  {
    name: 'MCP servers',
    key: 'iris.mcp.servers.v1',
    root: 'array',
    document: [mcpServer],
    read: (storage) => new LocalMcpServerRepository(storage).list(),
    write: (storage) => new LocalMcpServerRepository(storage).save(mcpServer),
    empty: [],
  },
  {
    name: 'MCP server-request policies',
    key: 'iris.mcp.server-request-policies.v1',
    root: 'array',
    document: [
      {
        version: 1,
        id: 'policy',
        serverId: 'mcp',
        method: 'roots/list',
        decision: 'allow',
        updatedAt: AT,
      },
    ],
    read: (storage) => new LocalMcpServerRequestPolicyRepository(storage).list(),
    write: (storage) =>
      new LocalMcpServerRequestPolicyRepository(storage).save({
        version: 1,
        id: 'policy-2',
        serverId: 'mcp',
        method: 'sampling/createMessage',
        decision: 'deny',
        updatedAt: AT,
      }),
    empty: [],
  },
  {
    name: 'conversations',
    key: 'iris.agents.conversations.v1',
    root: 'object',
    document: { agent: [{ role: 'user', content: 'Hello' }] },
    read: (storage) => new LocalConversationRepository(storage).list('agent'),
    write: (storage) =>
      new LocalConversationRepository(storage).save('agent', [{ role: 'user', content: 'Again' }]),
    empty: [],
  },
  {
    name: 'suspended agent turns',
    key: 'iris.agents.suspended-turns.v1',
    root: 'array',
    document: [suspendedTurn],
    read: (storage) => new LocalSuspendedAgentTurnRepository(storage).getByAgentId('agent'),
    write: (storage) =>
      new LocalSuspendedAgentTurnRepository(storage).save(
        suspendedTurn as unknown as Parameters<LocalSuspendedAgentTurnRepository['save']>[0],
      ),
    empty: null,
  },
  {
    name: 'Cortex context packs',
    key: 'iris.cortex.context-packs.v2',
    root: 'array',
    document: [contextPack],
    read: (storage) => new LocalContextPackRepository(storage).listAll(),
    write: (storage) =>
      new LocalContextPackRepository(storage).save(
        contextPack as unknown as Parameters<LocalContextPackRepository['save']>[0],
      ),
    empty: [],
  },
  {
    name: 'Cortex turns',
    key: 'iris.cortex.turns.v1',
    root: 'array',
    document: [cortexTurn],
    read: (storage) => new LocalCortexTurnRepository(storage).listAll(),
    write: (storage) =>
      new LocalCortexTurnRepository(storage).save({ ...cortexTurn, turnId: 'turn-2' } as never),
    empty: [],
  },
  {
    name: 'Cortex turn steps',
    key: 'iris.cortex.turn-steps.v1',
    root: 'array',
    document: [cortexStep],
    read: (storage) => new LocalCortexTurnStepRepository(storage).listForAgent('agent'),
    write: (storage) =>
      new LocalCortexTurnStepRepository(storage).save({
        ...cortexStep,
        toolCallId: 'call-2',
      } as never),
    empty: [],
  },
  {
    name: 'memory records',
    key: 'iris.memory.records.v1',
    root: 'array',
    document: [memoryRecord],
    read: (storage) => new LocalMemoryRepository(storage).list(),
    write: (storage) =>
      new LocalMemoryRepository(storage).save({
        ...memoryRecord,
        id: 'memory-2',
      } as never),
    empty: [],
  },
  {
    name: 'memory embedding indexes',
    key: 'iris.memory.embedding-indexes.v1',
    root: 'array',
    document: [embeddingIndex],
    read: (storage) =>
      new LocalMemoryEmbeddingIndexRepository(storage).get({
        providerId: 'provider',
        model: 'model',
      }),
    write: (storage) =>
      new LocalMemoryEmbeddingIndexRepository(storage).save(embeddingIndex as never),
    empty: null,
  },
  {
    name: 'permission rules',
    key: 'iris.permissions.rules.v1',
    root: 'array',
    document: [permissionRule],
    read: (storage) => new LocalPermissionRuleRepository(storage).list(),
    write: (storage) =>
      new LocalPermissionRuleRepository(storage).save({
        ...permissionRule,
        id: 'rule-2',
      } as never),
    empty: [],
  },
  {
    name: 'permission audit',
    key: 'iris.permissions.audit.v1',
    root: 'array',
    document: [permissionAudit],
    read: (storage) => new LocalPermissionAuditRepository(storage).list(),
    write: (storage) =>
      new LocalPermissionAuditRepository(storage).append({
        ...permissionAudit,
        id: 'audit-2',
      } as never),
    empty: [],
  },
  {
    name: 'tool approvals',
    key: 'iris.tools.approvals.v1',
    root: 'array',
    document: [toolApproval],
    read: (storage) => new LocalToolApprovalRepository(storage).list(),
    write: (storage) =>
      new LocalToolApprovalRepository(storage).save({
        ...toolApproval,
        id: 'approval-2',
      } as never),
    empty: [],
  },
  {
    name: 'project worker checkpoints',
    key: 'iris.projects.worker-checkpoints.v1',
    root: 'object',
    document: { run: checkpoint },
    read: (storage) => new LocalProjectCheckpointRepository(storage).get('run'),
    write: (storage) => new LocalProjectCheckpointRepository(storage).save('run', checkpoint),
    empty: null,
  },
  {
    name: 'schedule queue controls',
    key: 'iris.schedules.queue-control.v1',
    root: 'single',
    document: { version: 1, paused: true },
    read: (storage) => new LocalScheduledQueue(storage).isPaused(),
    // `setPaused` is a blind explicit write requested by the user, not a read-modify-write, so it
    // has no write attempt here: the corruption policy covers reads and the writes that depend on them.
    empty: false,
  },
];

let storage: Storage;
beforeEach(() => {
  storage = memoryStorage();
});

describe('persistence corruption policy', () => {
  describe('Test A — a key that was never written returns the legitimate empty state', () => {
    it.each(cases)('$name', async ({ key, read, empty }) => {
      expect(storage.getItem(key)).toBeNull();
      await expect(read(storage)).resolves.toEqual(empty);
    });
  });

  describe('Test B — malformed JSON fails closed and keeps the original bytes', () => {
    it.each(cases)('$name', async ({ key, read, write }) => {
      const corrupt = '{broken json';
      storage.setItem(key, corrupt);
      await expect(read(storage)).rejects.toThrow(PersistedDataError);
      expect(storage.getItem(key)).toBe(corrupt);
      if (!write) return;
      // Test E: a write attempted after the failed read must not replace the document.
      await expect(write(storage)).rejects.toThrow(PersistedDataError);
      expect(storage.getItem(key)).toBe(corrupt);
    });
  });

  describe('Test C — a wrong root type fails closed and keeps the original bytes', () => {
    it.each(cases)('$name', async ({ key, root, read, write }) => {
      const corrupt = root === 'array' ? '{"agent":[]}' : '[]';
      storage.setItem(key, corrupt);
      await expect(read(storage)).rejects.toThrow(PersistedDataError);
      expect(storage.getItem(key)).toBe(corrupt);
      if (!write) return;
      await expect(write(storage)).rejects.toThrow(PersistedDataError);
      expect(storage.getItem(key)).toBe(corrupt);
    });
  });

  describe('Test D — valid JSON with an invalid schema fails closed', () => {
    it.each(cases)('$name', async ({ key, root, read, write }) => {
      const corrupt =
        root === 'array'
          ? JSON.stringify([{ nonsense: true }])
          : root === 'object'
            ? JSON.stringify({ run: { version: 99 } })
            : JSON.stringify({ version: 1, paused: 'yes' });
      storage.setItem(key, corrupt);
      await expect(read(storage)).rejects.toThrow(PersistedDataError);
      expect(storage.getItem(key)).toBe(corrupt);
      if (!write) return;
      await expect(write(storage)).rejects.toThrow(PersistedDataError);
      expect(storage.getItem(key)).toBe(corrupt);
    });
  });

  describe('Test F — valid existing data still supports a normal read-modify-write', () => {
    it.each(cases)('$name', async ({ key, root, document, read, write }) => {
      storage.setItem(key, JSON.stringify(document));
      await expect(read(storage)).resolves.not.toBeUndefined();
      if (write) await write(storage);
      expect(storage.getItem(key)).not.toBeNull();
      if (root === 'array') expect(storage.getItem(key)!.startsWith('[')).toBe(true);
      if (root === 'object') expect(storage.getItem(key)!.startsWith('{')).toBe(true);
    });
  });
});

describe('M-06 conversation root-type validation', () => {
  const conversationKey = 'iris.agents.conversations.v1';
  const valid = JSON.stringify({ agent: [{ role: 'user', content: 'Hello' }] });

  it.each([
    ['an array', JSON.stringify([{ role: 'user', content: 'Hello' }])],
    ['null', 'null'],
    ['a string', JSON.stringify('hello')],
    ['a number', JSON.stringify(42)],
    ['a boolean', JSON.stringify(true)],
  ])('rejects %s where a keyed object is required and keeps the original bytes', async (_, raw) => {
    storage.setItem(conversationKey, raw);
    const repository = new LocalConversationRepository(storage);
    await expect(repository.list('agent')).rejects.toThrow(PersistedDataError);
    await expect(
      repository.save('agent', [{ role: 'user', content: 'Replacement' }]),
    ).rejects.toThrow(PersistedDataError);
    expect(storage.getItem(conversationKey)).toBe(raw);
  });

  it('accepts a valid object and performs a normal save and reload', async () => {
    storage.setItem(conversationKey, valid);
    const repository = new LocalConversationRepository(storage);
    await expect(repository.list('agent')).resolves.toEqual([{ role: 'user', content: 'Hello' }]);
    await repository.save('second', [{ role: 'assistant', content: 'Reply' }]);
    const reopened = new LocalConversationRepository(storage);
    expect(await reopened.list('agent')).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(await reopened.list('second')).toEqual([{ role: 'assistant', content: 'Reply' }]);
  });

  it('rejects the array root that previously let a save report success while the change vanished', async () => {
    // Before Phase 2B this document was accepted. `save` then assigned a named property onto the
    // array, and `JSON.stringify` dropped it, so the write silently disappeared.
    const array = [{ role: 'user', content: 'Kept' }] as unknown as Record<string, unknown>;
    array.agent = [{ role: 'assistant', content: 'Lost silently' }];
    const raw = JSON.stringify(array);
    expect(raw).toBe('[{"role":"user","content":"Kept"}]');

    storage.setItem(conversationKey, raw);
    const repository = new LocalConversationRepository(storage);
    await expect(repository.list('agent')).rejects.toThrow(PersistedDataError);
    await expect(
      repository.save('agent', [{ role: 'assistant', content: 'Lost silently' }]),
    ).rejects.toThrow(PersistedDataError);
    expect(storage.getItem(conversationKey)).toBe(raw);
  });

  it('rejects a conversation value that is not an array of usable messages', async () => {
    storage.setItem(conversationKey, JSON.stringify({ agent: { role: 'user', content: 'x' } }));
    await expect(new LocalConversationRepository(storage).list('agent')).rejects.toThrow(
      PersistedDataError,
    );
  });

  it('applies the same policy to the project worker conversation document', async () => {
    const workerKey = 'iris.projects.worker-conversations.v1';
    storage.setItem(workerKey, JSON.stringify([{ role: 'user', content: 'Hello' }]));
    const repository = new LocalConversationRepository(storage, workerKey);
    await expect(repository.list('worker')).rejects.toThrow(workerKey);
    expect(storage.getItem(workerKey)).toBe(JSON.stringify([{ role: 'user', content: 'Hello' }]));
  });
});

describe('persistence corruption diagnostics', () => {
  it('Test G — never includes the stored payload in the failure message', async () => {
    const secret = 'sk-live-DO-NOT-LEAK-1234567890';
    // Valid JSON with an unusable message shape: `role: "system"` is not a conversation role.
    storage.setItem(
      'iris.agents.conversations.v1',
      `{"agent":[{"role":"user","content":${JSON.stringify(secret)}},{"role":"system","content":${JSON.stringify(secret)}}]}`,
    );
    const repository = new LocalConversationRepository(storage);
    const failure = await repository.list('agent').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PersistedDataError);
    const message = (failure as Error).message;
    expect(message).not.toContain(secret);
    expect(message).not.toContain('system');
    expect(message).toContain('iris.agents.conversations.v1');
    expect(message).toContain('conversations');
    expect(message).toContain('retained');
    // Malformed JSON must not leak either.
    storage.setItem('iris.agents.conversations.v1', `{${JSON.stringify(secret)}`);
    const second = await repository.list('agent').catch((error: unknown) => error);
    expect((second as Error).message).not.toContain(secret);
    expect((second as Error).message).toContain('iris.agents.conversations.v1');
  });

  it('names the storage key, the repository and the failure kind for every failure mode', async () => {
    const scenarios: [string, string, PersistedDataError['failure'], string][] = [
      ['malformed JSON', '{broken', 'malformed-json', 'not valid JSON'],
      [
        'wrong root type',
        JSON.stringify({ not: 'an array' }),
        'wrong-root-type',
        'a JSON array document was required',
      ],
      [
        'invalid record',
        JSON.stringify([{ version: 99 }]),
        'invalid-record',
        'failed scheduled runs validation',
      ],
      [
        'duplicate record',
        JSON.stringify([scheduledRun, { ...scheduledRun }]),
        'duplicate-record',
        'repeats identity',
      ],
    ];
    for (const [name, raw, failure, fragment] of scenarios) {
      storage.setItem('iris.schedules.runs.v1', raw);
      const error = (await new LocalScheduledRunRepository(storage)
        .list()
        .catch((caught: unknown) => caught)) as PersistedDataError;
      expect(error, name).toBeInstanceOf(PersistedDataError);
      expect(error.storageKey, name).toBe('iris.schedules.runs.v1');
      expect(error.repository, name).toBe('scheduled runs');
      expect(error.failure, name).toBe(failure);
      expect(error.message, name).toContain('iris.schedules.runs.v1');
      expect(error.message, name).toContain('scheduled runs');
      expect(error.message, name).toContain(fragment);
      expect(error.message, name).toContain('retained');
      expect(storage.getItem('iris.schedules.runs.v1'), name).toBe(raw);
    }
  });

  it('reports the exact storage key and repository for a keyed object', async () => {
    const storageWithCheckpoints = memoryStorage();
    storageWithCheckpoints.setItem('iris.projects.worker-checkpoints.v1', '');
    const failure = await new LocalProjectCheckpointRepository(storageWithCheckpoints)
      .get('run')
      .catch((error: unknown) => error);
    expect((failure as Error).message).toContain('iris.projects.worker-checkpoints.v1');
    expect((failure as Error).message).toContain('project worker checkpoints');
    expect(storageWithCheckpoints.getItem('iris.projects.worker-checkpoints.v1')).toBe('');
  });

  it('rejects a keyed object document that stores a non-array per key', async () => {
    storage.setItem(
      'iris.agents.conversations.v1',
      JSON.stringify({ agent: { role: 'user', content: 'Not an array' } }),
    );
    await expect(new LocalConversationRepository(storage).list('agent')).rejects.toThrow(
      'iris.agents.conversations.v1',
    );
  });
});
