import { bumpSemVer } from '@iris/github';

export function GitHubReleaseDialog({
  showReleaseModal,
  setShowReleaseModal,
  newReleaseTag,
  setNewReleaseTag,
  newReleaseTitle,
  setNewReleaseTitle,
  newReleaseNotes,
  setNewReleaseNotes,
  handlePublishRelease,
  busy,
}: {
  showReleaseModal: boolean;
  setShowReleaseModal: (value: boolean) => void;
  newReleaseTag: string;
  setNewReleaseTag: (value: string) => void;
  newReleaseTitle: string;
  setNewReleaseTitle: (value: string) => void;
  newReleaseNotes: string;
  setNewReleaseNotes: (value: string) => void;
  handlePublishRelease: () => Promise<void>;
  busy: boolean;
}) {
  return (
    <>
      {' '}
      {/* Release Creation Modal */}
      {showReleaseModal && (
        <div className="github-modal-overlay" onClick={() => setShowReleaseModal(false)}>
          <div className="github-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="github-modal-header">
              <h3 className="github-modal-title">Create New Release & Trigger Build</h3>
              <button
                type="button"
                onClick={() => setShowReleaseModal(false)}
                className="row-button"
              >
                ✕
              </button>
            </div>

            <div className="github-form-group">
              <label>SemVer Tag *</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  value={newReleaseTag}
                  onChange={(e) => setNewReleaseTag(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => setNewReleaseTag(bumpSemVer(newReleaseTag, 'patch'))}
                  className="soft-button"
                  style={{ fontSize: '10.5px', padding: '4px 8px' }}
                >
                  Patch
                </button>
                <button
                  type="button"
                  onClick={() => setNewReleaseTag(bumpSemVer(newReleaseTag, 'minor'))}
                  className="soft-button"
                  style={{ fontSize: '10.5px', padding: '4px 8px' }}
                >
                  Minor
                </button>
                <button
                  type="button"
                  onClick={() => setNewReleaseTag(bumpSemVer(newReleaseTag, 'major'))}
                  className="soft-button"
                  style={{ fontSize: '10.5px', padding: '4px 8px' }}
                >
                  Major
                </button>
              </div>
            </div>

            <div className="github-form-group">
              <label>Release Title</label>
              <input
                type="text"
                value={newReleaseTitle}
                onChange={(e) => setNewReleaseTitle(e.target.value)}
              />
            </div>

            <div className="github-form-group">
              <label>Release Notes & Changelog</label>
              <textarea
                rows={4}
                placeholder="Describe highlights, new features and fixes in this release…"
                value={newReleaseNotes}
                onChange={(e) => setNewReleaseNotes(e.target.value)}
              />
            </div>

            <div className="github-modal-actions">
              <button
                type="button"
                onClick={() => setShowReleaseModal(false)}
                className="row-button"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handlePublishRelease}
                disabled={busy || !newReleaseTag.trim() || !newReleaseNotes.trim()}
                className="soft-button primary-button"
              >
                {busy ? 'Publishing…' : 'Publish Release & Trigger Build'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
