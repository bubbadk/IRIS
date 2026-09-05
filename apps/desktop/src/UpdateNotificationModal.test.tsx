// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateNotificationModal } from './UpdateNotificationModal';

const { check, install, relaunch, close } = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  relaunch: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch }));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const release = {
  version: '0.2.11',
  name: 'IRIS 0.2.11',
  notes: '## Changes\n- **Fixed** concurrent writes and preserved conversation history.',
  publishedAt: '',
  url: 'https://github.com/bubbadk/IRIS/releases/tag/v0.2.11',
};

describe('update installation UI', () => {
  it('shows readable notes and rejects a changed target without download or dismissal', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    check.mockResolvedValue({ version: '0.2.12', downloadAndInstall: install, close });
    const dismiss = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <UpdateNotificationModal release={release} onDismiss={dismiss} darkMode={false} />,
      ),
    );
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).not.toContain('##');
    await act(async () =>
      (container.querySelector('.update-btn-primary') as HTMLButtonElement).click(),
    );
    expect(container.textContent).toContain('target changed to 0.2.12');
    expect(install).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
  it('explains unsigned release metadata without downloading or restarting', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    check.mockResolvedValue({
      version: release.version,
      rawJson: {
        platforms: { 'linux-x86_64': { signature: '', url: 'https://example.test/iris.tar.gz' } },
      },
      downloadAndInstall: install,
      close,
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <UpdateNotificationModal release={release} onDismiss={() => {}} darkMode={false} />,
      ),
    );
    await act(async () =>
      (container.querySelector('.update-btn-primary') as HTMLButtonElement).click(),
    );
    expect(container.textContent).toContain('does not provide a signed update package');
    expect(install).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
});
