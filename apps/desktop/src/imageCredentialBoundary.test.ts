/**
 * H1 regression coverage — cross-provider image credential disclosure.
 *
 * Invariant under test: a credential resolved for provider configuration P is never transmitted to
 * a network origin that P does not authorize. Concretely, a credential stored for an OpenAI-catalog
 * configuration whose endpoint is a custom gateway must reach that gateway and never
 * `api.openai.com`.
 *
 * This drives the *real* production path, not a helper:
 *   provider configuration store (packages/providers, real localStorage document)
 *     -> apps/desktop/src/tooling imageProviderBindingResolver (the real, unexported resolver used by
 *        the registered `image.generate` tool)
 *     -> apps/desktop/src/credentials resolveProviderConnection (real precedence contract)
 *     -> packages/tools imageTools run() -> outbound HTTP request (intercepted; nothing leaves the
 *        machine and no real endpoint is contacted)
 *
 * `fetch` is replaced before `./tooling` is evaluated because the tool captures its fetch reference
 * at registration time.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderConfig, saveProviderConfigs, type ProviderConfig } from '@iris/providers';
import { saveProviderSecrets } from './credentials';
import { permissionRuleRepository } from './persistence';
import type { agentToolRuntime as AgentToolRuntime } from './tooling';

const OPENAI_NATIVE_SECRET = 'SENTINEL_OPENAI_NATIVE_2I1';
const GATEWAY_SECRET = 'SENTINEL_GATEWAY_SECRET_2I1';
const SECOND_GATEWAY_SECRET = 'SENTINEL_SECOND_GATEWAY_SECRET_2I1';
const STALE_PLAINTEXT_SECRET = 'SENTINEL_STALE_PLAINTEXT_2I1';
const KEYRING_SECRET = 'SENTINEL_KEYRING_2I1';

const OPENAI_ORIGIN = 'https://api.openai.com';
const OPENAI_ENDPOINT = `${OPENAI_ORIGIN}/v1`;
const GATEWAY_ENDPOINT = 'http://127.0.0.1:9/selfhosted-litellm-gateway/v1';
const SECOND_GATEWAY_ENDPOINT = 'http://127.0.0.1:8/second-gateway/v1';

interface CapturedRequest {
  url: string;
  authorization?: string;
}

let captured: CapturedRequest[] = [];
let runtime: typeof AgentToolRuntime;
/**
 * Provider ids are unique per test. `saveProviderSecrets` keys the trusted session store by
 * provider id for the whole file, so reusing an id would let an earlier test's credential leak into
 * a later one and make the isolation assertions meaningless.
 */
let idSequence = 0;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
}

// Records the exact destination and Authorization header, then answers with a successful
// OpenAI-shaped payload served from a neutral host that belongs to no known image provider.
const interceptingFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
  const headers = new Headers(init?.headers);
  captured.push({ url: href, authorization: headers.get('authorization') ?? undefined });
  return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/h1-boundary.png' }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

beforeAll(async () => {
  globalThis.localStorage = memoryStorage();
  globalThis.fetch = interceptingFetch as unknown as typeof fetch;
  ({ agentToolRuntime: runtime } = await import('./tooling'));
});

beforeEach(() => {
  captured = [];
  interceptingFetch.mockClear();
  idSequence += 1;
  globalThis.localStorage = memoryStorage();
});

function configWith(label: string, endpoint: string): ProviderConfig {
  const config = createProviderConfig('openai');
  // The label stays in the id so ordering assertions mean the same thing in every run.
  config.id = `openai-${idSequence}-${label}`;
  config.endpoint = endpoint;
  return config;
}

/** Invokes the real registered `image.generate` tool through the real agent tool runtime. */
async function generateImage(agentId: string, provider: 'openai' | 'auto' = 'openai') {
  await permissionRuleRepository.save({
    id: `allow-image-${agentId}`,
    agentId,
    toolId: 'image.generate',
    decision: 'allow',
  });
  return runtime.execute(
    {
      id: agentId,
      name: 'Designer',
      autonomy: 'act' as const,
      skillIds: [],
      toolIds: ['image.generate'],
    },
    'image_generate',
    { prompt: 'a boundary cube', provider },
    { turnId: `turn-${agentId}`, toolCallId: `call-${agentId}` },
  );
}

function requestsToOrigin(origin: string): CapturedRequest[] {
  return captured.filter((request) => {
    try {
      return new URL(request.url).origin === origin;
    } catch {
      return false;
    }
  });
}

function requestsCarrying(secret: string): CapturedRequest[] {
  return captured.filter((request) => request.authorization === `Bearer ${secret}`);
}

describe('image credentials never cross a provider origin boundary', () => {
  it('Case A: a real OpenAI configuration reaches OpenAI with its own credential', async () => {
    const openai = configWith('native', OPENAI_ENDPOINT);
    saveProviderConfigs([openai]);
    await saveProviderSecrets(openai.id, { apiKey: OPENAI_NATIVE_SECRET });

    const result = await generateImage('agent-native');

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://api.openai.com/v1/images/generations');
    expect(captured[0].authorization).toBe(`Bearer ${OPENAI_NATIVE_SECRET}`);
    expect(result).toMatchObject({
      status: 'completed',
      output: {
        actualProvider: 'openai',
        providerOrigin: OPENAI_ORIGIN,
        providerFallback: false,
      },
    });
  });

  it('Case B: a custom gateway credential goes only to that gateway, never to api.openai.com', async () => {
    const gateway = configWith('gateway', GATEWAY_ENDPOINT);
    saveProviderConfigs([gateway]);
    await saveProviderSecrets(gateway.id, { apiKey: GATEWAY_SECRET });

    const result = await generateImage('agent-gateway');

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(`${GATEWAY_ENDPOINT}/images/generations`);
    expect(captured[0].authorization).toBe(`Bearer ${GATEWAY_SECRET}`);

    // The forbidden tuple: the gateway sentinel on an origin its configuration does not authorize.
    expect(requestsCarrying(GATEWAY_SECRET).map((request) => new URL(request.url).origin)).toEqual([
      'http://127.0.0.1:9',
    ]);
    expect(requestsToOrigin(OPENAI_ORIGIN)).toEqual([]);
    expect(captured.some((request) => request.url.includes('api.openai.com'))).toBe(false);
    expect(result).toMatchObject({
      status: 'completed',
      output: { actualProvider: 'openai', providerOrigin: 'http://127.0.0.1:9' },
    });
  });

  it('Case C: several OpenAI-compatible configurations select deterministically and stay bound', async () => {
    // Two gateways, stored in reverse id order, each with its own credential.
    const second = configWith('b-second', SECOND_GATEWAY_ENDPOINT);
    const first = configWith('a-first', GATEWAY_ENDPOINT);
    saveProviderConfigs([second, first]);
    await saveProviderSecrets(first.id, { apiKey: GATEWAY_SECRET });
    await saveProviderSecrets(second.id, { apiKey: SECOND_GATEWAY_SECRET });

    await generateImage('agent-multi');

    expect(captured).toHaveLength(1);
    // Deterministic choice independent of stored array order...
    expect(captured[0].url).toBe(`${GATEWAY_ENDPOINT}/images/generations`);
    // ...and the credential belongs to the same configuration as that endpoint.
    expect(captured[0].authorization).toBe(`Bearer ${GATEWAY_SECRET}`);
    expect(requestsCarrying(SECOND_GATEWAY_SECRET)).toEqual([]);
  });

  it('Case C: a first-party OpenAI configuration is preferred over a custom gateway', async () => {
    const gateway = configWith('gateway', GATEWAY_ENDPOINT);
    const native = configWith('native', OPENAI_ENDPOINT);
    saveProviderConfigs([gateway, native]);
    await saveProviderSecrets(gateway.id, { apiKey: GATEWAY_SECRET });
    await saveProviderSecrets(native.id, { apiKey: OPENAI_NATIVE_SECRET });

    await generateImage('agent-prefer-native');

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://api.openai.com/v1/images/generations');
    expect(captured[0].authorization).toBe(`Bearer ${OPENAI_NATIVE_SECRET}`);
    // The gateway secret is never redirected to the host its configuration does not name.
    expect(requestsCarrying(GATEWAY_SECRET)).toEqual([]);
  });

  it('Case C: a keyless first-party configuration does not hide a keyed gateway', async () => {
    const native = configWith('native', OPENAI_ENDPOINT);
    const gateway = configWith('gateway', GATEWAY_ENDPOINT);
    saveProviderConfigs([native, gateway]);
    await saveProviderSecrets(gateway.id, { apiKey: GATEWAY_SECRET });

    await generateImage('agent-keyless-native');

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(`${GATEWAY_ENDPOINT}/images/generations`);
    expect(captured[0].authorization).toBe(`Bearer ${GATEWAY_SECRET}`);
  });

  it('Case D: the trusted keyring credential wins over a stale plaintext copy', async () => {
    // A legacy document that still carries plaintext, written the way old builds persisted it.
    globalThis.localStorage.setItem(
      'iris.providers.config.v2',
      JSON.stringify([
        {
          id: 'openai-legacy',
          name: 'OpenAI',
          kind: 'openai-compatible',
          endpoint: OPENAI_ENDPOINT,
          model: 'gpt-4o',
          enabled: true,
          catalogId: 'openai',
          apiKey: STALE_PLAINTEXT_SECRET,
          storedSecretFields: ['apiKey'],
          connectionValues: {},
        },
      ]),
    );
    await saveProviderSecrets('openai-legacy', { apiKey: KEYRING_SECRET });

    await generateImage('agent-precedence');

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://api.openai.com/v1/images/generations');
    expect(captured[0].authorization).toBe(`Bearer ${KEYRING_SECRET}`);
    expect(requestsCarrying(STALE_PLAINTEXT_SECRET)).toEqual([]);
  });

  it('Case E: provenance reports the endpoint that actually served the image', async () => {
    const gateway = configWith('gateway', GATEWAY_ENDPOINT);
    saveProviderConfigs([gateway]);
    await saveProviderSecrets(gateway.id, { apiKey: GATEWAY_SECRET });

    const result = await generateImage('agent-provenance', 'auto');

    expect(captured).toHaveLength(1);
    expect(result).toMatchObject({
      status: 'completed',
      output: {
        requestedProvider: 'auto',
        actualProvider: 'openai',
        providerOrigin: 'http://127.0.0.1:9',
        // 'auto' selection is not a fallback: no second provider was called after the request.
        providerFallback: false,
      },
    });
    expect(captured.every((request) => request.url.startsWith('http://127.0.0.1:9'))).toBe(true);
  });

  it('rejects a configuration whose endpoint cannot authorize a request instead of substituting one', async () => {
    const broken = configWith('broken', 'not-a-url');
    saveProviderConfigs([broken]);
    await saveProviderSecrets(broken.id, { apiKey: GATEWAY_SECRET });

    // The runtime turns a tool error into a controlled failure result; the point is that no request
    // was made and no default destination was substituted for the unusable endpoint.
    const result = await generateImage('agent-broken-endpoint');
    expect(result).toMatchObject({ status: 'failed' });
    expect(String((result as { reason?: string }).reason)).toMatch(
      /does not name a usable HTTP\(S\) endpoint/,
    );
    expect(captured).toEqual([]);
  });

  it('reports a missing credential as a controlled error and never contacts a default host', async () => {
    const native = configWith('native', OPENAI_ENDPOINT);
    saveProviderConfigs([native]);

    const result = await generateImage('agent-missing-credential');
    expect(result).toMatchObject({ status: 'failed' });
    expect(String((result as { reason?: string }).reason)).toMatch(
      /No openai credential is configured/,
    );
    expect(captured).toEqual([]);
  });
});
