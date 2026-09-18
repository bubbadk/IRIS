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

/**
 * IRIS Phase 2G §6–§8, §10 — one authoritative exclusive-execution reservation across runtimes.
 *
 * The orchestration under test is production code: the real registry and the real coordinator. Only
 * the model provider is scripted.
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
    getByAgentId: async (agentId) =>
      [...suspended.values()].find((turn) => turn.agentId === agentId) ?? null,
    getByApprovalId: async (approvalId) =>
      [...suspended.values()].find((turn) =>
        turn.pending.kind === 'tool-approval'
          ? turn.pending.approval.id === approvalId
          : false,
      ) ?? null,
    list: async () => [...suspended.values()],
    save: async (turn) => {
      suspended.set(turn.pending.turnId, turn);
    },
    removeByTurnId: async (turnId) => {
      suspended.delete(turnId);
    },
  };
  // A real provider resolution is what the coordinator awaits after `begin`; every await after the
  // reservation is exactly the window this phase closes.
  const tools: AgentToolRuntime = {
    definitions: () => [],
    execute: async () => ({ status: 'completed', output: null }),
    resolve: async () => ({ status: 'completed', output: null }),
  };
  return { agents, conversationRepository, suspendedTurns, tools, suspended };
}

interface CoordinatorOptions {
  ownerKind: 'interactive' | 'scheduled' | 'project';
  reserveTurns?: boolean;
}

function coordinator(
  leases: AgentExecutionLeaseRegistry,
  kind: CoordinatorOptions['ownerKind'],
  reserveTurns?: boolean,
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
      ...(reserveTurns === undefined ? {} : { reserveTurns }),
    },
  );
  return { instance, ...repos, ...script };
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('AgentExecutionLeaseRegistry', () => {
  it('is a synchronous check-and-set: exactly one of two simultaneous owners wins', () => {
    const leases = new AgentExecutionLeaseRegistry();
    expect(leases.reserve({ agentId: 'a', ownerId: 'one', acquiredAt: at })).toBe(true);
    expect(leases.reserve({ agentId: 'a', ownerId: 'two', acquiredAt: at })).toBe(false);
    expect(leases.holder('a')?.ownerId).toBe('one');
  });

  it('lets the same owner re-acquire idempotently and only that owner release', () => {
    const leases = new AgentExecutionLeaseRegistry();
    expect(leases.reserve({ agentId: 'a', ownerId: 'one', acquiredAt: at })).toBe(true);
    expect(leases.reserve({ agentId: 'a', ownerId: 'one', acquiredAt: at })).toBe(true);
    expect(leases.release('a', 'someone-else')).toBe(false);
    expect(leases.holder('a')?.ownerId).toBe('one');
    expect(leases.release('a', 'one')).toBe(true);
    expect(leases.holder('a')).toBeUndefined();
  });

  it('hands ownership over atomically and refuses a stale transfer', () => {
    const leases = new AgentExecutionLeaseRegistry();
    leases.reserve({ agentId: 'a', ownerId: 'entry', acquiredAt: at });
    expect(leases.transfer('a', 'stale', 'run-1', at, 'run-1')).toBe(false);
    expect(leases.holder('a')?.ownerId).toBe('entry');
    expect(leases.transfer('a', 'entry', 'run-1', at, 'run-1')).toBe(true);
    expect(leases.holder('a')).toMatchObject({ ownerId: 'run-1', runId: 'run-1' });
  });

  it('runs different agents concurrently', () => {
    const leases = new AgentExecutionLeaseRegistry();
    expect(leases.reserve({ agentId: 'a', ownerId: 'one', acquiredAt: at })).toBe(true);
    expect(leases.reserve({ agentId: 'b', ownerId: 'two', acquiredAt: at })).toBe(true);
    expect(leases.list()).toHaveLength(2);
  });

  it('reconciles only owners that are provably inactive', () => {
    const leases = new AgentExecutionLeaseRegistry();
    leases.reserve({ agentId: 'a', ownerId: 'live', acquiredAt: at });
    leases.reserve({ agentId: 'b', ownerId: 'gone', acquiredAt: at });
    const dropped = leases.reconcile((reservation) => reservation.ownerId === 'live');
    expect(dropped.map((reservation) => reservation.agentId)).toEqual(['b']);
    expect(leases.holder('a')?.ownerId).toBe('live');
  });
});

describe('cross-runtime exclusive execution', () => {
  it('a project worker run blocks a scheduled turn for the same agent', async () => {
    const leases = new AgentExecutionLeaseRegistry();
    const scheduled = coordinator(leases, 'scheduled');
    expect(
      leases.reserve({
        agentId: agent.id,
        ownerId: 'project-run:r1',
        ownerKind: 'project',
        acquiredAt: at,
        runId: 'r1',
      }),
    ).toBe(true);

    await expect(drain(scheduled.instance.send(agent.id, 'Run now'))).rejects.toThrow(
      'already executing other IRIS work',
    );
    expect(scheduled.entered()).toBe(0);
    // The blocked turn must not have released the project worker's reservation.
    expect(leases.holder(agent.id)?.ownerId).toBe('project-run:r1');
  });

  it('a scheduled turn blocks a project worker for the same agent, and releases on completion', async () => {
    const leases = new AgentExecutionLeaseRegistry();
    const scheduled = coordinator(leases, 'scheduled');
    const running = drain(scheduled.instance.send(agent.id, 'Run now'));
    await Promise.resolve();
    await Promise.resolve();
    // The scheduled turn owns the agent from `begin`, before it awaits the provider.
    expect(leases.holder(agent.id)).toMatchObject({ ownerId: `scheduled:${agent.id}` });
    expect(
      leases.reserve({ agentId: agent.id, ownerId: 'project-run:r1', ownerKind: 'project', acquiredAt: at }),
    ).toBe(false);

    scheduled.release();
    await running;
    // The completed turn released it, so the next execution is allowed.
    expect(leases.holder(agent.id)).toBeUndefined();
    expect(
      leases.reserve({ agentId: agent.id, ownerId: 'project-run:r1', ownerKind: 'project', acquiredAt: at }),
    ).toBe(true);
  });

  it('denies a simultaneous turn from a second runtime coordinator', async () => {
    const leases = new AgentExecutionLeaseRegistry();
    const scheduled = coordinator(leases, 'scheduled');
    const interactive = coordinator(leases, 'interactive');
    const running = drain(scheduled.instance.send(agent.id, 'Run now'));
    await Promise.resolve();
    await Promise.resolve();

    await expect(drain(interactive.instance.send(agent.id, 'Also run'))).rejects.toThrow(
      'already executing other IRIS work',
    );
    expect(interactive.entered()).toBe(0);

    scheduled.release();
    await running;
    expect(leases.holder(agent.id)).toBeUndefined();
  });

  it('a coordinator that does not own the reservation never fabricates free state', async () => {
    const leases = new AgentExecutionLeaseRegistry();
    const project = coordinator(leases, 'project', false);
    expect(
      leases.reserve({
        agentId: agent.id,
        ownerId: 'project-run:r1',
        ownerKind: 'project',
        acquiredAt: at,
        runId: 'r1',
      }),
    ).toBe(true);

    // The project turn runs inside its own run's reservation, so it is allowed...
    const project_ = drain(project.instance.send(agent.id, 'Worker turn'));
    await Promise.resolve();
    // ...and when the turn ends it must not release the run's ownership.
    project.release();
    await project_;
    expect(leases.holder(agent.id)?.ownerId).toBe('project-run:r1');
  });

  it('rebuilds ownership from persisted suspended turns after a restart', async () => {
    const leases = new AgentExecutionLeaseRegistry();
    const scheduled = coordinator(leases, 'scheduled');
    await scheduled.suspendedTurns.save({
      version: 4,
      agentId: agent.id,
      providerId: 'provider',
      model: 'test-model',
      pending: {
        kind: 'tool-approval',
        turnId: 'turn-1',
        approval: { id: 'approval-1', toolId: 't', toolName: 'T', reason: 'Ask.' },
        call: { id: 'call-1', name: 't', input: {} },
        assistantText: '',
      },
      createdAt: at,
    } as unknown as SuspendedAgentTurn);

    // A restart starts from an empty registry; reconciliation must not present the agent as free.
    expect(leases.holder(agent.id)).toBeUndefined();
    expect(await scheduled.instance.reconcileExecutionReservations()).toBe(1);
    expect(leases.holder(agent.id)?.ownerId).toBe(`scheduled:${agent.id}`);

    // It also never steals an agent another owner already holds.
    const other = new AgentExecutionLeaseRegistry();
    other.reserve({ agentId: agent.id, ownerId: 'project-run:r9', acquiredAt: at });
    const second = coordinator(other, 'scheduled');
    await second.suspendedTurns.save({
      version: 4,
      agentId: agent.id,
      providerId: 'provider',
      model: 'test-model',
      pending: {
        kind: 'tool-approval',
        turnId: 'turn-2',
        approval: { id: 'approval-2', toolId: 't', toolName: 'T', reason: 'Ask.' },
        call: { id: 'call-2', name: 't', input: {} },
        assistantText: '',
      },
      createdAt: at,
    } as unknown as SuspendedAgentTurn);
    expect(await second.instance.reconcileExecutionReservations()).toBe(0);
    expect(other.holder(agent.id)?.ownerId).toBe('project-run:r9');
  });

  it('keeps ownership while an approval is pending, and frees it once cancelled', async () => {
    const leases = new AgentExecutionLeaseRegistry();
    const runs = coordinator(leases, 'interactive');
    // A real session suspension is not required here: what matters is that the coordinator keeps the
    // reservation while a suspended turn for the agent exists.
    await runs.suspendedTurns.save({
      version: 4,
      agentId: agent.id,
      providerId: 'provider',
      model: 'test-model',
      pending: {
        kind: 'tool-approval',
        turnId: 'turn-3',
        approval: { id: 'approval-3', toolId: 't', toolName: 'T', reason: 'Ask.' },
        call: { id: 'call-3', name: 't', input: {} },
        assistantText: '',
      },
      createdAt: at,
    } as unknown as SuspendedAgentTurn);
    expect(await runs.instance.reconcileExecutionReservations()).toBe(1);
    // `send` refuses while an approval is pending, and must not silently drop the reservation.
    await expect(drain(runs.instance.send(agent.id, 'Hello'))).rejects.toThrow(
      'Resolve the pending tool approval',
    );
    expect(leases.holder(agent.id)?.ownerId).toBe(`interactive:${agent.id}`);
    await runs.instance.cancelSuspended(agent.id);
    expect(leases.holder(agent.id)).toBeUndefined();
  });
});
