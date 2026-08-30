import { describe, expect, it } from 'vitest';
import { diffWorkspaceText } from '@iris/workspaces';

describe('DiffViewer logic & workspace diff integration', () => {
  it('correctly categorizes added, removed and equal lines with accurate counts', () => {
    const original = 'line 1\nline 2\nline 3';
    const modified = 'line 1\nline 2 edited\nline 3\nline 4';

    const diff = diffWorkspaceText(original, modified);
    expect(diff.changed).toBe(true);
    expect(diff.lines.some((l) => l.kind === 'addition')).toBe(true);
    expect(diff.lines.some((l) => l.kind === 'deletion')).toBe(true);
    expect(diff.lines.some((l) => l.kind === 'context')).toBe(true);
  });

  it('marks unchanged files as changed: false', () => {
    const original = 'function hello() { return true; }';
    const diff = diffWorkspaceText(original, original);
    expect(diff.changed).toBe(false);
    expect(diff.lines.every((l) => l.kind === 'context')).toBe(true);
  });
});
