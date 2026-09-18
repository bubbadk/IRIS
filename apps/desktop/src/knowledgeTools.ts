import type { RegisteredTool } from '@iris/tools';
import { resolveKnowledge, searchKnowledge, type KnowledgeScope } from '@iris/memory';
import { agentRepository, projectGraphRepository } from './persistence';
import { knowledgeRepository, notifyKnowledgeChanged } from './knowledge';
function fields(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Knowledge tools require an object input.');
  return input as Record<string, unknown>;
}
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}
async function scopeOf(input: Record<string, unknown>): Promise<KnowledgeScope> {
  if (input.scope === 'global') {
    if (input.projectId !== undefined)
      throw new Error('Global knowledge must not specify a project.');
    return { kind: 'global' };
  }
  if (input.scope !== 'project') throw new Error('Choose global or project scope.');
  const projectId = required(input.projectId, 'Project id');
  if (!(await projectGraphRepository.get(projectId)))
    throw new Error('The project is unavailable.');
  return { kind: 'project', projectId };
}
const scopeProperties = {
  scope: { type: 'string', enum: ['global', 'project'] },
  projectId: {
    type: 'string',
    description: 'Required for project scope; use the assigned project id.',
  },
  query: {
    type: 'string',
    description:
      'Optional words to search all current approved knowledge beyond the turn context limit.',
  },
};
export function createKnowledgeTools(): RegisteredTool[] {
  return [
    {
      id: 'knowledge.propose',
      name: 'Propose durable knowledge',
      providerName: 'knowledge_propose',
      risk: 'write',
      manualExecution: false,
      description:
        'Saves a fact or preference for human review in Memory or the selected Project. It is not active until a person approves it. Reuse the same topic for updated facts so conflicts are visible. Cannot approve, overwrite or silently change active knowledge.',
      inputSchema: {
        type: 'object',
        properties: {
          ...scopeProperties,
          kind: { type: 'string', enum: ['fact', 'preference'] },
          topic: { type: 'string', maxLength: 120 },
          content: { type: 'string', maxLength: 4096 },
          sourceReference: { type: 'string', maxLength: 1000 },
          expiresAt: { type: 'string', description: 'Optional expiry as an ISO date and time.' },
        },
        required: ['scope', 'kind', 'topic', 'content'],
        additionalProperties: false,
      },
      async run(input, context) {
        const value = fields(input);
        const allowed = new Set([
          'scope',
          'projectId',
          'kind',
          'topic',
          'content',
          'sourceReference',
          'expiresAt',
        ]);
        if (Object.keys(value).some((key) => !allowed.has(key)))
          throw new Error('Unsupported knowledge proposal field.');
        if (!context.turnId || !context.toolCallId)
          throw new Error('Knowledge proposals require an actual agent turn and tool call.');
        if (value.kind !== 'fact' && value.kind !== 'preference')
          throw new Error('Choose fact or preference.');
        const scope = await scopeOf(value),
          createdAt = new Date().toISOString();
        const entry = await knowledgeRepository.propose({
          id: crypto.randomUUID(),
          scope,
          kind: value.kind,
          topic: required(value.topic, 'Topic'),
          content: required(value.content, 'Content'),
          createdAt,
          ...(value.sourceReference !== undefined
            ? { sourceReference: required(value.sourceReference, 'Source reference') }
            : {}),
          ...(value.expiresAt !== undefined
            ? { expiresAt: required(value.expiresAt, 'Expiry') }
            : {}),
          provenance: {
            source: 'agent',
            actorId: context.agentId,
            actorName: context.agentName,
            turnId: context.turnId,
            toolCallId: context.toolCallId,
            capturedAt: createdAt,
          },
        });
        notifyKnowledgeChanged();
        return {
          id: entry.id,
          status: entry.status,
          active: false,
          note: 'Saved for human review. Agents must not treat this proposal as approved knowledge.',
        };
      },
    },
    {
      id: 'knowledge.read',
      name: 'Read approved knowledge',
      providerName: 'knowledge_read',
      risk: 'read',
      manualExecution: false,
      description:
        'Reads current approved, unexpired knowledge available to this agent. Project scope combines global and project entries, with project entries taking precedence for the same kind and topic. Requires memory read access; excludes proposals and archived entries.',
      inputSchema: {
        type: 'object',
        properties: scopeProperties,
        required: ['scope'],
        additionalProperties: false,
      },
      async run(input, context) {
        const value = fields(input);
        if (Object.keys(value).some((key) => !['scope', 'projectId', 'query'].includes(key)))
          throw new Error('Unsupported knowledge read field.');
        if ((await agentRepository.get(context.agentId))?.memoryAccess !== 'read')
          throw new Error('This agent has no memory read access.');
        const scope = await scopeOf(value);
        const entries = await knowledgeRepository.list();
        const projectId = scope.kind === 'project' ? scope.projectId : undefined;
        return typeof value.query === 'string' && value.query.trim()
          ? searchKnowledge(entries, projectId, value.query, new Date().toISOString())
          : resolveKnowledge(entries, projectId, new Date().toISOString());
      },
    },
  ];
}
