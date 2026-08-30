import { useEffect, useMemo, useState } from 'react';
import { subscribeAgentActivity, subscribeAgentRuntime, type AgentActivityLogEntry } from './agentRuntime';
import { cortexTurnRepository } from './persistence';
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatRelativeTime,
  readHostMetrics,
  summarizeUsage,
  type HostMetrics,
  type UsageSummary,
} from './systemTelemetry';

const HOST_POLL_MS = 4000;
const RELATIVE_TIME_TICK_MS = 3000;

const emptyUsage: UsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  turnsWithUsage: 0,
  recentTurnTokens: [],
};

function humanizeActivity(summary: string): { agent: string; action: string; icon: string } {
  // Format tool names
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

function Meter({
  label,
  detail,
  fraction,
  tone = 'accent',
}: {
  label: string;
  detail: string;
  fraction: number;
  tone?: 'accent' | 'warm';
}) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const percent = (clamped * 100).toFixed(0);
  return (
    <div className="panel-meter">
      <div className="panel-meter-top">
        <span className="panel-meter-label">{label}</span>
        <span className="panel-meter-detail">
          {detail} <span className="panel-meter-percent">({percent}%)</span>
        </span>
      </div>
      <div className="panel-meter-track">
        <span
          className={`panel-meter-fill panel-meter-${tone}`}
          style={{ width: `${(clamped * 100).toFixed(1)}%` }}
        />
      </div>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const width = 220;
  const height = 44;
  if (values.length < 2) {
    return <div className="panel-spark-empty">Awaiting additional turns…</div>;
  }
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const points = values
    .map((value, index) => {
      const x = index * step;
      const y = height - (value / max) * (height - 6) - 3;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const areaPoints = `0,${height} ${points} ${width},${height}`;
  return (
    <div className="panel-spark-container">
      <svg
        className="panel-spark"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Tokens per recent turn"
      >
        <defs>
          <linearGradient id="sparkGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--panel-accent)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--panel-accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <polygon points={areaPoints} fill="url(#sparkGradient)" />
        <polyline points={points} className="panel-spark-line" />
      </svg>
    </div>
  );
}

function ActivityConsole({ log }: { log: AgentActivityLogEntry[] }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className="panel-block panel-block-activity">
      <div className="panel-block-header">
        <p className="panel-eyebrow">Live Activity</p>
        {log.length > 0 && <span className="panel-live-badge">Live</span>}
      </div>
      {log.length === 0 ? (
        <p className="panel-subtle">
          Nothing happening right now. Tool calls, sub-agents and replies appear here in real-time.
        </p>
      ) : (
        <ul className="activity-console" aria-label="Live IRIS activity">
          {log.map((entry) => {
            const { agent, action, icon } = humanizeActivity(entry.summary);
            const isRunning = entry.kind === 'tool';
            return (
              <li key={entry.id} className={`activity-row activity-row-${entry.kind} ${isRunning ? 'is-active-task' : ''}`}>
                <span className={`activity-dot activity-dot-${entry.kind}`} aria-hidden="true" />
                <span className="activity-body">
                  <span className="activity-header-line">
                    <span className="activity-agent-tag">{agent}</span>
                    <span className="activity-time">{formatRelativeTime(entry.at, now)}</span>
                  </span>
                  <span className="activity-summary">
                    <span className="activity-icon" aria-hidden="true">{icon}</span>
                    <span className="activity-text">{action}</span>
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function SystemPanel() {
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [nativeAvailable, setNativeAvailable] = useState(true);
  const [usage, setUsage] = useState<UsageSummary>(emptyUsage);
  const [activity, setActivity] = useState<AgentActivityLogEntry[]>([]);

  useEffect(() => subscribeAgentActivity(setActivity), []);

  useEffect(() => {
    let cancelled = false;
    async function refreshHost() {
      try {
        const next = await readHostMetrics();
        if (cancelled) return;
        setMetrics(next);
        setNativeAvailable(next !== null);
      } catch {
        if (!cancelled) setNativeAvailable(false);
      }
    }
    void refreshHost();
    const timer = setInterval(refreshHost, HOST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refreshUsage() {
      try {
        const records = await cortexTurnRepository.listAll();
        if (!cancelled) setUsage(summarizeUsage(records));
      } catch {
        /* telemetry is best-effort; never block the shell */
      }
    }
    void refreshUsage();
    const unsubscribe = subscribeAgentRuntime(() => void refreshUsage());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const memory = useMemo(() => {
    if (!metrics?.memoryTotalBytes || metrics.memoryAvailableBytes === undefined) return null;
    const used = Math.max(0, metrics.memoryTotalBytes - metrics.memoryAvailableBytes);
    return {
      used,
      total: metrics.memoryTotalBytes,
      fraction: used / metrics.memoryTotalBytes,
    };
  }, [metrics]);

  const load = useMemo(() => {
    if (!metrics?.loadAverage) return null;
    const [one] = metrics.loadAverage;
    const cores = metrics.cpuCount ?? 1;
    return { one, cores, fraction: one / cores };
  }, [metrics]);

  const tokenSplit = usage.totalTokens > 0 ? usage.inputTokens / usage.totalTokens : 0;
  const isAgentActive = activity.some((entry) => entry.kind === 'tool');

  return (
    <aside className="system-panel" aria-label="System telemetry">
      <section className="panel-block">
        <div className="panel-block-header">
          <p className="panel-eyebrow">Machine</p>
          <span className={`panel-status-indicator ${isAgentActive ? 'active' : 'idle'}`}>
            <span className="pulse-dot" />
            {isAgentActive ? 'Agent Active' : 'System Ready'}
          </span>
        </div>
        {metrics ? (
          <>
            <p className="panel-title">{metrics.hostname ?? 'This machine'}</p>
            <p className="panel-subtle">
              {metrics.operatingSystem} · {metrics.architecture} · IRIS {metrics.appVersion}
            </p>
            <div className="panel-chips">
              {metrics.cpuCount !== undefined && (
                <span className="panel-chip">
                  <span className="panel-chip-value">{metrics.cpuCount}</span> cores
                </span>
              )}
              {metrics.uptimeSeconds !== undefined && (
                <span className="panel-chip">
                  <span className="panel-chip-value">{formatDuration(metrics.uptimeSeconds)}</span>{' '}
                  uptime
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="panel-subtle">
            {nativeAvailable
              ? 'Reading host telemetry…'
              : 'Live host metrics are available in the native desktop app.'}
          </p>
        )}
      </section>

      {(memory || load) && (
        <section className="panel-block">
          {memory && (
            <Meter
              label="Memory"
              detail={`${formatBytes(memory.used)} / ${formatBytes(memory.total)}`}
              fraction={memory.fraction}
            />
          )}
          {load && (
            <Meter
              label="CPU load"
              detail={`${load.one.toFixed(2)} on ${load.cores} cores`}
              fraction={load.fraction}
              tone="warm"
            />
          )}
        </section>
      )}

      <section className="panel-block">
        <p className="panel-eyebrow">Tokens</p>
        <p className="panel-metric">{formatCount(usage.totalTokens)}</p>
        <p className="panel-subtle">
          across {usage.turnsWithUsage} {usage.turnsWithUsage === 1 ? 'turn' : 'turns'}
        </p>
        {usage.totalTokens > 0 && (
          <>
            <Meter
              label="In / Out"
              detail={`${formatCount(usage.inputTokens)} in · ${formatCount(usage.outputTokens)} out`}
              fraction={tokenSplit}
            />
            <Sparkline values={usage.recentTurnTokens} />
          </>
        )}
        {usage.totalTokens === 0 && (
          <p className="panel-subtle">Token usage appears here after the first agent reply.</p>
        )}
      </section>

      <ActivityConsole log={activity} />
    </aside>
  );
}
