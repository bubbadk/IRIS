import { beforeEach, describe, expect, it } from 'vitest';
import fixture from './__fixtures__/modelsDevCatalog.json';
import {
  createProviderConfig,
  refreshProviderCatalog,
  refreshProviderModels,
  type ProviderCatalogEntry,
  type ProviderConfig,
} from './index';
import {
  catalogModelsFromDirectory,
  catalogModelsFromIds,
  chatSelectableModelIds,
  classifyModel,
  compareModelIds,
  dedupeModelIds,
  defaultChatModelState,
  embeddingModelIds,
  imageSelectableModelIds,
  NO_COMPATIBLE_CHAT_MODEL,
  normalizedModelIds,
  parseModelMetadata,
  selectDefaultChatModel,
  type CatalogModel,
  type ModelMetadataRecord,
} from './modelCatalog';

/**
 * M-27 / M-28 regression suite. All model metadata comes from the pinned
 * `__fixtures__/modelsDevCatalog.json` snapshot (captured from models.dev): no test here reads the
 * live directory, and no test consumes a real provider API. Parsing/capability tests run against
 * synthetic records; policy tests run against the pinned fixture.
 */

beforeEach(() => {
  const values = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
});

async function pinnedCatalog(): Promise<ProviderCatalogEntry[]> {
  return refreshProviderCatalog(
    async () => new Response(JSON.stringify(fixture), { status: 200 }),
  );
}

function entryFor(catalog: ProviderCatalogEntry[], id: string): ProviderCatalogEntry {
  const entry = catalog.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`fixture provider missing: ${id}`);
  return entry;
}

function models(records: Record<string, ModelMetadataRecord>): CatalogModel[] {
  return catalogModelsFromDirectory(records);
}

describe('M-27 — provider default selection is capability-aware', () => {
  it('reproduces the original hazard: the image model is still alphabetically first', async () => {
    const catalog = await pinnedCatalog();
    const openai = entryFor(catalog, 'openai');
    // Before the fix this position decided the default, which made the OpenAI default
    // `chatgpt-image-latest` — an image generation model (output text+image, tool_call false).
    expect(openai.models?.[0]).toBe('chatgpt-image-latest');
  });

  it('never preselects the alphabetically first image model through the production path', async () => {
    const catalog = await pinnedCatalog();
    const config = createProviderConfig(entryFor(catalog, 'openai'));
    expect(config.model).not.toBe('chatgpt-image-latest');
    expect(config.model).toBe('gpt-4.1');
    const classification = classifyModel({
      id: config.model,
      metadata: config.modelMetadata?.[config.model],
    });
    expect(classification.chatSelectable).toBe(true);
    expect(classification.imageSelectable).toBe(false);
    // The selected model must actually exist in the provider's catalog.
    expect(config.availableModels).toContain(config.model);
  });

  it('chooses chat when a provider lists chat and image models', () => {
    const list = models({
      'vendor-image-flagship': {
        modalities: { input: ['text'], output: ['image'] },
        tool_call: false,
      },
      'vendor-chat-standard': {
        modalities: { input: ['text', 'image'], output: ['text'] },
        tool_call: true,
      },
    });
    expect(selectDefaultChatModel(list)).toBe('vendor-chat-standard');
  });

  it('chooses chat even when the image model sorts first alphabetically', () => {
    const list = models({
      'aaa-image-model': {
        modalities: { input: ['text'], output: ['text', 'image'] },
        tool_call: false,
      },
      'zzz-chat-model': {
        modalities: { input: ['text'], output: ['text'] },
        tool_call: true,
      },
    });
    // `aaa-image-model` is first in the raw list, yet it must not become the default.
    expect(list[0].id).toBe('aaa-image-model');
    expect(selectDefaultChatModel(list)).toBe('zzz-chat-model');
  });

  it('reports the controlled no-compatible-chat-model state for image-only providers', () => {
    const list = models({
      'image-one': { modalities: { input: ['text'], output: ['text', 'image'] }, tool_call: false },
      'image-two': { modalities: { input: ['text'], output: ['image'] }, tool_call: false },
    });
    expect(selectDefaultChatModel(list)).toBe('');
    expect(defaultChatModelState(list)).toEqual({
      model: '',
      message: NO_COMPATIBLE_CHAT_MODEL,
    });
    expect(chatSelectableModelIds(list)).toEqual([]);
    expect(imageSelectableModelIds(list)).toEqual(['image-one', 'image-two']);
  });

  it('chooses the chat model when a provider mixes embeddings and chat', () => {
    const list = models({
      'text-embedding-3-small': {
        modalities: { input: ['text'], output: ['text'] },
        tool_call: false,
      },
      'gpt-4o-mini': { modalities: { input: ['text'], output: ['text'] }, tool_call: true },
    });
    expect(selectDefaultChatModel(list)).toBe('gpt-4o-mini');
    expect(embeddingModelIds(list)).toEqual(['text-embedding-3-small']);
  });

  it('accepts a vision-capable chat model as default when it is conversational', () => {
    const list = models({
      'vendor-vision-chat': {
        modalities: { input: ['text', 'image'], output: ['text'] },
        tool_call: true,
        reasoning: true,
      },
    });
    expect(selectDefaultChatModel(list)).toBe('vendor-vision-chat');
    expect(classifyModel(list[0]).visionChatSelectable).toBe(true);
    expect(classifyModel(list[0]).capabilities).toContain('vision-input');
  });

  it('uses the documented conservative fallback when model metadata is missing', () => {
    // No metadata: an unknown identifier stays selectable (never hidden) and is not blocked just
    // because it is absent from a list written earlier.
    const unknown = catalogModelsFromIds(['vendor-future-chat-9']);
    expect(classifyModel(unknown[0]).chatSelectable).toBe(true);
    expect(selectDefaultChatModel(unknown)).toBe('vendor-future-chat-9');

    // No metadata and a recognized specialized family: still visible/selectable, but never the
    // automatic default, and a provider with only such ids gets the controlled state.
    const imageOnly = catalogModelsFromIds(['black-forest-labs/flux-1-schnell', 'dall-e-3']);
    expect(chatSelectableModelIds(imageOnly)).toEqual([
      'black-forest-labs/flux-1-schnell',
      'dall-e-3',
    ]);
    expect(selectDefaultChatModel(imageOnly)).toBe('');
    expect(defaultChatModelState(imageOnly).message).toBe(NO_COMPATIBLE_CHAT_MODEL);

    // Metadata without a modality block is treated as absent evidence, not as "not chat".
    const recordWithoutModalities = models({ 'vendor-mystery': { reasoning: true } });
    expect(recordWithoutModalities[0].metadata?.hasModalityMetadata).toBe(false);
    expect(classifyModel(recordWithoutModalities[0]).chatSelectable).toBe(true);
  });

  it('is deterministic: the same catalog always yields the same default', () => {
    const list = models({
      'z-chat': { modalities: { input: ['text'], output: ['text'] }, tool_call: true },
      'a-chat': { modalities: { input: ['text'], output: ['text'] }, tool_call: true },
      'm-chat': { modalities: { input: ['text'], output: ['text'] }, tool_call: true },
    });
    const first = selectDefaultChatModel(list);
    for (let run = 0; run < 5; run += 1) expect(selectDefaultChatModel(list)).toBe(first);
    expect(first).toBe('a-chat');
  });

  it('prefers a trusted provider-recommended default over positional order', () => {
    const list = models({
      'a-chat': { modalities: { input: ['text'], output: ['text'] }, tool_call: true },
      'b-chat': { modalities: { input: ['text'], output: ['text'] }, tool_call: true },
    });
    expect(selectDefaultChatModel(list, { defaultModelId: 'b-chat' })).toBe('b-chat');
    // An incompatible recommendation is ignored rather than trusted blindly.
    const withImage = models({
      'a-chat': { modalities: { input: ['text'], output: ['text'] }, tool_call: true },
      'a-image': { modalities: { input: ['text'], output: ['image'] }, tool_call: false },
    });
    expect(selectDefaultChatModel(withImage, { defaultModelId: 'a-image' })).toBe('a-chat');
  });

  it('never defaults to a deprecated model', () => {
    const list = models({
      'a-deprecated-chat': {
        modalities: { input: ['text'], output: ['text'] },
        tool_call: true,
        status: 'deprecated',
      },
      'b-current-chat': { modalities: { input: ['text'], output: ['text'] }, tool_call: true },
    });
    expect(selectDefaultChatModel(list)).toBe('b-current-chat');
    expect(classifyModel(list[0]).defaultEligible).toBe(false);
    // Deprecated models stay in the catalog; they are simply not a default.
    expect(chatSelectableModelIds(list)).toContain('a-deprecated-chat');
  });

  it('ranks experimental models below stable ones without hiding them', () => {
    const list = models({
      'a-experimental-chat': {
        modalities: { input: ['text'], output: ['text'] },
        tool_call: true,
        experimental: { modes: { fast: {} } },
      },
      'z-stable-chat': { modalities: { input: ['text'], output: ['text'] }, tool_call: true },
    });
    expect(selectDefaultChatModel(list)).toBe('z-stable-chat');
    expect(chatSelectableModelIds(list)).toHaveLength(2);
  });
});

describe('M-28 — one catalog policy, no stale hardcoded allow-lists', () => {
  it('keeps every DeepSeek model the directory publishes', async () => {
    const catalog = await pinnedCatalog();
    const deepseek = entryFor(catalog, 'deepseek');
    expect(deepseek.models).toEqual([
      'deepseek-flash',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro',
    ]);
    // The previous implementation filtered this list down to deepseek-flash and deepseek-v4-pro.
    expect(deepseek.models).toContain('deepseek-v4-flash');
    expect(deepseek.models).toContain('deepseek-v4-flash-vision-exp');
    const config = createProviderConfig(deepseek);
    expect(config.model).toBe('deepseek-flash');
    expect(config.availableModels).toEqual(deepseek.models);
  });

  it('classifies the DeepSeek vision/chat variant as conversational vision chat', async () => {
    const catalog = await pinnedCatalog();
    const config = createProviderConfig(entryFor(catalog, 'deepseek'));
    const vision = classifyModel({
      id: 'deepseek-v4-flash-vision-exp',
      metadata: config.modelMetadata?.['deepseek-v4-flash-vision-exp'],
    });
    expect(vision.chatSelectable).toBe(true);
    expect(vision.visionChatSelectable).toBe(true);
    expect(vision.imageSelectable).toBe(false);
  });

  it('keeps an unknown future chat model visible when its metadata is valid', () => {
    const list = models({
      'vendor-brand-new-model-2027': {
        name: 'Brand New 2027',
        modalities: { input: ['text', 'image'], output: ['text'] },
        tool_call: true,
        reasoning: true,
        release_date: '2027-01-01',
      },
    });
    expect(chatSelectableModelIds(list)).toEqual(['vendor-brand-new-model-2027']);
    expect(selectDefaultChatModel(list)).toBe('vendor-brand-new-model-2027');
  });

  it('de-duplicates model ids deterministically and keeps display entries unique', () => {
    expect(dedupeModelIds(['b', 'a', 'b', '  a  ', '', 'c'])).toEqual(['b', 'a', 'c']);
    expect(normalizedModelIds(['b', 'a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(new Set(normalizedModelIds(['gpt-4o', 'gpt-4o', 'gpt-4.1'])).size).toBe(2);
  });

  it('orders model ids by code point so the same catalog is identical everywhere', () => {
    expect(normalizedModelIds(['gpt-4o', 'gpt-4.1', 'gpt-4.1-mini'])).toEqual([
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o',
    ]);
    expect(compareModelIds('a', 'b')).toBeLessThan(0);
    expect(compareModelIds('b', 'a')).toBeGreaterThan(0);
    expect(compareModelIds('a', 'a')).toBe(0);
  });

  it('parses only the metadata fields the policy relies on', () => {
    const metadata = parseModelMetadata('probe', {
      name: ' Probe ',
      family: 'probe-family',
      reasoning: true,
      tool_call: true,
      attachment: true,
      status: 'deprecated',
      experimental: true,
      release_date: '2026-01-02',
      modalities: { input: ['TEXT', 'Image'], output: ['text'] },
    });
    expect(metadata).toMatchObject({
      id: 'probe',
      name: 'Probe',
      family: 'probe-family',
      reasoning: true,
      toolCall: true,
      attachment: true,
      deprecated: true,
      experimental: true,
      releaseDate: '2026-01-02',
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      hasModalityMetadata: true,
    });
    // A record without a modality block reports no modality evidence.
    expect(parseModelMetadata('probe', { reasoning: true }).hasModalityMetadata).toBe(false);
    expect(parseModelMetadata('probe', undefined).hasModalityMetadata).toBe(false);
  });
});

describe('M-27 — live provider discovery uses the same policy', () => {
  const config: ProviderConfig = {
    id: 'discovery-provider',
    name: 'Discovery provider',
    kind: 'openai-compatible',
    endpoint: 'https://api.example.test/v1',
    model: 'retired-model',
    enabled: true,
  };

  function discover(ids: string[]): Promise<ProviderConfig> {
    return refreshProviderModels(
      config,
      async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) })),
    );
  }

  it('never adopts the alphabetically first image model when the stored model retires', async () => {
    const refreshed = await discover(['chatgpt-image-latest', 'gpt-4.1']);
    expect(refreshed.model).toBe('gpt-4.1');
    // A live list carries no metadata, so the refreshed configuration must not pretend it has some.
    expect(refreshed.modelMetadata).toBeUndefined();
  });

  it('reports a controlled empty selection when the live list has only image models', async () => {
    const refreshed = await discover(['dall-e-3', 'flux-dev']);
    expect(refreshed.availableModels).toEqual(['dall-e-3', 'flux-dev']);
    expect(refreshed.model).toBe('');
  });

  it('keeps a stored model that the provider still reports', async () => {
    const refreshed = await refreshProviderModels(
      { ...config, model: 'gpt-4.1' },
      async () => new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1' }] })),
    );
    expect(refreshed.model).toBe('gpt-4.1');
  });
});
