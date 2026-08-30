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
  if (cleaned.includes('Specialist Sub-Agent')) icon = '🤖';
  else if (cleaned.includes('Workspace') || cleaned.includes('File') || cleaned.includes('Directory')) icon = '📁';
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
  const [isExpanded, setIsExpanded] = useState(false);

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
      event.button === 0 &&
      !(event.target as HTMLElement).closest('button, input, textarea, a, select')
    ) {
      try {
        const appWindow = getCurrentWebviewWindow();
        void appWindow.startDragging();
        void invoke('start_drag');
      } catch {
        /* fallback */
      }
    }
  };

  const latest = activity[0] ?? null;
  const isWorking = activity.some((entry) => entry.kind === 'tool');
  const humanized = latest ? humanizeActivity(latest.summary) : null;

  return (
    <div
      className={`desktop-live-widget ${isStandalone ? 'is-standalone-window' : ''} ${darkMode ? 'dark-mode' : ''} ${isWorking ? 'is-working' : ''}`}
      role="region"
      aria-label="IRIS Live Desktop Desklet"
      onPointerDown={handlePointerDown}
      data-tauri-drag-region="true"
    >
      <div className="widget-header" data-tauri-drag-region="true">
        <div className="widget-brand" data-tauri-drag-region="true">
          <span className="widget-drag-grip" title="Drag to move" data-tauri-drag-region="true">
            ⠿
          </span>
          <span className="widget-status-dot">
            <span className="widget-pulse" />
          </span>
          <span className="widget-title" data-tauri-drag-region="true">
            IRIS
          </span>
          <span className={`widget-pill ${isWorking ? 'pill-active' : 'pill-idle'}`}>
            {isWorking ? 'Working…' : 'Ready'}
          </span>
        </div>
        <div className="widget-actions">
          <button
            type="button"
            className="widget-restore-btn"
            onClick={onRestore}
            title="Open full IRIS workspace"
            aria-label="Restore IRIS"
          >
            ⤢ Open
          </button>
          {onHide && (
            <button
              type="button"
              className="widget-close-btn"
              onClick={onHide}
              title="Hide to system tray"
              aria-label="Hide to tray"
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="widget-body" onClick={onRestore} data-tauri-drag-region="true">
        {humanized ? (
          <div className="widget-activity-line" data-tauri-drag-region="true">
            <span className="widget-activity-icon" aria-hidden="true">
              {humanized.icon}
            </span>
            <div className="widget-activity-text" data-tauri-drag-region="true">
              <span className="widget-agent-name">{humanized.agent}: </span>
              <span className="widget-action-name">{humanized.action}</span>
            </div>
          </div>
        ) : (
          <div className="widget-activity-line idle" data-tauri-drag-region="true">
            <span className="widget-activity-icon" aria-hidden="true">
              🌿
            </span>
            <div className="widget-activity-text" data-tauri-drag-region="true">
              <span className="widget-agent-name">System ready: </span>
              <span className="widget-action-name">Agents standing by</span>
            </div>
          </div>
        )}
      </div>

      {metrics && (
        <div className="widget-footer" data-tauri-drag-region="true">
          {metrics.memoryTotalBytes && metrics.memoryAvailableBytes !== undefined && (
            <span className="widget-metric" data-tauri-drag-region="true">
              💾 {formatBytes(metrics.memoryTotalBytes - metrics.memoryAvailableBytes)}
            </span>
          )}
          {metrics.uptimeSeconds !== undefined && (
            <span className="widget-metric" data-tauri-drag-region="true">
              ⏱ {formatDuration(metrics.uptimeSeconds)}
            </span>
          )}
          <button
            type="button"
            className="widget-details-toggle"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? '▴ Hide' : '▾ More'}
          </button>
        </div>
      )}

      {isExpanded && activity.length > 1 && (
        <div className="widget-expanded-log">
          <p className="widget-log-title">Recent Activity:</p>
          {activity.slice(1, 4).map((entry) => {
            const h = humanizeActivity(entry.summary);
            return (
              <div key={entry.id} className="widget-log-row">
                <span className={`log-dot log-dot-${entry.kind}`} />
                <span className="log-text">
                  <strong>{h.agent}:</strong> {h.action}
                </span>
              </div>
            );
          })}
        </div>
      )}
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
