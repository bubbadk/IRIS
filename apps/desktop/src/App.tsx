import type { IrisObjectType } from '@iris/core';
import { resolveWorkspaceIntent } from '@iris/cortex';
import { type WorkspaceMount } from '@iris/workspaces';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChatDesklet } from './ChatDesklet';
import { CommandPalette } from './CommandPalette';
import { subscribeDesktopActivity } from './desktopActivity';
import { objects } from './desktopObjects';
import { DesktopWidget } from './DesktopWidget';
import { HomeIcon, IrisMark, SearchIcon } from './icons';
import { restoreMcpServers } from './mcp';
import { OnboardingWizard, isOnboardingNeeded } from './OnboardingWizard';
import { workspaceRepository } from './persistence';
import { ProjectFlowStage } from './ProjectFlowStage';
import { startScheduledRuntime } from './scheduledRuntime';
import {
  onSudoPasswordRequestChange,
  resolveSudoPasswordRequest,
  type SudoPasswordRequest,
} from './sudoPasswordPrompt';
import { SystemPanel } from './SystemPanel';
import { checkLatestRelease, type ReleaseInfo } from './updateChecker';
import { UpdateNotificationModal } from './UpdateNotificationModal';
import { WindowFrame } from './WindowFrame';
import {
  defaultWindow,
  loadLayouts,
  loadWindows,
  normalizeWindow,
  saveLayout,
  saveWindows,
  windowLayerBase,
  type DesktopWindow,
} from './windowing';
import { subscribeWorkspace } from './workspace';

void restoreMcpServers();

function SudoPasswordPromptModal({
  command,
  onSubmit,
  onCancel,
}: {
  command: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function submit() {
    if (!password) return;
    onSubmit(password);
    setPassword('');
  }

  return (
    <div
      className="capability-picker-backdrop"
      role="presentation"
      onMouseDown={onCancel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <section
        className="sudo-password-prompt"
        role="dialog"
        aria-modal="true"
        aria-label="Sudo password"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="eyebrow">Local command needs sudo</p>
        <h3>Enter your password</h3>
        <pre>{command}</pre>
        <p className="agent-note">
          IRIS needs your local sudo password to run this. It is used once, sent straight to the
          command, and never stored or logged.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            ref={inputRef}
            type="password"
            value={password}
            autoComplete="off"
            placeholder="Password"
            onChange={(event) => setPassword(event.target.value)}
          />
          <div>
            <button type="button" className="row-button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="row-button approval-button" disabled={!password}>
              Run
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function App() {
  const [windows, setWindows] = useState<DesktopWindow[]>(() => {
    if (typeof window !== 'undefined' && window.location.search.includes('preview=desktop')) {
      return [
        {
          id: 'win-agents',
          objectType: 'agents',
          title: 'Agents',
          x: 60,
          y: 80,
          width: 820,
          height: 680,
          z: 11,
        },
        {
          id: 'win-workspace',
          objectType: 'workspace',
          title: 'Workspace',
          x: 920,
          y: 110,
          width: 760,
          height: 640,
          z: 12,
        },
      ];
    }
    return loadWindows();
  });
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('iris.theme') === 'dark');
  const [workspaceMount, setWorkspaceMount] = useState<WorkspaceMount | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(
    () => isOnboardingNeeded() && !window.location.search.includes('onboarding=false'),
  );
  const [availableUpdate, setAvailableUpdate] = useState<ReleaseInfo | null>(null);
  const [widgetMode, setWidgetMode] = useState(false);
  const [chatStarted, setChatStarted] = useState(false);
  const [query, setQuery] = useState('');
  const [sudoPasswordRequest, setSudoPasswordRequest] = useState<SudoPasswordRequest | null>(null);
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [layoutName, setLayoutName] = useState('My workspace');
  const [layoutNames, setLayoutNames] = useState<string[]>(() => {
    try {
      return Object.keys(loadLayouts());
    } catch {
      return [];
    }
  });
  const [layoutMessage, setLayoutMessage] = useState('');
  const restoreBounds = () => setWindows((current) => current.map((win) => normalizeWindow(win)));
  useEffect(() => {
    window.addEventListener('resize', restoreBounds);
    return () => window.removeEventListener('resize', restoreBounds);
  }, []);

  const topZ = useMemo(
    () => windows.reduce((max, win) => Math.max(max, win.z), windowLayerBase),
    [windows],
  );

  useEffect(() => saveWindows(windows), [windows]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    localStorage.setItem('iris.theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  useEffect(() => startScheduledRuntime(), []);
  useEffect(() => subscribeDesktopActivity(() => undefined), []);

  useEffect(() => {
    let active = true;
    void checkLatestRelease().then((release) => {
      if (active && release) {
        const dismissed = localStorage.getItem(`iris.update.dismissed.${release.version}`);
        if (!dismissed) setAvailableUpdate(release);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => onSudoPasswordRequestChange(setSudoPasswordRequest), []);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void workspaceRepository.get().then((mount) => {
        if (active) setWorkspaceMount(mount);
      });
    };
    refresh();
    const unsubscribe = subscribeWorkspace(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  function openObject(type: IrisObjectType | 'welcome') {
    const existing = windows.find((win) => win.objectType === type);
    if (existing) {
      focus(existing.id);
      return;
    }
    setWindows((current) => [...current, normalizeWindow(defaultWindow(type, topZ + 1))]);
  }

  function focus(id: string) {
    setWindows((current) => {
      const highestZ = current.reduce((max, win) => Math.max(max, win.z), windowLayerBase);
      const target = current.find((win) => win.id === id);
      if (!target || target.z === highestZ) return current;
      return current.map((win) => (win.id === id ? { ...win, z: highestZ + 1 } : win));
    });
  }

  function submitCommand(event: React.FormEvent) {
    event.preventDefault();
    const target = resolveWorkspaceIntent(query);
    if (target) {
      openObject(target);
      setQuery('');
      return;
    }
    setChatStarted(true);
  }

  if (widgetMode) {
    return <DesktopWidget onRestore={() => setWidgetMode(false)} darkMode={darkMode} />;
  }

  return (
    <main
      className={`desktop-shell ${chatStarted ? 'chat-active' : ''} ${darkMode ? 'dark-mode' : ''}`}
    >
      <header className="topbar">
        <div className="brand">
          <IrisMark />
          <span>IRIS</span>
        </div>
        <div className="top-status">
          <span className="status-dot" />{' '}
          {workspaceMount ? `${workspaceMount.name} mounted` : 'No folder mounted'}
        </div>
        <div className="top-actions">
          <details className="layout-menu">
            <summary>Layouts</summary>
            <div className="layout-menu-content">
              <button className="soft-button" onClick={restoreBounds}>
                Bring all windows into view
              </button>
              <label>
                Layout name
                <input value={layoutName} onChange={(event) => setLayoutName(event.target.value)} />
              </label>
              <button
                className="soft-button"
                onClick={() => {
                  try {
                    saveLayout(layoutName, windows);
                    setLayoutNames(Object.keys(loadLayouts()));
                    setLayoutMessage('Layout saved.');
                  } catch (error) {
                    setLayoutMessage(String(error));
                  }
                }}
              >
                Save current layout
              </button>
              {layoutNames.map((name) => (
                <button
                  key={name}
                  className="soft-button"
                  onClick={() => {
                    try {
                      const layout = loadLayouts()[name];
                      if (layout) setWindows(layout.map((win) => normalizeWindow(win)));
                      setLayoutMessage('Layout restored.');
                    } catch (error) {
                      setLayoutMessage(String(error));
                    }
                  }}
                >
                  Restore {name}
                </button>
              ))}
              <span role="status">{layoutMessage}</span>
            </div>
          </details>
          <button
            className="widget-toggle-btn"
            onClick={() => setWidgetMode(true)}
            title="Minimize to Desktop Desklet"
            aria-label="Desktop widget mode"
          >
            <span aria-hidden="true">🛸</span> Desklet
          </button>
          <button
            className="theme-toggle"
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            title={darkMode ? 'Light mode' : 'Dark mode'}
            onClick={() => setDarkMode((current) => !current)}
          >
            {darkMode ? '☀' : '☾'}
          </button>
        </div>
      </header>

      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <SystemPanel onOpenProject={(id) => setFocusedProjectId(id)} />

      <section className="command-stage">
        <div className="stage-mark">
          <IrisMark />
        </div>
        <p className="eyebrow">Intelligent Reasoning & Integration System</p>
        <h1>What would you like to work on?</h1>
        {chatStarted ? (
          <ChatDesklet
            initialQuery={query}
            onStarted={() => setChatStarted(true)}
            onReset={() => {
              setChatStarted(false);
              setQuery('');
            }}
          />
        ) : (
          <form className="command-bar" onSubmit={submitCommand}>
            <SearchIcon />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => setChatStarted(true)}
              placeholder="Start a chat or open an object…"
              aria-label="IRIS command"
            />
            <kbd>Enter</kbd>
          </form>
        )}
      </section>

      <section className="desktop-objects" aria-label="IRIS objects">
        {objects.slice(0, 4).map(({ type, label, Icon }) => (
          <button
            className="desktop-object"
            key={type}
            onDoubleClick={() => openObject(type)}
            onClick={() => openObject(type)}
          >
            <span className={`object-glyph object-${type}`}>
              <Icon />
            </span>
            <span>{label}</span>
          </button>
        ))}
      </section>

      {windows.map((win) => (
        <WindowFrame
          key={win.id}
          win={win}
          onOpenProject={(id) => setFocusedProjectId(id)}
          onClose={() => setWindows((current) => current.filter((item) => item.id !== win.id))}
          onFocus={() => focus(win.id)}
          onChange={(next) =>
            setWindows((current) =>
              current.map((item) =>
                item.id === win.id
                  ? {
                      ...item,
                      x: next.x,
                      y: next.y,
                      width: next.width,
                      height: next.height,
                    }
                  : item,
              ),
            )
          }
        />
      ))}

      <nav className="dock" aria-label="IRIS dock">
        <button className="dock-item" onClick={() => setWindows([])} aria-label="Clear workspace">
          <HomeIcon />
        </button>
        <span className="dock-separator" />
        {objects.map(({ type, label, Icon }) => (
          <button
            key={type}
            className="dock-item"
            onClick={() => openObject(type)}
            aria-label={label}
            title={label}
          >
            <Icon />
            {windows.some((win) => win.objectType === type) && <span className="running-dot" />}
          </button>
        ))}
      </nav>

      {sudoPasswordRequest && (
        <SudoPasswordPromptModal
          command={sudoPasswordRequest.command}
          onSubmit={(password) => resolveSudoPasswordRequest(password)}
          onCancel={() => resolveSudoPasswordRequest(null)}
        />
      )}

      <CommandPalette
        open={paletteOpen}
        commands={objects.map(({ type, label, description }) => ({ type, label, description }))}
        onClose={() => setPaletteOpen(false)}
        onSelect={(type) => openObject(type)}
      />

      {showOnboarding && (
        <OnboardingWizard onFinish={() => setShowOnboarding(false)} darkMode={darkMode} />
      )}

      {availableUpdate && (
        <UpdateNotificationModal
          release={availableUpdate}
          onDismiss={() => {
            localStorage.setItem(`iris.update.dismissed.${availableUpdate.version}`, 'true');
            setAvailableUpdate(null);
          }}
          darkMode={darkMode}
        />
      )}

      {focusedProjectId && (
        <ProjectFlowStage projectId={focusedProjectId} onClose={() => setFocusedProjectId(null)} />
      )}
    </main>
  );
}
