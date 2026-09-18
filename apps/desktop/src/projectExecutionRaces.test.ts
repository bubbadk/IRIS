// @vitest-environment jsdom
/**
 * IRIS Phase 2G §10, §15, §26 — the adversarial concurrency matrix.
 *
 * Every scenario runs the real `ProjectQueueDispatcher`, the real `ProjectWorkflowRuntime`, the real
 * repositories and the real transition guards over a fault-injectable durable store. Only the model
 * worker is scripted, so a race is aimed at a real gap rather than at a mock.
 */
import { describe, expect, it } from 'vitest';
import {
  addProjectTask,
  ProjectWorkerBusyError,
  createProjectGraph,
  type ProjectGraph,
  type ProjectQueueEntry,
} from '@iris/workflows';
import { createProjectQueueHarness, scriptedWorker, settle } from './projectQueueHarness';

const now = '2026-09-17T12:00:00.000Z';
let ids = 0;
const createId = () => `run-${(ids += 1)}`;

function graph(taskIds: string[] = ['task']): ProjectGraph {
  let project = createProjectGraph({
    id: 'project',
    title: 'Queue',
    objective: 'Verify queue integrity.',
    createdAt: now,
  });
  for (const id of taskIds)
    project = addProjectTask(project, { id, title: `Task ${id}`, dependencyIds: [], createdAt: now });
  return project;
}

function entry(overrides: Partial<ProjectQueueEntry> = {}): ProjectQueueEntry {
  return {
    version: 1,
    id: 'entry',
    projectId: 'project',
    taskId: 'task',
    agentId: 'agent',
    status: 'queued',
    queuedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('M-13 — atomic worker reservation ahead of asynchronous preparation', () => {
  it('two simultaneous direct launches produce exactly one reservation winner and one worker', async () => {
    ids = 0;
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({
      graph: graph(),
      script,
      createId,
    });

    // Both callers enter together; the reservation is taken before either awaits preparation.
    const results: { ok: boolean; error?: unknown }[] = [];
    const track = (launch: Promise<unknown>) => {
      void launch.then(
        () => results.push({ ok: true }),
        (error: unknown) => results.push({ ok: false, error }),
      );
    };
    track(harness.runtime.launch({ projectId: 'project', taskId: 'task', agentId: 'agent' }));
    track(harness.runtime.launch({ projectId: 'project', taskId: 'task', agentId: 'agent' }));
    await settle();

    // Exactly one caller won the reservation, and only the winner prepared anything.
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(script.prepares).toBe(1);
    expect(harness.leasesHolder('agent')).toBeDefined();

    script.releasePrepare();
    script.release();
    await settle(20);

    const losers = results.filter((result) => !result.ok);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.error).toBeInstanceOf(ProjectWorkerBusyError);
    expect((losers[0]!.error as Error).message).toContain('already executing this agent');
    expect(script.executions).toBe(1);
    expect(await harness.runs.list()).toHaveLength(1);
    expect(script.launchedRunIds).toHaveLength(1);

    // No orphan reservation: the completed run released the agent.
    expect(harness.leasesHolder('agent')).toBeUndefined();
  });

  it('two queued entries for one agent yield exactly one launch and leave the other queued', async () => {
    ids = 0;
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({
      graph: graph(['task', 'other']),
      script,
      createId,
    });
    await harness.enqueue(entry({ id: 'entry-a', taskId: 'task', agentId: 'agent' }));
    await harness.enqueue(entry({ id: 'entry-b', taskId: 'other', agentId: 'agent' }));

    const dispatched = await harness.dispatcher.tick();
    expect(dispatched.map((candidate) => candidate.id)).toEqual(['entry-a']);
    script.releasePrepare();
    script.release();
    await settle();

    const stored = await harness.queue.list();
    expect(stored.find((candidate) => candidate.id === 'entry-a')).toMatchObject({
      status: 'launched',
    });
    expect(stored.find((candidate) => candidate.id === 'entry-b')).toMatchObject({
      status: 'queued',
    });
    expect(await harness.runs.list()).toHaveLength(1);
    expect(script.executions).toBe(1);
  });

  it('releases the reservation when preparation fails before a run exists', async () => {
    ids = 0;
    const script = scriptedWorker();
    script.failPrepare = new Error('The keyring is locked.');
    const harness = await createProjectQueueHarness({
      graph: graph(),
      script,
      createId,
    });
    await harness.enqueue(entry());
    await harness.dispatcher.tick();
    script.releasePrepare();
    await settle();

    expect(await harness.runs.list()).toEqual([]);
    expect(harness.leasesHolder('agent')).toBeUndefined();
  });
});

describe('M-24 — one worker per agent follows the real worker lifecycle', () => {
  it('an actively running launched worker keeps a second queue entry waiting', async () => {
    ids = 0;
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({
      graph: graph(['task', 'other']),
      script,
      createId,
    });
    await harness.enqueue(entry({ id: 'entry-a', taskId: 'task', agentId: 'agent' }));
    await harness.dispatcher.tick();
    script.releasePrepare();
    await settle();

    // The worker is now really running, and its entry is already `launched`.
    const launched = (await harness.queue.list()).find((candidate) => candidate.id === 'entry-a')!;
    expect(launched.status).toBe('launched');
    expect(script.executions).toBe(1);

    await harness.enqueue(entry({ id: 'entry-b', taskId: 'other', agentId: 'agent', queuedAt: now }));
    expect(await harness.dispatcher.tick()).toEqual([]);
    script.release();
    await settle();
    expect(
      (await harness.queue.list()).find((candidate) => candidate.id === 'entry-b')?.status,
    ).toBe('queued');
    expect(await harness.runs.list()).toHaveLength(1);
  });

  it('keeps the agent busy while its run is non-terminal and frees it once terminal', async () => {
    ids = 0;
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({
      graph: graph(['task', 'other']),
      script,
      createId,
    });
    await harness.enqueue(entry({ id: 'entry-a', taskId: 'task', agentId: 'agent' }));
    await harness.dispatcher.tick();
    script.releasePrepare();
    script.release();
    await settle();

    // The worker returned for review. It no longer occupies the *execution* lease, but the run is
    // still non-terminal, so §11 keeps a second worker off this agent.
    const returned = (await harness.runs.list())[0]!;
    expect(returned.status).toBe('awaiting-review');
    expect(harness.leasesHolder('agent')).toBeUndefined();
    await harness.enqueue(entry({ id: 'entry-b', taskId: 'other', agentId: 'agent' }));
    expect(await harness.dispatcher.tick()).toEqual([]);

    // Once the run really ends, the agent is free again and the waiting entry proceeds.
    await harness.runs.save({
      ...returned,
      status: 'failed',
      failedAt: now,
      failure: 'Reviewed and abandoned.',
    });
    expect((await harness.dispatcher.tick()).map((candidate) => candidate.id)).toEqual(['entry-b']);
    script.releasePrepare();
    script.release();
    await settle();
    expect(await harness.runs.list()).toHaveLength(2);
  });
});

describe('M-26 — cancellation always beats a stale dispatch continuation', () => {
  it('a cancellation before launch keeps the entry cancelled and starts nothing', async () => {
    ids = 0;
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({ graph: graph(), script, createId });
    await harness.enqueue(entry());
    await harness.cancel('entry');

    expect(await harness.dispatcher.tick()).toEqual([]);
    const stored = (await harness.queue.list())[0]!;
    expect(stored.status).toBe('cancelled');
    expect(await harness.runs.list()).toEqual([]);
    expect(script.prepares).toBe(0);
    expect(harness.leasesHolder('agent')).toBeUndefined();
  });

  it('a cancellation during preparation is not overwritten when the worker actually starts', async () => {
    ids = 0;
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({ graph: graph(), script, createId });
    await harness.enqueue(entry());
    script.holdPreparation();

    await harness.dispatcher.tick();
    // Dispatch is parked inside preparation, with the entry already claimed.
    expect((await harness.queue.list())[0]?.status).toBe('claimed');
    await harness.cancel('entry');

    script.releasePrepare();
    await settle();

    const stored = (await harness.queue.list())[0]!;
    // The run is real and its identity is recorded, but the cancellation is preserved — never
    // resurrected as claimed, queued or needs-attention.
    expect(stored.status).toBe('cancelled');
    const runs = await harness.runs.list();
    expect(runs).toHaveLength(1);
    expect(stored.runId).toBe(runs[0]!.id);
    expect(stored.message).toContain('already been created');
  });

  it('a stale failure write cannot resurrect a cancelled entry', async () => {
    ids = 0;
    const script = scriptedWorker();
    script.failPrepare = new Error('The model provider is not configured.');
    const harness = await createProjectQueueHarness({ graph: graph(), script, createId });
    await harness.enqueue(entry());
    script.holdPreparation();

    await harness.dispatcher.tick();
    await harness.cancel('entry');
    // The failure handler now tries to write a retryable/failed state over the cancellation.
    script.releasePrepare();
    await settle();

    const stored = (await harness.queue.list())[0]!;
    expect(stored.status).toBe('cancelled');
    expect(stored.failureKind).toBeUndefined();
    expect(await harness.runs.list()).toEqual([]);
    expect(harness.leasesHolder('agent')).toBeUndefined();
  });

  it('cancellation wins over a stale needs-attention write after a failed launch', async () => {
    ids = 0;
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({ graph: graph(), script, createId });
    await harness.enqueue(entry());
    script.holdPreparation();
    await harness.dispatcher.tick();

    // The user cancels, then the in-flight dispatch finishes and writes its outcome.
    await harness.cancel('entry');
    script.failPrepare = new Error('The provider became unavailable.');
    script.releasePrepare();
    await settle();

    const stored = (await harness.queue.list())[0]!;
    expect(stored.status).toBe('cancelled');
    expect(stored.status).not.toBe('needs-attention');
    expect(harness.leasesHolder('agent')).toBeUndefined();
  });
});

describe('§4, §26 — dispatch idempotency around the launch boundary', () => {
  it('never launches a second worker for an entry that already carries a run id', async () => {
    ids = 0;
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({ graph: graph(), script, createId });
    await harness.enqueue(
      entry({ status: 'queued', runId: 'run-existing', updatedAt: now }),
    );

    expect(await harness.dispatcher.tick()).toEqual([]);
    const stored = (await harness.queue.list())[0]!;
    expect(stored).toMatchObject({ status: 'launched', runId: 'run-existing' });
    expect(script.prepares).toBe(0);
    expect(await harness.runs.list()).toEqual([]);
  });

  it('reconciles a real run instead of declaring the launch failed', async () => {
    ids = 0;
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({ graph: graph(), script, createId });
    await harness.enqueue(entry());
    await harness.dispatcher.tick();
    script.releasePrepare();
    script.release();
    await settle();
    const runId = (await harness.runs.list())[0]!.id;

    // Simulate a lost launched write: the entry is back to `claimed` with no run identity.
    const launchedEntry = (await harness.queue.list())[0]!;
    await harness.queue.save({
      ...launchedEntry,
      status: 'claimed',
      runId: undefined,
      updatedAt: now,
      claimedAt: now,
    });
    await harness.dispatcher.reconcile();

    const stored = (await harness.queue.list())[0]!;
    expect(stored).toMatchObject({ status: 'launched', runId });
    expect(script.prepares).toBe(1);
    expect(await harness.runs.list()).toHaveLength(1);
  });

  it('reports needs-attention only when no run exists at all', async () => {
    ids = 0;
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({ graph: graph(), script, createId });
    await harness.enqueue(entry({ status: 'claimed', claimedAt: now, updatedAt: now }));
    await harness.dispatcher.reconcile();

    const stored = (await harness.queue.list())[0]!;
    expect(stored).toMatchObject({ status: 'needs-attention', failureKind: 'unknown' });
    expect(stored.runId).toBeUndefined();
    expect(stored.message).toContain('found no worker run');
  });
});

describe('§26 — cross-runtime exclusivity through the project queue', () => {
  it('a scheduled reservation blocks a project queue dispatch until it is released', async () => {
    ids = 0;
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({ graph: graph(), script, createId });
    await harness.enqueue(entry());

    // Another runtime (the scheduled runtime) owns the agent.
    expect(
      harness.reserveForOtherRuntime('agent', 'agent-runtime:agent'),
    ).toBe(true);

    expect(await harness.dispatcher.tick()).toEqual([]);
    expect((await harness.queue.list())[0]?.status).toBe('queued');
    expect(script.prepares).toBe(0);

    harness.releaseForOtherRuntime('agent', 'agent-runtime:agent');
    expect((await harness.dispatcher.tick()).map((candidate) => candidate.id)).toEqual(['entry']);
    script.releasePrepare();
    script.release();
    await settle();
    expect(await harness.runs.list()).toHaveLength(1);
  });

  it('a direct project launch is denied while another runtime executes the agent', async () => {
    ids = 0;
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({ graph: graph(), script, createId });
    expect(harness.reserveForOtherRuntime('agent', 'agent-runtime:agent')).toBe(true);

    await expect(
      harness.runtime.launch({ projectId: 'project', taskId: 'task', agentId: 'agent' }),
    ).rejects.toBeInstanceOf(ProjectWorkerBusyError);
    expect(script.prepares).toBe(0);
    // The other runtime still owns the agent: a denied launch must not free it.
    expect(harness.leasesHolder('agent')?.ownerId).toBe('agent-runtime:agent');
  });
});
