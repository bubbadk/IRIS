import { useEffect, useState } from 'react';
import type { AgentDefinition, AgentMemoryAccess } from '@iris/core';
import type {
  MemoryEmbeddingIndexBuildProgress,
  MemoryEmbeddingIndexStatus,
  MemoryRecord,
} from '@iris/memory';
import {
  loadProviderConfigs,
  providerSupportsEmbeddings,
  type ProviderConfig,
} from '@iris/providers';
import { agentRuntime, subscribeAgentRuntime } from './agentRuntime';
import { agentRepository } from './persistence';
import { memoryService } from './memory';
import {
  fetchEmbeddingModelOptions,
  getMemoryEmbeddingIndexStatus,
  loadMemoryRetrievalConfig,
  rebuildMemoryEmbeddingIndex,
  saveMemoryRetrievalConfig,
  testMemoryRetrievalConfig,
  validateMemoryRetrievalConfig,
  type MemoryRetrievalConfig,
} from './memoryRetrieval';
import { MemoryBenchmarkView } from './MemoryBenchmarkView';
import { MemoryConstellationView } from './MemoryConstellationView';
import { formatMemoryDate } from './App';

export function MemoryState() {
  const [memoryTab, setMemoryTab] = useState<'records' | 'benchmark' | 'constellation'>('records');
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [retrievalConfig, setRetrievalConfig] = useState<MemoryRetrievalConfig>(() =>
    loadMemoryRetrievalConfig(),
  );
  const [retrievalDraft, setRetrievalDraft] = useState<MemoryRetrievalConfig>(retrievalConfig);
  const [retrievalErrors, setRetrievalErrors] = useState<string[]>([]);
  const [retrievalState, setRetrievalState] = useState<
    'idle' | 'testing' | 'connected' | 'error' | 'saved'
  >('idle');
  const [embeddingIndexState, setEmbeddingIndexState] = useState<
    | MemoryEmbeddingIndexStatus
    | { state: 'checking' }
    | { state: 'rebuilding'; progress: MemoryEmbeddingIndexBuildProgress | null }
    | { state: 'error' }
    | null
  >(retrievalConfig.strategy !== 'lexical' ? { state: 'checking' } : null);
  const [embeddingModels, setEmbeddingModels] = useState<string[]>([]);
  const [embeddingModelsState, setEmbeddingModelsState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const embeddingProviders = loadProviderConfigs().filter(
    (provider) => provider.enabled && providerSupportsEmbeddings(provider.kind),
  );

  useEffect(() => {
    let active = true;
    const loadMemory = () => memoryService.list();
    void Promise.all([loadMemory(), agentRepository.list()]).then(
      ([storedRecords, storedAgents]) => {
        if (!active) return;
        setRecords(storedRecords);
        setAgents(storedAgents);
        setSelectedId(storedRecords[0]?.id ?? null);
        setLoaded(true);
      },
    );
    const unsubscribe = subscribeAgentRuntime(() => {
      void loadMemory().then((storedRecords) => {
        if (!active) return;
        setRecords(storedRecords);
        setSelectedId((current) => current ?? storedRecords[0]?.id ?? null);
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (retrievalConfig.strategy === 'lexical') {
      setEmbeddingIndexState(null);
      return () => {
        active = false;
      };
    }
    setEmbeddingIndexState({ state: 'checking' });
    void getMemoryEmbeddingIndexStatus(retrievalConfig, records)
      .then((status) => {
        if (active) setEmbeddingIndexState(status);
      })
      .catch(() => {
        if (active) setEmbeddingIndexState({ state: 'error' });
      });
    return () => {
      active = false;
    };
  }, [records, retrievalConfig]);

  const draftEmbeddingProviderId =
    retrievalDraft.strategy !== 'lexical' ? retrievalDraft.providerId : '';
  // One fetch per selected provider; loadEmbeddingModels only prefills an empty model field.
  useEffect(() => {
    if (draftEmbeddingProviderId) void loadEmbeddingModels(draftEmbeddingProviderId);
  }, [draftEmbeddingProviderId]);

  const selected = records.find((record) => record.id === selectedId) ?? null;
  const grantedAgents = agents.filter((agent) => agent.memoryAccess === 'read').length;

  function refreshMemoryReaders(): boolean {
    let deferred = false;
    for (const agent of agents) {
      if (agent.memoryAccess !== 'read') continue;
      try {
        agentRuntime.refreshConfiguration(agent.id);
      } catch {
        deferred = true;
      }
    }
    return deferred;
  }

  async function remember(event: React.FormEvent) {
    event.preventDefault();
    try {
      const record = await memoryService.remember(draft);
      setRecords((current) => [record, ...current]);
      setSelectedId(record.id);
      setDraft('');
      setError(
        refreshMemoryReaders()
          ? 'Memory was saved and will reach running agents after their current turn.'
          : '',
      );
    } catch (memoryError) {
      setError(memoryError instanceof Error ? memoryError.message : 'IRIS could not save memory.');
    }
  }

  async function forget(record: MemoryRecord) {
    await memoryService.forget(record.id);
    const next = records.filter((item) => item.id !== record.id);
    setRecords(next);
    if (selectedId === record.id) setSelectedId(next[0]?.id ?? null);
    setError(
      refreshMemoryReaders()
        ? 'Memory was removed and running agents will refresh after their current turn.'
        : '',
    );
  }

  async function setAgentAccess(agent: AgentDefinition, memoryAccess: AgentMemoryAccess) {
    const updated = { ...agent, memoryAccess };
    await agentRepository.save(updated);
    setAgents((current) => current.map((item) => (item.id === agent.id ? updated : item)));
    try {
      agentRuntime.refreshConfiguration(agent.id);
      setError('');
    } catch {
      setError('Access was saved and will apply after the current agent run finishes.');
    }
  }

  async function loadEmbeddingModels(providerId: string) {
    if (!providerId) {
      setEmbeddingModels([]);
      setEmbeddingModelsState('idle');
      return;
    }
    setEmbeddingModelsState('loading');
    try {
      const models = await fetchEmbeddingModelOptions(providerId, embeddingProviders);
      setEmbeddingModels(models);
      setEmbeddingModelsState('ready');
      // The list is already filtered to embedding models, so prefill the first when empty.
      setRetrievalDraft((current) =>
        current.strategy !== 'lexical' && !current.model.trim() && models[0]
          ? { ...current, model: models[0] }
          : current,
      );
    } catch {
      setEmbeddingModels([]);
      setEmbeddingModelsState('error');
    }
  }

  function selectRetrievalStrategy(strategy: MemoryRetrievalConfig['strategy']) {
    setRetrievalErrors([]);
    setRetrievalState('idle');
    if (strategy === 'lexical') {
      setRetrievalDraft({ strategy: 'lexical' });
      setEmbeddingModels([]);
      setEmbeddingModelsState('idle');
      return;
    }
    const providerId = embeddingProviders[0]?.id ?? '';
    setRetrievalDraft(
      strategy === 'hybrid'
        ? { strategy: 'hybrid', providerId, model: '' }
        : { strategy: 'embedding', providerId, model: '' },
    );
    void loadEmbeddingModels(providerId);
  }

  function selectEmbeddingProvider(providerId: string) {
    setRetrievalDraft((current) =>
      current.strategy !== 'lexical' ? { ...current, providerId, model: '' } : current,
    );
    void loadEmbeddingModels(providerId);
  }

  async function saveRetrieval() {
    const nextErrors = validateMemoryRetrievalConfig(retrievalDraft, embeddingProviders);
    if (nextErrors.length) {
      setRetrievalErrors(nextErrors);
      setRetrievalState('error');
      return;
    }
    try {
      await saveMemoryRetrievalConfig(retrievalDraft);
      setRetrievalConfig(retrievalDraft);
      setRetrievalErrors([]);
      setRetrievalState('saved');
    } catch (saveError) {
      setRetrievalErrors([
        saveError instanceof Error ? saveError.message : 'IRIS could not save memory retrieval.',
      ]);
      setRetrievalState('error');
    }
  }

  async function testRetrieval() {
    setRetrievalErrors([]);
    setRetrievalState('testing');
    try {
      await testMemoryRetrievalConfig(retrievalDraft, embeddingProviders);
      setRetrievalState('connected');
    } catch (retrievalError) {
      setRetrievalErrors([
        retrievalError instanceof Error
          ? retrievalError.message
          : 'IRIS could not test embedding retrieval.',
      ]);
      setRetrievalState('error');
    }
  }

  async function rebuildEmbeddingIndex() {
    if (retrievalConfig.strategy === 'lexical') return;
    setRetrievalErrors([]);
    setEmbeddingIndexState({ state: 'rebuilding', progress: null });
    try {
      const status = await rebuildMemoryEmbeddingIndex(
        retrievalConfig,
        records,
        embeddingProviders,
        undefined,
        undefined,
        (progress) => setEmbeddingIndexState({ state: 'rebuilding', progress }),
      );
      setEmbeddingIndexState(status);
    } catch (indexError) {
      setEmbeddingIndexState({ state: 'error' });
      setRetrievalErrors([
        indexError instanceof Error
          ? indexError.message
          : 'IRIS could not rebuild the local embedding index.',
      ]);
    }
  }

  const configuredEmbeddingProvider =
    retrievalConfig.strategy !== 'lexical'
      ? embeddingProviders.find((provider) => provider.id === retrievalConfig.providerId)
      : undefined;
  const visibleIndexProgress =
    embeddingIndexState?.state === 'rebuilding'
      ? embeddingIndexState.progress
      : embeddingIndexState?.state === 'needs-rebuild'
        ? embeddingIndexState
        : null;

  return (
    <div className="memory-state">
      <div className="memory-heading">
        <div>
          <p className="eyebrow">Local memory</p>
          <h2>Remember with a clear source.</h2>
          <p>
            Saved records stay in this workspace. Agents see them only when you grant read access.
          </p>
        </div>
        <span className="memory-local-seal">Local store</span>
      </div>

      <div className="memory-facts">
        <div>
          <strong>{records.length}</strong>
          <span>saved records</span>
        </div>
        <div>
          <strong>{grantedAgents}</strong>
          <span>agents with access</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px', margin: '14px 0 16px 0', borderBottom: '1px solid var(--line)', paddingBottom: '10px' }}>
        <button
          type="button"
          className={`button ${memoryTab === 'records' ? 'button-primary' : 'button-secondary'}`}
          onClick={() => setMemoryTab('records')}
          style={{ fontSize: '12px', padding: '6px 14px' }}
        >
          🧠 Stored Memories ({records.length})
        </button>
        <button
          type="button"
          className={`button ${memoryTab === 'benchmark' ? 'button-primary' : 'button-secondary'}`}
          onClick={() => setMemoryTab('benchmark')}
          style={{ fontSize: '12px', padding: '6px 14px' }}
        >
          🏆 FP-AMB Benchmark
        </button>
        <button
          type="button"
          className={`button ${memoryTab === 'constellation' ? 'button-primary' : 'button-secondary'}`}
          onClick={() => setMemoryTab('constellation')}
          style={{ fontSize: '12px', padding: '6px 14px' }}
        >
          🌌 Constellation
        </button>
      </div>

      {memoryTab === 'benchmark' ? (
        <MemoryBenchmarkView />
      ) : memoryTab === 'constellation' ? (
        <MemoryConstellationView records={records} agentId={selectedId} agentName={agents.find((agent) => agent.id === selectedId)?.name} />
      ) : (
        <>
      <section className="memory-retrieval" aria-label="Memory retrieval">
        <div className="section-heading">
          <div>
            <h3>Retrieval</h3>
            <p>Choose how granted agents find records relevant to each prompt.</p>
          </div>
          <span>
            {retrievalConfig.strategy === 'lexical'
              ? 'Lexical active'
              : configuredEmbeddingProvider && embeddingIndexState?.state === 'ready'
                ? 'Index ready'
                : configuredEmbeddingProvider && embeddingIndexState?.state === 'rebuilding'
                  ? embeddingIndexState.progress
                    ? `${embeddingIndexState.progress.readyCount}/${embeddingIndexState.progress.recordCount} indexed`
                    : 'Preparing index'
                  : configuredEmbeddingProvider && embeddingIndexState?.state === 'checking'
                    ? 'Checking index'
                    : configuredEmbeddingProvider && embeddingIndexState?.state === 'error'
                      ? 'Index unavailable'
                      : configuredEmbeddingProvider
                        ? 'Rebuild needed'
                        : 'Needs configuration'}
          </span>
        </div>
        <div className="memory-retrieval-status">
          {retrievalConfig.strategy === 'lexical' ? (
            <p>
              Local embeddings are not configured. IRIS uses deterministic lexical ranking without a
              model or network connection.
            </p>
          ) : configuredEmbeddingProvider ? (
            embeddingIndexState?.state === 'ready' ? (
              <p>
                The persistent index contains <strong>{embeddingIndexState.recordCount}</strong>{' '}
                records for <strong>{retrievalConfig.model}</strong>. It was built{' '}
                <strong>{formatMemoryDate(embeddingIndexState.builtAt)}</strong>; recalls embed only
                the current prompt.
              </p>
            ) : embeddingIndexState?.state === 'rebuilding' ? (
              <p>
                IRIS is indexing through <strong>{configuredEmbeddingProvider.name}</strong>.{' '}
                {embeddingIndexState.progress ? (
                  <>
                    <strong>{embeddingIndexState.progress.readyCount}</strong> of{' '}
                    <strong>{embeddingIndexState.progress.recordCount}</strong> records are safely
                    checkpointed. Unchanged valid vectors are retained.
                  </>
                ) : (
                  'Existing checkpoints are being inspected before any embedding request is sent.'
                )}
              </p>
            ) : embeddingIndexState?.state === 'checking' ? (
              <p>Checking the persisted local index for this provider and model…</p>
            ) : embeddingIndexState?.state === 'error' ? (
              <p>
                The local index could not be inspected or rebuilt. See the reported error below.
              </p>
            ) : (
              <p>
                Semantic retrieval is configured for <strong>{retrievalConfig.model}</strong>.{' '}
                {embeddingIndexState?.reason === 'failed'
                  ? `${embeddingIndexState.failedCount} record${embeddingIndexState.failedCount === 1 ? '' : 's'} failed and can be retried; completed vectors remain checkpointed.`
                  : embeddingIndexState?.reason === 'records-changed'
                    ? `${embeddingIndexState.readyCount} unchanged vector${embeddingIndexState.readyCount === 1 ? '' : 's'} can be retained while changed records are indexed.`
                    : 'Its local index needs an explicit build.'}
              </p>
            )
          ) : (
            <p>
              The selected embedding provider is unavailable. Choose lexical retrieval or connect an
              enabled provider before the next agent recall.
            </p>
          )}
        </div>
        {configuredEmbeddingProvider &&
          visibleIndexProgress &&
          visibleIndexProgress.recordCount > 0 && (
            <div className="memory-index-progress" aria-live="polite">
              <div className="memory-index-progress-heading">
                <span>
                  <strong>{visibleIndexProgress.readyCount}</strong> ready ·{' '}
                  <strong>{visibleIndexProgress.pendingCount}</strong> pending ·{' '}
                  <strong>{visibleIndexProgress.failedCount}</strong> failed
                </span>
                {embeddingIndexState?.state === 'rebuilding' &&
                  embeddingIndexState.progress?.currentMemoryId && <span>Embedding now</span>}
              </div>
              <ol>
                {visibleIndexProgress.records.map((recordState) => {
                  const memoryRecord = records.find((record) => record.id === recordState.memoryId);
                  const isCurrent =
                    embeddingIndexState?.state === 'rebuilding' &&
                    embeddingIndexState.progress?.currentMemoryId === recordState.memoryId;
                  return (
                    <li
                      key={recordState.memoryId}
                      data-state={isCurrent ? 'active' : recordState.state}
                    >
                      <div>
                        <strong>{memoryRecord?.content ?? recordState.memoryId}</strong>
                        {recordState.state === 'failed' && (
                          <small>
                            {recordState.error} · attempt {recordState.attempts} ·{' '}
                            {formatMemoryDate(recordState.lastAttemptAt)}
                          </small>
                        )}
                      </div>
                      <span>{isCurrent ? 'Embedding' : recordState.state}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        <div className="memory-retrieval-editor">
          <label>
            Strategy
            <select
              value={retrievalDraft.strategy}
              onChange={(event) =>
                selectRetrievalStrategy(event.target.value as MemoryRetrievalConfig['strategy'])
              }
            >
              <option value="lexical">Deterministic lexical</option>
              <option value="embedding">Provider embeddings</option>
              <option value="hybrid">Hybrid (lexical + embeddings)</option>
            </select>
          </label>
          {retrievalDraft.strategy !== 'lexical' && (
            <>
              <label>
                Embedding provider
                <select
                  value={retrievalDraft.providerId}
                  onChange={(event) => selectEmbeddingProvider(event.target.value)}
                >
                  <option value="">Choose provider…</option>
                  {embeddingProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                      {provider.kind === 'ollama' ? ' (local)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="memory-model-label">
                  Embedding model
                  {retrievalDraft.providerId && (
                    <button
                      type="button"
                      className="memory-model-refresh"
                      disabled={embeddingModelsState === 'loading'}
                      onClick={() => void loadEmbeddingModels(retrievalDraft.providerId)}
                    >
                      {embeddingModelsState === 'loading'
                        ? 'Loading…'
                        : embeddingModelsState === 'error'
                          ? 'Retry'
                          : 'Refresh'}
                    </button>
                  )}
                </span>
                <input
                  value={retrievalDraft.model}
                  list="embedding-model-options"
                  onChange={(event) =>
                    setRetrievalDraft({ ...retrievalDraft, model: event.target.value })
                  }
                  placeholder={
                    embeddingModelsState === 'loading'
                      ? 'Loading models…'
                      : 'e.g. text-embedding-3-small or embeddinggemma'
                  }
                />
                <datalist id="embedding-model-options">
                  {embeddingModels.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
                {embeddingModelsState === 'ready' && embeddingModels.length > 0 && (
                  <small className="memory-model-hint">
                    {embeddingModels.length} embedding{' '}
                    {embeddingModels.length === 1 ? 'model' : 'models'} found — start typing to
                    filter.
                  </small>
                )}
                {embeddingModelsState === 'ready' && embeddingModels.length === 0 && (
                  <small className="memory-model-hint">
                    No embedding models found for this provider — it may not offer embeddings. Type a
                    model name if you know one.
                  </small>
                )}
                {embeddingModelsState === 'error' && (
                  <small className="memory-model-hint">
                    IRIS could not list this provider&apos;s models. Enter the model name manually.
                  </small>
                )}
              </label>
            </>
          )}
        </div>
        {retrievalDraft.strategy !== 'lexical' && embeddingProviders.length === 0 && (
          <div className="memory-retrieval-empty">
            No enabled provider supports embeddings yet. Add an OpenAI-compatible or Ollama provider
            in the Models object first.
          </div>
        )}
        {retrievalErrors.length > 0 && (
          <div className="form-errors">
            {retrievalErrors.map((retrievalError) => (
              <span key={retrievalError}>{retrievalError}</span>
            ))}
          </div>
        )}
        <div className="memory-retrieval-actions">
          {retrievalDraft.strategy !== 'lexical' && (
            <button
              className="row-button"
              disabled={retrievalState === 'testing'}
              onClick={() => void testRetrieval()}
            >
              {retrievalState === 'testing'
                ? 'Testing…'
                : retrievalState === 'connected'
                  ? 'Test passed'
                  : 'Test embedding'}
            </button>
          )}
          {retrievalConfig.strategy !== 'lexical' && configuredEmbeddingProvider && (
            <button
              className="row-button"
              disabled={embeddingIndexState?.state === 'rebuilding'}
              onClick={() => void rebuildEmbeddingIndex()}
            >
              {embeddingIndexState?.state === 'rebuilding'
                ? 'Rebuilding…'
                : embeddingIndexState?.state === 'ready'
                  ? 'Rebuild index'
                  : embeddingIndexState?.state === 'needs-rebuild' &&
                      embeddingIndexState.failedCount > 0
                    ? 'Retry index'
                    : 'Build index'}
            </button>
          )}
          <button className="soft-button primary-button" onClick={() => void saveRetrieval()}>
            {retrievalState === 'saved' ? 'Saved' : 'Save retrieval'}
          </button>
        </div>
      </section>

      <form className="memory-composer" onSubmit={remember}>
        <label htmlFor="memory-content">Add a workspace memory</label>
        <div>
          <textarea
            id="memory-content"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Write a fact or preference that should remain available…"
            rows={3}
          />
          <button className="soft-button primary-button" disabled={!draft.trim()}>
            Remember
          </button>
        </div>
        <small>
          Manual entries are immediate. Agents can write only through the separately assigned and
          permission-gated Memory tool.
        </small>
      </form>

      <section className="memory-access" aria-label="Agent memory access">
        <div className="section-heading">
          <h3>Agent access</h3>
          <span>Deny by default</span>
        </div>
        {agents.length === 0 ? (
          <div className="memory-access-empty">Create an agent before granting memory access.</div>
        ) : (
          <div className="memory-access-list">
            {agents.map((agent) => (
              <label key={agent.id}>
                <span className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</span>
                <span>
                  <strong>{agent.name}</strong>
                  <small>Applies to new and refreshed sessions</small>
                </span>
                <select
                  value={agent.memoryAccess ?? 'none'}
                  onChange={(event) =>
                    void setAgentAccess(agent, event.target.value as AgentMemoryAccess)
                  }
                >
                  <option value="none">No access</option>
                  <option value="read">Read</option>
                </select>
              </label>
            ))}
          </div>
        )}
      </section>

      {!loaded ? (
        <div className="memory-empty">Loading saved memory…</div>
      ) : records.length === 0 ? (
        <div className="memory-empty">
          <strong>No memories saved</strong>
          <p>Add a real record above. IRIS will not invent context to fill this space.</p>
        </div>
      ) : (
        <div className="memory-browser">
          <div className="memory-list" aria-label="Saved memories">
            {records.map((record) => (
              <button
                key={record.id}
                className={selected?.id === record.id ? 'selected' : ''}
                onClick={() => setSelectedId(record.id)}
              >
                <strong>{record.content}</strong>
                <small>{formatMemoryDate(record.createdAt)}</small>
              </button>
            ))}
          </div>
          {selected && (
            <article className="memory-detail">
              <div className="memory-detail-heading">
                <p className="eyebrow">Saved record</p>
                <button className="row-button danger-button" onClick={() => void forget(selected)}>
                  Forget
                </button>
              </div>
              <p className="memory-content">{selected.content}</p>
              <dl>
                <div>
                  <dt>Source</dt>
                  <dd>{selected.provenance.source === 'user' ? 'Manual entry' : 'Agent'}</dd>
                </div>
                <div>
                  <dt>Recorded by</dt>
                  <dd>{selected.provenance.actorName}</dd>
                </div>
                <div>
                  <dt>Captured</dt>
                  <dd>{formatMemoryDate(selected.provenance.capturedAt)}</dd>
                </div>
                {selected.provenance.source === 'agent' && (
                  <>
                    <div>
                      <dt>Originating turn</dt>
                      <dd>{selected.provenance.turnId}</dd>
                    </div>
                    <div>
                      <dt>Tool call</dt>
                      <dd>{selected.provenance.toolCallId}</dd>
                    </div>
                  </>
                )}
                <div>
                  <dt>Record ID</dt>
                  <dd>{selected.id}</dd>
                </div>
              </dl>
            </article>
          )}
        </div>
      )}
      {error && <p className="memory-error">{error}</p>}
        </>
      )}
    </div>
  );
}