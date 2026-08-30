import { describe, expect, it } from 'vitest';
import { displayedAgentModel, selectableAgentModels } from './agentModelSelection';

describe('agent model selection', () => {
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
