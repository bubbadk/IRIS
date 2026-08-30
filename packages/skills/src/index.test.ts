import { describe, expect, it } from 'vitest';
import {
  SkillService,
  catalogInstructionsAreDescriptionOnly,
  describeSkillBundle,
  describeSkillBundleProvenance,
  createSkill,
  applyImportedSkillUpdate,
  diffSkillInstructions,
  describeAgentSkills,
  findImportedSkill,
  importedSkillOrigin,
  normalizeSkillDraft,
  parseSkillBundleDraft,
  parseSkillCatalogEntry,
  parseSkillCatalogPage,
  parseSkillDocument,
  planSkillBundleRegistration,
  renderSkill,
  resolveAgentSkills,
  skillDraftFromCatalog,
  skillDocumentCandidates,
  skillInstructionsLimit,
  skillOrigin,
  skillSummaryLimit,
  serializeSkillBundleDraft,
  updateSkill,
  sourceCheckFor,
  fingerprintSkillText,
  validateSkill,
  validateSkillBundle,
  type SkillDefinition,
  type SkillRepository,
} from './index';

class InMemorySkillRepository implements SkillRepository {
  constructor(private skills: SkillDefinition[] = []) {}

  async list(): Promise<SkillDefinition[]> {
    return this.skills.map((skill) => ({ ...skill }));
  }

  async get(id: string): Promise<SkillDefinition | null> {
    return this.skills.find((skill) => skill.id === id) ?? null;
  }

  async save(skill: SkillDefinition): Promise<void> {
    this.skills = [skill, ...this.skills.filter((item) => item.id !== skill.id)];
  }

  async remove(id: string): Promise<void> {
    this.skills = this.skills.filter((skill) => skill.id !== id);
  }
}

function skill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    version: 1,
    id: 'skill-1',
    name: 'Release checklist',
    summary: 'How IRIS ships a Linux build.',
    instructions: 'Always build the AppImage before announcing a release.',
    enabled: true,
    createdAt: '2026-08-27T09:00:00.000Z',
    updatedAt: '2026-08-27T09:00:00.000Z',
    ...overrides,
  };
}

describe('skill definitions', () => {
  it('rejects a skill without a name or instructions', () => {
    expect(() =>
      normalizeSkillDraft({ name: '  ', summary: '', instructions: 'Do it.', enabled: true }),
    ).toThrow(/needs name/);
    expect(() =>
      normalizeSkillDraft({ name: 'Review', summary: '', instructions: '   ', enabled: true }),
    ).toThrow(/needs instructions/);
  });

  it('bounds instructions so injected context stays predictable', () => {
    expect(() =>
      normalizeSkillDraft({
        name: 'Long',
        summary: '',
        instructions: 'x'.repeat(skillInstructionsLimit + 1),
        enabled: true,
      }),
    ).toThrow(new RegExp(`${skillInstructionsLimit} characters`));
  });

  it('creates and updates skills while preserving identity and creation time', () => {
    const created = createSkill(
      'skill-1',
      {
        name: ' Release checklist ',
        summary: ' Ship ',
        instructions: ' Build it. ',
        enabled: true,
      },
      { createdAt: '2026-08-27T09:00:00.000Z', updatedAt: '2026-08-27T09:00:00.000Z' },
    );
    expect(created).toMatchObject({
      id: 'skill-1',
      name: 'Release checklist',
      summary: 'Ship',
      instructions: 'Build it.',
    });
    expect(validateSkill(created)).toBe(true);

    const updated = updateSkill(
      created,
      { name: 'Release', summary: '', instructions: 'Build the AppImage.', enabled: false },
      '2026-08-28T09:00:00.000Z',
    );
    expect(updated).toMatchObject({
      id: 'skill-1',
      name: 'Release',
      enabled: false,
      createdAt: '2026-08-27T09:00:00.000Z',
      updatedAt: '2026-08-28T09:00:00.000Z',
    });
  });

  it('accepts an agent-captured origin with full provenance', () => {
    const captured = createSkill(
      'skill-cap',
      { name: 'Restart Sonarr', summary: 'When unhealthy', instructions: 'docker restart …', enabled: true },
      { createdAt: '2026-08-29T12:00:00.000Z', updatedAt: '2026-08-29T12:00:00.000Z' },
      {
        kind: 'captured',
        agentId: 'agent-1',
        agentName: 'Tekniker',
        turnId: 'turn-9',
        capturedAt: '2026-08-29T12:00:00.000Z',
      },
    );
    expect(validateSkill(captured)).toBe(true);
    expect(skillOrigin(captured)).toMatchObject({ kind: 'captured', agentName: 'Tekniker' });
    // Missing provenance fields must be rejected.
    expect(
      validateSkill({ ...captured, origin: { kind: 'captured', agentId: 'agent-1' } }),
    ).toBe(false);
  });

  it('rejects malformed persisted values', () => {
    expect(validateSkill(null)).toBe(false);
    expect(validateSkill({ ...skill(), version: 2 })).toBe(false);
    expect(validateSkill({ ...skill(), instructions: '' })).toBe(false);
    expect(validateSkill({ ...skill(), enabled: 'yes' })).toBe(false);
  });

  it('models bundled files and tool declarations without granting execution authority', () => {
    const bundle = {
      version: 1 as const,
      provenance: 'local' as const,
      files: [{ path: 'templates/release.md', content: '# Release' }],
      toolDeclarations: [
        {
          id: 'skill.release.check',
          name: 'Check release',
          description: 'Checks a release plan.',
          risk: 'read' as const,
        },
      ],
    };
    expect(validateSkillBundle(bundle)).toBe(true);
    expect(validateSkill({ ...skill(), bundle })).toBe(true);
    expect(describeSkillBundle(bundle)).toBe(
      '1 bundled file; 1 declared tool; no tool authority granted.',
    );
    expect(describeSkillBundleProvenance(bundle)).toBe('Local bundle · authored in IRIS');
  });

  it('keeps imported bundle provenance reviewable without turning it into authority', () => {
    const bundle = {
      version: 1 as const,
      provenance: 'imported' as const,
      source: {
        url: 'https://example.com/skill-bundle.tar',
        fingerprint: 'a1b2c3d4',
        importedAt: '2026-08-28T09:00:00.000Z',
        lastCheckedAt: '2026-08-28T10:00:00.000Z',
        lastCheck: 'changed' as const,
      },
      files: [],
      toolDeclarations: [],
    };
    expect(validateSkillBundle(bundle)).toBe(true);
    expect(describeSkillBundleProvenance(bundle)).toBe('Imported bundle · review changed');
    expect(
      validateSkillBundle({ ...bundle, source: { ...bundle.source, lastCheck: 'invalid' } }),
    ).toBe(false);
  });

  it('round-trips the local bundle editor manifest and rejects executable values', () => {
    const bundle = parseSkillBundleDraft(
      JSON.stringify({
        files: [{ path: 'templates/release.md', content: '# Release' }],
        toolDeclarations: [
          {
            id: 'skill.release.check',
            name: 'Check release',
            description: 'Checks a release plan.',
            risk: 'read',
          },
        ],
      }),
    );
    expect(bundle.provenance).toBe('local');
    expect(parseSkillBundleDraft(serializeSkillBundleDraft(bundle))).toEqual(bundle);
    expect(() => parseSkillBundleDraft('{')).toThrow(/valid JSON/);
    expect(() =>
      parseSkillBundleDraft(
        JSON.stringify({
          files: [{ path: '../escape', content: 'x' }],
          toolDeclarations: [],
        }),
      ),
    ).toThrow(/invalid/);
    expect(() =>
      parseSkillBundleDraft(
        JSON.stringify({
          files: [],
          toolDeclarations: [
            {
              id: 'skill.release.check',
              name: 'Check release',
              description: 'Checks a release plan.',
              risk: 'read',
              handler: 'never persisted',
            },
          ],
        }),
      ),
    ).toThrow(/invalid/);
  });

  it('rejects bundle traversal, duplicate files, runtime handlers and unnamespaced tools', () => {
    const base = {
      version: 1 as const,
      provenance: 'imported' as const,
      files: [{ path: 'templates/release.md', content: '# Release' }],
      toolDeclarations: [],
    };
    expect(validateSkillBundle({ ...base, files: [{ path: '../escape', content: 'x' }] })).toBe(
      false,
    );
    expect(validateSkillBundle({ ...base, files: [...base.files, ...base.files] })).toBe(false);
    expect(
      validateSkillBundle({
        ...base,
        toolDeclarations: [
          { id: 'workspace.write', name: 'Write', description: 'Write', risk: 'write' },
        ],
      }),
    ).toBe(false);
    expect(
      validateSkillBundle({
        ...base,
        toolDeclarations: [
          {
            id: 'skill.release.check',
            name: 'Check release',
            description: 'Checks a release plan.',
            risk: 'read',
            run: async () => 'must never persist',
          },
        ],
      }),
    ).toBe(false);
    expect(
      validateSkillBundle({
        ...base,
        toolDeclarations: [
          {
            id: 'skill.release.check',
            name: 'Check release',
            description: 'Checks a release plan.',
            risk: 'read',
            inputSchema: { properties: { callback: () => 'must never persist' } },
          },
        ],
      }),
    ).toBe(false);
  });

  it('accepts only acyclic JSON data in declaration schemas', () => {
    const base = {
      version: 1 as const,
      provenance: 'local' as const,
      files: [],
      toolDeclarations: [
        {
          id: 'skill.release.check',
          name: 'Check release',
          description: 'Checks a release plan.',
          risk: 'read' as const,
        },
      ],
    };
    expect(
      validateSkillBundle({
        ...base,
        toolDeclarations: [
          {
            ...base.toolDeclarations[0],
            inputSchema: { properties: { ready: { type: 'boolean' } } },
          },
        ],
      }),
    ).toBe(true);
    expect(
      validateSkillBundle({
        ...base,
        toolDeclarations: [{ ...base.toolDeclarations[0], inputSchema: new Date() as never }],
      }),
    ).toBe(false);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      validateSkillBundle({
        ...base,
        toolDeclarations: [{ ...base.toolDeclarations[0], inputSchema: cyclic }],
      }),
    ).toBe(false);
  });

  it('keeps bundled capability registration behind an explicit host boundary', () => {
    const bundle = {
      version: 1 as const,
      provenance: 'local' as const,
      files: [],
      toolDeclarations: [
        {
          id: 'skill.release.check',
          name: 'Check release',
          description: 'Checks a release plan.',
          risk: 'read' as const,
          inputSchema: { type: 'object', properties: { ready: { type: 'boolean' } } },
        },
      ],
    };

    const plan = planSkillBundleRegistration('skill-1', bundle);
    expect(plan.status).toBe('unavailable');
    expect(plan.reason).toBe('provider-and-permission-wiring-required');
    expect(plan.declarations).toEqual(bundle.toolDeclarations);
    expect(plan.declarations).not.toHaveProperty('run');
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.declarations)).toBe(true);
    expect(Object.isFrozen(plan.declarations[0])).toBe(true);
    const plannedSchema = plan.declarations[0]!.inputSchema as Record<string, unknown>;
    expect(Object.isFrozen(plannedSchema)).toBe(true);
    expect(Object.isFrozen(plannedSchema.properties)).toBe(true);
    expect(() => {
      plannedSchema.properties = { changed: true };
    }).toThrow(TypeError);
    expect(bundle.toolDeclarations[0]!.inputSchema).toEqual({
      type: 'object',
      properties: { ready: { type: 'boolean' } },
    });
    expect(() => planSkillBundleRegistration(' ', bundle)).toThrow(/skill identifier/);
  });
});

describe('agent skill resolution', () => {
  it('separates enabled, disabled and removed assignments', () => {
    const resolution = resolveAgentSkills({ skillIds: ['skill-1', 'skill-2', 'skill-gone'] }, [
      skill(),
      skill({ id: 'skill-2', name: 'Draft', enabled: false }),
    ]);

    expect(resolution.active.map((item) => item.id)).toEqual(['skill-1']);
    expect(resolution.disabled.map((item) => item.id)).toEqual(['skill-2']);
    expect(resolution.missingIds).toEqual(['skill-gone']);
    expect(describeAgentSkills(resolution)).toBe(
      '1 enabled skill was injected for this turn. 1 assigned skill is disabled and was not injected. 1 assigned skill no longer exists.',
    );
  });

  it('keeps assignment order and reports an honest empty state', () => {
    const resolution = resolveAgentSkills({ skillIds: [] }, [skill()]);
    expect(resolution.active).toEqual([]);
    expect(describeAgentSkills(resolution)).toBe('No enabled skill is assigned to this agent.');
  });

  it('renders a skill with its name, summary and instructions', () => {
    expect(renderSkill(skill())).toBe(
      '## Release checklist\n\nHow IRIS ships a Linux build.\n\nAlways build the AppImage before announcing a release.',
    );
    expect(renderSkill(skill({ summary: '' }))).toBe(
      '## Release checklist\n\nAlways build the AppImage before announcing a release.',
    );
  });
});

describe('skill catalog parsing', () => {
  const entry = {
    slug: 'api-designer',
    name: 'API Designer',
    description: 'Design clean, RESTful APIs',
    category: 'documentation',
    icon: '🔌',
    sourceUrl: 'https://github.com/example/skills',
    tags: ['rest', 'api'],
    installCommand: 'npx playbooks add skill example/skills',
    importCount: 42,
  };

  it('reads a real catalog entry', () => {
    expect(parseSkillCatalogEntry(entry)).toEqual({ ...entry });
  });

  it('drops entries that lack an identity instead of inventing one', () => {
    expect(parseSkillCatalogEntry({ ...entry, slug: '  ' })).toBeNull();
    expect(parseSkillCatalogEntry({ ...entry, name: undefined })).toBeNull();
    expect(parseSkillCatalogEntry(null)).toBeNull();
    expect(parseSkillCatalogEntry('api-designer')).toBeNull();
  });

  it('defaults untrusted optional fields without trusting their type', () => {
    expect(
      parseSkillCatalogEntry({
        slug: 'x',
        name: 'X',
        description: 12,
        category: null,
        tags: ['ok', 3, '  '],
        importCount: -5,
      }),
    ).toEqual({
      slug: 'x',
      name: 'X',
      description: '',
      category: 'uncategorised',
      tags: ['ok'],
      importCount: 0,
    });
  });

  it('reads pagination and skips unreadable rows in a page', () => {
    const page = parseSkillCatalogPage(
      {
        data: [entry, { broken: true }],
        pagination: { page: 2, limit: 12, total: 25, totalPages: 3 },
      },
      12,
    );
    expect(page.entries.map((item) => item.slug)).toEqual(['api-designer']);
    expect(page).toMatchObject({ page: 2, limit: 12, total: 25, totalPages: 3 });
  });

  it('derives missing pagination rather than reporting a fabricated page count', () => {
    const page = parseSkillCatalogPage({ data: [entry], pagination: { total: 25 } }, 10);
    expect(page).toMatchObject({ page: 1, limit: 10, total: 25, totalPages: 3 });
  });

  it('refuses a response that is not a catalog page', () => {
    expect(() => parseSkillCatalogPage({ nope: true }, 12)).toThrow('no result list');
    expect(() => parseSkillCatalogPage('nope', 12)).toThrow('unreadable response');
  });
});

describe('importing a catalog skill', () => {
  const entry = {
    slug: 'api-designer',
    name: 'API Designer',
    description: 'Design clean, RESTful APIs',
    category: 'documentation',
    tags: [],
    sourceUrl: 'https://github.com/example/skills',
    importCount: 42,
  };

  it('maps a catalog entry onto a real skill draft', () => {
    expect(skillDraftFromCatalog(entry, '  Follow REST conventions.  ')).toEqual({
      name: 'API Designer',
      summary: 'Design clean, RESTful APIs',
      instructions: 'Follow REST conventions.',
      enabled: true,
    });
  });

  it('derives raw skill documents only from supported GitHub source links', () => {
    expect(
      skillDocumentCandidates(
        'https://github.com/anthropics/skills/tree/main/skills/frontend-design',
      ),
    ).toEqual([
      'https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md',
      'https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/skill.md',
      'https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/README.md',
    ]);
    expect(skillDocumentCandidates('https://github.com/example/skills', 'api-designer')).toContain(
      'https://raw.githubusercontent.com/example/skills/main/skills/api-designer/SKILL.md',
    );
    expect(skillDocumentCandidates('https://example.com/example/skills')).toEqual([]);
    expect(skillDocumentCandidates('not a url')).toEqual([]);
  });

  it('keeps only the instruction body from a skill markdown document', () => {
    expect(
      parseSkillDocument(
        '---\r\nname: "API Designer"\r\ndescription: Design APIs\r\n---\r\n\r\n# Workflow\r\n\r\nRead the routes first.\r\n',
      ),
    ).toEqual({
      name: 'API Designer',
      description: 'Design APIs',
      body: '# Workflow\r\n\r\nRead the routes first.',
    });
    expect(parseSkillDocument('  Follow the checklist.  ')).toEqual({
      body: 'Follow the checklist.',
    });
  });

  it('shortens an over-long summary but refuses over-long instructions', () => {
    const long = skillDraftFromCatalog({ ...entry, description: 'x'.repeat(400) }, 'Do it.');
    expect(long.summary).toHaveLength(skillSummaryLimit);
    expect(long.summary.endsWith('…')).toBe(true);

    expect(() => skillDraftFromCatalog(entry, 'x'.repeat(skillInstructionsLimit + 1))).toThrow(
      /limited to 8000 characters, but this one has 8001/,
    );
  });

  it('refuses an entry with no instruction body', () => {
    expect(() => skillDraftFromCatalog(entry, '   ')).toThrow(/nothing to import/);
  });

  it('refuses an entry whose instructions only repeat its own description', () => {
    // Most directory entries are like this: the catalog fills the instruction field with the
    // description, which describes a capability instead of explaining how to carry one out.
    expect(catalogInstructionsAreDescriptionOnly(entry, ` ${entry.description} `)).toBe(true);
    expect(() => skillDraftFromCatalog(entry, ` ${entry.description} `)).toThrow(
      /only repeats its own description/,
    );
  });

  it('accepts real instructions that merely start with the description', () => {
    const body = `${entry.description}\n\n## Steps\n1. Read the route table first.`;
    expect(catalogInstructionsAreDescriptionOnly(entry, body)).toBe(false);
    expect(skillDraftFromCatalog(entry, body).instructions).toBe(body);
  });

  it('does not treat an empty description as a match for empty instructions', () => {
    expect(catalogInstructionsAreDescriptionOnly({ ...entry, description: '' }, '')).toBe(false);
    expect(catalogInstructionsAreDescriptionOnly({ ...entry, description: '' }, 'Do it.')).toBe(
      false,
    );
  });

  it('records where an imported skill came from and finds it again', () => {
    const origin = importedSkillOrigin({
      entry,
      instructions: 'Follow REST conventions.',
      catalog: {
        id: 'skillsplayground',
        name: 'Skills Playground',
        homeUrl: 'https://example.com',
      },
      importedAt: '2026-08-28T09:00:00.000Z',
    });
    expect(origin).toEqual({
      kind: 'imported',
      catalogId: 'skillsplayground',
      catalogName: 'Skills Playground',
      slug: 'api-designer',
      sourceUrl: 'https://github.com/example/skills',
      importedAt: '2026-08-28T09:00:00.000Z',
      sourceFingerprint: fingerprintSkillText('Follow REST conventions.'),
    });

    const imported = createSkill(
      'skill-imported',
      skillDraftFromCatalog(entry, 'Follow REST conventions.'),
      { createdAt: '2026-08-28T09:00:00.000Z', updatedAt: '2026-08-28T09:00:00.000Z' },
      origin,
    );
    expect(validateSkill(imported)).toBe(true);
    expect(
      findImportedSkill([skill(), imported], 'skillsplayground', 'api-designer'),
    ).toMatchObject({ id: 'skill-imported' });
    expect(findImportedSkill([skill()], 'skillsplayground', 'api-designer')).toBeNull();
  });

  it('treats a record written before import existed as locally authored', () => {
    const legacy = skill();
    delete (legacy as { origin?: unknown }).origin;
    expect(validateSkill(legacy)).toBe(true);
    expect(skillOrigin(legacy)).toEqual({ kind: 'local' });
    expect(validateSkill({ ...skill(), origin: { kind: 'imported' } })).toBe(false);
  });

  it('detects source changes without changing the local instructions', () => {
    const imported = skill({
      origin: {
        kind: 'imported',
        catalogId: 'catalog',
        catalogName: 'Catalog',
        slug: 'release',
        sourceUrl: 'https://raw.example/SKILL.md',
        importedAt: '2026-08-28T09:00:00.000Z',
        sourceFingerprint: fingerprintSkillText('Original instructions'),
      },
      instructions: 'Original instructions',
    });
    const check = sourceCheckFor(
      imported,
      'Updated instructions',
      '2026-08-29T09:00:00.000Z',
      'https://raw.example/SKILL.md',
    );
    expect(check.status).toBe('changed');
    expect(check.previousText).toBe('Original instructions');
    expect(
      applyImportedSkillUpdate(
        imported,
        check.proposedText!,
        '2026-08-29T09:00:00.000Z',
        check.checkedAt,
      ),
    ).toMatchObject({
      instructions: 'Updated instructions',
      origin: {
        sourceFingerprint: fingerprintSkillText('Updated instructions'),
        lastCheck: 'unchanged',
      },
    });
  });

  it('represents unavailable and moved sources without erasing local content', () => {
    const imported = skill({
      origin: {
        kind: 'imported',
        catalogId: 'catalog',
        catalogName: 'Catalog',
        slug: 'x',
        sourceUrl: 'https://old/SKILL.md',
        importedAt: 'now',
        sourceFingerprint: fingerprintSkillText(skill().instructions),
      },
    });
    expect(sourceCheckFor(imported, null, 'later').status).toBe('unavailable');
    expect(
      sourceCheckFor(imported, 'New body', 'later', 'https://new/SKILL.md', 'moved').status,
    ).toBe('moved');
    expect(imported.instructions).toBe('Always build the AppImage before announcing a release.');
  });

  it('renders a bounded readable instruction diff', () => {
    expect(diffSkillInstructions('Keep this.\nOld step.', 'Keep this.\nNew step.')).toBe(
      '  … unchanged above\n- Old step.\n+ New step.',
    );
  });
});

describe('skill service', () => {
  it('persists real skills and toggles enablement with a new timestamp', async () => {
    let clock = 0;
    const repository = new InMemorySkillRepository();
    const service = new SkillService(repository, {
      createId: () => 'skill-1',
      now: () => new Date(Date.UTC(2026, 7, 28, 0, 0, (clock += 1))),
    });

    const created = await service.create({
      name: 'Release checklist',
      summary: '',
      instructions: 'Build the AppImage.',
      enabled: true,
    });
    expect(created.id).toBe('skill-1');
    expect(await repository.list()).toHaveLength(1);

    const disabled = await service.setEnabled('skill-1', false);
    expect(disabled.enabled).toBe(false);
    expect(disabled.updatedAt).not.toBe(created.updatedAt);

    await service.remove('skill-1');
    expect(await repository.list()).toEqual([]);
  });

  it('refuses to update an unknown skill instead of silently creating one', async () => {
    const service = new SkillService(new InMemorySkillRepository());
    await expect(
      service.update('missing', {
        name: 'X',
        summary: '',
        instructions: 'Y',
        enabled: true,
      }),
    ).rejects.toThrow('Unknown skill: missing');
  });

  it('persists bundled material separately from instructions', async () => {
    const repository = new InMemorySkillRepository([skill()]);
    const service = new SkillService(repository, {
      now: () => new Date('2026-08-28T00:00:00.000Z'),
    });
    const bundle = {
      version: 1 as const,
      provenance: 'local' as const,
      files: [{ path: 'data/checklist.json', content: '{"ready":true}' }],
      toolDeclarations: [],
    };
    const updated = await service.setBundle('skill-1', bundle);
    expect(updated.instructions).toBe(skill().instructions);
    expect(updated.bundle).toEqual(bundle);
    expect((await service.list())[0]?.bundle).toEqual(bundle);
  });

  it('stores a data-only snapshot and strips runtime-shaped extras', async () => {
    const repository = new InMemorySkillRepository([skill()]);
    const service = new SkillService(repository);
    const bundle = {
      version: 1 as const,
      provenance: 'local' as const,
      files: [{ path: 'data/checklist.json', content: '{"ready":true}', runtime: 'discard' }],
      toolDeclarations: [
        {
          id: 'skill.release.check',
          name: 'Check release',
          description: 'Checks a release plan.',
          risk: 'read' as const,
          inputSchema: { type: 'object', properties: { ready: { type: 'boolean' } } },
          runtime: 'discard',
        },
      ],
      runtime: 'discard',
    } as never;

    const updated = await service.setBundle('skill-1', bundle);
    expect(updated.bundle).toEqual({
      version: 1,
      provenance: 'local',
      files: [{ path: 'data/checklist.json', content: '{"ready":true}' }],
      toolDeclarations: [
        {
          id: 'skill.release.check',
          name: 'Check release',
          description: 'Checks a release plan.',
          risk: 'read',
          inputSchema: { type: 'object', properties: { ready: { type: 'boolean' } } },
        },
      ],
    });
  });
});
