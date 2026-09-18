import { describe, expect, it } from 'vitest';
import type { ProjectQueueEntry, ProjectTaskRun } from '@iris/workflows';
import {
  LocalProjectQueueRepository,
  LocalProjectTaskRunRepository,
} from './persistence';
import { SnapshotStorage } from './repositoryStorage';

const queueKey = 'iris.projects.queue.v1';
const runKey = 'iris.projects.task-runs.v1';

function at(sequence: number): string {
  return new Date(Date.UTC(2026, 8, 9, 12, 0, sequence)).toISOString();
}

function queueEntry(
  index: number,
  status: ProjectQueueEntry['status'],
  projectId = 'project',
): ProjectQueueEntry {
  return {
    version: 1,
    id: `entry-${index}`,
    projectId,
    taskId: `task-${index}`,
    agentId: `agent-${index}`,
    status,
    queuedAt: at(index),
    updatedAt: at(index),
  };
}

function taskRun(
  index: number,
  status: ProjectTaskRun['status'],
  extra: Partial<ProjectTaskRun> = {},
): ProjectTaskRun {
  const base: ProjectTaskRun = {
    version: 1,
    id: `run-${index}`,
    projectId: 'project',
    taskId: 'task',
    agentId: 'agent',
    agentName: 'Worker',
    status,
    createdAt: at(index),
    updatedAt: at(index),
  };
  if (status === 'paused')
    return {
      ...base,
      startedAt: at(index),
      runtimeTurnId: `turn-${index}`,
      returnedAt: at(index),
      pausedAt: at(index),
      output: 'Paused report',
      stopReason: 'tool-limit',
      turnsUsed: 1,
      turnLimit: 2,
      ...extra,
    };
  if (status === 'awaiting-review')
    return {
      ...base,
      startedAt: at(index),
      runtimeTurnId: `turn-${index}`,
      returnedAt: at(index),
      output: 'Report',
      ...extra,
    };
  if (status === 'needs-attention')
    return {
      ...base,
      startedAt: at(index),
      runtimeTurnId: `turn-${index}`,
      returnedAt: at(index),
      output: 'Report',
      stopReason: 'tool-limit',
      ...extra,
    };
  if (status === 'suspended')
    return {
      ...base,
      startedAt: at(index),
      runtimeTurnId: `turn-${index}`,
      suspendedAt: at(index),
      approval: { id: `approval-${index}`, toolId: 'tool', toolName: 'Tool', reason: 'Ask.' },
      ...extra,
    };
  if (status === 'completed')
    return {
      ...base,
      startedAt: at(index),
      runtimeTurnId: `turn-${index}`,
      completedAt: at(index),
      ...extra,
    };
  if (status === 'failed')
    return { ...base, failedAt: at(index), failure: 'Stopped.', ...extra };
  if (status === 'cancelled') return { ...base, cancelledAt: at(index), ...extra };
  return { ...base, ...extra };
}

describe('H-08 project queue retention through durable storage', () => {
  it('does not prune anything while the queue is under its limit', async () => {
    const storage = new SnapshotStorage({
      [queueKey]: JSON.stringify([queueEntry(1, 'cancelled'), queueEntry(2, 'queued')]),
    });
    const repository = new LocalProjectQueueRepository(storage);
    await repository.save(queueEntry(3, 'claimed'));
    const ids = (await repository.list()).map((entry) => entry.id).sort();
    expect(ids).toEqual(['entry-1', 'entry-2', 'entry-3']);
  });

  it('prunes only terminal history when the queue is over its limit', async () => {
    const committed = Array.from({ length: 260 }, (_, index) => queueEntry(index, 'cancelled'));
    const storage = new SnapshotStorage({ [queueKey]: JSON.stringify(committed) });
    const repository = new LocalProjectQueueRepository(storage);
    await repository.save(queueEntry(999, 'queued'));
    const listed = await repository.list();
    // The cap is 250; the live entry plus the newest 249 terminal entries remain.
    expect(listed).toHaveLength(250);
    expect(listed.filter((entry) => entry.status !== 'cancelled')).toHaveLength(1);
    expect(listed.some((entry) => entry.id === 'entry-0')).toBe(false);
    expect(listed.some((entry) => entry.id === 'entry-259')).toBe(true);
  });

  it('never removes a queued entry when the cap is enforced', async () => {
    const committed = Array.from({ length: 260 }, (_, index) =>
      index === 0 ? queueEntry(index, 'queued') : queueEntry(index, 'cancelled'),
    );
    const storage = new SnapshotStorage({ [queueKey]: JSON.stringify(committed) });
    const repository = new LocalProjectQueueRepository(storage);
    await repository.save(queueEntry(999, 'cancelled'));
    const listed = await repository.list();
    expect(listed.some((entry) => entry.id === 'entry-0')).toBe(true);
    expect(listed.some((entry) => entry.status === 'queued')).toBe(true);
  });

  it('never removes claimed or launched entries when the cap is enforced', async () => {
    const committed = Array.from({ length: 260 }, (_, index) => {
      if (index === 0) return queueEntry(index, 'claimed');
      if (index === 1) return queueEntry(index, 'launched');
      if (index === 2) return queueEntry(index, 'needs-attention');
      return queueEntry(index, 'cancelled');
    });
    const storage = new SnapshotStorage({ [queueKey]: JSON.stringify(committed) });
    const repository = new LocalProjectQueueRepository(storage);
    await repository.save(queueEntry(999, 'cancelled'));
    const listed = await repository.list();
    for (const id of ['entry-0', 'entry-1', 'entry-2'])
      expect(listed.some((entry) => entry.id === id)).toBe(true);
  });

  it('keeps every live entry and exceeds the cap when live work alone overflows', async () => {
    const committed = Array.from({ length: 260 }, (_, index) =>
      queueEntry(index, index % 2 === 0 ? 'queued' : 'claimed'),
    );
    const storage = new SnapshotStorage({ [queueKey]: JSON.stringify(committed) });
    const repository = new LocalProjectQueueRepository(storage);
    await repository.save(queueEntry(999, 'launched'));
    const listed = await repository.list();
    expect(listed).toHaveLength(261);
    expect(listed.filter((entry) => entry.status !== 'cancelled')).toHaveLength(261);
  });

  it('is deterministic across repeated saves', async () => {
    const build = () =>
      new SnapshotStorage({
        [queueKey]: JSON.stringify(
          Array.from({ length: 260 }, (_, index) =>
            index === 7 ? queueEntry(index, 'queued') : queueEntry(index, 'cancelled'),
          ),
        ),
      });
    const first = new LocalProjectQueueRepository(build());
    await first.save(queueEntry(999, 'cancelled'));
    const second = new LocalProjectQueueRepository(build());
    await second.save(queueEntry(999, 'cancelled'));
    expect(await first.list()).toEqual(await second.list());
  });

  it('keeps the same live entries after a save and reload', async () => {
    const committed = Array.from({ length: 260 }, (_, index) =>
      index === 0 || index === 5 ? queueEntry(index, 'claimed') : queueEntry(index, 'cancelled'),
    );
    const storage = new SnapshotStorage({ [queueKey]: JSON.stringify(committed) });
    await new LocalProjectQueueRepository(storage).save(queueEntry(999, 'queued'));
    const persisted = storage.getItem(queueKey);
    // A brand new storage view (simulating the next launch) must observe the same live entries.
    const reloaded = new SnapshotStorage({ [queueKey]: persisted! });
    const listed = await new LocalProjectQueueRepository(reloaded).list();
    const live = listed.filter((entry) => entry.status !== 'cancelled').map((entry) => entry.id);
    expect(live.sort()).toEqual(['entry-0', 'entry-5', 'entry-999']);
  });
});

describe('M-01 project task run retention through durable storage', () => {
  it('does not prune anything while the run history is under its limit', async () => {
    const storage = new SnapshotStorage({
      [runKey]: JSON.stringify([taskRun(1, 'completed'), taskRun(2, 'running')]),
    });
    const repository = new LocalProjectTaskRunRepository(storage);
    await repository.save(taskRun(3, 'completed'));
    expect((await repository.list()).map((run) => run.id).sort()).toEqual([
      'run-1',
      'run-2',
      'run-3',
    ]);
  });

  it('prunes only terminal history over the limit, oldest first', async () => {
    const committed = Array.from({ length: 60 }, (_, index) => taskRun(index, 'completed'));
    const storage = new SnapshotStorage({ [runKey]: JSON.stringify(committed) });
    const repository = new LocalProjectTaskRunRepository(storage);
    await repository.save(taskRun(999, 'completed'));
    const listed = await repository.list();
    expect(listed).toHaveLength(50);
    // Eleven oldest terminal runs are removed; the newest terminal history survives.
    expect(listed.some((run) => run.id === 'run-0')).toBe(false);
    expect(listed.some((run) => run.id === 'run-10')).toBe(false);
    expect(listed.some((run) => run.id === 'run-11')).toBe(true);
    expect(listed.some((run) => run.id === 'run-59')).toBe(true);
    expect(listed.some((run) => run.id === 'run-999')).toBe(true);
  });

  it('never prunes a paused or awaiting-review run, including its model output', async () => {
    const committed = Array.from({ length: 60 }, (_, index) => {
      if (index === 0) return taskRun(index, 'paused', { output: 'Paused model output' });
      if (index === 1) return taskRun(index, 'awaiting-review', { output: 'Awaiting model output' });
      return taskRun(index, 'completed');
    });
    const storage = new SnapshotStorage({ [runKey]: JSON.stringify(committed) });
    const repository = new LocalProjectTaskRunRepository(storage);
    await repository.save(taskRun(999, 'completed'));
    const listed = await repository.list();
    expect(listed.find((run) => run.id === 'run-0')?.output).toBe('Paused model output');
    expect(listed.find((run) => run.id === 'run-1')?.output).toBe('Awaiting model output');
  });

  it('never prunes a suspended or needs-attention run that still needs the user', async () => {
    const committed = Array.from({ length: 60 }, (_, index) => {
      if (index === 0) return taskRun(index, 'suspended');
      if (index === 1) return taskRun(index, 'needs-attention');
      if (index === 2) return taskRun(index, 'running', { output: 'Live output' });
      return taskRun(index, 'failed', { failedAt: at(index), failure: 'Stopped.' });
    });
    const storage = new SnapshotStorage({ [runKey]: JSON.stringify(committed) });
    const repository = new LocalProjectTaskRunRepository(storage);
    await repository.save(taskRun(999, 'completed'));
    const listed = await repository.list();
    for (const id of ['run-0', 'run-1', 'run-2'])
      expect(listed.some((run) => run.id === id)).toBe(true);
    expect(listed.find((run) => run.id === 'run-2')?.output).toBe('Live output');
  });

  it('keeps every active run and intentionally exceeds the cap when active work overflows', async () => {
    const committed = Array.from({ length: 60 }, (_, index) => taskRun(index, 'running'));
    const storage = new SnapshotStorage({ [runKey]: JSON.stringify(committed) });
    const repository = new LocalProjectTaskRunRepository(storage);
    await repository.save(taskRun(999, 'queued'));
    const listed = await repository.list();
    expect(listed).toHaveLength(61);
    expect(listed.every((run) => run.status === 'running' || run.status === 'queued')).toBe(true);
  });

  it('bounds each project task independently', async () => {
    const committed = [
      ...Array.from({ length: 60 }, (_, index) =>
        taskRun(index, 'completed', { projectId: 'project-1', taskId: 'task-1' }),
      ),
      ...Array.from({ length: 60 }, (_, index) =>
        taskRun(100 + index, 'completed', { projectId: 'project-2', taskId: 'task-2' }),
      ),
    ];
    const storage = new SnapshotStorage({ [runKey]: JSON.stringify(committed) });
    const repository = new LocalProjectTaskRunRepository(storage);
    await repository.save(
      taskRun(999, 'completed', { projectId: 'project-1', taskId: 'task-1' }),
    );
    const listed = await repository.list();
    expect(listed.filter((run) => run.projectId === 'project-1')).toHaveLength(50);
    // Bounding project-1 must not reach into project-2 beyond project-2's own cap: its newest
    // history is untouched and it never loses runs because another task overflowed.
    const second = listed.filter((run) => run.projectId === 'project-2');
    expect(second).toHaveLength(50);
    expect(second.some((run) => run.id === 'run-159')).toBe(true);
    expect(second.some((run) => run.id === 'run-100')).toBe(false);
  });

  it('is deterministic across repeated saves', async () => {
    const build = () =>
      new SnapshotStorage({
        [runKey]: JSON.stringify(
          Array.from({ length: 60 }, (_, index) =>
            index === 3
              ? taskRun(index, 'needs-attention')
              : taskRun(index, 'cancelled', { cancelledAt: at(index) }),
          ),
        ),
      });
    const first = new LocalProjectTaskRunRepository(build());
    await first.save(taskRun(999, 'failed', { failedAt: at(999), failure: 'Stopped.' }));
    const second = new LocalProjectTaskRunRepository(build());
    await second.save(taskRun(999, 'failed', { failedAt: at(999), failure: 'Stopped.' }));
    expect(await first.list()).toEqual(await second.list());
  });

  it('keeps the same active runs after a save and reload', async () => {
    const committed = Array.from({ length: 60 }, (_, index) =>
      index === 0 || index === 2 ? taskRun(index, 'paused') : taskRun(index, 'completed'),
    );
    const storage = new SnapshotStorage({ [runKey]: JSON.stringify(committed) });
    await new LocalProjectTaskRunRepository(storage).save(taskRun(999, 'queued'));
    const reloaded = new SnapshotStorage({ [runKey]: storage.getItem(runKey)! });
    const listed = await new LocalProjectTaskRunRepository(reloaded).list();
    const active = listed
      .filter((run) => run.status !== 'completed')
      .map((run) => run.id)
      .sort();
    expect(active).toEqual(['run-0', 'run-2', 'run-999']);
  });
});
