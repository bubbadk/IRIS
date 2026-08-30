import { describe, it, expect } from 'vitest';
import { analyzeTurnForSkill, saveLearnedSkill } from './skillLearner';
import { LocalSkillRepository } from './persistence';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] ?? null,
    length: values.size,
  };
}

describe('skillLearner', () => {
  it('analyzes multi-step turn and synthesizes a learned skill draft', () => {
    const draft = analyzeTurnForSkill({
      turnId: 'turn-123',
      userPrompt: 'Configure Nginx proxy for web app',
      assistantReply: 'I have configured the Nginx reverse proxy configuration at /etc/nginx/sites-available/default.',
      toolSteps: [
        {
          name: 'workspace_read',
          input: { path: 'nginx.conf' },
          status: 'completed',
        },
        {
          name: 'workspace_patch',
          input: { path: 'nginx.conf' },
          status: 'completed',
        },
      ],
    });

    expect(draft).not.toBeNull();
    expect(draft?.name).toContain('learned-configure-nginx-proxy');
    expect(draft?.summary).toContain('Configure Nginx proxy');
    expect(draft?.instructions).toContain('workspace_patch');
    expect(draft?.originTurnId).toBe('turn-123');
    expect(draft?.confidence).toBeGreaterThan(0.7);
  });

  it('returns null for trivial non-procedural questions without tools', () => {
    const draft = analyzeTurnForSkill({
      turnId: 'turn-simple',
      userPrompt: 'hi',
      assistantReply: 'Hello! How can I help you today?',
      toolSteps: [],
    });

    expect(draft).toBeNull();
  });

  it('saves learned skill to persistence repository', async () => {
    const storage = memoryStorage();
    const repo = new LocalSkillRepository(storage);

    const draft = analyzeTurnForSkill({
      turnId: 'turn-456',
      userPrompt: 'Fix typescript build errors in auth module',
      assistantReply: 'Fixed interface definitions and resolved compilation.',
      toolSteps: [
        {
          name: 'workspace_search',
          input: { query: 'UserAuth' },
          status: 'completed',
        },
        {
          name: 'workspace_patch',
          input: { path: 'src/auth.ts' },
          status: 'completed',
        },
      ],
    });

    expect(draft).not.toBeNull();
    if (draft) {
      const saved = await saveLearnedSkill(draft, repo);
      expect(saved.id).toBe(draft.id);
      expect(saved.enabled).toBe(true);

      const all = await repo.list();
      expect(all.some((s) => s.id === saved.id)).toBe(true);
    }
  });
});
