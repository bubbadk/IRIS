import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProjectResults, requireUnchangedProjectCheckEvidence } from '@iris/workflows';
import { createDocument } from '@iris/workspaces';
import { createProjectResultChecker } from './projectResultChecks';
const doc = createDocument({
  id: 'doc',
  title: 'Brief',
  format: 'text',
  revision: {
    id: 'rev',
    content: 'Actual saved content',
    createdAt: new Date().toISOString(),
    author: { kind: 'user', id: 'user', name: 'User' },
  },
});
describe('desktop result check adapter', () => {
  it('rejects changed-but-passing and deleted real files at final acceptance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'iris-review-evidence-'));
    const path = join(root, 'result.txt');
    try {
      await writeFile(path, 'First nonempty deliverable');
      const reader = createProjectResultChecker(
        { list: async () => [] },
        {
          // Exercise actual disk reads and the production hash adapter. Native path protection
          // has separate Rust tests; this isolated reader grants access only to this fixture.
          readForCheck: async (requestedRoot, relativePath) => {
            expect(requestedRoot).toBe(root);
            expect(relativePath).toBe('result.txt');
            try {
              const content = await readFile(path, 'utf8');
              return {
                relativePath,
                content,
                bytesRead: Buffer.byteLength(content),
                truncated: false,
              };
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
              throw error;
            }
          },
        },
      );
      const checks = [
        {
          id: 'real-file',
          target: { kind: 'workspace-file' as const, rootPath: root, path: 'result.txt' },
          assertion: 'nonempty' as const,
        },
      ];
      const at = new Date().toISOString();
      const previous = await checkProjectResults(checks, reader, 'turn', at);
      const unchanged = await checkProjectResults(checks, reader, 'turn', at);
      expect(() =>
        requireUnchangedProjectCheckEvidence(checks, previous, unchanged, 'turn', at),
      ).not.toThrow();
      await writeFile(path, 'A different but still nonempty deliverable');
      const changed = await checkProjectResults(checks, reader, 'turn', at);
      expect(changed.results[0]?.status).toBe('passed');
      expect(() =>
        requireUnchangedProjectCheckEvidence(checks, previous, changed, 'turn', at),
      ).toThrow('changed after');
      await unlink(path);
      const deleted = await checkProjectResults(checks, reader, 'turn', at);
      expect(() =>
        requireUnchangedProjectCheckEvidence(checks, previous, deleted, 'turn', at),
      ).toThrow('does not exist');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('uses the actual document revision and refuses ambiguous titles', async () => {
    const docs = [doc];
    const reader = createProjectResultChecker({ list: async () => docs });
    await expect(reader.read({ kind: 'document', title: 'Brief' })).resolves.toEqual({
      content: 'Actual saved content',
      evidence: 'Document doc, revision 1 (rev).',
    });
    await expect(reader.read({ kind: 'document', title: 'Missing' })).resolves.toBeNull();
    docs.push({ ...doc, id: 'duplicate' });
    await expect(reader.read({ kind: 'document', title: 'Brief' })).rejects.toThrow(
      'Several documents',
    );
  });
  it('never passes a truncated file and records a reproducible content hash', async () => {
    let truncated = true;
    const reader = createProjectResultChecker(
      { list: async () => [] },
      {
        readForCheck: async (root, path) => {
          expect(root).toBe('/project');
          expect(path).toBe('brief.txt');
          return { relativePath: path, content: 'abc', bytesRead: 3, truncated };
        },
      },
    );
    const target = { kind: 'workspace-file' as const, rootPath: '/project', path: 'brief.txt' };
    await expect(reader.read(target)).rejects.toThrow('full content was not checked');
    truncated = false;
    expect((await reader.read(target))?.evidence).toContain(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
