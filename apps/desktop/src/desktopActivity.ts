import {
  agentRuntime,
  subscribeAgentActivity,
  subscribeAgentRuntime,
  type AgentActivityLogEntry,
} from './agentRuntime';
import { projectAgentRuntime, subscribeProjectAgentRuntime } from './projectRuntime';

export interface DesktopActivitySnapshot {
  activity: AgentActivityLogEntry[];
  running: boolean;
}

function isSnapshot(value: unknown): value is DesktopActivitySnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<DesktopActivitySnapshot>;
  return (
    typeof snapshot.running === 'boolean' &&
    Array.isArray(snapshot.activity) &&
    snapshot.activity.every(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.id === 'string' &&
        typeof entry.agentId === 'string' &&
        typeof entry.agentName === 'string' &&
        typeof entry.at === 'string' &&
        typeof entry.summary === 'string' &&
        ['info', 'tool', 'success', 'warn', 'error'].includes(entry.kind),
    )
  );
}

// The native Desklet runs in its own webview. In-memory subscriptions alone
// cannot observe work in the main window, so request and broadcast snapshots.
export function subscribeDesktopActivity(
  listener: (snapshot: DesktopActivitySnapshot) => void,
): () => void {
  const standalone =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('window') === 'widget';
  const channel =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('iris:desktop-activity') : null;
  let activity: AgentActivityLogEntry[] = [];
  const publish = () => {
    const snapshot = {
      activity,
      running:
        agentRuntime.runningAgentIds.length > 0 || projectAgentRuntime.runningAgentIds.length > 0,
    };
    if (!standalone) {
      listener(snapshot);
      channel?.postMessage({ type: 'snapshot', snapshot });
    }
  };
  if (channel)
    channel.onmessage = ({
      data,
    }: MessageEvent<{ type: string; snapshot?: DesktopActivitySnapshot }>) => {
      if (!data || typeof data !== 'object') return;
      if (standalone && data.type === 'snapshot' && isSnapshot(data.snapshot))
        listener(data.snapshot);
      if (!standalone && data.type === 'request') publish();
    };
  const unsubscribeActivity = subscribeAgentActivity((next) => {
    activity = next;
    publish();
  });
  const unsubscribeRuntime = subscribeAgentRuntime(publish);
  const unsubscribeProject = subscribeProjectAgentRuntime(publish);
  channel?.postMessage({ type: 'request' });
  return () => {
    unsubscribeActivity();
    unsubscribeRuntime();
    unsubscribeProject();
    channel?.close();
  };
}
