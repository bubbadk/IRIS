import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentToolApproval, SuspendedAgentTurn } from '@iris/agents';
import { ChatSessions } from './chatSession';

const approval = (id: string): AgentToolApproval => ({
  id,
  toolId: 'test',
  toolName: 'Test',
  reason: 'Permission required',
});
function setup() {
  let pending: SuspendedAgentTurn | null = null;
  const runtime = {
    runningAgentIds: [] as string[],
    send: vi.fn(async function* (): AsyncGenerator<AgentEvent> {}),
    resolveApproval: vi.fn(async function* (): AsyncGenerator<AgentEvent> {}),
    suspendedForAgent: vi.fn(async () => pending),
    clearConversation: vi.fn(async () => {}),
    cancelSuspended: vi.fn(async () => {}),
  };
  return {
    runtime,
    sessions: new ChatSessions(runtime, { list: async () => [] }),
    setPending(id: string) {
      // Only the pending data is consumed by the presentation controller.
      pending = {
        pending: {
          approval: approval(id),
          call: { id, name: 'test', input: {} },
          assistantText: '',
        },
      } as SuspendedAgentTurn;
    },
  };
}
describe('shared chat sessions', () => {
  it('retains a subsequent approval when the first approval is resolved', async () => {
    const { sessions, runtime, setPending } = setup();
    setPending('first');
    await sessions.load('agent');
    runtime.resolveApproval.mockImplementation(async function* () {
      setPending('second');
      yield {
        type: 'tool-approval-required',
        approval: approval('second'),
        call: { id: 'second', name: 'test', input: {} },
      };
    });
    await sessions.resolve('agent', 'approve');
    expect(sessions.getSnapshot('agent').approval?.id).toBe('second');
    expect(sessions.getSnapshot('agent').busy).toBe(false);
  });
  it('continues streaming across view unmounts and rejects duplicate starts', async () => {
    const { sessions, runtime } = setup();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    runtime.send.mockImplementation(async function* () {
      yield { type: 'assistant-chunk', text: 'First' };
      await gate;
      yield { type: 'assistant-chunk', text: ' second' };
    });
    const unsubscribe = sessions.subscribe(() => {});
    const turn = sessions.send('agent', 'hello');
    await sessions.send('agent', 'duplicate');
    unsubscribe();
    resume();
    await turn;
    expect(runtime.send).toHaveBeenCalledTimes(1);
    expect(sessions.getSnapshot('agent').assistantDraft).toBe('First second');
  });
  it('matches tool results by invocation id, including denials after resuming', async () => {
    const { sessions, runtime } = setup();
    runtime.send.mockImplementation(async function* () {
      yield { type: 'tool-call', call: { id: 'one', name: 'same_tool', input: {} } };
      yield { type: 'tool-call', call: { id: 'two', name: 'same_tool', input: {} } };
      yield {
        type: 'tool-denied',
        call: { id: 'two', name: 'same_tool', input: {} },
        reason: 'Denied',
      };
    });
    await sessions.send('agent', 'hello');
    expect(sessions.getSnapshot('agent').activeTools.map((tool) => tool.status)).toEqual([
      'running',
      'denied',
    ]);
  });
  it('does not let a slow history load overwrite a newly started turn', async () => {
    const { runtime } = setup();
    let resolveHistory!: (messages: []) => void;
    const sessions = new ChatSessions(runtime, {
      list: () =>
        new Promise<[]>((resolve) => {
          resolveHistory = resolve;
        }),
    });
    const loading = sessions.load('agent');
    let finish!: () => void;
    runtime.send.mockImplementation(async function* () {
      yield { type: 'assistant-chunk', text: 'Live' };
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const turn = sessions.send('agent', 'hello');
    await vi.waitFor(() => expect(sessions.getSnapshot('agent').assistantDraft).toBe('Live'));
    resolveHistory([]);
    await loading;
    expect(sessions.getSnapshot('agent').assistantDraft).toBe('Live');
    finish();
    await vi.waitFor(() => expect(sessions.getSnapshot('agent').busy).toBe(false));
    resolveHistory([]);
    await turn;
  });
});
