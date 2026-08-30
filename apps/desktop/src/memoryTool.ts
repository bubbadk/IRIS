import type { MemoryService } from '@iris/memory';
import type { RegisteredTool } from '@iris/tools';

interface RememberMemoryInput {
  content: string;
}

function rememberMemoryInput(value: unknown): RememberMemoryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Remember memory requires an object with content.');
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.content !== 'string' || !candidate.content.trim()) {
    throw new Error('Remember memory requires non-empty content.');
  }
  if (Object.keys(candidate).some((key) => key !== 'content')) {
    throw new Error('Remember memory accepts only content.');
  }
  return { content: candidate.content };
}

export function createRememberMemoryTool(memory: MemoryService): RegisteredTool {
  return {
    id: 'memory.remember',
    name: 'Remember workspace fact',
    description:
      'Saves one durable workspace fact with the originating agent and turn for user review.',
    risk: 'write',
    providerName: 'memory_remember',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'A concise fact or preference worth retaining across future sessions.',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    async run(input, context) {
      const { content } = rememberMemoryInput(input);
      if (!context.turnId || !context.toolCallId) {
        throw new Error('Remember workspace fact can run only inside an agent turn.');
      }
      const record = await memory.rememberForAgent(
        content,
        { id: context.agentId, name: context.agentName },
        context.turnId,
        context.toolCallId,
      );
      return {
        saved: true,
        memoryId: record.id,
        capturedAt: record.provenance.capturedAt,
      };
    },
  };
}
