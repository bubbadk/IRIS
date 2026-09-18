// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  saveProviderConfigs,
  loadProviderConfigs,
  mountWorkspace,
  saveProviderSecrets,
  refreshProviderModels,
  resolveProviderConnection,
} = vi.hoisted(() => ({
  saveProviderConfigs: vi.fn(),
  loadProviderConfigs: vi.fn(() => []),
  mountWorkspace: vi.fn(),
  saveProviderSecrets: vi.fn(),
  refreshProviderModels: vi.fn(),
  resolveProviderConnection: vi.fn(),
}));

vi.mock('@iris/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@iris/providers')>();
  return {
    ...actual,
    saveProviderConfigs,
    loadProviderConfigs,
    // Never reach a live provider during onboarding tests.
    refreshProviderModels,
  };
});
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('./workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace')>()),
  mountWorkspace,
}));
vi.mock('./credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./credentials')>()),
  saveProviderSecrets,
  resolveProviderConnection,
}));
vi.mock('./persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./persistence')>()),
  agentRepository: { list: vi.fn(async () => [{}]) },
}));

import { OnboardingWizard } from './OnboardingWizard';

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('onboarding persistence', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    saveProviderSecrets.mockResolvedValue(true);
    mountWorkspace.mockResolvedValue(undefined);
    resolveProviderConnection.mockImplementation(async (config: unknown) => config);
    refreshProviderModels.mockImplementation(async (config: unknown) => config);
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function complete(container: HTMLElement) {
    await act(async () => setValue(container.querySelector('#provider-api-key')!, 'test-key'));
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Next: Workspace'))!
        .click(),
    );
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Next: Agent Team'))!
        .click(),
    );
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Launch IRIS'))!
        .click(),
    );
  }

  it('stores a cloud key before saving the public provider configuration', async () => {
    const onFinish = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<OnboardingWizard darkMode={false} onFinish={onFinish} />));
    await complete(container);
    expect(saveProviderSecrets).toHaveBeenCalledWith(expect.stringMatching(/^openrouter-/), {
      apiKey: 'test-key',
    });
    expect(saveProviderConfigs).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'openai-compatible',
        storedSecretFields: ['apiKey'],
        connectionValues: undefined,
      }),
    ]);
    expect(onFinish).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });

  it('writes no hardcoded model name and adopts the provider-discovered default', async () => {
    refreshProviderModels.mockImplementation(async (config: Record<string, unknown>) => ({
      ...config,
      // The provider's own list: an image model sorts first, a chat model must still win.
      availableModels: ['chatgpt-image-latest', 'vendor-real-chat'],
      model: 'vendor-real-chat',
      modelsRefreshedAt: '2026-01-01T00:00:00.000Z',
    }));
    const onFinish = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<OnboardingWizard darkMode={false} onFinish={onFinish} />));
    await complete(container);

    const saved = (saveProviderConfigs.mock.calls[0] as unknown[][])[0][0] as {
      model: string;
      availableModels?: string[];
    };
    expect(saved.model).toBe('vendor-real-chat');
    expect(saved.availableModels).toEqual(['chatgpt-image-latest', 'vendor-real-chat']);
    await act(async () => root.unmount());
  });

  it('never fabricates a model name when discovery is unavailable', async () => {
    refreshProviderModels.mockRejectedValue(new Error('offline'));
    const onFinish = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<OnboardingWizard darkMode={false} onFinish={onFinish} />));
    await complete(container);

    const saved = (saveProviderConfigs.mock.calls[0] as unknown[][])[0][0] as { model: string };
    expect(saved.model).toBe('');
    expect(onFinish).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });

  it('does not save an unverified workspace or provider after a mount error', async () => {
    mountWorkspace.mockRejectedValue(new Error('Folder is unavailable.'));
    const onFinish = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<OnboardingWizard darkMode={false} onFinish={onFinish} />));
    await act(async () => setValue(container.querySelector('#provider-api-key')!, 'test-key'));
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Next: Workspace'))!
        .click(),
    );
    await act(async () =>
      setValue(container.querySelector('#workspace-folder')!, '/missing-workspace'),
    );
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Next: Agent Team'))!
        .click(),
    );
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Launch IRIS'))!
        .click(),
    );
    expect(saveProviderSecrets).not.toHaveBeenCalled();
    expect(saveProviderConfigs).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Folder is unavailable.');
    await act(async () => root.unmount());
  });
});
