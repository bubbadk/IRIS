import { describe, expect, it, vi } from 'vitest';
import { checkProjectResults, validProjectChecks, type ProjectResultCheck } from './resultChecks';
const check: ProjectResultCheck = {
  id: 'check',
  target: { kind: 'document', title: 'Brief' },
  assertion: 'contains',
  expected: 'Summary',
};
describe('independent result checks', () => {
  it('checks actual content, not the worker report, and shares a snapshot across assertions', async () => {
    const read = vi.fn(async () => ({ content: 'summary', evidence: 'revision-1' }));
    const report = await checkProjectResults(
      [check, { ...check, id: 'nonempty', assertion: 'nonempty', expected: undefined }],
      { read },
      'turn',
      new Date().toISOString(),
    );
    expect(report.results.map((result) => result.status)).toEqual(['failed', 'passed']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(report.results[0]?.evidence).toBe('revision-1');
  });
  it('distinguishes missing and malformed content from unavailable checking', async () => {
    const json: ProjectResultCheck = { ...check, assertion: 'json', expected: undefined };
    const run = (read?: () => Promise<{ content: string; evidence: string } | null>) =>
      checkProjectResults([json], read ? { read } : undefined, 'turn', new Date().toISOString());
    expect((await run(async () => null)).results[0]?.status).toBe('failed');
    expect(
      (await run(async () => ({ content: '{broken', evidence: 'rev' }))).results[0]?.status,
    ).toBe('failed');
    expect(
      (await run(async () => ({ content: '{"real":true}', evidence: 'rev' }))).results[0]?.status,
    ).toBe('passed');
    expect((await run()).results[0]?.status).toBe('error');
    expect(
      (
        await run(async () => {
          throw new Error('Storage offline');
        })
      ).results[0]?.message,
    ).toBe('Storage offline');
  });
  it('rejects malformed checks, duplicate IDs, traversal, empty matches and oversized lists', () => {
    expect(validProjectChecks([check])).toBe(true);
    expect(validProjectChecks([check, check])).toBe(false);
    expect(validProjectChecks([{ ...check, expected: '' }])).toBe(false);
    expect(
      validProjectChecks(Array.from({ length: 9 }, (_, i) => ({ ...check, id: `${i}` }))),
    ).toBe(false);
    for (const path of ['/etc/passwd', '../other', 'a/../b', 'a\\b', 'a//b'])
      expect(
        validProjectChecks([
          { ...check, target: { kind: 'workspace-file', rootPath: '/project', path } },
        ]),
      ).toBe(false);
  });
});
