import type { AgentRepository } from '@iris/agents';
import type { SkillService } from '@iris/skills';
import type { RegisteredTool } from '@iris/tools';

interface CaptureSkillInput {
  name: string;
  summary: string;
  instructions: string;
}

function captureSkillInput(value: unknown): CaptureSkillInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Capture skill requires an object with name, summary and instructions.');
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(['name', 'summary', 'instructions']);
  if (Object.keys(candidate).some((key) => !allowed.has(key))) {
    throw new Error('Capture skill accepts only name, summary and instructions.');
  }
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) {
    throw new Error('Capture skill requires a non-empty name.');
  }
  if (typeof candidate.instructions !== 'string' || !candidate.instructions.trim()) {
    throw new Error('Capture skill requires non-empty instructions.');
  }
  if (candidate.summary !== undefined && typeof candidate.summary !== 'string') {
    throw new Error('Capture skill summary must be text.');
  }
  return {
    name: candidate.name,
    summary: typeof candidate.summary === 'string' ? candidate.summary : '',
    instructions: candidate.instructions,
  };
}

interface CaptureSkillDependencies {
  now: () => Date;
}

/**
 * Lets an agent turn a procedure it just carried out into a reusable Skill — the missing step of a
 * self-improvement loop. The skill is created enabled and assigned to the capturing agent so it
 * loads into the agent's context on the next turn, and it records which agent and turn authored it
 * for user review. Execution is permission-gated like every write tool, and the user can disable or
 * delete a captured skill at any time from the Skills object.
 */
export function createCaptureSkillTool(
  skills: SkillService,
  agents: AgentRepository,
  dependencies: CaptureSkillDependencies = { now: () => new Date() },
): RegisteredTool {
  return {
    id: 'skill.capture',
    name: 'Capture reusable skill',
    description:
      'Saves a repeatable procedure the agent just performed as a reusable skill (steps, verification and known failure modes) so it loads automatically in future sessions.',
    risk: 'write',
    providerName: 'skill_capture',
    manualExecution: false,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'A short, specific name for the procedure, e.g. "Restart the Sonarr container".',
        },
        summary: {
          type: 'string',
          description: 'One line on when to use this skill, so future turns know when it applies.',
        },
        instructions: {
          type: 'string',
          description:
            'The reusable procedure: ordered steps and exact commands, how to verify success, and any known failure modes learned this turn.',
        },
      },
      required: ['name', 'instructions'],
      additionalProperties: false,
    },
    async run(input, context) {
      const { name, summary, instructions } = captureSkillInput(input);
      if (!context.turnId || !context.toolCallId) {
        throw new Error('Capture reusable skill can run only inside an agent turn.');
      }
      const agent = await agents.get(context.agentId);
      if (!agent) throw new Error('The capturing agent no longer exists.');

      const skill = await skills.create(
        { name, summary, instructions, enabled: true },
        {
          kind: 'captured',
          agentId: context.agentId,
          agentName: context.agentName,
          turnId: context.turnId,
          capturedAt: dependencies.now().toISOString(),
        },
      );

      // Assign it to the capturing agent so the SkillContextContributor loads it next turn.
      if (!agent.skillIds.includes(skill.id)) {
        await agents.save({ ...agent, skillIds: [...agent.skillIds, skill.id] });
      }

      return {
        captured: true,
        skillId: skill.id,
        name: skill.name,
        assignedTo: context.agentId,
        capturedAt: skill.origin?.kind === 'captured' ? skill.origin.capturedAt : skill.createdAt,
      };
    },
  };
}
