import { describe, expect, it, vi } from 'vitest';
import {
  createImageGenerationTool,
  type ImageGenerationInput,
  type ImageGenerationOutput,
  type ImageProviderBinding,
} from './imageTools';
import { createWebExtractTool, type WebExtractInput } from './webTools';

const context = { agentId: 'agent-1', agentName: 'Operator' };

/** A trusted openai binding: endpoint and credential come from the same provider configuration. */
function openAiBinding(apiKey: string): ImageProviderBinding {
  return {
    configurationId: 'config-openai',
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    apiKey,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function schemaProperties(tool: {
  inputSchema?: Record<string, unknown>;
}): Record<string, unknown> {
  return (tool.inputSchema as { properties: Record<string, unknown> }).properties;
}

/**
 * F-01 regression coverage: credentials must never be model-controlled. Tool arguments are
 * untrusted model output, so an `apiKey` sent there has no authority and must be rejected before any
 * network call, while the trusted resolver stays the only credential source.
 */
describe('tool arguments are not credential authority', () => {
  it('does not expose an apiKey field in the image generation schema', () => {
    expect(Object.keys(schemaProperties(createImageGenerationTool()))).not.toContain('apiKey');
  });

  it('does not expose an apiKey field in the web extract schema', () => {
    expect(Object.keys(schemaProperties(createWebExtractTool()))).not.toContain('apiKey');
  });

  it('rejects a model-supplied apiKey and never reaches a provider', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ url: 'https://cdn.example/i.png' }] }),
    );
    const tool = createImageGenerationTool(fetchMock, async () => openAiBinding('trusted-key'));

    await expect(
      tool.run(
        {
          prompt: 'An ivory desk',
          provider: 'openai',
          apiKey: 'ATTACKER_KEY',
        } as unknown as ImageGenerationInput,
        context,
      ),
    ).rejects.toThrow(/must not carry credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the trusted resolver credential for the provider request', async () => {
    const authorization: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      authorization.push(String((init?.headers as Record<string, string>)?.Authorization));
      return jsonResponse({ data: [{ url: 'https://cdn.example/i.png' }] });
    });
    const tool = createImageGenerationTool(fetchMock, async (provider) =>
      provider === 'openai' ? openAiBinding('trusted-openai-key') : undefined,
    );

    const result = (await tool.run(
      { prompt: 'An ivory desk', provider: 'openai' },
      context,
    )) as ImageGenerationOutput;

    expect(result.status).toBe('completed');
    expect(authorization).toEqual(['Bearer trusted-openai-key']);
  });

  it('uses the rotated credential after the trusted store changes', async () => {
    let key = 'first-key';
    const authorization: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      authorization.push(String((init?.headers as Record<string, string>)?.Authorization));
      return jsonResponse({ data: [{ url: 'https://cdn.example/i.png' }] });
    });
    const tool = createImageGenerationTool(fetchMock, async () => openAiBinding(key));

    await tool.run({ prompt: 'An ivory desk', provider: 'openai' }, context);
    key = 'rotated-key';
    await tool.run({ prompt: 'An ivory desk', provider: 'openai' }, context);

    expect(authorization).toEqual(['Bearer first-key', 'Bearer rotated-key']);
  });

  it('reports a missing trusted credential as a controlled error without any request', async () => {
    const fetchMock = vi.fn();
    const tool = createImageGenerationTool(fetchMock, async () => undefined);

    await expect(
      tool.run({ prompt: 'An ivory desk', provider: 'openai' }, context),
    ).rejects.toThrow(/No openai credential is configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the credential out of the tool result', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ data: [{ url: 'https://cdn.example/i.png' }] }),
    );
    const tool = createImageGenerationTool(fetchMock, async () => openAiBinding('trusted-openai-key'));

    const result = await tool.run({ prompt: 'An ivory desk', provider: 'openai' }, context);

    expect(JSON.stringify(result)).not.toContain('trusted-openai-key');
  });

  it('rejects a model-supplied apiKey on web.extract without any request', async () => {
    const fetchMock = vi.fn();
    const tool = createWebExtractTool(fetchMock);

    await expect(
      tool.run(
        { url: 'https://example.com/docs', apiKey: 'ATTACKER_KEY' } as unknown as WebExtractInput,
        context,
      ),
    ).rejects.toThrow(/must not carry credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still extracts a page when no credential field is present', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('<html><head><title>Docs</title></head><body><p>Hello</p></body></html>', {
          status: 200,
        }),
    );
    const tool = createWebExtractTool(fetchMock);

    const result = (await tool.run({ url: 'https://example.com/docs' }, context)) as {
      title: string;
      markdown: string;
    };

    expect(result.title).toBe('Docs');
    expect(result.markdown).toContain('Hello');
  });
});
