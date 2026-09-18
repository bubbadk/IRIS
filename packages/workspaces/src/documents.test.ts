import { describe, expect, it } from 'vitest';
import {
  createDocument,
  reviseDocument,
  validateDocument,
  documentFilename,
  documentByteLimit,
  documentTitleLimit,
  unicodeLength,
  utf8ByteLength,
  requireDocumentContent,
} from './documents';
const input = {
  id: 'doc',
  title: 'Report',
  format: 'markdown' as const,
  revision: {
    id: 'r1',
    content: '# First',
    createdAt: '2026-09-08T10:00:00Z',
    author: { kind: 'user' as const, id: 'user', name: 'You' },
  },
};
describe('durable documents', () => {
  it('retains immutable content and provenance through revision and restoration', () => {
    const first = createDocument(input);
    const second = reviseDocument(first, 'r1', {
      ...input.revision,
      id: 'r2',
      content: '# Revised',
      author: { kind: 'agent', id: 'agent', name: 'Writer', turnId: 'turn' },
    });
    const restored = reviseDocument(second, 'r2', { ...input.revision, id: 'r3' });
    expect(first.revisions).toHaveLength(1);
    expect(restored.revisions.map((r) => r.content)).toEqual(['# First', '# Revised', '# First']);
    expect(restored.revisions[1].author.turnId).toBe('turn');
    restored.revisions[0].content = 'Changed outside';
    expect(first.revisions[0].content).toBe('# First');
  });
  it('rejects stale writes, duplicate revision identities and malformed saved data', () => {
    const doc = createDocument(input);
    expect(() =>
      reviseDocument(doc, 'old', { ...input.revision, id: 'r2', content: 'Changed' }),
    ).toThrow('newer revision');
    expect(() => reviseDocument(doc, 'r1', { ...input.revision, content: 'Changed' })).toThrow(
      'invalid',
    );
    expect(validateDocument({ ...doc, revisions: [null] })).toBe(false);
    expect(validateDocument({ ...doc, revisions: [{ ...doc.revisions[0], number: 2 }] })).toBe(
      false,
    );
  });
  it('validates UTF-8 size and JSON before saving', () => {
    expect(() =>
      createDocument({
        ...input,
        format: 'json',
        revision: { ...input.revision, content: '{broken' },
      }),
    ).toThrow('invalid JSON');
    expect(() =>
      createDocument({
        ...input,
        revision: { ...input.revision, content: 'ø'.repeat(documentByteLimit / 2 + 1) },
      }),
    ).toThrow(`${documentByteLimit} UTF-8 bytes`);
  });
  it('reports the exact byte size it rejected so Unicode mismatches are never silent', () => {
    try {
      createDocument({
        ...input,
        revision: { ...input.revision, content: 'æ'.repeat(documentByteLimit / 2 + 1) },
      });
      expect.unreachable('the oversized document must be refused');
    } catch (failure) {
      expect((failure as Error).message).toContain(`${documentByteLimit + 2} bytes`);
      expect((failure as Error).message).toContain(`${documentByteLimit} UTF-8 bytes`);
    }
  });
  it('retains all history at the revision cap and ignores unchanged content', () => {
    let doc = createDocument(input);
    for (let n = 2; n <= 50; n++)
      doc = reviseDocument(doc, `r${n - 1}`, {
        ...input.revision,
        id: `r${n}`,
        content: `Revision ${n}`,
      });
    expect(
      reviseDocument(doc, 'r50', { ...input.revision, id: 'unchanged', content: 'Revision 50' })
        .revisions,
    ).toHaveLength(50);
    expect(() =>
      reviseDocument(doc, 'r50', { ...input.revision, id: 'r51', content: 'Another' }),
    ).toThrow('history is retained');
    expect(doc.revisions[0].content).toBe('# First');
  });
  it('creates a filename without path separators or control characters', () => {
    expect(documentFilename({ title: '../Report\u0000/test', format: 'markdown' })).toBe(
      '-Report--test.md',
    );
  });
});

describe('M-19 document size semantics', () => {
  const withContent = (content: string) =>
    createDocument({ ...input, revision: { ...input.revision, content } });
  const withTitle = (title: string) => createDocument({ ...input, title });

  it('uses UTF-8 bytes as the authority for document content', () => {
    const ascii = 'a'.repeat(documentByteLimit);
    expect(utf8ByteLength(ascii)).toBe(documentByteLimit);
    expect(ascii.length).toBe(documentByteLimit);
    expect(() => withContent(ascii)).not.toThrow();
    expect(() => withContent('a'.repeat(documentByteLimit + 1))).toThrow('UTF-8 bytes');
  });

  it('rejects one byte over the limit for every encoding family', () => {
    const families: [string, string][] = [
      ['ascii', 'a'],
      ['danish', 'ø'],
      ['emoji', '😀'],
      ['CJK', '文'],
      ['combining', 'e\u0301'],
    ];
    for (const [label, unit] of families) {
      const unitBytes = utf8ByteLength(unit);
      const at = Math.floor(documentByteLimit / unitBytes);
      const exact = unit.repeat(at);
      expect(utf8ByteLength(exact), label).toBeLessThanOrEqual(documentByteLimit);
      expect(() => withContent(exact), `${label} at limit`).not.toThrow();
      // Exactly one code point more must cross the limit and be refused.
      expect(() => withContent(unit.repeat(at + 1)), `${label} one over`).toThrow('UTF-8 bytes');
    }
  });

  it('accepts the same non-ASCII payload the tool layer accepts', () => {
    const content = 'ø'.repeat(documentByteLimit / 2);
    expect(unicodeLength(content)).toBe(documentByteLimit / 2);
    expect(() => withContent(content)).not.toThrow();
    expect(() => requireDocumentContent(content, 'markdown')).not.toThrow();
    expect(() => withContent(`${content}ø`)).toThrow('UTF-8 bytes');
    expect(() => requireDocumentContent(`${content}ø`, 'markdown')).toThrow('UTF-8 bytes');
  });

  it('measures the title in code points, not UTF-16 code units', () => {
    expect(() => withTitle('a'.repeat(documentTitleLimit))).not.toThrow();
    expect(() => withTitle('a'.repeat(documentTitleLimit + 1))).toThrow(
      `${documentTitleLimit} characters`,
    );
    // 180 astral characters are 360 UTF-16 code units but only 180 characters.
    const emojiTitle = '😀'.repeat(documentTitleLimit);
    expect(emojiTitle.length).toBe(documentTitleLimit * 2);
    expect(unicodeLength(emojiTitle)).toBe(documentTitleLimit);
    const doc = withTitle(emojiTitle);
    expect(doc.title).toBe(emojiTitle);
    expect(validateDocument(doc)).toBe(true);
    expect(() => withTitle('😀'.repeat(documentTitleLimit + 1))).toThrow(
      `${documentTitleLimit} characters`,
    );
  });

  it('never splits a surrogate pair when building an export filename', () => {
    const filename = documentFilename({ title: '😀'.repeat(200), format: 'text' });
    expect(filename.endsWith('.txt')).toBe(true);
    expect(filename).not.toContain('\uFFFD');
    // 100 whole code points survive; no lone surrogate remains in the result.
    expect(Array.from(filename.slice(0, -4))).toHaveLength(100);
    const lone = Array.from(filename).filter((character) => {
      const code = character.codePointAt(0)!;
      return code >= 0xd800 && code <= 0xdfff;
    });
    expect(lone).toEqual([]);
  });
});
