import { describe, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '@iris/core';
import { SkillService, type SkillDefinition, type SkillRepository } from '@iris/skills';
import { createCaptureSkillTool } from './skillTool';

class InMemorySkillRepository implements SkillRepository {
  skills: SkillDefinition[] = [];
  async list() {
    return this.skills.map((skill) => ({ ...skill }));
  }
  async get(id: string) {
    const skill = this.skills.find((candidate) => candidate.id === id);
    return skill ? { ...skill } : null;
  }
  async save(skill: SkillDefinition) {
    this.skills = [skill, ...this.skills.filter((candidate) => candidate.id !== skill.id)];
  }
  async remove(id: string) {
    this.skills = this.skills.filter((candidate) => candidate.id !== id);
  }
}

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'agent-1',
    name: 'Tekniker',
    autonomy: 'operate',
    skillIds: [],
    toolIds: ['skill.capture'],
    ...overrides,
  };
}

function setup(stored: AgentDefinition = agent()) {
  const repository = new InMemorySkillRepository();
  const skills = new SkillService(repository, {
    createId: () => 'skill-captured-1',
    now: () => new Date('2026-08-29T12:00:00.000Z'),
  });
  const saved: AgentDefinition[] = [];
  const agents = {
    list: vi.fn(async () => [stored]),
    get: vi.fn(async (id: string) => (id === stored.id ? { ...stored } : null)),
    save: vi.fn(async (next: AgentDefinition) => {
      saved.push(next);
    }),
    remove: vi.fn(async () => undefined),
  };
  const tool = createCaptureSkillTool(skills, agents, {
    now: () => new Date('2026-08-29T12:00:00.000Z'),
  });
  return { tool, repository, agents, saved };
}

const invocation = { agentId: 'agent-1', agentName: 'Tekniker', turnId: 'turn-9', toolCallId: 'call-3' };

describe('capture reusable skill tool', () => {
  it('creates an enabled skill with agent provenance and assigns it to the agent', async () => {
    const { tool, repository, saved } = setup();
    const result = await tool.run(
      {
        name: 'Restart Sonarr',
        summary: 'When the Sonarr container is unhealthy',
        instructions: '1. docker restart binhex-sonarr\n2. Verify: docker ps shows healthy',
      },
      invocation,
    );

    expect(result).toMatchObject({ captured: true, skillId: 'skill-captured-1', assignedTo: 'agent-1' });
    const [stored] = repository.skills;
    expect(stored.enabled).toBe(true);
    expect(stored.name).toBe('Restart Sonarr');
    expect(stored.origin).toEqual({
      kind: 'captured',
      agentId: 'agent-1',
      agentName: 'Tekniker',
      turnId: 'turn-9',
      capturedAt: '2026-08-29T12:00:00.000Z',
    });
    // The skill is assigned to the capturing agent so it loads next turn.
    expect(saved).toHaveLength(1);
    expect(saved[0]?.skillIds).toEqual(['skill-captured-1']);
  });

  it('does not duplicate an assignment the agent already holds', async () => {
    const { tool, saved } = setup(agent({ skillIds: ['skill-captured-1'] }));
    await tool.run({ name: 'X', summary: '', instructions: 'do the thing' }, invocation);
    // Already assigned → no agent save needed.
    expect(saved).toHaveLength(0);
  });

  it('requires a name and instructions and rejects extra fields', async () => {
    const { tool } = setup();
    await expect(tool.run({ name: 'X' }, invocation)).rejects.toThrow('non-empty instructions');
    await expect(tool.run({ instructions: 'y' }, invocation)).rejects.toThrow('non-empty name');
    await expect(
      tool.run({ name: 'X', instructions: 'y', extra: 1 }, invocation),
    ).rejects.toThrow('only name, summary and instructions');
  });

  it('runs only inside an agent turn', async () => {
    const { tool } = setup();
    await expect(
      tool.run({ name: 'X', instructions: 'y' }, { agentId: 'agent-1', agentName: 'Tekniker' }),
    ).rejects.toThrow('only inside an agent turn');
  });
});
