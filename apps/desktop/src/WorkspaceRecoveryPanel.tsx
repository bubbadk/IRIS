import { useEffect, useState } from 'react';
import type {
  WorkspaceIsolationStatus,
  WorkspaceRestorePoint,
  WorkspaceRestorePreview,
} from '@iris/workspaces';
import { workspaceRecovery } from './workspaceRecovery';
import { notifyWorkspaceChanged, subscribeWorkspace } from './workspace';

const stateLabels: Record<WorkspaceRestorePoint['state'], string> = {
  ready: 'Matches saved edit',
  original: 'Original contents present',
  conflict: 'Changed since this edit',
  unavailable: 'File unavailable',
};
const previewLimit = 12_000;

export function WorkspaceRecoveryPanel() {
  const [isolation, setIsolation] = useState<WorkspaceIsolationStatus | null>(null);
  const [points, setPoints] = useState<WorkspaceRestorePoint[]>([]);
  const [preview, setPreview] = useState<WorkspaceRestorePreview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void workspaceRecovery
      .isolation()
      .then((result) => {
        if (active) setIsolation(result);
      })
      .catch((failure) => {
        if (active) setIsolation({ available: false, detail: String(failure) });
      });
    const load = async () => {
      try {
        const result = await workspaceRecovery.list();
        if (active) setPoints(result);
      } catch (failure) {
        if (active)
          setError(failure instanceof Error ? failure.message : 'Restore history is unavailable.');
      } finally {
        if (active) setLoaded(true);
      }
    };
    void load();
    const unsubscribe = subscribeWorkspace(() => void load());
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function act(id?: string, restore = false) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (id && restore) {
        const path = await workspaceRecovery.restore(id);
        setNotice(`Restored the previous state of ${path}.`);
        setPreview(null);
        notifyWorkspaceChanged();
      } else if (id) setPreview(await workspaceRecovery.preview(id));
      const result = await workspaceRecovery.list();
      setPoints(result);
      setLoaded(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The restore operation failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="workspace-recovery" aria-label="Workspace isolation and restore points">
      <div className="workspace-recovery-status">
        <strong>
          {isolation
            ? isolation.available
              ? 'Shell isolation available'
              : 'Shell isolation unavailable'
            : 'Checking shell isolation…'}
        </strong>
        {isolation && <p>{isolation.detail}</p>}
      </div>
      <div className="workspace-change-heading">
        <div>
          <p className="section-label">File restore points</p>
          <strong>Review an edit before undoing it.</strong>
        </div>
        <button type="button" className="row-button" disabled={busy} onClick={() => void act()}>
          Refresh restore points
        </button>
      </div>
      <p>
        Original text is saved before workspace write and patch tools change a file, up to 1 MiB.
        Shell commands, moves and deletions are not covered. Newer file contents block a restore.
      </p>
      {!loaded ? (
        <p>Loading local restore points…</p>
      ) : points.length === 0 ? (
        <p>No file restore points saved yet.</p>
      ) : (
        <ul className="workspace-restore-list">
          {points.map((point) => (
            <li key={point.id}>
              <div>
                <strong>{point.path}</strong>
                <small>
                  {stateLabels[point.state]} · {new Date(point.createdAtMs).toLocaleString()}
                </small>
              </div>
              <button
                type="button"
                className="row-button"
                disabled={busy || point.state !== 'ready'}
                onClick={() => void act(point.id)}
              >
                Review restore
              </button>
            </li>
          ))}
        </ul>
      )}
      {points.length >= 50 && (
        <small>Showing the 50 most recent restore points for this folder.</small>
      )}
      {preview && (
        <div className="workspace-restore-preview">
          <strong>Restore {preview.summary.path}</strong>
          <p>
            {preview.before === null
              ? 'This file was created by the saved edit. Restoring will remove it.'
              : 'Restore the saved original text. Current contents must still match this edit.'}
          </p>
          <div className="workspace-restore-columns">
            <div>
              <small>Expected current text</small>
              <pre>{preview.after.slice(0, previewLimit)}</pre>
            </div>
            <div>
              <small>Previous text to restore</small>
              <pre>
                {preview.before === null
                  ? '(File did not exist)'
                  : preview.before.slice(0, previewLimit)}
              </pre>
            </div>
          </div>
          {(preview.after.length > previewLimit ||
            (preview.before?.length ?? 0) > previewLimit) && (
            <small>
              Preview shortened to 12,000 characters per side. The complete saved file is restored.
            </small>
          )}
          <div className="workspace-restore-actions">
            <button
              type="button"
              className="row-button"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="soft-button primary-button"
              disabled={busy || preview.summary.state !== 'ready'}
              onClick={() => void act(preview.summary.id, true)}
            >
              ✓ Restore previous state
            </button>
          </div>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
