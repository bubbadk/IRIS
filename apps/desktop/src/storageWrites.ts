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

/**
 * A durable write that ran out of storage. It is a controlled, catchable error: the caller learns
 * that nothing was persisted instead of observing a half-applied repository.
 */
export class StorageQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageQuotaExceededError';
  }
}

function storageFailureReason(failure: unknown): string {
  if (failure instanceof Error) {
    const name = failure.name || 'storage error';
    return `${name}: ${failure.message}`;
  }
  return String(failure);
}

/**
 * Commits one complete value for a storage key. A single `setItem` is the atomic unit of web
 * storage, so either the whole next value is durable or the previous value remains untouched; this
 * helper additionally turns a quota or security failure into a controlled error the caller can
 * report to the user.
 */
export function writeStorageValue(storage: Storage, key: string, value: string): void {
  const previous = storage.getItem(key);
  try {
    storage.setItem(key, value);
  } catch (failure) {
    // Best effort only: web storage is atomic, so the previous value is normally still in place.
    // A storage implementation that is not atomic must never keep a partially written value.
    try {
      if (previous === null) storage.removeItem(key);
      else storage.setItem(key, previous);
    } catch {
      // Swallowed deliberately: the original failure is what the caller must see, and any further
      // storage error would only hide it.
    }
    throw new StorageQuotaExceededError(
      `IRIS could not save this change because durable storage rejected the write, so nothing was saved and the previous data is intact (${storageFailureReason(failure)}).`,
    );
  }
}
