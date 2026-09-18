// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '@iris/core';

/**
 * F-1H release-blocker coverage: the REAL production fresh-install path.
 *
 * The existing onboarding suite mocks `./persistence` with a non-empty agent list, so the
 * default-team creation branch never executed — which is how the stale preset IDs
 * (`workspace.directory`, `host.inspect`) reached a green suite. Here only the provider,
 * workspace-mount and credential side effects are stubbed: the wizard's default-team branch runs
 * against the real repositories, the real tool registry and the real preset factory.
 */
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
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(async () => ({})),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
  message: vi.fn(async () => undefined),
  ask: vi.fn(async () => false),
  confirm: vi.fn(async () => false),
}));
vi.mock('./workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace')>()),
  mountWorkspace,
}));
vi.mock('./credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./credentials')>()),
  saveProviderSecrets,
  resolveProviderConnection,
}));

// Production registration order, exactly as the app bootstrap performs it: `tooling` registers
// every tool except delegation; `agentRuntime` registers the delegation tools at module scope.
import './tooling';
import './agentRuntime';
import { OnboardingWizard, ONBOARDING_COMPLETED_KEY } from './OnboardingWizard';
import { LocalAgentRepository } from './persistence';
import { toolRegistry } from './toolRegistry';
import { standardWorkspaceTools } from './agentPresets';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function clickNamed(container: HTMLElement, label: string) {
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(label))!
      .click(),
  );
}

describe('fresh install creates and can re-read the default agent team', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', memoryStorage());
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

  it('persists only canonical registered tool IDs and lists the team after a restart', async () => {
    const onFinish = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<OnboardingWizard darkMode={false} onFinish={onFinish} />));

    await act(async () => setValue(container.querySelector('#provider-api-key')!, 'test-key'));
    await clickNamed(container, 'Next: Workspace');
    await clickNamed(container, 'Next: Agent Team');
    await clickNamed(container, 'Launch IRIS');

    expect(onFinish).toHaveBeenCalledOnce();
    expect(globalThis.localStorage.getItem(ONBOARDING_COMPLETED_KEY)).toBe('true');

    const raw = globalThis.localStorage.getItem('iris.agents.config.v2');
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!) as AgentDefinition[];
    expect(persisted).toHaveLength(3);
    for (const agent of persisted) {
      expect(agent.toolIds.length).toBeGreaterThan(0);
      for (const toolId of agent.toolIds) {
        expect(toolRegistry.get(toolId), `${agent.name} references ${toolId}`).toBeDefined();
      }
    }
    expect(raw).not.toContain('workspace.directory');
    expect(raw).not.toContain('host.inspect');

    // Restart: a new repository instance over the same durable storage must read the team.
    const restarted = new LocalAgentRepository(globalThis.localStorage, toolRegistry);
    const listed = await restarted.list();
    expect(listed).toHaveLength(3);
    const coordinator = listed.find((agent) => agent.autonomy === 'operate');
    expect(coordinator?.toolIds).toEqual([...standardWorkspaceTools]);
    expect(toolRegistry.get('system.inspect-host')).toBeDefined();

    await act(async () => root.unmount());
  });
});
