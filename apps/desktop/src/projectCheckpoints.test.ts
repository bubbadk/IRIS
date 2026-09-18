import { describe, expect, it } from 'vitest';
import type { AgentCheckpoint } from '@iris/agents';
import type { ProjectTaskRun } from '@iris/workflows';
import { LocalProjectCheckpointRepository, retainCheckpoints } from './projectCheckpoints';
import { PersistedDataError } from './persistenceIntegrity';
import { SnapshotStorage } from './repositoryStorage';

const checkpointKey = 'iris.projects.worker-checkpoints.v1';
const runKey = 'iris.projects.task-runs.v1';
const AT = '2026-09-09T12:00:00.000Z';

function checkpointFor(turnId: string, agentId = 'worker'): AgentCheckpoint {
  return {
    version: 1,
    agentId,
    providerId: 'test',
    model: 'test',
    turnId,
    conversation: [{ role: 'assistant', content: `Report ${turnId}`, turnId }],
    modelHistory: [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `call-${turnId}`, name: 'write', input: { path: 'result.txt' } }],
      },
      { role: 'tool', toolCallId: `call-${turnId}`, content: 'Written.' },
      { role: 'assistant', content: `Report ${turnId}` },
    ],
  };
}

function taskRun(
  id: string,
  status: ProjectTaskRun['status'],
  updatedAt: string,
  extra: Partial<ProjectTaskRun> = {},
): ProjectTaskRun {
  const base: ProjectTaskRun = {
    version: 1,
    id,
    projectId: 'project',
    taskId: 'task',
    agentId: 'worker',
    agentName: 'Worker',
    status,
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  };
  if (status === 'paused')
    return {
      ...base,
      startedAt: updatedAt,
      runtimeTurnId: `turn-${id}`,
      returnedAt: updatedAt,
      pausedAt: updatedAt,
      output: 'Paused report',
      stopReason: 'tool-limit',
      turnsUsed: 1,
      turnLimit: 2,
    };
  return base;
}

const first = checkpointFor('turn');
const second = checkpointFor('turn-2');

describe('project worker checkpoint storage', () => {
  it('round-trips tool results through a new repository and returns defensive copies', async () => {
    const storage = new SnapshotStorage();
    await new LocalProjectCheckpointRepository(storage).save('run', first);
    const reopened = new LocalProjectCheckpointRepository(storage);
    const saved = await reopened.get('run');
    expect(saved).toEqual(first);
    saved!.modelHistory[1]!.content = 'Changed outside storage';
    expect((await reopened.get('run'))?.modelHistory[1]?.content).toBe('Written.');
    await expect(
      reopened.save('run', { ...first, modelHistory: first.modelHistory.slice(0, 1) }),
    ).rejects.toThrow('unsafe');
    expect(await reopened.get('run')).toEqual(first);
  });

  it('preserves corrupt storage and refuses to overwrite it with a new checkpoint', async () => {
    const storage = new SnapshotStorage({ [checkpointKey]: '{"run":{"version":99}}' });
    const repository = new LocalProjectCheckpointRepository(storage);
    await expect(repository.save('next', first)).rejects.toThrow('retained');
    expect(storage.getItem(checkpointKey)).toBe('{"run":{"version":99}}');
  });

  it('fails closed on malformed JSON and keeps the original bytes', async () => {
    const storage = new SnapshotStorage({ [checkpointKey]: '{broken' });
    const repository = new LocalProjectCheckpointRepository(storage);
    await expect(repository.get('run')).rejects.toThrow(PersistedDataError);
    await expect(repository.save('run', first)).rejects.toThrow(PersistedDataError);
    expect(storage.getItem(checkpointKey)).toBe('{broken');
  });

  it('rejects an array root where a keyed object document is required', async () => {
    const stored = JSON.stringify([first]);
    const storage = new SnapshotStorage({ [checkpointKey]: stored });
    const repository = new LocalProjectCheckpointRepository(storage);
    const failure = await repository.get('run').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PersistedDataError);
    expect((failure as Error).message).toContain('a JSON object document was required');
    await expect(repository.save('run', first)).rejects.toThrow(PersistedDataError);
    expect(storage.getItem(checkpointKey)).toBe(stored);
  });

  it('fails closed when one stored checkpoint is unusable', async () => {
    const stored = JSON.stringify({ good: first, bad: { version: 99 } });
    const storage = new SnapshotStorage({ [checkpointKey]: stored });
    const repository = new LocalProjectCheckpointRepository(storage);
    await expect(repository.get('good')).rejects.toThrow('project worker checkpoints');
    expect(storage.getItem(checkpointKey)).toBe(stored);
  });

  it('prunes checkpoints whose run no longer exists so they can never be requested again', async () => {
    const storage = new SnapshotStorage({
      [checkpointKey]: JSON.stringify({ 'run-gone': checkpointFor('gone'), 'run-live': first }),
      [runKey]: JSON.stringify([taskRun('run-live', 'paused', AT)]),
    });
    await new LocalProjectCheckpointRepository(storage).save('run-live', first);
    const repository = new LocalProjectCheckpointRepository(storage);
    expect(await repository.get('run-gone')).toBeNull();
    expect(await repository.get('run-live')).toEqual(first);
  });

  it('keeps one project from wiping another project recoverable checkpoints', async () => {
    const otherProjectRun = taskRun('run-other', 'paused', AT, {
      projectId: 'project-2',
      taskId: 'task-2',
    });
    const other = checkpointFor('other');
    const storage = new SnapshotStorage({
      [checkpointKey]: JSON.stringify({
        'run-other': other,
        'run-orphan': checkpointFor('orphan'),
      }),
      [runKey]: JSON.stringify([otherProjectRun]),
    });
    await new LocalProjectCheckpointRepository(storage).save('run-other', other);
    const repository = new LocalProjectCheckpointRepository(storage);
    expect(await repository.get('run-other')).toEqual(other);
    expect(await repository.get('run-orphan')).toBeNull();
  });

  it('never prunes a checkpoint for a non-terminal run even far beyond the safety cap', () => {
    const runs = Array.from({ length: 260 }, (_, index) =>
      taskRun(`run-${index}`, 'paused', new Date(Date.UTC(2026, 8, 9, 12, 0, index)).toISOString()),
    );
    const records: Record<string, AgentCheckpoint> = {};
    for (const run of runs) records[run.id] = checkpointFor(run.id);
    const retained = retainCheckpoints({ records, runs, hasRunDocument: true, limit: 200 });
    expect(Object.keys(retained)).toHaveLength(260);
  });

  it('applies the safety cap only to finally closed runs, oldest first, deterministically', () => {
    const runs = [
      ...Array.from({ length: 210 }, (_, index) =>
        taskRun(
          `done-${index}`,
          'completed',
          new Date(Date.UTC(2026, 8, 9, 12, 0, index)).toISOString(),
        ),
      ),
      taskRun('live', 'running', AT),
    ];
    const records: Record<string, AgentCheckpoint> = {};
    for (const run of runs) records[run.id] = checkpointFor(run.id);
    const build = () => retainCheckpoints({ records, runs, hasRunDocument: true, limit: 200 });
    const firstPass = build();
    const secondPass = build();
    expect(Object.keys(firstPass)).toEqual(Object.keys(secondPass));
    // The live run and the newest 199 finished runs are retained; the oldest 11 are pruned.
    expect(Object.keys(firstPass)).toHaveLength(200);
    expect(firstPass.live).toBeDefined();
    expect(firstPass['done-209']).toBeDefined();
    expect(firstPass['done-0']).toBeUndefined();
    expect(firstPass['done-10']).toBeUndefined();
    expect(firstPass['done-11']).toBeDefined();
  });

  it('does not treat checkpoints as orphans when the task-run document was never written', () => {
    const retained = retainCheckpoints({
      records: { 'run-unknown': first },
      runs: [],
      hasRunDocument: false,
      limit: 200,
    });
    expect(Object.keys(retained)).toEqual(['run-unknown']);
  });

  it('keeps the newest checkpoint for a run after a reload', async () => {
    const storage = new SnapshotStorage({
      [runKey]: JSON.stringify([taskRun('run', 'paused', AT)]),
    });
    const repository = new LocalProjectCheckpointRepository(storage);
    await repository.save('run', first);
    await repository.save('run', second);
    const reloaded = new SnapshotStorage({ [checkpointKey]: storage.getItem(checkpointKey)! });
    expect(await new LocalProjectCheckpointRepository(reloaded).get('run')).toEqual(second);
  });

  it('supports the normal save then recover flow used by a paused worker', async () => {
    const storage = new SnapshotStorage({
      [runKey]: JSON.stringify([taskRun('run', 'running', AT)]),
    });
    const repository = new LocalProjectCheckpointRepository(storage);
    await repository.save('run', first);
    const recovered = await repository.get('run');
    expect(recovered).toEqual(first);
    expect(recovered?.turnId).toBe('turn');
  });
});
