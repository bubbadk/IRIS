import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '@iris/core';
import {
  AgentExecutionLeaseRegistry,
  AgentRuntimeCoordinator,
  type ConversationMessage,
  type ConversationRepository,
  type SuspendedAgentTurn,
  type SuspendedAgentTurnRepository,
} from './index';
import { RepositoryTransactions } from '../../../apps/desktop/src/repositoryStorage';
import { createLeaseAuthority, type ProcessLiveness } from './leaseAuthority';

/**
 * Phase 2H.2 §14–§17 — conservative reconciliation of persisted suspended state against the
 * durable approval lifecycle and the Phase 2H.1/2H.3 cross-process authority. Every branch
 * must classify truthfully and never fabricate success; unknown liveness fails closed.
 */

const at = '2026-09-17T12:00:00.000Z';
const agent: AgentDefinition = {
  id: 'agent',
  name: 'Orphan agent',
  autonomy: 'assist',
  approvalMode: 'ask',
  skillIds: [],
  toolIds: [],
};

/** Minimal durable approval reader the reconciliation consults (structural, like production). */
type ApprovalReader = { get(approvalId: string): Promise<{ status: string } | null> };

class CasBackend {
  data = { values: {} as Record<string, string>, revisions: {} as Record<string, number> };
  async snapshot() {
    return structuredClone(this.data);
  }
  async commit(expected: Record<string, number>, changes: Record<string, string | null>) {
    if (Object.entries(expected).some(([key, rev]) => (this.data.revisions[key] ?? 0) !== rev)) return false;
    for (const [key, value] of Object.entries(changes)) {
      this.data.revisions[key] = (this.data.revisions[key] ?? 0) + 1;
      if (value === null) delete this.data.values[key];
      else this.data.values[key] = value;
    }
    return true;
  }
}

function authorityFor(
  backend: CasBackend,
  instance: string,
  alivePids: number[],
  liveness?: (pid: number) => Promise<ProcessLiveness>,
) {
  return createLeaseAuthority(new RepositoryTransactions(backend as never), {
    pid: async () => (instance === 'a' ? 100 : 200),
    instance: () => instance,
    liveness: liveness ?? (async (pid) => ({ status: alivePids.includes(pid) ? 'alive' : 'dead' }) as ProcessLiveness),
  });
}

function suspendedTurn(id: string, approvalId = `approval-${id}`): SuspendedAgentTurn {
  return {
    version: 4,
    agentId: agent.id,
    providerId: 'provider',
    model: 'test-model',
    conversation: [],
    modelHistory: [],
    pending: {
      kind: 'tool-approval',
      turnId: id,
      approval: { id: approvalId, toolId: 't', toolName: 'T', reason: 'Ask.' },
      call: { id: `call-${id}`, name: 't', input: {} },
      assistantText: '',
    },
    createdAt: at,
  } as unknown as SuspendedAgentTurn;
}

function repos() {
  const suspended = new Map<string, SuspendedAgentTurn>();
  return {
    suspended,
    suspendedTurns: {
      getByAgentId: async (agentId: string) => [...suspended.values()].find((t) => t.agentId === agentId) ?? null,
      getByApprovalId: async (approvalId: string) =>
        [...suspended.values()].find((t) => t.pending.kind === 'tool-approval' && t.pending.approval.id === approvalId) ?? null,
      list: async () => [...suspended.values()],
      save: async (turn: SuspendedAgentTurn) => {
        suspended.set((turn.pending as { turnId: string }).turnId, turn);
      },
      removeByTurnId: async (turnId: string) => {
        suspended.delete(turnId);
      },
    } satisfies SuspendedAgentTurnRepository,
    conversations: {
      list: async () => [] as ConversationMessage[],
      save: async () => undefined,
      clear: async () => undefined,
    } satisfies ConversationRepository,
    agents: {
      list: async () => [agent],
      get: async (id: string) => (id === agent.id ? agent : null),
      save: async () => undefined,
      remove: async () => undefined,
    },
  };
}

function harness(
  backend: CasBackend,
  instance: 'a' | 'b',
  alivePids: number[],
  approvals?: ApprovalReader,
  liveness?: (pid: number) => Promise<ProcessLiveness>,
) {
  const store = repos();
  const coordinator = new AgentRuntimeCoordinator(
    store.agents,
    store.conversations,
    store.suspendedTurns,
    { resolve: async (): Promise<never> => { throw new Error('Provider must never run during reconciliation'); } },
    {
      definitions: () => [],
      execute: async () => ({ status: 'completed', output: null }),
      resolve: async () => ({ status: 'completed', output: null }),
    },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    {
      leases: new AgentExecutionLeaseRegistry(),
      ownerKind: 'interactive',
      ownerId: (id) => `interactive:${id}`,
      crossProcess: authorityFor(backend, instance, alivePids, liveness),
    },
  );
  return { ...store, coordinator, approvals };
}

const pendingApprovals = (status: string): ApprovalReader => ({ get: async () => ({ status }) });
const missingApprovals: ApprovalReader = { get: async () => null };

describe('orphan suspended turn reconciliation (Phase 2H.2)', () => {
  it('keeps local ownership for a suspended turn whose approval is still pending', async () => {
    const h = harness(new CasBackend(), 'a', [100]);
    await h.suspendedTurns.save(suspendedTurn('orphan-1'));
    expect(await h.coordinator.reconcileExecutionReservations()).toBe(1);
    expect([...h.suspended.values()]).toHaveLength(1);
  });

  it('classifies a missing approval record as unknown, keeps the turn, and never deletes it', async () => {
    const backend = new CasBackend();
    const h = harness(backend, 'a', [100], missingApprovals);
    await h.suspendedTurns.save(suspendedTurn('orphan-missing'));
    await h.coordinator.reconcileExecutionReservations();
    const [result] = await h.coordinator.reconcileOrphanSuspensions(missingApprovals);
    expect(result.outcome).toBe('unknown');
    expect(result.outcomeDetail).toContain('needs attention');
    expect([...h.suspended.values()]).toHaveLength(1);
    // The lease was not released by an unknown-outcome classification.
    expect(backend.data.values['iris.agents.execution-leases.v1']).toContain('orphan-missing'.length ? 'agent' : '');
  });

  it('completes the lifecycle when the approval is durably terminal and the lease is ours', async () => {
    const h = harness(new CasBackend(), 'a', [100], pendingApprovals('denied'));
    await h.suspendedTurns.save(suspendedTurn('orphan-terminal'));
    await h.coordinator.reconcileExecutionReservations();
    const [result] = await h.coordinator.reconcileOrphanSuspensions(pendingApprovals('denied'));
    expect(result.outcome).toBe('terminal-known');
    // The stranded suspension is removed; no phantom busy remains.
    expect([...h.suspended.values()]).toHaveLength(0);
    // Duplicate reconciliation is a no-op.
    expect(await h.coordinator.reconcileOrphanSuspensions(pendingApprovals('denied'))).toHaveLength(0);
  });

  it('defers reconciliation while a live foreign process holds the lease', async () => {
    const backend = new CasBackend();
    const owner = createLeaseAuthority(new RepositoryTransactions(backend as never), {
      pid: async () => 100,
      instance: () => 'foreign',
      liveness: async () => ({ status: 'alive' }),
    });
    await owner.acquire('agent', 'foreign-owner', 'scheduled', at);
    const h = harness(backend, 'b', [100], pendingApprovals('denied'));
    await h.suspendedTurns.save(suspendedTurn('orphan-foreign'));
    const [result] = await h.coordinator.reconcileOrphanSuspensions(pendingApprovals('denied'));
    expect(result.outcome).toBe('unknown');
    expect(result.outcomeDetail).toContain('foreign');
    expect([...h.suspended.values()]).toHaveLength(1);
  });

  it('fails closed on unknown foreign liveness instead of taking over', async () => {
    const backend = new CasBackend();
    const owner = createLeaseAuthority(new RepositoryTransactions(backend as never), {
      pid: async () => 100,
      instance: () => 'foreign-unknown',
      liveness: async () => ({ status: 'unknown', reason: 'Probe unavailable' }),
    });
    await owner.acquire('agent', 'foreign-owner', 'scheduled', at);
    const h = harness(backend, 'b', [], pendingApprovals('denied'), async () => ({ status: 'unknown', reason: 'Probe unavailable' }));
    await h.suspendedTurns.save(suspendedTurn('orphan-unknown'));
    const [result] = await h.coordinator.reconcileOrphanSuspensions(pendingApprovals('denied'));
    expect(result.outcome).toBe('unknown');
    expect([...h.suspended.values()]).toHaveLength(1);
    // The foreign lease record is untouched.
    expect(backend.data.values['iris.agents.execution-leases.v1']).toContain('foreign-owner');
  });

  it('reconciles a dead foreign lease and completes the lifecycle', async () => {
    const backend = new CasBackend();
    const deadOwner = createLeaseAuthority(new RepositoryTransactions(backend as never), {
      pid: async () => 100,
      instance: () => 'dead-foreign',
      liveness: async () => ({ status: 'dead' }),
    });
    await deadOwner.acquire('agent', 'dead-owner', 'scheduled', at);
    const h = harness(backend, 'b', [100], pendingApprovals('approved'), async () => ({ status: 'dead' }));
    await h.suspendedTurns.save(suspendedTurn('orphan-dead'));
    const [result] = await h.coordinator.reconcileOrphanSuspensions(pendingApprovals('approved'));
    expect(result.outcome).toBe('terminal-known');
    expect([...h.suspended.values()]).toHaveLength(0);
  });
});
