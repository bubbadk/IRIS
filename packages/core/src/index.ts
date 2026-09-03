export type IrisObjectType =
  | 'agents'
  | 'projects'
  | 'schedules'
  | 'workspace'
  | 'models'
  | 'memory'
  | 'skills'
  | 'connections'
  | 'channels'
  | 'settings'
  | 'github'
  | 'subtitles';

export type Capability = 'chat' | 'streaming' | 'reasoning' | 'vision' | 'tools' | 'embeddings';

export type AgentAutonomy = 'observe' | 'assist' | 'act' | 'operate' | 'janitor' | 'github';

export type AgentMemoryAccess = 'none' | 'read';
export type AgentApprovalMode = 'ask' | 'yolo';

/**
 * How hard the model should think before answering, mirroring Claude Code's own low/medium/high
 * knob. 'none' sends no reasoning request at all — the model's ordinary default. Providers that
 * cannot honor a given level (or reasoning at all) silently ignore it rather than fail the turn.
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  /** User-authored identity guidance. It never grants tool authority. */
  persona?: string;
  providerPolicyId?: string;
  model?: string;
  takeoverProviderPolicyId?: string;
  takeoverModel?: string;
  autonomy: AgentAutonomy;
  memoryAccess?: AgentMemoryAccess;
  /** YOLO skips repeated approvals for assigned tools; explicit deny rules still win. */
  approvalMode?: AgentApprovalMode;
  /** Defaults to 'none' when unset — no reasoning request is sent. */
  reasoningEffort?: ReasoningEffort;
  skillIds: string[];
  toolIds: string[];
  /**
   * Maximum number of tool calls from a single model round that may execute concurrently.
   * Undefined or omitted means unlimited (preserving existing behavior). Caps at 20 to prevent
   * accidental host overload; values above 20 are clamped during validation.
   */
  maxConcurrentTools?: number;
}

/** Persistence/runtime boundary for user-authored agent configuration. */
export function validateAgentDefinition(value: unknown): value is AgentDefinition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AgentDefinition>;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.trim().length > 0 &&
    typeof candidate.name === 'string' &&
    candidate.name.trim().length > 0 &&
    (candidate.description === undefined || typeof candidate.description === 'string') &&
    (candidate.persona === undefined || typeof candidate.persona === 'string') &&
    (candidate.providerPolicyId === undefined || typeof candidate.providerPolicyId === 'string') &&
    (candidate.model === undefined || typeof candidate.model === 'string') &&
    (candidate.takeoverProviderPolicyId === undefined || typeof candidate.takeoverProviderPolicyId === 'string') &&
    (candidate.takeoverModel === undefined || typeof candidate.takeoverModel === 'string') &&
    (candidate.autonomy === 'observe' ||
      candidate.autonomy === 'assist' ||
      candidate.autonomy === 'act' ||
      candidate.autonomy === 'operate' ||
      candidate.autonomy === 'janitor' ||
      candidate.autonomy === 'github') &&
    (candidate.memoryAccess === undefined ||
      candidate.memoryAccess === 'none' ||
      candidate.memoryAccess === 'read') &&
    (candidate.approvalMode === undefined ||
      candidate.approvalMode === 'ask' ||
      candidate.approvalMode === 'yolo') &&
    (candidate.reasoningEffort === undefined ||
      candidate.reasoningEffort === 'none' ||
      candidate.reasoningEffort === 'low' ||
      candidate.reasoningEffort === 'medium' ||
      candidate.reasoningEffort === 'high') &&
    Array.isArray(candidate.skillIds) &&
    candidate.skillIds.every((id) => typeof id === 'string') &&
    Array.isArray(candidate.toolIds) &&
    candidate.toolIds.every((id) => typeof id === 'string') &&
    (candidate.maxConcurrentTools === undefined ||
      (typeof candidate.maxConcurrentTools === 'number' &&
        Number.isInteger(candidate.maxConcurrentTools) &&
        candidate.maxConcurrentTools >= 1))
  );
}

export function cloneAgentDefinition(agent: AgentDefinition): AgentDefinition {
  return {
    ...agent,
    skillIds: [...agent.skillIds],
    toolIds: [...agent.toolIds],
    ...(agent.maxConcurrentTools !== undefined
      ? { maxConcurrentTools: Math.min(agent.maxConcurrentTools, 20) }
      : {}),
  };
}


export interface ProviderDefinition {
  id: string;
  name: string;
  kind: string;
  capabilities: Capability[];
  local: boolean;
  /**
   * True when this connection round-trips reasoning/thinking blocks across tool-call rounds within
   * a turn (native Anthropic, or OpenRouter — which documents the same continuity mechanism as its
   * `reasoning_details` field). Lets the agent loop trust a later round's reasoning to build on
   * what an earlier round already thought through, instead of assuming it starts blind every time.
   * Absent/false for providers with no such mechanism.
   */
  reasoningContinuity?: boolean;
}

export interface IrisEvent<T = unknown> {
  id: string;
  type: string;
  source: string;
  timestamp: string;
  payload: T;
}
