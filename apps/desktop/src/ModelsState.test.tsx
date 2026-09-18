// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as actualProviders from '@iris/providers';
import type { ProviderConfig } from '@iris/providers';

/**
 * §25: the Models surface must show compatible models, must not hide real catalog entries, and must
 * never preselect an incompatible model. The component reads the shared catalog classification — it
 * has no model list of its own — so these tests drive the real classification through the real
 * component while stubbing only storage, secrets and network.
 */

const state = vi.hoisted(() => ({
  providers: [] as unknown[],
  saved: [] as unknown[],
}));

vi.mock('@iris/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@iris/providers')>();
  return {
    ...actual,
    loadProviderConfigs: () => state.providers,
    saveProviderConfigs: (configs: unknown[]) => {
      state.saved.push(configs);
    },
    refreshProviderCatalog: async () => actual.providerCatalog,
    refreshProviderModels: async (config: unknown) => config,
    testProviderConnection: async () => undefined,
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => false }));

vi.mock('./credentials', () => ({
  deleteProviderSecrets: vi.fn(),
  isTauriRuntime: () => false,
  loadProviderSecrets: async () => null,
  resolveProviderConnection: async (config: unknown) => config,
  saveProviderSecrets: async () => false,
}));

vi.mock('./ChatContent', () => ({ formatMemoryDate: (value: string) => value }));

import { ModelsState } from './ModelsState';

const imageMetadata = actualProviders.parseModelMetadata('chatgpt-image-latest', {
  name: 'chatgpt-image-latest',
  tool_call: false,
  modalities: { input: ['text', 'image'], output: ['text', 'image'] },
});
const chatMetadata = actualProviders.parseModelMetadata('vendor-chat-standard', {
  name: 'Vendor Chat Standard',
  tool_call: true,
  modalities: { input: ['text'], output: ['text'] },
});
const futureMetadata = actualProviders.parseModelMetadata('vendor-brand-new-2027', {
  name: 'Vendor Brand New 2027',
  tool_call: true,
  modalities: { input: ['text', 'image'], output: ['text'] },
});

function providerConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-1',
    name: 'Example provider',
    kind: 'openai-compatible',
    endpoint: 'https://api.example.test/v1',
    model: 'vendor-chat-standard',
    availableModels: ['chatgpt-image-latest', 'vendor-chat-standard'],
    modelMetadata: {
      'chatgpt-image-latest': imageMetadata,
      'vendor-chat-standard': chatMetadata,
    },
    enabled: true,
    connectionFields: [{ id: 'apiKey', label: 'API key', required: true, secret: true }],
    ...overrides,
  };
}

async function render(): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ModelsState />);
  });
  return container;
}

async function openEditor(container: HTMLElement): Promise<void> {
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Edit')!
      .click();
  });
}

function draftSelect(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector('.provider-editor select') as HTMLSelectElement | null;
  if (!select) throw new Error('draft model select not rendered');
  return select;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.providers = [];
  state.saved = [];
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Models surface model compatibility', () => {
  it('preselects the chat model and keeps the image model visible but not selected', async () => {
    state.providers = [providerConfig()];
    const container = await render();
    await openEditor(container);

    const select = draftSelect(container);
    expect(select.value).toBe('vendor-chat-standard');
    const options = [...select.querySelectorAll('option')].map((option) => option.value);
    expect(options).toContain('vendor-chat-standard');
    // Not hidden: the image model is offered, grouped as not chat-compatible.
    expect(options).toContain('chatgpt-image-latest');
    const groups = [...select.querySelectorAll('optgroup')].map((group) => group.label);
    expect(groups).toEqual(['Chat models', 'Not chat-compatible']);
  });

  it('shows the controlled no-compatible-chat-model state instead of preselecting an image model', async () => {
    state.providers = [
      providerConfig({
        model: '',
        availableModels: ['chatgpt-image-latest', 'gpt-image-1'],
        modelMetadata: {
          'chatgpt-image-latest': imageMetadata,
          'gpt-image-1': actualProviders.parseModelMetadata('gpt-image-1', {
            modalities: { input: ['text'], output: ['image'] },
            tool_call: false,
          }),
        },
      }),
    ];
    const container = await render();

    // The provider row reports the controlled state truthfully rather than inventing a model.
    expect(container.textContent).toContain('no compatible chat model');
    await openEditor(container);
    expect(container.textContent).toContain(
      "No compatible chat model was found in this provider's catalog",
    );
    const options = [...draftSelect(container).querySelectorAll('option')].map(
      (option) => option.value,
    );
    // Both image models are still listed for a user who knows better; neither is selected.
    expect(options).toEqual(expect.arrayContaining(['chatgpt-image-latest', 'gpt-image-1']));
  });

  it('shows an unknown future chat model that has valid metadata', async () => {
    state.providers = [
      providerConfig({
        model: 'vendor-brand-new-2027',
        availableModels: ['vendor-brand-new-2027'],
        modelMetadata: { 'vendor-brand-new-2027': futureMetadata },
      }),
    ];
    const container = await render();
    await openEditor(container);
    const select = draftSelect(container);
    expect(select.value).toBe('vendor-brand-new-2027');
    expect([...select.querySelectorAll('option')].map((option) => option.value)).toContain(
      'vendor-brand-new-2027',
    );
  });

  it('keeps DeepSeek directory models selectable without a hardcoded list', async () => {
    const deepseekModels = [
      'deepseek-flash',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro',
    ];
    const deepseekMetadata = Object.fromEntries(
      deepseekModels.map((id) => [
        id,
        actualProviders.parseModelMetadata(id, {
          name: id,
          tool_call: true,
          reasoning: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
        }),
      ]),
    );
    state.providers = [
      providerConfig({
        name: 'DeepSeek',
        model: 'deepseek-flash',
        availableModels: deepseekModels,
        modelMetadata: deepseekMetadata,
      }),
    ];
    const container = await render();
    await openEditor(container);
    const select = draftSelect(container);
    expect(select.value).toBe('deepseek-flash');
    expect([...select.querySelectorAll('option')].map((option) => option.value)).toEqual(
      expect.arrayContaining(deepseekModels),
    );
  });
});
