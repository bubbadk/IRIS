// @vitest-environment jsdom
/**
 * IRIS Phase 2G §1 — H-11 reproduction through the actual production queue dispatch path.
 *
 * These tests document the *before-fix* behaviour of the shipped dispatcher: a launch that really
 * happened can be rewritten as "launch failed", and a run identity that really exists can be lost.
 * They are written so the same scenarios also pin the fixed behaviour once the transition guard
 * lands.
 */
import { describe, expect, it } from 'vitest';
import { addProjectTask, createProjectGraph, type ProjectQueueEntry } from '@iris/workflows';
import {
  createProjectQueueHarness,
  FaultStorage,
  scriptedWorker,
  settle,
} from './projectQueueHarness';

const now = '2026-09-17T12:00:00.000Z';
let ids = 0;
const createId = () => `run-${(ids += 1)}`;

function graph() {
  return addProjectTask(
    createProjectGraph({
      id: 'project',
      title: 'Queue',
      objective: 'Verify queue integrity.',
      createdAt: now,
    }),
    { id: 'task', title: 'Queued task', dependencyIds: [], createdAt: now },
  );
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

describe('H-11 — launch succeeds but queue persistence fails', () => {
  it('keeps the real run identity when the launched write fails but the retry succeeds', async () => {
    ids = 0;
    const storage = new FaultStorage();
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({
      storage,
      graph: graph(),
      script,
      createId,
    });
    await harness.enqueue(entry());

    const dispatched = await harness.dispatcher.tick();
    expect(dispatched.map((candidate) => candidate.status)).toEqual(['claimed']);

    // The `launched` write is rejected; the failure-path write afterwards is accepted.
    storage.failWrites('queue', 1);
    script.release();
    await settle();

    const stored = await harness.queue.list();
    const runs = await harness.runs.list();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;

    // BEFORE FIX this was `{status:'needs-attention', runId: undefined}` — the real run was
    // rewritten as a launch failure.
    expect({ status: stored[0]?.status, runId: stored[0]?.runId }).toEqual({
      status: 'launched',
      runId: run.id,
    });
  });

  it('reconstructs launched state when every queue persistence attempt fails', async () => {
    ids = 0;
    const storage = new FaultStorage();
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({
      storage,
      graph: graph(),
      script,
      createId,
    });
    await harness.enqueue(entry());

    await harness.dispatcher.tick();
    // Both the launch-boundary write and its retry are rejected, and so are the two writes made
    // when the worker returns: nothing durable records the launch yet.
    storage.failWrites('queue', 4);
    script.release();
    await settle();

    // Nothing durable records the launch yet, and the entry must not have been rewritten to a
    // failure: it is still exactly the claim it was.
    const midFlight = (await harness.queue.list())[0]!;
    expect(midFlight.status).toBe('claimed');
    expect(midFlight.runId).toBeUndefined();
    expect(typeof midFlight.claimedAt).toBe('string');

    const runs = await harness.runs.list();
    expect(runs).toHaveLength(1);
    const runId = runs[0]!.id;

    // BEFORE FIX the entry stayed `claimed` forever with no run identity; reconciliation then
    // declared it needs-attention even though the worker really ran.
    await harness.dispatcher.reconcile();
    const stored = await harness.queue.list();
    expect({ status: stored[0]?.status, runId: stored[0]?.runId }).toEqual({
      status: 'launched',
      runId,
    });
    await settle();
    expect(await harness.queue.list()).toEqual(stored);
  });

  it('records launched with the real run when persistence succeeds', async () => {
    ids = 0;
    const storage = new FaultStorage();
    const script = scriptedWorker();
    const harness = await createProjectQueueHarness({
      storage,
      graph: graph(),
      script,
      createId,
    });
    await harness.enqueue(entry());
    await harness.dispatcher.tick();
    script.release();
    await settle();

    const stored = await harness.queue.list();
    const runs = await harness.runs.list();
    expect(stored[0]).toMatchObject({ status: 'launched', runId: runs[0]!.id });
    expect(runs[0]!.status).toBe('awaiting-review');
  });

  it('a provably pre-launch failure is retry-safe and never reported as a launch', async () => {
    ids = 0;
    const storage = new FaultStorage();
    const script = scriptedWorker();
    script.failPrepare = new Error('The model provider is not configured.');
    const harness = await createProjectQueueHarness({
      storage,
      graph: graph(),
      script,
      createId,
    });
    await harness.enqueue(entry());

    await harness.dispatcher.tick();
    await settle();

    expect(await harness.runs.list()).toEqual([]);
    const stored = await harness.queue.list();
    expect(stored[0]).toMatchObject({
      status: 'queued',
      attempts: 1,
      failureKind: 'not-launched',
    });
    expect(stored[0]?.runId).toBeUndefined();
    expect(stored[0]?.claimedAt).toBeUndefined();
    expect(stored[0]?.message).toContain('model provider is not configured');
    expect(stored[0]?.message).toContain('Attempt 1 of 3');
    expect(Date.parse(stored[0]!.retryAt!)).toBeGreaterThan(Date.parse(now));

    // The bounded budget is spent, then the entry stops retrying and becomes visible instead of
    // looping forever. (The backoff is cleared each round so the test does not sleep on a clock.)
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      const current = (await harness.queue.list())[0]!;
      await harness.queue.save({ ...current, retryAt: undefined });
      await harness.dispatcher.tick();
      await settle();
    }
    const exhausted = (await harness.queue.list())[0]!;
    expect(exhausted).toMatchObject({ status: 'needs-attention', failureKind: 'configuration' });
    expect(exhausted.message).toContain('will not retry automatically');
    expect(harness.script.prepares).toBe(3);
  });
});
