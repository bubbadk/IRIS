export type IrisObjectType =
  | 'browser'
  | 'documents'
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
  /**
   * Descriptive record of the permission-rule scopes a delegated (sub-)agent sits under, nearest
   * ancestor first. It documents delegation ancestry for observability and persistence, and it
   * grants no authority: the permission engine never reads this field. Rule binding for a delegated
   * turn is driven exclusively by the runtime-minted delegation context
   * (`DelegationPolicyContext`), so a user-authored or model-influenced agent cannot change any
   * permission outcome by populating it.
   */
  inheritedPolicyAgentIds?: string[];
  /**
   * Descriptive record of a delegated agent's depth, written by the delegating runtime. It grants no
   * authority and is never used for the recursion guard: the authoritative depth travels in the
   * runtime-minted delegation context. Never read from model input.
   */
  delegationDepth?: number;
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
    (candidate.inheritedPolicyAgentIds === undefined ||
      (Array.isArray(candidate.inheritedPolicyAgentIds) &&
        candidate.inheritedPolicyAgentIds.every(
          (id) => typeof id === 'string' && id.trim().length > 0,
        ))) &&
    (candidate.delegationDepth === undefined ||
      (typeof candidate.delegationDepth === 'number' &&
        Number.isInteger(candidate.delegationDepth) &&
        candidate.delegationDepth >= 0)) &&
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

/**
 * The only actor attributes permission-rule precedence depends on. Kept deliberately minimal so a
 * delegation chain can describe its ancestors without the permission engine ever receiving (or
 * trusting) a whole agent definition from a delegated turn.
 */
export interface PolicyActor {
  id: string;
  approvalMode?: AgentApprovalMode;
}

/** Plain, serializable description of a delegation chain. Carries no trust by itself. */
export interface DelegationChain {
  /** Depth of the agent this chain belongs to. A root agent is depth 0. */
  depth: number;
  /** The delegating agents above that agent, nearest ancestor first. */
  ancestors: readonly PolicyActor[];
}

/**
 * One delegated child of a runtime tool call, as reported by the tool that created it.
 *
 * `childAgentId` is the stable correlation key the runtime uses to hand a finished child's outcome
 * back to the turn that delegated to it — never a heuristic such as "the newest suspended turn".
 * `approvalId` is present only while that child is blocked on a descendant approval, and then
 * `ownerAgentId` names the agent that owns the decision.
 */
export interface DelegatedChildRef {
  childAgentId: string;
  approvalId?: string;
  ownerAgentId?: string;
  toolId?: string;
  toolName?: string;
  /** Delegation depth of the child. Diagnostics only — never an authority. */
  depth?: number;
  /**
   * Text the child had already produced when it stopped. Progress, never a result: it is reported so
   * a suspended chain can describe what was in flight, and must never be presented as a final answer.
   */
  partialOutput?: string;
}

export function isDelegatedChildRef(value: unknown): value is DelegatedChildRef {
  if (!value || typeof value !== 'object') return false;
  const child = value as DelegatedChildRef;
  if (typeof child.childAgentId !== 'string' || !child.childAgentId.trim()) return false;
  for (const key of ['approvalId', 'ownerAgentId', 'toolId', 'toolName'] as const) {
    if (child[key] !== undefined && typeof child[key] !== 'string') return false;
  }
  if (child.depth !== undefined && !Number.isInteger(child.depth)) return false;
  if (child.partialOutput !== undefined && typeof child.partialOutput !== 'string') return false;
  if (child.approvalId !== undefined && !child.ownerAgentId) return false;
  return true;
}

/** Module-private brand: only `createDelegationContext` can mint a trusted delegation context. */
const delegationBrand: unique symbol = Symbol('iris.delegation-context');

/**
 * Trusted delegation context accepted by the permission engine.
 *
 * This is the boundary the H-09 audit demands: ancestry only ever arrives here, from runtime code
 * that actually performed the delegation, and never from an agent definition (which a user authors
 * and a model can influence) or from tool arguments (which are untrusted model output). Ancestors
 * are folded into the evaluated agent's decision with least privilege, so a chain can preserve or
 * restrict authority but never raise it.
 */
export type DelegationPolicyContext = DelegationChain & { readonly [delegationBrand]: true };

export function validateDelegationChain(value: unknown): value is DelegationChain {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DelegationChain>;
  return (
    typeof candidate.depth === 'number' &&
    Number.isInteger(candidate.depth) &&
    candidate.depth >= 0 &&
    Array.isArray(candidate.ancestors) &&
    candidate.ancestors.every(
      (ancestor) =>
        Boolean(ancestor) &&
        typeof ancestor === 'object' &&
        typeof (ancestor as PolicyActor).id === 'string' &&
        (ancestor as PolicyActor).id.trim().length > 0 &&
        ((ancestor as PolicyActor).approvalMode === undefined ||
          (ancestor as PolicyActor).approvalMode === 'ask' ||
          (ancestor as PolicyActor).approvalMode === 'yolo'),
    )
  );
}

/** Mints the trusted context only the delegating runtime may produce. */
export function createDelegationContext(chain: DelegationChain): DelegationPolicyContext {
  if (!validateDelegationChain(chain)) {
    throw new Error('A delegation context requires a non-negative depth and valid ancestor actors.');
  }
  const context = {
    depth: chain.depth,
    ancestors: Object.freeze(
      chain.ancestors.map((ancestor) =>
        Object.freeze({
          id: ancestor.id,
          ...(ancestor.approvalMode ? { approvalMode: ancestor.approvalMode } : {}),
        }),
      ),
    ),
    [delegationBrand]: true as const,
  };
  return Object.freeze(context) as DelegationPolicyContext;
}

/**
 * True only for a context minted by `createDelegationContext` in this process. A structurally
 * identical plain object — for example one rebuilt from serialized state, an agent definition, or a
 * caller's own literal — is rejected so it can never activate delegated evaluation.
 */
export function isTrustedDelegationContext(value: unknown): value is DelegationPolicyContext {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as Record<PropertyKey, unknown>)[delegationBrand] === true &&
    validateDelegationChain(value)
  );
}

/** Plain copy for persistence: the brand is intentionally dropped so stored state is never trusted. */
export function copyDelegationChain(
  chain: DelegationChain | undefined,
): DelegationChain | undefined {
  if (!chain) return undefined;
  return {
    depth: chain.depth,
    ancestors: chain.ancestors.map((ancestor) => ({
      id: ancestor.id,
      ...(ancestor.approvalMode ? { approvalMode: ancestor.approvalMode } : {}),
    })),
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
