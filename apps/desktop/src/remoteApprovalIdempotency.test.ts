// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolApprovalStateError, type ToolApprovalRequest } from '@iris/tools';

const counters = vi.hoisted(() => ({ settlements: 0 }));

vi.mock('./agentRuntime', () => ({
  agentRuntime: { suspendedForApproval: vi.fn(async () => null) },
  providerResolver: { resolve: vi.fn() },
}));
vi.mock('./projectRuntime', () => ({
  projectWorkflowRuntime: { suspendedForApproval: vi.fn(async () => null) },
}));
vi.mock('./tooling', () => ({
  createToolExecutor: () => ({
    resolve: async (approvalId: string, decision: 'approve' | 'deny') => {
      // Mirrors the production GatedToolExecutor settlement boundary: one durable
      // compareAndSet from pending to terminal decides who owns the semantic effect, and the
      // loser receives the same controlled ToolApprovalStateError production throws.
      const settled = await toolApprovalRepository.compareAndSet(approvalId, 'pending', {
        ...approval(approvalId),
        status: decision === 'approve' ? 'approved' : 'denied',
      } as ToolApprovalRequest);
      if (!settled) throw new ToolApprovalStateError('Approval was already resolved.');
      counters.settlements += 1;
      return { status: 'completed', output: null };
    },
  }),
}));

import { resolveRemoteApproval } from './channelApprovals';
import { toolApprovalRepository } from './persistence';

function approval(id: string): ToolApprovalRequest {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    agentId: 'agent-1',
    agentName: 'IRIS',
    toolId: 'web.search',
    toolName: 'Web search',
    input: { query: 'fixture' },
    evaluation: { decision: 'ask', reason: 'Ask.' },
  };
}

beforeEach(() => {
  counters.settlements = 0;
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } satisfies Storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('duplicate remote approval delivery (Phase 2H.2 §12)', () => {
  it('settles the same Telegram approval command exactly once under concurrent duplicates', async () => {
    await toolApprovalRepository.save(approval('approval-7'));
    // The same Telegram update delivered twice at the same time: two identical commands race.
    const [first, second] = await Promise.all([
      resolveRemoteApproval('approve approval-7'),
      resolveRemoteApproval('approve approval-7'),
    ]);
    expect(first).toMatch('Approval approved');
    expect(second).toMatch('already resolved');
    // Exactly one durable settlement decided the semantic effect.
    expect(counters.settlements).toBe(1);
  });

  it('rejects a replay after the approval is durably terminal', async () => {
    await toolApprovalRepository.save(approval('approval-8'));
    await expect(resolveRemoteApproval('approve approval-8')).resolves.toMatch('Approval approved');
    await expect(resolveRemoteApproval('approve approval-8')).resolves.toMatch('already resolved.');
    expect(counters.settlements).toBe(1);
  });
});
