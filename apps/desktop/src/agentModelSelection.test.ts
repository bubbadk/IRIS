import { describe, expect, it } from 'vitest';
import { parseModelMetadata, NO_COMPATIBLE_CHAT_MODEL } from '@iris/providers';
import {
  catalogAgentModels,
  displayProviderModelName,
  displayedAgentModel,
  providerChatModelState,
  selectableAgentModels,
} from './agentModelSelection';

describe('agent model selection', () => {
  it('shows DeepSeek V4.1 Flash while preserving the API model identifier', () => {
    expect(displayProviderModelName('deepseek-flash')).toBe('DeepSeek V4.1 Flash');
    expect(displayProviderModelName('deepseek-v4-pro')).toBe('deepseek-v4-pro');
  });
  it('exposes every discovered model instead of only the provider default', () => {
    expect(
      selectableAgentModels({
        model: 'deepseek-v4-flash',
        availableModels: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-vision'],
      }),
    ).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-vision']);
  });

  it('keeps the manual provider model available without discovery', () => {
    expect(selectableAgentModels({ model: 'deepseek-chat' })).toEqual(['deepseek-chat']);
  });

  it('displays an agent override with a provider-default fallback for existing agents', () => {
    const providers = [{ id: 'deepseek', model: 'deepseek-v4-flash' }];
    expect(
      displayedAgentModel({ providerPolicyId: 'deepseek', model: 'deepseek-v4-pro' }, providers),
    ).toBe('deepseek-v4-pro');
    expect(displayedAgentModel({ providerPolicyId: 'deepseek' }, providers)).toBe(
      'deepseek-v4-flash',
    );
  });
});

describe('agent model selection uses the shared capability catalog', () => {
  const metadata = {
    'chatgpt-image-latest': parseModelMetadata('chatgpt-image-latest', {
      modalities: { input: ['text', 'image'], output: ['text', 'image'] },
      tool_call: false,
    }),
    'gpt-4.1': parseModelMetadata('gpt-4.1', {
      modalities: { input: ['text'], output: ['text'] },
      tool_call: true,
    }),
    'text-embedding-3-small': parseModelMetadata('text-embedding-3-small', {
      modalities: { input: ['text'], output: ['text'] },
      tool_call: false,
    }),
    'vendor-future-chat': parseModelMetadata('vendor-future-chat', {
      modalities: { input: ['text'], output: ['text'] },
      tool_call: true,
    }),
  };

  it('offers chat models and hides only models that positively cannot chat', () => {
    expect(
      selectableAgentModels({
        model: 'gpt-4.1',
        availableModels: [
          'chatgpt-image-latest',
          'gpt-4.1',
          'text-embedding-3-small',
          'vendor-future-chat',
        ],
        modelMetadata: metadata,
      }),
    ).toEqual(['gpt-4.1', 'vendor-future-chat']);
  });

  it('keeps a stored non-chat selection visible instead of lying about the configuration', () => {
    expect(
      selectableAgentModels({
        model: 'chatgpt-image-latest',
        availableModels: ['chatgpt-image-latest', 'gpt-4.1'],
        modelMetadata: metadata,
      }),
    ).toEqual(['gpt-4.1', 'chatgpt-image-latest']);
  });

  it('exposes every advertised model for callers that need the full catalog', () => {
    expect(
      catalogAgentModels({
        model: 'gpt-4.1',
        availableModels: ['chatgpt-image-latest', 'gpt-4.1', 'gpt-4.1'],
      }),
    ).toEqual(['chatgpt-image-latest', 'gpt-4.1']);
  });

  it('reports the controlled state for a provider with no chat-compatible model', () => {
    expect(
      providerChatModelState({
        model: '',
        availableModels: ['chatgpt-image-latest', 'text-embedding-3-small'],
        modelMetadata: metadata,
      }),
    ).toEqual({ model: '', message: NO_COMPATIBLE_CHAT_MODEL });
  });

  it('prefers the directory display name when metadata provides one', () => {
    expect(displayProviderModelName('deepseek-flash')).toBe('DeepSeek V4.1 Flash');
    expect(
      displayProviderModelName(
        'deepseek-flash',
        parseModelMetadata('deepseek-flash', { name: 'DeepSeek V4.1 Flash' }),
      ),
    ).toBe('DeepSeek V4.1 Flash');
  });
});
