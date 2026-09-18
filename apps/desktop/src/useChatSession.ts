import { useEffect, useSyncExternalStore } from 'react';
import { subscribeAgentRuntime } from './agentRuntime';
import { conversationRepository } from './persistence';
import { chatAgentRuntime } from './agentApproval';
import { ChatSessions } from './chatSession';

// The chat window resolves approvals through the central path, so a decision made here updates the
// scheduled run the approval belongs to just like the global permissions window does.
export const chatSessions = new ChatSessions(chatAgentRuntime, conversationRepository);
export function useChatSession(agentId: string | null) {
  const state = useSyncExternalStore(chatSessions.subscribe, () =>
    chatSessions.getSnapshot(agentId ?? ''),
  );
  useEffect(() => {
    if (!agentId) return;
    void chatSessions.load(agentId);
    return subscribeAgentRuntime((changed) => {
      if (changed === agentId) void chatSessions.load(agentId);
    });
  }, [agentId]);
  return state;
}
