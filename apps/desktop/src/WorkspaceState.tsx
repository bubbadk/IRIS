import { useEffect, useState } from 'react';
import type {
  WorkspaceGitStatus,
  WorkspaceListing,
  WorkspaceMount,
  WorkspaceSearchResult,
  WorkspaceTextFile,
} from '@iris/workspaces';
import { isTauriRuntime } from './credentials';
import {
  chooseWorkspaceFolder,
  mountWorkspace,
  subscribeWorkspace,
  unmountWorkspace,
  workspaceService,
} from './workspace';

function formatBytes(value?: number): string {
  if (value === undefined) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function parentPath(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

export function WorkspaceState() {
  const native = isTauriRuntime();
  const [mount, setMount] = useState<WorkspaceMount | null>(null);
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(null);
  const [selectedFile, setSelectedFile] = useState<WorkspaceTextFile | null>(null);
  const [search, setSearch] = useState<WorkspaceSearchResult | null>(null);
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const configured = await workspaceService.current();
        if (!active) return;
        setMount(configured);
        if (configured && native) {
          setListing(await workspaceService.list());
          try {
            const git = await workspaceService.gitStatus?.();
            if (active && git) setGitStatus(git);
          } catch {
            /* git is best-effort */
          }
        }
      } catch (workspaceError) {
        if (!active) return;
        setError(
          workspaceError instanceof Error
            ? workspaceError.message
            : 'The configured workspace is unavailable.',
        );
      } finally {
        if (active) setLoaded(true);
      }
    }
    void load();
    const unsubscribe = subscribeWorkspace(() => void load());
    return () => {
      active = false;
      unsubscribe();
    };
  }, [native]);

  async function chooseFolder() {
    setBusy(true);
    setError('');
    try {
      const selected = await chooseWorkspaceFolder();
      if (!selected) return;
      const connected = await mountWorkspace(selected);
      setMount(connected);
      setListing(await workspaceService.list());
      setSelectedFile(null);
      setSearch(null);
    } catch (workspaceError) {
      setError(
        workspaceError instanceof Error ? workspaceError.message : 'Workspace connection failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      await unmountWorkspace();
      setMount(null);
      setListing(null);
      setSelectedFile(null);
      setSearch(null);
      setQuery('');
    } catch (workspaceError) {
      setError(
        workspaceError instanceof Error ? workspaceError.message : 'Workspace disconnect failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function openDirectory(relativePath: string) {
    setBusy(true);
    setError('');
    try {
      setListing(await workspaceService.list(relativePath));
      setSelectedFile(null);
      setSearch(null);
    } catch (workspaceError) {
      setError(
        workspaceError instanceof Error ? workspaceError.message : 'Directory could not be read.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function openFile(relativePath: string) {
    setBusy(true);
    setError('');
    try {
      setSelectedFile(await workspaceService.read(relativePath));
      setSearch(null);
    } catch (workspaceError) {
      setSelectedFile(null);
      setError(
        workspaceError instanceof Error ? workspaceError.message : 'File could not be read.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function searchWorkspace(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError('');
    try {
      setSearch(await workspaceService.search(query));
      setSelectedFile(null);
    } catch (workspaceError) {
      setSearch(null);
      setError(
        workspaceError instanceof Error ? workspaceError.message : 'Workspace search failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace-state">
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">Local workspace</p>
          <h2>Bring real files into reach.</h2>
          <p>
            Mount one local folder. IRIS exposes only bounded operations, and every agent needs
            explicit permission before it can read or change files.
          </p>
        </div>
        {mount ? (
          <div className="workspace-heading-actions">
            <button className="row-button" disabled={busy} onClick={() => void chooseFolder()}>
              Change folder
            </button>
            <button className="row-button" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        ) : (
          <button
            className="soft-button primary-button"
            disabled={busy || !native}
            onClick={() => void chooseFolder()}
          >
            {busy ? 'Connecting…' : 'Choose folder'}
          </button>
        )}
      </header>

      {!loaded ? (
        <div className="workspace-empty">Loading local workspace state…</div>
      ) : !native ? (
        <div className="workspace-empty">
          <strong>Native desktop required</strong>
          <p>The browser preview cannot read local folders and does not simulate their contents.</p>
        </div>
      ) : !mount ? (
        <div className="workspace-empty">
          <strong>No folder mounted</strong>
          <p>Choose a folder above. Nothing outside it will be exposed through workspace tools.</p>
        </div>
      ) : (
        <div className="workspace-browser">
          <aside className="workspace-mount-card">
            <span className="workspace-folder-mark">⌁</span>
            <div>
              <p className="section-label">Mounted</p>
              <strong>{mount.name}</strong>
              <small title={mount.rootPath}>{mount.rootPath}</small>
            </div>
            <dl>
              <div>
                <dt>Mode</dt>
                <dd>Permission-gated</dd>
              </div>
              <div>
                <dt>Verified</dt>
                <dd>
                  {new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(
                    new Date(mount.verifiedAt),
                  )}
                </dd>
              </div>
            </dl>
            {gitStatus?.isGitRepo && (
              <div className="workspace-git-badge">
                <div className="git-branch-info">
                  <span className="git-branch-icon">🌿</span>
                  <strong>{gitStatus.branch}</strong>
                </div>
                {gitStatus.hasChanges ? (
                  <span className="git-changes-pill">
                    {gitStatus.modifiedFiles.length +
                      gitStatus.untrackedFiles.length +
                      gitStatus.stagedFiles.length}{' '}
                    changes
                  </span>
                ) : (
                  <span className="git-clean-pill">Clean</span>
                )}
              </div>
            )}
            <p>
              Agents see the workspace name, but file access remains unavailable until list, search
              or read is assigned and allowed in System.
            </p>
          </aside>

          <section className="workspace-files">
            <div className="workspace-toolbar">
              <div className="workspace-path">
                <button
                  disabled={!listing?.relativePath || busy}
                  onClick={() => void openDirectory(parentPath(listing?.relativePath ?? ''))}
                >
                  ←
                </button>
                <span>{listing?.relativePath || mount.name}</span>
              </div>
              <form onSubmit={(event) => void searchWorkspace(event)}>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search real files…"
                  aria-label="Search workspace"
                />
                <button className="row-button" disabled={busy || !query.trim()}>
                  Search
                </button>
              </form>
            </div>

            {search ? (
              <div className="workspace-result-panel">
                <div className="workspace-panel-heading">
                  <div>
                    <p className="section-label">Search results</p>
                    <strong>
                      {search.matches.length} matches for “{search.query}”
                    </strong>
                  </div>
                  <button className="row-button" onClick={() => setSearch(null)}>
                    Close
                  </button>
                </div>
                {search.matches.length === 0 ? (
                  <div className="workspace-panel-empty">No real path or text match was found.</div>
                ) : (
                  <ul className="workspace-search-list">
                    {search.matches.map((match, index) => (
                      <li key={`${match.relativePath}:${match.match}:${match.line ?? 0}:${index}`}>
                        <button onClick={() => void openFile(match.relativePath)}>
                          <strong>{match.relativePath}</strong>
                          <span>
                            {match.match}
                            {match.line ? ` · line ${match.line}` : ''}
                          </span>
                          <small>{match.preview}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {search.truncated && (
                  <p className="workspace-limit-note">
                    Search stopped at the bounded native limit.
                  </p>
                )}
              </div>
            ) : selectedFile ? (
              <div className="workspace-result-panel file-preview">
                <div className="workspace-panel-heading">
                  <div>
                    <p className="section-label">Text preview</p>
                    <strong>{selectedFile.relativePath}</strong>
                  </div>
                  <button className="row-button" onClick={() => setSelectedFile(null)}>
                    Close
                  </button>
                </div>
                <pre>{selectedFile.content}</pre>
                <small>
                  {formatBytes(selectedFile.bytesRead)} read
                  {selectedFile.truncated ? ' · preview truncated' : ''}
                </small>
              </div>
            ) : listing?.entries.length ? (
              <ul className="workspace-entry-list">
                {listing.entries.map((entry) => (
                  <li key={entry.relativePath}>
                    <button
                      disabled={busy || entry.kind === 'symlink'}
                      onClick={() =>
                        void (entry.kind === 'directory'
                          ? openDirectory(entry.relativePath)
                          : openFile(entry.relativePath))
                      }
                    >
                      <span className={`workspace-entry-icon entry-${entry.kind}`}>
                        {entry.kind === 'directory' ? '⌁' : entry.kind === 'symlink' ? '↗' : '·'}
                      </span>
                      <span>
                        <strong>{entry.name}</strong>
                        <small>
                          {entry.kind}
                          {entry.size !== undefined ? ` · ${formatBytes(entry.size)}` : ''}
                        </small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="workspace-panel-empty">This directory is empty.</div>
            )}
            {listing?.truncated && (
              <p className="workspace-limit-note">Only the first 500 entries are shown.</p>
            )}
          </section>
        </div>
      )}
      {error && <p className="workspace-error">{error}</p>}
    </div>
  );
}
