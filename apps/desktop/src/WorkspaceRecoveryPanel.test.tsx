// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRecoveryPanel } from './WorkspaceRecoveryPanel';
const { list, isolation, preview, restore } = vi.hoisted(() => ({
  list: vi.fn(),
  isolation: vi.fn(),
  preview: vi.fn(),
  restore: vi.fn(),
}));
vi.mock('./workspaceRecovery', () => ({
  workspaceRecovery: { list, isolation, preview, restore },
}));
vi.mock('./workspace', () => ({
  subscribeWorkspace: () => () => {},
  notifyWorkspaceChanged: vi.fn(),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
const point = { id: 'restore-1', path: 'report.txt', state: 'ready', createdAtMs: 1 };

describe('workspace recovery controls', () => {
  it('previews before restoring and keeps a stale-file rejection visible', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    list.mockResolvedValue([point]);
    isolation.mockResolvedValue({
      available: false,
      detail: 'Isolation is unavailable on this test host.',
    });
    preview.mockResolvedValue({ summary: point, before: null, after: 'Created report' });
    restore.mockRejectedValue(new Error('The file changed since this edit.'));
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<WorkspaceRecoveryPanel />));
    expect(container.textContent).toContain('Shell isolation unavailable');
    expect(container.textContent).toContain('Shell commands, moves and deletions are not covered');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Review restore')!
        .click(),
    );
    expect(restore).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Restoring will remove it');
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('✓ Restore'))!
        .click(),
    );
    expect(restore).toHaveBeenCalledWith('restore-1');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('file changed');
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it('does not offer restore for a file containing newer work', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    list.mockResolvedValue([{ ...point, state: 'conflict' }]);
    isolation.mockResolvedValue({ available: true, detail: 'Verified by test probe.' });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<WorkspaceRecoveryPanel />));
    expect(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Review restore',
      )!.disabled,
    ).toBe(true);
    expect(container.textContent).toContain('Changed since this edit');
    await act(async () => root.unmount());
  });
});
