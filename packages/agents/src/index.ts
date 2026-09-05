import type { AgentDefinition } from '@iris/core';

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
  save(turn: SuspendedAgentTurn): Promise<void>;
  remove(approvalId: string): Promise<void>;
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

export type AgentToolExecutionResult =
  | { status: 'completed'; output: unknown }
  | { status: 'denied'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'approval-required'; approval: AgentToolApproval };

export type AgentToolApprovalResult =
  | { status: 'completed'; output: unknown }
  | { status: 'approval-denied' }
  | { status: 'failed'; reason: string };

export interface AgentToolInvocation {
  turnId: string;
  toolCallId: string;
}

export interface AgentToolRuntime {
  definitions(agent: AgentDefinition): ModelToolDefinition[];
  execute(
    agent: AgentDefinition,
    toolName: string,
    input: unknown,
    invocation: AgentToolInvocation,
    signal?: AbortSignal,
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

export interface AgentProviderResolver {
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
  context?: ModelMessage[];
}

export interface SuspendedAgentTurn {
  version: 2;
  agentId: string;
  providerId: string;
  model: string;
  conversation: ConversationMessage[];
  modelHistory: ModelMessage[];
  pending: PendingAgentToolTurn;
}

const maxToolRounds = 16;

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

  constructor(
    readonly agent: AgentDefinition,
    private readonly provider: ModelProvider,
    private readonly model: string,
    initialHistory: ConversationMessage[] = [],
    private readonly tools?: AgentToolRuntime,
    suspendedTurn?: SuspendedAgentTurn,
    initialContext: ModelMessage[] = [],
  ) {
    if (suspendedTurn) {
      if (suspendedTurn.agentId !== agent.id) {
        throw new Error(`Suspended turn belongs to another agent: ${suspendedTurn.agentId}.`);
      }
      if (suspendedTurn.providerId !== provider.definition.id || suspendedTurn.model !== model) {
        throw new Error('Suspended turn must resume with its original provider and model.');
      }
      this.history.push(...copyConversation(suspendedTurn.conversation));
      this.modelHistory.push(...copyModelHistory(suspendedTurn.modelHistory));
      this.pendingToolTurn = copyPendingTurn(suspendedTurn.pending);
      return;
    }
    this.history.push(...copyConversation(initialHistory));
    this.modelHistory.push(...copyModelHistory(initialContext));
    this.modelHistory.push(
      ...initialHistory.filter(isModelConversationMessage).map(toModelConversationMessage),
    );
  }

  static restore(
    agent: AgentDefinition,
    provider: ModelProvider,
    suspendedTurn: SuspendedAgentTurn,
    tools: AgentToolRuntime,
  ): AgentSession {
    return new AgentSession(agent, provider, suspendedTurn.model, [], tools, suspendedTurn);
  }

  messages(): ConversationMessage[] {
    return copyConversation(this.history);
  }

  runtimeIdentity(): { providerId: string; model: string } {
    return { providerId: this.provider.definition.id, model: this.model };
  }

  suspendedTurn(): SuspendedAgentTurn | null {
    if (!this.pendingToolTurn) return null;
    return {
      version: 2,
      agentId: this.agent.id,
      providerId: this.provider.definition.id,
      model: this.model,
      conversation: copyConversation(this.history),
      modelHistory: copyModelHistory(this.modelHistory),
      pending: copyPendingTurn(this.pendingToolTurn),
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
    if (this.pendingToolTurn) {
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
        turnId: pending.turnId,
        call: next.call,
        approval: next.approval,
        remainingCalls: pending.remainingCalls,
        queuedApprovals: rest,
        assistantText: pending.assistantText,
        context: pending.context,
      };
      yield { type: 'tool-approval-required', call: next.call, approval: next.approval };
      return;
    }

    yield* this.continueTurn(
      pending.assistantText,
      pending.remainingCalls,
      pending.turnId,
      pending.context ?? [],
      signal,
    );
  }

  private async *continueTurn(
    initialAssistantText: string,
    queuedCalls: ModelToolCall[],
    turnId: string,
    context: ModelMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    let assistantText = initialAssistantText;
    let calls = queuedCalls;
    let toolRounds = 0;
    let turnUsage: TokenUsage | undefined;

    while (true) {
      if (calls.length === 0) {
        const streamedCalls: ModelToolCall[] = [];
        let roundAssistantText = '';
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
          if (chunk.reasoningText) yield { type: 'reasoning-chunk', text: chunk.reasoningText };
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
          ...(roundThinkingBlocks?.length ? { thinkingBlocks: roundThinkingBlocks } : {}),
          ...(roundReasoningDetails?.length ? { reasoningDetails: roundReasoningDetails } : {}),
        });
      }

      if (toolRounds >= maxToolRounds) {
        const notice = `\n\nIRIS stopped this turn after ${maxToolRounds} tool calls. The tool results received so far are preserved; please narrow the request or run the check in smaller parts.`;
        assistantText += notice;
        this.history.push({ role: 'assistant', content: assistantText, turnId });
        this.modelHistory.push({
          role: 'assistant',
          content: assistantText,
        });
        yield { type: 'assistant-chunk', text: notice };
        yield {
          type: 'assistant-complete',
          message: { role: 'assistant', content: assistantText, turnId },
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
        ),
      }));

      let paused: { call: ModelToolCall; approval: AgentToolApproval } | undefined;
      const queuedApprovals: { call: ModelToolCall; approval: AgentToolApproval }[] = [];
      for (const { call, result } of settled) {
        if (result.status === 'approval-required') {
          if (paused) queuedApprovals.push({ call, approval: result.approval });
          else paused = { call, approval: result.approval };
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
          turnId,
          call: paused.call,
          approval: paused.approval,
          remainingCalls: [],
          queuedApprovals,
          assistantText,
          context: copyModelHistory(context),
        };
        yield { type: 'tool-approval-required', call: paused.call, approval: paused.approval };
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
    context: copyModelHistory(pending.context ?? []),
  };
}

function createTurnId(): string {
  return `turn-${crypto.randomUUID()}`;
}

export class AgentRuntimeCoordinator {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly runningAgents = new Set<string>();
  private readonly reconciledCortexAgents = new Set<string>();

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
  ) {}

  async suspendedForAgent(agentId: string): Promise<SuspendedAgentTurn | null> {
    return this.suspendedTurns.getByAgentId(agentId);
  }

  get runningAgentIds(): readonly string[] {
    return [...this.runningAgents];
  }

  async suspendedForApproval(approvalId: string): Promise<SuspendedAgentTurn | null> {
    return this.suspendedTurns.getByApprovalId(approvalId);
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
        const recovered =
          suspended?.pending.turnId === record.turnId
            ? transitionCortexTurn(
                record,
                {
                  status: 'suspended',
                  suspension: {
                    approvalId: suspended.pending.approval.id,
                    toolId: suspended.pending.approval.toolId,
                    toolName: suspended.pending.approval.toolName,
                    reason: suspended.pending.approval.reason,
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
    this.begin(agentId);
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

  async *resolveApproval(
    approvalId: string,
    decision: 'approve' | 'deny',
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const suspended = await this.suspendedTurns.getByApprovalId(approvalId);
    if (!suspended) throw new Error(`No suspended agent turn matches ${approvalId}.`);
    this.begin(suspended.agentId);
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
      const agent = await this.requireAgent(suspended.agentId);
      const resolved = await this.providers.resolve(agent, suspended);
      const session = AgentSession.restore(agent, resolved.provider, suspended, this.tools);
      this.sessions.set(agent.id, session);
      yield* this.persistEvents(
        session.resolveApproval(approvalId, decision, signal),
        session,
        lifecycle,
        approvalId,
      );
    } catch (error) {
      await this.failCortexTurn(lifecycle, error);
      throw error;
    } finally {
      this.runningAgents.delete(suspended.agentId);
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
    await this.suspendedTurns.remove(suspended.pending.approval.id);
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
    this.onStateChange(agentId);
  }

  refreshConfiguration(agentId: string): void {
    if (this.runningAgents.has(agentId)) {
      throw new Error('The agent is currently running.');
    }
    this.sessions.delete(agentId);
    this.onStateChange(agentId);
  }

  private begin(agentId: string): void {
    if (this.runningAgents.has(agentId)) throw new Error('This agent is already running.');
    this.runningAgents.add(agentId);
    this.onStateChange(agentId);
  }

  private async requireAgent(agentId: string): Promise<AgentDefinition> {
    const agent = await this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    return agent;
  }

  private async *persistEvents(
    events: AsyncIterable<AgentEvent>,
    session: AgentSession,
    lifecycle: { record: CortexTurnRecord | null },
    resumedApprovalId?: string,
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
        if (resumedApprovalId) await this.suspendedTurns.remove(resumedApprovalId);
        if (lifecycle.record) {
          await this.updateTurnStep(
            lifecycle.record.turnId,
            event.call.id,
            event.type === 'tool-complete'
              ? { status: 'completed', output: event.output }
              : { status: event.type === 'tool-denied' ? 'denied' : 'failed', reason: event.reason },
          );
        }
        this.onStateChange(session.agent.id);
      }
      if (event.type === 'tool-approval-required') {
        const suspended = session.suspendedTurn();
        if (!suspended) throw new Error('Agent paused without a resumable turn snapshot.');
        await this.suspendedTurns.save(suspended);
        if (lifecycle.record?.status === 'running') {
          await this.saveCortexTurn(
            lifecycle,
            transitionCortexTurn(
              lifecycle.record,
              {
                status: 'suspended',
                suspension: {
                  approvalId: event.approval.id,
                  toolId: event.approval.toolId,
                  toolName: event.approval.toolName,
                  reason: event.approval.reason,
                },
              },
              this.timestamp(),
            ),
          );
        }
        if (lifecycle.record) {
          await this.updateTurnStep(lifecycle.record.turnId, event.call.id, {
            status: 'awaiting-approval',
            approvalId: event.approval.id,
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
