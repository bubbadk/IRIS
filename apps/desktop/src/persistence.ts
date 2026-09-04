import type {
  AgentRepository,
  ConversationMessage,
  ConversationRepository,
  SuspendedAgentTurn,
  SuspendedAgentTurnRepository,
} from '@iris/agents';
import { cloneAgentDefinition, validateAgentDefinition, type AgentDefinition } from '@iris/core';
import type {
  ContextPack,
  ContextPackRepository,
  ContextSelection,
  CortexTurnRecord,
  CortexTurnRepository,
  CortexTurnStep,
  CortexTurnStepRepository,
} from '@iris/cortex';
import type {
  MemoryEmbeddingIndex,
  MemoryEmbeddingIndexRepository,
  MemoryEmbeddingScope,
  MemoryRecord,
  MemoryRepository,
} from '@iris/memory';
import type {
  PermissionAuditEvent,
  PermissionAuditRepository,
  PermissionRule,
  PermissionRuleRepository,
  ToolApprovalRepository,
  ToolApprovalRequest,
} from '@iris/tools';
import {
  cloneMcpServer,
  validateMcpServer,
  type McpServerConnection,
  type McpServerRepository,
  type SupportedMcpServerRequestMethod,
} from '@iris/mcp';
import {
  cloneSkill,
  validateSkill,
  type SkillDefinition,
  type SkillRepository,
} from '@iris/skills';
import {
  cloneWorkspaceChange,
  cloneWorkspaceMount,
  validateWorkspaceChange,
  validateWorkspaceMount,
  type WorkspaceChange,
  type WorkspaceChangeRepository,
  type WorkspaceMount,
  type WorkspaceRepository,
} from '@iris/workspaces';
import {
  cloneProjectGraph,
  cloneProjectTaskRun,
  cloneSchedule,
  cloneScheduledRun,
  validateProjectGraph,
  validateProjectTaskRun,
  validateSchedule,
  validateScheduledRun,
  type ProjectGraph,
  type ProjectGraphRepository,
  type ProjectTaskRun,
  type ProjectTaskRunRepository,
  type ScheduleDefinition,
  type ScheduleRepository,
  type ScheduledRun,
  type ScheduledRunRepository,
} from '@iris/workflows';

const agentStorageKey = 'iris.agents.config.v2';
const legacyAgentStorageKey = 'iris.agents.config.v1';
const conversationStorageKey = 'iris.agents.conversations.v1';
const suspendedTurnStorageKey = 'iris.agents.suspended-turns.v1';
const projectWorkerConversationStorageKey = 'iris.projects.worker-conversations.v1';
const projectWorkerSuspendedTurnStorageKey = 'iris.projects.worker-suspended-turns.v1';
const contextPackStorageKey = 'iris.cortex.context-packs.v2';
const legacyContextPackStorageKey = 'iris.cortex.context-packs.v1';
const cortexTurnStorageKey = 'iris.cortex.turns.v1';
const cortexTurnStepStorageKey = 'iris.cortex.turn-steps.v1';
const projectWorkerContextPackStorageKey = 'iris.projects.worker-context-packs.v1';
const projectWorkerCortexTurnStorageKey = 'iris.projects.worker-cortex-turns.v1';
const projectWorkerCortexTurnStepStorageKey = 'iris.projects.worker-cortex-turn-steps.v1';
const permissionRuleStorageKey = 'iris.permissions.rules.v1';
const permissionAuditStorageKey = 'iris.permissions.audit.v1';
const toolApprovalStorageKey = 'iris.tools.approvals.v1';
const memoryStorageKey = 'iris.memory.records.v1';
const memoryEmbeddingIndexStorageKey = 'iris.memory.embedding-indexes.v1';
const projectGraphStorageKey = 'iris.projects.graphs.v1';
const projectTaskRunStorageKey = 'iris.projects.task-runs.v1';
const scheduleStorageKey = 'iris.schedules.v1';
const scheduledRunStorageKey = 'iris.schedules.runs.v1';
const workspaceStorageKey = 'iris.workspace.mount.v1';
const workspaceChangeStorageKey = 'iris.workspace.changes.v1';
const skillStorageKey = 'iris.skills.definitions.v1';
const mcpServerStorageKey = 'iris.mcp.servers.v1';
const mcpServerRequestPolicyStorageKey = 'iris.mcp.server-request-policies.v1';
const mcpServerLimit = 50;

export type McpServerRequestPolicyDecision = 'allow' | 'deny';
export interface McpServerRequestPolicy {
  version: 1;
  id: string;
  serverId: string;
  method: SupportedMcpServerRequestMethod;
  decision: McpServerRequestPolicyDecision;
  updatedAt: string;
}

export interface McpServerRequestPolicyRepository {
  list(): Promise<McpServerRequestPolicy[]>;
  get(
    serverId: string,
    method: SupportedMcpServerRequestMethod,
  ): Promise<McpServerRequestPolicy | null>;
  save(policy: McpServerRequestPolicy): Promise<void>;
  remove(serverId: string, method: SupportedMcpServerRequestMethod): Promise<void>;
}
const skillLimit = 100;
const permissionAuditLimit = 250;
const toolApprovalLimit = 100;
const memoryRecordLimit = 200;
const contextPackHistoryLimit = 40;
const cortexTurnHistoryLimit = 40;
// Generous enough for the tool-call safety limit (16 per turn) across the retained turn history.
const cortexTurnStepHistoryLimit = 600;
const projectGraphLimit = 50;
const projectTaskRunLimit = 250;
const scheduleLimit = 100;
const scheduledRunLimit = 500;
const workspaceChangeLimit = 250;

function parseArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as T[];
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export class LocalAgentRepository implements AgentRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(raw: string | null): AgentDefinition[] {
    return parseArray<unknown>(raw).flatMap((value) =>
      validateAgentDefinition(value) ? [cloneAgentDefinition(value)] : [],
    );
  }

  listSync(): AgentDefinition[] {
    const current = this.store.getItem(agentStorageKey);
    if (current !== null) {
      const agents = this.read(current);
      if (agents.length > 0 || current === '[]') {
        return agents.map(cloneAgentDefinition);
      }
    }
    const legacy = this.read(this.store.getItem(legacyAgentStorageKey));
    if (legacy.length) {
      return legacy.map(cloneAgentDefinition);
    }
    return [];
  }

  async list(): Promise<AgentDefinition[]> {
    const current = this.store.getItem(agentStorageKey);
    if (current !== null) {
      const agents = this.read(current);
      if (agents.length > 0 || current === '[]') {
        const parsed = parseArray<unknown>(current);
        if (agents.length !== parsed.length)
          this.store.setItem(agentStorageKey, JSON.stringify(agents));
        return agents.map(cloneAgentDefinition);
      }
    }
    const legacy = this.read(this.store.getItem(legacyAgentStorageKey));
    if (legacy.length) {
      this.store.setItem(agentStorageKey, JSON.stringify(legacy));
      return legacy.map(cloneAgentDefinition);
    }
    return [];
  }

  async get(id: string): Promise<AgentDefinition | null> {
    const agent = (await this.list()).find((candidate) => candidate.id === id);
    return agent ? cloneAgentDefinition(agent) : null;
  }

  async save(agent: AgentDefinition): Promise<void> {
    if (!validateAgentDefinition(agent)) throw new Error('Cannot persist an invalid agent.');
    const agents = await this.list();
    this.store.setItem(
      agentStorageKey,
      JSON.stringify([
        cloneAgentDefinition(agent),
        ...agents.filter((item) => item.id !== agent.id),
      ]),
    );
  }

  async remove(id: string): Promise<void> {
    const agents = await this.list();
    this.store.setItem(agentStorageKey, JSON.stringify(agents.filter((agent) => agent.id !== id)));
  }
}

export class LocalProjectGraphRepository implements ProjectGraphRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): ProjectGraph[] {
    return parseArray<unknown>(this.store.getItem(projectGraphStorageKey)).flatMap((value) =>
      validateProjectGraph(value) ? [cloneProjectGraph(value)] : [],
    );
  }

  async list(): Promise<ProjectGraph[]> {
    return this.read().map(cloneProjectGraph);
  }

  async get(id: string): Promise<ProjectGraph | null> {
    const graph = this.read().find((candidate) => candidate.id === id);
    return graph ? cloneProjectGraph(graph) : null;
  }

  async save(graph: ProjectGraph): Promise<void> {
    if (!validateProjectGraph(graph)) throw new Error('Cannot persist an invalid project graph.');
    const graphs = this.read().filter((candidate) => candidate.id !== graph.id);
    this.store.setItem(
      projectGraphStorageKey,
      JSON.stringify([cloneProjectGraph(graph), ...graphs].slice(0, projectGraphLimit)),
    );
  }

  async remove(id: string): Promise<void> {
    this.store.setItem(
      projectGraphStorageKey,
      JSON.stringify(this.read().filter((graph) => graph.id !== id)),
    );
  }
}

export class LocalProjectTaskRunRepository implements ProjectTaskRunRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): ProjectTaskRun[] {
    return parseArray<unknown>(this.store.getItem(projectTaskRunStorageKey)).flatMap((value) =>
      validateProjectTaskRun(value) ? [cloneProjectTaskRun(value)] : [],
    );
  }

  async list(projectId?: string): Promise<ProjectTaskRun[]> {
    return this.read()
      .filter((run) => !projectId || run.projectId === projectId)
      .map(cloneProjectTaskRun);
  }

  async get(id: string): Promise<ProjectTaskRun | null> {
    const run = this.read().find((candidate) => candidate.id === id);
    return run ? cloneProjectTaskRun(run) : null;
  }

  async save(run: ProjectTaskRun): Promise<void> {
    if (!validateProjectTaskRun(run))
      throw new Error('Cannot persist an invalid project task run.');
    const runs = this.read().filter((candidate) => candidate.id !== run.id);
    this.store.setItem(
      projectTaskRunStorageKey,
      JSON.stringify([cloneProjectTaskRun(run), ...runs].slice(0, projectTaskRunLimit)),
    );
  }
}

export class LocalScheduleRepository implements ScheduleRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }
  private read(): ScheduleDefinition[] {
    return parseArray<unknown>(this.store.getItem(scheduleStorageKey)).flatMap((value) =>
      validateSchedule(value) ? [cloneSchedule(value)] : [],
    );
  }
  async list(): Promise<ScheduleDefinition[]> {
    return this.read().map(cloneSchedule);
  }
  async get(id: string): Promise<ScheduleDefinition | null> {
    const schedule = this.read().find((candidate) => candidate.id === id);
    return schedule ? cloneSchedule(schedule) : null;
  }
  async save(schedule: ScheduleDefinition): Promise<void> {
    if (!validateSchedule(schedule)) throw new Error('Cannot persist an invalid schedule.');
    const schedules = this.read().filter((candidate) => candidate.id !== schedule.id);
    this.store.setItem(
      scheduleStorageKey,
      JSON.stringify([cloneSchedule(schedule), ...schedules].slice(0, scheduleLimit)),
    );
  }
  async remove(id: string): Promise<void> {
    this.store.setItem(
      scheduleStorageKey,
      JSON.stringify(this.read().filter((schedule) => schedule.id !== id)),
    );
  }
}

export class LocalScheduledRunRepository implements ScheduledRunRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }
  private read(): ScheduledRun[] {
    return parseArray<unknown>(this.store.getItem(scheduledRunStorageKey)).flatMap((value) =>
      validateScheduledRun(value) ? [cloneScheduledRun(value)] : [],
    );
  }
  async list(scheduleId?: string): Promise<ScheduledRun[]> {
    return this.read()
      .filter((run) => !scheduleId || run.scheduleId === scheduleId)
      .map(cloneScheduledRun);
  }
  async get(id: string): Promise<ScheduledRun | null> {
    const run = this.read().find((candidate) => candidate.id === id);
    return run ? cloneScheduledRun(run) : null;
  }
  async save(run: ScheduledRun): Promise<void> {
    if (!validateScheduledRun(run)) throw new Error('Cannot persist an invalid scheduled run.');
    const runs = this.read().filter((candidate) => candidate.id !== run.id);
    this.store.setItem(
      scheduledRunStorageKey,
      JSON.stringify([cloneScheduledRun(run), ...runs].slice(0, scheduledRunLimit)),
    );
  }
}

export class LocalWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  async get(): Promise<WorkspaceMount | null> {
    try {
      const raw = this.store.getItem(workspaceStorageKey);
      if (!raw) return null;
      const value: unknown = JSON.parse(raw);
      return validateWorkspaceMount(value) ? cloneWorkspaceMount(value) : null;
    } catch {
      return null;
    }
  }

  async save(mount: WorkspaceMount): Promise<void> {
    if (!validateWorkspaceMount(mount))
      throw new Error('Cannot persist an invalid workspace mount.');
    this.store.setItem(workspaceStorageKey, JSON.stringify(cloneWorkspaceMount(mount)));
  }

  async clear(): Promise<void> {
    this.store.removeItem(workspaceStorageKey);
  }
}

export class LocalWorkspaceChangeRepository implements WorkspaceChangeRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): WorkspaceChange[] {
    return parseArray<unknown>(this.store.getItem(workspaceChangeStorageKey)).flatMap((value) =>
      validateWorkspaceChange(value) ? [cloneWorkspaceChange(value)] : [],
    );
  }

  async list(workspaceId?: string): Promise<WorkspaceChange[]> {
    return this.read()
      .filter((change) => !workspaceId || change.workspaceId === workspaceId)
      .map(cloneWorkspaceChange);
  }

  async append(change: WorkspaceChange): Promise<void> {
    if (!validateWorkspaceChange(change)) {
      throw new Error('Cannot persist an invalid workspace change.');
    }
    const existing = this.read().filter((candidate) => candidate.id !== change.id);
    this.store.setItem(
      workspaceChangeStorageKey,
      JSON.stringify([cloneWorkspaceChange(change), ...existing].slice(0, workspaceChangeLimit)),
    );
  }

  async clear(workspaceId?: string): Promise<void> {
    this.store.setItem(
      workspaceChangeStorageKey,
      JSON.stringify(
        workspaceId
          ? this.read().filter((change) => change.workspaceId !== workspaceId)
          : [],
      ),
    );
  }
}

export class LocalSkillRepository implements SkillRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): SkillDefinition[] {
    return parseArray<unknown>(this.store.getItem(skillStorageKey)).flatMap((value) =>
      validateSkill(value) ? [cloneSkill(value)] : [],
    );
  }

  async list(): Promise<SkillDefinition[]> {
    return this.read().map(cloneSkill);
  }

  async get(id: string): Promise<SkillDefinition | null> {
    const skill = this.read().find((candidate) => candidate.id === id);
    return skill ? cloneSkill(skill) : null;
  }

  async save(skill: SkillDefinition): Promise<void> {
    if (!validateSkill(skill)) throw new Error('Cannot persist an invalid skill.');
    const skills = this.read().filter((candidate) => candidate.id !== skill.id);
    this.store.setItem(
      skillStorageKey,
      JSON.stringify([cloneSkill(skill), ...skills].slice(0, skillLimit)),
    );
  }

  async remove(id: string): Promise<void> {
    this.store.setItem(
      skillStorageKey,
      JSON.stringify(this.read().filter((skill) => skill.id !== id)),
    );
  }
}

export class LocalMcpServerRepository implements McpServerRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): McpServerConnection[] {
    return parseArray<unknown>(this.store.getItem(mcpServerStorageKey)).flatMap((value) =>
      validateMcpServer(value) ? [cloneMcpServer(value)] : [],
    );
  }

  async list(): Promise<McpServerConnection[]> {
    return this.read().map(cloneMcpServer);
  }

  async get(id: string): Promise<McpServerConnection | null> {
    const server = this.read().find((candidate) => candidate.id === id);
    return server ? cloneMcpServer(server) : null;
  }

  async save(server: McpServerConnection): Promise<void> {
    if (!validateMcpServer(server)) throw new Error('Cannot persist an invalid MCP server.');
    const servers = this.read().filter((candidate) => candidate.id !== server.id);
    this.store.setItem(
      mcpServerStorageKey,
      JSON.stringify([cloneMcpServer(server), ...servers].slice(0, mcpServerLimit)),
    );
  }

  async remove(id: string): Promise<void> {
    this.store.setItem(
      mcpServerStorageKey,
      JSON.stringify(this.read().filter((server) => server.id !== id)),
    );
  }
}

export class LocalMcpServerRequestPolicyRepository implements McpServerRequestPolicyRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): McpServerRequestPolicy[] {
    return parseArray<unknown>(this.store.getItem(mcpServerRequestPolicyStorageKey)).flatMap(
      (value) => {
        if (!value || typeof value !== 'object') return [];
        const policy = value as Partial<McpServerRequestPolicy>;
        return policy.version === 1 &&
          typeof policy.id === 'string' &&
          typeof policy.serverId === 'string' &&
          (policy.method === 'roots/list' ||
            policy.method === 'elicitation/create' ||
            policy.method === 'sampling/createMessage') &&
          (policy.decision === 'allow' || policy.decision === 'deny') &&
          typeof policy.updatedAt === 'string'
          ? [
              {
                version: 1 as const,
                id: policy.id,
                serverId: policy.serverId,
                method: policy.method,
                decision: policy.decision,
                updatedAt: policy.updatedAt,
              },
            ]
          : [];
      },
    );
  }

  async list(): Promise<McpServerRequestPolicy[]> {
    return this.read().map((policy) => ({ ...policy }));
  }

  async get(
    serverId: string,
    method: SupportedMcpServerRequestMethod,
  ): Promise<McpServerRequestPolicy | null> {
    const policy = this.read().find((item) => item.serverId === serverId && item.method === method);
    return policy ? { ...policy } : null;
  }

  async save(policy: McpServerRequestPolicy): Promise<void> {
    const policies = this.read().filter(
      (item) =>
        item.id !== policy.id &&
        !(item.serverId === policy.serverId && item.method === policy.method),
    );
    this.store.setItem(
      mcpServerRequestPolicyStorageKey,
      JSON.stringify([{ ...policy }, ...policies]),
    );
  }

  async remove(serverId: string, method: SupportedMcpServerRequestMethod): Promise<void> {
    this.store.setItem(
      mcpServerRequestPolicyStorageKey,
      JSON.stringify(
        this.read().filter((item) => item.serverId !== serverId || item.method !== method),
      ),
    );
  }
}

type StoredConversations = Record<string, ConversationMessage[]>;
const maxStoredMessagesPerAgent = 200;

function stripOlderImages(conversations: StoredConversations, keepRecentCount = 5): StoredConversations {
  const result: StoredConversations = {};
  for (const [agentId, messages] of Object.entries(conversations)) {
    const cutoff = Math.max(0, messages.length - keepRecentCount);
    result[agentId] = messages.map((msg, index) => {
      if (index < cutoff && msg.images?.length) {
        const copy = { ...msg };
        delete copy.images;
        return copy;
      }
      return msg;
    });
  }
  return result;
}

function stripAllImages(conversations: StoredConversations): StoredConversations {
  const result: StoredConversations = {};
  for (const [agentId, messages] of Object.entries(conversations)) {
    result[agentId] = messages.map((msg) => {
      if (msg.images?.length) {
        const copy = { ...msg };
        delete copy.images;
        return copy;
      }
      return msg;
    });
  }
  return result;
}

export class LocalConversationRepository implements ConversationRepository {
  constructor(
    private readonly storage?: Storage,
    private readonly storageKey = conversationStorageKey,
  ) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): StoredConversations {
    try {
      const raw = this.store.getItem(this.storageKey);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as StoredConversations;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  async list(agentId: string): Promise<ConversationMessage[]> {
    return (this.read()[agentId] ?? []).map((message) => ({ ...message }));
  }

  async save(agentId: string, messages: ConversationMessage[]): Promise<void> {
    const conversations = this.read();
    conversations[agentId] = messages
      .slice(-maxStoredMessagesPerAgent)
      .map((message) => ({ ...message }));
    try {
      this.store.setItem(this.storageKey, JSON.stringify(conversations));
    } catch {
      try {
        const trimmed = stripOlderImages(conversations, 3);
        this.store.setItem(this.storageKey, JSON.stringify(trimmed));
      } catch {
        try {
          const noImages = stripAllImages(conversations);
          this.store.setItem(this.storageKey, JSON.stringify(noImages));
        } catch {
          const minimal: StoredConversations = {
            [agentId]: messages.slice(-20).map((msg) => {
              const copy = { ...msg };
              delete copy.images;
              return copy;
            }),
          };
          this.store.setItem(this.storageKey, JSON.stringify(minimal));
        }
      }
    }
  }

  async clear(agentId: string): Promise<void> {
    const conversations = this.read();
    delete conversations[agentId];
    this.store.setItem(this.storageKey, JSON.stringify(conversations));
  }
}

export class LocalSuspendedAgentTurnRepository implements SuspendedAgentTurnRepository {
  constructor(
    private readonly storage?: Storage,
    private readonly storageKey = suspendedTurnStorageKey,
  ) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): SuspendedAgentTurn[] {
    return parseArray<SuspendedAgentTurn>(this.store.getItem(this.storageKey));
  }

  async getByAgentId(agentId: string): Promise<SuspendedAgentTurn | null> {
    return this.read().find((turn) => turn.agentId === agentId) ?? null;
  }

  async getByApprovalId(approvalId: string): Promise<SuspendedAgentTurn | null> {
    return this.read().find((turn) => turn.pending.approval.id === approvalId) ?? null;
  }

  async save(turn: SuspendedAgentTurn): Promise<void> {
    const turns = this.read();
    this.store.setItem(
      this.storageKey,
      JSON.stringify([
        turn,
        ...turns.filter(
          (stored) =>
            stored.agentId !== turn.agentId &&
            stored.pending.approval.id !== turn.pending.approval.id,
        ),
      ]),
    );
  }

  async remove(approvalId: string): Promise<void> {
    this.store.setItem(
      this.storageKey,
      JSON.stringify(this.read().filter((turn) => turn.pending.approval.id !== approvalId)),
    );
  }
}

function cloneContextSelection(item: ContextSelection): ContextSelection {
  return item.source === 'skill'
    ? { ...item, provenance: { ...item.provenance } }
    : { ...item, provenance: { ...item.provenance } };
}

function cloneContextPack(pack: ContextPack): ContextPack {
  return {
    ...pack,
    sources: pack.sources.map((source) => ({ ...source })),
    selections: pack.selections.map(cloneContextSelection),
  };
}

function normalizeContextPack(value: unknown): ContextPack | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Omit<Partial<ContextPack>, 'version'> & { version?: number };
  const valid =
    (candidate.version === 1 || candidate.version === 2) &&
    typeof candidate.id === 'string' &&
    typeof candidate.agentId === 'string' &&
    (candidate.version === 1 || typeof candidate.turnId === 'string') &&
    typeof candidate.prompt === 'string' &&
    typeof candidate.createdAt === 'string' &&
    Array.isArray(candidate.sources) &&
    candidate.sources.every(
      (source) =>
        (source?.source === 'memory' || source?.source === 'skill') &&
        ['selected', 'no-match', 'not-authorized', 'error'].includes(source.state) &&
        typeof source.detail === 'string',
    ) &&
    Array.isArray(candidate.selections) &&
    candidate.selections.every(
      (item) =>
        (item?.source === 'memory' || item?.source === 'skill') &&
        typeof item.sourceId === 'string' &&
        typeof item.content === 'string' &&
        typeof item.reason === 'string' &&
        typeof item.provenance?.actorId === 'string' &&
        typeof item.provenance.actorName === 'string' &&
        typeof item.provenance.capturedAt === 'string',
    );
  if (!valid) return null;
  return cloneContextPack({
    ...(candidate as ContextPack),
    version: 2,
    turnId: candidate.version === 2 ? candidate.turnId! : `legacy-context:${candidate.id!}`,
  });
}

export class LocalContextPackRepository implements ContextPackRepository {
  constructor(
    private readonly storage?: Storage,
    private readonly storageKey = contextPackStorageKey,
    private readonly legacyStorageKey: string | undefined = legacyContextPackStorageKey,
  ) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): ContextPack[] {
    const current = this.store.getItem(this.storageKey);
    const packs = parseArray<unknown>(
      current ?? (this.legacyStorageKey ? this.store.getItem(this.legacyStorageKey) : null),
    ).flatMap((value) => {
      const pack = normalizeContextPack(value);
      return pack ? [pack] : [];
    });
    if (!current && packs.length) {
      this.store.setItem(this.storageKey, JSON.stringify(packs));
    }
    return packs;
  }

  async list(agentId: string): Promise<ContextPack[]> {
    return this.read()
      .filter((candidate) => candidate.agentId === agentId)
      .map(cloneContextPack);
  }

  async listAll(): Promise<ContextPack[]> {
    return this.read().map(cloneContextPack);
  }

  async latest(agentId: string): Promise<ContextPack | null> {
    const pack = (await this.list(agentId))[0];
    return pack ? cloneContextPack(pack) : null;
  }

  async save(pack: ContextPack): Promise<void> {
    const packs = this.read().filter(
      (candidate) =>
        candidate.agentId !== pack.agentId ||
        (candidate.id !== pack.id && candidate.turnId !== pack.turnId),
    );
    const agentHistory = [
      cloneContextPack(pack),
      ...packs.filter((candidate) => candidate.agentId === pack.agentId),
    ].slice(0, contextPackHistoryLimit);
    const otherAgents = packs.filter((candidate) => candidate.agentId !== pack.agentId);
    this.store.setItem(this.storageKey, JSON.stringify([...agentHistory, ...otherAgents]));
  }

  async clear(agentId: string): Promise<void> {
    this.store.setItem(
      this.storageKey,
      JSON.stringify(this.read().filter((pack) => pack.agentId !== agentId)),
    );
  }
}

function cloneCortexTurn(record: CortexTurnRecord): CortexTurnRecord {
  if (record.status === 'suspended') {
    return { ...record, suspension: { ...record.suspension } };
  }
  if (record.status === 'failed') {
    return { ...record, failure: { ...record.failure } };
  }
  return { ...record };
}

function normalizeCortexTurn(value: unknown): CortexTurnRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CortexTurnRecord> & Record<string, unknown>;
  const baseIsValid =
    candidate.version === 1 &&
    typeof candidate.turnId === 'string' &&
    typeof candidate.agentId === 'string' &&
    (candidate.contextPackId === undefined || typeof candidate.contextPackId === 'string') &&
    typeof candidate.providerId === 'string' &&
    typeof candidate.model === 'string' &&
    typeof candidate.startedAt === 'string' &&
    typeof candidate.updatedAt === 'string';
  if (!baseIsValid) return null;
  if (candidate.status === 'running') return cloneCortexTurn(candidate as CortexTurnRecord);
  if (candidate.status === 'completed' && typeof candidate.completedAt === 'string') {
    return cloneCortexTurn(candidate as CortexTurnRecord);
  }
  if (
    candidate.status === 'failed' &&
    typeof candidate.failedAt === 'string' &&
    typeof candidate.failure === 'object' &&
    candidate.failure !== null &&
    typeof (candidate.failure as { message?: unknown }).message === 'string'
  ) {
    return cloneCortexTurn(candidate as CortexTurnRecord);
  }
  if (
    candidate.status === 'suspended' &&
    typeof candidate.suspension === 'object' &&
    candidate.suspension !== null
  ) {
    const suspension = candidate.suspension as Record<string, unknown>;
    if (
      typeof suspension.approvalId === 'string' &&
      typeof suspension.toolId === 'string' &&
      typeof suspension.toolName === 'string' &&
      typeof suspension.reason === 'string'
    ) {
      return cloneCortexTurn(candidate as CortexTurnRecord);
    }
  }
  return null;
}

export class LocalCortexTurnRepository implements CortexTurnRepository {
  constructor(
    private readonly storage?: Storage,
    private readonly storageKey = cortexTurnStorageKey,
  ) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): CortexTurnRecord[] {
    return parseArray<unknown>(this.store.getItem(this.storageKey)).flatMap((value) => {
      const record = normalizeCortexTurn(value);
      return record ? [record] : [];
    });
  }

  async list(agentId: string): Promise<CortexTurnRecord[]> {
    return this.read()
      .filter((record) => record.agentId === agentId)
      .map(cloneCortexTurn);
  }

  /** Every persisted turn across all agents, newest first — used for aggregate telemetry. */
  async listAll(): Promise<CortexTurnRecord[]> {
    return this.read().map(cloneCortexTurn);
  }

  async get(turnId: string): Promise<CortexTurnRecord | null> {
    const record = this.read().find((candidate) => candidate.turnId === turnId);
    return record ? cloneCortexTurn(record) : null;
  }

  async save(record: CortexTurnRecord): Promise<void> {
    const records = this.read().filter((candidate) => candidate.turnId !== record.turnId);
    const agentHistory = [
      cloneCortexTurn(record),
      ...records.filter((candidate) => candidate.agentId === record.agentId),
    ].slice(0, cortexTurnHistoryLimit);
    const otherAgents = records.filter((candidate) => candidate.agentId !== record.agentId);
    this.store.setItem(this.storageKey, JSON.stringify([...agentHistory, ...otherAgents]));
  }

  async clear(agentId: string): Promise<void> {
    this.store.setItem(
      this.storageKey,
      JSON.stringify(this.read().filter((record) => record.agentId !== agentId)),
    );
  }
}

function cloneCortexTurnStep(step: CortexTurnStep): CortexTurnStep {
  return { ...step };
}

function normalizeCortexTurnStep(value: unknown): CortexTurnStep | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CortexTurnStep> & Record<string, unknown>;
  const baseIsValid =
    candidate.version === 1 &&
    typeof candidate.turnId === 'string' &&
    typeof candidate.agentId === 'string' &&
    typeof candidate.toolCallId === 'string' &&
    typeof candidate.toolName === 'string' &&
    typeof candidate.startedAt === 'string' &&
    typeof candidate.updatedAt === 'string' &&
    (candidate.reason === undefined || typeof candidate.reason === 'string') &&
    (candidate.approvalId === undefined || typeof candidate.approvalId === 'string');
  if (!baseIsValid) return null;
  if (
    candidate.status !== 'running' &&
    candidate.status !== 'awaiting-approval' &&
    candidate.status !== 'completed' &&
    candidate.status !== 'denied' &&
    candidate.status !== 'failed'
  ) {
    return null;
  }
  return cloneCortexTurnStep(candidate as CortexTurnStep);
}

/** Persisted trace of every tool call within a Cortex turn — the real run history behind the
 * inspectable timeline, never simulated. */
export class LocalCortexTurnStepRepository implements CortexTurnStepRepository {
  constructor(
    private readonly storage?: Storage,
    private readonly storageKey = cortexTurnStepStorageKey,
  ) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): CortexTurnStep[] {
    return parseArray<unknown>(this.store.getItem(this.storageKey)).flatMap((value) => {
      const step = normalizeCortexTurnStep(value);
      return step ? [step] : [];
    });
  }

  async list(turnId: string): Promise<CortexTurnStep[]> {
    return this.read()
      .filter((step) => step.turnId === turnId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map(cloneCortexTurnStep);
  }

  async listForAgent(agentId: string): Promise<CortexTurnStep[]> {
    return this.read()
      .filter((step) => step.agentId === agentId)
      .map(cloneCortexTurnStep);
  }

  async save(step: CortexTurnStep): Promise<void> {
    const others = this.read().filter(
      (candidate) => candidate.turnId !== step.turnId || candidate.toolCallId !== step.toolCallId,
    );
    const merged = [cloneCortexTurnStep(step), ...others].slice(0, cortexTurnStepHistoryLimit);
    this.store.setItem(this.storageKey, JSON.stringify(merged));
  }

  async clear(agentId: string): Promise<void> {
    this.store.setItem(
      this.storageKey,
      JSON.stringify(this.read().filter((step) => step.agentId !== agentId)),
    );
  }
}

export class LocalMemoryRepository implements MemoryRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  async list(): Promise<MemoryRecord[]> {
    return parseArray<MemoryRecord>(this.store.getItem(memoryStorageKey)).map((record) => ({
      ...record,
      provenance: { ...record.provenance },
    }));
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return (await this.list()).find((record) => record.id === id) ?? null;
  }

  async save(record: MemoryRecord): Promise<void> {
    const records = await this.list();
    this.store.setItem(
      memoryStorageKey,
      JSON.stringify(
        [record, ...records.filter((item) => item.id !== record.id)].slice(0, memoryRecordLimit),
      ),
    );
  }

  async remove(id: string): Promise<void> {
    const records = await this.list();
    this.store.setItem(
      memoryStorageKey,
      JSON.stringify(records.filter((record) => record.id !== id)),
    );
  }
}

function cloneEmbeddingIndex(index: MemoryEmbeddingIndex): MemoryEmbeddingIndex {
  return {
    scope: { ...index.scope },
    builtAt: index.builtAt,
    updatedAt: index.updatedAt,
    entries: index.entries.map((entry) => ({ ...entry, vector: [...entry.vector] })),
    failures: index.failures.map((failure) => ({ ...failure })),
  };
}

interface StoredEmbeddingIndexV1 {
  scope: MemoryEmbeddingScope;
  builtAt: string;
  entries: MemoryEmbeddingIndex['entries'];
}

function isStoredEmbeddingIndex(
  value: unknown,
): value is MemoryEmbeddingIndex | StoredEmbeddingIndexV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MemoryEmbeddingIndex>;
  return (
    typeof candidate.scope?.providerId === 'string' &&
    typeof candidate.scope.model === 'string' &&
    (candidate.builtAt === null || typeof candidate.builtAt === 'string') &&
    Array.isArray(candidate.entries) &&
    candidate.entries.every(
      (entry) =>
        entry &&
        typeof entry.memoryId === 'string' &&
        typeof entry.sourceFingerprint === 'string' &&
        Array.isArray(entry.vector) &&
        entry.vector.every((value) => typeof value === 'number'),
    )
  );
}

function normalizeEmbeddingIndex(
  index: MemoryEmbeddingIndex | StoredEmbeddingIndexV1,
): MemoryEmbeddingIndex {
  const current = index as Partial<MemoryEmbeddingIndex>;
  return {
    scope: { ...index.scope },
    builtAt: index.builtAt,
    updatedAt: typeof current.updatedAt === 'string' ? current.updatedAt : (index.builtAt ?? ''),
    entries: index.entries.map((entry) => ({ ...entry, vector: [...entry.vector] })),
    failures: Array.isArray(current.failures)
      ? current.failures
          .filter(
            (failure) =>
              failure &&
              typeof failure.memoryId === 'string' &&
              typeof failure.sourceFingerprint === 'string' &&
              typeof failure.attempts === 'number' &&
              typeof failure.error === 'string' &&
              typeof failure.lastAttemptAt === 'string',
          )
          .map((failure) => ({ ...failure }))
      : [],
  };
}

export class LocalMemoryEmbeddingIndexRepository implements MemoryEmbeddingIndexRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): MemoryEmbeddingIndex[] {
    return parseArray<unknown>(this.store.getItem(memoryEmbeddingIndexStorageKey))
      .filter(isStoredEmbeddingIndex)
      .map(normalizeEmbeddingIndex);
  }

  async get(scope: MemoryEmbeddingScope): Promise<MemoryEmbeddingIndex | null> {
    const index = this.read().find(
      (candidate) =>
        candidate.scope.providerId === scope.providerId && candidate.scope.model === scope.model,
    );
    return index ? cloneEmbeddingIndex(index) : null;
  }

  async save(index: MemoryEmbeddingIndex): Promise<void> {
    const indexes = this.read().filter(
      (candidate) =>
        candidate.scope.providerId !== index.scope.providerId ||
        candidate.scope.model !== index.scope.model,
    );
    this.store.setItem(
      memoryEmbeddingIndexStorageKey,
      JSON.stringify([cloneEmbeddingIndex(index), ...indexes]),
    );
  }

  async clear(): Promise<void> {
    this.store.removeItem(memoryEmbeddingIndexStorageKey);
  }
}

export class LocalPermissionRuleRepository implements PermissionRuleRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  async list(): Promise<PermissionRule[]> {
    return parseArray<PermissionRule>(this.store.getItem(permissionRuleStorageKey)).map((rule) => ({
      ...rule,
    }));
  }

  async save(rule: PermissionRule): Promise<void> {
    const rules = await this.list();
    this.store.setItem(
      permissionRuleStorageKey,
      JSON.stringify([...rules.filter((item) => item.id !== rule.id), rule]),
    );
  }

  async remove(id: string): Promise<void> {
    const rules = await this.list();
    this.store.setItem(
      permissionRuleStorageKey,
      JSON.stringify(rules.filter((rule) => rule.id !== id)),
    );
  }
}

export class LocalPermissionAuditRepository implements PermissionAuditRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  async list(): Promise<PermissionAuditEvent[]> {
    return parseArray<PermissionAuditEvent>(this.store.getItem(permissionAuditStorageKey)).map(
      (event) => ({ ...event }),
    );
  }

  async append(event: PermissionAuditEvent): Promise<void> {
    const events = await this.list();
    this.store.setItem(
      permissionAuditStorageKey,
      JSON.stringify([{ ...event }, ...events].slice(0, permissionAuditLimit)),
    );
  }

  async clear(): Promise<void> {
    this.store.removeItem(permissionAuditStorageKey);
  }
}

export class LocalToolApprovalRepository implements ToolApprovalRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  async list(): Promise<ToolApprovalRequest[]> {
    return parseArray<ToolApprovalRequest>(this.store.getItem(toolApprovalStorageKey)).map(
      (request) => ({ ...request }),
    );
  }

  async get(id: string): Promise<ToolApprovalRequest | null> {
    return (await this.list()).find((request) => request.id === id) ?? null;
  }

  async save(request: ToolApprovalRequest): Promise<void> {
    const requests = await this.list();
    this.store.setItem(
      toolApprovalStorageKey,
      JSON.stringify(
        [{ ...request }, ...requests.filter((item) => item.id !== request.id)].slice(
          0,
          toolApprovalLimit,
        ),
      ),
    );
  }

  async clearResolved(): Promise<void> {
    const requests = await this.list();
    this.store.setItem(
      toolApprovalStorageKey,
      JSON.stringify(
        requests.filter((request) => request.status === 'pending' || request.status === 'approved'),
      ),
    );
  }
}

export const agentRepository = new LocalAgentRepository();
export const projectGraphRepository = new LocalProjectGraphRepository();
export const projectTaskRunRepository = new LocalProjectTaskRunRepository();
export const scheduleRepository = new LocalScheduleRepository();
export const scheduledRunRepository = new LocalScheduledRunRepository();
export const workspaceRepository = new LocalWorkspaceRepository();
export const workspaceChangeRepository = new LocalWorkspaceChangeRepository();
export const skillRepository = new LocalSkillRepository();
export const mcpServerRepository = new LocalMcpServerRepository();
export const mcpServerRequestPolicyRepository = new LocalMcpServerRequestPolicyRepository();
export const conversationRepository = new LocalConversationRepository();
export const suspendedAgentTurnRepository = new LocalSuspendedAgentTurnRepository();
export const projectWorkerConversationRepository = new LocalConversationRepository(
  undefined,
  projectWorkerConversationStorageKey,
);
export const projectWorkerSuspendedTurnRepository = new LocalSuspendedAgentTurnRepository(
  undefined,
  projectWorkerSuspendedTurnStorageKey,
);
export const contextPackRepository = new LocalContextPackRepository();
export const cortexTurnRepository = new LocalCortexTurnRepository();
export const cortexTurnStepRepository = new LocalCortexTurnStepRepository();
export const projectWorkerContextPackRepository = new LocalContextPackRepository(
  undefined,
  projectWorkerContextPackStorageKey,
  undefined,
);
export const projectWorkerCortexTurnRepository = new LocalCortexTurnRepository(
  undefined,
  projectWorkerCortexTurnStorageKey,
);
export const projectWorkerCortexTurnStepRepository = new LocalCortexTurnStepRepository(
  undefined,
  projectWorkerCortexTurnStepStorageKey,
);
export const memoryRepository = new LocalMemoryRepository();
export const memoryEmbeddingIndexRepository = new LocalMemoryEmbeddingIndexRepository();
export const permissionRuleRepository = new LocalPermissionRuleRepository();
export const permissionAuditRepository = new LocalPermissionAuditRepository();
export const toolApprovalRepository = new LocalToolApprovalRepository();
