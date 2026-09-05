import { describe, expect, it } from 'vitest';
import {
  RepositoryTransactions,
  type RepositoryBackend,
  type StorageSnapshot,
} from './repositoryStorage';
import { LocalConversationRepository, LocalToolApprovalRepository } from './persistence';
import type { ToolApprovalRequest } from '@iris/tools';

class TestDatabase implements RepositoryBackend {
  data: StorageSnapshot = { values: {}, revisions: {} };
  fail = false;
  async snapshot() {
    return structuredClone(this.data);
  }
  async commit(expected: Record<string, number>, changes: Record<string, string | null>) {
    if (this.fail) throw new Error('Disk full');
    if (
      Object.entries(expected).some(
        ([key, revision]) => (this.data.revisions[key] ?? 0) !== revision,
      )
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

describe('native repository transaction adapter', () => {
  it('retains both agents when two webviews save conversations concurrently', async () => {
    const database = new TestDatabase();
    const windows = [new RepositoryTransactions(database), new RepositoryTransactions(database)];
    await Promise.all(
      windows.map((view, index) =>
        view.run(async (storage) => {
          const repository = new LocalConversationRepository(storage);
          await repository.save(String(index), [{ role: 'user', content: `Message ${index}` }]);
        }),
      ),
    );
    const reopened = new RepositoryTransactions(database);
    const messages = await Promise.all(
      ['0', '1'].map((id) =>
        reopened.run((storage) => new LocalConversationRepository(storage).list(id)),
      ),
    );
    expect(messages.map((history) => history[0]?.content)).toEqual(['Message 0', 'Message 1']);
  });
  it('re-evaluates approval state after a competing window commits', async () => {
    const database = new TestDatabase();
    const first = new RepositoryTransactions(database);
    const second = new RepositoryTransactions(database);
    const approval: ToolApprovalRequest = {
      id: 'a',
      agentId: 'agent',
      agentName: 'Agent',
      toolId: 'test',
      toolName: 'Test',
      input: {},
      evaluation: { decision: 'ask', reason: 'Ask' },
      status: 'approved',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    await first.run((storage) => new LocalToolApprovalRepository(storage).save(approval));
    const claims = await Promise.all(
      [first, second].map((view) =>
        view.run((storage) =>
          new LocalToolApprovalRepository(storage).compareAndSet('a', 'approved', {
            ...approval,
            status: 'executing',
          }),
        ),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    // A restart cannot claim an invocation already marked executing.
    expect(
      await new RepositoryTransactions(database).run((storage) =>
        new LocalToolApprovalRepository(storage).compareAndSet('a', 'approved', {
          ...approval,
          status: 'executing',
        }),
      ),
    ).toBe(false);
  });
  it('does not expose an uncommitted write after storage failure', async () => {
    const database = new TestDatabase();
    const view = new RepositoryTransactions(database);
    await view.initialize();
    database.fail = true;
    await expect(
      view.run(async (storage) => {
        storage.setItem('iris.memory.records.v1', '[1]');
      }),
    ).rejects.toThrow('Disk full');
    expect(view.initialSnapshot.getItem('iris.memory.records.v1')).toBeNull();
    expect(database.data.values).toEqual({});
  });
});
