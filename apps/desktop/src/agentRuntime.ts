import {
  AgentRuntimeCoordinator,
  type AgentActivity,
  type AgentEvent,
  type AgentProviderResolver,
  type AgentSystemContextBuilder,
} from '@iris/agents';
import type { AgentDefinition } from '@iris/core';
import {
  createModelProvider,
  loadProviderConfigs,
  missingProviderConnectionFields,
  providerConnectionFields,
  type ProviderConfig,
} from '@iris/providers';
import { loadProviderSecrets } from './credentials';
import {
  agentRepository,
  contextPackRepository,
  conversationRepository,
  cortexTurnRepository,
  cortexTurnStepRepository,
  permissionRuleRepository,
  suspendedAgentTurnRepository,
} from './persistence';
import { ensureAssignedToolsRequireApproval } from './agentPermissions';
import { toolRegistry, agentToolRuntime, janitorHealthToolId } from './tooling';
import { createSubAgentTool, createSubAgentTeamTool } from './subagentTool';
import { agentContextBuilder } from './memory';
import { agentWorkspaceContext } from './workspace';

type AgentRuntimeListener = (agentId: string) => void;

const listeners = new Set<AgentRuntimeListener>();

// A small, in-memory, real-time log of what IRIS is actually doing — tool calls, approvals,
// replies — across every agent (chat-driven or scheduled/"Dreaming"). Powers the Activity
// Console in the SystemPanel. Never persisted: it exists to show the system is alive right now,
// not as a durable audit trail (that already lives in cortexTurnStepRepository).
export type AgentActivityKind = 'info' | 'tool' | 'success' | 'warn' | 'error';

export interface AgentActivityLogEntry {
  id: string;
  agentId: string;
  agentName: string;
  at: string;
  kind: AgentActivityKind;
  summary: string;
}

const maxActivityLogEntries = 60;
const activityLog: AgentActivityLogEntry[] = [];
const activityListeners = new Set<(log: AgentActivityLogEntry[]) => void>();

/**
 * Turns a raw agent event into one console line, or `null` to skip it. Streamed text
 * (`assistant-chunk`, `reasoning-chunk`) and `context-pack-ready` are real-time progress within
 * the events below, not activity of their own — logging every chunk would drown the feed.
 */
export function summarizeActivity(
  activity: AgentActivity,
): { kind: AgentActivityKind; summary: string } | null {
  const { agentName, event } = activity;
  switch (event.type) {
    case 'user-message':
      return { kind: 'info', summary: `${agentName} received a new message` };
    case 'tool-call':
      return { kind: 'tool', summary: `${agentName} is running ${event.call.name}` };
    case 'tool-complete':
      return { kind: 'success', summary: `${agentName} finished ${event.call.name}` };
    case 'tool-denied':
      return { kind: 'warn', summary: `${agentName}: ${event.call.name} was denied` };
    case 'tool-failed':
      return { kind: 'error', summary: `${agentName}: ${event.call.name} failed` };
    case 'tool-approval-required':
      return {
        kind: 'warn',
        summary: `${agentName} is waiting for approval to run ${event.call.name}`,
      };
    case 'assistant-complete':
      return { kind: 'success', summary: `${agentName} finished replying` };
    default:
      return null;
  }
}

function recordActivity(activity: AgentActivity): void {
  const line = summarizeActivity(activity);
  if (!line) return;
  activityLog.unshift({
    id: `${activity.agentId}-${activity.at}-${Math.random().toString(36).slice(2, 8)}`,
    agentId: activity.agentId,
    agentName: activity.agentName,
    at: activity.at,
    ...line,
  });
  if (activityLog.length > maxActivityLogEntries) activityLog.length = maxActivityLogEntries;
  activityListeners.forEach((listener) => listener(activityLog));
}

/** Subscribes to the live activity log; the listener fires immediately with the current log. */
export function subscribeAgentActivity(
  listener: (log: AgentActivityLogEntry[]) => void,
): () => void {
  activityListeners.add(listener);
  listener(activityLog);
  return () => activityListeners.delete(listener);
}

export const standardWorkspaceTools: readonly string[] = [
  'workspace.list',
  'workspace.search',
  'workspace.read',
  'workspace.directory',
  'workspace.write',
  'workspace.patch',
  'workspace.move',
  'workspace.delete',
  'memory.remember',
  'host.inspect',
  'subagent.delegate',
];

export const standardGitHubTools = [
  'github.list_repos',
  'github.get_repo',
  'github.create_repo',
  'github.create_release',
  'github.trigger_workflow',
  'github.get_workflow_status',
  'github.list_issues',
  'github.create_pull_request',
  'workspace.list',
  'workspace.search',
  'workspace.read',
  'workspace.write',
  'workspace.patch',
  'memory.remember',
];

export async function normalizeDesktopAgent(agent: AgentDefinition): Promise<AgentDefinition> {
  let modified = false;
  let toolIds = [...agent.toolIds];
  if (
    toolIds.length === 0 &&
    (agent.autonomy === 'operate' || agent.autonomy === 'act' || agent.autonomy === 'assist')
  ) {
    toolIds = [...standardWorkspaceTools];
    modified = true;
  }
  if (agent.autonomy === 'github' && toolIds.length === 0) {
    toolIds = [...standardGitHubTools];
    modified = true;
  }
  if (agent.autonomy === 'janitor' && !toolIds.includes(janitorHealthToolId)) {
    toolIds.push(janitorHealthToolId);
    modified = true;
  }
  if (modified) {
    const updated = { ...agent, toolIds };
    await agentRepository.save(updated);
    const rules = await permissionRuleRepository.list();
    await ensureAssignedToolsRequireApproval(
      permissionRuleRepository,
      [updated],
      toolRegistry.list(),
      rules,
    );
    return updated;
  }
  return agent;
}

export function configuredAgentModel(
  agent: Pick<AgentDefinition, 'model'>,
  config: Pick<ProviderConfig, 'model' | 'availableModels'>,
  suspendedModel?: string,
): string {
  const model = suspendedModel?.trim() || agent.model?.trim() || config.model.trim();
  if (!model) throw new Error('This provider needs a model selection before the agent can run.');
  if (
    !suspendedModel &&
    agent.model?.trim() &&
    config.availableModels?.length &&
    !config.availableModels.includes(model)
  ) {
    throw new Error(`The selected agent model ${model} is no longer reported by this provider.`);
  }
  return model;
}

export const providerResolver: AgentProviderResolver = {
  async resolve(agent, suspended) {
    const providerId = suspended?.providerId ?? agent.providerPolicyId;
    const config = loadProviderConfigs().find((provider) => provider.id === providerId);
    if (!config) {
      throw new Error(
        suspended
          ? 'The original provider for this suspended turn is no longer configured.'
          : 'Choose a model provider for this agent first.',
      );
    }
    if (!config.enabled) throw new Error('This model provider is disabled.');
    const model = configuredAgentModel(agent, config, suspended?.model);
    const hasSecretFields = providerConnectionFields(config).some((field) => field.secret);
    const storedSecrets =
      hasSecretFields || config.storedSecretFields?.length
        ? await loadProviderSecrets(config.id)
        : null;
    const connected = {
      ...config,
      connectionValues: {
        ...(storedSecrets ?? {}),
        ...(config.connectionValues ?? {}),
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      },
    };
    const missingFields = missingProviderConnectionFields({
      ...connected,
      storedSecretFields: [],
    });
    if (missingFields.length) {
      throw new Error(
        `This provider needs ${missingFields.map((field) => field.label.toLowerCase()).join(' and ')} before the agent can run.`,
      );
    }
    return {
      provider: createModelProvider(connected),
      model,
    };
  },
};

toolRegistry.register(
  createSubAgentTool({
    agentRepository,
    providerResolver,
    agentToolRuntime,
  }),
);
toolRegistry.register(
  createSubAgentTeamTool({
    agentRepository,
    providerResolver,
    agentToolRuntime,
  }),
);

// A big reasoning budget invites a model to fully draft what it's about to build — a whole file,
// a whole function — inside its reasoning trace before ever touching a tool, then write the same
// thing again for real in the tool call. That reasoning is discarded once the turn moves on (see
// `packages/agents`'s `continueTurn`), so none of that first draft was ever kept: it is pure waste,
// distinct from — and not fixed by — capping how many rounds get the full reasoning budget. This
// is model-agnostic and safe for every agent (chat, janitor, coding), not just build-heavy ones.
export const reasoningHygieneContext: AgentSystemContextBuilder = {
  async build() {
    return [
      'Reasoning guidance: when tools are available, use your reasoning to decide what to do next, not to produce the actual output. Never draft the real content of a tool call — code, file text, long output — inside your reasoning; write it once, for real, through the tool call itself. Reasoning that rehearses what a tool call will contain wastes time and tokens without creating anything real.',
    ];
  },
};

export const memoryHygieneContext: AgentSystemContextBuilder = {
  async build(agent) {
    if (!agent.toolIds.includes('memory.remember')) return [];
    return [
      'Memory guidance: When the user establishes key project facts, environment details, server configs, preferences, or important technical decisions, proactively use the `memory_remember` tool to save concise, durable records for future reference.',
    ];
  },
};

const systemContext: AgentSystemContextBuilder = {
  async build(agent) {
    const [reasoning, workspace, memory] = await Promise.all([
      reasoningHygieneContext.build(agent),
      agentWorkspaceContext.build(agent),
      memoryHygieneContext.build(agent),
    ]);
    return [...reasoning, ...workspace, ...memory];
  },
};

export const agentRuntime = new AgentRuntimeCoordinator(
  agentRepository,
  conversationRepository,
  suspendedAgentTurnRepository,
  providerResolver,
  agentToolRuntime,
  (agentId) => listeners.forEach((listener) => listener(agentId)),
  agentContextBuilder,
  contextPackRepository,
  cortexTurnRepository,
  undefined,
  systemContext,
  normalizeDesktopAgent,
  cortexTurnStepRepository,
  recordActivity,
);

export function subscribeAgentRuntime(listener: AgentRuntimeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function consumeAgentEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const consumed: AgentEvent[] = [];
  for await (const event of events) consumed.push(event);
  return consumed;
}

export async function* scheduledAgentEvents(
  events: AsyncIterable<AgentEvent>,
): AsyncGenerator<
  | { type: 'started' }
  | { type: 'approval-required'; approvalId: string }
  | { type: 'completed'; output: string }
> {
  let started = false;
  for await (const event of events) {
    if (
      !started &&
      (event.type === 'user-message' ||
        event.type === 'assistant-chunk' ||
        event.type === 'tool-call')
    ) {
      started = true;
      yield { type: 'started' };
    }
    if (event.type === 'tool-approval-required')
      yield { type: 'approval-required', approvalId: event.approval.id };
    if (event.type === 'assistant-complete') {
      if (!started) yield { type: 'started' };
      yield { type: 'completed', output: event.message.content };
    }
  }
}
