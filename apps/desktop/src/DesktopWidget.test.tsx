// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopWidget } from './DesktopWidget';

const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock('./desktopActivity', () => ({ subscribeDesktopActivity: listen }));
vi.mock('./systemTelemetry', () => ({ readHostMetrics: async () => null, formatBytes: String, formatDuration: String }));

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

describe('DesktopWidget real state', () => {
  it('renders unavailable telemetry and returns to ready after historical tool work', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    listen.mockImplementation((callback) => {
      callback({ running: false, activity: [{ id: '1', agentId: 'a', agentName: 'Agent', kind: 'tool', summary: 'Agent is running Read File', at: '2026-09-05T00:00:00Z' }] });
      return () => undefined;
    });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<DesktopWidget onRestore={() => undefined} darkMode={false} />));
    expect(container.textContent).toContain('Ready');
    expect(container.textContent).not.toContain('Working…');
    expect(container.textContent).not.toContain('4.2 GB');
    expect(container.textContent).not.toContain('1d 4h 12m');
    expect(container.textContent?.match(/Unavailable/g)).toHaveLength(2);
    await act(async () => root.unmount());
  });
});
