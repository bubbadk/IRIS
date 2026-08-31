import { describe, expect, it } from 'vitest';
import { validateAgentDefinition, type AgentDefinition } from './index';

describe('packages/core', () => {
  it('validates a valid agent definition with github autonomy', () => {
    const agent: AgentDefinition = {
      id: 'agent-gh',
      name: 'GitHub Engineer',
      autonomy: 'github',
      skillIds: [],
      toolIds: ['github.list_repos', 'github.create_release'],
    };

    expect(validateAgentDefinition(agent)).toBe(true);
  });

  it('rejects an agent definition with invalid autonomy', () => {
    const agent = {
      id: 'agent-invalid',
      name: 'Invalid Agent',
      autonomy: 'superhuman',
      skillIds: [],
      toolIds: [],
    };

    expect(validateAgentDefinition(agent)).toBe(false);
  });
});
