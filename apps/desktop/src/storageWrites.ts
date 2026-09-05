// Serialize read-modify-write operations across repositories and desktop webviews.
// localStorage.setItem is atomic: a failed write leaves the previous value intact.
const queues = new WeakMap<Storage, Promise<unknown>>();

export async function withStorageWrite<T>(
  storage: Storage,
  operation: () => Promise<T>,
): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('iris:persistence', operation);
  }
  const previous = queues.get(storage) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(storage, next);
  void next
    .finally(() => {
      if (queues.get(storage) === next) queues.delete(storage);
    })
    .catch(() => undefined);
  return next;
}
