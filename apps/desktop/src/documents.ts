import {
  createDocument,
  documentAggregateByteLimit,
  documentCountLimit,
  reviseDocument,
  utf8ByteLength,
  validateDocument,
  type DocumentRevision,
  type IrisDocument,
  type NewDocument,
} from '@iris/workspaces';
import { createDesktopRepository } from './repositoryStorage';
import { writeStorageValue, withStorageWrite } from './storageWrites';
const key = 'iris.documents.records.v1';

/**
 * A controlled refusal caused by the document storage budget rather than by invalid input. Nothing
 * is deleted to make room: document revisions are the retained history of the user's work, so the
 * repository refuses the write and reports the exact budget instead.
 */
export class DocumentStorageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentStorageLimitError';
  }
}

export class LocalDocumentRepository {
  constructor(
    private readonly storage?: Storage,
    private readonly byteLimit: number = documentAggregateByteLimit,
    private readonly countLimit: number = documentCountLimit,
  ) {}
  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }
  private read(): IrisDocument[] {
    const raw = this.store.getItem(key);
    if (!raw) return [];
    // Malformed JSON is the same class of problem as a structurally invalid list — the stored value
    // cannot be trusted and must not be replaced — so it reports the same controlled refusal instead
    // of a raw parser error, which told the user nothing about their data being retained.
    let values: unknown;
    try {
      values = JSON.parse(raw);
    } catch {
      throw new Error('Saved documents are invalid. Existing data has been retained.');
    }
    if (
      !Array.isArray(values) ||
      !values.every(validateDocument) ||
      new Set(values.map((doc) => doc.id)).size !== values.length
    )
      throw new Error('Saved documents are invalid. Existing data has been retained.');
    return values;
  }
  /**
   * Commits the whole next document list in one write. The repository never writes metadata and
   * content separately, so a failed write cannot leave an inconsistent store behind.
   */
  private commit(documents: IrisDocument[]): void {
    const payload = JSON.stringify(documents);
    const previous = this.store.getItem(key);
    const previousBytes = previous ? utf8ByteLength(previous) : 0;
    const nextBytes = utf8ByteLength(payload);
    // A store that is already over budget may still shrink; it may never grow further.
    if (nextBytes > this.byteLimit && nextBytes > previousBytes)
      throw new DocumentStorageLimitError(
        `The IRIS document store is limited to ${this.byteLimit} UTF-8 bytes and this change needs ${nextBytes}. ` +
          'Document revisions are never deleted automatically, so export or remove content before saving again.',
      );
    writeStorageValue(this.store, key, payload);
  }
  async list(): Promise<IrisDocument[]> {
    return structuredClone(this.read());
  }
  async get(id: string): Promise<IrisDocument | null> {
    return structuredClone(this.read().find((doc) => doc.id === id) ?? null);
  }
  async create(input: NewDocument): Promise<IrisDocument> {
    return withStorageWrite(this.store, async () => {
      const docs = this.read();
      if (docs.some((doc) => doc.id === input.id)) throw new Error('This document already exists.');
      if (docs.length >= this.countLimit)
        throw new DocumentStorageLimitError(
          `The IRIS document store holds at most ${this.countLimit} documents. Nothing was deleted; remove a document before creating another.`,
        );
      const doc = createDocument(input);
      this.commit([doc, ...docs]);
      return doc;
    });
  }
  async revise(
    id: string,
    expectedRevisionId: string,
    revision: Omit<DocumentRevision, 'number'>,
  ): Promise<IrisDocument> {
    return withStorageWrite(this.store, async () => {
      const docs = this.read();
      const existing = docs.find((doc) => doc.id === id);
      if (!existing) throw new Error('The document is unavailable.');
      const doc = reviseDocument(existing, expectedRevisionId, revision);
      this.commit(docs.map((item) => (item.id === id ? doc : item)));
      return doc;
    });
  }
}
export const documentRepository = createDesktopRepository(
  (storage) => new LocalDocumentRepository(storage),
  [key],
);
const listeners = new Set<() => void>();
export function notifyDocumentsChanged(): void {
  listeners.forEach((listener) => listener());
}
export function subscribeDocuments(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
