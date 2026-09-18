import { describe, expect, it } from 'vitest';
import {
  addProjectTask,
  cloneProjectTaskRun,
  createProjectGraph,
  projectResultVersion,
  projectTaskVersion,
  recordProjectQualityReview,
  resumeProjectRun,
  validateProjectRunReservation,
  verifyProjectRun,
  type ProjectGraph,
  type ProjectTaskRun,
} from './index';

/**
 * IRIS Phase 2G §21–§22 — a timestamp alone is not a total order.
 *
 * Two runs created in the same millisecond used to each look "not older" than the other, so both
 * could be rejected as "a newer run exists". These tests drive every production guard that compares
 * runs, with runs that share one `createdAt`, and require exactly one survivor.
 */

const at = '2026-09-17T12:00:00.000Z';
const later = '2026-09-17T12:30:00.000Z';

function project(): ProjectGraph {
  return addProjectTask(
    createProjectGraph({ id: 'p', title: 'Project', objective: 'Ship.', createdAt: at }),
    { id: 't', title: 'Task', dependencyIds: [], createdAt: at },
  );
}

function run(id: string, overrides: Partial<ProjectTaskRun> = {}): ProjectTaskRun {
  return {
    version: 1,
    id,
    projectId: 'p',
    taskId: 't',
    agentId: 'a',
    agentName: 'Worker',
    status: 'awaiting-review',
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    returnedAt: at,
    runtimeTurnId: `turn-${id}`,
    output: `Report ${id}.`,
    ...overrides,
  };
}

/** Runs the guard for both runs of a same-timestamp pair and reports which ones are refused. */
function refused(
  runs: ProjectTaskRun[],
  guard: (candidate: ProjectTaskRun) => void,
): string[] {
  return runs
    .filter((candidate) => {
      try {
        guard(candidate);
        return false;
      } catch {
        return true;
      }
    })
    .map((candidate) => candidate.id)
    .sort();
}

describe('M-22 — same-millisecond runs never reject each other', () => {
  it('verification accepts exactly one of two runs with the same createdAt', () => {
    const [a, b] = [run('run-a'), run('run-b')];
    const rejected = refused([a, b], (candidate) =>
      verifyProjectRun(project(), candidate, [a, b], 'Checked.', later),
    );
    expect(rejected).toHaveLength(1);
    // The order is by `(createdAt, id)`: `run-b` is the newest, so only it may be verified.
    expect(rejected).toEqual(['run-a']);
  });

  it('quality review accepts exactly one of three runs with the same createdAt', () => {
    const runs = [run('run-a'), run('run-b'), run('run-c')];
    const current = project();
    const task = current.tasks[0]!;
    const reviewInput = (target: ProjectTaskRun) => ({
      expectedRun: cloneProjectTaskRun(target),
      expectedTask: projectTaskVersion(task),
      review: {
        id: `review-${target.id}`,
        method: 'human-review' as const,
        reviewedAt: later,
        projectId: 'p',
        taskId: 't',
        runId: target.id,
        criteriaVersion: '',
        taskVersion: projectTaskVersion(task),
        resultVersion: projectResultVersion(target),
        assessments: [],
        findings: [],
        resolutions: [],
      },
    });
    const rejected = refused(runs, (candidate) =>
      recordProjectQualityReview(current, candidate, runs, reviewInput(candidate)),
    );
    expect(rejected).toEqual(['run-a', 'run-b']);
  });

  it('resuming a paused run refuses exactly one of a same-timestamp pair', () => {
    const source = run('run-source', {
      status: 'paused',
      pausedAt: at,
      turnsUsed: 1,
      turnLimit: 3,
      output: 'Half done.',
    });
    const other = run('run-other');
    const rejected = refused([source, other], (candidate) =>
      resumeProjectRun(project(), candidate, [source, other], later),
    );
    // `run-source` sorts newer than `run-other`, so only the older run is refused.
    expect(rejected).toEqual(['run-other']);
  });

  it('reserves a queued run whose own record is already in the list', () => {
    const previous = run('run-previous', { status: 'failed', failedAt: at, failure: 'Stopped.' });
    const candidate = run('run-a', {
      status: 'queued',
      startedAt: undefined,
      returnedAt: undefined,
    });
    const sameTimestamp = run('run-b');
    expect(() =>
      validateProjectRunReservation(project(), candidate, [previous, candidate, sameTimestamp]),
    ).not.toThrow();
    expect(() =>
      validateProjectRunReservation(project(), candidate, [previous, sameTimestamp]),
    ).not.toThrow();
  });

  it('still blocks a reservation when another run really is active', () => {
    const candidate = run('run-a', {
      status: 'queued',
      startedAt: undefined,
      returnedAt: undefined,
    });
    const active = run('run-b', { status: 'running', startedAt: at });
    expect(() =>
      validateProjectRunReservation(project(), candidate, [candidate, active]),
    ).toThrow('already has an active worker run');
    // A different agent on a different task is genuinely unrelated and must not block this one.
    const unrelated = run('run-c', {
      status: 'running',
      agentId: 'b',
      taskId: 't2',
      startedAt: at,
    });
    expect(() =>
      validateProjectRunReservation(project(), candidate, [candidate, unrelated]),
    ).not.toThrow();
  });

  it('is stable across shuffled input and a restart round-trip', () => {
    const runs = [run('run-a'), run('run-b'), run('run-c')];
    const guard = (candidate: ProjectTaskRun) =>
      verifyProjectRun(project(), candidate, runs, 'Checked.', later);
    const first = refused(runs, guard);
    const shuffled = refused([...runs].reverse(), guard);
    const restarted = refused(JSON.parse(JSON.stringify(runs)), guard);
    expect(shuffled).toEqual(first);
    expect(restarted).toEqual(first);
  });
});
