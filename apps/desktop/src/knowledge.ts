import {
  sameKnowledgeScope,
  proposeKnowledge,
  reviewKnowledge,
  validateKnowledgeEntry,
  type KnowledgeEntry,
  type KnowledgeInput,
} from '@iris/memory';
import { createDesktopRepository } from './repositoryStorage';
import { withStorageWrite } from './storageWrites';
const key = 'iris.knowledge.records.v1';
export class LocalKnowledgeRepository {
  constructor(private readonly storage?: Storage) {}
  private get store() {
    return this.storage ?? globalThis.localStorage;
  }
  private read(): KnowledgeEntry[] {
    const raw = this.store.getItem(key);
    if (!raw) return [];
    const entries: unknown = JSON.parse(raw);
    if (
      !Array.isArray(entries) ||
      !entries.every(validateKnowledgeEntry) ||
      new Set(entries.map((entry) => entry.id)).size !== entries.length
    )
      throw new Error('Saved knowledge is invalid. Existing data has been retained.');
    return entries;
  }
  async list() {
    return structuredClone(this.read());
  }
  async propose(input: KnowledgeInput) {
    return withStorageWrite(this.store, async () => {
      const entries = this.read();
      if (entries.some((entry) => entry.id === input.id))
        throw new Error('This knowledge entry already exists.');
      const entry = proposeKnowledge(input);
      if (
        entry.replacesId &&
        !entries.some(
          (previous) =>
            previous.id === entry.replacesId && sameKnowledgeScope(previous.scope, entry.scope),
        )
      )
        throw new Error('The previous entry is unavailable. Refresh before proposing a revision.');
      this.store.setItem(key, JSON.stringify([entry, ...entries]));
      return entry;
    });
  }
  async review(
    id: string,
    revision: number,
    decision: 'activate' | 'archive',
    conflicts: Record<string, number>,
  ) {
    return withStorageWrite(this.store, async () => {
      const entries = reviewKnowledge(
        this.read(),
        id,
        revision,
        decision,
        conflicts,
        new Date().toISOString(),
      );
      this.store.setItem(key, JSON.stringify(entries));
      return entries.find((entry) => entry.id === id)!;
    });
  }
}
export const knowledgeRepository = createDesktopRepository(
  (storage) => new LocalKnowledgeRepository(storage),
  [key],
);
const listeners = new Set<() => void>();
export function notifyKnowledgeChanged() {
  listeners.forEach((listener) => listener());
}
export function subscribeKnowledge(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
