import { invoke, isTauri } from '@tauri-apps/api/core';
import { repositoryKeys } from './repositoryKeys';

export interface StorageSnapshot {
  values: Record<string, string>;
  revisions: Record<string, number>;
}
export interface RepositoryBackend {
  snapshot(keys?: readonly string[]): Promise<StorageSnapshot>;
  commit(
    expected: Record<string, number>,
    changes: Record<string, string | null>,
  ): Promise<boolean>;
}

/** A private transaction view. No changes escape before the durable commit succeeds. */
export class SnapshotStorage implements Storage {
  private values: Map<string, string>;
  readonly reads = new Set<string>();
  readonly changes = new Map<string, string | null>();
  constructor(values: Record<string, string> = {}) {
    this.values = new Map(Object.entries(values));
  }
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    this.reads.add(key);
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.reads.add(key);
    if (this.values.get(key) === value) return;
    this.values.set(key, value);
    this.changes.set(key, value);
  }
  removeItem(key: string) {
    this.reads.add(key);
    if (!this.values.has(key)) return;
    this.values.delete(key);
    this.changes.set(key, null);
  }
  clear() {
    for (const key of this.values.keys()) this.removeItem(key);
  }
}

export class RepositoryTransactions {
  private cache = new SnapshotStorage();
  constructor(private readonly backend: RepositoryBackend) {}
  async initialize() {
    this.cache = new SnapshotStorage((await this.backend.snapshot()).values);
  }
  get initialSnapshot(): Storage {
    return this.cache;
  }
  async run<T>(operation: (storage: Storage) => Promise<T>, keys?: readonly string[]): Promise<T> {
    // Retry the pure repository operation against fresh data after another window commits.
    // Tool execution is outside this boundary and is never replayed here.
    for (let attempt = 0; attempt < 32; attempt++) {
      const snapshot = await this.backend.snapshot(keys);
      const storage = new SnapshotStorage(snapshot.values);
      const result = await operation(storage);
      if (keys && [...storage.reads].some((key) => !keys.includes(key)))
        throw new Error('Repository accessed data outside its transaction scope.');
      const changes = Object.fromEntries(storage.changes);
      if (
        storage.changes.size &&
        !(await this.backend.commit(
          Object.fromEntries([...storage.reads].map((key) => [key, snapshot.revisions[key] ?? 0])),
          changes,
        ))
      )
        continue;
      for (const key of keys ?? repositoryKeys) this.cache.removeItem(key);
      for (const [key, value] of Object.entries(snapshot.values)) this.cache.setItem(key, value);
      for (const [key, value] of storage.changes) {
        if (value === null) this.cache.removeItem(key);
        else this.cache.setItem(key, value);
      }
      return result;
    }
    throw new Error('The database is busy in another window. Please retry the operation.');
  }
}

let transactions: RepositoryTransactions | undefined;
let initialization: Promise<void> | undefined;
export function initializeRepositoryStorage(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  initialization ??= (async () => {
    const legacy: Record<string, string> = {};
    for (const key of repositoryKeys) {
      const value = globalThis.localStorage.getItem(key);
      if (value !== null) legacy[key] = value;
    }
    // Native import is one transaction and runs only once. Keep localStorage as a backup.
    await invoke('repository_initialize', { legacy });
    const ready = new RepositoryTransactions({
      snapshot: (keys) => invoke<StorageSnapshot>('repository_snapshot', { keys: keys ?? null }),
      commit: (expected, changes) => invoke<boolean>('repository_commit', { expected, changes }),
    });
    await ready.initialize();
    transactions = ready;
  })();
  return initialization;
}

/** Preserve repository contracts while isolating each call in its own SQLite transaction view. */
export function createDesktopRepository<T extends object>(
  factory: (storage?: Storage) => T,
  keys: readonly string[],
): T {
  return new Proxy(factory(), {
    get(target, property) {
      const method: unknown = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      if (!isTauri()) return method.bind(target) as unknown;
      if (property === 'listSync')
        return (...args: unknown[]) => {
          if (!transactions) throw new Error('The repository database has not been initialized.');
          const view = factory(transactions.initialSnapshot);
          return Reflect.apply(
            Reflect.get(view, property) as (...args: unknown[]) => unknown,
            view,
            args,
          );
        };
      return async (...args: unknown[]) => {
        await initializeRepositoryStorage();
        if (!transactions) throw new Error('The repository database is unavailable.');
        return transactions.run(async (storage) => {
          const view = factory(storage);
          return Reflect.apply(
            Reflect.get(view, property) as (...args: unknown[]) => unknown,
            view,
            args,
          );
        }, keys);
      };
    },
  });
}
