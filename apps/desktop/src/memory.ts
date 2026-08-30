import {
  CompositeContextPackBuilder,
  MemoryContextPackBuilder,
  SkillContextContributor,
  type ContextPackBuilder,
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
): ContextPackBuilder {
  return new CompositeContextPackBuilder([
    new SkillContextContributor(skills),
    new MemoryContextPackBuilder(service, { limit }),
  ]);
}

export const agentContextBuilder: ContextPackBuilder = createAgentContextBuilder(
  memoryService,
  skillRepository,
);
