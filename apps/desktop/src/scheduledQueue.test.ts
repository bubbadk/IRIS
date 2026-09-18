import { describe, expect, it } from 'vitest';
import { SnapshotStorage } from './repositoryStorage';
import { LocalScheduledRunRepository } from './persistence';
import { PersistedDataError } from './persistenceIntegrity';
import { LocalScheduledQueue } from './scheduledQueue';
import type { ScheduledRun } from '@iris/workflows';
const at = '2026-09-09T10:00:00.000Z';
const run: ScheduledRun = {
  version: 1,
  queueVersion: 1,
  id: 'waiting',
  scheduleId: 'schedule',
  agentId: 'agent',
  prompt: 'Do real work',
  status: 'queued',
  scheduledFor: at,
  createdAt: at,
  updatedAt: at,
};
describe('persistent queue storage', () => {
  it('retains older pending jobs when finished history reaches its limit', async () => {
    const completed = Array.from({ length: 500 }, (_, index) => ({
      ...run,
      id: `done-${index}`,
      status: 'completed' as const,
    }));
    const storage = new SnapshotStorage({
      'iris.schedules.runs.v1': JSON.stringify([...completed, run]),
    });
    const repository = new LocalScheduledRunRepository(storage);
    await repository.save({ ...run, id: 'latest', status: 'completed' });
    expect((await repository.get('waiting'))?.status).toBe('queued');
    expect(await repository.list()).toHaveLength(501);
  });
  it('fails closed without overwriting malformed run or pause data', async () => {
    const storage = new SnapshotStorage({
      'iris.schedules.runs.v1': '{broken',
      'iris.schedules.queue-control.v1': '{broken',
    });
    await expect(new LocalScheduledRunRepository(storage).save(run)).rejects.toThrow();
    await expect(new LocalScheduledQueue(storage).isPaused()).rejects.toThrow();
    expect(storage.getItem('iris.schedules.runs.v1')).toBe('{broken');
    expect(storage.getItem('iris.schedules.queue-control.v1')).toBe('{broken');
  });

  it('reports a controlled error and keeps the exact bytes for every malformed document shape', async () => {
    const malformed = [
      '{broken',
      '',
      '{"version":1}',
      JSON.stringify([{ version: 1, id: 'x' }]),
      JSON.stringify([{ ...run, status: 'unknown-status' }, run]),
    ];
    for (const raw of malformed) {
      const storage = new SnapshotStorage({ 'iris.schedules.runs.v1': raw });
      const repository = new LocalScheduledRunRepository(storage);
      const failure = await repository.list().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PersistedDataError);
      expect((failure as Error).message).toContain('iris.schedules.runs.v1');
      expect((failure as Error).message).toContain('scheduled runs');
      await expect(repository.save(run)).rejects.toThrow(PersistedDataError);
      expect(storage.getItem('iris.schedules.runs.v1')).toBe(raw);
    }
  });

  it('rejects a duplicate run id instead of silently collapsing the history', async () => {
    const raw = JSON.stringify([run, { ...run, scheduledFor: '2026-09-09T11:00:00.000Z' }]);
    const storage = new SnapshotStorage({ 'iris.schedules.runs.v1': raw });
    await expect(new LocalScheduledRunRepository(storage).list()).rejects.toThrow(
      'iris.schedules.runs.v1',
    );
    expect(storage.getItem('iris.schedules.runs.v1')).toBe(raw);
  });
});
