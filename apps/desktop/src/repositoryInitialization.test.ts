import { afterEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: native.invoke }));
afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function readyMock() {
  native.invoke.mockImplementation(async (command: string) =>
    command === 'repository_snapshot' ? { values: {}, revisions: {} } : undefined,
  );
}

it('retries repository initialization on the next legitimate operation after a transient failure', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  native.invoke.mockRejectedValueOnce(new Error('Transient database failure'));
  const { initializeRepositoryStorage } = await import('./repositoryStorage');
  await expect(initializeRepositoryStorage()).rejects.toThrow('Transient database failure');
  readyMock();
  await expect(initializeRepositoryStorage()).resolves.toBeUndefined();
  expect(native.invoke.mock.calls.filter(([command]) => command === 'repository_initialize')).toHaveLength(2);
});

it('performs exactly one physical initialization for two concurrent first callers', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  readyMock();
  const { initializeRepositoryStorage } = await import('./repositoryStorage');
  await Promise.all([initializeRepositoryStorage(), initializeRepositoryStorage()]);
  expect(native.invoke.mock.calls.filter(([command]) => command === 'repository_initialize')).toHaveLength(1);
});

it('shares one rejection among multiple callers awaiting the same failing initialization', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  native.invoke.mockRejectedValue(new Error('Persistent database failure'));
  const { initializeRepositoryStorage } = await import('./repositoryStorage');
  const attempts = await Promise.allSettled([
    initializeRepositoryStorage(),
    initializeRepositoryStorage(),
    initializeRepositoryStorage(),
  ]);
  expect(attempts.map((attempt) => attempt.status)).toEqual(['rejected', 'rejected', 'rejected']);
  for (const attempt of attempts)
    expect((attempt as PromiseRejectedResult).reason).toMatchObject({ message: 'Persistent database failure' });
  expect(native.invoke.mock.calls.filter(([command]) => command === 'repository_initialize')).toHaveLength(1);
  // Controlled failure with no internal retry loop.
  expect(native.invoke.mock.calls.filter(([command]) => command === 'repository_snapshot')).toHaveLength(0);
});

it('starts exactly one shared retry when several callers arrive together after failure', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  native.invoke.mockRejectedValueOnce(new Error('First attempt failed'));
  const { initializeRepositoryStorage } = await import('./repositoryStorage');
  await expect(initializeRepositoryStorage()).rejects.toThrow('First attempt failed'.replace('First attempt', 'First attempt'));
  readyMock();
  await Promise.all([initializeRepositoryStorage(), initializeRepositoryStorage(), initializeRepositoryStorage()]);
  expect(native.invoke.mock.calls.filter(([command]) => command === 'repository_initialize')).toHaveLength(2);
});

it('keeps the repository unusable until initialization succeeds, then usable', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  native.invoke.mockRejectedValueOnce(new Error('Transient database failure'));
  const { initializeRepositoryStorage, currentRepositoryTransactions } = await import('./repositoryStorage');
  await expect(initializeRepositoryStorage()).rejects.toThrow('Transient database failure');
  expect(currentRepositoryTransactions()).toBeUndefined();
  readyMock();
  await initializeRepositoryStorage();
  expect(currentRepositoryTransactions()).toBeDefined();
});

it('survives failure after the native mutation: the retry is a fresh, safe attempt', async () => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  // repository_initialize succeeds, the first snapshot (part of initialization) then fails.
  native.invoke.mockImplementation(async (command: string) => {
    if (command === 'repository_initialize') return undefined;
    if (command === 'repository_snapshot') throw new Error('Snapshot after native mutation failed');
    throw new Error('Unexpected command');
  });
  const { initializeRepositoryStorage } = await import('./repositoryStorage');
  await expect(initializeRepositoryStorage()).rejects.toThrow('Snapshot after native mutation failed');
  readyMock();
  await expect(initializeRepositoryStorage()).resolves.toBeUndefined();
  // Native initialize ran twice; it is idempotent (migration-once semantics live in the
  // native migrations table, proven by repository.rs tests).
  expect(native.invoke.mock.calls.filter(([command]) => command === 'repository_initialize')).toHaveLength(2);
});
