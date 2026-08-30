import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ProviderConnectionValues } from '@iris/providers';

const sessionSecrets = new Map<string, ProviderConnectionValues>();

function isTauriRuntime(): boolean {
  return isTauri() || (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);
}

interface StoredProviderSecrets {
  version: 1;
  values: ProviderConnectionValues;
}

function parseStoredSecrets(secret: string): ProviderConnectionValues {
  try {
    const parsed = JSON.parse(secret) as Partial<StoredProviderSecrets>;
    if (!parsed || parsed.version !== 1 || !parsed.values || typeof parsed.values !== 'object') {
      return { apiKey: secret };
    }
    return Object.fromEntries(
      Object.entries(parsed.values).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return { apiKey: secret };
  }
}

export async function saveProviderSecrets(
  providerId: string,
  values: ProviderConnectionValues,
): Promise<boolean> {
  if (!isTauriRuntime()) {
    sessionSecrets.set(providerId, { ...values });
    return false;
  }
  const payload: StoredProviderSecrets = { version: 1, values };
  await invoke('set_provider_secret', { providerId, secret: JSON.stringify(payload) });
  const verified = await loadProviderSecrets(providerId);
  const persisted = Object.entries(values).every(
    ([fieldId, value]) => verified?.[fieldId] === value,
  );
  if (!persisted) throw new Error('The OS credential store did not retain the provider secret.');
  return true;
}

export async function loadProviderSecrets(
  providerId: string,
): Promise<ProviderConnectionValues | null> {
  if (!isTauriRuntime()) {
    const values = sessionSecrets.get(providerId);
    return values ? { ...values } : null;
  }
  const stored = await invoke<string | null>('get_provider_secret', { providerId });
  return stored === null ? null : parseStoredSecrets(stored);
}

export async function deleteProviderSecrets(providerId: string): Promise<boolean> {
  sessionSecrets.delete(providerId);
  if (!isTauriRuntime()) return false;
  await invoke('delete_provider_secret', { providerId });
  return true;
}

export { isTauriRuntime };
