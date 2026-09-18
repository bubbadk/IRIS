import { GlobalKnowledgeContributor } from './knowledgeContext';
import {
  CompositeContextPackBuilder,
  MemoryContextPackBuilder,
  SkillContextContributor,
  type ContextPackBuilder,
  type ContextContributor,
} from '@iris/cortex';
import { MemoryService } from '@iris/memory';
import type { SkillRepository } from '@iris/skills';
import { memoryRepository, skillRepository } from './persistence';
import { ConfiguredMemoryRetriever } from './memoryRetrieval';

const memoryContextLimit = 20;

export const memoryService = new MemoryService(memoryRepository, {
  retriever: new ConfiguredMemoryRetriever(),
});

export function createAgentContextBuilder(
  service: MemoryService,
  skills: Pick<SkillRepository, 'list'>,
  limit = memoryContextLimit,
  knowledge?: ContextContributor,
): ContextPackBuilder {
  return new CompositeContextPackBuilder([
    ...(knowledge ? [knowledge] : []),
    new SkillContextContributor(skills),
    new MemoryContextPackBuilder(service, { limit }),
  ]);
}

export const agentContextBuilder: ContextPackBuilder = createAgentContextBuilder(
  memoryService,
  skillRepository,
  memoryContextLimit,
  new GlobalKnowledgeContributor(),
);
export const projectAgentContextBuilder = createAgentContextBuilder(memoryService, skillRepository);
