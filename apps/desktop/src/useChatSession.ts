import { useEffect, useSyncExternalStore } from 'react';
import { agentRuntime, subscribeAgentRuntime } from './agentRuntime';
import { conversationRepository } from './persistence';
import { ChatSessions } from './chatSession';

export const chatSessions = new ChatSessions(agentRuntime, conversationRepository);
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
