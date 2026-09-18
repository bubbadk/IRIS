// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDocument,
  documentByteLimit,
  documentTitleLimit,
  utf8ByteLength,
} from '@iris/workspaces';
import { createDocumentTools } from './documentTools';
import { LocalDocumentRepository } from './documents';

function schemaProperty(toolId: string, property: string): Record<string, unknown> {
  const tool = createDocumentTools().find((candidate) => candidate.id === toolId)!;
  const properties = tool.inputSchema!.properties as Record<string, Record<string, unknown>>;
  return properties[property]!;
}
const context = { agentId: 'writer', agentName: 'Writer', turnId: 'turn-1' };
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    key: (index: number) => [...values.keys()][index] ?? null,
  } satisfies Storage);
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});
describe('agent document tools', () => {
  it('saves actual content with provenance, reads it and refuses a stale revision', async () => {
    const tools = createDocumentTools();
    const run = (id: string, input: unknown) =>
      tools.find((tool) => tool.id === id)!.run(input, context);
    const created = (await run('documents.create', {
      title: 'Deliverable',
      format: 'markdown',
      content: '# Actual content',
    })) as { id: string; revisionId: string };
    const saved = await new LocalDocumentRepository().get(created.id);
    expect(saved?.revisions[0].author).toEqual({
      kind: 'agent',
      id: 'writer',
      name: 'Writer',
      turnId: 'turn-1',
    });
    expect(saved?.revisions[0].content).toBe('# Actual content');
    expect(await run('documents.read', { id: created.id })).toMatchObject({
      id: created.id,
      revisionId: created.revisionId,
      content: '# Actual content',
    });
    await run('documents.revise', {
      id: created.id,
      expectedRevisionId: created.revisionId,
      content: '# Improved',
    });
    await expect(
      run('documents.revise', {
        id: created.id,
        expectedRevisionId: created.revisionId,
        content: '# Stale',
      }),
    ).rejects.toThrow('newer revision');
    expect(await run('documents.list', {})).toEqual([
      expect.objectContaining({ id: created.id, revision: 2 }),
    ]);
    expect(tools.filter((tool) => tool.risk === 'write').map((tool) => tool.id)).toEqual([
      'documents.create',
      'documents.revise',
    ]);
  });
  it('reports invalid content without manufacturing a saved document', async () => {
    await expect(
      createDocumentTools()[0].run({ title: 'Broken', format: 'json', content: '{bad' }, context),
    ).rejects.toThrow();
    expect(await new LocalDocumentRepository().list()).toEqual([]);
  });
});

describe('M-19 tool and domain size semantics', () => {
  const context = { agentId: 'writer', agentName: 'Writer', turnId: 'turn-1' };
  const domainAccepts = (content: string) => {
    try {
      createDocument({
        id: `probe-${content.length}-${utf8ByteLength(content)}`,
        title: 'Probe',
        format: 'markdown',
        revision: {
          id: 'revision',
          content,
          createdAt: '2026-09-08T10:00:00Z',
          author: { kind: 'user', id: 'user', name: 'You' },
        },
      });
      return true;
    } catch {
      return false;
    }
  };
  const toolAccepts = async (content: string) => {
    try {
      await createDocumentTools()
        .find((tool) => tool.id === 'documents.create')!
        .run({ title: 'Probe', format: 'markdown', content }, context);
      return true;
    } catch {
      return false;
    }
  };

  it('agrees with domain validation at every byte boundary and encoding family', async () => {
    const families: [string, string][] = [
      ['ascii', 'a'],
      ['danish', 'æøå'],
      ['emoji', '😀'],
      ['CJK', '文'],
      ['combining', 'e\u0301'],
    ];
    for (const [label, unit] of families) {
      const at = Math.floor(documentByteLimit / utf8ByteLength(unit));
      const cases: [string, string][] = [
        [`${label} under limit`, unit.repeat(at - 1)],
        [`${label} exactly at the byte limit`, unit.repeat(at)],
        [`${label} one code point over the byte limit`, unit.repeat(at + 1)],
      ];
      for (const [name, content] of cases) {
        const domain = domainAccepts(content);
        expect(await toolAccepts(content), name).toBe(domain);
      }
      // The interesting case: valid under `maxLength` but rejected by the byte authority.
      if (utf8ByteLength(unit) > 1) {
        const overCharacterSafe = unit.repeat(at + 1);
        expect(Array.from(overCharacterSafe).length).toBeLessThanOrEqual(documentByteLimit);
        expect(domainAccepts(overCharacterSafe)).toBe(false);
      }
    }
  });

  it('never claims a byte limit it cannot express in the model-facing schema', () => {
    const content = schemaProperty('documents.create', 'content');
    const title = schemaProperty('documents.create', 'title');
    expect(content.maxLength).toBe(documentByteLimit);
    expect(String(content.description)).toContain(`${documentByteLimit} UTF-8 bytes`);
    // The title is human text, so its limit really is a character count.
    expect(title.maxLength).toBe(documentTitleLimit);
    expect(String(title.description)).toContain(`${documentTitleLimit} characters`);
    expect(String(createDocumentTools()[0].description)).toContain(
      `${documentByteLimit} UTF-8 bytes`,
    );
  });
});
