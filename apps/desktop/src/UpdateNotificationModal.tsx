import { isTauri } from '@tauri-apps/api/core';
import {
  readableReleaseNotes,
  hasReleaseSummary,
  verifyUpdateTarget,
  verifyUpdateSignatureMetadata,
} from './updateReleaseNotes';
import { useState } from 'react';
import type { ReleaseInfo } from './updateChecker';

export function UpdateNotificationModal({
  release,
  onDismiss,
  darkMode,
}: {
  release: ReleaseInfo;
  onDismiss: () => void;
  darkMode: boolean;
}) {
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [statusText, setStatusText] = useState<string>('');
  const [errorText, setErrorText] = useState<string>('');

  async function handleAutoUpdate() {
    setDownloading(true);
    setErrorText('');
    setStatusText('Checking update package…');

    try {
      if (!isTauri())
        throw new Error('Automatic installation is available only in the native desktop app.');
      verifyUpdateTarget(release, release.version);
      // Load the native updater only after the user requests installation.
      const { check } = await import('@tauri-apps/plugin-updater');
      const { relaunch } = await import('@tauri-apps/plugin-process');

      const update = await check();
      if (!update)
        throw new Error('No newer installable package is available for this installation.');
      try {
        verifyUpdateTarget(release, update.version);
        verifyUpdateSignatureMetadata(update.rawJson);
      } catch (error) {
        await update.close();
        throw error;
      }

      let downloaded = 0;
      let contentLength = 0;

      setStatusText('Downloading update…');
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength ?? 0;
            setProgress(0);
            setStatusText('Starting download…');
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              const pct = Math.min(100, Math.round((downloaded / contentLength) * 100));
              setProgress(pct);
              setStatusText(`Downloading: ${pct}%`);
            } else {
              setStatusText(`Downloading: ${(downloaded / 1024 / 1024).toFixed(1)} MB`);
            }
            break;
          case 'Finished':
            setProgress(100);
            setStatusText('Installing update & restarting…');
            break;
        }
      });

      setStatusText('Restarting IRIS…');
      await relaunch();
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
      setStatusText('Update was not completed.');
    } finally {
      setDownloading(false);
    }
  }

  const handleOpenGitHub = () => {
    if (isTauri()) {
      void import('@tauri-apps/plugin-opener')
        .then(({ openUrl }) => openUrl(release.url))
        .catch((error: unknown) => setErrorText(String(error)));
    } else window.open(release.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className={`update-modal-backdrop ${darkMode ? 'dark-mode' : ''}`}>
      <div className="update-card" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <div className="update-header">
          <div className="update-badge">
            <span className="update-icon" aria-hidden="true">
              🚀
            </span>
            <div>
              <h2 id="update-title" className="update-title">
                IRIS Update Available
              </h2>
              <span className="update-version-pill">Version {release.version}</span>
            </div>
          </div>
          <button
            type="button"
            className="update-close-btn"
            onClick={onDismiss}
            aria-label="Close update notification"
            disabled={downloading}
          >
            ×
          </button>
        </div>

        <div className="update-body">
          <h3 className="update-release-name">{release.name}</h3>

          {errorText && (
            <div className="workspace-error" style={{ margin: '0 0 10px 0' }}>
              {errorText}
            </div>
          )}

          {downloading && (
            <div
              className="update-progress-container"
              style={{
                margin: '12px 0',
                padding: '12px',
                background: 'rgba(80,93,83,0.06)',
                borderRadius: '12px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '11px',
                  fontWeight: 600,
                  marginBottom: '6px',
                  color: 'var(--ink)',
                }}
              >
                <span>{statusText}</span>
                {progress !== null && <span>{progress}%</span>}
              </div>
              <div
                style={{
                  height: '6px',
                  background: 'var(--line)',
                  borderRadius: '4px',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${progress ?? 100}%`,
                    background: '#10b981',
                    transition: 'width 0.2s ease',
                  }}
                />
              </div>
            </div>
          )}

          <div className="update-notes-container">
            <p className="update-notes-label">What&apos;s new in this release:</p>
            {!hasReleaseSummary(release.notes, release.version) && (
              <p role="alert">
                A release summary is unavailable. Installation is disabled until the publisher
                supplies readable notes.
              </p>
            )}
            <div className="update-notes-content">
              {readableReleaseNotes(release.notes)
                .split('\n')
                .map((line, idx) => {
                  if (line.startsWith('• ')) {
                    return (
                      <p key={idx} className="update-note-bullet">
                        {line}
                      </p>
                    );
                  }
                  if (!line.trim()) return <br key={idx} />;
                  return <p key={idx}>{line}</p>;
                })}
            </div>
          </div>
        </div>

        <div className="update-footer">
          <button
            type="button"
            className="update-btn-secondary"
            onClick={handleOpenGitHub}
            disabled={downloading}
          >
            View Notes on GitHub ⤤
          </button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              className="update-btn-secondary"
              onClick={onDismiss}
              disabled={downloading}
            >
              Maybe later
            </button>
            <button
              type="button"
              className="update-btn-primary"
              onClick={handleAutoUpdate}
              disabled={downloading || !hasReleaseSummary(release.notes, release.version)}
            >
              {downloading ? 'Updating…' : '⚡ 1-Click Update'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
