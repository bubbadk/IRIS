import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, tauriIsTauri } = vi.hoisted(() => ({
  invoke: vi.fn(),
  tauriIsTauri: vi.fn(() => false),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: tauriIsTauri }));

import {
  loadProviderSecrets,
  mergeTrustedConnectionValues,
  providerConfigHasSecretFields,
  resolveProviderConnection,
  saveProviderSecrets,
} from './credentials';
import type { ProviderConfig } from '@iris/providers';

function providerConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-1',
    name: 'Provider',
    kind: 'openai-compatible',
    endpoint: 'https://api.example.test/v1',
    model: 'gpt-4o',
    enabled: true,
    connectionFields: [{ id: 'apiKey', label: 'API key', required: true, secret: true }],
    ...overrides,
  };
}

describe('provider credential storage', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    invoke.mockReset();
    tauriIsTauri.mockReturnValue(false);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('stores a versioned structured secret record in the native keyring', async () => {
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        values: { apiKey: 'azure-secret', tenantId: 'tenant-secret' },
      }),
    );

    await expect(
      saveProviderSecrets('azure-1', { apiKey: 'azure-secret', tenantId: 'tenant-secret' }),
    ).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledWith('set_provider_secret', {
      providerId: 'azure-1',
      secret: JSON.stringify({
        version: 1,
        values: { apiKey: 'azure-secret', tenantId: 'tenant-secret' },
      }),
    });
    expect(invoke).toHaveBeenLastCalledWith('get_provider_secret', {
      providerId: 'azure-1',
    });
  });

  it('loads structured fields and migrates legacy plaintext keys in memory', async () => {
    invoke.mockResolvedValueOnce(
      JSON.stringify({ version: 1, values: { apiKey: 'new-key', sessionToken: 'token' } }),
    );
    await expect(loadProviderSecrets('provider-1')).resolves.toEqual({
      apiKey: 'new-key',
      sessionToken: 'token',
    });

    invoke.mockResolvedValueOnce('legacy-key');
    await expect(loadProviderSecrets('provider-1')).resolves.toEqual({ apiKey: 'legacy-key' });
  });

  it('keeps preview credentials in memory for agent runtime without persisting them', async () => {
    vi.stubGlobal('window', {});

    await expect(saveProviderSecrets('preview-provider', { apiKey: 'session-key' })).resolves.toBe(
      false,
    );
    await expect(loadProviderSecrets('preview-provider')).resolves.toEqual({
      apiKey: 'session-key',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('uses Tauri 2 runtime detection and refuses an unverified native save', async () => {
    vi.stubGlobal('window', {});
    tauriIsTauri.mockReturnValue(true);
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(null);

    await expect(saveProviderSecrets('provider-2', { apiKey: 'not-retained' })).rejects.toThrow(
      'did not retain',
    );
  });

  it('lets the trusted keyring secret win over a stale plaintext credential', () => {
    const merged = mergeTrustedConnectionValues(
      {
        connectionValues: { apiKey: 'stale-plaintext-key', baseUrl: 'https://api.example' },
        apiKey: 'even-older-key',
      },
      { apiKey: 'current-keyring-key' },
    );

    expect(merged).toEqual({
      apiKey: 'current-keyring-key',
      baseUrl: 'https://api.example',
    });
  });

  it('keeps configured non-secret fields when the keyring stores nothing', () => {
    const merged = mergeTrustedConnectionValues(
      { connectionValues: { apiKey: 'legacy-key', tenantId: 'tenant' } },
      null,
    );

    expect(merged).toEqual({ apiKey: 'legacy-key', tenantId: 'tenant' });
  });
});

/**
 * M-29: every production caller resolves effective credentials through `resolveProviderConnection`,
 * which owns the precedence contract. These are the unit-level rows of the matrix; the integration
 * rows run through the agent runtime, memory embeddings and subtitle translation in
 * `credentialPrecedence.test.ts`.
 */
describe('resolveProviderConnection precedence contract', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    invoke.mockReset();
    tauriIsTauri.mockReturnValue(false);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('lets the keyring outrank plaintext metadata and the legacy apiKey field', async () => {
    invoke.mockResolvedValueOnce(
      JSON.stringify({ version: 1, values: { apiKey: 'current-keyring-key' } }),
    );
    const resolved = await resolveProviderConnection(
      providerConfig({
        connectionValues: { apiKey: 'stale-plaintext-key', tenantId: 'tenant' },
        apiKey: 'even-older-key',
      }),
    );
    expect(resolved.connectionValues).toEqual({
      apiKey: 'current-keyring-key',
      tenantId: 'tenant',
    });
  });

  it('does not read the keyring for a provider with no secret fields', async () => {
    expect(providerConfigHasSecretFields(providerConfig({ connectionFields: [] }))).toBe(false);
    const resolved = await resolveProviderConnection(
      providerConfig({
        connectionFields: [],
        connectionValues: { baseUrl: 'https://api.example.test/v1' },
      }),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(resolved.connectionValues).toEqual({ baseUrl: 'https://api.example.test/v1' });
  });

  it('keeps legacy plaintext working only while the trusted store is empty', async () => {
    invoke.mockResolvedValueOnce(null);
    const resolved = await resolveProviderConnection(
      providerConfig({ connectionValues: { apiKey: 'legacy-key' } }),
    );
    expect(resolved.connectionValues?.apiKey).toBe('legacy-key');
  });
});
