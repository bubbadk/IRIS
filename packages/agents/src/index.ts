import { validateAgentCheckpoint, type AgentCheckpoint } from './checkpoint';
export { validateAgentCheckpoint, type AgentCheckpoint } from './checkpoint';
export {
  agentLeaseStorageKey,
  createLeaseAuthority,
  decodeExecutionLeases,
  normalizeProcessLiveness,
  type ProcessLiveness,
  type CrossProcessHolderStatus,
  type CrossProcessLeaseIdentity,
  type CrossProcessLeasePort,
  type CrossProcessLeaseRecord,
} from './leaseAuthority';
import type { CrossProcessHolderStatus } from './leaseAuthority';
export type { DelegatedChildRef } from '@iris/core';
import {
  cloneAgentDefinition,
  copyDelegationChain,
  createDelegationContext,
  validateAgentDefinition,
  validateDelegationChain,
  type AgentDefinition,
  type DelegatedChildRef,
  type DelegationChain,
  type DelegationPolicyContext,
} from '@iris/core';

/**
 * Runs items through an async mapper with at most `limit` concurrent in-flight promises.
 * When limit is Infinity (or any non-finite value) this collapses to a plain Promise.all,
 * preserving the existing zero-overhead path for agents without a concurrency cap.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isFinite(limit) || limit >= items.length) {
    return Promise.all(items.map(fn));
  }
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const runNext = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.floor(limit)) }, () => runNext());
  await Promise.all(workers);
  return results;
}
import {
  attachContextPack,
  renderContextPack,
  startCortexTurn,
  startCortexTurnStep,
  transitionCortexTurn,
  transitionCortexTurnStep,
  type ContextPack,
  type ContextPackBuilder,
  type ContextPackRepository,
  type CortexTurnRecord,
  type CortexTurnRepository,
  type CortexTurnStepRepository,
  type CortexTurnStepTransition,
} from '@iris/cortex';
import type {
  ModelImage,
  ModelMessage,
  ModelProvider,
  ModelThinkingBlock,
  ModelToolCall,
  ModelToolDefinition,
  TokenUsage,
} from '@iris/providers';

export interface AgentRepository {
  list(): Promise<AgentDefinition[]>;
  get(id: string): Promise<AgentDefinition | null>;
  save(agent: AgentDefinition): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface ConversationRepository {
  list(agentId: string): Promise<ConversationMessage[]>;
  save(agentId: string, messages: ConversationMessage[]): Promise<void>;
  clear(agentId: string): Promise<void>;
}

export interface SuspendedAgentTurnRepository {
  getByAgentId(agentId: string): Promise<SuspendedAgentTurn | null>;
  getByApprovalId(approvalId: string): Promise<SuspendedAgentTurn | null>;
  /** Every suspended turn, used to find the turn that delegated to a finished child. */
  list(): Promise<SuspendedAgentTurn[]>;
  save(turn: SuspendedAgentTurn): Promise<void>;
  /** Removes one turn by its runtime turn id — the one identity both suspension kinds share. */
  removeByTurnId(turnId: string): Promise<void>;
}

export interface ConversationModelIdentity {
  providerId: string;
  model: string;
}

export interface ConversationModelHandoff {
  from: ConversationModelIdentity;
  to: ConversationModelIdentity;
  at: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'handoff';
  content: string;
  turnId?: string;
  /** A runtime stop is not evidence that the user's task succeeded. */
  stopReason?: 'tool-limit';
  /** Images the user attached to this message. Providers that cannot accept images ignore them. */
  images?: ModelImage[];
  /** Durable transcript-only boundary when a later turn switches its resolved model. */
  handoff?: ConversationModelHandoff;
}

export function createModelHandoffMessage(
  from: ConversationModelIdentity,
  to: ConversationModelIdentity,
  at: string,
): ConversationMessage {
  return {
    role: 'handoff',
    content: `Model handoff · ${from.model} → ${to.model}`,
    handoff: { from: { ...from }, to: { ...to }, at },
  };
}

export interface AgentToolApproval {
  id: string;
  toolId: string;
  toolName: string;
  reason: string;
}

/** A tool call that handed its work to a delegated child which is now waiting for approval. */
export interface AgentToolSuspension {
  /** Every delegated child of the call, in request order. Blocked ones carry their approval. */
  children: DelegatedChildRef[];
}

export type AgentToolExecutionResult =
  | { status: 'completed'; output: unknown }
  | { status: 'denied'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'approval-required'; approval: AgentToolApproval }
  /**
   * Not terminal and not denied: the call delegated to a child that cannot finish yet. The turn must
   * stop here and resume when the descendant approval is resolved — reporting a result now would
   * claim work that has not happened.
   */
  | { status: 'suspended'; suspension: AgentToolSuspension };

export type AgentToolApprovalResult =
  | { status: 'completed'; output: unknown }
  | { status: 'approval-denied' }
  | { status: 'failed'; reason: string }
  /**
   * The approved call itself delegated to a child that now waits for approval. Approving a delegation
   * is not the same as finishing it, so the turn stops on that descendant instead of reporting a
   * result the child has not produced.
   */
  | { status: 'suspended'; suspension: AgentToolSuspension };

export interface AgentToolInvocation {
  turnId: string;
  toolCallId: string;
  /**
   * Present only when the runtime re-invokes a call that previously reported a nested suspension.
   * The delegated children travel back verbatim so the tool recovers their recorded outcomes instead
   * of creating the work (and its side effects) a second time.
   */
  resume?: { children: DelegatedChildRef[] };
}

export interface AgentToolRuntime {
  definitions(agent: AgentDefinition): ModelToolDefinition[];
  execute(
    agent: AgentDefinition,
    toolName: string,
    input: unknown,
    invocation: AgentToolInvocation,
    signal?: AbortSignal,
    /**
     * The invoking agent's trusted delegation chain, when it is a delegated turn. The runtime that
     * delegated to this agent produced it, and it is the only thing that carries delegation depth
     * and ancestry into permission evaluation and further delegation.
     */
    delegation?: DelegationPolicyContext,
  ): Promise<AgentToolExecutionResult>;
  resolve(
    approvalId: string,
    decision: 'approve' | 'deny',
    signal?: AbortSignal,
  ): Promise<AgentToolApprovalResult>;
}

export interface AgentProviderResolution {
  provider: ModelProvider;
  model: string;
}

/**
 * Phase 2H.2 §15 — the truthful classification of one persisted suspended turn during orphan
 * reconciliation. `recoverable` means the turn's durable state still supports resuming it; a
 * `terminal-known` outcome is durably proven and finishes the lifecycle; `unknown` never
 * fabricates success and keeps the suspended state untouched for attention.
 */
export type OrphanOutcome = 'recoverable' | 'terminal-known' | 'unknown';

export interface OrphanReconciliationResult {
  turnId: string;
  agentId: string;
  outcome: OrphanOutcome;
  /** Human-readable, truthful reason for the classification; never a fabricated success. */
  outcomeDetail: string;
}

/** Minimal durable approval status reader used during orphan reconciliation. */
export interface OrphanApprovalReader {
  get(approvalId: string): Promise<{ status: string } | null>;
}export interface AgentProviderResolver {
  resolve(
    agent: AgentDefinition,
    suspended?: Pick<SuspendedAgentTurn, 'providerId' | 'model'>,
  ): Promise<AgentProviderResolution>;
}

export interface AgentSystemContextBuilder {
  build(agent: AgentDefinition): Promise<string[]>;
}

export type AgentEvent =
  | { type: 'context-pack-ready'; pack: ContextPack }
  | { type: 'user-message'; message: ConversationMessage }
  | { type: 'reasoning-chunk'; text: string }
  | { type: 'assistant-chunk'; text: string }
  | { type: 'assistant-complete'; message: ConversationMessage; usage?: TokenUsage }
  | { type: 'tool-call'; call: ModelToolCall }
  | { type: 'tool-complete'; call: ModelToolCall; output: unknown }
  | { type: 'tool-approval-required'; call: ModelToolCall; approval: AgentToolApproval }
  | { type: 'tool-suspended'; call: ModelToolCall; suspension: AgentToolSuspension }
  | { type: 'tool-denied'; call: ModelToolCall; reason: string }
  | { type: 'tool-failed'; call: ModelToolCall; reason: string };

/** One raw agent event as it happens, for a live "what is IRIS doing right now" activity feed. */
export interface AgentActivity {
  agentId: string;
  agentName: string;
  turnId?: string;
  at: string;
  event: AgentEvent;
}

export interface PendingAgentToolTurn {
  kind: 'tool-approval';
  turnId: string;
  call: ModelToolCall;
  approval: AgentToolApproval;
  remainingCalls: ModelToolCall[];
  /**
   * Other calls from the same parallel batch that also turned out to need approval, each already
   * carrying its own resolved `AgentToolApproval` (obtained when the whole batch executed
   * concurrently). Approvals are still surfaced to the user one at a time, in the order the model
   * requested them — resolving `call` above promotes the next entry here instead of re-running it.
   */
  queuedApprovals?: { call: ModelToolCall; approval: AgentToolApproval }[];
  assistantText: string;
  /** Preserve the safety limit through approvals and restarts. */
  toolCallsUsed?: number;
  context?: ModelMessage[];
  /**
   * Calls from the same batch that turned out to wait on a delegated descendant rather than an
   * approval of this turn. They are re-evaluated once every approval in the batch is resolved, so a
   * batched delegation can never be silently dropped.
   */
  queuedSuspensions?: { call: ModelToolCall; children: DelegatedChildRef[] }[];
}

/**
 * A turn that stopped because a tool call handed its work to a delegated child that is waiting for
 * approval. This turn owns no approval of its own: it is blocked on a *descendant's* approval, and
 * it stays non-terminal until that descendant chain is settled.
 */
export interface PendingAgentDelegationTurn {
  kind: 'delegation';
  turnId: string;
  /** Every suspended call with the delegated children it is waiting for, in request order. */
  waiting: { call: ModelToolCall; children: DelegatedChildRef[] }[];
  remainingCalls: ModelToolCall[];
  assistantText: string;
  /** Preserve the safety limit through suspensions and restarts. */
  toolCallsUsed?: number;
  context?: ModelMessage[];
}

export type PendingAgentTurn = PendingAgentToolTurn | PendingAgentDelegationTurn;

/** One approval a suspended turn is currently blocked on. */
export interface PendingApprovalRef {
  approvalId: string;
  /** The agent that owns the approval: the deepest waiting agent in the delegation chain. */
  ownerAgentId: string;
  toolId?: string;
  toolName?: string;
  depth?: number;
}

/**
 * Every approval a suspended turn is blocked on, deepest owner first. A `tool-approval` turn owns its
 * own approval; a `delegation` turn is blocked on the approvals of the descendants it handed work to.
 */
export function suspendedApprovals(turn: SuspendedAgentTurn): PendingApprovalRef[] {
  if (turn.pending.kind === 'tool-approval') {
    const approval = turn.pending.approval;
    return [
      {
        approvalId: approval.id,
        ownerAgentId: turn.agentId,
        toolId: approval.toolId,
        toolName: approval.toolName,
        ...(turn.delegatedAgent?.delegationDepth !== undefined
          ? { depth: turn.delegatedAgent.delegationDepth }
          : {}),
      },
    ];
  }
  const approvals: PendingApprovalRef[] = [];
  for (const entry of turn.pending.waiting) {
    for (const child of entry.children) {
      if (!child.approvalId) continue;
      approvals.push({
        approvalId: child.approvalId,
        ownerAgentId: child.ownerAgentId ?? child.childAgentId,
        ...(child.toolId ? { toolId: child.toolId } : {}),
        ...(child.toolName ? { toolName: child.toolName } : {}),
        ...(child.depth !== undefined ? { depth: child.depth } : {}),
      });
    }
  }
  return approvals;
}

/**
 * A turn that stopped because a tool needs approval. This is a *suspended* state, never a terminal
 * one: the tool has not run, the model has not been asked to continue, and only resolving the
 * approval can move the turn forward.
 */
export interface SuspendedAgentTurn {
  version: 4;
  agentId: string;
  providerId: string;
  model: string;
  conversation: ConversationMessage[];
  modelHistory: ModelMessage[];
  pending: PendingAgentTurn;
  /**
   * The runtime-built definition of an ephemeral delegated (sub-)agent. A sub-agent is never
   * persisted as a roster agent, so this is what lets a suspended delegated turn be resumed with its
   * own identity, tool assignment and approval mode instead of an unresolved agent id.
   */
  delegatedAgent?: AgentDefinition;
  /**
   * Plain copy of the delegated turn's trusted chain, re-minted into a trusted context at resume.
   * Stored state is never trusted directly: a tampered chain can only restrict, because ancestors
   * are folded with least privilege.
   */
  delegationChain?: DelegationChain;
}

const maxToolRounds = 16;

/**
 * Safety bound for resuming a delegation chain. Delegation itself is already limited by the nesting
 * limit; this only bounds a walk that would otherwise be able to loop on corrupted state.
 */
const maxDelegationResumeChain = 32;

// Rough character budget for the rolling model history. ~4 chars per token keeps the default
// near 100k tokens of conversation, well inside every supported model's context window while
// leaving ample room for the system context and the model's reply. Anthropic prompt caching
// (see `withTrailingCacheControl` in @iris/providers) makes resending this much larger, mostly
// unchanged prefix on every tool round cheap, so the budget can favor keeping real work over
// shaving tokens.
const defaultHistoryCharBudget = 400_000;

function messageChars(message: ModelMessage): number {
  let total = message.content?.length ?? 0;
  for (const call of message.toolCalls ?? []) {
    total += call.name.length + JSON.stringify(call.input ?? {}).length;
  }
  return total;
}

/**
 * Trims the oldest complete exchanges from a conversation history so it stays within a character
 * budget. Trimming happens only at `user` message boundaries, so an assistant tool call is never
 * separated from its tool result — which every provider format requires. The two most recent
 * exchanges are always kept in full (not just the last one), and a short marker records how many
 * earlier messages were elided.
 *
 * Keeping two, not one, matters for a long tool-calling turn: a multi-round build with no user
 * message in between is a single exchange, however large. If a user then sends a short follow-up
 * ("continue"), that follow-up becomes the new "most recent" exchange and the entire build turn
 * would otherwise be the very next one in line to be dropped — wiping out the model's only record
 * of the work it just did, right when the user asked it to pick that work back up.
 */
/**
 * Returns the trimming priority of a message. Pinned messages are never dropped, high-priority
 * messages survive after all normal ones have been exhausted, and everything else (including
 * messages without metadata) is treated as normal. System-role messages are automatically
 * promoted to pinned so foundational instructions never get silently lost.
 */
function messagePriority(message: ModelMessage): 'pinned' | 'high' | 'normal' {
  if (message.role === 'system') return 'pinned';
  return message.metadata?.priority ?? 'normal';
}

export function trimModelHistory(
  history: ModelMessage[],
  maxChars = defaultHistoryCharBudget,
): { history: ModelMessage[]; dropped: number } {
  const totalChars = history.reduce((sum, message) => sum + messageChars(message), 0);
  if (totalChars <= maxChars) return { history, dropped: 0 };

  const starts = history.flatMap((message, index) => (message.role === 'user' ? [index] : []));
  if (starts.length <= 2) return { history, dropped: 0 };

  // Build exchange groups between user-message boundaries. Each group starts at a user message
  // and extends up to (but not including) the next user message, so tool calls and their results
  // stay grouped with the user turn that triggered them. Messages before the first user message
  // (typically system prompts) form their own leading exchange.
  const exchanges: Array<{ from: number; to: number; priority: 'pinned' | 'high' | 'normal' }> = [];
  const bounds = [0, ...starts, history.length];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const from = bounds[i];
    const to = bounds[i + 1];
    if (from === to) continue;
    // An exchange inherits its highest member priority — a single pinned message in an exchange
    // protects the whole group. This keeps tool results attached to pinned system context.
    let priority: 'pinned' | 'high' | 'normal' = 'normal';
    for (let j = from; j < to; j += 1) {
      const p = messagePriority(history[j]);
      if (p === 'pinned') {
        priority = 'pinned';
        break;
      }
      if (p === 'high' && priority === 'normal') priority = 'high';
    }
    exchanges.push({ from, to, priority });
  }

  // The last two user-originated exchanges are always preserved so the model retains its most
  // recent conversational context. When there are fewer than three user turns total we already
  // returned above, so this slice is always safe.
  const trimmable = exchanges.slice(0, Math.max(0, exchanges.length - 2));
  if (trimmable.length === 0) return { history, dropped: 0 };

  // Drop normal-priority exchanges first (oldest first), then high. Pinned exchanges are
  // never dropped regardless of budget pressure.
  let remaining = totalChars;
  let droppedCount = 0;
  const droppedIndices = new Set<number>();
  for (const tier of ['normal', 'high'] as const) {
    for (let i = 0; i < trimmable.length && remaining > maxChars; i += 1) {
      const exchange = trimmable[i];
      if (exchange.priority !== tier) continue;
      for (let j = exchange.from; j < exchange.to; j += 1) {
        remaining -= messageChars(history[j]);
        droppedIndices.add(j);
      }
      droppedCount += exchange.to - exchange.from;
    }
  }

  if (droppedCount === 0) return { history, dropped: 0 };

  const kept = history.filter((_, i) => !droppedIndices.has(i));
  const marker: ModelMessage = {
    role: 'assistant',
    content: `[IRIS trimmed ${droppedCount} earlier message${droppedCount === 1 ? '' : 's'} to stay within the context window. Pinned and high-priority messages were preserved where possible.]`,
  };
  return { history: [marker, ...kept], dropped: droppedCount };
}

function addUsage(total: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  return {
    inputTokens: (total?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + next.outputTokens,
  };
}

function toolOutputContent(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output) ?? 'null';
  } catch {
    return String(output);
  }
}

export class AgentSession {
  private readonly history: ConversationMessage[] = [];
  private readonly modelHistory: ModelMessage[] = [];
  private pendingToolTurn: PendingAgentToolTurn | null = null;
  private pendingDelegationTurn: PendingAgentDelegationTurn | null = null;

  constructor(
    readonly agent: AgentDefinition,
    private readonly provider: ModelProvider,
    private readonly model: string,
    initialHistory: ConversationMessage[] = [],
    private readonly tools?: AgentToolRuntime,
    suspendedTurn?: SuspendedAgentTurn,
    initialContext: ModelMessage[] = [],
    checkpointHistory?: ModelMessage[],
    /**
     * Trusted delegation chain for this session, supplied only by the runtime that delegated to this
     * agent (or re-minted from a suspended turn's stored chain). Nothing on the agent definition is
     * read as delegation authority.
     */
    private readonly delegation?: DelegationPolicyContext,
  ) {
    if (suspendedTurn) {
      if (suspendedTurn.agentId !== agent.id) {
        throw new Error(`Suspended turn belongs to another agent: ${suspendedTurn.agentId}.`);
      }
      if (suspendedTurn.providerId !== provider.definition.id || suspendedTurn.model !== model) {
        throw new Error('Suspended turn must resume with its original provider and model.');
      }
      // A delegated turn's authority comes from its chain. Resuming without one would evaluate the
      // child as a standalone agent — which, for a YOLO child, could ignore an ancestor's deny rule.
      // Fail closed instead of guessing.
      if (suspendedTurn.delegatedAgent && !delegation) {
        throw new Error(
          'Refusing to resume a delegated turn without its trusted delegation context.',
        );
      }
      this.history.push(...copyConversation(suspendedTurn.conversation));
      this.modelHistory.push(...copyModelHistory(suspendedTurn.modelHistory));
      if (suspendedTurn.pending.kind === 'delegation') {
        this.pendingDelegationTurn = copyPendingDelegationTurn(suspendedTurn.pending);
      } else {
        this.pendingToolTurn = copyPendingTurn(suspendedTurn.pending);
      }
      return;
    }
    this.history.push(...copyConversation(initialHistory));
    this.modelHistory.push(...copyModelHistory(initialContext));
    if (checkpointHistory) {
      this.modelHistory.push(...copyModelHistory(checkpointHistory));
      return;
    }
    this.modelHistory.push(
      ...initialHistory.filter(isModelConversationMessage).map(toModelConversationMessage),
    );
  }

  static restore(
    agent: AgentDefinition,
    provider: ModelProvider,
    suspendedTurn: SuspendedAgentTurn,
    tools: AgentToolRuntime,
    delegation?: DelegationPolicyContext,
  ): AgentSession {
    return new AgentSession(
      agent,
      provider,
      suspendedTurn.model,
      [],
      tools,
      suspendedTurn,
      [],
      undefined,
      delegation,
    );
  }

  checkpoint(): AgentCheckpoint {
    if (this.pendingToolTurn || this.pendingDelegationTurn)
      throw new Error('Resolve the pending approval before checkpointing this turn.');
    const checkpoint: AgentCheckpoint = {
      version: 1,
      agentId: this.agent.id,
      providerId: this.provider.definition.id,
      model: this.model,
      turnId: this.history.at(-1)?.turnId ?? '',
      conversation: copyConversation(this.history),
      modelHistory: copyModelHistory(withoutThinkingBlocks(this.modelHistory)),
    };
    if (!validateAgentCheckpoint(checkpoint))
      throw new Error('This turn has no safe checkpoint. Tool outcomes may still be unknown.');
    return checkpoint;
  }

  static fromCheckpoint(
    agent: AgentDefinition,
    provider: ModelProvider,
    checkpoint: AgentCheckpoint,
    tools: AgentToolRuntime,
  ): AgentSession {
    if (
      !validateAgentCheckpoint(checkpoint) ||
      checkpoint.agentId !== agent.id ||
      checkpoint.providerId !== provider.definition.id
    )
      throw new Error('The checkpoint does not match this agent and provider.');
    return new AgentSession(
      agent,
      provider,
      checkpoint.model,
      checkpoint.conversation,
      tools,
      undefined,
      [],
      checkpoint.modelHistory,
    );
  }

  messages(): ConversationMessage[] {
    return copyConversation(this.history);
  }

  runtimeIdentity(): { providerId: string; model: string } {
    return { providerId: this.provider.definition.id, model: this.model };
  }

  /**
   * The resumable snapshot of a turn that stopped on `tool-approval-required` or on a delegated
   * child's approval, or `null` when the turn is not suspended. Callers must treat a non-null result
   * as "not finished": the approval is still pending and the work has not happened.
   */
  suspendedTurn(): SuspendedAgentTurn | null {
    if (!this.pendingToolTurn && !this.pendingDelegationTurn) return null;
    const chain = copyDelegationChain(this.delegation);
    return {
      version: 4,
      agentId: this.agent.id,
      providerId: this.provider.definition.id,
      model: this.model,
      conversation: copyConversation(this.history),
      modelHistory: copyModelHistory(this.modelHistory),
      pending: this.pendingToolTurn
        ? copyPendingTurn(this.pendingToolTurn)
        : copyPendingDelegationTurn(this.pendingDelegationTurn!),
      // Only a runtime-minted chain marks this turn as delegated; the agent's own metadata fields
      // are copied for observability and never become authority.
      ...(chain
        ? {
            delegatedAgent: cloneAgentDefinition(this.agent),
            delegationChain: chain,
          }
        : {}),
    };
  }

  async *send(
    text: string,
    signal?: AbortSignal,
    context: ModelMessage[] = [],
    turnId = createTurnId(),
    images: ModelImage[] = [],
  ): AsyncGenerator<AgentEvent> {
    const content = text.trim();
    // An image-only message (a screenshot with no caption) is a legitimate turn.
    if (!content && !images.length) return;
    if (this.pendingToolTurn || this.pendingDelegationTurn) {
      throw new Error('Resolve the pending tool approval before sending another message.');
    }
    const normalizedTurnId = turnId.trim();
    if (!normalizedTurnId) throw new Error('An agent turn requires a runtime turn ID.');

    // Thinking blocks are only meaningful within the still-open tool-use sequence that produced
    // them. This new turn means the previous one has concluded, so its thinking no longer needs to
    // ride along on every future request — drop it before it becomes dead weight in the history.
    const settled = withoutThinkingBlocks(this.modelHistory);
    this.modelHistory.length = 0;
    this.modelHistory.push(...settled);

    const userMessage = {
      role: 'user' as const,
      content,
      turnId: normalizedTurnId,
      ...(images.length ? { images } : {}),
    };
    this.history.push(userMessage);
    this.modelHistory.push(toModelConversationMessage(userMessage));
    yield { type: 'user-message', message: userMessage };

    // Keep the rolling history within the context budget before starting the turn. Only whole
    // past exchanges are dropped, so the just-added message and any tool pairs stay intact.
    const trimmed = trimModelHistory(this.modelHistory);
    if (trimmed.dropped > 0) {
      this.modelHistory.length = 0;
      this.modelHistory.push(...trimmed.history);
    }

    yield* this.continueTurn('', [], normalizedTurnId, context, signal);
  }

  async *resolveApproval(
    approvalId: string,
    decision: 'approve' | 'deny',
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const pending = this.pendingToolTurn;
    if (!pending || pending.approval.id !== approvalId) {
      throw new Error(`No pending tool approval matches ${approvalId}.`);
    }
    if (!this.tools) throw new Error('This agent session has no tool runtime.');

    const result = await this.tools.resolve(approvalId, decision, signal);
    this.pendingToolTurn = null;
    if (result.status === 'suspended') {
      // The approval covered the delegation itself, and the delegated child now waits on its own
      // approval. Hand the turn to the delegation wait instead of reporting a result.
      this.pendingDelegationTurn = {
        kind: 'delegation',
        turnId: pending.turnId,
        waiting: [{ call: pending.call, children: result.suspension.children }],
        remainingCalls: pending.remainingCalls,
        assistantText: pending.assistantText,
        toolCallsUsed: pending.toolCallsUsed,
        context: pending.context,
        ...(pending.queuedSuspensions?.length
          ? { waiting: [...pending.queuedSuspensions, { call: pending.call, children: result.suspension.children }] }
          : {}),
      };
      yield {
        type: 'tool-suspended',
        call: pending.call,
        suspension: { children: result.suspension.children },
      };
      return;
    }
    if (result.status === 'approval-denied') {
      const reason = 'The user denied this tool invocation.';
      this.modelHistory.push({
        role: 'tool',
        content: reason,
        toolCallId: pending.call.id,
        toolName: pending.call.name,
      });
      yield { type: 'tool-denied', call: pending.call, reason };
    } else if (result.status === 'failed') {
      this.modelHistory.push({
        role: 'tool',
        content: `Tool execution failed: ${result.reason}`,
        toolCallId: pending.call.id,
        toolName: pending.call.name,
      });
      yield { type: 'tool-failed', call: pending.call, reason: result.reason };
    } else {
      this.modelHistory.push({
        role: 'tool',
        content: toolOutputContent(result.output),
        toolCallId: pending.call.id,
        toolName: pending.call.name,
      });
      yield { type: 'tool-complete', call: pending.call, output: result.output };
    }

    // Other calls from the same parallel batch may also be waiting on approval. Surface the next
    // one now rather than resuming the model — one approval prompt at a time, in request order.
    const [next, ...rest] = pending.queuedApprovals ?? [];
    if (next) {
      this.pendingToolTurn = {
        kind: 'tool-approval',
        turnId: pending.turnId,
        call: next.call,
        approval: next.approval,
        remainingCalls: pending.remainingCalls,
        queuedApprovals: rest,
        queuedSuspensions: pending.queuedSuspensions,
        assistantText: pending.assistantText,
        toolCallsUsed: pending.toolCallsUsed,
        context: pending.context,
      };
      yield { type: 'tool-approval-required', call: next.call, approval: next.approval };
      return;
    }

    // A call in the same batch may have delegated to a child that is still waiting for approval. That
    // wait outlives this turn's own approval, so promote it instead of resuming the model too early.
    const queuedSuspensions = pending.queuedSuspensions ?? [];
    if (queuedSuspensions.length) {
      this.pendingDelegationTurn = {
        kind: 'delegation',
        turnId: pending.turnId,
        waiting: queuedSuspensions,
        remainingCalls: pending.remainingCalls,
        assistantText: pending.assistantText,
        toolCallsUsed: pending.toolCallsUsed,
        context: pending.context,
      };
      yield {
        type: 'tool-suspended',
        call: queuedSuspensions[0].call,
        suspension: { children: queuedSuspensions.flatMap((entry) => entry.children) },
      };
      return;
    }

    yield* this.continueTurn(
      pending.assistantText,
      pending.remainingCalls,
      pending.turnId,
      pending.context ?? [],
      signal,
      pending.toolCallsUsed ?? 0,
    );
  }

  /**
   * Continues a turn that stopped because a delegated child was waiting for approval. The suspended
   * calls are re-invoked with the children they handed work to; a tool whose descendant chain is now
   * settled returns its real outcome, and a tool whose descendant is still waiting reports the
   * suspension again. Re-invocation — never fresh delegation — is what keeps the chain to exactly one
   * execution per child, across restarts and across whichever surface resolved the approval.
   */
  async *resumeDelegation(signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const pending = this.pendingDelegationTurn;
    if (!pending) throw new Error('This agent turn is not waiting for a delegated sub-agent.');
    if (this.pendingToolTurn) throw new Error('Resolve the pending tool approval first.');
    if (!this.tools) throw new Error('This agent session has no tool runtime.');

    const stillWaiting: { call: ModelToolCall; children: DelegatedChildRef[] }[] = [];
    const paused: { call: ModelToolCall; approval: AgentToolApproval }[] = [];
    for (const entry of pending.waiting) {
      const result = await this.tools.execute(
        this.agent,
        entry.call.name,
        entry.call.input,
        {
          turnId: pending.turnId,
          toolCallId: entry.call.id,
          resume: { children: entry.children },
        },
        signal,
        this.delegation,
      );
      if (result.status === 'suspended') {
        stillWaiting.push({ call: entry.call, children: result.suspension.children });
        continue;
      }
      if (result.status === 'approval-required') {
        // Re-evaluation reached a fresh approval (the delegation was re-authorised). Surface it
        // through the normal single-file approval path rather than inventing a second one.
        paused.push({ call: entry.call, approval: result.approval });
        continue;
      }
      if (result.status === 'denied') {
        this.modelHistory.push({
          role: 'tool',
          content: `Tool access was denied: ${result.reason}`,
          toolCallId: entry.call.id,
          toolName: entry.call.name,
        });
        yield { type: 'tool-denied', call: entry.call, reason: result.reason };
        continue;
      }
      if (result.status === 'failed') {
        this.modelHistory.push({
          role: 'tool',
          content: `Tool execution failed: ${result.reason}`,
          toolCallId: entry.call.id,
          toolName: entry.call.name,
        });
        yield { type: 'tool-failed', call: entry.call, reason: result.reason };
        continue;
      }
      this.modelHistory.push({
        role: 'tool',
        content: toolOutputContent(result.output),
        toolCallId: entry.call.id,
        toolName: entry.call.name,
      });
      yield { type: 'tool-complete', call: entry.call, output: result.output };
    }

    if (paused.length) {
      const [first, ...rest] = paused;
      this.pendingDelegationTurn = null;
      this.pendingToolTurn = {
        kind: 'tool-approval',
        turnId: pending.turnId,
        call: first.call,
        approval: first.approval,
        remainingCalls: pending.remainingCalls,
        assistantText: pending.assistantText,
        toolCallsUsed: pending.toolCallsUsed,
        context: pending.context,
        ...(stillWaiting.length ? { queuedSuspensions: stillWaiting } : {}),
        ...(rest.length
          ? { queuedApprovals: rest.map((entry) => ({ call: entry.call, approval: entry.approval })) }
          : {}),
      };
      yield { type: 'tool-approval-required', call: first.call, approval: first.approval };
      return;
    }

    if (stillWaiting.length) {
      this.pendingDelegationTurn = { ...pending, waiting: stillWaiting };
      yield {
        type: 'tool-suspended',
        call: stillWaiting[0].call,
        suspension: { children: stillWaiting.flatMap((entry) => entry.children) },
      };
      return;
    }

    this.pendingDelegationTurn = null;
    yield* this.continueTurn(
      pending.assistantText,
      pending.remainingCalls,
      pending.turnId,
      pending.context ?? [],
      signal,
      pending.toolCallsUsed ?? 0,
    );
  }

  private async *continueTurn(
    initialAssistantText: string,
    queuedCalls: ModelToolCall[],
    turnId: string,
    context: ModelMessage[],
    signal?: AbortSignal,
    toolCallsUsed = 0,
  ): AsyncGenerator<AgentEvent> {
    let assistantText = initialAssistantText;
    let calls = queuedCalls;
    let toolRounds = toolCallsUsed;
    let turnUsage: TokenUsage | undefined;

    while (true) {
      if (calls.length === 0) {
        const streamedCalls: ModelToolCall[] = [];
        let roundAssistantText = '';
        let roundReasoningContent = '';
        const forceFinalResponse = toolRounds >= maxToolRounds;
        if (forceFinalResponse) {
          this.modelHistory.push({
            role: 'user',
            content:
              'IRIS has reached the tool-call safety limit for this turn. Do not request more tools. Summarize the real tool results already received and clearly state any checks that could not be completed.',
          });
        }
        // The configured reasoning effort buys deliberation for the turn's first decision — what
        // to do at all. A provider with `reasoningContinuity` (native Anthropic's interleaved
        // thinking, or OpenRouter's `reasoning_details`) carries that reasoning forward round to
        // round instead of resetting it, so every round keeps the full configured effort: the
        // model builds on what it already thought through rather than re-deriving it from scratch,
        // which is what made every round pay the full cost for the same conclusion. Providers
        // without that mechanism have no way to carry reasoning forward, so round zero gets the
        // configured effort and later rounds drop to a light "low" budget instead of paying full
        // price blind to what earlier rounds already decided.
        const interleavesThinking = Boolean(this.provider.definition.reasoningContinuity);
        const roundReasoningEffort: typeof this.agent.reasoningEffort =
          interleavesThinking ||
          toolRounds === 0 ||
          !this.agent.reasoningEffort ||
          this.agent.reasoningEffort === 'none'
            ? this.agent.reasoningEffort
            : 'low';
        let roundThinkingBlocks: ModelThinkingBlock[] | undefined;
        let roundReasoningDetails: unknown[] | undefined;
        for await (const chunk of this.provider.stream(
          {
            model: this.model,
            messages: [...copyModelHistory(context), ...copyModelHistory(this.modelHistory)],
            tools: forceFinalResponse ? undefined : this.tools?.definitions(this.agent),
            reasoningEffort: roundReasoningEffort,
          },
          signal,
        )) {
          // The reasoning trace is shown live so the user can see the turn is progressing, but it
          // is scratch space, not a chat message: it never joins assistantText or the visible
          // conversation. `thinkingBlocks`/`reasoningDetails` are a separate thing — wire-format
          // state round-tripped to the provider so reasoning continuity keeps working, not display.
          if (chunk.reasoningText) {
            roundReasoningContent += chunk.reasoningText;
            yield { type: 'reasoning-chunk', text: chunk.reasoningText };
          }
          assistantText += chunk.text;
          roundAssistantText += chunk.text;
          if (chunk.text) yield { type: 'assistant-chunk', text: chunk.text };
          if (chunk.toolCalls?.length) streamedCalls.push(...chunk.toolCalls);
          if (chunk.thinkingBlocks?.length) roundThinkingBlocks = chunk.thinkingBlocks;
          if (chunk.reasoningDetails?.length) roundReasoningDetails = chunk.reasoningDetails;
          if (chunk.usage) turnUsage = addUsage(turnUsage, chunk.usage);
        }
        calls = streamedCalls;
        if (calls.length === 0) {
          const assistantMessage = {
            role: 'assistant' as const,
            content: assistantText,
            turnId,
            ...(forceFinalResponse ? { stopReason: 'tool-limit' as const } : {}),
          };
          this.history.push(assistantMessage);
          this.modelHistory.push(toModelConversationMessage(assistantMessage));
          yield {
            type: 'assistant-complete',
            message: assistantMessage,
            ...(turnUsage ? { usage: turnUsage } : {}),
          };
          return;
        }
        if (!this.tools) throw new Error('The model requested a tool, but no tool runtime exists.');
        this.modelHistory.push({
          role: 'assistant',
          content: roundAssistantText,
          toolCalls: calls,
          ...(roundReasoningContent ? { reasoningContent: roundReasoningContent } : {}),
          ...(roundThinkingBlocks?.length ? { thinkingBlocks: roundThinkingBlocks } : {}),
          ...(roundReasoningDetails?.length ? { reasoningDetails: roundReasoningDetails } : {}),
        });
      }

      if (toolRounds >= maxToolRounds) {
        // Discard the provider's unexecuted final tool request; it must never be replayed.
        if (this.modelHistory.at(-1)?.toolCalls?.length) this.modelHistory.pop();
        const notice = `\n\nIRIS stopped this turn after ${toolRounds} tool calls. The tool results received so far are preserved; please narrow the request or run the check in smaller parts.`;
        assistantText += notice;
        this.history.push({
          role: 'assistant',
          content: assistantText,
          turnId,
          stopReason: 'tool-limit',
        });
        this.modelHistory.push({
          role: 'assistant',
          content: assistantText,
        });
        yield { type: 'assistant-chunk', text: notice };
        yield {
          type: 'assistant-complete',
          message: { role: 'assistant', content: assistantText, turnId, stopReason: 'tool-limit' },
          ...(turnUsage ? { usage: turnUsage } : {}),
        };
        return;
      }
      // A model round rarely stops exactly at the budget; a whole round is always let through
      // rather than executing it partway, so `toolRounds` can end up a little past `maxToolRounds`
      // — the check above catches that before the *next* round starts.
      toolRounds += calls.length;

      // Calls the model requested together in one round are independent by construction (that is
      // what makes them safe to batch instead of issuing one at a time across separate rounds), so
      // run them concurrently. `execute` never has a side effect for a call that turns out to need
      // approval — it only records the approval request — so it is safe to run unconditionally.
      // When the agent defines a concurrency cap, an async semaphore gates how many calls actually
      // start at once; the rest queue behind earlier ones. This prevents host overload or provider
      // rate limits when a model requests many parallel tool calls in a single round.
      for (const call of calls) yield { type: 'tool-call', call };
      const concurrencyLimit = this.agent.maxConcurrentTools ?? Infinity;
      const settled = await runWithConcurrency(calls, concurrencyLimit, async (call) => ({
        call,
        result: await this.tools!.execute(
          this.agent,
          call.name,
          call.input,
          { turnId, toolCallId: call.id },
          signal,
          this.delegation,
        ),
      }));

      let paused: { call: ModelToolCall; approval: AgentToolApproval } | undefined;
      const queuedApprovals: { call: ModelToolCall; approval: AgentToolApproval }[] = [];
      const suspendedCalls: { call: ModelToolCall; children: DelegatedChildRef[] }[] = [];
      for (const { call, result } of settled) {
        if (result.status === 'approval-required') {
          if (paused) queuedApprovals.push({ call, approval: result.approval });
          else paused = { call, approval: result.approval };
          continue;
        }
        if (result.status === 'suspended') {
          // The call handed its work to a delegated child that is waiting for approval. There is no
          // result yet, so the turn stops here instead of letting the model treat a pending chain as
          // finished work.
          suspendedCalls.push({ call, children: result.suspension.children });
          continue;
        }
        if (result.status === 'denied') {
          this.modelHistory.push({
            role: 'tool',
            content: `Tool access was denied: ${result.reason}`,
            toolCallId: call.id,
            toolName: call.name,
          });
          yield { type: 'tool-denied', call, reason: result.reason };
          continue;
        }
        if (result.status === 'failed') {
          this.modelHistory.push({
            role: 'tool',
            content: `Tool execution failed: ${result.reason}`,
            toolCallId: call.id,
            toolName: call.name,
          });
          yield { type: 'tool-failed', call, reason: result.reason };
          continue;
        }
        this.modelHistory.push({
          role: 'tool',
          content: toolOutputContent(result.output),
          toolCallId: call.id,
          toolName: call.name,
        });
        yield { type: 'tool-complete', call, output: result.output };
      }

      // If more than one call in the batch needs approval, only the first is surfaced now; the
      // rest wait in `queuedApprovals` and are promoted one at a time as each prior one resolves
      // (see `resolveApproval`) — approvals are single-file even though execution was not.
      if (paused) {
        this.pendingToolTurn = {
          kind: 'tool-approval',
          turnId,
          call: paused.call,
          approval: paused.approval,
          remainingCalls: [],
          queuedApprovals,
          assistantText,
          toolCallsUsed: toolRounds,
          context: copyModelHistory(context),
          ...(suspendedCalls.length ? { queuedSuspensions: suspendedCalls } : {}),
        };
        yield { type: 'tool-approval-required', call: paused.call, approval: paused.approval };
        return;
      }
      if (suspendedCalls.length) {
        this.pendingDelegationTurn = {
          kind: 'delegation',
          turnId,
          waiting: suspendedCalls,
          remainingCalls: [],
          assistantText,
          toolCallsUsed: toolRounds,
          context: copyModelHistory(context),
        };
        yield {
          type: 'tool-suspended',
          call: suspendedCalls[0].call,
          suspension: { children: suspendedCalls.flatMap((entry) => entry.children) },
        };
        return;
      }
      calls = [];
    }
  }
}

function copyImages(images: ModelImage[] | undefined): ModelImage[] | undefined {
  return images?.map((image) => ({ ...image }));
}

function copyConversation(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.map((message) => ({
    ...message,
    images: copyImages(message.images),
    handoff: message.handoff
      ? {
          ...message.handoff,
          from: { ...message.handoff.from },
          to: { ...message.handoff.to },
        }
      : undefined,
  }));
}

function isModelConversationMessage(
  message: ConversationMessage,
): message is ConversationMessage & { role: 'user' | 'assistant' } {
  return message.role === 'user' || message.role === 'assistant';
}

function toModelConversationMessage(
  message: ConversationMessage & { role: 'user' | 'assistant' },
): ModelMessage {
  return { role: message.role, content: message.content, images: copyImages(message.images) };
}

function copyToolCall(call: ModelToolCall): ModelToolCall {
  return { ...call };
}

function withoutThinkingBlocks(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) =>
    message.thinkingBlocks || message.reasoningDetails
      ? { ...message, thinkingBlocks: undefined, reasoningDetails: undefined }
      : message,
  );
}

function copyModelHistory(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map(copyToolCall),
    thinkingBlocks: message.thinkingBlocks?.map((block) => ({ ...block })),
    reasoningDetails: message.reasoningDetails?.map((detail) => detail),
    images: copyImages(message.images),
  }));
}

function copyPendingTurn(pending: PendingAgentToolTurn): PendingAgentToolTurn {
  return {
    ...pending,
    turnId: pending.turnId || `legacy-turn:${pending.approval.id}`,
    call: copyToolCall(pending.call),
    approval: { ...pending.approval },
    remainingCalls: pending.remainingCalls.map(copyToolCall),
    queuedApprovals: pending.queuedApprovals?.map((entry) => ({
      call: copyToolCall(entry.call),
      approval: { ...entry.approval },
    })),
    queuedSuspensions: pending.queuedSuspensions?.map((entry) => ({
      call: copyToolCall(entry.call),
      children: entry.children.map((child) => ({ ...child })),
    })),
    context: copyModelHistory(pending.context ?? []),
  };
}

function copyPendingDelegationTurn(
  pending: PendingAgentDelegationTurn,
): PendingAgentDelegationTurn {
  return {
    ...pending,
    waiting: pending.waiting.map((entry) => ({
      call: copyToolCall(entry.call),
      children: entry.children.map((child) => ({ ...child })),
    })),
    remainingCalls: pending.remainingCalls.map(copyToolCall),
    context: copyModelHistory(pending.context ?? []),
  };
}

function createTurnId(): string {
  return `turn-${crypto.randomUUID()}`;
}

/** Which subsystem is exclusively executing an agent. Purely descriptive; ownership is `ownerId`. */
export type AgentExecutionOwnerKind = 'interactive' | 'scheduled' | 'project';

/**
 * The single authoritative record that one owner is exclusively executing one agent.
 *
 * `ownerId` is the durable identity of the work that holds the agent: a project queue entry, a
 * project worker run, or a chat/scheduled turn. Two different owners can never hold the same agent.
 */
export interface AgentExecutionReservation {
  agentId: string;
  ownerKind: AgentExecutionOwnerKind;
  ownerId: string;
  acquiredAt: string;
  /** The worker run that inherited this reservation, when there is one. */
  runId?: string;
}

export interface AgentExecutionReservationRequest {
  agentId: string;
  ownerId: string;
  ownerKind?: AgentExecutionOwnerKind;
  acquiredAt: string;
  runId?: string;
}

/**
 * IRIS Phase 2G §6–§8, §10 — the shared, cross-runtime exclusive-execution reservation.
 *
 * Scheduled runtime, project runtime and interactive chat each used to keep their own private
 * `Set<string>` of busy agents, so a scheduled turn and a project worker could genuinely execute the
 * same agent against the same workspace at the same time. This registry is the one authority they
 * all consult.
 *
 * `reserve` is a synchronous check-and-set over one map, which is atomic within the application's
 * single-threaded concurrency model. That is exactly what closes the check-then-reserve TOCTOU: a
 * caller reserves *before* it awaits provider or keyring preparation, so the loser never prepares.
 *
 * The registry holds no I/O and no timers; every reservation is released by the owner that took it,
 * or reconciled away once the owner is provably no longer active.
 */
export class AgentExecutionLeaseRegistry {
  private readonly reservations = new Map<string, AgentExecutionReservation>();

  /** Atomically reserves an agent for `ownerId`. Re-reserving by the same owner is idempotent. */
  reserve(request: AgentExecutionReservationRequest): boolean {
    const existing = this.reservations.get(request.agentId);
    if (existing) {
      if (existing.ownerId !== request.ownerId) return false;
      const refreshed: AgentExecutionReservation = {
        ...existing,
        acquiredAt: request.acquiredAt,
        ...(request.runId ? { runId: request.runId } : {}),
      };
      this.reservations.set(request.agentId, refreshed);
      return true;
    }
    this.reservations.set(request.agentId, {
      agentId: request.agentId,
      ownerKind: request.ownerKind ?? 'interactive',
      ownerId: request.ownerId,
      acquiredAt: request.acquiredAt,
      ...(request.runId ? { runId: request.runId } : {}),
    });
    return true;
  }

  /** Releases only when `ownerId` still owns the agent; a stale writer can never free live work. */
  release(agentId: string, ownerId: string): boolean {
    const existing = this.reservations.get(agentId);
    if (!existing || existing.ownerId !== ownerId) return false;
    this.reservations.delete(agentId);
    return true;
  }

  /**
   * Hands ownership from one owner to another atomically. Used when a queue entry that reserved an
   * agent transfers ownership to the worker run it actually created.
   */
  transfer(
    agentId: string,
    fromOwnerId: string,
    toOwnerId: string,
    at: string,
    runId?: string,
  ): boolean {
    const existing = this.reservations.get(agentId);
    if (!existing || existing.ownerId !== fromOwnerId) return false;
    if (fromOwnerId === toOwnerId) {
      this.reservations.set(agentId, { ...existing, acquiredAt: at, ...(runId ? { runId } : {}) });
      return true;
    }
    this.reservations.set(agentId, {
      ...existing,
      ownerId: toOwnerId,
      acquiredAt: at,
      ...(runId ? { runId } : {}),
    });
    return true;
  }

  /** The current owner of the agent, or `undefined` when it is free. */
  holder(agentId: string): AgentExecutionReservation | undefined {
    const existing = this.reservations.get(agentId);
    return existing ? { ...existing } : undefined;
  }

  list(): AgentExecutionReservation[] {
    return [...this.reservations.values()].map((reservation) => ({ ...reservation }));
  }

  /**
   * Drops reservations whose owner is provably no longer active, and only those. A caller that
   * cannot prove an owner is gone must report it as active: fabricating free state while real work
   * is still running is the failure mode this registry exists to prevent.
   */
  reconcile(isOwnerActive: (reservation: AgentExecutionReservation) => boolean): AgentExecutionReservation[] {
    const dropped: AgentExecutionReservation[] = [];
    for (const reservation of [...this.reservations.values()]) {
      if (isOwnerActive(reservation)) continue;
      this.reservations.delete(reservation.agentId);
      dropped.push({ ...reservation });
    }
    return dropped;
  }
}

/**
 * How one `AgentRuntimeCoordinator` participates in the shared exclusive-execution reservation.
 *
 * `reserveTurns: false` marks a coordinator whose turns run *inside* work that already owns the
 * agent (a project queue entry or worker run). That work holds the reservation; re-acquiring it here
 * would conflict with its own owner.
 */
export interface AgentExecutionCoordination {
  leases: AgentExecutionLeaseRegistry;
  ownerKind: AgentExecutionOwnerKind;
  ownerId: (agentId: string) => string;
  reserveTurns?: boolean;
  /**
   * IRIS Phase 2H.1 — the cross-process authority behind the process-local registry.
   * When present, `begin` consults it before every reservation: a same-agent turn in
   * another live IRIS process is refused with a truthful busy error. The in-process Map
   * stays the fast path; this port is what makes exclusivity hold across processes.
   */
  crossProcess?: {
    /** Acquires the agent lease across processes; `false` means another process owns it. */
    acquire(agentId: string, ownerId: string, ownerKind: AgentExecutionOwnerKind, at: string, runId?: string): Promise<boolean>;
    /** Releases a lease this process owns; no-op when another owner holds it. */
    release(agentId: string, ownerId: string): Promise<void>;
    /** Holder metadata for truthful busy reporting, when the authority exposes it. */
    inspect?(agentId: string): Promise<{ ownerId?: string } | undefined>;
    /**
     * Phase 2H.2 — tri-state holder reading (owner, foreign, alive/dead/unknown) for truthful
     * orphan reconciliation. Optional; authorities without it are treated as unknown holders.
     */
    holderStatus?(agentId: string): Promise<CrossProcessHolderStatus | undefined>;
  };
}

export class AgentRuntimeCoordinator {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly runningAgents = new Set<string>();
  private readonly reconciledCortexAgents = new Set<string>();
  /** The reservation owner id this coordinator holds per agent, so only it can release it. */
  private readonly executionOwners = new Map<string, string>();

  constructor(
    private readonly agents: AgentRepository,
    private readonly conversations: ConversationRepository,
    private readonly suspendedTurns: SuspendedAgentTurnRepository,
    private readonly providers: AgentProviderResolver,
    private readonly tools: AgentToolRuntime,
    private readonly onStateChange: (agentId: string) => void = () => undefined,
    private readonly context?: ContextPackBuilder,
    private readonly contextPacks?: ContextPackRepository,
    private readonly cortexTurns?: CortexTurnRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly systemContext?: AgentSystemContextBuilder,
    private readonly normalizeAgent?: (agent: AgentDefinition) => Promise<AgentDefinition>,
    private readonly turnSteps?: CortexTurnStepRepository,
    private readonly onActivity?: (activity: AgentActivity) => void,
    private readonly execution?: AgentExecutionCoordination,
  ) {}

  checkpointForAgent(agentId: string): AgentCheckpoint {
    const session = this.sessions.get(agentId);
    if (!session) throw new Error('The worker session is unavailable for checkpointing.');
    return session.checkpoint();
  }

  async restoreCheckpoint(agentId: string, checkpoint: AgentCheckpoint): Promise<void> {
    if (this.runningAgents.has(agentId) || (await this.suspendedTurns.getByAgentId(agentId)))
      throw new Error(
        'Stop the active worker or resolve its approval before restoring a checkpoint.',
      );
    if (!validateAgentCheckpoint(checkpoint) || checkpoint.agentId !== agentId)
      throw new Error('The checkpoint does not match this agent.');
    const agent = await this.requireAgent(agentId);
    const resolved = await this.providers.resolve(agent, checkpoint);
    if (resolved.model !== checkpoint.model)
      throw new Error('The checkpoint requires its original model.');
    const session = AgentSession.fromCheckpoint(agent, resolved.provider, checkpoint, this.tools);
    await this.conversations.save(agentId, checkpoint.conversation);
    this.sessions.set(agentId, session);
  }

  async suspendedForAgent(agentId: string): Promise<SuspendedAgentTurn | null> {
    return this.suspendedTurns.getByAgentId(agentId);
  }

  get runningAgentIds(): readonly string[] {
    return [...this.runningAgents];
  }

  /**
   * The shared cross-runtime exclusive-execution reservation for an agent, or `undefined` when the
   * agent is free. A caller outside this coordinator (another runtime, a queue dispatcher) must use
   * this rather than {@link runningAgentIds}, which only knows this coordinator's own turns.
   */
  executionReservation(agentId: string): AgentExecutionReservation | undefined {
    return this.execution?.leases.holder(agentId);
  }

  /**
   * Re-establishes ownership after a restart. Every persisted suspended turn still owns its agent
   * until it is resolved, so a project or scheduled launch must not treat that agent as free.
   * It never steals an agent that another owner already holds.
   */
  async reconcileExecutionReservations(): Promise<number> {
    const execution = this.execution;
    if (!execution || execution.reserveTurns === false) return 0;
    let restored = 0;
    for (const suspended of await this.suspendedTurns.list()) {
      const ownerId = execution.ownerId(suspended.agentId);
      const reserved = execution.leases.reserve({
        agentId: suspended.agentId,
        ownerId,
        ownerKind: execution.ownerKind,
        acquiredAt: this.timestamp(),
      });
      if (!reserved) continue;
      this.executionOwners.set(suspended.agentId, ownerId);
      // Phase 2H.1 §14/§15 — a suspended turn retains exclusive ownership across restarts, so
      // the cross-process lease is re-established here too: another live process must not
      // execute the agent while its approval is still pending. Retaining is the safe policy:
      // a resumed turn continues the same conversation and workspace work.
      if (execution.crossProcess)
        await execution.crossProcess
          .acquire(suspended.agentId, ownerId, execution.ownerKind, this.timestamp())
          .catch(() => undefined);
      restored += 1;
    }
    return restored;
  }

  async suspendedForApproval(approvalId: string): Promise<SuspendedAgentTurn | null> {
    return this.suspendedTurns.getByApprovalId(approvalId);
  }

  /**
   * Phase 2H.2 §14–§17 — conservative reconciliation of persisted suspended turns whose
   * durable context has drifted (missing/terminal approvals, foreign or dead lease holders).
   *
   * Classifications (never fabricated):
   * - `recoverable`: enough durable state exists to keep waiting truthfully — the turn stays
   *   suspended and keeps ownership (this is also the "defer" answer for a live foreign lease).
   * - `terminal-known`: the approval is durably terminal and no other surface will resume this
   *   turn; the stranded suspension is removed so the agent cannot stay phantom-busy. The
   *   cross-process lease is released only when this runtime provably holds it (release is a
   *   no-op otherwise), and never when the holder is merely unknown.
   * - `unknown`: the approval record is missing, or a foreign lease's liveness cannot be
   *   established — fail closed: the turn remains suspended, nothing is deleted, and the
   *   detail names what needs attention.
   *
   * Reconciliation is read-only toward leases it does not own: it never acquires, never
   * releases, and never mutates a foreign holder's record.
   */
  async reconcileOrphanSuspensions(approvals: OrphanApprovalReader): Promise<OrphanReconciliationResult[]> {
    const results: OrphanReconciliationResult[] = [];
    for (const suspended of await this.suspendedTurns.list()) {
      if (suspended.pending.kind !== 'tool-approval') {
        // Delegation turns are resumed through their children's approvals; classifying them
        // against a single approval would be a guess. Leave them for the approval-driven path.
        results.push({
          turnId: suspended.pending.turnId,
          agentId: suspended.agentId,
          outcome: 'recoverable',
          outcomeDetail: 'The suspended turn is waiting on delegated child work, not a lost approval.',
        });
        continue;
      }
      const approvalId = suspended.pending.approval.id;
      let approval: { status: string } | null;
      try {
        approval = await approvals.get(approvalId);
      } catch (error) {
        results.push({
          turnId: suspended.pending.turnId,
          agentId: suspended.agentId,
          outcome: 'unknown',
          outcomeDetail: `The durable approval record for ${approvalId} could not be read (${error instanceof Error ? error.message : String(error)}); the suspended turn needs attention.`,
        });
        continue;
      }
      if (approval === null) {
        results.push({
          turnId: suspended.pending.turnId,
          agentId: suspended.agentId,
          outcome: 'unknown',
          outcomeDetail: `The durable approval record for ${approvalId} is missing; the suspended turn needs attention and was kept.`,
        });
        continue;
      }
      if (approval.status === 'pending' || approval.status === 'requested') {
        results.push({
          turnId: suspended.pending.turnId,
          agentId: suspended.agentId,
          outcome: 'recoverable',
          outcomeDetail: `Approval ${approvalId} is durably pending; the suspended turn keeps waiting.`,
        });
        continue;
      }
      // The approval is durably terminal. Only this runtime's own lease may be released, and
      // only when the authority can prove the holder state — a live or unknown foreign lease
      // is never touched (Phase 2H.1/2H.3).
      const holder = await this.execution?.crossProcess?.holderStatus?.(suspended.agentId);
      if (holder && holder.foreign && holder.liveness !== 'dead') {
        results.push({
          turnId: suspended.pending.turnId,
          agentId: suspended.agentId,
          outcome: 'unknown',
          outcomeDetail: `A ${holder.liveness} foreign process still holds the agent lease; reconciliation deferred — the suspended turn was kept.`,
        });
        continue;
      }
      await this.cancelSuspended(suspended.agentId);
      results.push({
        turnId: suspended.pending.turnId,
        agentId: suspended.agentId,
        outcome: 'terminal-known',
        outcomeDetail: `Approval ${approvalId} is durably ${approval.status}; the stranded suspension was completed without resuming the agent.`,
      });
    }
    return results;
  }

  async cortexTurnsForAgent(agentId: string): Promise<CortexTurnRecord[]> {
    if (!this.cortexTurns) return [];
    if (!this.reconciledCortexAgents.has(agentId)) {
      this.reconciledCortexAgents.add(agentId);
      const [records, suspended] = await Promise.all([
        this.cortexTurns.list(agentId),
        this.suspendedTurns.getByAgentId(agentId),
      ]);
      let changed = false;
      for (const record of records) {
        if (record.status !== 'running') continue;
        const blocking = suspended ? suspendedApprovals(suspended)[0] : undefined;
        const recovered =
          suspended && blocking && suspended.pending.turnId === record.turnId
            ? transitionCortexTurn(
                record,
                {
                  status: 'suspended',
                  suspension: {
                    approvalId: blocking.approvalId,
                    toolId: blocking.toolId ?? '',
                    toolName: blocking.toolName ?? '',
                    reason:
                      suspended.pending.kind === 'tool-approval'
                        ? suspended.pending.approval.reason
                        : 'A delegated sub-agent is waiting for approval.',
                  },
                },
                this.timestamp(),
              )
            : transitionCortexTurn(
                record,
                {
                  status: 'failed',
                  message: 'IRIS stopped before this turn reached a final state.',
                },
                this.timestamp(),
              );
        await this.cortexTurns.save(recovered);
        changed = true;
      }
      if (changed) this.onStateChange(agentId);
    }
    return this.cortexTurns.list(agentId);
  }

  async *send(
    agentId: string,
    text: string,
    signal?: AbortSignal,
    images: ModelImage[] = [],
  ): AsyncGenerator<AgentEvent> {
    const prompt = text.trim();
    if (!prompt && !images.length) return;
    await this.begin(agentId);
    const lifecycle: { record: CortexTurnRecord | null } = { record: null };
    try {
      if (await this.suspendedTurns.getByAgentId(agentId)) {
        throw new Error('Resolve the pending tool approval before sending another message.');
      }
      const storedAgent = await this.requireAgent(agentId);
      const agent = this.normalizeAgent ? await this.normalizeAgent(storedAgent) : storedAgent;
      if (agent !== storedAgent) this.sessions.delete(agentId);
      let session = this.sessions.get(agentId);
      if (!session) {
        const resolved = await this.providers.resolve(agent);
        const history = await this.conversationWithModelHandoff(
          agentId,
          await this.conversations.list(agentId),
          { providerId: resolved.provider.definition.id, model: resolved.model },
        );
        session = new AgentSession(agent, resolved.provider, resolved.model, history, this.tools);
        this.sessions.set(agentId, session);
      }
      const context: ModelMessage[] = [];
      if (agent.persona?.trim()) {
        context.push({
          role: 'system',
          content: [
            'The user gave this agent the following persona. Use it as identity and communication guidance, not as tool authority:',
            agent.persona.trim(),
          ].join('\n\n'),
        });
      }
      const turnId = createTurnId();
      const identity = session.runtimeIdentity();
      await this.saveCortexTurn(
        lifecycle,
        startCortexTurn({
          turnId,
          agentId: agent.id,
          providerId: identity.providerId,
          model: identity.model,
          startedAt: this.timestamp(),
        }),
      );
      if (this.systemContext) {
        const systemMessages = await this.systemContext.build(agent);
        context.push(
          ...systemMessages
            .map((content) => content.trim())
            .filter(Boolean)
            .map((content) => ({ role: 'system' as const, content })),
        );
      }
      if (this.context) {
        const pack = await this.context.build(agent, { prompt, turnId });
        if (pack.agentId !== agent.id || pack.prompt !== prompt || pack.turnId !== turnId) {
          throw new Error('Cortex returned a context pack for a different agent turn.');
        }
        await this.contextPacks?.save(pack);
        await this.saveCortexTurn(
          lifecycle,
          attachContextPack(lifecycle.record!, pack.id, this.timestamp()),
        );
        this.onStateChange(agent.id);
        yield { type: 'context-pack-ready', pack };
        const rendered = renderContextPack(pack);
        if (rendered) context.push({ role: 'system', content: rendered });
      }
      yield* this.persistEvents(
        session.send(prompt, signal, context, turnId, images),
        session,
        lifecycle,
      );
    } catch (error) {
      await this.failCortexTurn(lifecycle, error);
      throw error;
    } finally {
      this.runningAgents.delete(agentId);
      await this.releaseExecutionIfIdle(agentId);
      this.onStateChange(agentId);
    }
  }

  private async conversationWithModelHandoff(
    agentId: string,
    history: ConversationMessage[],
    target: ConversationModelIdentity,
  ): Promise<ConversationMessage[]> {
    if (!this.cortexTurns || !history.some((message) => message.role !== 'handoff')) return history;
    const previous = (await this.cortexTurns.list(agentId))[0];
    if (
      !previous ||
      (previous.providerId === target.providerId && previous.model === target.model)
    ) {
      return history;
    }
    const latestHandoff = [...history].reverse().find((message) => message.role === 'handoff');
    if (
      latestHandoff?.handoff?.to.providerId === target.providerId &&
      latestHandoff.handoff.to.model === target.model
    ) {
      return history;
    }
    const updated = [
      ...history,
      createModelHandoffMessage(
        { providerId: previous.providerId, model: previous.model },
        target,
        this.timestamp(),
      ),
    ];
    await this.conversations.save(agentId, updated);
    this.onStateChange(agentId);
    return updated;
  }

  /**
   * Resolves the approval a suspended turn owns and then walks the delegation chain upward: every
   * ancestor whose turn stopped waiting for that descendant is re-invoked with the descendant's real
   * outcome, so approving the deepest approval produces one coherent chain of events instead of
   * leaving the delegating turns stranded as "suspended" with no path forward.
   */
  async *resolveApproval(
    approvalId: string,
    decision: 'approve' | 'deny',
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const suspended = await this.suspendedTurns.getByApprovalId(approvalId);
    if (!suspended) throw new Error(`No suspended agent turn matches ${approvalId}.`);
    if (suspended.pending.kind !== 'tool-approval') {
      throw new Error(`No suspended agent turn owns the approval ${approvalId}.`);
    }
    yield* this.resumeSuspendedTurn(suspended, { approvalId, decision }, signal);

    // A turn that reached a terminal state is the outcome the turn that delegated to it was waiting
    // for. Resume that waiter with the recorded outcome, and keep walking up until nothing waits.
    let finishedAgentId: string | null = suspended.agentId;
    for (let level = 0; finishedAgentId && level <= maxDelegationResumeChain; level += 1) {
      const waiter = await this.waiterFor(finishedAgentId);
      if (!waiter) return;
      yield* this.resumeSuspendedTurn(waiter, null, signal);
      // Still suspended (on a fresh approval or a deeper delegation) means this branch is not
      // finished; there is nothing above it to resume yet.
      finishedAgentId = (await this.suspendedTurns.getByAgentId(waiter.agentId))
        ? null
        : waiter.agentId;
    }
    if (finishedAgentId) {
      throw new Error(
        `The delegation chain above ${finishedAgentId} is too deep to resume safely.`,
      );
    }
  }

  /**
   * The suspended turn that delegated to `childAgentId`, matched by the stable child identity the
   * delegation recorded — never by "the newest suspended turn for this agent".
   */
  private async waiterFor(childAgentId: string): Promise<SuspendedAgentTurn | null> {
    const turns = await this.suspendedTurns.list();
    return (
      turns.find(
        (turn) =>
          turn.pending.kind === 'delegation' &&
          turn.pending.waiting.some((entry) =>
            entry.children.some((child) => child.childAgentId === childAgentId),
          ),
      ) ?? null
    );
  }

  /**
   * Resumes one suspended turn: with an approval decision when it owns the approval, or by
   * re-evaluating the delegated calls it was waiting on. Persists every event exactly like a normal
   * turn, so a chain resume is indistinguishable from ordinary work in the transcript.
   */
  private async *resumeSuspendedTurn(
    suspended: SuspendedAgentTurn,
    resume: { approvalId: string; decision: 'approve' | 'deny' } | null,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    await this.begin(suspended.agentId);
    const lifecycle: { record: CortexTurnRecord | null } = { record: null };
    try {
      const storedRecord = await this.cortexTurns?.get(suspended.pending.turnId);
      if (storedRecord?.status === 'completed' || storedRecord?.status === 'failed') {
        throw new Error(`Cannot resume a ${storedRecord.status} Cortex turn.`);
      }
      const contextPack = (await this.contextPacks?.list(suspended.agentId))?.find(
        (pack) => pack.turnId === suspended.pending.turnId,
      );
      await this.saveCortexTurn(
        lifecycle,
        storedRecord?.status === 'suspended'
          ? transitionCortexTurn(storedRecord, { status: 'running' }, this.timestamp())
          : (storedRecord ??
              startCortexTurn({
                turnId: suspended.pending.turnId,
                agentId: suspended.agentId,
                contextPackId: contextPack?.id,
                providerId: suspended.providerId,
                model: suspended.model,
                startedAt: this.timestamp(),
              })),
      );
      const agent = await this.resolveSuspendedAgent(suspended);
      const resolved = await this.providers.resolve(agent, suspended);
      const session = AgentSession.restore(
        agent,
        resolved.provider,
        suspended,
        this.tools,
        this.delegationContextFor(suspended),
      );
      this.sessions.set(agent.id, session);
      yield* this.persistEvents(
        resume
          ? session.resolveApproval(resume.approvalId, resume.decision, signal)
          : session.resumeDelegation(signal),
        session,
        lifecycle,
        suspended.pending.turnId,
      );
    } catch (error) {
      await this.failCortexTurn(lifecycle, error);
      throw error;
    } finally {
      this.runningAgents.delete(suspended.agentId);
      await this.releaseExecutionIfIdle(suspended.agentId);
      this.onStateChange(suspended.agentId);
    }
  }

  async clearConversation(agentId: string): Promise<void> {
    if (this.runningAgents.has(agentId)) throw new Error('The agent is currently running.');
    // Clearing is also the recovery path for a persisted approval whose UI was
    // interrupted. Cancel it first so the composer cannot remain locked.
    await this.cancelSuspended(agentId);
    this.sessions.delete(agentId);
    await Promise.all([
      this.conversations.clear(agentId),
      this.contextPacks?.clear(agentId),
      this.cortexTurns?.clear(agentId),
      this.turnSteps?.clear(agentId),
    ]);
    this.onStateChange(agentId);
  }

  async cancelSuspended(agentId: string): Promise<void> {
    const suspended = await this.suspendedTurns.getByAgentId(agentId);
    if (!suspended) return;
    await this.suspendedTurns.removeByTurnId(suspended.pending.turnId);
    const record = await this.cortexTurns?.get(suspended.pending.turnId);
    if (record && record.status !== 'completed' && record.status !== 'failed') {
      await this.saveCortexTurn(
        { record: null },
        transitionCortexTurn(
          record,
          {
            status: 'failed',
            message: 'The project worker was cancelled before this turn completed.',
          },
          this.timestamp(),
        ),
      );
    }
    this.sessions.delete(agentId);
    // A cancelled suspension no longer owns the agent: release it so another runtime may proceed.
    // The owner id must be captured before `releaseExecution` clears the local mapping.
    const ownerId = this.executionOwners.get(agentId);
    this.releaseExecution(agentId);
    // Phase 2H.1 §14/§15 — the retained cross-process lease is freed with the local one.
    if (ownerId !== undefined) await this.execution?.crossProcess?.release(agentId, ownerId);
    this.onStateChange(agentId);
  }

  refreshConfiguration(agentId: string): void {
    if (this.runningAgents.has(agentId)) {
      throw new Error('The agent is currently running.');
    }
    this.sessions.delete(agentId);
    this.onStateChange(agentId);
  }

  /**
   * IRIS Phase 2G §7 — acquire the shared exclusive-execution reservation *before* any await.
   *
   * The reservation is taken synchronously, so a scheduled turn and a project worker that start at
   * the same moment can never both observe the agent as free.
   *
   * IRIS Phase 2H.1 — the process-local win is then confirmed by the cross-process authority
   * before the turn proceeds: a same-agent turn in another live IRIS process releases the local
   * reservation again and refuses this turn with the same truthful busy contract. An authority
   * that cannot be evaluated fails closed: the turn never starts on unknown lease state.
   */
  private async begin(agentId: string): Promise<void> {
    if (this.runningAgents.has(agentId)) throw new Error('This agent is already running.');
    const execution = this.execution;
    if (execution && execution.reserveTurns !== false) {
      const ownerId = execution.ownerId(agentId);
      const reserved = execution.leases.reserve({
        agentId,
        ownerId,
        ownerKind: execution.ownerKind,
        acquiredAt: this.timestamp(),
      });
      if (!reserved) {
        const holder = execution.leases.holder(agentId);
        throw new Error(
          `This agent is already executing other IRIS work (${holder?.ownerKind ?? 'active'}: ${holder?.ownerId ?? 'unknown'}). Wait for it to finish or stop it first.`,
        );
      }
      this.executionOwners.set(agentId, ownerId);
      if (execution.crossProcess) {
        let acquired: boolean;
        try {
          acquired = await execution.crossProcess.acquire(
            agentId,
            ownerId,
            execution.ownerKind,
            this.timestamp(),
          );
        } catch (error) {
          this.releaseExecution(agentId);
          throw error instanceof Error
            ? error
            : new Error('The cross-process agent lease is unavailable, so the turn was not started.');
        }
        if (!acquired) {
          this.releaseExecution(agentId);
          const holder = await execution.crossProcess.inspect?.(agentId);
          throw new Error(
            `This agent is already executing other IRIS work in another IRIS process${holder?.ownerId ? ` (${holder.ownerId})` : ''}. Wait for it to finish or stop it first.`,
          );
        }
      }
    } else if (execution?.crossProcess) {
      // Phase 2I.2 / H6 — `reserveTurns:false` means an outer project/queue owner already holds
      // the agent lease, so this coordinator must not acquire it twice. It must still refuse to
      // resume under a foreign LIVE or UNKNOWN holder: confirming the authority here protects every
      // coordinator resume surface (local, remote, scheduler, delegation), not only the workflow
      // caller. Own, proven-dead or absent holders proceed; `unknown` is never treated as dead.
      let blockingOwner: string | undefined;
      let blocking = false;
      if (execution.crossProcess.holderStatus) {
        const holder = await execution.crossProcess.holderStatus(agentId);
        if (holder?.foreign && holder.liveness !== 'dead') {
          blocking = true;
          blockingOwner = holder.ownerId;
        }
      } else {
        const holder = await execution.crossProcess.inspect?.(agentId);
        if (holder) {
          blocking = true;
          blockingOwner = holder.ownerId;
        }
      }
      if (blocking) {
        throw new Error(
          `This agent is already executing other IRIS work in another IRIS process${blockingOwner ? ` (${blockingOwner})` : ''}. Wait for it to finish or stop it first.`,
        );
      }
    }
    this.runningAgents.add(agentId);
    this.onStateChange(agentId);
  }

  /**
   * Drops this coordinator's reservation, but only when nothing still owns the agent. A pending
   * approval keeps ownership: resuming it continues the very same exclusive work, and a project or
   * scheduled launch must not be able to interleave with it.
   */
  private async releaseExecutionIfIdle(agentId: string): Promise<void> {
    if (!this.executionOwners.has(agentId)) return;
    if (await this.suspendedTurns.getByAgentId(agentId)) return;
    const ownerId = this.executionOwners.get(agentId)!;
    this.releaseExecution(agentId);
    // Phase 2H.1 — the cross-process lease must be freed with the local one, or a finished
    // turn would phantom-block the same agent in every other live IRIS process.
    await this.execution?.crossProcess?.release(agentId, ownerId);
  }

  /** Releases only the reservation this coordinator itself took; a stale writer cannot free work. */
  private releaseExecution(agentId: string): void {
    const ownerId = this.executionOwners.get(agentId);
    if (ownerId === undefined) return;
    this.executionOwners.delete(agentId);
    this.execution?.leases.release(agentId, ownerId);
  }

  private async requireAgent(agentId: string): Promise<AgentDefinition> {
    const agent = await this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    return agent;
  }

  /**
   * The agent a suspended turn belongs to. A delegated (sub-)agent is ephemeral by design and
   * deliberately absent from the agent repository, so its runtime-built definition travels with the
   * suspended turn. A stored definition that fails validation is refused rather than replaced by a
   * guess — a wrong agent here would resume the turn under the wrong authority.
   */
  private async resolveSuspendedAgent(suspended: SuspendedAgentTurn): Promise<AgentDefinition> {
    if (!suspended.delegatedAgent) return this.requireAgent(suspended.agentId);
    if (
      !validateAgentDefinition(suspended.delegatedAgent) ||
      suspended.delegatedAgent.id !== suspended.agentId
    ) {
      throw new Error(
        `The suspended delegated turn for ${suspended.agentId} carries an invalid agent definition.`,
      );
    }
    return suspended.delegatedAgent;
  }

  /**
   * Re-mints the trusted delegation context for a resumed delegated turn. Persisted state is never
   * trusted as-is: a missing or malformed chain fails closed, and a tampered chain can only restrict
   * because ancestors are combined with least privilege.
   */
  private delegationContextFor(
    suspended: SuspendedAgentTurn,
  ): DelegationPolicyContext | undefined {
    if (!suspended.delegatedAgent) return undefined;
    if (!validateDelegationChain(suspended.delegationChain)) {
      throw new Error(
        `Refusing to resume the delegated turn for ${suspended.agentId} without a valid delegation chain.`,
      );
    }
    return createDelegationContext(suspended.delegationChain);
  }

  private async *persistEvents(
    events: AsyncIterable<AgentEvent>,
    session: AgentSession,
    lifecycle: { record: CortexTurnRecord | null },
    resumedTurnId?: string,
  ): AsyncGenerator<AgentEvent> {
    for await (const event of events) {
      this.onActivity?.({
        agentId: session.agent.id,
        agentName: session.agent.name,
        turnId: lifecycle.record?.turnId,
        at: this.timestamp(),
        event,
      });
      if (event.type === 'user-message' || event.type === 'assistant-complete') {
        await this.conversations.save(session.agent.id, session.messages());
        if (event.type === 'assistant-complete' && lifecycle.record?.status === 'running') {
          await this.saveCortexTurn(
            lifecycle,
            transitionCortexTurn(
              lifecycle.record,
              { status: 'completed', ...(event.usage ? { usage: event.usage } : {}) },
              this.timestamp(),
            ),
          );
        }
        this.onStateChange(session.agent.id);
      }
      if (event.type === 'tool-call' && lifecycle.record) {
        await this.turnSteps?.save(
          startCortexTurnStep({
            turnId: lifecycle.record.turnId,
            agentId: lifecycle.record.agentId,
            toolCallId: event.call.id,
            toolName: event.call.name,
            input: event.call.input,
            startedAt: this.timestamp(),
          }),
        );
        this.onStateChange(session.agent.id);
      }
      if (
        event.type === 'tool-complete' ||
        event.type === 'tool-denied' ||
        event.type === 'tool-failed'
      ) {
        if (resumedTurnId) await this.suspendedTurns.removeByTurnId(resumedTurnId);
        if (lifecycle.record) {
          await this.updateTurnStep(
            lifecycle.record.turnId,
            event.call.id,
            event.type === 'tool-complete'
              ? { status: 'completed', output: event.output }
              : {
                  status: event.type === 'tool-denied' ? 'denied' : 'failed',
                  reason: event.reason,
                },
          );
        }
        this.onStateChange(session.agent.id);
      }
      if (event.type === 'tool-approval-required' || event.type === 'tool-suspended') {
        const suspended = session.suspendedTurn();
        if (!suspended) throw new Error('Agent paused without a resumable turn snapshot.');
        await this.suspendedTurns.save(suspended);
        const blocking = suspendedApprovals(suspended)[0];
        if (lifecycle.record?.status === 'running' && blocking) {
          await this.saveCortexTurn(
            lifecycle,
            transitionCortexTurn(
              lifecycle.record,
              {
                status: 'suspended',
                suspension: {
                  approvalId: blocking.approvalId,
                  toolId: blocking.toolId ?? '',
                  toolName: blocking.toolName ?? '',
                  reason:
                    event.type === 'tool-approval-required'
                      ? event.approval.reason
                      : 'A delegated sub-agent is waiting for approval.',
                },
              },
              this.timestamp(),
            ),
          );
        }
        if (lifecycle.record && blocking) {
          await this.updateTurnStep(lifecycle.record.turnId, event.call.id, {
            status: 'awaiting-approval',
            approvalId: blocking.approvalId,
          });
        }
        this.onStateChange(session.agent.id);
      }
      yield event;
    }
  }

  /** Best-effort trace update — a step recorded before a coordinator restart without a turn-step
   * repository configured simply has no trace entry to update, which is never a fatal condition. */
  private async updateTurnStep(
    turnId: string,
    toolCallId: string,
    transition: CortexTurnStepTransition,
  ): Promise<void> {
    if (!this.turnSteps) return;
    const steps = await this.turnSteps.list(turnId);
    const step = steps.find((candidate) => candidate.toolCallId === toolCallId);
    if (!step) return;
    if (step.status === 'completed' || step.status === 'denied' || step.status === 'failed') return;
    await this.turnSteps.save(transitionCortexTurnStep(step, transition, this.timestamp()));
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async saveCortexTurn(
    lifecycle: { record: CortexTurnRecord | null },
    record: CortexTurnRecord,
  ): Promise<void> {
    lifecycle.record = record;
    await this.cortexTurns?.save(record);
    if (this.cortexTurns) this.onStateChange(record.agentId);
  }

  private async failCortexTurn(
    lifecycle: { record: CortexTurnRecord | null },
    error: unknown,
  ): Promise<void> {
    const record = lifecycle.record;
    if (!record || record.status === 'completed' || record.status === 'failed') return;
    const message = error instanceof Error ? error.message : String(error);
    await this.saveCortexTurn(
      lifecycle,
      transitionCortexTurn(record, { status: 'failed', message }, this.timestamp()),
    );
  }
}
