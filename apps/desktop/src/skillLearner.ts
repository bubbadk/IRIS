import { createSkill, type SkillDefinition } from '@iris/skills';
import { skillRepository } from './persistence';

export type LearnedSkillDraft = {
  id: string;
  name: string;
  summary: string;
  instructions: string;
  originTurnId?: string;
  confidence: number;
  tags: string[];
};

export type TurnToolStepSummary = {
  name: string;
  input: Record<string, unknown>;
  status: 'completed' | 'failed' | 'denied' | 'running';
  output?: string;
};

/**
 * Analyzes a completed agent turn to detect if a reusable procedural skill was demonstrated.
 */
export function analyzeTurnForSkill(params: {
  turnId: string;
  userPrompt: string;
  assistantReply: string;
  toolSteps: TurnToolStepSummary[];
}): LearnedSkillDraft | null {
  const { turnId, userPrompt, assistantReply, toolSteps } = params;

  // Must have at least 2 successful tool invocations to synthesize a multi-step procedural skill
  const completedSteps = toolSteps.filter((s) => s.status === 'completed');
  if (completedSteps.length < 2) {
    return null;
  }

  const promptLower = userPrompt.toLowerCase();
  const isProcedural =
    promptLower.includes('how to') ||
    promptLower.includes('fix') ||
    promptLower.includes('setup') ||
    promptLower.includes('configure') ||
    promptLower.includes('create') ||
    promptLower.includes('build') ||
    promptLower.includes('deploy') ||
    promptLower.includes('optimize') ||
    promptLower.includes('migrate') ||
    completedSteps.length >= 2;

  if (!isProcedural) {
    return null;
  }

  // Derive a slugified skill name
  const cleanTitle = userPrompt
    .replace(/[^\w\s-]/g, '')
    .trim()
    .slice(0, 40)
    .toLowerCase()
    .replace(/\s+/g, '-');

  const skillName = `learned-${cleanTitle || 'procedure-' + Date.now().toString(36)}`;
  const skillId = `skill-${skillName}`;

  // Extract key steps into instructions
  const stepsList = completedSteps
    .map((step, idx) => {
      const toolName = step.name;
      const target =
        typeof step.input.path === 'string'
          ? step.input.path
          : typeof step.input.command === 'string'
            ? step.input.command
            : JSON.stringify(step.input).slice(0, 60);
      return `${idx + 1}. Execute \`${toolName}\` on \`${target}\``;
    })
    .join('\n');

  const summary = `Auto-learned procedure for: "${userPrompt.slice(0, 80)}"`;

  const instructions = `# Learned Skill: ${userPrompt.slice(0, 60)}

## Purpose
This skill was autonomously synthesized by IRIS after successfully solving:
> "${userPrompt}"

## Proven Procedure
${stepsList || 'Follow the demonstrated solution steps:'}

### Key Guidance
- Apply the verified patterns from turn \`${turnId}\`.
- Ensure prerequisite workspace files or services are verified before applying mutations.

## Demonstrated Solution Reference
${assistantReply.slice(0, 300)}...
`;

  return {
    id: skillId,
    name: skillName,
    summary,
    instructions,
    originTurnId: turnId,
    confidence: Math.min(0.95, 0.6 + completedSteps.length * 0.1),
    tags: ['auto-evolved', 'learned'],
  };
}

/**
 * Saves a learned skill draft into the user's permanent skill repository.
 */
export async function saveLearnedSkill(
  draft: LearnedSkillDraft,
  repo: { save: (skill: SkillDefinition) => Promise<void> } = skillRepository,
): Promise<SkillDefinition> {
  const now = new Date().toISOString();
  const skill = createSkill(
    draft.id,
    {
      name: draft.name,
      summary: draft.summary,
      instructions: draft.instructions,
      enabled: true,
    },
    { createdAt: now, updatedAt: now },
    { kind: 'local' },
  );

  await repo.save(skill);
  return skill;
}
