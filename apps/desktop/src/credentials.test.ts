import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, tauriIsTauri } = vi.hoisted(() => ({
  invoke: vi.fn(),
  tauriIsTauri: vi.fn(() => false),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: tauriIsTauri }));

import { loadProviderSecrets, saveProviderSecrets } from './credentials';

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
});
