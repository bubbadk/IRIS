import { describe, expect, it, vi } from 'vitest';
import {
  addProjectTask,
  createProjectGraph,
  ProjectWorkflowRuntime,
  ScheduleDispatcher,
  projectProgress,
  projectTaskState,
  setProjectTaskCompletion,
  validateProjectGraph,
  validateProjectTaskRun,
  nextScheduleRun,
  nextIdleScheduleRun,
  isoToZonedDateTime,
  zonedDateTimeToIso,
  validateSchedule,
  validateScheduledRun,
  type ProjectGraph,
  type ProjectGraphRepository,
  type ProjectTaskRun,
  type ProjectTaskRunRepository,
  type ProjectWorkerEvent,
  verifyProjectRun,
  resumeProjectRun,
  type ProjectWorkerExecutor,
  type ScheduleDefinition,
  type ScheduledRun,
  type ScheduleRepository,
  type ScheduledRunRepository,
} from './index';

function graphWithDependency() {
  const project = createProjectGraph({
    id: 'project-1',
    title: 'Release IRIS',
    objective: 'Produce the first verified local release.',
    createdAt: '2026-08-27T12:00:00.000Z',
  });
  const prepared = addProjectTask(project, {
    id: 'task-1',
    title: 'Verify desktop build',
    createdAt: '2026-08-27T12:01:00.000Z',
  });
  return addProjectTask(prepared, {
    id: 'task-2',
    title: 'Package AppImage',
    dependencyIds: ['task-1'],
    createdAt: '2026-08-27T12:02:00.000Z',
  });
}

describe('project task graph', () => {
  it('derives honest ready and blocked state from dependencies', () => {
    const graph = graphWithDependency();

    expect(projectTaskState(graph, 'task-1')).toBe('ready');
    expect(projectTaskState(graph, 'task-2')).toBe('blocked');
    expect(projectProgress(graph)).toEqual({ completed: 0, ready: 1, blocked: 1, total: 2 });
  });

  it('unblocks dependent work only after its prerequisite completes', () => {
    const graph = graphWithDependency();
    expect(() =>
      setProjectTaskCompletion(graph, 'task-2', true, '2026-08-27T12:03:00.000Z'),
    ).toThrow('prerequisites');

    const progressed = setProjectTaskCompletion(graph, 'task-1', true, '2026-08-27T12:03:00.000Z');
    expect(projectTaskState(progressed, 'task-2')).toBe('ready');
    expect(graph.tasks[0]).not.toHaveProperty('completedAt');
  });

  it('preserves graph consistency when completed dependents exist', () => {
    const graph = graphWithDependency();
    const firstComplete = setProjectTaskCompletion(
      graph,
      'task-1',
      true,
      '2026-08-27T12:03:00.000Z',
    );
    const allComplete = setProjectTaskCompletion(
      firstComplete,
      'task-2',
      true,
      '2026-08-27T12:04:00.000Z',
    );

    expect(() =>
      setProjectTaskCompletion(allComplete, 'task-1', false, '2026-08-27T12:05:00.000Z'),
    ).toThrow('Reopen Package AppImage');
  });

  it('rejects missing dependencies and malformed persisted graphs', () => {
    const project = createProjectGraph({
      id: 'project-1',
      title: 'Release IRIS',
      objective: 'Ship it.',
      createdAt: '2026-08-27T12:00:00.000Z',
    });
    expect(() =>
      addProjectTask(project, {
        id: 'task-1',
        title: 'Package',
        dependencyIds: ['missing'],
        createdAt: '2026-08-27T12:01:00.000Z',
      }),
    ).toThrow('does not exist');
    expect(validateProjectGraph(project)).toBe(true);
    expect(validateProjectGraph({ ...project, tasks: [{ id: 'broken' }] })).toBe(false);
  });

  it('detects and rejects circular dependencies', () => {
    const project = createProjectGraph({
      id: 'project-1',
      title: 'Graph with cycles',
      objective: 'Verify cycle prevention.',
      createdAt: '2026-08-27T12:00:00.000Z',
    });
    const t1 = addProjectTask(project, {
      id: 'task-1',
      title: 'Task 1',
      createdAt: '2026-08-27T12:01:00.000Z',
    });
    const t2 = addProjectTask(t1, {
      id: 'task-2',
      title: 'Task 2',
      dependencyIds: ['task-1'],
      createdAt: '2026-08-27T12:02:00.000Z',
    });
    const t3 = addProjectTask(t2, {
      id: 'task-3',
      title: 'Task 3',
      dependencyIds: ['task-2'],
      createdAt: '2026-08-27T12:03:00.000Z',
    });

    expect(validateProjectGraph(t3)).toBe(true);

    // Self dependency
    expect(() =>
      addProjectTask(project, {
        id: 'self-dep',
        title: 'Self',
        dependencyIds: ['self-dep'],
        createdAt: '2026-08-27T12:04:00.000Z',
      }),
    ).toThrow('cannot depend on itself');

    // Circular graph validation
    const cyclicGraph: ProjectGraph = {
      ...t3,
      tasks: [
        {
          id: 'task-1',
          title: 'Task 1',
          dependencyIds: ['task-3'],
          createdAt: '2026-08-27T12:01:00.000Z',
        },
        {
          id: 'task-2',
          title: 'Task 2',
          dependencyIds: ['task-1'],
          createdAt: '2026-08-27T12:02:00.000Z',
        },
        {
          id: 'task-3',
          title: 'Task 3',
          dependencyIds: ['task-2'],
          createdAt: '2026-08-27T12:03:00.000Z',
        },
      ],
    };
    expect(validateProjectGraph(cyclicGraph)).toBe(false);
  });
});

describe('schedules', () => {
  it('converts one-time wall-clock values using the selected timezone', () => {
    expect(zonedDateTimeToIso('2026-08-28T09:30', 'Europe/Copenhagen')).toBe(
      '2026-08-28T07:30:00.000Z',
    );
    expect(isoToZonedDateTime('2026-08-28T07:30:00.000Z', 'Europe/Copenhagen')).toBe(
      '2026-08-28T09:30',
    );
    expect(zonedDateTimeToIso('2026-03-29T02:30', 'Europe/Copenhagen')).toBeUndefined();
  });

  it('calculates the next daily run in the configured timezone', () => {
    const next = nextScheduleRun(
      { recurrence: 'daily', timeOfDay: '09:30', timeZone: 'Europe/Copenhagen' },
      new Date('2026-08-27T07:00:00.000Z'),
    );
    expect(next).toBe('2026-08-27T07:30:00.000Z');
  });

  it('skips non-selected weekdays and validates recurring records', () => {
    const next = nextScheduleRun(
      { recurrence: 'weekly', timeOfDay: '09:00', timeZone: 'UTC', weekdays: [1] },
      new Date('2026-08-28T10:00:00.000Z'),
    );
    expect(next).toBe('2026-08-31T09:00:00.000Z');
    expect(
      validateSchedule({
        version: 1,
        id: 's',
        name: 'Review',
        agentId: 'a',
        prompt: 'Review',
        recurrence: 'daily',
        timeOfDay: '09:00',
        timeZone: 'UTC',
        enabled: true,
        createdAt: '2026-08-27',
        updatedAt: '2026-08-27',
      }),
    ).toBe(true);
    expect(
      validateSchedule({
        version: 1,
        id: 's',
        name: 'Review',
        agentId: 'a',
        prompt: 'Review',
        recurrence: 'daily',
        timeOfDay: '9:00',
        timeZone: 'UTC',
        enabled: true,
        createdAt: '2026-08-27',
        updatedAt: '2026-08-27',
      }),
    ).toBe(false);
  });

  it('selects the nearest configured weekday when weekly schedules have multiple days', () => {
    const next = nextScheduleRun(
      { recurrence: 'weekly', timeOfDay: '09:00', timeZone: 'UTC', weekdays: [2, 5] },
      new Date('2026-08-31T10:00:00.000Z'),
    );
    expect(next).toBe('2026-09-01T09:00:00.000Z');
  });

  it("computes an idle schedule's due time from the last real activity, defaulting to 60 minutes", () => {
    expect(nextIdleScheduleRun({ idleMinutes: 30 }, new Date('2026-08-29T10:00:00.000Z'))).toBe(
      '2026-08-29T10:30:00.000Z',
    );
    expect(nextIdleScheduleRun({}, new Date('2026-08-29T10:00:00.000Z'))).toBe(
      '2026-08-29T11:00:00.000Z',
    );
  });

  it('accepts a valid idle schedule and rejects a non-positive idleMinutes', () => {
    const base = {
      version: 1 as const,
      id: 's',
      name: 'Dreaming',
      agentId: 'a',
      prompt: 'Review today and remember what matters.',
      recurrence: 'idle' as const,
      timeOfDay: '00:00',
      timeZone: 'UTC',
      enabled: true,
      createdAt: '2026-08-29',
      updatedAt: '2026-08-29',
    };
    expect(validateSchedule({ ...base, idleMinutes: 60 })).toBe(true);
    expect(validateSchedule(base)).toBe(true); // idleMinutes is optional; defaults at use time.
    expect(validateSchedule({ ...base, idleMinutes: 0 })).toBe(false);
    expect(validateSchedule({ ...base, idleMinutes: 1.5 })).toBe(false);
  });

  it('accepts only truthful scheduled run states', () => {
    expect(
      validateScheduledRun({
        version: 1,
        id: 'r',
        scheduleId: 's',
        agentId: 'a',
        prompt: 'Review',
        status: 'failed',
        scheduledFor: '2026-08-27T09:00:00.000Z',
        createdAt: '2026-08-27',
        updatedAt: '2026-08-27',
        failure: 'Provider unavailable.',
      }),
    ).toBe(true);
    expect(
      validateScheduledRun({
        version: 1,
        id: 'r',
        scheduleId: 's',
        agentId: 'a',
        prompt: '',
        status: 'completed',
        scheduledFor: '2026-08-27T09:00:00.000Z',
        createdAt: '2026-08-27',
        updatedAt: '2026-08-27',
      }),
    ).toBe(false);
  });

  it('dispatches a due schedule and persists its complete lifecycle', async () => {
    let schedule: ScheduleDefinition = {
      version: 1,
      id: 'schedule-1',
      name: 'Morning review',
      agentId: 'agent-1',
      prompt: 'Review the workspace.',
      recurrence: 'daily',
      timeOfDay: '09:00',
      timeZone: 'UTC',
      enabled: true,
      createdAt: '2026-08-27T08:00:00.000Z',
      updatedAt: '2026-08-27T08:00:00.000Z',
      nextRunAt: '2026-08-28T09:00:00.000Z',
    };
    let runs: ScheduledRun[] = [];
    const schedules: ScheduleRepository = {
      list: async () => [schedule],
      get: async () => schedule,
      save: async (next) => {
        schedule = next;
      },
      remove: async () => undefined,
    };
    const storedRuns: ScheduledRunRepository = {
      list: async () => runs,
      get: async (id) => runs.find((run) => run.id === id) ?? null,
      save: async (next) => {
        runs = [next, ...runs.filter((run) => run.id !== next.id)];
      },
    };
    let changes = 0;
    const dispatcher = new ScheduleDispatcher(
      schedules,
      storedRuns,
      {
        run: async function* () {
          yield { type: 'started' };
          yield { type: 'completed', output: 'Reviewed.' };
        },
        resume: async function* () {
          yield { type: 'completed', output: 'Resumed.' };
        },
      },
      {
        now: () => new Date('2026-08-28T09:01:00.000Z'),
        id: () => 'run-1',
        onChange: () => {
          changes += 1;
        },
      },
    );

    const result = await dispatcher.tick();
    expect(result[0]?.status).toBe('completed');
    expect(runs[0]?.output).toBe('Reviewed.');
    expect(schedule.nextRunAt).toBe('2026-08-29T09:00:00.000Z');
    expect(changes).toBe(4);
  });

  it('dispatches a due idle schedule and goes quiet instead of computing a calendar next-run', async () => {
    let schedule: ScheduleDefinition = {
      version: 1,
      id: 'schedule-idle',
      name: 'Dreaming',
      agentId: 'agent-1',
      prompt: 'Review today and remember what matters.',
      recurrence: 'idle',
      timeOfDay: '00:00',
      timeZone: 'UTC',
      idleMinutes: 60,
      enabled: true,
      createdAt: '2026-08-29T08:00:00.000Z',
      updatedAt: '2026-08-29T08:00:00.000Z',
      nextRunAt: '2026-08-29T09:00:00.000Z',
    };
    let runs: ScheduledRun[] = [];
    const schedules: ScheduleRepository = {
      list: async () => [schedule],
      get: async () => schedule,
      save: async (next) => {
        schedule = next;
      },
      remove: async () => undefined,
    };
    const storedRuns: ScheduledRunRepository = {
      list: async () => runs,
      get: async (id) => runs.find((run) => run.id === id) ?? null,
      save: async (next) => {
        runs = [next, ...runs.filter((run) => run.id !== next.id)];
      },
    };
    const dispatcher = new ScheduleDispatcher(
      schedules,
      storedRuns,
      {
        run: async function* () {
          yield { type: 'completed', output: 'Nothing new worth remembering.' };
        },
        resume: async function* () {},
      },
      { now: () => new Date('2026-08-29T09:05:00.000Z'), id: () => 'run-idle-1' },
    );

    await dispatcher.tick();
    expect(schedule.nextRunAt).toBeUndefined();
    expect(schedule.enabled).toBe(true); // stays enabled — unlike 'once', idle is recurring.
  });

  it('reconciles a crashed running run as failed and re-queues a never-started queued run', async () => {
    const crashedRun: ScheduledRun = {
      version: 1,
      id: 'run-crashed',
      scheduleId: 's',
      agentId: 'a',
      prompt: 'Do work',
      status: 'running',
      startedAt: '2026-08-28T09:00:05.000Z',
      scheduledFor: '2026-08-28T09:00:00.000Z',
      createdAt: '2026-08-28T09:00:00.000Z',
      updatedAt: '2026-08-28T09:00:00.000Z',
    };
    const neverStartedRun: ScheduledRun = {
      version: 1,
      id: 'run-queued',
      queueVersion: 1,
      scheduleId: 's',
      agentId: 'a',
      prompt: 'Do other work',
      status: 'queued',
      scheduledFor: '2026-08-28T09:00:00.000Z',
      createdAt: '2026-08-28T09:00:00.000Z',
      updatedAt: '2026-08-28T09:00:00.000Z',
    };
    const saved: Record<string, ScheduledRun> = {
      'run-crashed': crashedRun,
      'run-queued': neverStartedRun,
    };
    const schedules: ScheduleRepository = {
      list: async () => [],
      get: async () => null,
      save: async () => undefined,
      remove: async () => undefined,
    };
    const runs: ScheduledRunRepository = {
      list: async () => Object.values(saved),
      get: async (id) => saved[id] ?? null,
      save: async (next) => {
        saved[next.id] = next;
      },
    };
    const dispatcher = new ScheduleDispatcher(
      schedules,
      runs,
      { run: async function* () {}, resume: async function* () {} },
      { now: () => new Date('2026-08-28T10:00:00.000Z') },
    );
    await dispatcher.reconcile();
    // A run that actually started before the crash is marked failed with a timestamp-enriched message.
    expect(saved['run-crashed'].status).toBe('failed');
    expect(saved['run-crashed'].failure).toContain('started at');
    // A queued run that never began executing is re-queued so the next tick picks it up naturally.
    expect(saved['run-queued'].status).toBe('queued');
    expect(saved['run-queued'].failedAt).toBeUndefined();
    expect(saved['run-queued'].failure).toBeUndefined();
  });

  it('persists retry timing for read-only preflight failures without duplicating history', async () => {
    let now = new Date('2026-08-28T09:01:00.000Z');
    let schedule: ScheduleDefinition = {
      version: 1,
      id: 'schedule-retry',
      name: 'Retry review',
      agentId: 'agent-1',
      prompt: 'Review the workspace.',
      recurrence: 'daily',
      timeOfDay: '09:00',
      timeZone: 'UTC',
      enabled: true,
      maxAttempts: 2,
      createdAt: '2026-08-27T08:00:00.000Z',
      updatedAt: '2026-08-27T08:00:00.000Z',
      nextRunAt: '2026-08-28T09:00:00.000Z',
    };
    let storedRuns: ScheduledRun[] = [];
    let executions = 0;
    const schedules: ScheduleRepository = {
      list: async () => [schedule],
      get: async () => schedule,
      save: async (next) => {
        schedule = next;
      },
      remove: async () => undefined,
    };
    const runs: ScheduledRunRepository = {
      list: async () => storedRuns,
      get: async (id) => storedRuns.find((run) => run.id === id) ?? null,
      save: async (next) => {
        storedRuns = [next, ...storedRuns.filter((run) => run.id !== next.id)];
      },
    };
    const dispatcher = new ScheduleDispatcher(
      schedules,
      runs,
      {
        prepare: async () => {
          executions += 1;
          if (executions === 1) throw new Error('Configuration unavailable.');
        },
        run: async function* () {
          yield { type: 'started' as const };
          yield { type: 'completed' as const, output: 'Recovered.' };
        },
        resume: async function* () {},
      },
      { now: () => now, id: () => 'retry-run' },
    );

    const first = await dispatcher.tick();
    expect(first[0]).toMatchObject({ status: 'failed', attempt: 1, maxAttempts: 2 });
    expect(storedRuns[0]?.retryAt).toBe('2026-08-28T09:02:00.000Z');
    now = new Date('2026-08-28T09:02:00.000Z');
    const second = await dispatcher.tick();
    expect(second[0]).toMatchObject({ status: 'completed', attempt: 2, output: 'Recovered.' });
    expect(storedRuns).toHaveLength(1);
  });

  it('does not start the same retry twice when scheduler ticks overlap', async () => {
    const schedule: ScheduleDefinition = {
      version: 1,
      id: 'schedule-overlap',
      name: 'Overlap check',
      agentId: 'agent-1',
      prompt: 'Check once.',
      recurrence: 'daily',
      timeOfDay: '09:00',
      timeZone: 'UTC',
      enabled: true,
      maxAttempts: 2,
      createdAt: '2026-08-27T08:00:00.000Z',
      updatedAt: '2026-08-27T08:00:00.000Z',
      nextRunAt: '2026-08-29T09:00:00.000Z',
    };
    const retry: ScheduledRun = {
      version: 1,
      id: 'retry-overlap',
      retrySafe: true,
      scheduleId: schedule.id,
      agentId: schedule.agentId,
      prompt: schedule.prompt,
      status: 'failed',
      scheduledFor: '2026-08-28T09:00:00.000Z',
      createdAt: '2026-08-28T09:00:00.000Z',
      updatedAt: '2026-08-28T09:00:00.000Z',
      attempt: 1,
      maxAttempts: 2,
      retryAt: '2026-08-28T09:01:00.000Z',
      failure: 'Provider unavailable.',
    };
    let storedRun = retry;
    let executions = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const schedules: ScheduleRepository = {
      list: async () => [schedule],
      get: async () => schedule,
      save: async () => undefined,
      remove: async () => undefined,
    };
    const runs: ScheduledRunRepository = {
      list: async () => [storedRun],
      get: async () => storedRun,
      save: async (next) => {
        storedRun = next;
      },
    };
    const dispatcher = new ScheduleDispatcher(
      schedules,
      runs,
      {
        run: async function* () {
          executions += 1;
          await gate;
          yield { type: 'completed' as const, output: 'Recovered.' };
        },
        resume: async function* () {},
      },
      { now: () => new Date('2026-08-28T09:01:00.000Z') },
    );

    const first = dispatcher.tick();
    await Promise.resolve();
    const second = dispatcher.tick();
    release?.();
    const results = await Promise.all([first, second]);

    expect(executions).toBe(1);
    expect(results.flat()).toHaveLength(1);
    expect(storedRun).toMatchObject({ status: 'completed', attempt: 2 });
  });
});

function repositories(initial: ProjectGraph) {
  let project = initial;
  const projects: ProjectGraphRepository = {
    list: async () => [project],
    get: async (id) => (id === project.id ? project : null),
    save: async (next) => {
      project = next;
    },
    remove: async () => undefined,
  };
  let storedRuns: ProjectTaskRun[] = [];
  const runs: ProjectTaskRunRepository = {
    list: async (projectId) =>
      storedRuns.filter((run) => !projectId || run.projectId === projectId),
    get: async (id) => storedRuns.find((run) => run.id === id) ?? null,
    save: async (run) => {
      storedRuns = [run, ...storedRuns.filter((candidate) => candidate.id !== run.id)];
    },
  };
  return { projects, runs, currentProject: () => project, currentRuns: () => storedRuns };
}

function workerExecutor(
  execute: () => AsyncIterable<ProjectWorkerEvent>,
  resume: () => AsyncIterable<ProjectWorkerEvent> = execute,
): ProjectWorkerExecutor {
  return {
    prepare: async () => ({ agentName: 'Release worker' }),
    execute,
    resume,
    cancel: async () => undefined,
    recover: async (run) => ({
      status: 'failed',
      runtimeTurnId: run.runtimeTurnId,
      failure: 'IRIS stopped before this worker reached a final state.',
    }),
  };
}

describe('project workflow runtime', () => {
  it('keeps dependencies blocked when a worker returns even a confident success claim', async () => {
    const graph = graphWithDependency();
    const state = repositories(graph);
    const statuses: string[] = [];
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workerExecutor(async function* () {
        yield { type: 'started', runtimeTurnId: 'turn-1' };
        yield { type: 'returned', runtimeTurnId: 'turn-1', output: 'Desktop build verified.' };
      }),
      () => {
        statuses.push(state.currentRuns()[0]?.status ?? 'missing');
      },
      () => new Date('2026-08-27T14:00:00.000Z'),
      () => 'run-1',
    );

    const run = await runtime.launch({
      projectId: graph.id,
      taskId: 'task-1',
      agentId: 'agent-1',
    });

    expect(run).toMatchObject({
      id: 'run-1',
      agentId: 'agent-1',
      agentName: 'Release worker',
      status: 'awaiting-review',
      runtimeTurnId: 'turn-1',
      output: 'Desktop build verified.',
    });
    expect(statuses).toEqual(['queued', 'running', 'running', 'awaiting-review']);
    expect(projectTaskState(state.currentProject(), 'task-1')).toBe('ready');
    expect(projectTaskState(state.currentProject(), 'task-2')).toBe('blocked');
    expect(validateProjectTaskRun(run)).toBe(true);
  });

  it('keeps the graph unchanged when provider execution fails', async () => {
    const graph = graphWithDependency();
    const state = repositories(graph);
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workerExecutor(async function* () {
        yield* [] as ProjectWorkerEvent[];
        throw new Error('Provider is unavailable.');
      }),
      undefined,
      () => new Date('2026-08-27T14:00:00.000Z'),
      () => 'run-failed',
    );

    const run = await runtime.launch({
      projectId: graph.id,
      taskId: 'task-1',
      agentId: 'agent-1',
    });

    expect(run).toMatchObject({ status: 'failed', failure: 'Provider is unavailable.' });
    expect(projectTaskState(state.currentProject(), 'task-1')).toBe('ready');
  });

  it('persists approval suspension and resumes the same worker run', async () => {
    const graph = graphWithDependency();
    const state = repositories(graph);
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workerExecutor(
        async function* () {
          yield { type: 'started', runtimeTurnId: 'turn-approval' };
          yield {
            type: 'approval-required',
            runtimeTurnId: 'turn-approval',
            approval: {
              id: 'approval-1',
              toolId: 'system.inspect-host',
              toolName: 'Inspect host',
              reason: 'Ask every time.',
            },
          };
        },
        async function* () {
          yield {
            type: 'returned',
            runtimeTurnId: 'turn-approval',
            output: 'Approved inspection completed.',
          };
        },
      ),
      undefined,
      () => new Date('2026-08-27T14:00:00.000Z'),
      () => 'run-approval',
    );

    const suspended = await runtime.launch({
      projectId: graph.id,
      taskId: 'task-1',
      agentId: 'agent-1',
    });
    expect(suspended).toMatchObject({
      status: 'suspended',
      approval: { id: 'approval-1' },
    });
    expect(projectTaskState(state.currentProject(), 'task-1')).toBe('ready');

    const completed = await runtime.resolveApproval('approval-1', 'approve');
    expect(completed).toMatchObject({
      id: 'run-approval',
      status: 'awaiting-review',
      output: 'Approved inspection completed.',
    });
    expect(projectTaskState(state.currentProject(), 'task-1')).toBe('ready');
  });

  it('refuses blocked tasks and agents already occupied by another active run', async () => {
    const graph = graphWithDependency();
    const state = repositories(graph);
    await state.runs.save({
      version: 1,
      id: 'run-active',
      projectId: graph.id,
      taskId: 'task-1',
      agentId: 'agent-1',
      agentName: 'Release worker',
      status: 'running',
      createdAt: '2026-08-27T14:00:00.000Z',
      updatedAt: '2026-08-27T14:00:00.000Z',
      startedAt: '2026-08-27T14:00:00.000Z',
    });
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workerExecutor(async function* () {
        yield { type: 'returned', runtimeTurnId: 'unused', output: '' };
      }),
    );

    await expect(
      runtime.launch({ projectId: graph.id, taskId: 'task-2', agentId: 'agent-2' }),
    ).rejects.toThrow('ready');
    await expect(
      runtime.launch({ projectId: graph.id, taskId: 'task-1', agentId: 'agent-1' }),
    ).rejects.toThrow('active worker');
  });

  it.each([undefined, 'tool-limit'] as const)(
    'recovers a returned worker with stop reason %s without completing its task',
    async (stopReason) => {
      const graph = graphWithDependency();
      const state = repositories(graph);
      await state.runs.save({
        version: 1,
        id: 'run-recovered',
        projectId: graph.id,
        taskId: 'task-1',
        agentId: 'agent-1',
        agentName: 'Release worker',
        status: 'running',
        createdAt: '2026-08-27T14:00:00.000Z',
        updatedAt: '2026-08-27T14:01:00.000Z',
        startedAt: '2026-08-27T14:01:00.000Z',
        runtimeTurnId: 'turn-recovered',
      });
      const workers = workerExecutor(async function* () {
        yield { type: 'returned', runtimeTurnId: 'unused', output: '' };
      });
      workers.recover = async () => ({
        status: 'returned',
        runtimeTurnId: 'turn-recovered',
        output: 'Recovered verified output.',
        stopReason,
      });
      const runtime = new ProjectWorkflowRuntime(
        state.projects,
        state.runs,
        workers,
        undefined,
        () => new Date('2026-08-27T14:05:00.000Z'),
      );

      await expect(runtime.reconcile(graph.id)).resolves.toEqual([
        expect.objectContaining({
          id: 'run-recovered',
          status: stopReason ? 'needs-attention' : 'awaiting-review',
          output: 'Recovered verified output.',
        }),
      ]);
      expect(projectTaskState(state.currentProject(), 'task-1')).toBe('ready');
    },
  );

  it('cancels an active worker without completing its task', async () => {
    const graph = graphWithDependency();
    const state = repositories(graph);
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workerExecutor(async function* () {
        yield { type: 'started', runtimeTurnId: 'turn-cancelled' };
        await waiting;
      }),
      undefined,
      () => new Date('2026-08-27T14:00:00.000Z'),
      () => 'run-cancelled',
    );

    const running = runtime.launch({ projectId: graph.id, taskId: 'task-1', agentId: 'agent-1' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const cancelled = runtime.cancel('run-cancelled');
    release?.();

    await expect(cancelled).resolves.toMatchObject({
      id: 'run-cancelled',
      status: 'cancelled',
      cancelledAt: '2026-08-27T14:00:00.000Z',
    });
    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
    expect(projectTaskState(state.currentProject(), 'task-1')).toBe('ready');
  });

  it('cancels a suspended worker and removes its approval state', async () => {
    const graph = graphWithDependency();
    const state = repositories(graph);
    let cancelled = false;
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      {
        ...workerExecutor(async function* () {
          yield { type: 'started', runtimeTurnId: 'turn-suspended' };
          yield {
            type: 'approval-required',
            runtimeTurnId: 'turn-suspended',
            approval: { id: 'approval-cancel', toolId: 'tool', toolName: 'Tool', reason: 'Ask.' },
          };
        }),
        cancel: async () => {
          cancelled = true;
        },
      },
      undefined,
      () => new Date('2026-08-27T14:00:00.000Z'),
      () => 'run-suspended',
    );

    await runtime.launch({ projectId: graph.id, taskId: 'task-1', agentId: 'agent-1' });
    await expect(runtime.cancel('run-suspended')).resolves.toMatchObject({ status: 'cancelled' });
    expect(cancelled).toBe(true);
    await expect(runtime.resolveApproval('approval-cancel', 'approve')).rejects.toThrow(
      'No suspended project worker',
    );
    expect(projectTaskState(state.currentProject(), 'task-1')).toBe('ready');
  });

  it('preserves a stopped report and requires continued work before verification', async () => {
    const graph = graphWithDependency();
    const state = repositories(graph);
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workerExecutor(async function* () {
        yield {
          type: 'returned',
          runtimeTurnId: 'limited',
          output: 'Only inspected files.',
          stopReason: 'tool-limit',
        };
      }),
    );
    const run = await runtime.launch({ projectId: graph.id, taskId: 'task-1', agentId: 'agent-1' });
    expect(run.status).toBe('needs-attention');
    expect(run.output).toBe('Only inspected files.');
    expect(validateProjectTaskRun(run)).toBe(true);
    expect(projectTaskState(state.currentProject(), 'task-2')).toBe('blocked');
    expect(() => verifyProjectRun(graph, run, [run], 'Looks fine', run.updatedAt)).toThrow(
      'Continue stopped work',
    );
    expect(validateProjectTaskRun({ ...run, status: 'awaiting-review' })).toBe(false);
  });

  it('unlocks dependencies only after an explicit review with evidence', async () => {
    const graph = graphWithDependency();
    const state = repositories(graph);
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workerExecutor(async function* () {
        yield { type: 'returned', runtimeTurnId: 'review', output: 'Build report.' };
      }),
      undefined,
      undefined,
      undefined,
      {
        async verify(id, note, at) {
          const run = await state.runs.get(id);
          const result = verifyProjectRun(
            state.currentProject(),
            run!,
            state.currentRuns(),
            note,
            at,
          );
          await state.runs.save(result.run);
          await state.projects.save(result.project);
          return result.run;
        },
      },
    );
    const run = await runtime.launch({ projectId: graph.id, taskId: 'task-1', agentId: 'agent-1' });
    await expect(runtime.verifyRun(run.id, '  ')).rejects.toThrow('Record what you checked');
    expect(projectTaskState(state.currentProject(), 'task-2')).toBe('blocked');
    const completed = await runtime.verifyRun(run.id, 'I ran the build and checked the UI.');
    expect(completed.verification).toMatchObject({
      method: 'human-review',
      note: 'I ran the build and checked the UI.',
    });
    expect(validateProjectTaskRun(completed)).toBe(true);
    expect(projectTaskState(state.currentProject(), 'task-2')).toBe('ready');
    await expect(runtime.verifyRun(run.id, 'Again')).rejects.toThrow('awaiting review');
  });

  it('continues from a saved report in a new run without replaying the previous invocation', async () => {
    const graph = graphWithDependency();
    const state = repositories(graph);
    let counter = 0;
    const workers = workerExecutor(async function* () {
      yield { type: 'returned', runtimeTurnId: 'first-turn', output: 'First report.' };
    });
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workers,
      undefined,
      undefined,
      () => `run-${++counter}`,
    );
    const original = await runtime.launch({
      projectId: graph.id,
      taskId: 'task-1',
      agentId: 'agent-1',
    });
    workers.execute = async function* (input) {
      expect(input.previousRun?.output).toBe('First report.');
      expect(input.run.continuation).toBe('Check the remaining cases.');
      yield { type: 'returned', runtimeTurnId: 'second-turn', output: 'Second report.' };
    };
    const continued = await runtime.continueRun(original.id, 'Check the remaining cases.');
    expect(continued.previousRunId).toBe(original.id);
    expect(continued.id).not.toBe(original.id);
    expect((await state.runs.get(original.id))?.output).toBe('First report.');
    expect(projectTaskState(state.currentProject(), 'task-2')).toBe('blocked');
    expect(() =>
      verifyProjectRun(
        graph,
        original,
        state.currentRuns(),
        'Reviewed old result',
        original.updatedAt,
      ),
    ).toThrow('newer or active');
    const changed = {
      ...graph,
      tasks: graph.tasks.map((task) => ({ ...task, acceptanceCriteria: 'New criteria' })),
    };
    expect(() =>
      verifyProjectRun(changed, continued, [continued], 'Checked', continued.updatedAt),
    ).toThrow('criteria changed');
  });
  it.each([undefined, 'tool-limit'] as const)(
    'continues within the selected turn budget and stops with %s',
    async (stopReason) => {
      const graph = graphWithDependency();
      graph.tasks[0]!.turnLimit = 3;
      const state = repositories(graph);
      let continuations = 0;
      const workers = workerExecutor(async function* () {
        yield {
          type: 'returned',
          runtimeTurnId: 'turn-1',
          output: 'First checkpoint.',
          stopReason: 'tool-limit',
        };
      });
      workers.continue = async function* (input) {
        continuations++;
        const turn = (input.run.turnsUsed ?? 0) + 1;
        yield { type: 'started', runtimeTurnId: `turn-${turn}` };
        yield {
          type: 'returned',
          runtimeTurnId: `turn-${turn}`,
          output: `Checkpoint ${turn}`,
          stopReason: turn === 3 ? stopReason : 'tool-limit',
        };
      };
      const runtime = new ProjectWorkflowRuntime(state.projects, state.runs, workers);
      const run = await runtime.launch({
        projectId: graph.id,
        taskId: 'task-1',
        agentId: 'agent-1',
      });
      expect(run.turnsUsed).toBe(3);
      expect(run.status).toBe(stopReason ? 'needs-attention' : 'awaiting-review');
      expect(continuations).toBe(2);
      expect(validateProjectTaskRun(run)).toBe(true);
      expect(projectTaskState(state.currentProject(), 'task-2')).toBe('blocked');
    },
  );

  it('pauses at a safe turn boundary and resumes the remaining budget after restart', async () => {
    const graph = graphWithDependency();
    graph.tasks[0]!.turnLimit = 3;
    const state = repositories(graph);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let continuations = 0;
    const workers = workerExecutor(async function* () {
      yield { type: 'started', runtimeTurnId: 'first' };
      entered();
      await hold;
      yield {
        type: 'returned',
        runtimeTurnId: 'first',
        output: 'Safe partial result.',
        stopReason: 'tool-limit',
      };
    });
    workers.continue = async function* () {
      continuations++;
      yield { type: 'returned', runtimeTurnId: 'second', output: 'Finished report.' };
    };
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workers,
      undefined,
      undefined,
      () => 'paused-run',
    );
    const running = runtime.launch({ projectId: graph.id, taskId: 'task-1', agentId: 'agent-1' });
    await started;
    await runtime.requestPause('paused-run');
    release();
    const paused = await running;
    expect(paused.status).toBe('paused');
    expect(paused.turnsUsed).toBe(1);
    expect(validateProjectTaskRun(paused)).toBe(true);
    expect(continuations).toBe(0);
    const restarted = new ProjectWorkflowRuntime(state.projects, state.runs, workers);
    const resumed = await restarted.resumeRun(paused.id);
    expect(resumed.id).toBe(paused.id);
    expect(resumed.turnsUsed).toBe(2);
    expect(resumed.status).toBe('awaiting-review');
    expect(continuations).toBe(1);
    expect(projectTaskState(state.currentProject(), 'task-2')).toBe('blocked');
    await expect(restarted.resumeRun(paused.id)).rejects.toThrow('paused turns');
  });

  it('recovers a safe turn boundary as paused without executing the next turn', async () => {
    const graph = graphWithDependency();
    graph.tasks[0]!.turnLimit = 3;
    const state = repositories(graph);
    const workers = workerExecutor(async function* () {});
    let continued = false;
    workers.continue = async function* () {
      continued = true;
      yield { type: 'returned', runtimeTurnId: 'unexpected', output: 'Unexpected continuation.' };
    };
    workers.recover = async () => ({
      status: 'returned',
      runtimeTurnId: 'first',
      output: 'Saved progress.',
      stopReason: 'tool-limit',
    });
    const at = '2026-09-07T10:00:00.000Z';
    await state.runs.save({
      version: 1,
      id: 'run',
      projectId: graph.id,
      taskId: 'task-1',
      agentId: 'a',
      agentName: 'Worker',
      status: 'running',
      createdAt: at,
      updatedAt: at,
      startedAt: at,
      runtimeTurnId: 'first',
      turnLimit: 3,
      turnsUsed: 1,
    });
    const runtime = new ProjectWorkflowRuntime(state.projects, state.runs, workers);
    const [recovered] = await runtime.reconcile();
    expect(recovered?.status).toBe('paused');
    expect(continued).toBe(false);
    expect(validateProjectTaskRun(recovered)).toBe(true);
    expect(validateProjectTaskRun({ ...recovered, stopReason: undefined })).toBe(false);
    expect(validateProjectTaskRun({ ...recovered, returnedAt: 42 })).toBe(false);
  });
});

describe('project corrective result checks', () => {
  const checks = [
    {
      id: 'brief-check',
      target: { kind: 'document' as const, title: 'Brief' },
      assertion: 'contains' as const,
      expected: 'Summary',
    },
  ];
  function setup() {
    const graph = graphWithDependency();
    graph.tasks[0]!.turnLimit = 3;
    graph.tasks[0]!.resultChecks = checks;
    return { graph, state: repositories(graph) };
  }
  it('feeds a failed check into a corrective turn, saves both rounds and still requires human review', async () => {
    const { graph, state } = setup();
    let content = 'Unfinished';
    const workers = workerExecutor(async function* () {
      yield { type: 'returned', runtimeTurnId: 'turn-1', output: 'Everything is done.' };
    });
    workers.continue = async function* (input) {
      expect(input.run.checkReports?.at(-1)?.results[0]?.status).toBe('failed');
      expect(input.run.stopReason).toBe('check-failed');
      content = 'Summary: corrected content';
      yield { type: 'started', runtimeTurnId: 'turn-2' };
      yield { type: 'returned', runtimeTurnId: 'turn-2', output: 'Corrected the saved document.' };
    };
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workers,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        read: async () => ({
          content,
          evidence: content === 'Unfinished' ? 'revision-1' : 'revision-2',
        }),
      },
    );
    const run = await runtime.launch({ projectId: graph.id, taskId: 'task-1', agentId: 'agent-1' });
    expect(run.status).toBe('awaiting-review');
    expect(run.turnsUsed).toBe(2);
    expect(run.checkReports?.map((report) => report.results[0]?.status)).toEqual([
      'failed',
      'passed',
    ]);
    expect(validateProjectTaskRun(run)).toBe(true);
    expect(projectTaskState(state.currentProject(), 'task-2')).toBe('blocked');
    expect(
      verifyProjectRun(graph, run, [run], 'Reviewed actual revision 2.', run.updatedAt, {
        expectedRun: run,
        checkReport: structuredClone(run.checkReports!.at(-1)!),
      }).run.status,
    ).toBe('completed');
    const changed = structuredClone(graph);
    changed.tasks[0]!.resultChecks![0]!.expected = 'New requirement';
    expect(() => verifyProjectRun(changed, run, [run], 'Reviewed', run.updatedAt)).toThrow(
      'checks changed',
    );
    expect(validateProjectTaskRun({ ...run, checkReports: undefined })).toBe(false);
  });
  it('stops at the shared turn budget and cannot verify failed checks', async () => {
    const { graph, state } = setup();
    const workers = workerExecutor(async function* () {
      yield { type: 'returned', runtimeTurnId: 'turn-1', output: 'Done' };
    });
    let continuations = 0;
    workers.continue = async function* (input) {
      continuations++;
      yield {
        type: 'returned',
        runtimeTurnId: `turn-${(input.run.turnsUsed ?? 0) + 1}`,
        output: 'Done again',
      };
    };
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workers,
      undefined,
      undefined,
      undefined,
      undefined,
      { read: async () => null },
    );
    const run = await runtime.launch({ projectId: graph.id, taskId: 'task-1', agentId: 'agent-1' });
    expect(run).toMatchObject({
      status: 'needs-attention',
      stopReason: 'check-failed',
      turnsUsed: 3,
    });
    expect(continuations).toBe(2);
    expect(run.checkReports).toHaveLength(3);
    expect(validateProjectTaskRun(run)).toBe(true);
    expect(() => verifyProjectRun(graph, run, [run], 'Unverified', run.updatedAt)).toThrow(
      'awaiting review',
    );
    expect(
      validateProjectTaskRun({ ...run, status: 'awaiting-review', stopReason: undefined }),
    ).toBe(false);
  });
  it('does not spend correction turns when the checker cannot read the target', async () => {
    const { graph, state } = setup();
    const workers = workerExecutor(async function* () {
      yield { type: 'returned', runtimeTurnId: 'turn-1', output: 'Done' };
    });
    workers.continue = () => {
      throw new Error('Must not continue');
    };
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workers,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        read: async () => {
          throw new Error('The workspace changed.');
        },
      },
    );
    const run = await runtime.launch({ projectId: graph.id, taskId: 'task-1', agentId: 'agent-1' });
    expect(run).toMatchObject({
      status: 'needs-attention',
      stopReason: 'check-error',
      turnsUsed: 1,
    });
    expect(validateProjectTaskRun(run)).toBe(true);
  });
  it('preserves failed checks across a paused checkpoint and resumes only the remaining turns', async () => {
    const { graph, state } = setup();
    const workers = workerExecutor(async function* () {
      yield { type: 'returned', runtimeTurnId: 'turn-1', output: 'Done' };
    });
    workers.continue = async function* () {
      yield { type: 'returned', runtimeTurnId: 'turn-2', output: 'Corrected' };
    };
    const runtime: ProjectWorkflowRuntime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workers,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        read: async () => {
          await runtime.requestPause(state.currentRuns()[0]!.id);
          return null;
        },
      },
    );
    const paused = await runtime.launch({
      projectId: graph.id,
      taskId: 'task-1',
      agentId: 'agent-1',
    });
    expect(paused).toMatchObject({ status: 'paused', stopReason: 'check-failed', turnsUsed: 1 });
    expect(validateProjectTaskRun(paused)).toBe(true);
    const restarted = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workers,
      undefined,
      undefined,
      undefined,
      undefined,
      { read: async () => ({ content: 'Summary', evidence: 'new revision' }) },
    );
    const resumed = await restarted.resumeRun(paused.id);
    expect(resumed).toMatchObject({ status: 'awaiting-review', turnsUsed: 2 });
    expect(resumed.checkReports).toHaveLength(2);
  });
});

describe('project wall-clock limits', () => {
  it('aborts an active worker at the real persisted deadline', async () => {
    vi.useFakeTimers();
    try {
      const graph = graphWithDependency();
      graph.tasks[0]!.timeLimitMinutes = 1;
      const state = repositories(graph);
      const workers = workerExecutor(async function* () {
        yield { type: 'returned', runtimeTurnId: 'unused', output: 'Unused.' };
      });
      workers.execute = async function* (_input, signal): AsyncGenerator<ProjectWorkerEvent> {
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
        yield { type: 'returned', runtimeTurnId: 'late', output: 'Late.' };
      };
      const runtime = new ProjectWorkflowRuntime(state.projects, state.runs, workers);
      const running = runtime.launch({ projectId: graph.id, taskId: 'task-1', agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(60_000);
      const run = await running;
      expect(run.status).toBe('failed');
      expect(run.failure).toContain('wall-clock limit expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('snapshots an explicit deadline and refuses a run that is already past it', async () => {
    const graph = graphWithDependency();
    graph.tasks[0]!.timeLimitMinutes = 1;
    const state = repositories(graph);
    const now = new Date('2026-09-09T10:00:00.000Z');
    const workers = workerExecutor(async function* () {
      now.setTime(now.getTime() + 61_000);
      yield { type: 'returned', runtimeTurnId: 'late', output: 'Late report.' };
    });
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workers,
      undefined,
      () => now,
      () => 'limited-run',
    );
    const run = await runtime.launch({ projectId: graph.id, taskId: 'task-1', agentId: 'agent-1' });
    expect(run).toMatchObject({
      status: 'failed',
      timeLimitMinutes: 1,
      deadlineAt: '2026-09-09T10:01:00.000Z',
    });
    expect(run.failure).toContain('wall-clock limit expired');
    expect(projectTaskState(state.currentProject(), 'task-2')).toBe('blocked');
  });

  it('does not resume a paused run after its persisted deadline', () => {
    const graph = graphWithDependency();
    graph.tasks[0]!.timeLimitMinutes = 1;
    const paused: ProjectTaskRun = {
      version: 1,
      id: 'paused-limit',
      projectId: graph.id,
      taskId: 'task-1',
      agentId: 'agent-1',
      agentName: 'Worker',
      status: 'paused',
      createdAt: '2026-09-09T10:00:00.000Z',
      updatedAt: '2026-09-09T10:00:20.000Z',
      startedAt: '2026-09-09T10:00:00.000Z',
      runtimeTurnId: 'turn',
      returnedAt: '2026-09-09T10:00:20.000Z',
      output: 'Saved checkpoint.',
      stopReason: 'tool-limit',
      turnLimit: 2,
      turnsUsed: 1,
      timeLimitMinutes: 1,
      deadlineAt: '2026-09-09T10:01:00.000Z',
      pausedAt: '2026-09-09T10:00:20.000Z',
    };
    expect(() => resumeProjectRun(graph, paused, [paused], '2026-09-09T10:01:00.000Z')).toThrow(
      'time limit has expired',
    );
  });
});
