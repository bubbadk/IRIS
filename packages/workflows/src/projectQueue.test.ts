import { describe, expect, it } from 'vitest';
import {
  addProjectTask,
  createProjectGraph,
  ProjectQueueDispatcher,
  type ProjectQueueEntry,
} from './index';

const now = '2026-09-09T12:00:00.000Z';
function project() {
  return addProjectTask(
    createProjectGraph({
      id: 'project',
      title: 'Queue',
      objective: 'Verify task queue.',
      createdAt: now,
    }),
    { id: 'task', title: 'Queued task', dependencyIds: [], createdAt: now },
  );
}

describe('project task queue', () => {
  it('claims a ready task before launching it and stores the resulting worker run', async () => {
    const graph = project();
    let entries: ProjectQueueEntry[] = [
      {
        version: 1,
        id: 'entry',
        projectId: graph.id,
        taskId: 'task',
        agentId: 'agent',
        status: 'queued',
        queuedAt: now,
        updatedAt: now,
      },
    ];
    let launchSawClaim = false;
    const dispatcher = new ProjectQueueDispatcher(
      {
        list: async () => [graph],
        get: async () => graph,
        save: async () => {},
        remove: async () => {},
      },
      {
        list: async () => entries.map((entry) => ({ ...entry })),
        get: async (id) => entries.find((entry) => entry.id === id) ?? null,
        enqueue: async (next) => {
          entries = [next, ...entries];
        },
        claim: async (id, claimedAt) => {
          const current = entries.find((entry) => entry.id === id);
          if (!current || current.status !== 'queued') return null;
          const claimed = {
            ...current,
            status: 'claimed' as const,
            claimedAt,
            updatedAt: claimedAt,
            message: undefined,
          };
          entries = [claimed, ...entries.filter((entry) => entry.id !== id)];
          return claimed;
        },
        save: async (next) => {
          entries = [next, ...entries.filter((entry) => entry.id !== next.id)];
        },
      },
      {
        available: async () => true,
        launch: async () => {
          launchSawClaim = entries[0]?.status === 'claimed';
          return {
            version: 1,
            id: 'run',
            projectId: graph.id,
            taskId: 'task',
            agentId: 'agent',
            agentName: 'Agent',
            status: 'awaiting-review',
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            runtimeTurnId: 'turn',
            returnedAt: now,
            output: 'Saved report.',
          };
        },
      },
      () => new Date(now),
    );
    expect((await dispatcher.tick()).map((entry) => entry.status)).toEqual(['claimed']);
    await Promise.resolve();
    await Promise.resolve();
    expect(launchSawClaim).toBe(true);
    expect(entries[0]).toMatchObject({ status: 'launched', runId: 'run' });
  });

  it('waits for dependencies and agents, and never replays a claimed entry after restart', async () => {
    const first = project();
    const graph = addProjectTask(first, {
      id: 'dependent',
      title: 'Dependent',
      dependencyIds: ['task'],
      createdAt: now,
    });
    let entries: ProjectQueueEntry[] = [
      {
        version: 1,
        id: 'wait',
        projectId: graph.id,
        taskId: 'dependent',
        agentId: 'busy',
        status: 'queued',
        queuedAt: now,
        updatedAt: now,
      },
      {
        version: 1,
        id: 'claimed',
        projectId: graph.id,
        taskId: 'task',
        agentId: 'agent',
        status: 'claimed',
        queuedAt: now,
        updatedAt: now,
        claimedAt: now,
      },
    ];
    let launches = 0;
    const dispatcher = new ProjectQueueDispatcher(
      {
        list: async () => [graph],
        get: async () => graph,
        save: async () => {},
        remove: async () => {},
      },
      {
        list: async () => entries,
        get: async (id) => entries.find((entry) => entry.id === id) ?? null,
        enqueue: async (next) => {
          entries = [next, ...entries];
        },
        claim: async (id, claimedAt) => {
          const current = entries.find((entry) => entry.id === id);
          if (!current || current.status !== 'queued') return null;
          const claimed = {
            ...current,
            status: 'claimed' as const,
            claimedAt,
            updatedAt: claimedAt,
            message: undefined,
          };
          entries = [claimed, ...entries.filter((entry) => entry.id !== id)];
          return claimed;
        },
        save: async (next) => {
          entries = [next, ...entries.filter((entry) => entry.id !== next.id)];
        },
      },
      {
        available: async () => false,
        launch: async () => {
          launches++;
          throw new Error('Must not launch');
        },
      },
      () => new Date(now),
    );
    await dispatcher.reconcile();
    expect(entries.find((entry) => entry.id === 'claimed')).toMatchObject({
      status: 'needs-attention',
    });
    expect(await dispatcher.tick()).toEqual([]);
    expect(entries.find((entry) => entry.id === 'wait')?.status).toBe('queued');
    expect(launches).toBe(0);
  });
});
