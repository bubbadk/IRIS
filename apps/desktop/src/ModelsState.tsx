import { useEffect, useState } from 'react';
import {
  createProviderConfig,
  loadProviderCatalog,
  loadProviderConfigs,
  missingProviderConnectionFields,
  providerCatalogIdForConfig,
  providerConnectionFields,
  refreshProviderCatalog,
  refreshProviderModels,
  saveProviderConfigs,
  testProviderConnection,
  validateProviderConfig,
  type ProviderCatalogEntry,
  type ProviderCatalogId,
  type ProviderConfig,
} from '@iris/providers';
import {
  deleteProviderSecrets,
  isTauriRuntime,
  loadProviderSecrets,
  saveProviderSecrets,
} from './credentials';
import { formatMemoryDate } from './ChatContent';

export function ModelsState() {
  const [providers, setProviders] = useState<ProviderConfig[]>(() => loadProviderConfigs());
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>(() => loadProviderCatalog());
  const [catalogSync, setCatalogSync] = useState<'syncing' | 'current' | 'offline'>('syncing');
  const [draft, setDraft] = useState<ProviderConfig | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [catalogChoice, setCatalogChoice] = useState<ProviderCatalogId>('openai');
  const [saving, setSaving] = useState(false);
  const [activityStates, setActivityStates] = useState<
    Record<string, 'testing' | 'connected' | 'refreshing' | 'ready' | 'error'>
  >({});
  const [activityMessages, setActivityMessages] = useState<Record<string, string>>({});
  const desktopRuntime = isTauriRuntime();
  const selectedCatalogEntry =
    catalog.find((entry) => entry.id === catalogChoice) ?? catalog.find((entry) => entry.supported);
  const supportedCatalog = catalog.filter((entry) => entry.supported);
  const pendingCatalog = catalog.filter((entry) => !entry.supported);

  useEffect(() => saveProviderConfigs(providers), [providers]);

  useEffect(() => {
    let active = true;
    void refreshProviderCatalog()
      .then((next) => {
        if (!active) return;
        setCatalog(next);
        setCatalogSync('current');
      })
      .catch(() => {
        if (active) setCatalogSync('offline');
      });
    return () => {
      active = false;
    };
  }, []);

  function startAdding() {
    if (!selectedCatalogEntry?.supported) return;
    setErrors([]);
    setDraft(createProviderConfig(selectedCatalogEntry));
  }

  function catalogEntryForConfig(provider: ProviderConfig): ProviderCatalogEntry {
    const id = providerCatalogIdForConfig(provider);
    return (
      catalog.find((entry) => entry.id === id) ?? {
        id,
        name: provider.name,
        description: 'Saved provider configuration. The live directory is not available.',
        kind: provider.kind,
        endpoint: provider.endpoint,
        credentialMode:
          provider.credentialMode ?? (provider.kind === 'ollama' ? 'none' : 'optional'),
        credentialNames: [],
        connectionFields: providerConnectionFields(provider),
        supported: true,
        source: 'built-in',
      }
    );
  }

  function upsertProvider(provider: ProviderConfig) {
    setProviders((current) => {
      const exists = current.some((candidate) => candidate.id === provider.id);
      return exists
        ? current.map((candidate) => (candidate.id === provider.id ? provider : candidate))
        : [...current, provider];
    });
  }

  async function resolveProviderConnection(provider: ProviderConfig): Promise<ProviderConfig> {
    const hasSecretFields = providerConnectionFields(provider).some((field) => field.secret);
    const storedSecrets =
      hasSecretFields || provider.storedSecretFields?.length
        ? await loadProviderSecrets(provider.id)
        : null;
    return {
      ...provider,
      connectionValues: {
        ...(storedSecrets ?? {}),
        ...(provider.connectionValues ?? {}),
        ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      },
    };
  }

  async function saveDraft() {
    if (!draft) return;
    const nextErrors = validateProviderConfig(draft, {
      requireModel: draft.kind === 'azure-openai',
    });
    if (nextErrors.length) {
      setErrors(nextErrors);
      return;
    }
    setSaving(true);
    setErrors([]);
    const existing = providers.find((provider) => provider.id === draft.id);
    const secretFields = providerConnectionFields(draft).filter((field) => field.secret);
    const credentialChanged = secretFields.some((field) =>
      Boolean(draft.connectionValues?.[field.id]?.trim()),
    );
    let next: ProviderConfig = {
      ...draft,
      connectionValues: {
        ...(existing?.connectionValues ?? {}),
        ...(draft.connectionValues ?? {}),
      },
    };
    if (credentialChanged) {
      try {
        const resolved = await resolveProviderConnection(next);
        const secrets = Object.fromEntries(
          secretFields.flatMap((field) => {
            const value = resolved.connectionValues?.[field.id]?.trim();
            return value ? [[field.id, value]] : [];
          }),
        );
        const storedInOsKeyring = await saveProviderSecrets(next.id, secrets);
        next = {
          ...next,
          connectionValues: storedInOsKeyring
            ? Object.fromEntries(
                Object.entries(next.connectionValues ?? {}).filter(
                  ([fieldId]) => !secretFields.some((field) => field.id === fieldId),
                ),
              )
            : next.connectionValues,
          storedSecretFields: storedInOsKeyring
            ? Object.keys(secrets)
            : (next.storedSecretFields ?? []).filter(
                (fieldId) => !secretFields.some((field) => field.id === fieldId),
              ),
          availableModels: credentialChanged ? undefined : next.availableModels,
          modelsRefreshedAt: credentialChanged ? undefined : next.modelsRefreshedAt,
        };
      } catch {
        setErrors(['IRIS could not save this key in the OS credential store.']);
        setSaving(false);
        return;
      }
    }

    try {
      const connected = await resolveProviderConnection(next);
      const missingFields = missingProviderConnectionFields({
        ...connected,
        storedSecretFields: [],
      });
      if (missingFields.length) {
        throw new Error(
          `Add ${missingFields.map((field) => field.label.toLowerCase()).join(' and ')} before IRIS requests the provider model list.`,
        );
      }
      const refreshed = await refreshProviderModels(connected);
      next = {
        ...refreshed,
        connectionValues: next.connectionValues,
      };
      setActivityStates((current) => ({ ...current, [next.id]: 'ready' }));
      setActivityMessages((current) => ({
        ...current,
        [next.id]: `${next.availableModels?.length ?? 0} models refreshed`,
      }));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'IRIS could not refresh the provider model list.';
      setActivityStates((current) => ({ ...current, [next.id]: 'error' }));
      setActivityMessages((current) => ({ ...current, [next.id]: message }));
      if (!next.model.trim()) {
        upsertProvider(next);
        setDraft(next);
        setErrors([
          message,
          'The provider was saved, but it needs a model name before an agent can use it.',
        ]);
        setSaving(false);
        return;
      }
    }

    const finalErrors = validateProviderConfig(next);
    if (finalErrors.length) {
      setErrors(finalErrors);
      setSaving(false);
      return;
    }
    upsertProvider(next);
    setDraft(null);
    setErrors([]);
    setSaving(false);
  }

  async function testConnection(provider: ProviderConfig) {
    setActivityStates((current) => ({ ...current, [provider.id]: 'testing' }));
    setActivityMessages((current) => ({ ...current, [provider.id]: 'Testing connection…' }));
    try {
      const connected = await resolveProviderConnection(provider);
      const missingFields = missingProviderConnectionFields({
        ...connected,
        storedSecretFields: [],
      });
      if (missingFields.length) {
        throw new Error('Required provider credentials are not available.');
      }
      await testProviderConnection(connected);
      setActivityStates((current) => ({ ...current, [provider.id]: 'connected' }));
      setActivityMessages((current) => ({ ...current, [provider.id]: 'Connection passed' }));
    } catch (error) {
      setActivityStates((current) => ({ ...current, [provider.id]: 'error' }));
      setActivityMessages((current) => ({
        ...current,
        [provider.id]: error instanceof Error ? error.message : 'IRIS could not connect.',
      }));
    }
  }

  async function refreshModels(provider: ProviderConfig) {
    setActivityStates((current) => ({ ...current, [provider.id]: 'refreshing' }));
    setActivityMessages((current) => ({ ...current, [provider.id]: 'Refreshing model list…' }));
    try {
      const connected = await resolveProviderConnection(provider);
      const missingFields = missingProviderConnectionFields({
        ...connected,
        storedSecretFields: [],
      });
      if (missingFields.length) {
        throw new Error('Required provider credentials are not available.');
      }
      const refreshed = await refreshProviderModels(connected);
      upsertProvider({
        ...refreshed,
        connectionValues: provider.connectionValues,
      });
      setActivityStates((current) => ({ ...current, [provider.id]: 'ready' }));
      setActivityMessages((current) => ({
        ...current,
        [provider.id]: `${refreshed.availableModels?.length ?? 0} models refreshed`,
      }));
    } catch (error) {
      setActivityStates((current) => ({ ...current, [provider.id]: 'error' }));
      setActivityMessages((current) => ({
        ...current,
        [provider.id]:
          error instanceof Error ? error.message : 'IRIS could not refresh the model list.',
      }));
    }
  }

  async function removeProvider(provider: ProviderConfig) {
    try {
      if (provider.storedSecretFields?.length || provider.secretStored) {
        await deleteProviderSecrets(provider.id);
      }
      setProviders((current) => current.filter((candidate) => candidate.id !== provider.id));
      setActivityMessages((current) => {
        const next = { ...current };
        delete next[provider.id];
        return next;
      });
    } catch (error) {
      setActivityStates((current) => ({ ...current, [provider.id]: 'error' }));
      setActivityMessages((current) => ({
        ...current,
        [provider.id]:
          error instanceof Error ? error.message : 'IRIS could not remove the stored credential.',
      }));
    }
  }

  return (
    <div className="models-state">
      <div className="models-intro">
        <div>
          <p className="eyebrow">Model providers</p>
          <h2>Give IRIS a brain.</h2>
          <p>
            Keep local and cloud providers side by side. IRIS reads their real model lists only
            after you save credentials or request a refresh.
          </p>
        </div>
        <div className="provider-actions">
          <label className="provider-catalog-picker">
            <span>Provider type</span>
            <select
              aria-label="Provider type"
              value={catalogChoice}
              onChange={(event) => setCatalogChoice(event.target.value as ProviderCatalogId)}
            >
              <optgroup label={`Ready in IRIS (${supportedCatalog.length})`}>
                {supportedCatalog.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
              {pendingCatalog.length > 0 && (
                <optgroup label={`Listed · adapter needed (${pendingCatalog.length})`}>
                  {pendingCatalog.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <button
            className="soft-button primary-button"
            disabled={!selectedCatalogEntry?.supported}
            onClick={startAdding}
          >
            ＋ Add provider
          </button>
        </div>
      </div>

      <div className="provider-catalog-note">
        <strong>{selectedCatalogEntry?.name ?? 'Provider directory'}</strong>
        <span>
          {selectedCatalogEntry?.description ?? 'No provider entry is available.'}{' '}
          {selectedCatalogEntry?.supportReason}
        </span>
        <small>
          {catalog.length} providers · {supportedCatalog.length} ready in IRIS ·{' '}
          {catalogSync === 'current'
            ? 'directory current'
            : catalogSync === 'offline'
              ? 'using cached directory'
              : 'syncing directory…'}
        </small>
      </div>

      {providers.length === 0 && !draft && (
        <div className="provider-empty">
          <span>○</span>
          <div>
            <strong>No providers configured</strong>
            <p>IRIS will keep this space quiet until a real provider is connected.</p>
          </div>
        </div>
      )}
      <div className="provider-list">
        {providers.map((provider) => {
          const catalogId = providerCatalogIdForConfig(provider);
          const activity = activityStates[provider.id];
          return (
            <article className="provider-row" key={provider.id}>
              <div className="provider-icon">{catalogId === 'ollama' ? '◎' : '✦'}</div>
              <div className="provider-details">
                <strong>{provider.name}</strong>
                <span>
                  {provider.model || 'No model selected'} · {provider.endpoint}
                </span>
                {activityMessages[provider.id] && (
                  <small className={activity === 'error' ? 'provider-error' : ''}>
                    {activityMessages[provider.id]}
                  </small>
                )}
                {!activityMessages[provider.id] && provider.modelsRefreshedAt && (
                  <small>Models refreshed {formatMemoryDate(provider.modelsRefreshedAt)}</small>
                )}
              </div>
              <div className="provider-status">
                {activity === 'connected'
                  ? 'Connected'
                  : activity === 'testing'
                    ? 'Testing…'
                    : activity === 'refreshing'
                      ? 'Refreshing…'
                      : activity === 'error'
                        ? 'Unavailable'
                        : !provider.model.trim()
                          ? 'Needs model'
                          : provider.availableModels?.length
                            ? `${provider.availableModels.length} models`
                            : provider.storedSecretFields?.length
                              ? desktopRuntime
                                ? 'Stored securely'
                                : 'Session key expired'
                              : provider.connectionValues?.apiKey || provider.apiKey
                                ? 'Credentials in session'
                                : provider.kind === 'ollama' || provider.credentialMode === 'none'
                                  ? 'Local'
                                  : provider.credentialMode === 'optional'
                                    ? 'Key optional'
                                    : 'Needs key'}
              </div>
              <button
                className="row-button"
                disabled={activity === 'testing' || activity === 'refreshing'}
                onClick={() => void refreshModels(provider)}
              >
                Models
              </button>
              <button
                className="row-button"
                disabled={activity === 'testing' || activity === 'refreshing'}
                onClick={() => void testConnection(provider)}
              >
                Test
              </button>
              <button
                className="row-button"
                onClick={() => {
                  setErrors([]);
                  setDraft(provider);
                }}
              >
                Edit
              </button>
              <button
                className="row-button danger-button"
                onClick={() => void removeProvider(provider)}
              >
                Remove
              </button>
            </article>
          );
        })}
      </div>

      {draft && (
        <div className="provider-editor">
          <div className="editor-heading">
            <div>
              <p className="eyebrow">Configure provider</p>
              <h3>{catalogEntryForConfig(draft).name}</h3>
              <span className="provider-editor-description">
                {catalogEntryForConfig(draft).description}
              </span>
            </div>
            <button className="row-button" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
          <label>
            Display name
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            Endpoint URL
            <input
              value={draft.endpoint}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  endpoint: event.target.value,
                  availableModels: undefined,
                  modelsRefreshedAt: undefined,
                })
              }
            />
          </label>
          <label>
            {draft.kind === 'azure-openai' ? 'Deployment name' : 'Default model'}
            {draft.availableModels?.length && draft.kind !== 'azure-openai' ? (
              <select
                value={draft.model}
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              >
                {draft.availableModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={draft.model}
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                placeholder={
                  draft.kind === 'azure-openai'
                    ? 'Your Azure deployment name'
                    : 'Loaded from the provider after save'
                }
              />
            )}
          </label>
          {providerConnectionFields(draft).map((field) => (
            <label key={field.id}>
              {field.label}
              {!field.required && ' (optional)'}{' '}
              {field.secret && (
                <span className="field-note">
                  {desktopRuntime ? 'stored in OS keyring' : 'kept in memory only in preview'}
                </span>
              )}
              <input
                type={field.secret ? 'password' : 'text'}
                value={draft.connectionValues?.[field.id] ?? ''}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    connectionValues: {
                      ...(draft.connectionValues ?? {}),
                      [field.id]: event.target.value,
                    },
                    availableModels: field.id === 'apiVersion' ? undefined : draft.availableModels,
                    modelsRefreshedAt:
                      field.id === 'apiVersion' ? undefined : draft.modelsRefreshedAt,
                  })
                }
                placeholder={
                  field.secret && draft.storedSecretFields?.includes(field.id)
                    ? `Stored ${field.label.toLowerCase()} will be reused`
                    : field.placeholder
                }
              />
            </label>
          ))}
          {draft.kind === 'azure-openai' && draft.availableModels?.length && (
            <p className="provider-field-help">
              Azure reports {draft.availableModels.length} accessible base models. Deployment names
              are resource-specific and remain explicit.
            </p>
          )}
          {errors.length > 0 && (
            <div className="form-errors">
              {errors.map((error) => (
                <span key={error}>{error}</span>
              ))}
            </div>
          )}
          <button
            className="soft-button primary-button save-provider"
            disabled={saving}
            onClick={() => void saveDraft()}
          >
            {saving ? 'Saving and refreshing…' : 'Save provider'}
          </button>
        </div>
      )}
    </div>
  );
}