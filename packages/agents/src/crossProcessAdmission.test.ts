import { describe, expect, it } from 'vitest';
import type { ModelProvider } from '@iris/providers';
import type { AgentDefinition } from '@iris/core';
import {
  AgentExecutionLeaseRegistry,
  AgentRuntimeCoordinator,
  type AgentEvent,
  type AgentRepository,
  type AgentToolRuntime,
  type ConversationMessage,
  type ConversationRepository,
  type SuspendedAgentTurn,
  type SuspendedAgentTurnRepository,
} from './index';
import type { RepositoryBackend, StorageSnapshot } from '../../../apps/desktop/src/repositoryStorage';
import { createLeaseAuthority } from './leaseAuthority';
import { RepositoryTransactions } from '../../../apps/desktop/src/repositoryStorage';

/**
 * IRIS Phase 2H.1 — the coordinator's cross-process admission port under the exact
 * repository-CAS authority semantics. The provider is scripted; admission, release,
 * suspension retention and resume are the real production orchestration.
 */

const at = '2026-09-17T12:00:00.000Z';
const agent: AgentDefinition = {
  id: 'agent',
  name: 'Shared agent',
  autonomy: 'assist',
  approvalMode: 'ask',
  skillIds: [],
  toolIds: [],
};

class CasBackend implements RepositoryBackend {
  data: StorageSnapshot = { values: {}, revisions: {} };
  async snapshot(): Promise<StorageSnapshot> {
    return structuredClone(this.data);
  }
  async commit(expected: Record<string, number>, changes: Record<string, string | null>) {
    if (
      Object.entries(expected).some(([key, revision]) => (this.data.revisions[key] ?? 0) !== revision)
    )
      return false;
    for (const [key, value] of Object.entries(changes)) {
      this.data.revisions[key] = (this.data.revisions[key] ?? 0) + 1;
      if (value === null) delete this.data.values[key];
      else this.data.values[key] = value;
    }
    return true;
  }
}

/** A lease authority for one simulated process identity over the shared CAS backend. */
function authorityFor(backend: CasBackend, instance: string, alivePids: number[]) {
  return createLeaseAuthority(new RepositoryTransactions(backend), {
    pid: async () => (instance === 'a' ? 100 : 200),
    instance: () => instance,
    liveness: async (pid) => ({ status: alivePids.includes(pid) ? 'alive' : 'dead' }),
  });
}

function gatedProvider() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const provider: ModelProvider = {
    definition: {
      id: 'provider',
      name: 'Test',
      kind: 'test',
      capabilities: ['chat'],
      local: true,
    },
    capabilities: () => ['chat'],
    testConnection: async () => undefined,
    stream: async function* () {
      entered += 1;
      await gate;
      yield { text: 'Done.', done: true };
    },
  };
  return { provider, release, entered: () => entered };
}

function repositories() {
  const conversations = new Map<string, ConversationMessage[]>();
  const suspended = new Map<string, SuspendedAgentTurn>();
  const agents: AgentRepository = {
    list: async () => [agent],
    get: async (id) => (id === agent.id ? agent : null),
    save: async () => undefined,
    remove: async () => undefined,
  };
  const conversationRepository: ConversationRepository = {
    list: async (agentId) => [...(conversations.get(agentId) ?? [])],
    save: async (agentId, messages) => {
      conversations.set(agentId, [...messages]);
    },
    clear: async (agentId) => {
      conversations.delete(agentId);
    },
  };
  const suspendedTurns: SuspendedAgentTurnRepository = {
    getByAgentId: async (agentId) => [...suspended.values()].find((turn) => turn.agentId === agentId) ?? null,
    getByApprovalId: async (approvalId) =>
      [...suspended.values()].find((turn) =>
        turn.pending.kind === 'tool-approval' ? turn.pending.approval.id === approvalId : false,
      ) ?? null,
    list: async () => [...suspended.values()],
    save: async (turn) => {
      suspended.set(turn.pending.turnId, turn);
    },
    removeByTurnId: async (turnId) => {
      suspended.delete(turnId);
    },
  };
  const tools: AgentToolRuntime = {
    definitions: () => [],
    execute: async () => ({ status: 'completed', output: null }),
    resolve: async () => ({ status: 'completed', output: null }),
  };
  return { agents, conversationRepository, suspendedTurns, tools, suspended };
}

function coordinator(
  leases: AgentExecutionLeaseRegistry,
  kind: 'interactive' | 'scheduled' | 'project',
  crossProcess?: Parameters<typeof Object.assign>[0] extends never ? never : import('./index').AgentExecutionCoordination['crossProcess'],
  options: { reserveTurns?: boolean } = {},
) {
  const repos = repositories();
  const script = gatedProvider();
  const instance = new AgentRuntimeCoordinator(
    repos.agents,
    repos.conversationRepository,
    repos.suspendedTurns,
    { resolve: async () => ({ provider: script.provider, model: 'test-model' }) },
    repos.tools,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      leases,
      ownerKind: kind,
      ownerId: (agentId) => `${kind}:${agentId}`,
      ...(crossProcess ? { crossProcess } : {}),
      ...(options.reserveTurns === undefined ? {} : { reserveTurns: options.reserveTurns }),
    },
  );
  return { instance, ...repos, ...script };
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function suspendedTurn(id: string): SuspendedAgentTurn {
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
      approval: { id: `approval-${id}`, toolId: 't', toolName: 'T', reason: 'Ask.' },
      call: { id: `call-${id}`, name: 't', input: {} },
      remainingCalls: [],
      assistantText: '',
    },
    createdAt: at,
  } as unknown as SuspendedAgentTurn;
}

describe('coordinator cross-process admission (Phase 2H.1)', () => {
  it.each(['interactive', 'scheduled', 'project'] as const)('denies %s admission on unknown owner liveness without provider entry', async (kind) => {
    const backend = new CasBackend();
    await authorityFor(backend, 'a', [100]).acquire(agent.id, 'owner-a', 'interactive', at);
    const before = structuredClone(backend.data);
    const port = createLeaseAuthority(new RepositoryTransactions(backend), {
      pid: async () => 200, instance: () => 'b',
      liveness: async () => ({ status: 'unknown', reason: 'Injected unavailable' }),
    });
    const second = coordinator(new AgentExecutionLeaseRegistry(), kind, port);
    await expect(drain(second.instance.send(agent.id, 'Must not execute'))).rejects.toThrow('another IRIS process');
    expect(second.entered()).toBe(0);
    expect(backend.data).toEqual(before);
  });

  it('refuses approval resume while suspended foreign owner liveness is unknown', async () => {
    const backend = new CasBackend();
    await authorityFor(backend, 'a', [100]).acquire(agent.id, 'owner-a', 'scheduled', at);
    const before = structuredClone(backend.data);
    const port = createLeaseAuthority(new RepositoryTransactions(backend), {
      pid: async () => 200, instance: () => 'b',
      liveness: async () => ({ status: 'unknown', reason: 'Unavailable' }),
    });
    const second = coordinator(new AgentExecutionLeaseRegistry(), 'interactive', port);
    const turn = suspendedTurn('blocked');
    await second.suspendedTurns.save(turn);
    await expect(drain(second.instance.resolveApproval('approval-blocked', 'approve'))).rejects.toThrow('another IRIS process');
    expect(second.entered()).toBe(0);
    expect(await second.suspendedTurns.getByApprovalId('approval-blocked')).toEqual(turn);
    expect(backend.data).toEqual(before);
  });

  it('refuses resume under the production reserveTurns:false config while a live foreign owner holds the lease', async () => {
    const backend = new CasBackend();
    await authorityFor(backend, 'a', [100]).acquire(agent.id, 'owner-a', 'project', at);
    const port = createLeaseAuthority(new RepositoryTransactions(backend), {
      pid: async () => 200, instance: () => 'b',
      liveness: async () => ({ status: 'alive' }),
    });
    const second = coordinator(new AgentExecutionLeaseRegistry(), 'project', port, {
      reserveTurns: false,
    });
    const turn = suspendedTurn('production-config');
    await second.suspendedTurns.save(turn);
    await expect(
      drain(second.instance.resolveApproval('approval-production-config', 'approve')),
    ).rejects.toThrow(/another IRIS process/);
    expect(second.entered()).toBe(0);
    expect(await second.suspendedTurns.getByApprovalId('approval-production-config')).toEqual(turn);
  });

  it('still resumes under reserveTurns:false when no foreign owner holds the lease', async () => {
    const backend = new CasBackend();
    const port = createLeaseAuthority(new RepositoryTransactions(backend), {
      pid: async () => 200, instance: () => 'b',
      liveness: async () => ({ status: 'alive' }),
    });
    const second = coordinator(new AgentExecutionLeaseRegistry(), 'project', port, {
      reserveTurns: false,
    });
    const turn = suspendedTurn('free');
    await second.suspendedTurns.save(turn);
    const resuming = drain(second.instance.resolveApproval('approval-free', 'approve'));
    await Promise.resolve();
    await Promise.resolve();
    second.release();
    const events = await resuming;
    expect(events.some((event) => event.type === 'assistant-complete')).toBe(true);
    expect(second.entered()).toBe(1);
    expect(await second.suspendedTurns.getByApprovalId('approval-free')).toBeNull();
  });

  it('refuses a same-agent turn from a simulated second process and never streams', async () => {
    const backend = new CasBackend();
    // Production topology: each process owns its local registry; only the lease document is
    // shared. The second process's local Map is free, so the refusal must come from the
    // cross-process authority with its truthful message.
    const first = coordinator(new AgentExecutionLeaseRegistry(), 'scheduled', authorityFor(backend, 'a', [100, 200]));
    const second = coordinator(new AgentExecutionLeaseRegistry(), 'interactive', authorityFor(backend, 'b', [100, 200]));
    const running = drain(first.instance.send(agent.id, 'Run now'));
    await Promise.resolve();
    await Promise.resolve();
    await expect(drain(second.instance.send(agent.id, 'Me too'))).rejects.toThrow(
      /another IRIS process/,
    );
    expect(second.entered()).toBe(0);
    first.release();
    await running;
  });

  it('lets the second process in only after the first releases its lease', async () => {
    const backend = new CasBackend();
    const leases = new AgentExecutionLeaseRegistry();
    const first = coordinator(leases, 'scheduled', authorityFor(backend, 'a', [100, 200]));
    const running = drain(first.instance.send(agent.id, 'Run now'));
    await Promise.resolve();
    await Promise.resolve();
    first.release();
    await running;
    // The cross-process lease is gone with the local one, so the other process may execute.
    const second = coordinator(leases, 'interactive', authorityFor(backend, 'b', [100, 200]));
    const secondRun = drain(second.instance.send(agent.id, 'Now me'));
    await Promise.resolve();
    await Promise.resolve();
    second.release();
    await secondRun;
    expect(second.entered()).toBe(1);
  });

  it('fails closed when the cross-process authority cannot be evaluated', async () => {
    const leases = new AgentExecutionLeaseRegistry();
    const failing = coordinator(leases, 'scheduled', {
      acquire: async () => {
        throw new Error('Lease storage unavailable.');
      },
      release: async () => undefined,
    });
    await expect(drain(failing.instance.send(agent.id, 'Run now'))).rejects.toThrow(
      'Lease storage unavailable.',
    );
    expect(failing.entered()).toBe(0);
    // The local reservation was rolled back, so the agent is not phantom-busy locally.
    expect(leases.holder(agent.id)).toBeUndefined();
  });

  it('retains cross-process ownership across a restart while an approval is pending', async () => {
    const backend = new CasBackend();
    const leases = new AgentExecutionLeaseRegistry();
    const scheduled = coordinator(leases, 'scheduled', authorityFor(backend, 'a', [100, 200]));
    await scheduled.suspendedTurns.save(suspendedTurn('turn-1'));
    // Restart reconciliation re-acquires the cross-process lease for the suspended turn.
    expect(await scheduled.instance.reconcileExecutionReservations()).toBe(1);
    const other = authorityFor(backend, 'b', [100, 200]);
    await expect(other.acquire(agent.id, 'owner-b', 'interactive', at)).resolves.toBe(false);
  });

  it('frees the cross-process lease when the suspended turn is cancelled', async () => {
    const backend = new CasBackend();
    const leases = new AgentExecutionLeaseRegistry();
    const runs = coordinator(leases, 'interactive', authorityFor(backend, 'a', [100, 200]));
    await runs.suspendedTurns.save(suspendedTurn('turn-2'));
    expect(await runs.instance.reconcileExecutionReservations()).toBe(1);
    await runs.instance.cancelSuspended(agent.id);
    const other = authorityFor(backend, 'b', [100, 200]);
    await expect(other.acquire(agent.id, 'owner-b', 'interactive', at)).resolves.toBe(true);
  });
});
