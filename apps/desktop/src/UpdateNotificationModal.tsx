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
  const handleOpenRelease = () => {
    window.open(release.url, '_blank');
    onDismiss();
  };

  return (
    <div className={`update-modal-backdrop ${darkMode ? 'dark-mode' : ''}`}>
      <div
        className="update-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
      >
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
          >
            ×
          </button>
        </div>

        <div className="update-body">
          <h3 className="update-release-name">{release.name}</h3>
          <div className="update-notes-container">
            <p className="update-notes-label">What&apos;s new in this release:</p>
            <div className="update-notes-content">
              {release.notes.split('\n').map((line, idx) => {
                if (line.startsWith('- ') || line.startsWith('* ')) {
                  return (
                    <li key={idx} className="update-note-bullet">
                      {line.replace(/^[-*]\s+/, '')}
                    </li>
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
            onClick={onDismiss}
          >
            Maybe later
          </button>
          <button
            type="button"
            className="update-btn-primary"
            onClick={handleOpenRelease}
          >
            Get Update ⤤
          </button>
        </div>
      </div>
    </div>
  );
}
