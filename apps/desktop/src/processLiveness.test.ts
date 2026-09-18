import { afterEach, expect, it, vi } from 'vitest';
import { agentLeaseStorageKey, createLeaseAuthority, decodeExecutionLeases } from '@iris/agents';
import { RepositoryTransactions, type StorageSnapshot } from './repositoryStorage';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true }));
const repository = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('./repositoryStorage', async (original) => ({
  ...await original<typeof import('./repositoryStorage')>(),
  currentRepositoryTransactions: () => repository.current,
}));
afterEach(() => { vi.resetModules(); vi.clearAllMocks(); });

it.each([
  ['invoke throws', 'throw'],
  ['explicit unknown', { status: 'unknown', reason: 'Injected error' }],
  ['missing status', {}],
  ['unexpected enum', { status: 'missing' }],
  ['undefined', undefined],
  ['legacy false', false],
  ['invalid JSON payload', '{broken'],
  ['alive', { status: 'alive' }],
])('does not take over a foreign owner: %s', async (_label, response) => {
  const data: StorageSnapshot = { values: {}, revisions: {} };
  const transactions = new RepositoryTransactions({
    snapshot: async () => structuredClone(data),
    commit: async (expected, changes) => {
      if (Object.entries(expected).some(([k, v]) => (data.revisions[k] ?? 0) !== v)) return false;
      for (const [k, v] of Object.entries(changes)) {
        data.revisions[k] = (data.revisions[k] ?? 0) + 1;
        if (v === null) delete data.values[k]; else data.values[k] = v;
      }
      return true;
    },
  });
  repository.current = transactions;
  const ownerA = createLeaseAuthority(transactions, {
    pid: async () => 101, instance: () => 'instance-A', liveness: async () => ({ status: 'alive' }),
  });
  await ownerA.acquire('agent-X', 'owner-A', 'interactive', '2026-01-01T00:00:00Z');
  const before = structuredClone(data);
  native.invoke.mockImplementation(async (command: string) => {
    if (command === 'process_own_pid') return 202;
    if (command === 'process_instance_nonce') return 'instance-B';
    if (command === 'process_is_alive') {
      if (response === 'throw') throw new Error('Injected IPC probe failure');
      return response;
    }
    throw new Error('Unexpected command');
  });
  const { crossProcessAuthority } = await import('./agentExecution');
  const ownerB = await crossProcessAuthority();
  const acquired = await ownerB!.acquire('agent-X', 'owner-B', 'interactive', '2026-01-01T00:00:01Z');
  console.info('Liveness fault evidence', {
    agentId: 'agent-X', ownerA: 'owner-A', ownerB: 'owner-B', probe: _label,
    revisionBefore: before.revisions[agentLeaseStorageKey], revisionAfter: data.revisions[agentLeaseStorageKey],
    acquired, resultingOwner: decodeExecutionLeases(data.values[agentLeaseStorageKey])['agent-X'].ownerId,
  });
  expect(acquired).toBe(false);
  expect(data).toEqual(before);
});
