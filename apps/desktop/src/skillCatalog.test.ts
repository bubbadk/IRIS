import { describe, expect, it } from 'vitest';
import type { SkillCatalogEntry } from '@iris/skills';
import { SkillsPlaygroundCatalog } from './skillCatalog';

function catalog(
  handler: (url: string) => unknown,
  textHandler: (url: string) => string | null | Error = () => null,
) {
  const requests: string[] = [];
  const textRequests: string[] = [];
  const source = new SkillsPlaygroundCatalog({
    fetchJson: async (url) => {
      requests.push(url);
      const result = handler(url);
      if (result instanceof Error) throw result;
      return result;
    },
    fetchText: async (url) => {
      textRequests.push(url);
      const result = textHandler(url);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { source, requests, textRequests };
}

const entry: SkillCatalogEntry = {
  slug: 'api-designer',
  name: 'API Designer',
  description: 'Design clean, RESTful APIs',
  category: 'documentation',
  tags: ['rest'],
  importCount: 42,
};

const listPayload = {
  data: [
    {
      slug: 'api-designer',
      name: 'API Designer',
      description: 'Design clean, RESTful APIs',
      category: 'documentation',
      tags: ['rest'],
      importCount: 42,
    },
  ],
  pagination: { page: 2, limit: 12, total: 25, totalPages: 3 },
};

describe('Skills Playground catalog', () => {
  it('builds a real query against the documented list endpoint', async () => {
    const { source, requests } = catalog(() => listPayload);

    const page = await source.browse({ query: ' rest ', category: 'documentation', page: 2 });

    const url = new URL(requests[0]!);
    expect(url.origin + url.pathname).toBe('https://skillsplayground.com/api/v1/skills');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: '2',
      limit: '12',
      q: 'rest',
      category: 'documentation',
    });
    expect(page.entries.map((entry) => entry.slug)).toEqual(['api-designer']);
    expect(page.total).toBe(25);
  });

  it('omits empty filters and clamps an out-of-range page and limit', async () => {
    const { source, requests } = catalog(() => listPayload);

    await source.browse({ query: '   ', category: '', page: 0, limit: 5000 });

    const params = new URL(requests[0]!).searchParams;
    expect(params.get('page')).toBe('1');
    expect(params.get('limit')).toBe('100');
    expect(params.has('q')).toBe(false);
    expect(params.has('category')).toBe(false);
  });

  it('resolves instructions from the bulk endpoint and fetches it only once', async () => {
    const { source, requests } = catalog((url) =>
      url.includes('/api/v1/')
        ? listPayload
        : [
            { slug: 'api-designer', systemPrompt: '  Follow REST conventions.  ' },
            { slug: 'blank', systemPrompt: '   ' },
            { nonsense: true },
          ],
    );

    expect(await source.instructions(entry)).toEqual({
      body: 'Follow REST conventions.',
      origin: 'catalog',
    });
    expect(await source.instructions(entry)).toEqual({
      body: 'Follow REST conventions.',
      origin: 'catalog',
    });
    expect(await source.instructions({ ...entry, slug: 'blank' })).toBeNull();
    expect(await source.instructions({ ...entry, slug: 'missing' })).toBeNull();
    expect(requests.filter((url) => url.endsWith('/api/skills'))).toHaveLength(1);
  });

  it('reads a real SKILL.md when the directory only repeats the description', async () => {
    const repositoryEntry: SkillCatalogEntry = {
      ...entry,
      sourceUrl: 'https://github.com/example/skills/tree/main/skills/api-designer',
    };
    const { source, textRequests } = catalog(
      () => [{ slug: entry.slug, systemPrompt: entry.description }],
      (url) =>
        url.endsWith('/SKILL.md')
          ? '---\nname: api-designer\ndescription: Design APIs\n---\n\nFollow REST conventions.'
          : null,
    );

    await expect(source.instructions(repositoryEntry)).resolves.toEqual({
      body: 'Follow REST conventions.',
      origin: 'repository',
      url: 'https://raw.githubusercontent.com/example/skills/main/skills/api-designer/SKILL.md',
    });
    expect(textRequests).toEqual([
      'https://raw.githubusercontent.com/example/skills/main/skills/api-designer/SKILL.md',
    ]);
  });

  it('does not hide a repository outage as a skill without instructions', async () => {
    const { source } = catalog(
      () => [{ slug: entry.slug, systemPrompt: entry.description }],
      () => new Error('network down'),
    );

    await expect(
      source.instructions({ ...entry, sourceUrl: 'https://github.com/example/skills' }),
    ).rejects.toThrow('network down');
  });

  it('keeps the catalog description visible when no repository document exists', async () => {
    const { source, textRequests } = catalog(() => [
      { slug: entry.slug, systemPrompt: entry.description },
    ]);

    await expect(
      source.instructions({ ...entry, sourceUrl: 'https://github.com/example/skills' }),
    ).resolves.toEqual({ body: entry.description, origin: 'catalog' });
    expect(textRequests.length).toBeGreaterThan(0);
  });

  it('shares one in-flight bulk request between concurrent imports', async () => {
    const { source, requests } = catalog(() => [
      { slug: 'api-designer', systemPrompt: 'Follow REST conventions.' },
    ]);

    const [first, second] = await Promise.all([
      source.instructions(entry),
      source.instructions(entry),
    ]);

    expect(first).toEqual(second);
    expect(requests).toHaveLength(1);
  });

  it('reports a failing catalog instead of returning an empty page', async () => {
    const { source } = catalog(
      () => new Error('The skill catalog answered 503 Service Unavailable.'),
    );

    await expect(source.browse({})).rejects.toThrow('503 Service Unavailable');
  });

  it('refuses an unreadable bulk payload rather than importing nothing silently', async () => {
    const { source } = catalog(() => ({ notAnArray: true }));

    await expect(source.instructions(entry)).rejects.toThrow('unreadable instruction list');
  });

  it('retries the bulk endpoint after a failure instead of caching the error', async () => {
    let attempt = 0;
    const { source } = catalog(() => {
      attempt += 1;
      return attempt === 1
        ? new Error('network down')
        : [{ slug: 'api-designer', systemPrompt: 'Follow REST conventions.' }];
    });

    await expect(source.instructions(entry)).rejects.toThrow('network down');
    expect(await source.instructions(entry)).toEqual({
      body: 'Follow REST conventions.',
      origin: 'catalog',
    });
  });

  it('names the real catalog it talks to', () => {
    const { source } = catalog(() => listPayload);
    expect(source.descriptor()).toEqual({
      id: 'skillsplayground',
      name: 'Skills Playground',
      homeUrl: 'https://skillsplayground.com',
    });
    expect(source.categories()).toContain('frontend');
  });

  it('checks the exact imported document and preserves moved-source provenance', async () => {
    const { source, textRequests } = catalog(
      () => [],
      (url) => (url === 'https://raw.example/SKILL.md' ? null : 'New instructions.'),
    );
    await expect(
      source.readImportedSource({
        kind: 'imported',
        catalogId: 'skillsplayground',
        catalogName: 'Skills Playground',
        slug: 'api-designer',
        sourceUrl: 'https://raw.example/SKILL.md',
        repositoryUrl: 'https://github.com/example/skills/tree/main/skills/api-designer',
        importedAt: 'now',
      }),
    ).resolves.toMatchObject({ text: 'New instructions.', moved: true });
    expect(textRequests[0]).toBe('https://raw.example/SKILL.md');
  });

  it('reports a deleted source without inventing replacement text', async () => {
    const { source } = catalog(
      () => [],
      () => null,
    );
    await expect(
      source.readImportedSource({
        kind: 'imported',
        catalogId: 'catalog',
        catalogName: 'Catalog',
        slug: 'missing',
        sourceUrl: 'https://raw.example/SKILL.md',
        importedAt: 'now',
      }),
    ).resolves.toEqual({ text: null, moved: true });
  });
});
