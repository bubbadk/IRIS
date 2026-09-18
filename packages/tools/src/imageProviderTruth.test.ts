import { describe, expect, it, vi } from 'vitest';
import {
  createImageGenerationTool,
  imageProviderForUrl,
  type ImageGenerationOutput,
  type ImageProviderBinding,
} from './imageTools';

const context = { agentId: 'agent-1', agentName: 'Operator' };

/**
 * Trusted bindings shaped exactly like the ones the host layer builds from stored provider
 * configuration: endpoint and credential belong to the same configuration, which is what a fake
 * resolver must reproduce for the tool's destination to be meaningful.
 */
function openAiBinding(apiKey: string): ImageProviderBinding {
  return {
    configurationId: 'config-openai',
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    apiKey,
  };
}

function openRouterBinding(apiKey: string): ImageProviderBinding {
  return {
    configurationId: 'config-openrouter',
    provider: 'openrouter',
    endpoint: 'https://openrouter.ai/api/v1',
    apiKey,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status = 200): Response {
  return new Response(null, { status });
}

/**
 * M-32: a successful result must come from the provider that served it. These tests never touch a
 * live API — every request goes through a fake fetch, and credentials come from a fake resolver.
 */
describe('image provider identity is truthful', () => {
  it('reports the actual OpenRouter provider on success and never calls Pollinations', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return jsonResponse({
        choices: [{ message: { content: 'Here you go: https://cdn.example/art.png' } }],
      });
    });
    const tool = createImageGenerationTool(fetchMock, async (provider) =>
      provider === 'openrouter' ? openRouterBinding('trusted-openrouter-key') : undefined,
    );

    const result = (await tool.run(
      { prompt: 'An ivory desk', provider: 'openrouter', model: 'vendor/image-model' },
      context,
    )) as ImageGenerationOutput;

    expect(result.status).toBe('completed');
    expect(result.actualProvider).toBe('openrouter');
    expect(result.actualModel).toBe('vendor/image-model');
    expect(result.requestedProvider).toBe('openrouter');
    expect(result.requestedModel).toBe('vendor/image-model');
    expect(result.providerFallback).toBe(false);
    expect(result.url).toBe('https://cdn.example/art.png');
    expect(result.providerOrigin).toBe('https://openrouter.ai');
    expect(calls).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
    expect(calls.some((url) => url.includes('pollinations'))).toBe(false);
  });

  it('fails with the OpenRouter error instead of falling back to Pollinations', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return jsonResponse({ error: { message: 'upstream unavailable' } }, 502);
    });
    const tool = createImageGenerationTool(fetchMock, async () =>
      openRouterBinding('trusted-openrouter-key'),
    );

    await expect(
      tool.run({ prompt: 'An ivory desk', provider: 'openrouter' }, context),
    ).rejects.toThrow(/OpenRouter image request failed .*502.*No fallback provider was used/s);
    expect(calls).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
  });

  it('fails as an invalid provider response when OpenRouter returns 200 without an image', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return jsonResponse({ choices: [{ message: { content: 'I cannot draw that.' } }] });
    });
    const tool = createImageGenerationTool(fetchMock, async () =>
      openRouterBinding('trusted-openrouter-key'),
    );

    await expect(
      tool.run({ prompt: 'An ivory desk', provider: 'openrouter' }, context),
    ).rejects.toThrow(/OpenRouter returned no usable image output.*No fallback provider was used/s);
    expect(calls).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
  });

  it('fails as a controlled configuration error when the OpenRouter credential is missing', async () => {
    const fetchMock = vi.fn();
    const tool = createImageGenerationTool(fetchMock, async () => undefined);

    await expect(
      tool.run({ prompt: 'An ivory desk', provider: 'openrouter' }, context),
    ).rejects.toThrow(/No openrouter credential is configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to relabel an image served by a different provider', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return jsonResponse({
        choices: [
          {
            message: {
              content: 'https://image.pollinations.ai/prompt/a-desk.png?width=1024',
            },
          },
        ],
      });
    });
    const tool = createImageGenerationTool(fetchMock, async () =>
      openRouterBinding('trusted-openrouter-key'),
    );

    await expect(
      tool.run({ prompt: 'An ivory desk', provider: 'openrouter' }, context),
    ).rejects.toThrow(/served by pollinations.*will not relabel/s);
    // Critically, it did not then call the Pollinations gateway itself.
    expect(calls).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
  });

  it('serves Pollinations truthfully when Pollinations is explicitly selected', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return emptyResponse(200);
    });
    const tool = createImageGenerationTool(fetchMock, async () => openAiBinding('unused-key'));

    const result = (await tool.run(
      { prompt: 'An ivory desk', provider: 'pollinations' },
      context,
    )) as ImageGenerationOutput;

    expect(result.status).toBe('completed');
    expect(result.actualProvider).toBe('pollinations');
    expect(result.actualModel).toBe('pollinations/flux');
    expect(result.requestedProvider).toBe('pollinations');
    expect(result.url).toContain('image.pollinations.ai');
    expect(calls.every((url) => url.includes('pollinations'))).toBe(true);
  });

  it('never switches provider across repeated calls (retry containment)', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return jsonResponse({ error: 'nope' }, 429);
    });
    const tool = createImageGenerationTool(fetchMock, async () =>
      openRouterBinding('trusted-openrouter-key'),
    );

    await expect(
      tool.run({ prompt: 'first', provider: 'openrouter' }, context),
    ).rejects.toThrow(/No fallback provider was used/);
    await expect(
      tool.run({ prompt: 'second', provider: 'openrouter' }, context),
    ).rejects.toThrow(/No fallback provider was used/);

    expect(calls).toEqual([
      'https://openrouter.ai/api/v1/chat/completions',
      'https://openrouter.ai/api/v1/chat/completions',
    ]);
  });

  it('auto selects one provider up front and reports it truthfully', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return jsonResponse({ data: [{ url: 'https://cdn.example/auto.png' }] });
    });
    const tool = createImageGenerationTool(fetchMock, async (provider) =>
      provider === 'openai' ? openAiBinding('trusted-openai-key') : undefined,
    );

    const result = (await tool.run({ prompt: 'An ivory desk' }, context)) as ImageGenerationOutput;

    expect(result.requestedProvider).toBe('auto');
    expect(result.actualProvider).toBe('openai');
    expect(result.providerOrigin).toBe('https://api.openai.com');
    expect(result.status).toBe('completed');
    expect(calls).toEqual(['https://api.openai.com/v1/images/generations']);
  });

  it('auto uses the keyless gateway only when no keyed credential exists, and says so', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return emptyResponse(200);
    });
    const tool = createImageGenerationTool(fetchMock, async () => undefined);

    const result = (await tool.run({ prompt: 'An ivory desk' }, context)) as ImageGenerationOutput;

    expect(result.actualProvider).toBe('pollinations');
    expect(result.requestedProvider).toBe('auto');
    expect(result.providerFallback).toBe(false);
    expect(calls.every((url) => url.includes('pollinations'))).toBe(true);
  });

  it('fails as a controlled error when a provider returns an unreadable body', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return new Response('<html>gateway error</html>', { status: 200 });
    });
    const tool = createImageGenerationTool(fetchMock, async () =>
      openRouterBinding('trusted-openrouter-key'),
    );

    await expect(
      tool.run({ prompt: 'An ivory desk', provider: 'openrouter' }, context),
    ).rejects.toThrow(/Image generation failed/);
    expect(calls).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
  });

  it('recognises which provider a returned URL belongs to', () => {
    expect(imageProviderForUrl('https://image.pollinations.ai/prompt/x')).toBe('pollinations');
    expect(imageProviderForUrl('https://api.openai.com/v1/images/1')).toBe('openai');
    expect(imageProviderForUrl('https://cdn.example/art.png')).toBeUndefined();
    expect(imageProviderForUrl('not-a-url')).toBeUndefined();
  });
});
