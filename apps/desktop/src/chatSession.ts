import type {
  AgentEvent,
  AgentToolApproval,
  ConversationMessage,
  AgentRuntimeCoordinator,
} from '@iris/agents';
import type { ContextPack } from '@iris/cortex';
import type { ModelImage } from '@iris/providers';

export interface ActiveToolInvocation {
  id: string;
  name: string;
  input: unknown;
  status: 'running' | 'completed' | 'denied' | 'failed';
  output?: unknown;
  reason?: string;
}
export interface ChatSessionState {
  messages: ConversationMessage[];
  assistantDraft: string;
  reasoningDraft: string;
  busy: boolean;
  activity: string;
  error: string;
  turnStartedAt: number | null;
  approval: AgentToolApproval | null;
  approvalInput: unknown;
  activeTools: ActiveToolInvocation[];
  latestContextPack: ContextPack | null;
}
export const emptyChatSession: ChatSessionState = {
  messages: [],
  assistantDraft: '',
  reasoningDraft: '',
  busy: false,
  activity: '',
  error: '',
  turnStartedAt: null,
  approval: null,
  approvalInput: null,
  activeTools: [],
  latestContextPack: null,
};

type ChatRuntime = Pick<
  AgentRuntimeCoordinator,
  | 'send'
  | 'resolveApproval'
  | 'suspendedForAgent'
  | 'clearConversation'
  | 'cancelSuspended'
  | 'runningAgentIds'
>;

/** Runtime state outlives views. Closing/switching a chat never loses an in-flight approval. */
export class ChatSessions {
  private states = new Map<string, ChatSessionState>();
  private controllers = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  constructor(
    private readonly runtime: ChatRuntime,
    private readonly history: { list(agentId: string): Promise<ConversationMessage[]> },
  ) {}
  getSnapshot = (agentId: string): ChatSessionState => this.states.get(agentId) ?? emptyChatSession;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(agentId: string, patch: Partial<ChatSessionState>) {
    this.states.set(agentId, { ...this.getSnapshot(agentId), ...patch });
    for (const listener of this.listeners) listener();
  }
  async load(agentId: string) {
    const before = this.getSnapshot(agentId);
    if (before.busy) return;
    try {
      const [messages, suspended] = await Promise.all([
        this.history.list(agentId),
        this.runtime.suspendedForAgent(agentId),
      ]);
      if (before !== this.getSnapshot(agentId)) return;
      this.update(agentId, {
        messages,
        approval: suspended?.pending.approval ?? null,
        approvalInput: suspended?.pending.call.input ?? null,
        assistantDraft: suspended?.pending.assistantText ?? before.assistantDraft,
        activity: suspended ? `Permission required for ${suspended.pending.approval.toolName}` : '',
      });
    } catch (error) {
      this.update(agentId, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  async send(agentId: string, content: string, images: ModelImage[] = []) {
    if (this.getSnapshot(agentId).approval) return;
    await this.run(agentId, (signal) => this.runtime.send(agentId, content, signal, images));
  }
  async resolve(agentId: string, decision: 'approve' | 'deny') {
    const approval = this.getSnapshot(agentId).approval;
    if (!approval) return;
    await this.run(agentId, (signal) =>
      this.runtime.resolveApproval(approval.id, decision, signal),
    );
  }
  private async run(agentId: string, events: (signal: AbortSignal) => AsyncIterable<AgentEvent>) {
    if (this.controllers.has(agentId) || this.runtime.runningAgentIds.includes(agentId)) return;
    const controller = new AbortController();
    this.controllers.set(agentId, controller);
    this.update(agentId, {
      busy: true,
      error: '',
      activity: 'Thinking…',
      assistantDraft: '',
      reasoningDraft: '',
      turnStartedAt: Date.now(),
      activeTools: [],
      approval: null,
      approvalInput: null,
    });
    try {
      for await (const event of events(controller.signal)) await this.consume(agentId, event);
    } catch (error) {
      this.update(agentId, {
        error: controller.signal.aborted
          ? 'Turn stopped.'
          : error instanceof Error
            ? error.message
            : String(error),
        activity: '',
      });
    } finally {
      this.controllers.delete(agentId);
      this.update(agentId, { busy: false, turnStartedAt: null });
      // Reconcile persisted suspension, including a second approval or an error during resolution.
      await this.load(agentId);
    }
  }
  private async consume(agentId: string, event: AgentEvent) {
    const state = this.getSnapshot(agentId);
    switch (event.type) {
      case 'context-pack-ready':
        this.update(agentId, { latestContextPack: event.pack });
        break;
      case 'user-message':
        this.update(agentId, { messages: await this.history.list(agentId) });
        break;
      case 'assistant-chunk':
        this.update(agentId, { assistantDraft: state.assistantDraft + event.text });
        break;
      case 'reasoning-chunk':
        this.update(agentId, { reasoningDraft: state.reasoningDraft + event.text });
        break;
      case 'assistant-complete':
        this.update(agentId, {
          messages: await this.history.list(agentId),
          assistantDraft: '',
          reasoningDraft: '',
          activity: '',
        });
        break;
      case 'tool-call':
        this.update(agentId, {
          activeTools: [
            ...state.activeTools,
            {
              id: event.call.id,
              name: event.call.name,
              input: event.call.input,
              status: 'running',
            },
          ],
          activity: `Requested ${event.call.name}. Checking authority…`,
        });
        break;
      case 'tool-complete':
      case 'tool-denied':
      case 'tool-failed': {
        const status =
          event.type === 'tool-complete'
            ? 'completed'
            : event.type === 'tool-denied'
              ? 'denied'
              : 'failed';
        this.update(agentId, {
          activeTools: state.activeTools.map((tool) =>
            tool.id === event.call.id
              ? {
                  ...tool,
                  status,
                  ...('output' in event ? { output: event.output } : { reason: event.reason }),
                }
              : tool,
          ),
          approval: null,
          approvalInput: null,
          activity: `${event.call.name} ${status}. Continuing with the model…`,
        });
        break;
      }
      case 'tool-approval-required':
        this.update(agentId, {
          approval: event.approval,
          approvalInput: event.call.input,
          activity: `Permission required for ${event.approval.toolName}`,
        });
        break;
    }
  }
  async clear(agentId: string) {
    if (this.getSnapshot(agentId).busy || this.runtime.runningAgentIds.includes(agentId)) return;
    await this.runtime.clearConversation(agentId);
    this.update(agentId, emptyChatSession);
  }
  async stop(agentId: string) {
    const controller = this.controllers.get(agentId);
    if (controller) {
      controller.abort();
      return;
    }
    if (this.getSnapshot(agentId).approval) {
      await this.runtime.cancelSuspended(agentId);
      this.update(agentId, {
        approval: null,
        approvalInput: null,
        activity: 'Turn stopped.',
        turnStartedAt: null,
      });
    }
  }
}
