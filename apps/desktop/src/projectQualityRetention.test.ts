import { describe, expect, it } from 'vitest';
import type {
  ProjectQualityRejection,
  ProjectQualityReview,
  ProjectTaskRun,
} from '@iris/workflows';
import {
  LocalProjectGraphRepository,
  LocalProjectQueueRepository,
  LocalProjectTaskRunRepository,
} from './persistence';
import { SnapshotStorage } from './repositoryStorage';

/**
 * IRIS Phase 2G §19–§20 — quality history is bounded *in durable storage*, and a permitted prune can
 * never remove a record that still carries current truth.
 */

const runKey = 'iris.projects.task-runs.v1';
const graphKey = 'iris.projects.graphs.v1';
const queueKey = 'iris.projects.queue.v1';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 17, 12, minutes, 0)).toISOString();

function review(id: string, minutes: number, findingIds: string[] = []): ProjectQualityReview {
  return {
    id,
    method: 'human-review',
    reviewedAt: at(minutes),
    projectId: 'project',
    taskId: 'task',
    runId: 'run',
    criteriaVersion: '',
    taskVersion: 'task-version',
    resultVersion: 'result-version',
    assessments: [],
    findings: findingIds.map((findingId) => ({
      id: findingId,
      blocking: true,
      reason: 'Incomplete.',
      repair: 'Finish it.',
    })),
    resolutions: [],
  };
}

function rejection(id: string, minutes: number): ProjectQualityRejection {
  return { id, at: at(minutes), reason: 'Rejected.', resultVersion: 'result-version' };
}

function taskRun(overrides: Partial<ProjectTaskRun> = {}): ProjectTaskRun {
  return {
    version: 1,
    id: 'run',
    projectId: 'project',
    taskId: 'task',
    agentId: 'agent',
    agentName: 'Worker',
    status: 'awaiting-review',
    createdAt: at(0),
    updatedAt: at(0),
    startedAt: at(0),
    runtimeTurnId: 'turn',
    returnedAt: at(0),
    output: 'Report.',
    ...overrides,
  };
}

async function seed(run: ProjectTaskRun): Promise<SnapshotStorage> {
  const storage = new SnapshotStorage();
  await new LocalProjectTaskRunRepository(storage).save(run);
  return storage;
}

describe('M-21 project quality history retention through durable storage', () => {
  it('bounds a growing review history while keeping the newest review', async () => {
    const storage = await seed(taskRun({ qualityReviews: [review('first', 1)], qualityRejections: [] }));

    // Appending many resolved reviews through repeated saves must not grow without bound.
    for (let index = 2; index <= 80; index += 1) {
      const stored = await new LocalProjectTaskRunRepository(storage).get('run');
      await new LocalProjectTaskRunRepository(storage).save({
        ...stored!,
        qualityReviews: [...(stored!.qualityReviews ?? []), review(`review-${index}`, index)],
      });
    }
    const final = await new LocalProjectTaskRunRepository(storage).get('run');
    expect(final!.qualityReviews!.length).toBeLessThanOrEqual(41);
    expect(final!.qualityReviews!.at(-1)!.id).toBe('review-80');
  });

  it('bounds a growing rejection history while keeping the newest rejection', async () => {
    const storage = await seed(taskRun({ qualityReviews: [], qualityRejections: [] }));
    for (let index = 1; index <= 80; index += 1) {
      const stored = await new LocalProjectTaskRunRepository(storage).get('run');
      await new LocalProjectTaskRunRepository(storage).save({
        ...stored!,
        qualityRejections: [...(stored!.qualityRejections ?? []), rejection(`j-${index}`, index)],
      });
    }
    const final = await new LocalProjectTaskRunRepository(storage).get('run');
    expect(final!.qualityRejections!.length).toBeLessThanOrEqual(41);
    expect(final!.qualityRejections!.at(-1)!.id).toBe('j-80');
  });

  it('refuses a write that would drop a review holding an open blocking finding', async () => {
    const storage = await seed(taskRun({ qualityReviews: [] }));
    const repository = new LocalProjectTaskRunRepository(storage);
    await repository.save(
      taskRun({
        qualityReviews: [review('open', 1, ['still-open']), review('later', 2)],
      }),
    );

    // A caller that tries to persist a run without the protected review must be rejected, not
    // silently allowed to erase evidence of unfinished work.
    const stored = (await repository.get('run'))!;
    await expect(
      repository.save({ ...stored, qualityReviews: [stored.qualityReviews![1]!] }),
    ).rejects.toThrow();
    expect((await repository.get('run'))!.qualityReviews!.map((item) => item.id)).toContain('open');
  });

  it('refuses a write that would drop a review carrying recorded resolutions', async () => {
    const storage = await seed(taskRun({ qualityReviews: [] }));
    const repository = new LocalProjectTaskRunRepository(storage);
    const resolved: ProjectQualityReview = {
      ...review('resolved', 1, ['f']),
      resolutions: [{ findingId: 'f', note: 'Addressed.' }],
    };
    await repository.save(taskRun({ qualityReviews: [resolved, review('newest', 2)] }));
    const stored = (await repository.get('run'))!;
    await expect(
      repository.save({ ...stored, qualityReviews: [stored.qualityReviews![1]!] }),
    ).rejects.toThrow();
    expect((await repository.get('run'))!.qualityReviews!.map((item) => item.id)).toEqual([
      'resolved',
      'newest',
    ]);
  });

  it('survives a storage round-trip without changing the retained history', async () => {
    const storage = await seed(taskRun({ qualityReviews: [] }));
    const repository = new LocalProjectTaskRunRepository(storage);
    const history = Array.from({ length: 60 }, (_, index) => review(`review-${index}`, index + 1));
    await repository.save(taskRun({ qualityReviews: history }));
    const first = await repository.get('run');
    const second = await new LocalProjectTaskRunRepository(storage).get('run');
    expect(second!.qualityReviews).toEqual(first!.qualityReviews);

    // Re-saving the already-retained history is a no-op, not another prune.
    await repository.save(second!);
    expect((await repository.get('run'))!.qualityReviews).toEqual(first!.qualityReviews);
  });
});

describe('M-13, M-26 durable transition guard through storage', () => {
  it('applies a guarded write only while the entry is unchanged', async () => {
    const storage = new SnapshotStorage();
    const queue = new LocalProjectQueueRepository(storage);
    await queue.enqueue({
      version: 1,
      id: 'entry',
      projectId: 'project',
      taskId: 'task',
      agentId: 'agent',
      status: 'claimed',
      queuedAt: at(0),
      updatedAt: at(0),
      claimedAt: at(1),
    });

    const claimed = (await queue.get('entry'))!;
    expect(
      await queue.saveIfUnchanged(
        {
          ...claimed,
          status: 'launched',
          runId: 'run-1',
          updatedAt: at(2),
          failureKind: 'launched',
        },
        { status: 'claimed', updatedAt: at(0) },
      ),
    ).toBe(true);
    expect((await queue.get('entry'))!.status).toBe('launched');

    // Replaying the same guarded write now loses: the entry is no longer the claimed version.
    const launched = (await queue.get('entry'))!;
    expect(
      await queue.saveIfUnchanged(
        { ...launched, status: 'needs-attention', message: 'stale', updatedAt: at(3) },
        { status: 'claimed', updatedAt: at(0) },
      ),
    ).toBe(false);
    const stored = (await queue.get('entry'))!;
    expect(stored.status).toBe('launched');
    expect(stored.runId).toBe('run-1');
  });

  it('refuses a guarded write when a cancellation already replaced the claimed entry', async () => {
    const storage = new SnapshotStorage();
    const queue = new LocalProjectQueueRepository(storage);
    await queue.enqueue({
      version: 1,
      id: 'entry',
      projectId: 'project',
      taskId: 'task',
      agentId: 'agent',
      status: 'claimed',
      queuedAt: at(0),
      updatedAt: at(0),
      claimedAt: at(1),
    });
    await queue.save({
      ...(await queue.get('entry'))!,
      status: 'cancelled',
      updatedAt: at(5),
      message: 'Removed by the user.',
    });

    const claimedEntry = {
      ...(await queue.get('entry'))!,
      status: 'claimed' as const,
      updatedAt: at(0),
      claimedAt: at(1),
    };
    const applied = await queue.saveIfUnchanged(
      { ...claimedEntry, status: 'needs-attention', message: 'The worker could not start.' },
      { status: 'claimed', updatedAt: at(0) },
    );
    expect(applied).toBe(false);
    const stored = (await queue.get('entry'))!;
    expect(stored.status).toBe('cancelled');
    expect(stored.message).toBe('Removed by the user.');
  });
});

describe('M-21 retained history does not corrupt the rest of the store', () => {
  it('leaves other project data untouched while pruning quality history', async () => {
    const storage = new SnapshotStorage();
    await new LocalProjectGraphRepository(storage).save({
      version: 1,
      id: 'project',
      title: 'Export',
      objective: 'Ship.',
      createdAt: at(0),
      updatedAt: at(0),
      tasks: [{ id: 'task', title: 'Task', dependencyIds: [], createdAt: at(0) }],
    });
    await new LocalProjectQueueRepository(storage).enqueue({
      version: 1,
      id: 'entry',
      projectId: 'project',
      taskId: 'task',
      agentId: 'agent',
      status: 'queued',
      queuedAt: at(0),
      updatedAt: at(0),
    });
    const repository = new LocalProjectTaskRunRepository(storage);
    await repository.save(
      taskRun({
        qualityReviews: Array.from({ length: 60 }, (_, index) => review(`r-${index}`, index + 1)),
      }),
    );
    expect(storage.getItem(graphKey)).not.toBeNull();
    expect(storage.getItem(queueKey)).not.toBeNull();
    expect((await new LocalProjectGraphRepository(storage).get('project'))!.title).toBe('Export');
    expect((await new LocalProjectQueueRepository(storage).get('entry'))!.status).toBe('queued');
    expect(storage.getItem(runKey)).not.toBeNull();
  });
});
