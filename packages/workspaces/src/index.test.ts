import { describe, expect, it } from 'vitest';
import {
  requireWorkspaceFileContent,
  requireWorkspaceQuery,
  requireWorkspaceRelativePath,
  diffWorkspaceText,
  validateWorkspaceMount,
} from './index';

describe('workspace domain boundaries', () => {
  it('accepts only durable mount records', () => {
    expect(
      validateWorkspaceMount({
        version: 1,
        id: 'workspace-1',
        name: 'IRIS',
        rootPath: '/home/user/IRIS',
        connectedAt: '2026-08-27T12:00:00.000Z',
        verifiedAt: '2026-08-27T12:00:00.000Z',
      }),
    ).toBe(true);
    expect(validateWorkspaceMount({ version: 1, rootPath: '' })).toBe(false);
  });

  it('normalizes relative paths and rejects traversal or absolute paths', () => {
    expect(requireWorkspaceRelativePath('./src/main.ts')).toBe('src/main.ts');
    expect(requireWorkspaceRelativePath('src\\main.ts')).toBe('src/main.ts');
    expect(() => requireWorkspaceRelativePath('../secret')).toThrow('inside');
    expect(() => requireWorkspaceRelativePath('/etc/passwd')).toThrow('inside');
    expect(() => requireWorkspaceRelativePath('C:\\Users\\secret')).toThrow('inside');
  });

  it('requires a bounded non-empty search query', () => {
    expect(requireWorkspaceQuery('  permission  ')).toBe('permission');
    expect(() => requireWorkspaceQuery('')).toThrow('requires a query');
    expect(() => requireWorkspaceQuery('x'.repeat(201))).toThrow('too long');
  });

  it('accepts bounded UTF-8 file content and rejects non-text or oversized writes', () => {
    expect(requireWorkspaceFileContent('Hej IRIS')).toBe('Hej IRIS');
    expect(requireWorkspaceFileContent('')).toBe('');
    expect(() => requireWorkspaceFileContent({ content: 'no' })).toThrow('must be text');
    expect(() => requireWorkspaceFileContent('ø'.repeat(6), 10)).toThrow('write limit');
  });

  it('produces an explicit bounded line diff for previews', () => {
    expect(diffWorkspaceText('one\ntwo\n', 'one\nthree\n')).toMatchObject({
      changed: true,
      truncated: false,
      lines: [
        { kind: 'context', text: '  one' },
        { kind: 'addition', text: '+ three' },
        { kind: 'deletion', text: '- two' },
        { kind: 'context', text: '  ' },
      ],
    });
    expect(diffWorkspaceText('a\nb', 'a\nb', 1)).toEqual({
      changed: false,
      lines: [{ kind: 'context', text: '  a' }],
      truncated: true,
    });
  });
});
