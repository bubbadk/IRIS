import type { ModelMessage } from '@iris/providers';
import type { ConversationMessage } from './index';

/** A safe turn boundary: every requested tool has a recorded result. */
export interface AgentCheckpoint {
  version: 1;
  agentId: string;
  providerId: string;
  model: string;
  turnId: string;
  conversation: ConversationMessage[];
  modelHistory: ModelMessage[];
}

export function validateAgentCheckpoint(value: unknown): value is AgentCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Partial<AgentCheckpoint>;
  if (
    checkpoint.version !== 1 ||
    ![checkpoint.agentId, checkpoint.providerId, checkpoint.model, checkpoint.turnId].every(
      (id) => typeof id === 'string' && id.trim(),
    ) ||
    !Array.isArray(checkpoint.conversation) ||
    !Array.isArray(checkpoint.modelHistory)
  )
    return false;
  if (
    !checkpoint.conversation.every(
      (message) =>
        message &&
        ['user', 'assistant', 'handoff'].includes(message.role) &&
        typeof message.content === 'string',
    )
  )
    return false;
  const pending = new Set<string>();
  for (const message of checkpoint.modelHistory) {
    if (
      !message ||
      !['user', 'assistant', 'system', 'tool'].includes(message.role) ||
      typeof message.content !== 'string'
    )
      return false;
    if (message.role === 'tool') {
      if (!message.toolCallId || !pending.delete(message.toolCallId)) return false;
    } else if (pending.size) return false;
    if (message.toolCalls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.toolCalls)) return false;
      for (const call of message.toolCalls) {
        if (
          !call ||
          typeof call.id !== 'string' ||
          !call.id ||
          typeof call.name !== 'string' ||
          !call.name ||
          pending.has(call.id)
        )
          return false;
        pending.add(call.id);
      }
    }
  }
  return (
    pending.size === 0 &&
    checkpoint.modelHistory.at(-1)?.role === 'assistant' &&
    !checkpoint.modelHistory.at(-1)?.toolCalls?.length &&
    checkpoint.modelHistory.at(-1)?.content === checkpoint.conversation.at(-1)?.content &&
    checkpoint.conversation.at(-1)?.role === 'assistant' &&
    checkpoint.conversation.at(-1)?.turnId === checkpoint.turnId
  );
}
