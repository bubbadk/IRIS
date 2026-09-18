import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  providerConnectionFields,
  type ProviderConfig,
  type ProviderConnectionValues,
} from '@iris/providers';

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

/**
 * Merges persisted provider configuration with the trusted credential store. The stored secrets are
 * applied last on purpose: a stale plaintext `apiKey` left behind in legacy configuration must never
 * override the credential the OS keyring currently holds, and a rotated keyring secret must win over
 * an old copy. Non-secret fields that only exist in the configuration are still preserved.
 *
 * This is the single precedence contract (M-29). No caller may spread these sources in its own
 * order: several call sites used `{ ...storedSecrets, ...legacyPlaintext }`, which let an old
 * plaintext copy beat a freshly rotated keyring credential.
 */
export function mergeTrustedConnectionValues(
  config: Pick<ProviderConfig, 'connectionValues' | 'apiKey'>,
  storedSecrets: ProviderConnectionValues | null,
): ProviderConnectionValues {
  return {
    ...(config.connectionValues ?? {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(storedSecrets ?? {}),
  };
}

/** Whether a provider config can carry secrets that must be read from the trusted store. */
export function providerConfigHasSecretFields(
  config: Pick<ProviderConfig, 'connectionFields' | 'credentialMode' | 'kind' | 'storedSecretFields'>,
): boolean {
  const fields = providerConnectionFields(config);
  return fields.some((field) => field.secret) || Boolean(config.storedSecretFields?.length);
}

/**
 * The one credential resolver every production caller uses to turn a stored provider configuration
 * into the effective connection IRIS actually executes with.
 *
 * Precedence (highest last wins):
 *   1. persisted plaintext/metadata connection values — legacy state, never authoritative
 *   2. the legacy `apiKey` field migrated out of old documents — still legacy state
 *   3. the trusted OS keyring / session credential store — always authoritative
 *
 * A provider with no secret fields is returned untouched: there is nothing to resolve and no
 * keyring round-trip is needed. When a required credential is missing the returned configuration is
 * simply missing it; callers report the controlled configuration error through
 * `missingProviderConnectionFields` instead of inventing a fallback secret or switching providers.
 */
export async function resolveProviderConnection(config: ProviderConfig): Promise<ProviderConfig> {
  const storedSecrets = providerConfigHasSecretFields(config)
    ? await loadProviderSecrets(config.id)
    : null;
  return {
    ...config,
    connectionValues: mergeTrustedConnectionValues(config, storedSecrets),
  };
}

export async function deleteProviderSecrets(providerId: string): Promise<boolean> {
  sessionSecrets.delete(providerId);
  if (!isTauriRuntime()) return false;
  await invoke('delete_provider_secret', { providerId });
  return true;
}

export { isTauriRuntime };
