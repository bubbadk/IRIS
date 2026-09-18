// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createDocument, utf8ByteLength, type IrisDocument } from '@iris/workspaces';
import { DocumentStorageLimitError, LocalDocumentRepository } from './documents';
import { StorageQuotaExceededError } from './storageWrites';

const key = 'iris.documents.records.v1';

function at(sequence: number): string {
  return new Date(Date.UTC(2026, 8, 9, 12, 0, sequence)).toISOString();
}

/** A real Storage implementation with an explicit byte budget and write accounting. */
class FakeStorage implements Storage {
  readonly values = new Map<string, string>();
  writes = 0;
  constructor(private readonly budget = Number.POSITIVE_INFINITY) {}
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(name: string) {
    return this.values.get(name) ?? null;
  }
  setItem(name: string, value: string) {
    if (utf8ByteLength(value) > this.budget)
      throw new DOMException('Exceeded the storage quota.', 'QuotaExceededError');
    this.writes += 1;
    this.values.set(name, value);
  }
  removeItem(name: string) {
    this.values.delete(name);
  }
  clear() {
    this.values.clear();
  }
}

function newDocument(content: string, id = 'document-1', title = 'Report') {
  return {
    id,
    title,
    format: 'markdown' as const,
    revision: {
      id: `revision-${id}`,
      content,
      createdAt: at(1),
      author: { kind: 'user' as const, id: 'user', name: 'You' },
    },
  };
}

function serialized(documents: IrisDocument[]): string {
  return JSON.stringify(documents);
}

describe('M-20 document storage budget', () => {
  it('saves normally while the store is under its cap', async () => {
    const storage = new FakeStorage();
    const repository = new LocalDocumentRepository(storage, 4096);
    await repository.create(newDocument('small content'));
    expect((await repository.list())[0]!.revisions[0]!.content).toBe('small content');
  });

  it('saves normally when the store is exactly at its cap', async () => {
    const expected = JSON.stringify([createDocument(newDocument('exactly at the cap'))]);
    const storage = new FakeStorage();
    const repository = new LocalDocumentRepository(storage, utf8ByteLength(expected));
    await repository.create(newDocument('exactly at the cap'));
    expect(storage.getItem(key)).toBe(expected);
    expect(utf8ByteLength(storage.getItem(key)!)).toBe(utf8ByteLength(expected));
  });

  it('refuses to grow past the cap with a controlled error and keeps the old value', async () => {
    const expected = JSON.stringify([createDocument(newDocument('exactly at the cap'))]);
    const limit = utf8ByteLength(expected) - 1;
    const storage = new FakeStorage();
    const repository = new LocalDocumentRepository(storage, limit);
    await expect(repository.create(newDocument('exactly at the cap'))).rejects.toThrow(
      DocumentStorageLimitError,
    );
    await expect(repository.create(newDocument('exactly at the cap'))).rejects.toThrow(
      `${limit} UTF-8 bytes`,
    );
    expect(storage.getItem(key)).toBeNull();
    expect(await repository.list()).toEqual([]);
  });

  it('lets an already over-budget store shrink but never grow further', async () => {
    const storage = new FakeStorage();
    // Legacy data written before the aggregate budget existed: over budget but still readable.
    const legacy = JSON.stringify([createDocument(newDocument('x'.repeat(600)))], null, 2);
    storage.setItem(key, legacy);
    const repository = new LocalDocumentRepository(storage, 900);
    expect(utf8ByteLength(legacy)).toBeGreaterThan(900);
    await expect(
      repository.revise('document-1', 'revision-document-1', {
        id: 'revision-2',
        content: 'y'.repeat(600),
        createdAt: at(2),
        author: { kind: 'user', id: 'user', name: 'You' },
      }),
    ).rejects.toThrow(DocumentStorageLimitError);
    expect(storage.getItem(key)).toBe(legacy);
    // A write that genuinely reduces total usage is still allowed, so legacy data is never locked.
    await repository.revise('document-1', 'revision-document-1', {
      id: 'revision-2',
      content: 'tiny',
      createdAt: at(2),
      author: { kind: 'user', id: 'user', name: 'You' },
    });
    expect(utf8ByteLength(storage.getItem(key)!)).toBeLessThan(utf8ByteLength(legacy));
    expect((await repository.list())[0]!.revisions.at(-1)!.content).toBe('tiny');
  });

  it('refuses a new document once the store holds its maximum count', async () => {
    const storage = new FakeStorage();
    const repository = new LocalDocumentRepository(storage, 1_000_000, 2);
    await repository.create(newDocument('one', 'document-1'));
    await repository.create(newDocument('two', 'document-2'));
    await expect(repository.create(newDocument('three', 'document-3'))).rejects.toThrow(
      DocumentStorageLimitError,
    );
    await expect(repository.create(newDocument('three', 'document-3'))).rejects.toThrow(
      'at most 2 documents',
    );
    expect(await repository.list()).toHaveLength(2);
  });

  it('measures the budget in UTF-8 bytes, not in characters', async () => {
    const expected = JSON.stringify([createDocument(newDocument('ø'.repeat(500)))]);
    const storage = new FakeStorage();
    // The payload is far longer in bytes than in characters; the byte budget must be what counts.
    expect(utf8ByteLength(expected)).toBeGreaterThan(Array.from(expected).length + 400);
    const repository = new LocalDocumentRepository(storage, utf8ByteLength(expected));
    await expect(repository.create(newDocument('ø'.repeat(500)))).resolves.toBeTruthy();
    const tight = new LocalDocumentRepository(new FakeStorage(), utf8ByteLength(expected) - 1);
    await expect(tight.create(newDocument('ø'.repeat(500)))).rejects.toThrow(
      DocumentStorageLimitError,
    );
  });
});

describe('M-20 quota failures', () => {
  it('keeps the previous raw value byte-identical when storage rejects the write', async () => {
    const roomy = new FakeStorage(10_000);
    await new LocalDocumentRepository(roomy, 10_000).create(newDocument('first revision'));
    const before = roomy.getItem(key)!;
    // A storage whose whole budget is exactly the committed value: any growth fails the quota.
    const tight = new FakeStorage(utf8ByteLength(before));
    tight.setItem(key, before);
    const repository = new LocalDocumentRepository(tight, 1_000_000);
    await expect(
      repository.revise('document-1', 'revision-document-1', {
        id: 'revision-2',
        content: 'second revision that no longer fits in the quota',
        createdAt: at(2),
        author: { kind: 'user', id: 'user', name: 'You' },
      }),
    ).rejects.toThrow(StorageQuotaExceededError);
    expect(tight.getItem(key)).toBe(before);
    expect(before).toContain('first revision');
    expect(before).not.toContain('second revision');
  });

  it('never loses the current revision when a save fails', async () => {
    const roomy = new FakeStorage(10_000);
    await new LocalDocumentRepository(roomy, 10_000).create(newDocument('first revision'));
    const seeded = new LocalDocumentRepository(roomy, 10_000);
    for (let number = 2; number <= 4; number += 1)
      await seeded.revise(
        'document-1',
        number === 2 ? 'revision-document-1' : `revision-${number - 1}`,
        {
          id: `revision-${number}`,
          content: `revision ${number}`,
          createdAt: at(number),
          author: { kind: 'user', id: 'user', name: 'You' },
        },
      );
    const committed = roomy.getItem(key)!;
    const tight = new FakeStorage(utf8ByteLength(committed));
    tight.setItem(key, committed);
    const repository = new LocalDocumentRepository(tight, 10_000);
    await expect(
      repository.revise('document-1', 'revision-4', {
        id: 'revision-5',
        content: 'revision 5',
        createdAt: at(5),
        author: { kind: 'user', id: 'user', name: 'You' },
      }),
    ).rejects.toThrow(StorageQuotaExceededError);
    // The durable value is untouched and a fresh read still exposes every committed revision.
    expect(tight.getItem(key)).toBe(committed);
    expect((await repository.list())[0]!.revisions.map((revision) => revision.content)).toEqual([
      'first revision',
      'revision 2',
      'revision 3',
      'revision 4',
    ]);
  });

  it('reports a controlled error class the caller can present to the user', async () => {
    const storage = new FakeStorage();
    storage.setItem = () => {
      throw new DOMException('Exceeded the storage quota.', 'QuotaExceededError');
    };
    const repository = new LocalDocumentRepository(storage, 1_000_000);
    const failure = await repository
      .create(newDocument('content'))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageQuotaExceededError);
    expect((failure as Error).message).toContain('nothing was saved');
    expect((failure as Error).message).toContain('QuotaExceededError');
  });
});

describe('M-20 write atomicity', () => {
  it('writes the entire next document list in exactly one storage write', async () => {
    const storage = new FakeStorage();
    const repository = new LocalDocumentRepository(storage, 1_000_000);
    await repository.create(newDocument('one', 'document-1'));
    storage.writes = 0;
    await repository.revise('document-1', 'revision-document-1', {
      id: 'revision-2',
      content: 'two',
      createdAt: at(2),
      author: { kind: 'user', id: 'user', name: 'You' },
    });
    expect(storage.writes).toBe(1);
    const committed = JSON.parse(storage.getItem(key)!) as IrisDocument[];
    expect(committed).toHaveLength(1);
    expect(committed[0]!.revisions.map((revision) => revision.content)).toEqual(['one', 'two']);
  });

  it('reloads retained revisions identically after a restart', async () => {
    const storage = new FakeStorage();
    const repository = new LocalDocumentRepository(storage, 1_000_000);
    await repository.create(newDocument('one', 'document-1'));
    await repository.revise('document-1', 'revision-document-1', {
      id: 'revision-2',
      content: 'two',
      createdAt: at(2),
      author: { kind: 'agent', id: 'agent', name: 'Writer', turnId: 'turn' },
    });
    const before = await repository.list();
    // A brand new repository over the same durable bytes simulates the next launch.
    const restarted = new LocalDocumentRepository(storage, 1_000_000);
    expect(await restarted.list()).toEqual(before);
    expect((await restarted.list())[0]!.revisions[1]!.author.turnId).toBe('turn');
    expect(serialized(await restarted.list())).toBe(serialized(before));
  });
});
