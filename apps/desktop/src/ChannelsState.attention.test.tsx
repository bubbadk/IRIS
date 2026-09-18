// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelsWindow } from './ChannelsState';

/**
 * Regression for F2C — durable channel attention must be visible in the application.
 *
 * A channel update dropped on the restart-recovery path is classified once (`unknown` / `poison` /
 * `completed-with-warning`) and retained, but nothing read that record: `loadChannelAttention()` had
 * no production caller, the poll returns a bare `{ status: 'completed' }` for an update it did not
 * touch, and the status banner only ever rendered `result.error`. An update dropped before a restart
 * was therefore durable and invisible everywhere in the UI.
 */

const mocks = vi.hoisted(() => {
  const persisted = [
    {
      updateId: 4242,
      outcome: 'unknown' as const,
      attempts: 3,
      reason: 'The effect outcome could not be determined, so it was not replayed automatically.',
      at: 1_760_000_000_000,
    },
  ];
  return { persisted, loadChannelAttention: vi.fn(async () => persisted) };
});

vi.mock('./bridgeGateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridgeGateway')>();
  return {
    ...actual,
    loadChannelConnection: vi.fn(async () => structuredClone(actual.defaultChannelsConfig)),
    loadDurableChannelInbox: vi.fn(async () => []),
    loadChannelAttention: mocks.loadChannelAttention,
  };
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function render() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ChannelsWindow />));
  return container;
}

describe('channel attention surface', () => {
  it('shows attention retained from before this window opened, with no polling configured', async () => {
    const container = await render();
    const text = container.textContent ?? '';
    expect(mocks.loadChannelAttention).toHaveBeenCalled();
    expect(text).toContain('needs attention');
    expect(text).toContain('4242');
    expect(text).toContain('could not be determined');
  });

  it('does not offer to dismiss durable attention', async () => {
    const container = await render();
    const banner = [...container.querySelectorAll('[role="status"]')].find((node) =>
      node.textContent?.includes('needs attention'),
    );
    expect(banner).toBeDefined();
    // The poll banner is dismissible; durable truth is not, or the record would be invisible again.
    expect(banner?.querySelector('button')).toBeNull();
  });

  it('says nothing when no update needs attention', async () => {
    mocks.loadChannelAttention.mockResolvedValueOnce([]);
    const container = await render();
    expect(container.textContent ?? '').not.toContain('needs attention');
  });
});
