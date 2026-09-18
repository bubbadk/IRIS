import { createDesktopRepository } from './repositoryStorage';
import { withStorageWrite } from './storageWrites';
import { toolRegistry } from './toolRegistry';
import {
  canonicalConfiguredToolIds,
  canonicalConfiguredPermissionRules,
  type ToolRegistry,
} from '@iris/tools';
import type {
  AgentRepository,
  ConversationMessage,
  ConversationRepository,
  SuspendedAgentTurn,
  SuspendedAgentTurnRepository,
} from '@iris/agents';
import {
  cloneAgentDefinition,
  validateAgentDefinition,
  validateDelegationChain,
  type AgentDefinition,
} from '@iris/core';
import type { PendingAgentToolTurn } from '@iris/agents';
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
  ToolApprovalStatus,
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
  validQualityReviews,
  validQualityRejections,
  recordProjectQualityReview,
  projectResultVersion,
  retainProjectQueueEntries,
  protectedProjectQualityHistory,
  retainProjectQualityHistory,
  retainProjectTaskRuns,
  isTerminalProjectTaskRun,
  ProjectRunStateConflictError,
  type QualityReviewReceipt,
  cloneProjectGraph,
  cloneProjectQueueEntry,
  cloneProjectTaskRun,
  cloneSchedule,
  cloneScheduledRun,
  validateProjectGraph,
  validateProjectQueueEntry,
  verifyProjectRun,
  validateProjectRunReservation,
  resumeProjectRun,
  validateProjectTaskRun,
  validateSchedule,
  validateScheduledRun,
  type ProjectGraph,
  type ProjectGraphRepository,
  type ProjectQueueEntry,
  type ProjectQueueRepository,
  type ProjectQueueTransitionExpectation,
  type ProjectTaskRun,
  type ProjectRunReviewEvidence,
  type ProjectTaskRunRepository,
  type ScheduleDefinition,
  type ScheduleRepository,
  type ScheduledRun,
  type ScheduledRunRepository,
} from '@iris/workflows';
import {
  isPlainRecord,
  readPersistedArray,
  readPersistedKeyedObject,
  readPersistedValue,
} from './persistenceIntegrity';

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
const projectQueueStorageKey = 'iris.projects.queue.v1';
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
const contextPackHistoryLimit = 40;
const cortexTurnHistoryLimit = 40;
// Generous enough for the tool-call safety limit (16 per turn) across the retained turn history.
const cortexTurnStepHistoryLimit = 600;
const projectGraphLimit = 50;
const projectQueueLimit = 250;
/**
 * Bounded per project task (see `retainProjectTaskRuns`). Runs carry the full worker report and
 * check evidence, so unbounded history made every worker-progress write rewrite an ever-growing
 * document. Active work, work awaiting review, paused work, live continuation chains and runs
 * carrying human review provenance are never pruned; only finally closed history is.
 */
const projectTaskRunHistoryLimit = 50;
const scheduleLimit = 100;
const scheduledRunLimit = 500;
const workspaceChangeLimit = 250;

const maxStoredMessagesPerAgent = 200;

function isConversationMessage(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const message = value as Record<string, unknown>;
  if (!['user', 'assistant', 'handoff'].includes(message.role as string)) return false;
  if (typeof message.content !== 'string') return false;
  if (message.turnId !== undefined && typeof message.turnId !== 'string') return false;
  if (message.stopReason !== undefined && message.stopReason !== 'tool-limit') return false;
  if (message.images !== undefined && !Array.isArray(message.images)) return false;
  if (message.handoff !== undefined && !isPlainRecord(message.handoff)) return false;
  return true;
}

function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    Boolean(value.id.trim()) &&
    typeof value.content === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    isPlainRecord(value.provenance) &&
    ['user', 'agent'].includes(value.provenance.source as string) &&
    typeof value.provenance.actorId === 'string' &&
    typeof value.provenance.actorName === 'string' &&
    typeof value.provenance.capturedAt === 'string'
  );
}

function isPermissionRule(value: unknown): value is PermissionRule {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    Boolean(value.id.trim()) &&
    typeof value.agentId === 'string' &&
    typeof value.toolId === 'string' &&
    ['allow', 'ask', 'deny'].includes(value.decision as string) &&
    (value.reason === undefined || typeof value.reason === 'string')
  );
}

function isPermissionAuditEvent(value: unknown): value is PermissionAuditEvent {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.timestamp === 'string' &&
    ['inspection', 'execution'].includes(value.source as string) &&
    typeof value.agentId === 'string' &&
    typeof value.agentName === 'string' &&
    typeof value.toolId === 'string' &&
    typeof value.toolName === 'string' &&
    ['allow', 'ask', 'deny'].includes(value.decision as string) &&
    typeof value.reason === 'string'
  );
}

function isToolApprovalRequest(value: unknown): value is ToolApprovalRequest {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    ['pending', 'approved', 'executing', 'denied', 'completed', 'failed'].includes(
      value.status as string,
    ) &&
    typeof value.agentId === 'string' &&
    typeof value.agentName === 'string' &&
    typeof value.toolId === 'string' &&
    typeof value.toolName === 'string' &&
    'input' in value &&
    isPlainRecord(value.evaluation) &&
    ['allow', 'ask', 'deny'].includes(value.evaluation.decision as string) &&
    typeof value.evaluation.reason === 'string'
  );
}

/**
 * A persisted suspended turn is version 4 (which models both kinds of suspension), or an older
 * version 2/3 record that predates delegated chains and therefore always models an approval this
 * turn owns. Older records share every required field, so upgrading them only adds the discriminant.
 */
type LegacyPendingToolTurn = Omit<PendingAgentToolTurn, 'kind'>;
type SuspendedAgentTurnRecord =
  | (Omit<SuspendedAgentTurn, 'version' | 'pending'> & {
      version: 4;
      pending: SuspendedAgentTurn['pending'];
    })
  | (Omit<SuspendedAgentTurn, 'version' | 'pending'> & {
      version: 2 | 3;
      pending: LegacyPendingToolTurn;
    });

function isModelToolCall(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    'input' in value
  );
}

function isAgentToolApproval(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.toolId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.reason === 'string'
  );
}

function isDelegatedChildRef(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (typeof value.childAgentId !== 'string' || !value.childAgentId) return false;
  for (const key of ['approvalId', 'ownerAgentId', 'toolId', 'toolName', 'partialOutput'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  if (value.depth !== undefined && typeof value.depth !== 'number') return false;
  // A child that carries an approval must also identify its owner; otherwise a chain resume could
  // not tell which turn owns the decision.
  if (value.approvalId !== undefined && !value.ownerAgentId) return false;
  return true;
}

function isPendingToolTurn(value: unknown, requireKind: boolean): boolean {
  if (!isPlainRecord(value)) return false;
  if (requireKind && value.kind !== 'tool-approval') return false;
  if (value.kind !== undefined && value.kind !== 'tool-approval') return false;
  if (typeof value.turnId !== 'string') return false;
  if (!isModelToolCall(value.call)) return false;
  if (!isAgentToolApproval(value.approval)) return false;
  if (!Array.isArray(value.remainingCalls) || !value.remainingCalls.every(isModelToolCall))
    return false;
  if (typeof value.assistantText !== 'string') return false;
  if (value.toolCallsUsed !== undefined && typeof value.toolCallsUsed !== 'number') return false;
  if (value.context !== undefined && !Array.isArray(value.context)) return false;
  if (value.queuedApprovals !== undefined) {
    if (
      !Array.isArray(value.queuedApprovals) ||
      !value.queuedApprovals.every(
        (entry) =>
          isPlainRecord(entry) && isModelToolCall(entry.call) && isAgentToolApproval(entry.approval),
      )
    )
      return false;
  }
  if (value.queuedSuspensions !== undefined) {
    if (
      !Array.isArray(value.queuedSuspensions) ||
      !value.queuedSuspensions.every(
        (entry) =>
          isPlainRecord(entry) &&
          isModelToolCall(entry.call) &&
          Array.isArray(entry.children) &&
          entry.children.every(isDelegatedChildRef),
      )
    )
      return false;
  }
  return true;
}

function isPendingDelegationTurn(value: unknown): boolean {
  if (!isPlainRecord(value) || value.kind !== 'delegation') return false;
  if (typeof value.turnId !== 'string') return false;
  if (!Array.isArray(value.waiting) || value.waiting.length === 0) return false;
  if (
    !value.waiting.every(
      (entry) =>
        isPlainRecord(entry) &&
        isModelToolCall(entry.call) &&
        Array.isArray(entry.children) &&
        entry.children.length > 0 &&
        entry.children.every(isDelegatedChildRef),
    )
  )
    return false;
  // A delegation wait with nothing blocked would have resumed the turn instead of persisting it.
  if (
    !value.waiting.some((entry) =>
      (entry as { children: { approvalId?: string }[] }).children.some(
        (child) => child.approvalId !== undefined,
      ),
    )
  )
    return false;
  if (!Array.isArray(value.remainingCalls) || !value.remainingCalls.every(isModelToolCall))
    return false;
  if (typeof value.assistantText !== 'string') return false;
  if (value.toolCallsUsed !== undefined && typeof value.toolCallsUsed !== 'number') return false;
  if (value.context !== undefined && !Array.isArray(value.context)) return false;
  return true;
}

function isSuspendedAgentTurn(value: unknown): value is SuspendedAgentTurnRecord {
  if (!isPlainRecord(value)) return false;
  const version = value.version;
  if (version !== 2 && version !== 3 && version !== 4) return false;
  const wellFormed =
    typeof value.agentId === 'string' &&
    typeof value.providerId === 'string' &&
    typeof value.model === 'string' &&
    Array.isArray(value.conversation) &&
    value.conversation.every(isConversationMessage) &&
    Array.isArray(value.modelHistory) &&
    isPlainRecord(value.pending);
  if (!wellFormed) return false;
  if (version === 4) {
    if (!isPendingToolTurn(value.pending, true) && !isPendingDelegationTurn(value.pending))
      return false;
  } else if (!isPendingToolTurn(value.pending, false)) {
    return false;
  }
  if (version === 2) return true;
  if (value.delegatedAgent === undefined) return value.delegationChain === undefined;
  return (
    validateAgentDefinition(value.delegatedAgent) &&
    (value.delegatedAgent as AgentDefinition).id === value.agentId &&
    validateDelegationChain(value.delegationChain)
  );
}

/**
 * Fail-closed reader: version 2 and version 3 records are structurally approval suspensions this turn
 * owns, so they are upgraded by adding the discriminant — never by guessing a delegation wait. A
 * record that claims to belong to a delegated agent must carry both a valid runtime-built definition
 * and a valid chain, otherwise the whole record is rejected rather than resumed under the wrong
 * authority. Nothing is silently repaired or dropped.
 */
function decodeSuspendedAgentTurn(value: unknown): SuspendedAgentTurn | null {
  if (!isSuspendedAgentTurn(value)) return null;
  if (value.version === 4) return value as SuspendedAgentTurn;
  return {
    version: 4,
    agentId: value.agentId,
    providerId: value.providerId,
    model: value.model,
    conversation: value.conversation,
    modelHistory: value.modelHistory,
    pending: { kind: 'tool-approval', ...value.pending },
    ...(value.delegatedAgent ? { delegatedAgent: value.delegatedAgent } : {}),
    ...(value.delegationChain ? { delegationChain: value.delegationChain } : {}),
  };
}

export class LocalAgentRepository implements AgentRepository {
  constructor(
    private readonly storage?: Storage,
    private readonly registry: ToolRegistry = toolRegistry,
  ) {}

  private canonical(agent: AgentDefinition): AgentDefinition {
    return { ...cloneAgentDefinition(agent), toolIds: canonicalConfiguredToolIds(agent.toolIds, this.registry) };
  }

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(raw: string | null, storageKey: string): AgentDefinition[] {
    return readPersistedArray({
      repository: 'agent configurations',
      storageKey,
      raw,
      decode: (value) => (validateAgentDefinition(value) ? this.canonical(value) : null),
    });
  }

  listSync(): AgentDefinition[] {
    const current = this.store.getItem(agentStorageKey);
    if (current !== null) {
      return this.read(current, agentStorageKey).map(cloneAgentDefinition);
    }
    return this.read(this.store.getItem(legacyAgentStorageKey), legacyAgentStorageKey).map(
      cloneAgentDefinition,
    );
  }

  async list(): Promise<AgentDefinition[]> {
    const current = this.store.getItem(agentStorageKey);
    if (current !== null) {
      const agents = this.read(current, agentStorageKey);
      const canonical = JSON.stringify(agents);
      // Only a fully validated document is migrated; canonical reloads perform no writes.
      if (JSON.stringify(JSON.parse(current)) !== canonical) this.store.setItem(agentStorageKey, canonical);
      return agents.map(cloneAgentDefinition);
    }
    const legacy = this.read(this.store.getItem(legacyAgentStorageKey), legacyAgentStorageKey);
    // Explicit v1 -> v2 migration. The legacy document is only read and rewritten when the v2 key
    // has never been written, so no existing value is ever replaced here.
    if (legacy.length) this.store.setItem(agentStorageKey, JSON.stringify(legacy));
    return legacy.map(cloneAgentDefinition);
  }

  async get(id: string): Promise<AgentDefinition | null> {
    const agent = (await this.list()).find((candidate) => candidate.id === id);
    return agent ? cloneAgentDefinition(agent) : null;
  }

  async save(agent: AgentDefinition): Promise<void> {
    return withStorageWrite(this.store, async () => {
      if (!validateAgentDefinition(agent)) throw new Error('Cannot persist an invalid agent.');
      const canonical = this.canonical(agent);
      const agents = await this.list();
      this.store.setItem(
        agentStorageKey,
        JSON.stringify([
          canonical,
          ...agents.filter((item) => item.id !== agent.id),
        ]),
      );
    });
  }

  async remove(id: string): Promise<void> {
    return withStorageWrite(this.store, async () => {
      const agents = await this.list();
      this.store.setItem(
        agentStorageKey,
        JSON.stringify(agents.filter((agent) => agent.id !== id)),
      );
    });
  }
}

export class LocalProjectGraphRepository implements ProjectGraphRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): ProjectGraph[] {
    return readPersistedArray({
      repository: 'project graphs',
      storageKey: projectGraphStorageKey,
      raw: this.store.getItem(projectGraphStorageKey),
      decode: (value) => (validateProjectGraph(value) ? cloneProjectGraph(value) : null),
    });
  }

  async list(): Promise<ProjectGraph[]> {
    return this.read().map(cloneProjectGraph);
  }

  async get(id: string): Promise<ProjectGraph | null> {
    const graph = this.read().find((candidate) => candidate.id === id);
    return graph ? cloneProjectGraph(graph) : null;
  }

  async save(graph: ProjectGraph): Promise<void> {
    return withStorageWrite(this.store, async () => {
      if (!validateProjectGraph(graph)) throw new Error('Cannot persist an invalid project graph.');
      const graphs = this.read().filter((candidate) => candidate.id !== graph.id);
      this.store.setItem(
        projectGraphStorageKey,
        JSON.stringify([cloneProjectGraph(graph), ...graphs].slice(0, projectGraphLimit)),
      );
    });
  }

  async remove(id: string): Promise<void> {
    return withStorageWrite(this.store, async () => {
      this.store.setItem(
        projectGraphStorageKey,
        JSON.stringify(this.read().filter((graph) => graph.id !== id)),
      );
    });
  }
}

export class LocalProjectTaskRunRepository implements ProjectTaskRunRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): ProjectTaskRun[] {
    return readPersistedArray({
      repository: 'project task runs',
      storageKey: projectTaskRunStorageKey,
      raw: this.store.getItem(projectTaskRunStorageKey),
      decode: (value) => {
        if (!isPlainRecord(value)) return null;
        const run = value as unknown as ProjectTaskRun;
        if (
          (run.qualityReviews !== undefined && !validQualityReviews(run.qualityReviews, run)) ||
          (run.qualityRejections !== undefined && !validQualityRejections(run.qualityRejections)) ||
          ((run.qualityReviews !== undefined || run.qualityRejections !== undefined) &&
            !validateProjectTaskRun(run))
        )
          throw new Error(
            'Saved project quality history is invalid. Restore the stored record before proceeding.',
          );
        return validateProjectTaskRun(value) ? cloneProjectTaskRun(value) : null;
      },
    });
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
    return withStorageWrite(this.store, async () => {
      // §19 — the append-only quality history is bounded before validation, so a run cannot grow
      // forever. The rule only ever drops terminal, already-resolved history.
      const retained = retainProjectQualityHistory(run);
      const bounded: ProjectTaskRun = {
        ...run,
        ...(retained.qualityReviews.length ? { qualityReviews: retained.qualityReviews } : {}),
        ...(retained.qualityRejections.length
          ? { qualityRejections: retained.qualityRejections }
          : {}),
      };
      if (!validateProjectTaskRun(bounded))
        throw new Error('Cannot persist an invalid project task run.');
      // One validated read per operation: the whole file is decoded once, never once per lookup.
      const stored = this.read();
      const existing = stored.find((candidate) => candidate.id === bounded.id);
      // Phase 2I.2 / H4 — durable terminal truth is authoritative across processes. A stale
      // execution continuation that still holds an old in-memory snapshot must not replace a
      // cancelled, completed or failed record with a different (or older) state. The check runs
      // inside the repository write, so it observes the latest committed record after a concurrent
      // process write and the CAS retry.
      if (existing && isTerminalProjectTaskRun(existing)) {
        if (
          bounded.status !== existing.status ||
          Date.parse(bounded.updatedAt) < Date.parse(existing.updatedAt)
        )
          throw new ProjectRunStateConflictError(cloneProjectTaskRun(existing));
      }
      // Appending history is allowed and pruning the oldest fully-closed history is allowed. What is
      // never allowed is dropping or rewriting a record that still decides something — so the guard
      // checks the *protected subset*, not a prefix of the array. A prefix comparison broke the
      // legitimate sliding window at the cap, where appending must drop the oldest entry.
      const requiredQuality = existing ? protectedProjectQualityHistory(existing) : undefined;
      for (const field of ['qualityReviews', 'qualityRejections'] as const) {
        const required = requiredQuality?.[field];
        if (!required?.length) continue;
        const incoming = bounded[field] ?? [];
        for (const record of required) {
          const kept = incoming.some(
            (candidate) =>
              candidate.id === record.id && JSON.stringify(candidate) === JSON.stringify(record),
          );
          if (!kept)
            throw new Error(
              'Saved quality history cannot be removed or overwritten. Refresh the run.',
            );
        }
      }
      // A concurrent pause request must survive a worker's next progress write.
      const saved =
        existing?.pauseRequested && !(existing.status === 'paused' && bounded.status === 'running')
          ? { ...bounded, pauseRequested: true }
          : bounded;
      const runs = stored.filter((candidate) => candidate.id !== bounded.id);
      this.store.setItem(
        projectTaskRunStorageKey,
        JSON.stringify(
          retainProjectTaskRuns(
            [cloneProjectTaskRun(saved), ...runs],
            projectTaskRunHistoryLimit,
          ),
        ),
      );
    });
  }
}

/**
 * Durable queue storage. A corrupt document fails the read instead of being treated as empty, and
 * the retention cap only ever removes terminal history (see `retainProjectQueueEntries`).
 */
export class LocalProjectQueueRepository implements ProjectQueueRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): ProjectQueueEntry[] {
    return readPersistedArray({
      repository: 'project queue',
      storageKey: projectQueueStorageKey,
      raw: this.store.getItem(projectQueueStorageKey),
      decode: (value) => (validateProjectQueueEntry(value) ? cloneProjectQueueEntry(value) : null),
      identity: (entry) => entry.id,
    });
  }

  async list(projectId?: string): Promise<ProjectQueueEntry[]> {
    return this.read()
      .filter((entry) => !projectId || entry.projectId === projectId)
      .map(cloneProjectQueueEntry);
  }

  async get(id: string): Promise<ProjectQueueEntry | null> {
    const entry = this.read().find((candidate) => candidate.id === id);
    return entry ? cloneProjectQueueEntry(entry) : null;
  }

  async enqueue(entry: ProjectQueueEntry): Promise<void> {
    return withStorageWrite(this.store, async () => {
      if (!validateProjectQueueEntry(entry))
        throw new Error('Cannot persist an invalid project queue entry.');
      const entries = this.read();
      if (
        entries.some(
          (candidate) =>
            candidate.projectId === entry.projectId &&
            candidate.taskId === entry.taskId &&
            ['queued', 'claimed'].includes(candidate.status),
        )
      )
        throw new Error('This task is already waiting in the project queue.');
      this.store.setItem(
        projectQueueStorageKey,
        JSON.stringify(
          retainProjectQueueEntries(
            [cloneProjectQueueEntry(entry), ...entries],
            projectQueueLimit,
          ),
        ),
      );
    });
  }

  async claim(id: string, claimedAt: string): Promise<ProjectQueueEntry | null> {
    return withStorageWrite(this.store, async () => {
      const entries = this.read();
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry || entry.status !== 'queued') return null;
      if (
        entries.some(
          (candidate) =>
            candidate.id !== id &&
            candidate.agentId === entry.agentId &&
            candidate.status === 'claimed',
        )
      )
        return null;
      const claimed: ProjectQueueEntry = {
        ...entry,
        status: 'claimed',
        claimedAt,
        updatedAt: claimedAt,
        message: undefined,
      };
      this.store.setItem(
        projectQueueStorageKey,
        JSON.stringify([claimed, ...entries.filter((candidate) => candidate.id !== id)]),
      );
      return cloneProjectQueueEntry(claimed);
    });
  }

  async save(entry: ProjectQueueEntry): Promise<void> {
    return withStorageWrite(this.store, async () => {
      if (!validateProjectQueueEntry(entry))
        throw new Error('Cannot persist an invalid project queue entry.');
      const entries = this.read().filter((candidate) => candidate.id !== entry.id);
      this.store.setItem(
        projectQueueStorageKey,
        JSON.stringify(
          retainProjectQueueEntries(
            [cloneProjectQueueEntry(entry), ...entries],
            projectQueueLimit,
          ),
        ),
      );
    });
  }

  /**
   * IRIS Phase 2G §14, §25 — compare-and-swap for queue state.
   *
   * A dispatch continuation computes its next state from a snapshot it read before an await. If the
   * user cancelled the entry in the meantime, that continuation must lose: the write is applied only
   * while the stored entry still satisfies the expectation it was derived from.
   */
  async saveIfUnchanged(
    entry: ProjectQueueEntry,
    expected: ProjectQueueTransitionExpectation,
  ): Promise<boolean> {
    return withStorageWrite(this.store, async () => {
      if (!validateProjectQueueEntry(entry))
        throw new Error('Cannot persist an invalid project queue entry.');
      const entries = this.read();
      const current = entries.find((candidate) => candidate.id === entry.id);
      if (
        !current ||
        current.status !== expected.status ||
        current.updatedAt !== expected.updatedAt ||
        (expected.runId !== undefined && current.runId !== expected.runId)
      )
        return false;
      this.store.setItem(
        projectQueueStorageKey,
        JSON.stringify(
          retainProjectQueueEntries(
            [cloneProjectQueueEntry(entry), ...entries.filter((candidate) => candidate.id !== entry.id)],
            projectQueueLimit,
          ),
        ),
      );
      return true;
    });
  }
}

export class LocalScheduleRepository implements ScheduleRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }
  private read(): ScheduleDefinition[] {
    return readPersistedArray({
      repository: 'schedules',
      storageKey: scheduleStorageKey,
      raw: this.store.getItem(scheduleStorageKey),
      decode: (value) => (validateSchedule(value) ? cloneSchedule(value) : null),
    });
  }
  async list(): Promise<ScheduleDefinition[]> {
    return this.read().map(cloneSchedule);
  }
  async get(id: string): Promise<ScheduleDefinition | null> {
    const schedule = this.read().find((candidate) => candidate.id === id);
    return schedule ? cloneSchedule(schedule) : null;
  }
  async save(schedule: ScheduleDefinition): Promise<void> {
    return withStorageWrite(this.store, async () => {
      if (!validateSchedule(schedule)) throw new Error('Cannot persist an invalid schedule.');
      const schedules = this.read().filter((candidate) => candidate.id !== schedule.id);
      this.store.setItem(
        scheduleStorageKey,
        JSON.stringify([cloneSchedule(schedule), ...schedules].slice(0, scheduleLimit)),
      );
    });
  }
  async remove(id: string): Promise<void> {
    return withStorageWrite(this.store, async () => {
      this.store.setItem(
        scheduleStorageKey,
        JSON.stringify(this.read().filter((schedule) => schedule.id !== id)),
      );
    });
  }
}

export class LocalScheduledRunRepository implements ScheduledRunRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }
  private read(): ScheduledRun[] {
    return readPersistedArray({
      repository: 'scheduled runs',
      storageKey: scheduledRunStorageKey,
      raw: this.store.getItem(scheduledRunStorageKey),
      decode: (value) => (validateScheduledRun(value) ? cloneScheduledRun(value) : null),
      identity: (run) => run.id,
    });
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
    return withStorageWrite(this.store, async () => {
      if (!validateScheduledRun(run)) throw new Error('Cannot persist an invalid scheduled run.');
      const runs = this.read().filter((candidate) => candidate.id !== run.id);
      this.store.setItem(
        scheduledRunStorageKey,
        JSON.stringify(
          [cloneScheduledRun(run), ...runs].filter(
            (item, index) =>
              index < scheduledRunLimit ||
              ['queued', 'running', 'suspended'].includes(item.status) ||
              Boolean(item.retryAt),
          ),
        ),
      );
    });
  }
}

export class LocalWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): WorkspaceMount | null {
    return readPersistedValue({
      repository: 'workspace mount',
      storageKey: workspaceStorageKey,
      raw: this.store.getItem(workspaceStorageKey),
      decode: (value) => (validateWorkspaceMount(value) ? cloneWorkspaceMount(value) : null),
    });
  }

  async get(): Promise<WorkspaceMount | null> {
    return this.read();
  }

  async save(mount: WorkspaceMount): Promise<void> {
    return withStorageWrite(this.store, async () => {
      if (!validateWorkspaceMount(mount))
        throw new Error('Cannot persist an invalid workspace mount.');
      // This save replaces the whole document, so it must not overwrite a value that cannot be read.
      this.read();
      this.store.setItem(workspaceStorageKey, JSON.stringify(cloneWorkspaceMount(mount)));
    });
  }

  async clear(): Promise<void> {
    return withStorageWrite(this.store, async () => {
      this.store.removeItem(workspaceStorageKey);
    });
  }
}

export class LocalWorkspaceChangeRepository implements WorkspaceChangeRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): WorkspaceChange[] {
    return readPersistedArray({
      repository: 'workspace changes',
      storageKey: workspaceChangeStorageKey,
      raw: this.store.getItem(workspaceChangeStorageKey),
      decode: (value) => (validateWorkspaceChange(value) ? cloneWorkspaceChange(value) : null),
    });
  }

  async list(workspaceId?: string): Promise<WorkspaceChange[]> {
    return this.read()
      .filter((change) => !workspaceId || change.workspaceId === workspaceId)
      .map(cloneWorkspaceChange);
  }

  async append(change: WorkspaceChange): Promise<void> {
    return withStorageWrite(this.store, async () => {
      if (!validateWorkspaceChange(change)) {
        throw new Error('Cannot persist an invalid workspace change.');
      }
      const existing = this.read().filter((candidate) => candidate.id !== change.id);
      this.store.setItem(
        workspaceChangeStorageKey,
        JSON.stringify([cloneWorkspaceChange(change), ...existing].slice(0, workspaceChangeLimit)),
      );
    });
  }

  async clear(workspaceId?: string): Promise<void> {
    return withStorageWrite(this.store, async () => {
      this.store.setItem(
        workspaceChangeStorageKey,
        JSON.stringify(
          workspaceId ? this.read().filter((change) => change.workspaceId !== workspaceId) : [],
        ),
      );
    });
  }
}

export class LocalSkillRepository implements SkillRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): SkillDefinition[] {
    return readPersistedArray({
      repository: 'skills',
      storageKey: skillStorageKey,
      raw: this.store.getItem(skillStorageKey),
      decode: (value) => (validateSkill(value) ? cloneSkill(value) : null),
    });
  }

  async list(): Promise<SkillDefinition[]> {
    return this.read().map(cloneSkill);
  }

  async get(id: string): Promise<SkillDefinition | null> {
    const skill = this.read().find((candidate) => candidate.id === id);
    return skill ? cloneSkill(skill) : null;
  }

  async save(skill: SkillDefinition): Promise<void> {
    return withStorageWrite(this.store, async () => {
      if (!validateSkill(skill)) throw new Error('Cannot persist an invalid skill.');
      const skills = this.read().filter((candidate) => candidate.id !== skill.id);
      this.store.setItem(
        skillStorageKey,
        JSON.stringify([cloneSkill(skill), ...skills].slice(0, skillLimit)),
      );
    });
  }

  async remove(id: string): Promise<void> {
    return withStorageWrite(this.store, async () => {
      this.store.setItem(
        skillStorageKey,
        JSON.stringify(this.read().filter((skill) => skill.id !== id)),
      );
    });
  }
}

export class LocalMcpServerRepository implements McpServerRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): McpServerConnection[] {
    return readPersistedArray({
      repository: 'MCP servers',
      storageKey: mcpServerStorageKey,
      raw: this.store.getItem(mcpServerStorageKey),
      decode: (value) => (validateMcpServer(value) ? cloneMcpServer(value) : null),
    });
  }

  async list(): Promise<McpServerConnection[]> {
    return this.read().map(cloneMcpServer);
  }

  async get(id: string): Promise<McpServerConnection | null> {
    const server = this.read().find((candidate) => candidate.id === id);
    return server ? cloneMcpServer(server) : null;
  }

  async save(server: McpServerConnection): Promise<void> {
    return withStorageWrite(this.store, async () => {
      if (!validateMcpServer(server)) throw new Error('Cannot persist an invalid MCP server.');
      const servers = this.read().filter((candidate) => candidate.id !== server.id);
      this.store.setItem(
        mcpServerStorageKey,
        JSON.stringify([cloneMcpServer(server), ...servers].slice(0, mcpServerLimit)),
      );
    });
  }

  async remove(id: string): Promise<void> {
    return withStorageWrite(this.store, async () => {
      this.store.setItem(
        mcpServerStorageKey,
        JSON.stringify(this.read().filter((server) => server.id !== id)),
      );
    });
  }
}

export class LocalMcpServerRequestPolicyRepository implements McpServerRequestPolicyRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): McpServerRequestPolicy[] {
    return readPersistedArray({
      repository: 'MCP server-request policies',
      storageKey: mcpServerRequestPolicyStorageKey,
      raw: this.store.getItem(mcpServerRequestPolicyStorageKey),
      decode: (value) => {
        if (!isPlainRecord(value)) return null;
        const policy = value as Partial<McpServerRequestPolicy>;
        return policy.version === 1 &&
          typeof policy.id === 'string' &&
          typeof policy.serverId === 'string' &&
          (policy.method === 'roots/list' ||
            policy.method === 'elicitation/create' ||
            policy.method === 'sampling/createMessage') &&
          (policy.decision === 'allow' || policy.decision === 'deny') &&
          typeof policy.updatedAt === 'string'
          ? {
              version: 1 as const,
              id: policy.id,
              serverId: policy.serverId,
              method: policy.method,
              decision: policy.decision,
              updatedAt: policy.updatedAt,
            }
          : null;
      },
    });
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
    return withStorageWrite(this.store, async () => {
      const policies = this.read().filter(
        (item) =>
          item.id !== policy.id &&
          !(item.serverId === policy.serverId && item.method === policy.method),
      );
      this.store.setItem(
        mcpServerRequestPolicyStorageKey,
        JSON.stringify([{ ...policy }, ...policies]),
      );
    });
  }

  async remove(serverId: string, method: SupportedMcpServerRequestMethod): Promise<void> {
    return withStorageWrite(this.store, async () => {
      this.store.setItem(
        mcpServerRequestPolicyStorageKey,
        JSON.stringify(
          this.read().filter((item) => item.serverId !== serverId || item.method !== method),
        ),
      );
    });
  }
}

type StoredConversations = Record<string, ConversationMessage[]>;

export class LocalConversationRepository implements ConversationRepository {
  constructor(
    private readonly storage?: Storage,
    private readonly storageKey = conversationStorageKey,
  ) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): StoredConversations {
    return readPersistedKeyedObject({
      repository: 'conversations',
      storageKey: this.storageKey,
      raw: this.store.getItem(this.storageKey),
      decode: (_agentId, value) =>
        Array.isArray(value) && value.every(isConversationMessage)
          ? value.map((message) => ({ ...(message as ConversationMessage) }))
          : null,
    });
  }

  async list(agentId: string): Promise<ConversationMessage[]> {
    return (this.read()[agentId] ?? []).map((message) => ({ ...message }));
  }

  async save(agentId: string, messages: ConversationMessage[]): Promise<void> {
    return withStorageWrite(this.store, async () => {
      const conversations = this.read();
      conversations[agentId] = messages
        .slice(-maxStoredMessagesPerAgent)
        .map((message) => ({ ...message }));
      try {
        this.store.setItem(this.storageKey, JSON.stringify(conversations));
      } catch {
        throw new Error(
          'Conversation could not be saved. Existing history and attachments were preserved. Free storage space or export your data before retrying.',
        );
      }
    });
  }

  async clear(agentId: string): Promise<void> {
    return withStorageWrite(this.store, async () => {
      const conversations = this.read();
      delete conversations[agentId];
      this.store.setItem(this.storageKey, JSON.stringify(conversations));
    });
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
    return readPersistedArray({
      repository: 'suspended agent turns',
      storageKey: this.storageKey,
      raw: this.store.getItem(this.storageKey),
      decode: (value) => decodeSuspendedAgentTurn(value),
    });
  }

  async getByAgentId(agentId: string): Promise<SuspendedAgentTurn | null> {
    return this.read().find((turn) => turn.agentId === agentId) ?? null;
  }

  async list(): Promise<SuspendedAgentTurn[]> {
    return this.read();
  }

  /**
   * Only the turn that *owns* the approval. A turn that merely waits on a descendant's approval is
   * deliberately not returned: resolving an approval must resume the owner first, never the waiter.
   */
  async getByApprovalId(approvalId: string): Promise<SuspendedAgentTurn | null> {
    return (
      this.read().find(
        (turn) =>
          turn.pending.kind === 'tool-approval' && turn.pending.approval.id === approvalId,
      ) ?? null
    );
  }

  async save(turn: SuspendedAgentTurn): Promise<void> {
    return withStorageWrite(this.store, async () => {
      const turns = this.read();
      this.store.setItem(
        this.storageKey,
        JSON.stringify([
          turn,
          ...turns.filter(
            (stored) =>
              stored.agentId !== turn.agentId &&
              stored.pending.turnId !== turn.pending.turnId,
          ),
        ]),
      );
    });
  }

  async removeByTurnId(turnId: string): Promise<void> {
    return withStorageWrite(this.store, async () => {
      this.store.setItem(
        this.storageKey,
        JSON.stringify(this.read().filter((turn) => turn.pending.turnId !== turnId)),
      );
    });
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
        (source?.source === 'memory' ||
          source?.source === 'skill' ||
          source?.source === 'knowledge') &&
        ['selected', 'no-match', 'not-authorized', 'error'].includes(source.state) &&
        typeof source.detail === 'string',
    ) &&
    Array.isArray(candidate.selections) &&
    candidate.selections.every(
      (item) =>
        (item?.source === 'memory' || item?.source === 'skill' || item?.source === 'knowledge') &&
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
    private readonly legacyStorageKey: string | null | undefined = legacyContextPackStorageKey,
  ) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  private read(): ContextPack[] {
    const current = this.store.getItem(this.storageKey);
    const packs = readPersistedArray({
      repository: 'Cortex context packs',
      storageKey: current === null && this.legacyStorageKey ? this.legacyStorageKey : this.storageKey,
      raw:
        current ?? (this.legacyStorageKey ? this.store.getItem(this.legacyStorageKey) : null),
      decode: (value) => normalizeContextPack(value),
    });
    // Explicit legacy migration: only runs when the current key has never been written.
    if (current === null && packs.length) {
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
    return withStorageWrite(this.store, async () => {
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
    });
  }

  async clear(agentId: string): Promise<void> {
    return withStorageWrite(this.store, async () => {
      this.store.setItem(
        this.storageKey,
        JSON.stringify(this.read().filter((pack) => pack.agentId !== agentId)),
      );
    });
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
    return readPersistedArray({
      repository: 'Cortex turns',
      storageKey: this.storageKey,
      raw: this.store.getItem(this.storageKey),
      decode: (value) => normalizeCortexTurn(value),
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
    return withStorageWrite(this.store, async () => {
      const records = this.read().filter((candidate) => candidate.turnId !== record.turnId);
      const agentHistory = [
        cloneCortexTurn(record),
        ...records.filter((candidate) => candidate.agentId === record.agentId),
      ].slice(0, cortexTurnHistoryLimit);
      const otherAgents = records.filter((candidate) => candidate.agentId !== record.agentId);
      this.store.setItem(this.storageKey, JSON.stringify([...agentHistory, ...otherAgents]));
    });
  }

  async clear(agentId: string): Promise<void> {
    return withStorageWrite(this.store, async () => {
      this.store.setItem(
        this.storageKey,
        JSON.stringify(this.read().filter((record) => record.agentId !== agentId)),
      );
    });
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
    return readPersistedArray({
      repository: 'Cortex turn steps',
      storageKey: this.storageKey,
      raw: this.store.getItem(this.storageKey),
      decode: (value) => normalizeCortexTurnStep(value),
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
    return withStorageWrite(this.store, async () => {
      const others = this.read().filter(
        (candidate) => candidate.turnId !== step.turnId || candidate.toolCallId !== step.toolCallId,
      );
      const merged = [cloneCortexTurnStep(step), ...others].slice(0, cortexTurnStepHistoryLimit);
      this.store.setItem(this.storageKey, JSON.stringify(merged));
    });
  }

  async clear(agentId: string): Promise<void> {
    return withStorageWrite(this.store, async () => {
      this.store.setItem(
        this.storageKey,
        JSON.stringify(this.read().filter((step) => step.agentId !== agentId)),
      );
    });
  }
}

export class LocalMemoryRepository implements MemoryRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  async list(): Promise<MemoryRecord[]> {
    return readPersistedArray({
      repository: 'memory records',
      storageKey: memoryStorageKey,
      raw: this.store.getItem(memoryStorageKey),
      decode: (value) => (isMemoryRecord(value) ? { ...value } : null),
    }).map((record) => ({
      ...record,
      provenance: { ...record.provenance },
    }));
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return (await this.list()).find((record) => record.id === id) ?? null;
  }

  async save(record: MemoryRecord): Promise<void> {
    return withStorageWrite(this.store, async () => {
      const records = await this.list();
      this.store.setItem(
        memoryStorageKey,
        JSON.stringify([record, ...records.filter((item) => item.id !== record.id)]),
      );
    });
  }

  async remove(id: string): Promise<void> {
    return withStorageWrite(this.store, async () => {
      const records = await this.list();
      this.store.setItem(
        memoryStorageKey,
        JSON.stringify(records.filter((record) => record.id !== id)),
      );
    });
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
    return readPersistedArray({
      repository: 'memory embedding indexes',
      storageKey: memoryEmbeddingIndexStorageKey,
      raw: this.store.getItem(memoryEmbeddingIndexStorageKey),
      decode: (value) => (isStoredEmbeddingIndex(value) ? normalizeEmbeddingIndex(value) : null),
    });
  }

  async get(scope: MemoryEmbeddingScope): Promise<MemoryEmbeddingIndex | null> {
    const index = this.read().find(
      (candidate) =>
        candidate.scope.providerId === scope.providerId && candidate.scope.model === scope.model,
    );
    return index ? cloneEmbeddingIndex(index) : null;
  }

  async save(index: MemoryEmbeddingIndex): Promise<void> {
    return withStorageWrite(this.store, async () => {
      const indexes = this.read().filter(
        (candidate) =>
          candidate.scope.providerId !== index.scope.providerId ||
          candidate.scope.model !== index.scope.model,
      );
      this.store.setItem(
        memoryEmbeddingIndexStorageKey,
        JSON.stringify([cloneEmbeddingIndex(index), ...indexes]),
      );
    });
  }

  async clear(): Promise<void> {
    return withStorageWrite(this.store, async () => {
      this.store.removeItem(memoryEmbeddingIndexStorageKey);
    });
  }
}

export class LocalPermissionRuleRepository implements PermissionRuleRepository {
  constructor(
    private readonly storage?: Storage,
    private readonly registry: ToolRegistry = toolRegistry,
  ) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  async list(): Promise<PermissionRule[]> {
    const rules = readPersistedArray({
      repository: 'permission rules',
      storageKey: permissionRuleStorageKey,
      raw: this.store.getItem(permissionRuleStorageKey),
      decode: (value) => (isPermissionRule(value) ? { ...value } : null),
    });
    const canonical = canonicalConfiguredPermissionRules(rules, this.registry);
    if (JSON.stringify(canonical) !== JSON.stringify(rules)) {
      this.store.setItem(permissionRuleStorageKey, JSON.stringify(canonical));
    }
    return canonical;
  }

  async save(rule: PermissionRule): Promise<void> {
    return withStorageWrite(this.store, async () => {
      if (!isPermissionRule(rule)) throw new Error('Cannot persist an invalid permission rule.');
      const rules = await this.list();
      const canonical = canonicalConfiguredPermissionRules(
        [...rules.filter((item) => item.id !== rule.id), rule], this.registry,
      );
      this.store.setItem(permissionRuleStorageKey, JSON.stringify(canonical));
    });
  }

  async remove(id: string): Promise<void> {
    return withStorageWrite(this.store, async () => {
      const rules = await this.list();
      this.store.setItem(
        permissionRuleStorageKey,
        JSON.stringify(rules.filter((rule) => rule.id !== id)),
      );
    });
  }
}

export class LocalPermissionAuditRepository implements PermissionAuditRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  async list(): Promise<PermissionAuditEvent[]> {
    return readPersistedArray({
      repository: 'permission audit',
      storageKey: permissionAuditStorageKey,
      raw: this.store.getItem(permissionAuditStorageKey),
      decode: (value) => (isPermissionAuditEvent(value) ? { ...value } : null),
    }).map((event) => ({ ...event }));
  }

  async append(event: PermissionAuditEvent): Promise<void> {
    return withStorageWrite(this.store, async () => {
      const events = await this.list();
      this.store.setItem(
        permissionAuditStorageKey,
        JSON.stringify([{ ...event }, ...events].slice(0, permissionAuditLimit)),
      );
    });
  }

  async clear(): Promise<void> {
    return withStorageWrite(this.store, async () => {
      this.store.removeItem(permissionAuditStorageKey);
    });
  }
}

export class LocalToolApprovalRepository implements ToolApprovalRepository {
  constructor(private readonly storage?: Storage) {}

  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }

  async list(): Promise<ToolApprovalRequest[]> {
    return readPersistedArray({
      repository: 'tool approvals',
      storageKey: toolApprovalStorageKey,
      raw: this.store.getItem(toolApprovalStorageKey),
      decode: (value) => (isToolApprovalRequest(value) ? { ...value } : null),
    }).map((request) => ({ ...request }));
  }

  async get(id: string): Promise<ToolApprovalRequest | null> {
    return (await this.list()).find((request) => request.id === id) ?? null;
  }

  async save(request: ToolApprovalRequest): Promise<void> {
    return withStorageWrite(this.store, async () => {
      const requests = await this.list();
      this.store.setItem(
        toolApprovalStorageKey,
        JSON.stringify(
          [{ ...request }, ...requests.filter((item) => item.id !== request.id)].filter(
            (item, index) =>
              index < toolApprovalLimit ||
              ['pending', 'approved', 'executing'].includes(item.status),
          ),
        ),
      );
    });
  }

  async compareAndSet(
    id: string,
    expected: ToolApprovalStatus,
    request: ToolApprovalRequest,
  ): Promise<boolean> {
    return withStorageWrite(this.store, async () => {
      const requests = await this.list();
      if (request.id !== id || requests.find((item) => item.id === id)?.status !== expected)
        return false;
      this.store.setItem(
        toolApprovalStorageKey,
        JSON.stringify(requests.map((item) => (item.id === id ? request : item))),
      );
      return true;
    });
  }

  async clearResolved(): Promise<void> {
    return withStorageWrite(this.store, async () => {
      const requests = await this.list();
      this.store.setItem(
        toolApprovalStorageKey,
        JSON.stringify(
          requests.filter(
            (request) =>
              request.status === 'pending' ||
              request.status === 'approved' ||
              request.status === 'executing',
          ),
        ),
      );
    });
  }
}

export const agentRepository = createDesktopRepository(
  (storage) => new LocalAgentRepository(storage),
  [agentStorageKey, legacyAgentStorageKey],
);
export const projectGraphRepository = createDesktopRepository(
  (storage) => new LocalProjectGraphRepository(storage),
  [projectGraphStorageKey],
);
export const projectTaskRunRepository = createDesktopRepository(
  (storage) => new LocalProjectTaskRunRepository(storage),
  [projectTaskRunStorageKey],
);

// The review note, run status and dependency progress commit in one native SQLite transaction.
export class LocalProjectRunCommitter {
  async reviewQuality(runId: string, receipt: QualityReviewReceipt): Promise<ProjectTaskRun> {
    const runs = new LocalProjectTaskRunRepository(this.storage);
    const run = await runs.get(runId);
    if (!run) throw new Error('The worker result is unavailable.');
    const project = await new LocalProjectGraphRepository(this.storage).get(run.projectId);
    if (!project) throw new Error('The project is unavailable.');
    const saved = recordProjectQualityReview(project, run, await runs.list(run.projectId), receipt);
    await runs.save(saved);
    return saved;
  }

  // Return rejection as data so the surrounding transaction commits its audit record before
  // the runtime reports the error. Persistence errors still throw and never report success.
  async attemptVerify(
    runId: string,
    note: string,
    at: string,
    evidence: ProjectRunReviewEvidence,
    rejectionId: string,
  ): Promise<{ run: ProjectTaskRun; error?: string }> {
    const runs = new LocalProjectTaskRunRepository(this.storage);
    const run = await runs.get(runId);
    if (!run) throw new Error('The worker result is unavailable.');
    const projects = new LocalProjectGraphRepository(this.storage);
    const project = await projects.get(run.projectId);
    if (!project) throw new Error('The project is unavailable.');
    let reviewed: ReturnType<typeof verifyProjectRun>;
    try {
      reviewed = verifyProjectRun(project, run, await runs.list(project.id), note, at, evidence);
    } catch (failure) {
      const error = (failure instanceof Error ? failure.message : 'Acceptance was rejected.').slice(
        0,
        4000,
      );
      const rejected = {
        ...run,
        qualityRejections: [
          ...(run.qualityRejections ?? []),
          {
            id: rejectionId,
            at,
            reason: error,
            resultVersion: projectResultVersion(evidence.expectedRun),
          },
        ],
      };
      await runs.save(rejected);
      return { run: rejected, error };
    }
    await runs.save(reviewed.run);
    await projects.save(reviewed.project);
    return { run: reviewed.run };
  }

  constructor(private readonly storage?: Storage) {}
  async reserve(run: ProjectTaskRun): Promise<void> {
    const projects = new LocalProjectGraphRepository(this.storage);
    const runs = new LocalProjectTaskRunRepository(this.storage);
    const project = await projects.get(run.projectId);
    if (!project) throw new Error('The project is unavailable.');
    validateProjectRunReservation(project, run, await runs.list());
    await runs.save(run);
  }
  async pause(runId: string, at: string): Promise<ProjectTaskRun> {
    const runs = new LocalProjectTaskRunRepository(this.storage);
    const run = await runs.get(runId);
    if (!run || !['queued', 'running', 'suspended'].includes(run.status))
      throw new Error('Only a running worker can be paused.');
    const paused = { ...run, pauseRequested: true, updatedAt: at };
    await runs.save(paused);
    return paused;
  }
  async resume(runId: string, at: string): Promise<ProjectTaskRun> {
    const projects = new LocalProjectGraphRepository(this.storage);
    const runs = new LocalProjectTaskRunRepository(this.storage);
    const run = await runs.get(runId);
    if (!run) throw new Error('The paused run is unavailable.');
    const project = await projects.get(run.projectId);
    if (!project) throw new Error('The project is unavailable.');
    const resumed = resumeProjectRun(project, run, await runs.list(), at);
    await runs.save(resumed);
    return resumed;
  }
  async verify(
    runId: string,
    note: string,
    reviewedAt: string,
    evidence?: ProjectRunReviewEvidence,
  ): Promise<ProjectTaskRun> {
    const projects = new LocalProjectGraphRepository(this.storage);
    const runs = new LocalProjectTaskRunRepository(this.storage);
    const run = await runs.get(runId);
    if (!run) throw new Error('The worker result is unavailable.');
    const project = await projects.get(run.projectId);
    if (!project) throw new Error('The project is unavailable.');
    const reviewed = verifyProjectRun(
      project,
      run,
      await runs.list(project.id),
      note,
      reviewedAt,
      evidence,
    );
    await runs.save(reviewed.run);
    await projects.save(reviewed.project);
    return reviewed.run;
  }
}

export const projectRunCommitter = createDesktopRepository(
  (storage) => new LocalProjectRunCommitter(storage),
  [projectGraphStorageKey, projectTaskRunStorageKey],
);
export const projectQueueRepository = createDesktopRepository(
  (storage) => new LocalProjectQueueRepository(storage),
  [projectQueueStorageKey],
);

export const scheduleRepository = createDesktopRepository(
  (storage) => new LocalScheduleRepository(storage),
  [scheduleStorageKey],
);
export const scheduledRunRepository = createDesktopRepository(
  (storage) => new LocalScheduledRunRepository(storage),
  [scheduledRunStorageKey],
);
export const workspaceRepository = createDesktopRepository(
  (storage) => new LocalWorkspaceRepository(storage),
  [workspaceStorageKey],
);
export const workspaceChangeRepository = createDesktopRepository(
  (storage) => new LocalWorkspaceChangeRepository(storage),
  [workspaceChangeStorageKey],
);
export const skillRepository = createDesktopRepository(
  (storage) => new LocalSkillRepository(storage),
  [skillStorageKey],
);
export const mcpServerRepository = createDesktopRepository(
  (storage) => new LocalMcpServerRepository(storage),
  [mcpServerStorageKey],
);
export const mcpServerRequestPolicyRepository = createDesktopRepository(
  (storage) => new LocalMcpServerRequestPolicyRepository(storage),
  [mcpServerRequestPolicyStorageKey],
);
export const conversationRepository = createDesktopRepository(
  (storage) => new LocalConversationRepository(storage),
  [conversationStorageKey],
);
export const suspendedAgentTurnRepository = createDesktopRepository(
  (storage) => new LocalSuspendedAgentTurnRepository(storage),
  [suspendedTurnStorageKey],
);
export const projectWorkerConversationRepository = createDesktopRepository(
  (storage) => new LocalConversationRepository(storage, projectWorkerConversationStorageKey),
  [projectWorkerConversationStorageKey],
);
export const projectWorkerSuspendedTurnRepository = createDesktopRepository(
  (storage) => new LocalSuspendedAgentTurnRepository(storage, projectWorkerSuspendedTurnStorageKey),
  [projectWorkerSuspendedTurnStorageKey],
);
export const contextPackRepository = createDesktopRepository(
  (storage) => new LocalContextPackRepository(storage),
  [contextPackStorageKey, legacyContextPackStorageKey],
);
export const cortexTurnRepository = createDesktopRepository(
  (storage) => new LocalCortexTurnRepository(storage),
  [cortexTurnStorageKey],
);
export const cortexTurnStepRepository = createDesktopRepository(
  (storage) => new LocalCortexTurnStepRepository(storage),
  [cortexTurnStepStorageKey],
);
export const projectWorkerContextPackRepository = createDesktopRepository(
  (storage) => new LocalContextPackRepository(storage, projectWorkerContextPackStorageKey, null),
  [projectWorkerContextPackStorageKey],
);
export const projectWorkerCortexTurnRepository = createDesktopRepository(
  (storage) => new LocalCortexTurnRepository(storage, projectWorkerCortexTurnStorageKey),
  [projectWorkerCortexTurnStorageKey],
);
export const projectWorkerCortexTurnStepRepository = createDesktopRepository(
  (storage) => new LocalCortexTurnStepRepository(storage, projectWorkerCortexTurnStepStorageKey),
  [projectWorkerCortexTurnStepStorageKey],
);
export const memoryRepository = createDesktopRepository(
  (storage) => new LocalMemoryRepository(storage),
  [memoryStorageKey],
);
export const memoryEmbeddingIndexRepository = createDesktopRepository(
  (storage) => new LocalMemoryEmbeddingIndexRepository(storage),
  [memoryEmbeddingIndexStorageKey],
);
export const permissionRuleRepository = createDesktopRepository(
  (storage) => new LocalPermissionRuleRepository(storage),
  [permissionRuleStorageKey],
);
export const permissionAuditRepository = createDesktopRepository(
  (storage) => new LocalPermissionAuditRepository(storage),
  [permissionAuditStorageKey],
);
export const toolApprovalRepository = createDesktopRepository(
  (storage) => new LocalToolApprovalRepository(storage),
  [toolApprovalStorageKey],
);
