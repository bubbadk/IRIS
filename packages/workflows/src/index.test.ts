import { describe, expect, it } from 'vitest';
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
        { id: 'task-1', title: 'Task 1', dependencyIds: ['task-3'], createdAt: '2026-08-27T12:01:00.000Z' },
        { id: 'task-2', title: 'Task 2', dependencyIds: ['task-1'], createdAt: '2026-08-27T12:02:00.000Z' },
        { id: 'task-3', title: 'Task 3', dependencyIds: ['task-2'], createdAt: '2026-08-27T12:03:00.000Z' },
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

  it('computes an idle schedule\'s due time from the last real activity, defaulting to 60 minutes', () => {
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
    expect(changes).toBe(2);
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

  it('persists retry timing and retries a failed run without duplicating its history row', async () => {
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
        run: async function* () {
          executions += 1;
          yield { type: 'started' as const };
          if (executions === 1) throw new Error('Provider unavailable.');
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
  it('persists a real worker lifecycle and completes the originating task only on success', async () => {
    const graph = graphWithDependency();
    const state = repositories(graph);
    const statuses: string[] = [];
    const runtime = new ProjectWorkflowRuntime(
      state.projects,
      state.runs,
      workerExecutor(async function* () {
        yield { type: 'started', runtimeTurnId: 'turn-1' };
        yield { type: 'completed', runtimeTurnId: 'turn-1', output: 'Desktop build verified.' };
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
      status: 'completed',
      runtimeTurnId: 'turn-1',
      output: 'Desktop build verified.',
    });
    expect(statuses).toEqual(['queued', 'running', 'running', 'completed']);
    expect(projectTaskState(state.currentProject(), 'task-1')).toBe('completed');
    expect(projectTaskState(state.currentProject(), 'task-2')).toBe('ready');
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
            type: 'completed',
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
      status: 'completed',
      output: 'Approved inspection completed.',
    });
    expect(projectTaskState(state.currentProject(), 'task-1')).toBe('completed');
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
        yield { type: 'completed', runtimeTurnId: 'unused', output: '' };
      }),
    );

    await expect(
      runtime.launch({ projectId: graph.id, taskId: 'task-2', agentId: 'agent-2' }),
    ).rejects.toThrow('ready');
    await expect(
      runtime.launch({ projectId: graph.id, taskId: 'task-1', agentId: 'agent-1' }),
    ).rejects.toThrow('active worker');
  });

  it('reconciles a completed persisted Cortex worker after restart', async () => {
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
      yield { type: 'completed', runtimeTurnId: 'unused', output: '' };
    });
    workers.recover = async () => ({
      status: 'completed',
      runtimeTurnId: 'turn-recovered',
      output: 'Recovered verified output.',
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
        status: 'completed',
        output: 'Recovered verified output.',
      }),
    ]);
    expect(projectTaskState(state.currentProject(), 'task-1')).toBe('completed');
  });

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
});
