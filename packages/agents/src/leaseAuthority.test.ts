import { describe, expect, it } from 'vitest';
import { RepositoryTransactions, type RepositoryBackend, type StorageSnapshot } from '../../../apps/desktop/src/repositoryStorage';
import {
  agentLeaseStorageKey,
  createLeaseAuthority,
  decodeExecutionLeases,
  type CrossProcessLeaseIdentity,
  type ProcessLiveness,
} from './leaseAuthority';

/**
 * IRIS Phase 2H.1 — the cross-process authority under the exact repository transaction
 * semantics production uses. The backend is the same optimistic-CAS shape as the native
 * SQLite adapter (snapshot revisions + conditional commit), so a race between two processes
 * is a real commit race, not a shared mutable object.
 */

class CasBackend implements RepositoryBackend {
  data: StorageSnapshot = { values: {}, revisions: {} };
  failCommits = 0;
  async snapshot(): Promise<StorageSnapshot> {
    return structuredClone(this.data);
  }
  async commit(expected: Record<string, number>, changes: Record<string, string | null>) {
    if (this.failCommits > 0) {
      this.failCommits -= 1;
      return false;
    }
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

/** Two simulated process identities sharing one backend. */
function identity(pid: number, instance: string, alivePids: number[]): CrossProcessLeaseIdentity {
  return {
    pid: async () => pid,
    instance: () => instance,
    liveness: async (candidate) => ({ status: alivePids.includes(candidate) ? 'alive' : 'dead' }),
  };
}

function authority(backend: CasBackend, pid: number, instance: string, alivePids: number[]) {
  return createLeaseAuthority(new RepositoryTransactions(backend), identity(pid, instance, alivePids));
}

const at = '2026-09-17T12:00:00.000Z';

describe('cross-process lease authority (Phase 2H.1)', () => {
  it('gives exactly one winner per synchronized race, over many rounds', async () => {
    for (let round = 0; round < 100; round++) {
      const backend = new CasBackend();
      const first = authority(backend, 100, `instance-a-${round}`, [100, 200]);
      const second = authority(backend, 200, `instance-b-${round}`, [100, 200]);
      const [a, b] = await Promise.all([
        first.acquire('agent', 'owner-a', 'scheduled', at),
        second.acquire('agent', 'owner-b', 'interactive', at),
      ]);
      expect(a !== b, `round ${round} must have exactly one winner`).toBe(true);
      const winner = a ? 'owner-a' : 'owner-b';
      const loser = a ? second : first;
      await expect(loser.inspect('agent')).resolves.toEqual({ ownerId: winner });
    }
  });

  it('recovers a lease whose recorded process is provably dead', async () => {
    const backend = new CasBackend();
    // Seed a lease from a dead process.
    await new RepositoryTransactions(backend).run(async (storage) => {
      storage.setItem(
        agentLeaseStorageKey,
        JSON.stringify({
          agent: {
            agentId: 'agent',
            ownerId: 'scheduled:agent',
            ownerKind: 'scheduled',
            processId: 4194303,
            processInstance: 'dead-instance',
            acquiredAt: at,
          },
        }),
      );
    }, [agentLeaseStorageKey]);
    // pid 4194303 is not reported alive by either runtime's probe.
    const next = authority(backend, 200, 'instance-b', []);
    await expect(next.acquire('agent', 'owner-b', 'interactive', at)).resolves.toBe(true);
    await expect(next.inspect('agent')).resolves.toBeUndefined();
  });

  it('never lets a recycled pid override a live foreign runtime', async () => {
    const backend = new CasBackend();
    // Runtime A (pid 100) crashed without cleanup; an unrelated runtime later reused pid 100.
    await new RepositoryTransactions(backend).run(async (storage) => {
      storage.setItem(
        agentLeaseStorageKey,
        JSON.stringify({
          agent: {
            agentId: 'agent',
            ownerId: 'scheduled:agent',
            ownerKind: 'scheduled',
            processId: 100,
            processInstance: 'instance-older',
            acquiredAt: at,
          },
        }),
      );
    }, [agentLeaseStorageKey]);
    // Runtime B happens to run in pid 100's slot per its own view, but A's pid is probed alive.
    const b = authority(backend, 100, 'instance-b', [100]);
    await expect(b.acquire('agent', 'owner-b', 'interactive', at)).resolves.toBe(false);
    await expect(b.inspect('agent')).resolves.toEqual({ ownerId: 'scheduled:agent' });
  });

  it('releases only from the owning runtime and hands over immediately', async () => {
    const backend = new CasBackend();
    const a = authority(backend, 100, 'instance-a', [100, 200]);
    const b = authority(backend, 200, 'instance-b', [100, 200]);
    await expect(a.acquire('agent', 'owner-a', 'interactive', at)).resolves.toBe(true);
    await expect(b.release('agent', 'owner-a')).resolves.toBeUndefined();
    await expect(b.inspect('agent')).resolves.toEqual({ ownerId: 'owner-a' });
    await expect(a.release('agent', 'owner-a')).resolves.toBeUndefined();
    await expect(b.acquire('agent', 'owner-b', 'scheduled', at)).resolves.toBe(true);
    // The same runtime re-acquiring idempotently keeps its own lease.
    await expect(a.acquire('other', 'owner-a', 'interactive', at)).resolves.toBe(true);
    await expect(a.acquire('other', 'owner-a', 'interactive', at)).resolves.toBe(true);
  });

  it('fails closed on a corrupt lease document instead of starting the turn', async () => {
    const backend = new CasBackend();
    await new RepositoryTransactions(backend).run(async (storage) => {
      storage.setItem(agentLeaseStorageKey, '{not json');
    }, [agentLeaseStorageKey]);
    const a = authority(backend, 100, 'instance-a', [100]);
    await expect(a.acquire('agent', 'owner-a', 'interactive', at)).rejects.toThrow(
      'Saved agent execution leases are invalid',
    );
    await expect(a.inspect('agent')).rejects.toThrow('Saved agent execution leases are invalid');
  });

  it('fails closed when the commit cannot be verified', async () => {
    const backend = new CasBackend();
    backend.failCommits = 32; // exhaust the transaction retry budget
    const a = authority(backend, 100, 'instance-a', [100]);
    await expect(a.acquire('agent', 'owner-a', 'interactive', at)).rejects.toThrow(
      'The database is busy',
    );
  });

  it.each(['unknown', 'throw', 'malformed'] as const)('preserves foreign ownership and revision for %s probes over 100 contenders', async (fault) => {
    const backend = new CasBackend();
    await authority(backend, 100, 'a', [100]).acquire('agent', 'owner-a', 'interactive', at);
    const before = structuredClone(backend.data);
    const contenders = Array.from({ length: 100 }, (_, index) => createLeaseAuthority(new RepositoryTransactions(backend), {
      pid: async () => index + 200,
      instance: () => `candidate-${index}`,
      liveness: async (): Promise<ProcessLiveness> => {
        if (fault === 'throw') throw new Error('Injected probe failure');
        if (fault === 'malformed') return false as unknown as ProcessLiveness;
        return { status: 'unknown', reason: 'Injected unknown' };
      },
    }));
    expect(await Promise.all(contenders.map(port => port.acquire('agent', 'candidate', 'scheduled', at))))
      .toEqual(Array(100).fill(false));
    expect(backend.data).toEqual(before);
    await expect(contenders[0].inspect('agent')).resolves.toEqual({ ownerId: 'owner-a' });
    expect(backend.data).toEqual(before);
  });

  it('has exactly one dead-owner takeover winner in each of 100 CAS races', async () => {
    for (let round = 0; round < 100; round++) {
      const backend = new CasBackend();
      await authority(backend, 100, 'dead', [100]).acquire('agent', 'dead-owner', 'interactive', at);
      const a = authority(backend, 200, 'a', [200, 300]);
      const b = authority(backend, 300, 'b', [200, 300]);
      const result = await Promise.all([a.acquire('agent', 'a', 'interactive', at), b.acquire('agent', 'b', 'scheduled', at)]);
      expect(result.filter(Boolean)).toHaveLength(1);
      expect(backend.data.revisions[agentLeaseStorageKey]).toBe(2);
    }
  });

  it('keeps dead-owner state intact when recovery commit stays busy', async () => {
    const backend = new CasBackend();
    await authority(backend, 100, 'dead', [100]).acquire('agent', 'dead-owner', 'interactive', at);
    const before = structuredClone(backend.data);
    backend.failCommits = 32;
    await expect(authority(backend, 200, 'b', [200]).acquire('agent', 'b', 'interactive', at)).rejects.toThrow('database is busy');
    expect(backend.data).toEqual(before);
  });

  it('does not mutate or fabricate a free agent when snapshot inspection fails', async () => {
    const port = createLeaseAuthority(new RepositoryTransactions({
      snapshot: async () => { throw new Error('Database busy inspecting'); },
      commit: async () => { throw new Error('Must not commit'); },
    }), identity(200, 'b', [200]));
    await expect(port.inspect('agent')).rejects.toThrow('Database busy inspecting');
    await expect(port.acquire('agent', 'b', 'interactive', at)).rejects.toThrow('Database busy inspecting');
  });

  it('defers an alive probe even if the owner dies immediately afterward, then recovers on the next probe', async () => {
    const backend = new CasBackend();
    await authority(backend, 100, 'a', [100]).acquire('agent', 'a', 'interactive', at);
    let first = true;
    const b = createLeaseAuthority(new RepositoryTransactions(backend), {
      pid: async () => 200, instance: () => 'b',
      liveness: async () => { const status = first ? 'alive' : 'dead'; first = false; return { status }; },
    });
    await expect(b.acquire('agent', 'b', 'interactive', at)).resolves.toBe(false);
    expect(backend.data.revisions[agentLeaseStorageKey]).toBe(1);
    await expect(b.acquire('agent', 'b', 'interactive', at)).resolves.toBe(true);
  });

  it('reprobes after CAS conflict and denies when the recorded PID became live', async () => {
    const backend = new CasBackend();
    await authority(backend, 100, 'old', [100]).acquire('agent', 'old', 'interactive', at);
    backend.failCommits = 1;
    let probes = 0;
    const b = createLeaseAuthority(new RepositoryTransactions(backend), {
      pid: async () => 200, instance: () => 'b',
      liveness: async () => ({ status: ++probes === 1 ? 'dead' : 'alive' }),
    });
    await expect(b.acquire('agent', 'b', 'interactive', at)).resolves.toBe(false);
    expect(probes).toBe(2);
    expect(backend.data.revisions[agentLeaseStorageKey]).toBe(1);
    expect(decodeExecutionLeases(backend.data.values[agentLeaseStorageKey]).agent.ownerId).toBe('old');
  });

  it('round-trips records through the strict decoder and refuses malformed shapes', () => {
    const record = {
      agentId: 'agent',
      ownerId: 'owner',
      ownerKind: 'interactive',
      processId: 1,
      processInstance: 'i',
      acquiredAt: at,
    };
    expect(decodeExecutionLeases(JSON.stringify({ agent: record }))['agent']).toEqual(record);
    expect(decodeExecutionLeases(null)).toEqual({});
    expect(() => decodeExecutionLeases('[]')).toThrow('invalid');
    expect(() =>
      decodeExecutionLeases(JSON.stringify({ agent: { ...record, processId: 'x' } })),
    ).toThrow('invalid');
  });
});
