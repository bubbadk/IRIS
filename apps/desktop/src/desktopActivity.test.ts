import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentActivityLogEntry } from './agentRuntime';
import { subscribeDesktopActivity } from './desktopActivity';
const state = vi.hoisted(() => ({
  running: [] as string[],
  projectRunning: [] as string[],
  runtimeListeners: new Set<() => void>(),
  projectListeners: new Set<() => void>(),
  activityListeners: new Set<(entries: AgentActivityLogEntry[]) => void>(),
}));
vi.mock('./agentRuntime', () => ({
  agentRuntime: {
    get runningAgentIds() {
      return state.running;
    },
  },
  subscribeAgentRuntime: (listener: () => void) => {
    state.runtimeListeners.add(listener);
    return () => state.runtimeListeners.delete(listener);
  },
  subscribeAgentActivity: (listener: (entries: AgentActivityLogEntry[]) => void) => {
    state.activityListeners.add(listener);
    listener([]);
    return () => state.activityListeners.delete(listener);
  },
}));
vi.mock('./projectRuntime', () => ({
  projectAgentRuntime: {
    get runningAgentIds() {
      return state.projectRunning;
    },
  },
  subscribeProjectAgentRuntime: (listener: () => void) => {
    state.projectListeners.add(listener);
    return () => state.projectListeners.delete(listener);
  },
}));
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((stop) => stop());
  vi.unstubAllGlobals();
  state.running = [];
  state.projectRunning = [];
});

describe('desktop activity between separate windows', () => {
  it('uses real BroadcastChannels to deliver initial state, project starts and completion', async () => {
    vi.stubGlobal('window', { location: { search: '' } });
    cleanup.push(subscribeDesktopActivity(() => {}));
    vi.stubGlobal('window', { location: { search: '?window=widget' } });
    const widget = vi.fn();
    cleanup.push(subscribeDesktopActivity(widget));
    await vi.waitFor(() =>
      expect(widget).toHaveBeenLastCalledWith({ activity: [], running: false }),
    );
    state.projectRunning = ['worker'];
    state.projectListeners.forEach((listener) => listener());
    await vi.waitFor(() =>
      expect(widget).toHaveBeenLastCalledWith({ activity: [], running: true }),
    );
    state.projectRunning = [];
    state.projectListeners.forEach((listener) => listener());
    await vi.waitFor(() =>
      expect(widget).toHaveBeenLastCalledWith({ activity: [], running: false }),
    );
    cleanup.splice(0).forEach((stop) => stop());
    expect(
      state.runtimeListeners.size + state.projectListeners.size + state.activityListeners.size,
    ).toBe(0);
  });
  it('ignores malformed messages rather than turning them into runtime state', async () => {
    vi.stubGlobal('window', { location: { search: '?window=widget' } });
    const widget = vi.fn();
    cleanup.push(subscribeDesktopActivity(widget));
    const sender = new BroadcastChannel('iris:desktop-activity');
    cleanup.push(() => sender.close());
    sender.postMessage(null);
    sender.postMessage({ type: 'snapshot', snapshot: { running: 'yes', activity: [] } });
    sender.postMessage({ type: 'snapshot', snapshot: { running: false, activity: [] } });
    await vi.waitFor(() => expect(widget).toHaveBeenCalledTimes(1));
    expect(widget).toHaveBeenCalledWith({ running: false, activity: [] });
  });
});
