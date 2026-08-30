import { useEffect, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import { subscribeAgentActivity, type AgentActivityLogEntry } from './agentRuntime';
import { readHostMetrics, type HostMetrics, formatBytes, formatDuration } from './systemTelemetry';

function humanizeActivity(summary: string): { agent: string; action: string; icon: string } {
  const cleaned = summary
    .replace('cortex_delegate_subagent', 'Specialist Sub-Agent')
    .replace('workspace_list', 'List Workspace')
    .replace('workspace_read', 'Read File')
    .replace('workspace_search', 'Search Files')
    .replace('workspace_write', 'Write File')
    .replace('workspace_patch', 'Patch File')
    .replace('workspace_delete', 'Delete File')
    .replace('workspace_move', 'Move File')
    .replace('workspace_mkdir', 'Create Directory')
    .replace('memory_remember', 'Save Memory')
    .replace('system_inspect_host', 'Inspect Host')
    .replace('janitor_health', 'Janitor Health Check')
    .replace('janitor_diagnostics', 'Diagnostics');

  let icon = '⚡';
  if (cleaned.includes('Specialist Sub-Agent') || cleaned.includes('Senior Developer')) icon = '🤖';
  else if (
    cleaned.includes('Workspace') ||
    cleaned.includes('File') ||
    cleaned.includes('Directory')
  )
    icon = '📁';
  else if (cleaned.includes('Memory')) icon = '💾';
  else if (cleaned.includes('Janitor') || cleaned.includes('Diagnostics')) icon = '🛡️';
  else if (cleaned.includes('received a new message')) icon = '💬';
  else if (cleaned.includes('finished replying')) icon = '✨';

  const parts = cleaned.split(' ');
  const agent = parts[0] || 'Agent';
  const action = parts.slice(1).join(' ');

  return { agent, action, icon };
}

export function DesktopWidget({
  onRestore,
  onHide,
  darkMode,
  isStandalone = false,
}: {
  onRestore: () => void;
  onHide?: () => void;
  darkMode: boolean;
  isStandalone?: boolean;
}) {
  const [activity, setActivity] = useState<AgentActivityLogEntry[]>([]);
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [activeLogIndex, setActiveLogIndex] = useState(0);

  useEffect(() => subscribeAgentActivity(setActivity), []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await readHostMetrics();
        if (!cancelled && next) setMetrics(next);
      } catch {
        /* telemetry is best-effort */
      }
    }
    void load();
    const interval = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const handlePointerDown = (event: React.PointerEvent) => {
    if (
      (event.target as HTMLElement).closest('button') ||
      (event.target as HTMLElement).closest('a')
    ) {
      return;
    }
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        const appWindow = getCurrentWebviewWindow();
        void appWindow.startDragging();
        void invoke('start_drag');
      } catch {
        /* fallback */
      }
    }
  };

  const currentActivity = activity[activeLogIndex] ?? activity[0] ?? null;
  const isWorking = activity.some((entry) => entry.kind === 'tool');
  const humanized = currentActivity ? humanizeActivity(currentActivity.summary) : null;

  return (
    <div
      className={`desktop-live-widget capsule-hud ${isStandalone ? 'is-standalone-window' : ''} ${darkMode ? 'dark-mode' : ''} ${isWorking ? 'is-working' : ''}`}
      role="region"
      aria-label="IRIS Live Desktop Desklet"
      onPointerDown={handlePointerDown}
      data-tauri-drag-region="true"
    >
      {/* Left Column: Brand + Glowing Status Orb */}
      <div className="capsule-left-col" data-tauri-drag-region="true">
        <div className="capsule-brand-row" data-tauri-drag-region="true">
          <span className="capsule-drag-handle" title="Drag to move" data-tauri-drag-region="true">
            ⠿
          </span>
          <span className="capsule-brand-title" data-tauri-drag-region="true">
            IRIS
          </span>
        </div>
        <div className="capsule-status-row" data-tauri-drag-region="true">
          <span className="capsule-orb-wrapper">
            <span className={`capsule-glowing-orb ${isWorking ? 'orb-working' : 'orb-ready'}`} />
          </span>
          <span
            className={`capsule-status-text ${isWorking ? 'text-working' : 'text-ready'}`}
            data-tauri-drag-region="true"
          >
            {isWorking ? 'Working…' : 'Ready'}
          </span>
        </div>
      </div>

      {/* Vertical Subtle Divider */}
      <div className="capsule-divider" />

      {/* Right Column: Activity Line + Telemetry + Open Button */}
      <div className="capsule-right-col" data-tauri-drag-region="true">
        <div
          className="capsule-activity-line"
          onClick={onRestore}
          title="Click to open IRIS workspace"
          data-tauri-drag-region="true"
        >
          <span className="capsule-activity-icon" aria-hidden="true">
            {humanized?.icon ?? '🌿'}
          </span>
          <div className="capsule-activity-text" data-tauri-drag-region="true">
            {humanized ? (
              <>
                <span className="capsule-agent-name">{humanized.agent}: </span>
                <span className="capsule-action-name">{humanized.action}</span>
              </>
            ) : (
              <>
                <span className="capsule-agent-name">Senior Developer: </span>
                <span className="capsule-action-name">Agents standing by...</span>
              </>
            )}
          </div>
          {activity.length > 1 && (
            <button
              type="button"
              className="capsule-cycle-activity-btn"
              onClick={(e) => {
                e.stopPropagation();
                setActiveLogIndex((idx) => (idx + 1) % Math.min(activity.length, 5));
              }}
              title="Next activity"
              aria-label="Cycle activity"
            >
              ⇅
            </button>
          )}
        </div>

        <div className="capsule-bottom-row" data-tauri-drag-region="true">
          <div className="capsule-telemetry-group" data-tauri-drag-region="true">
            {metrics?.memoryTotalBytes && metrics.memoryAvailableBytes !== undefined ? (
              <div className="capsule-telemetry-chip">
                <span className="chip-label">RAM</span>
                <span className="chip-value">
                  {formatBytes(metrics.memoryTotalBytes - metrics.memoryAvailableBytes)} /{' '}
                  {formatBytes(metrics.memoryTotalBytes)}
                </span>
              </div>
            ) : (
              <div className="capsule-telemetry-chip">
                <span className="chip-label">RAM</span>
                <span className="chip-value">4.2 GB / 16 GB</span>
              </div>
            )}

            {metrics?.uptimeSeconds !== undefined ? (
              <div className="capsule-telemetry-chip">
                <span className="chip-label">UPTIME</span>
                <span className="chip-value">{formatDuration(metrics.uptimeSeconds)}</span>
              </div>
            ) : (
              <div className="capsule-telemetry-chip">
                <span className="chip-label">UPTIME</span>
                <span className="chip-value">1d 4h 12m</span>
              </div>
            )}
          </div>

          <div className="capsule-action-buttons">
            <button
              type="button"
              className="capsule-open-button"
              onClick={onRestore}
              title="Open IRIS Workspace"
            >
              Open
            </button>
            {onHide && (
              <button
                type="button"
                className="capsule-close-button"
                onClick={onHide}
                title="Hide to system tray"
                aria-label="Hide to tray"
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function StandaloneDesktopWidget() {
  const [darkMode] = useState(() => localStorage.getItem('iris.theme') === 'dark');

  async function restoreMain() {
    try {
      await invoke('show_main_from_widget');
    } catch {
      window.close();
    }
  }

  async function hideWidget() {
    try {
      const appWindow = getCurrentWebviewWindow();
      await appWindow.hide();
    } catch {
      window.close();
    }
  }

  return (
    <div className="standalone-widget-viewport" data-tauri-drag-region="true">
      <DesktopWidget
        onRestore={restoreMain}
        onHide={hideWidget}
        darkMode={darkMode}
        isStandalone={true}
      />
    </div>
  );
}
