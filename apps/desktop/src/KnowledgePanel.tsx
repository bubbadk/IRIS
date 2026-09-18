import { useEffect, useState } from 'react';
import {
  knowledgeConflicts,
  knowledgeExpired,
  possibleKnowledgeConflicts,
  sameKnowledgeScope,
  type KnowledgeEntry,
  type KnowledgeScope,
} from '@iris/memory';
import { knowledgeRepository, notifyKnowledgeChanged, subscribeKnowledge } from './knowledge';
function localDateInput(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function KnowledgePanel({ scope }: { scope: KnowledgeScope }) {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<'fact' | 'preference'>('fact');
  const [topic, setTopic] = useState('');
  const [content, setContent] = useState('');
  const [sourceReference, setSourceReference] = useState('');
  const [expires, setExpires] = useState('');
  const [replacesId, setReplacesId] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const records = await knowledgeRepository.list();
        if (active) setEntries(records);
      } catch (failure) {
        if (active) setError(String(failure));
      } finally {
        if (active) setLoaded(true);
      }
    };
    const reload = () => void load();
    reload();
    const unsubscribe = subscribeKnowledge(reload);
    window.addEventListener('focus', reload);
    window.addEventListener('storage', reload);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('focus', reload);
      window.removeEventListener('storage', reload);
    };
  }, [refresh]);
  const scoped = entries.filter((entry) => sameKnowledgeScope(scope, entry.scope));
  const now = new Date().toISOString();
  function begin(entry?: KnowledgeEntry) {
    setKind(entry?.kind ?? 'fact');
    setTopic(entry?.topic ?? '');
    setContent(entry?.content ?? '');
    setSourceReference(entry?.sourceReference ?? '');
    setExpires(localDateInput(entry?.expiresAt));
    setReplacesId(entry?.id);
    setEditing(true);
    setNotice('');
    setError('');
  }
  async function save() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const createdAt = new Date().toISOString();
      await knowledgeRepository.propose({
        id: crypto.randomUUID(),
        scope,
        kind,
        topic,
        content,
        createdAt,
        ...(sourceReference.trim() ? { sourceReference: sourceReference.trim() } : {}),
        ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}),
        ...(replacesId ? { replacesId } : {}),
        provenance: {
          source: 'user',
          actorId: 'local-user',
          actorName: 'You',
          capturedAt: createdAt,
        },
      });
      setEditing(false);
      setNotice('Saved for review. Approve this entry before agents can use it.');
      notifyKnowledgeChanged();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }
  async function review(entry: KnowledgeEntry, decision: 'activate' | 'archive') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const conflicts = decision === 'activate' ? knowledgeConflicts(entries, entry) : [];
      await knowledgeRepository.review(
        entry.id,
        entry.revision,
        decision,
        Object.fromEntries(conflicts.map((item) => [item.id, item.revision])),
      );
      setNotice(
        decision === 'activate'
          ? 'Approved for future turns. Existing running turns retain their earlier context.'
          : 'Archived. This entry will not be used in future turns.',
      );
      notifyKnowledgeChanged();
    } catch (failure) {
      setError(String(failure));
      setRefresh((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="knowledge-panel"
      aria-label={
        scope.kind === 'global'
          ? 'Global knowledge and preferences'
          : 'Project knowledge and preferences'
      }
    >
      <header>
        <p className="eyebrow">
          {scope.kind === 'global' ? 'Global knowledge' : 'Project knowledge'}
        </p>
        <h3>Facts and preferences that carry forward.</h3>
        <p>
          Approved entries guide future turns for agents with memory access. Project entries
          override global entries with the same kind and topic.
        </p>
      </header>
      <div className="knowledge-toolbar">
        <button className="soft-button" disabled={busy || editing} onClick={() => begin()}>
          Add knowledge
        </button>
        <button
          className="row-button"
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh knowledge
        </button>
        <label>
          <input
            type="checkbox"
            checked={showHistory}
            onChange={(event) => setShowHistory(event.target.checked)}
          />{' '}
          Show archived history
        </label>
      </div>
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            Kind
            <select
              disabled={busy}
              value={kind}
              onChange={(event) => setKind(event.target.value as 'fact' | 'preference')}
            >
              <option value="fact">Fact</option>
              <option value="preference">Preference</option>
            </select>
          </label>
          <label>
            Topic
            <input
              disabled={busy}
              value={topic}
              required
              maxLength={120}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="For example, writing language"
            />
          </label>
          <label>
            Knowledge content
            <textarea
              disabled={busy}
              value={content}
              required
              maxLength={4096}
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          <label>
            Source or reference (optional)
            <input
              disabled={busy}
              value={sourceReference}
              maxLength={1000}
              onChange={(event) => setSourceReference(event.target.value)}
            />
          </label>
          <label>
            Expires (local time, optional)
            <input
              disabled={busy}
              type="datetime-local"
              value={expires}
              onChange={(event) => setExpires(event.target.value)}
            />
          </label>
          {replacesId && (
            <small>The existing entry remains unchanged until you approve its replacement.</small>
          )}
          <div className="knowledge-toolbar">
            <button
              className="soft-button primary-button"
              disabled={busy || !topic.trim() || !content.trim()}
            >
              Save for review
            </button>
            <button
              type="button"
              className="row-button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Discard draft
            </button>
          </div>
        </form>
      )}
      {!loaded ? (
        <p>Loading saved knowledge…</p>
      ) : !scoped.some((entry) => showHistory || entry.status !== 'archived') ? (
        <p>No knowledge entries in this scope yet.</p>
      ) : (
        scoped
          .filter((entry) => showHistory || entry.status !== 'archived')
          .map((entry) => {
            const expired = knowledgeExpired(entry, now),
              conflicts = knowledgeConflicts(entries, entry),
              possibleConflicts = possibleKnowledgeConflicts(entries, entry);
            return (
              <article key={entry.id} className="knowledge-entry">
                <div className="knowledge-entry-title">
                  <strong>{entry.topic}</strong>
                  <span>
                    {entry.kind} · {entry.status}
                    {expired ? ' · expired' : ''}
                  </span>
                </div>
                <p className="knowledge-content">{entry.content}</p>
                <small>
                  From {entry.provenance.actorName} · {new Date(entry.createdAt).toLocaleString()}
                  {entry.reviewedAt
                    ? ` · Reviewed ${new Date(entry.reviewedAt).toLocaleString()}`
                    : ''}
                </small>
                {entry.sourceReference && (
                  <p className="knowledge-source">Source: {entry.sourceReference}</p>
                )}
                {entry.expiresAt && (
                  <small>Expires {new Date(entry.expiresAt).toLocaleString()}</small>
                )}
                <details>
                  <summary>Origin and identity</summary>
                  <small>
                    Entry {entry.id} · revision {entry.revision}
                    {entry.replacesId ? ` · Replaces ${entry.replacesId}` : ''}
                    {entry.provenance.source === 'agent'
                      ? ` · Agent turn ${entry.provenance.turnId} · Tool call ${entry.provenance.toolCallId}`
                      : ''}
                  </small>
                </details>
                {entry.status === 'proposed' && conflicts.length > 0 && (
                  <div className="knowledge-conflict">
                    <strong>Approval replaces these active entries:</strong>
                    {conflicts.map((conflict) => (
                      <p key={conflict.id}>
                        {conflict.topic}: {conflict.content}
                      </p>
                    ))}
                  </div>
                )}
                {entry.status === 'proposed' && possibleConflicts.length > 0 && (
                  <div className="knowledge-conflict">
                    <strong>Possible related knowledge — review manually:</strong>
                    {possibleConflicts.map((conflict) => (
                      <p key={conflict.id}>
                        {conflict.topic}: {conflict.content}
                      </p>
                    ))}
                  </div>
                )}
                <div className="knowledge-toolbar">
                  {entry.status === 'proposed' && (
                    <button
                      className="soft-button primary-button"
                      disabled={busy || expired}
                      onClick={() => void review(entry, 'activate')}
                    >
                      {conflicts.length
                        ? 'Approve and replace conflicting entries'
                        : 'Approve for use'}
                    </button>
                  )}
                  <button
                    className="row-button"
                    disabled={busy || editing}
                    onClick={() => begin(entry)}
                  >
                    Create revision
                  </button>
                  {entry.status !== 'archived' && (
                    <button
                      className="row-button"
                      disabled={busy}
                      onClick={() => void review(entry, 'archive')}
                    >
                      {entry.status === 'proposed' ? 'Reject and archive' : 'Archive'}
                    </button>
                  )}
                </div>
              </article>
            );
          })
      )}
      <small>
        Approval allows use; IRIS has not independently checked accuracy. Proposed, archived and
        expired entries are excluded. Each new turn includes up to 20 eligible entries, with
        preferences first and newer entries next. Running turns keep their recorded context.
        Archived history is retained. Unsaved drafts do not survive closing this window.
      </small>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
