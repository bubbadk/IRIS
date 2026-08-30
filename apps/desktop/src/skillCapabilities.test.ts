import { beforeEach, describe, expect, it } from 'vitest';
import type { SkillDefinition } from '@iris/skills';
import {
  bundledSkillListFilesToolId,
  bundledSkillReadFileToolId,
  bundledSkillReadJsonToolId,
  bundledSkillReadCsvToolId,
  bundledSkillFindFilesToolId,
  bundledSkillSearchFilesToolId,
  bundledSkillSummaryToolId,
  clearSkillCapabilityProviders,
  registerSkillCapabilityProvider,
  skillCapabilityStatus,
  syncBundledSkillCapabilityProviders,
  unregisterSkillCapabilityProvider,
} from './skillCapabilities';
import { toolRegistry, agentToolRuntime } from './tooling';
import { permissionRuleRepository } from './persistence';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

const skill: SkillDefinition = {
  version: 1,
  id: 'skill-release',
  name: 'Release',
  summary: 'Release checks',
  instructions: 'Check releases carefully.',
  enabled: true,
  bundle: {
    version: 1,
    provenance: 'local',
    files: [],
    toolDeclarations: [
      {
        id: 'skill.release.check',
        name: 'Check release',
        description: 'Checks a release plan.',
        risk: 'read',
        inputSchema: { type: 'object', properties: { tag: { type: 'string' } } },
      },
    ],
  },
  createdAt: '2026-08-28T09:00:00.000Z',
  updatedAt: '2026-08-28T09:00:00.000Z',
};

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
  clearSkillCapabilityProviders();
});

describe('bundled skill capability boundary', () => {
  it('parses bounded quoted CSV from persisted bundle data through explicit permission', async () => {
    const bundledSkill = {
      ...skill,
      bundle: {
        ...skill.bundle!,
        files: [
          { path: 'data/releases.csv', content: 'tag,notes\n"v1","Ready, reviewed"\nv2,Pending\n' },
        ],
        toolDeclarations: [
          {
            id: bundledSkillReadCsvToolId,
            name: 'Read bundled CSV',
            description: 'Parses a CSV file shipped inside this skill bundle.',
            risk: 'read' as const,
          },
        ],
      },
    };
    syncBundledSkillCapabilityProviders([bundledSkill]);
    const assigned = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'assist' as const,
      skillIds: [bundledSkill.id],
      toolIds: [bundledSkillReadCsvToolId],
    };

    expect(
      await agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_read_csv',
        { path: 'data/releases.csv' },
        { turnId: 'turn-1', toolCallId: 'call-1' },
      ),
    ).toEqual({ status: 'denied', reason: 'No permission rule allows this tool.' });

    await permissionRuleRepository.save({
      id: 'allow-bundle-csv',
      agentId: assigned.id,
      toolId: bundledSkillReadCsvToolId,
      decision: 'allow',
    });
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_read_csv',
        { path: 'data/releases.csv' },
        { turnId: 'turn-1', toolCallId: 'call-2' },
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      output: {
        path: 'data/releases.csv',
        columns: ['tag', 'notes'],
        rows: [
          ['v1', 'Ready, reviewed'],
          ['v2', 'Pending'],
        ],
        truncated: false,
      },
    });
  });

  it('rejects malformed bundled CSV and invalid delimiter input', async () => {
    const bundledSkill = {
      ...skill,
      bundle: {
        ...skill.bundle!,
        files: [{ path: 'data/broken.csv', content: 'tag,notes\n"v1,Pending\n' }],
        toolDeclarations: [
          {
            id: bundledSkillReadCsvToolId,
            name: 'Read bundled CSV',
            description: 'Parses a CSV file shipped inside this skill bundle.',
            risk: 'read' as const,
          },
        ],
      },
    };
    syncBundledSkillCapabilityProviders([bundledSkill]);
    const assigned = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'assist' as const,
      skillIds: [bundledSkill.id],
      toolIds: [bundledSkillReadCsvToolId],
    };
    await permissionRuleRepository.save({
      id: 'allow-bundle-csv-invalid',
      agentId: assigned.id,
      toolId: bundledSkillReadCsvToolId,
      decision: 'allow',
    });

    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_read_csv',
        { path: 'data/broken.csv' },
        { turnId: 'turn-1', toolCallId: 'call-1' },
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'Bundled CSV contains an unterminated quoted field.',
    });
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_read_csv',
        { path: 'data/broken.csv', delimiter: '::' },
        { turnId: 'turn-1', toolCallId: 'call-2' },
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'Bundled CSV reads require an exact path and one-character delimiter.',
    });
  });

  it('parses only a bounded persisted JSON file through the permission boundary', async () => {
    const bundledSkill = {
      ...skill,
      bundle: {
        ...skill.bundle!,
        files: [
          { path: 'config/settings.json', content: '{"mode":"safe","retries":2}' },
          { path: 'notes.txt', content: 'not JSON' },
        ],
        toolDeclarations: [
          {
            id: bundledSkillReadJsonToolId,
            name: 'Read bundled JSON',
            description: 'Parses a JSON file shipped inside this skill bundle.',
            risk: 'read' as const,
          },
        ],
      },
    };
    syncBundledSkillCapabilityProviders([bundledSkill]);
    const assigned = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'assist' as const,
      skillIds: [bundledSkill.id],
      toolIds: [bundledSkillReadJsonToolId],
    };

    await permissionRuleRepository.save({
      id: 'allow-bundle-json',
      agentId: assigned.id,
      toolId: bundledSkillReadJsonToolId,
      decision: 'allow',
    });
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_read_json',
        { path: 'config/settings.json' },
        { turnId: 'turn-1', toolCallId: 'call-1' },
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      output: {
        path: 'config/settings.json',
        value: { mode: 'safe', retries: 2 },
      },
    });
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_read_json',
        { path: 'notes.txt' },
        { turnId: 'turn-1', toolCallId: 'call-2' },
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'Bundled file at notes.txt does not contain valid JSON.',
    });
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_read_json',
        { path: '../outside' },
        { turnId: 'turn-1', toolCallId: 'call-3' },
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'No bundled file exists at ../outside.',
    });
  });

  it('lists only persisted bundle metadata through the second read-only provider', async () => {
    const bundledSkill = {
      ...skill,
      bundle: {
        ...skill.bundle!,
        files: [
          { path: 'templates/release.md', content: '# Release' },
          { path: 'config.json', content: '{"mode":"safe"}' },
        ],
        toolDeclarations: [
          {
            id: bundledSkillListFilesToolId,
            name: 'List bundled files',
            description: 'Lists files shipped inside this skill bundle.',
            risk: 'read' as const,
          },
        ],
      },
    };
    syncBundledSkillCapabilityProviders([bundledSkill]);
    const assigned = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'assist' as const,
      skillIds: [bundledSkill.id],
      toolIds: [bundledSkillListFilesToolId],
    };

    expect(
      await agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_list_files',
        {},
        {
          turnId: 'turn-1',
          toolCallId: 'call-1',
        },
      ),
    ).toEqual({ status: 'denied', reason: 'No permission rule allows this tool.' });

    await permissionRuleRepository.save({
      id: 'allow-bundle-list',
      agentId: assigned.id,
      toolId: bundledSkillListFilesToolId,
      decision: 'allow',
    });
    await expect(
      agentToolRuntime.execute(assigned, 'skill_skill_bundle_list_files', undefined, {
        turnId: 'turn-1',
        toolCallId: 'call-2',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      output: {
        files: [
          { path: 'templates/release.md', bytes: 9 },
          { path: 'config.json', bytes: 15 },
        ],
      },
    });
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_list_files',
        { path: 'not-accepted' },
        { turnId: 'turn-1', toolCallId: 'call-3' },
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'Bundled file listings accept only an empty object.',
    });
  });

  it('provides only the reserved read-only bundle file capability', async () => {
    const bundledSkill = {
      ...skill,
      bundle: {
        ...skill.bundle!,
        files: [{ path: 'templates/release.md', content: '# Release' }],
        toolDeclarations: [
          {
            id: bundledSkillReadFileToolId,
            name: 'Read bundled file',
            description: 'Reads a file shipped inside this skill bundle.',
            risk: 'read' as const,
          },
        ],
      },
    };
    syncBundledSkillCapabilityProviders([bundledSkill]);
    expect(skillCapabilityStatus(bundledSkill, bundledSkillReadFileToolId)).toEqual({
      status: 'registered',
      toolId: bundledSkillReadFileToolId,
    });

    const assigned = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'assist' as const,
      skillIds: [bundledSkill.id],
      toolIds: [bundledSkillReadFileToolId],
    };
    await permissionRuleRepository.save({
      id: 'allow-bundle-read',
      agentId: assigned.id,
      toolId: bundledSkillReadFileToolId,
      decision: 'allow',
    });
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_read_file',
        { path: 'templates/release.md' },
        { turnId: 'turn-1', toolCallId: 'call-1' },
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      output: { path: 'templates/release.md', content: '# Release' },
    });
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_read_file',
        { path: '../escape' },
        { turnId: 'turn-1', toolCallId: 'call-2' },
      ),
    ).resolves.toMatchObject({ status: 'failed', reason: 'No bundled file exists at ../escape.' });
  });

  it('searches persisted bundle text with bounded, permission-gated results', async () => {
    const bundledSkill = {
      ...skill,
      bundle: {
        ...skill.bundle!,
        files: [
          { path: 'notes/a.md', content: 'Keep the release calm.\nReview the release.' },
          { path: 'notes/b.md', content: 'No match here.' },
        ],
        toolDeclarations: [
          {
            id: bundledSkillSearchFilesToolId,
            name: 'Search bundled files',
            description: 'Searches text in files shipped inside this skill bundle.',
            risk: 'read' as const,
          },
        ],
      },
    };
    syncBundledSkillCapabilityProviders([bundledSkill]);
    const assigned = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'assist' as const,
      skillIds: [bundledSkill.id],
      toolIds: [bundledSkillSearchFilesToolId],
    };
    await permissionRuleRepository.save({
      id: 'allow-bundle-search',
      agentId: assigned.id,
      toolId: bundledSkillSearchFilesToolId,
      decision: 'allow',
    });
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_search_files',
        { query: 'release' },
        { turnId: 'turn-1', toolCallId: 'call-1' },
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      output: {
        query: 'release',
        matches: [
          { path: 'notes/a.md', line: 1, text: 'Keep the release calm.' },
          { path: 'notes/a.md', line: 2, text: 'Review the release.' },
        ],
        truncated: false,
      },
    });
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_search_files',
        { query: 'release', path: '../outside' },
        { turnId: 'turn-1', toolCallId: 'call-2' },
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'No bundled file exists at ../outside.',
    });
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_search_files',
        { query: ' release' },
        { turnId: 'turn-1', toolCallId: 'call-3' },
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('trimmed query'),
    });
  });

  it('finds persisted bundle paths without reading the host filesystem', async () => {
    const bundledSkill = {
      ...skill,
      bundle: {
        ...skill.bundle!,
        files: [
          { path: 'templates/release.md', content: '# Release' },
          { path: 'config/release.json', content: '{"mode":"safe"}' },
          { path: 'notes/other.txt', content: 'Other' },
        ],
        toolDeclarations: [
          {
            id: bundledSkillFindFilesToolId,
            name: 'Find bundled files',
            description: 'Finds paths in files shipped inside this skill bundle.',
            risk: 'read' as const,
          },
        ],
      },
    };
    syncBundledSkillCapabilityProviders([bundledSkill]);
    const assigned = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'assist' as const,
      skillIds: [bundledSkill.id],
      toolIds: [bundledSkillFindFilesToolId],
    };
    await permissionRuleRepository.save({
      id: 'allow-bundle-find',
      agentId: assigned.id,
      toolId: bundledSkillFindFilesToolId,
      decision: 'allow',
    });

    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_find_files',
        { query: 'RELEASE' },
        { turnId: 'turn-1', toolCallId: 'call-1' },
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      output: {
        query: 'RELEASE',
        matches: [
          { path: 'templates/release.md', bytes: 9 },
          { path: 'config/release.json', bytes: 15 },
        ],
        truncated: false,
      },
    });
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_find_files',
        { query: ' ../outside' },
        { turnId: 'turn-1', toolCallId: 'call-2' },
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('trimmed query'),
    });
  });

  it('summarizes only persisted bundle metadata through the permission boundary', async () => {
    const bundledSkill = {
      ...skill,
      summary: 'Review release material safely.',
      bundle: {
        ...skill.bundle!,
        files: [{ path: 'templates/release.md', content: '# Release' }],
        toolDeclarations: [
          {
            id: bundledSkillSummaryToolId,
            name: 'Summarize bundled skill',
            description: 'Reports metadata for this skill bundle.',
            risk: 'read' as const,
          },
        ],
      },
    };
    syncBundledSkillCapabilityProviders([bundledSkill]);
    const assigned = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'assist' as const,
      skillIds: [bundledSkill.id],
      toolIds: [bundledSkillSummaryToolId],
    };

    await permissionRuleRepository.save({
      id: 'allow-bundle-summary',
      agentId: assigned.id,
      toolId: bundledSkillSummaryToolId,
      decision: 'allow',
    });
    await expect(
      agentToolRuntime.execute(assigned, 'skill_skill_bundle_summary', undefined, {
        turnId: 'turn-1',
        toolCallId: 'call-1',
      }),
    ).resolves.toMatchObject({
      status: 'completed',
      output: { name: 'Release', summary: 'Review release material safely.', files: 1, bytes: 9 },
    });
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_bundle_summary',
        { includeContents: true },
        { turnId: 'turn-1', toolCallId: 'call-2' },
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'Bundled skill summaries accept only an empty object.',
    });
  });

  it('reports an unprovided declaration without putting it in the tool registry', () => {
    expect(skillCapabilityStatus(skill, 'skill.release.check')).toEqual({
      status: 'unavailable',
      reason: 'provider-not-registered',
    });
    expect(toolRegistry.get('skill.release.check')).toBeUndefined();
  });

  it('registers only a supplied provider and leaves assignment and permission explicit', async () => {
    registerSkillCapabilityProvider(skill, {
      skillId: skill.id,
      toolId: 'skill.release.check',
      async run(input, context) {
        return { input, agentId: context.agentId };
      },
    });

    expect(skillCapabilityStatus(skill, 'skill.release.check')).toEqual({
      status: 'registered',
      toolId: 'skill.release.check',
    });
    expect(toolRegistry.get('skill.release.check')).toBeDefined();
    const agent = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'assist' as const,
      skillIds: [skill.id],
      toolIds: [],
    };
    expect(agentToolRuntime.definitions(agent)).toEqual([]);

    const assigned = { ...agent, toolIds: ['skill.release.check'] };
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_release_check',
        { tag: 'v1' },
        { turnId: 'turn-1', toolCallId: 'call-1' },
      ),
    ).resolves.toEqual({ status: 'denied', reason: 'No permission rule allows this tool.' });

    await permissionRuleRepository.save({
      id: 'allow-skill-release-check',
      agentId: assigned.id,
      toolId: 'skill.release.check',
      decision: 'allow',
    });
    await expect(
      agentToolRuntime.execute(
        assigned,
        'skill_skill_release_check',
        { tag: 'v1' },
        { turnId: 'turn-1', toolCallId: 'call-1' },
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      output: { input: { tag: 'v1' }, agentId: 'agent-1' },
    });
  });

  it('rejects providers for undeclared capabilities and can remove runtime registration', () => {
    expect(() =>
      registerSkillCapabilityProvider(skill, {
        skillId: skill.id,
        toolId: 'skill.release.publish',
        run: async () => ({ ok: true }),
      }),
    ).toThrow(/does not declare/);

    registerSkillCapabilityProvider(skill, {
      skillId: skill.id,
      toolId: 'skill.release.check',
      run: async () => ({ ok: true }),
    });
    expect(unregisterSkillCapabilityProvider(skill.id, 'skill.release.check')).toBe(true);
    expect(toolRegistry.get('skill.release.check')).toBeUndefined();
  });

  it('removes stale built-in providers when a bundle declaration disappears', () => {
    const bundledSkill = {
      ...skill,
      bundle: {
        ...skill.bundle!,
        files: [{ path: 'data/release.csv', content: 'tag\nv1\n' }],
        toolDeclarations: [
          {
            id: bundledSkillReadCsvToolId,
            name: 'Read bundled CSV',
            description: 'Parses a CSV file shipped inside this skill bundle.',
            risk: 'read' as const,
          },
        ],
      },
    };
    syncBundledSkillCapabilityProviders([bundledSkill]);
    expect(toolRegistry.get(bundledSkillReadCsvToolId)).toBeDefined();

    syncBundledSkillCapabilityProviders([
      {
        ...bundledSkill,
        bundle: { ...bundledSkill.bundle, toolDeclarations: [] },
      },
    ]);

    expect(toolRegistry.get(bundledSkillReadCsvToolId)).toBeUndefined();
    expect(skillCapabilityStatus(bundledSkill, bundledSkillReadCsvToolId)).toEqual({
      status: 'unavailable',
      reason: 'provider-not-registered',
    });
  });
});
