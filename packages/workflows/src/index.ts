export interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  dependencyIds: string[];
  createdAt: string;
  completedAt?: string;
}

export interface ProjectGraph {
  version: 1;
  id: string;
  title: string;
  objective: string;
  tasks: ProjectTask[];
  createdAt: string;
  updatedAt: string;
}

export type ProjectTaskState = 'ready' | 'blocked' | 'completed';

export interface ProjectGraphRepository {
  list(): Promise<ProjectGraph[]>;
  get(id: string): Promise<ProjectGraph | null>;
  save(graph: ProjectGraph): Promise<void>;
  remove(id: string): Promise<void>;
}

export type ProjectTaskRunStatus =
  'queued' | 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';

export interface ProjectTaskRunApproval {
  id: string;
  toolId: string;
  toolName: string;
  reason: string;
}

export interface ProjectTaskRun {
  version: 1;
  id: string;
  projectId: string;
  taskId: string;
  agentId: string;
  agentName: string;
  status: ProjectTaskRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  runtimeTurnId?: string;
  suspendedAt?: string;
  approval?: ProjectTaskRunApproval;
  completedAt?: string;
  output?: string;
  failedAt?: string;
  failure?: string;
  cancelledAt?: string;
}

export interface ProjectTaskRunRepository {
  list(projectId?: string): Promise<ProjectTaskRun[]>;
  get(id: string): Promise<ProjectTaskRun | null>;
  save(run: ProjectTaskRun): Promise<void>;
}

export type ScheduleRecurrence = 'once' | 'daily' | 'weekly' | 'idle';

export interface ScheduleDefinition {
  version: 1;
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  recurrence: ScheduleRecurrence;
  timeOfDay: string;
  timeZone: string;
  /** ISO date used by one-time schedules. */
  runAt?: string;
  /** Sunday is 0, matching JavaScript Date.getUTCDay(). */
  weekdays?: number[];
  /** Minutes of no recorded user activity before an 'idle' schedule is due. */
  idleMinutes?: number;
  enabled: boolean;
  /** Total number of attempts, including the first attempt. Defaults to one. */
  maxAttempts?: number;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
}

export type ScheduledRunStatus = 'queued' | 'running' | 'suspended' | 'completed' | 'failed';

export interface ScheduledRun {
  version: 1;
  id: string;
  scheduleId: string;
  agentId: string;
  prompt: string;
  status: ScheduledRunStatus;
  scheduledFor: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  failure?: string;
  output?: string;
  approvalId?: string;
  attempt?: number;
  maxAttempts?: number;
  /** Persisted retry time; presence means this failed run is eligible for retry. */
  retryAt?: string;
}

export interface ScheduleRepository {
  list(): Promise<ScheduleDefinition[]>;
  get(id: string): Promise<ScheduleDefinition | null>;
  save(schedule: ScheduleDefinition): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface ScheduledRunRepository {
  list(scheduleId?: string): Promise<ScheduledRun[]>;
  get(id: string): Promise<ScheduledRun | null>;
  save(run: ScheduledRun): Promise<void>;
}

export interface ScheduleRunner {
  run(input: {
    schedule: ScheduleDefinition;
    run: ScheduledRun;
  }): AsyncIterable<
    | { type: 'started' }
    | { type: 'approval-required'; approvalId: string }
    | { type: 'completed'; output: string }
  >;
  resume(
    input: { schedule: ScheduleDefinition; run: ScheduledRun },
    approvalId: string,
    decision: 'approve' | 'deny',
  ): AsyncIterable<
    | { type: 'started' }
    | { type: 'approval-required'; approvalId: string }
    | { type: 'completed'; output: string }
  >;
}

export interface ScheduleDispatcherOptions {
  now?: () => Date;
  id?: () => string;
  onChange?: () => void;
}

/**
 * Durable due-job coordinator. Execution stays behind ScheduleRunner so the
 * domain package never owns a provider, UI or native process.
 */
export class ScheduleDispatcher {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly onChange: () => void;
  private readonly active = new Set<string>();

  constructor(
    private readonly schedules: ScheduleRepository,
    private readonly runs: ScheduledRunRepository,
    private readonly runner: ScheduleRunner,
    options: ScheduleDispatcherOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => `scheduled-run-${crypto.randomUUID()}`);
    this.onChange = options.onChange ?? (() => undefined);
  }

  async reconcile(): Promise<void> {
    const storedRuns = await this.runs.list();
    const timestamp = this.now().toISOString();
    for (const run of storedRuns) {
      if (run.status !== 'queued' && run.status !== 'running') continue;
      await this.runs.save({
        ...run,
        status: 'failed',
        failedAt: timestamp,
        updatedAt: timestamp,
        failure: 'IRIS stopped before this scheduled run reached a final state.',
      });
      this.onChange();
    }
  }

  async tick(): Promise<ScheduledRun[]> {
    const now = this.now();
    const due = (await this.schedules.list()).filter(
      (schedule) => schedule.enabled && !!schedule.nextRunAt && new Date(schedule.nextRunAt) <= now,
    );
    const results: ScheduledRun[] = [];
    const schedules = await this.schedules.list();
    const scheduleById = new Map(schedules.map((schedule) => [schedule.id, schedule]));
    const retryableRuns = (await this.runs.list()).filter(
      (run) => run.status === 'failed' && !!run.retryAt && new Date(run.retryAt) <= now,
    );
    for (const run of retryableRuns) {
      const schedule = scheduleById.get(run.scheduleId);
      if (!schedule || !schedule.enabled) continue;
      const key = `run:${run.id}`;
      if (this.active.has(key)) continue;
      this.active.add(key);
      const attempt = run.attempt ?? 1;
      try {
        results.push(
          await this.consume(
            {
              ...run,
              status: 'queued',
              attempt: attempt + 1,
              retryAt: undefined,
              updatedAt: now.toISOString(),
            },
            () =>
              this.runner.run({
                schedule,
                run: { ...run, attempt: attempt + 1, status: 'queued' },
              }),
          ),
        );
      } finally {
        this.active.delete(key);
      }
    }
    for (const schedule of due) {
      const scheduledFor = schedule.nextRunAt!;
      const key = `${schedule.id}:${scheduledFor}`;
      if (this.active.has(key)) continue;
      this.active.add(key);
      try {
        results.push(await this.dispatch(schedule, scheduledFor));
      } finally {
        this.active.delete(key);
      }
    }
    return results;
  }

  async resolveApproval(runId: string, decision: 'approve' | 'deny'): Promise<ScheduledRun> {
    const run = await this.runs.get(runId);
    if (!run || run.status !== 'suspended' || !run.approvalId) {
      throw new Error('This scheduled run is not waiting for approval.');
    }
    const schedule = await this.schedules.get(run.scheduleId);
    if (!schedule) throw new Error('The schedule for this run is no longer available.');
    const key = `run:${run.id}`;
    if (this.active.has(key)) throw new Error('This scheduled run is already being resumed.');
    this.active.add(key);
    try {
      return await this.consume(
        { ...run, status: 'running', updatedAt: this.now().toISOString() },
        () => this.runner.resume({ schedule, run }, run.approvalId!, decision),
      );
    } finally {
      this.active.delete(key);
    }
  }

  private async dispatch(
    schedule: ScheduleDefinition,
    scheduledFor: string,
  ): Promise<ScheduledRun> {
    const existing = (await this.runs.list(schedule.id)).find(
      (run) => run.scheduledFor === scheduledFor,
    );
    if (existing) return existing;
    const timestamp = this.now().toISOString();
    const run: ScheduledRun = {
      version: 1,
      id: this.id(),
      scheduleId: schedule.id,
      agentId: schedule.agentId,
      prompt: schedule.prompt,
      status: 'queued',
      scheduledFor,
      createdAt: timestamp,
      updatedAt: timestamp,
      attempt: 1,
      maxAttempts: Math.max(1, Math.floor(schedule.maxAttempts ?? 1)),
    };
    await this.runs.save(run);
    // 'idle' has no calendar occurrence to compute here — it goes quiet until real user
    // activity resets it (see nextIdleScheduleRun / refreshIdleSchedules), not immediately due
    // again on the next tick.
    const nextRunAt =
      schedule.recurrence === 'idle' ? undefined : nextScheduleRun(schedule, new Date(scheduledFor));
    await this.schedules.save({
      ...schedule,
      enabled: schedule.recurrence === 'once' ? false : schedule.enabled,
      nextRunAt,
      updatedAt: timestamp,
    });
    return this.consume(run, () => this.runner.run({ schedule, run }));
  }

  private async consume(
    initial: ScheduledRun,
    events: () => AsyncIterable<
      | { type: 'started' }
      | { type: 'approval-required'; approvalId: string }
      | { type: 'completed'; output: string }
    >,
  ): Promise<ScheduledRun> {
    let run = initial;
    try {
      for await (const event of events()) {
        const timestamp = this.now().toISOString();
        if (event.type === 'started') {
          run = {
            ...run,
            status: 'running',
            startedAt: run.startedAt ?? timestamp,
            updatedAt: timestamp,
          };
        } else if (event.type === 'approval-required') {
          run = { ...run, status: 'suspended', approvalId: event.approvalId, updatedAt: timestamp };
        } else {
          run = {
            ...run,
            status: 'completed',
            output: event.output,
            completedAt: timestamp,
            updatedAt: timestamp,
          };
        }
        await this.runs.save(run);
        this.onChange();
      }
      return run;
    } catch (error) {
      run = {
        ...run,
        status: 'failed',
        failedAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
        failure: error instanceof Error ? error.message : String(error),
      };
      const attempt = run.attempt ?? 1;
      const maxAttempts = run.maxAttempts ?? 1;
      if (attempt < maxAttempts) {
        run.retryAt = new Date(this.now().getTime() + attempt * 60_000).toISOString();
      } else {
        delete run.retryAt;
      }
      await this.runs.save(run);
      this.onChange();
      return run;
    }
  }
}

function validTimeOfDay(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function cloneSchedule(schedule: ScheduleDefinition): ScheduleDefinition {
  return { ...schedule, ...(schedule.weekdays ? { weekdays: [...schedule.weekdays] } : {}) };
}

export function cloneScheduledRun(run: ScheduledRun): ScheduledRun {
  return { ...run, attempt: run.attempt ?? 1, maxAttempts: run.maxAttempts ?? 1 };
}

function zonedParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date);
  const value = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
    hour: Number(value.hour),
    minute: Number(value.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value.weekday),
  };
}

function fromZonedParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(guess, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute);
    guess = new Date(guess.getTime() + desiredAsUtc - actualAsUtc);
  }
  return guess;
}

/** Convert a datetime-local wall-clock value in an explicit IANA timezone to an ISO instant. */
export function zonedDateTimeToIso(value: string, timeZone: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !validTimeZone(timeZone)) return undefined;
  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;
  const result = fromZonedParts(year, month, day, hour, minute, timeZone);
  const actual = zonedParts(result, timeZone);
  if (
    actual.year !== year ||
    actual.month !== month ||
    actual.day !== day ||
    actual.hour !== hour ||
    actual.minute !== minute
  )
    return undefined;
  return result.toISOString();
}

/** Format an ISO instant for a datetime-local input in an explicit IANA timezone. */
export function isoToZonedDateTime(value: string, timeZone: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !validTimeZone(timeZone)) return undefined;
  const parts = zonedParts(date, timeZone);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function nextScheduleRun(
  schedule: Pick<
    ScheduleDefinition,
    'recurrence' | 'timeOfDay' | 'timeZone' | 'runAt' | 'weekdays'
  >,
  after = new Date(),
): string | undefined {
  if (!validTimeOfDay(schedule.timeOfDay) || !validTimeZone(schedule.timeZone)) return undefined;
  if (schedule.recurrence === 'once') {
    if (!schedule.runAt) return undefined;
    const runAt = new Date(schedule.runAt);
    return Number.isNaN(runAt.getTime()) || runAt <= after ? undefined : runAt.toISOString();
  }
  const [hour, minute] = schedule.timeOfDay.split(':').map(Number);
  const weekdays = schedule.recurrence === 'weekly' ? new Set(schedule.weekdays ?? []) : undefined;
  const start = zonedParts(after, schedule.timeZone);
  const startUtcDay = Date.UTC(start.year, start.month - 1, start.day);
  for (let offset = 0; offset <= 370; offset += 1) {
    const day = new Date(startUtcDay + offset * 86_400_000);
    const candidate = fromZonedParts(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      hour,
      minute,
      schedule.timeZone,
    );
    const candidateWeekday = zonedParts(candidate, schedule.timeZone).weekday;
    if (weekdays && !weekdays.has(candidateWeekday)) continue;
    if (candidate > after) return candidate.toISOString();
  }
  return undefined;
}

/**
 * Due time for an 'idle' schedule: the last recorded real user activity plus its idle
 * threshold. The dispatcher's due-check (`nextRunAt <= now`) never changes — callers just
 * recompute and persist this value every time real user activity resets the idle window.
 */
export function nextIdleScheduleRun(
  schedule: Pick<ScheduleDefinition, 'idleMinutes'>,
  lastActivityAt: Date,
): string {
  const minutes = schedule.idleMinutes ?? 60;
  return new Date(lastActivityAt.getTime() + minutes * 60_000).toISOString();
}

export function validateSchedule(value: unknown): value is ScheduleDefinition {
  if (!value || typeof value !== 'object') return false;
  const schedule = value as Partial<ScheduleDefinition>;
  if (
    schedule.version !== 1 ||
    typeof schedule.id !== 'string' ||
    !schedule.id.trim() ||
    typeof schedule.name !== 'string' ||
    !schedule.name.trim() ||
    typeof schedule.agentId !== 'string' ||
    !schedule.agentId.trim() ||
    typeof schedule.prompt !== 'string' ||
    !schedule.prompt.trim() ||
    !['once', 'daily', 'weekly', 'idle'].includes(schedule.recurrence ?? '') ||
    !validTimeOfDay(schedule.timeOfDay) ||
    !validTimeZone(schedule.timeZone) ||
    typeof schedule.enabled !== 'boolean' ||
    typeof schedule.createdAt !== 'string' ||
    typeof schedule.updatedAt !== 'string'
  )
    return false;
  if (
    schedule.recurrence === 'once' &&
    (!schedule.runAt || Number.isNaN(new Date(schedule.runAt).getTime()))
  )
    return false;
  if (
    schedule.maxAttempts !== undefined &&
    (!Number.isInteger(schedule.maxAttempts) ||
      schedule.maxAttempts < 1 ||
      schedule.maxAttempts > 10)
  )
    return false;
  if (
    schedule.recurrence === 'weekly' &&
    (!Array.isArray(schedule.weekdays) ||
      schedule.weekdays.length === 0 ||
      schedule.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
  )
    return false;
  if (
    schedule.recurrence === 'idle' &&
    schedule.idleMinutes !== undefined &&
    (!Number.isInteger(schedule.idleMinutes) || schedule.idleMinutes < 1)
  )
    return false;
  return (
    schedule.nextRunAt === undefined ||
    (typeof schedule.nextRunAt === 'string' &&
      !Number.isNaN(new Date(schedule.nextRunAt).getTime()))
  );
}

export function validateScheduledRun(value: unknown): value is ScheduledRun {
  if (!value || typeof value !== 'object') return false;
  const run = value as Partial<ScheduledRun>;
  const attempt = run.attempt ?? 1;
  const maxAttempts = run.maxAttempts ?? 1;
  return (
    run.version === 1 &&
    typeof run.id === 'string' &&
    !!run.id.trim() &&
    typeof run.scheduleId === 'string' &&
    !!run.scheduleId.trim() &&
    typeof run.agentId === 'string' &&
    !!run.agentId.trim() &&
    typeof run.prompt === 'string' &&
    !!run.prompt.trim() &&
    ['queued', 'running', 'suspended', 'completed', 'failed'].includes(run.status ?? '') &&
    typeof run.scheduledFor === 'string' &&
    !Number.isNaN(new Date(run.scheduledFor).getTime()) &&
    typeof run.createdAt === 'string' &&
    typeof run.updatedAt === 'string' &&
    Number.isInteger(attempt) &&
    attempt >= 1 &&
    Number.isInteger(maxAttempts) &&
    maxAttempts >= attempt &&
    maxAttempts <= 10 &&
    (run.retryAt === undefined ||
      (typeof run.retryAt === 'string' && !Number.isNaN(new Date(run.retryAt).getTime())))
  );
}

export interface ProjectWorkerPreparation {
  agentName: string;
}

export interface ProjectWorkerExecutionInput {
  run: ProjectTaskRun;
  project: ProjectGraph;
  task: ProjectTask;
}

export type ProjectWorkerEvent =
  | { type: 'started'; runtimeTurnId: string }
  | {
      type: 'approval-required';
      runtimeTurnId: string;
      approval: ProjectTaskRunApproval;
    }
  | { type: 'completed'; runtimeTurnId: string; output: string };

export type ProjectWorkerRecovery =
  | { status: 'running'; runtimeTurnId: string }
  | {
      status: 'suspended';
      runtimeTurnId: string;
      approval: ProjectTaskRunApproval;
    }
  | { status: 'completed'; runtimeTurnId: string; output?: string }
  | { status: 'failed'; runtimeTurnId?: string; failure: string };

export interface ProjectWorkerExecutor {
  prepare(agentId: string): Promise<ProjectWorkerPreparation>;
  execute(
    input: ProjectWorkerExecutionInput,
    signal?: AbortSignal,
  ): AsyncIterable<ProjectWorkerEvent>;
  resume(
    input: ProjectWorkerExecutionInput,
    approvalId: string,
    decision: 'approve' | 'deny',
    signal?: AbortSignal,
  ): AsyncIterable<ProjectWorkerEvent>;
  cancel(run: ProjectTaskRun): Promise<void>;
  recover(run: ProjectTaskRun): Promise<ProjectWorkerRecovery>;
}

export interface LaunchProjectTaskInput {
  projectId: string;
  taskId: string;
  agentId: string;
}

export interface CreateProjectGraphInput {
  id: string;
  title: string;
  objective: string;
  createdAt: string;
}

export interface AddProjectTaskInput {
  id: string;
  title: string;
  description?: string;
  dependencyIds?: string[];
  createdAt: string;
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`A project requires ${label}.`);
  return normalized;
}

function taskById(graph: ProjectGraph, taskId: string): ProjectTask {
  const task = graph.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Project task ${taskId} does not exist.`);
  return task;
}

export function cloneProjectGraph(graph: ProjectGraph): ProjectGraph {
  return {
    ...graph,
    tasks: graph.tasks.map((task) => ({ ...task, dependencyIds: [...task.dependencyIds] })),
  };
}

export function cloneProjectTaskRun(run: ProjectTaskRun): ProjectTaskRun {
  return {
    ...run,
    ...(run.approval ? { approval: { ...run.approval } } : {}),
  };
}

export function createProjectGraph(input: CreateProjectGraphInput): ProjectGraph {
  const id = requireText(input.id, 'an ID');
  const title = requireText(input.title, 'a title');
  const objective = requireText(input.objective, 'an objective');
  return {
    version: 1,
    id,
    title,
    objective,
    tasks: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function hasDependencyCycle(
  tasks: readonly Pick<ProjectTask, 'id' | 'dependencyIds'>[],
): boolean {
  const taskMap = new Map(tasks.map((task) => [task.id, task.dependencyIds]));
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(id: string): boolean {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;

    visited.add(id);
    inStack.add(id);

    const dependencies = taskMap.get(id) ?? [];
    for (const dependencyId of dependencies) {
      if (dfs(dependencyId)) return true;
    }

    inStack.delete(id);
    return false;
  }

  for (const task of tasks) {
    if (dfs(task.id)) return true;
  }

  return false;
}

export function addProjectTask(graph: ProjectGraph, input: AddProjectTaskInput): ProjectGraph {
  const id = requireText(input.id, 'a task ID');
  if (graph.tasks.some((task) => task.id === id)) {
    throw new Error(`Project task ${id} already exists.`);
  }
  const dependencyIds = [...new Set(input.dependencyIds ?? [])];
  if (dependencyIds.includes(id)) throw new Error('A task cannot depend on itself.');
  for (const dependencyId of dependencyIds) taskById(graph, dependencyId);
  const description = input.description?.trim();
  const candidateTasks = [
    ...graph.tasks.map((task) => ({ id: task.id, dependencyIds: [...task.dependencyIds] })),
    { id, dependencyIds },
  ];
  if (hasDependencyCycle(candidateTasks)) {
    throw new Error('A task dependency cannot create a circular dependency.');
  }
  return {
    ...cloneProjectGraph(graph),
    tasks: [
      ...graph.tasks.map((task) => ({ ...task, dependencyIds: [...task.dependencyIds] })),
      {
        id,
        title: requireText(input.title, 'a task title'),
        ...(description ? { description } : {}),
        dependencyIds,
        createdAt: input.createdAt,
      },
    ],
    updatedAt: input.createdAt,
  };
}

export function projectTaskState(graph: ProjectGraph, taskId: string): ProjectTaskState {
  const task = taskById(graph, taskId);
  if (task.completedAt) return 'completed';
  return task.dependencyIds.every((dependencyId) => taskById(graph, dependencyId).completedAt)
    ? 'ready'
    : 'blocked';
}

export function setProjectTaskCompletion(
  graph: ProjectGraph,
  taskId: string,
  completed: boolean,
  occurredAt: string,
): ProjectGraph {
  const task = taskById(graph, taskId);
  if (completed && projectTaskState(graph, taskId) === 'blocked') {
    throw new Error('Complete this task’s prerequisites first.');
  }
  if (!completed) {
    const completedDependent = graph.tasks.find(
      (candidate) => candidate.completedAt && candidate.dependencyIds.includes(task.id),
    );
    if (completedDependent) {
      throw new Error(`Reopen ${completedDependent.title} before reopening this task.`);
    }
  }
  return {
    ...cloneProjectGraph(graph),
    tasks: graph.tasks.map((candidate) =>
      candidate.id === taskId
        ? {
            ...candidate,
            dependencyIds: [...candidate.dependencyIds],
            ...(completed ? { completedAt: occurredAt } : { completedAt: undefined }),
          }
        : { ...candidate, dependencyIds: [...candidate.dependencyIds] },
    ),
    updatedAt: occurredAt,
  };
}

export function projectProgress(graph: ProjectGraph): {
  completed: number;
  ready: number;
  blocked: number;
  total: number;
} {
  return graph.tasks.reduce(
    (progress, task) => {
      progress[projectTaskState(graph, task.id)] += 1;
      progress.total += 1;
      return progress;
    },
    { completed: 0, ready: 0, blocked: 0, total: 0 },
  );
}

export function validateProjectGraph(value: unknown): value is ProjectGraph {
  if (!value || typeof value !== 'object') return false;
  const graph = value as Partial<ProjectGraph>;
  if (
    graph.version !== 1 ||
    typeof graph.id !== 'string' ||
    !graph.id.trim() ||
    typeof graph.title !== 'string' ||
    !graph.title.trim() ||
    typeof graph.objective !== 'string' ||
    !graph.objective.trim() ||
    typeof graph.createdAt !== 'string' ||
    typeof graph.updatedAt !== 'string' ||
    !Array.isArray(graph.tasks)
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const task of graph.tasks) {
    if (
      !task ||
      typeof task.id !== 'string' ||
      !task.id.trim() ||
      ids.has(task.id) ||
      typeof task.title !== 'string' ||
      !task.title.trim() ||
      (task.description !== undefined && typeof task.description !== 'string') ||
      !Array.isArray(task.dependencyIds) ||
      !task.dependencyIds.every((id) => typeof id === 'string') ||
      typeof task.createdAt !== 'string' ||
      (task.completedAt !== undefined && typeof task.completedAt !== 'string')
    ) {
      return false;
    }
    ids.add(task.id);
  }
  return (
    !hasDependencyCycle(graph.tasks) &&
    graph.tasks.every(
      (task) =>
        new Set(task.dependencyIds).size === task.dependencyIds.length &&
        !task.dependencyIds.includes(task.id) &&
        task.dependencyIds.every((dependencyId) => ids.has(dependencyId)),
    )
  );
}

export function validateProjectTaskRun(value: unknown): value is ProjectTaskRun {
  if (!value || typeof value !== 'object') return false;
  const run = value as Partial<ProjectTaskRun>;
  const validBase =
    run.version === 1 &&
    typeof run.id === 'string' &&
    Boolean(run.id.trim()) &&
    typeof run.projectId === 'string' &&
    Boolean(run.projectId.trim()) &&
    typeof run.taskId === 'string' &&
    Boolean(run.taskId.trim()) &&
    typeof run.agentId === 'string' &&
    Boolean(run.agentId.trim()) &&
    typeof run.agentName === 'string' &&
    Boolean(run.agentName.trim()) &&
    ['queued', 'running', 'suspended', 'completed', 'failed', 'cancelled'].includes(
      run.status ?? '',
    ) &&
    typeof run.createdAt === 'string' &&
    typeof run.updatedAt === 'string' &&
    (run.startedAt === undefined || typeof run.startedAt === 'string') &&
    (run.runtimeTurnId === undefined || typeof run.runtimeTurnId === 'string') &&
    (run.suspendedAt === undefined || typeof run.suspendedAt === 'string') &&
    (run.completedAt === undefined || typeof run.completedAt === 'string') &&
    (run.output === undefined || typeof run.output === 'string') &&
    (run.failedAt === undefined || typeof run.failedAt === 'string') &&
    (run.failure === undefined || typeof run.failure === 'string') &&
    (run.cancelledAt === undefined || typeof run.cancelledAt === 'string');
  if (!validBase) return false;
  if (run.approval !== undefined) {
    if (
      !run.approval ||
      typeof run.approval.id !== 'string' ||
      typeof run.approval.toolId !== 'string' ||
      typeof run.approval.toolName !== 'string' ||
      typeof run.approval.reason !== 'string'
    ) {
      return false;
    }
  }
  if (run.status === 'suspended') {
    return Boolean(run.startedAt && run.runtimeTurnId && run.suspendedAt && run.approval);
  }
  if (run.status === 'completed') {
    return Boolean(run.startedAt && run.runtimeTurnId && run.completedAt);
  }
  if (run.status === 'failed') return Boolean(run.failedAt && run.failure);
  if (run.status === 'cancelled') return Boolean(run.cancelledAt);
  return run.approval === undefined && run.suspendedAt === undefined;
}

function activeRun(run: ProjectTaskRun): boolean {
  return run.status === 'queued' || run.status === 'running' || run.status === 'suspended';
}

export class ProjectWorkflowRuntime {
  private readonly activeRuns = new Set<string>();
  private readonly activeOperations = new Map<string, Promise<ProjectTaskRun>>();
  private readonly cancellation = new Map<string, AbortController>();
  private readonly cancelling = new Set<string>();

  constructor(
    private readonly projects: ProjectGraphRepository,
    private readonly runs: ProjectTaskRunRepository,
    private readonly workers: ProjectWorkerExecutor,
    private readonly onStateChange: (projectId: string) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = () => `run-${crypto.randomUUID()}`,
  ) {}

  async launch(input: LaunchProjectTaskInput): Promise<ProjectTaskRun> {
    const project = await this.requireProject(input.projectId);
    const task = taskById(project, input.taskId);
    if (projectTaskState(project, task.id) !== 'ready') {
      throw new Error('Only a ready project task can be launched.');
    }
    const existing = await this.runs.list();
    if (
      existing.some(
        (run) =>
          activeRun(run) &&
          ((run.projectId === project.id && run.taskId === task.id) ||
            run.agentId === input.agentId),
      )
    ) {
      throw new Error('This task or agent already has an active worker run.');
    }
    const prepared = await this.workers.prepare(input.agentId);
    const createdAt = this.timestamp();
    const run: ProjectTaskRun = {
      version: 1,
      id: this.createId(),
      projectId: project.id,
      taskId: task.id,
      agentId: input.agentId,
      agentName: requireText(prepared.agentName, 'a worker agent name'),
      status: 'queued',
      createdAt,
      updatedAt: createdAt,
    };
    await this.save(run);
    const controller = new AbortController();
    this.cancellation.set(run.id, controller);
    const operation = this.drive(
      run,
      project,
      task,
      this.workers.execute({ run, project, task }, controller.signal),
    );
    this.activeOperations.set(run.id, operation);
    void operation.finally(() => this.activeOperations.delete(run.id));
    return operation;
  }

  async resolveApproval(approvalId: string, decision: 'approve' | 'deny'): Promise<ProjectTaskRun> {
    const run = (await this.runs.list()).find(
      (candidate) => candidate.status === 'suspended' && candidate.approval?.id === approvalId,
    );
    if (!run) throw new Error(`No suspended project worker matches ${approvalId}.`);
    const project = await this.requireProject(run.projectId);
    const task = taskById(project, run.taskId);
    const resumed: ProjectTaskRun = {
      ...cloneProjectTaskRun(run),
      status: 'running',
      updatedAt: this.timestamp(),
      suspendedAt: undefined,
      approval: undefined,
    };
    await this.save(resumed);
    const operation = this.drive(
      resumed,
      project,
      task,
      this.workers.resume(
        { run: resumed, project, task },
        approvalId,
        decision,
        this.controllerFor(resumed.id).signal,
      ),
    );
    this.activeOperations.set(resumed.id, operation);
    void operation.finally(() => this.activeOperations.delete(resumed.id));
    return operation;
  }

  async cancel(runId: string): Promise<ProjectTaskRun> {
    const run = await this.runs.get(runId);
    if (!run || !activeRun(run)) throw new Error('Only an active project worker can be cancelled.');
    this.cancelling.add(run.id);
    this.cancellation.get(run.id)?.abort();
    await this.workers.cancel(run);
    const operation = this.activeOperations.get(run.id);
    if (operation) return operation;
    return this.markCancelled(run);
  }

  async reconcile(projectId?: string): Promise<ProjectTaskRun[]> {
    const stored = await this.runs.list(projectId);
    for (const run of stored) {
      if (!activeRun(run) || this.activeRuns.has(run.id)) continue;
      try {
        const recovery = await this.workers.recover(run);
        await this.applyRecovery(run, recovery);
      } catch (error) {
        await this.fail(run, error);
      }
    }
    return this.runs.list(projectId);
  }

  async suspendedForApproval(approvalId: string): Promise<ProjectTaskRun | null> {
    return (
      (await this.runs.list()).find(
        (run) => run.status === 'suspended' && run.approval?.id === approvalId,
      ) ?? null
    );
  }

  private async drive(
    initial: ProjectTaskRun,
    project: ProjectGraph,
    task: ProjectTask,
    events: AsyncIterable<ProjectWorkerEvent>,
  ): Promise<ProjectTaskRun> {
    if (this.activeRuns.has(initial.id)) throw new Error('This worker run is already active.');
    this.activeRuns.add(initial.id);
    let run = cloneProjectTaskRun(initial);
    try {
      if (run.status === 'queued') {
        const startedAt = this.timestamp();
        run = { ...run, status: 'running', startedAt, updatedAt: startedAt };
        await this.save(run);
      }
      for await (const event of events) {
        if (event.type === 'started') {
          run = { ...run, runtimeTurnId: event.runtimeTurnId, updatedAt: this.timestamp() };
          await this.save(run);
        } else if (event.type === 'approval-required') {
          const suspendedAt = this.timestamp();
          run = {
            ...run,
            status: 'suspended',
            runtimeTurnId: event.runtimeTurnId,
            suspendedAt,
            approval: { ...event.approval },
            updatedAt: suspendedAt,
          };
          await this.save(run);
        } else {
          run = await this.complete(run, project, task, event.runtimeTurnId, event.output);
        }
      }
      if (run.status === 'running') {
        throw new Error('The project worker stopped without a final runtime state.');
      }
      return cloneProjectTaskRun(run);
    } catch (error) {
      if (this.cancelling.has(initial.id)) return this.markCancelled(run);
      return this.fail(run, error);
    } finally {
      this.activeRuns.delete(initial.id);
      this.cancellation.delete(initial.id);
      this.cancelling.delete(initial.id);
    }
  }

  private async applyRecovery(run: ProjectTaskRun, recovery: ProjectWorkerRecovery): Promise<void> {
    if (recovery.status === 'failed') {
      await this.fail(run, recovery.failure);
      return;
    }
    if (recovery.status === 'completed') {
      const project = await this.requireProject(run.projectId);
      const task = taskById(project, run.taskId);
      await this.complete(
        run,
        project,
        task,
        recovery.runtimeTurnId,
        recovery.output ?? run.output ?? '',
      );
      return;
    }
    if (recovery.status === 'suspended') {
      const suspendedAt = run.suspendedAt ?? this.timestamp();
      await this.save({
        ...run,
        status: 'suspended',
        runtimeTurnId: recovery.runtimeTurnId,
        suspendedAt,
        approval: { ...recovery.approval },
        updatedAt: this.timestamp(),
      });
      return;
    }
    await this.save({
      ...run,
      status: 'running',
      runtimeTurnId: recovery.runtimeTurnId,
      startedAt: run.startedAt ?? this.timestamp(),
      updatedAt: this.timestamp(),
      suspendedAt: undefined,
      approval: undefined,
    });
  }

  private async complete(
    run: ProjectTaskRun,
    project: ProjectGraph,
    task: ProjectTask,
    runtimeTurnId: string,
    output: string,
  ): Promise<ProjectTaskRun> {
    const completedAt = this.timestamp();
    const completed: ProjectTaskRun = {
      ...run,
      status: 'completed',
      runtimeTurnId,
      completedAt,
      output,
      updatedAt: completedAt,
      suspendedAt: undefined,
      approval: undefined,
      failedAt: undefined,
      failure: undefined,
    };
    const current = (await this.projects.get(project.id)) ?? project;
    const currentTask = taskById(current, task.id);
    const progressed = currentTask.completedAt
      ? current
      : setProjectTaskCompletion(current, task.id, true, completedAt);
    await this.projects.save(progressed);
    await this.save(completed);
    return completed;
  }

  private async fail(run: ProjectTaskRun, error: unknown): Promise<ProjectTaskRun> {
    const failedAt = this.timestamp();
    const failed: ProjectTaskRun = {
      ...cloneProjectTaskRun(run),
      status: 'failed',
      failedAt,
      failure: error instanceof Error ? error.message : String(error),
      updatedAt: failedAt,
      suspendedAt: undefined,
      approval: undefined,
      completedAt: undefined,
      output: undefined,
      cancelledAt: undefined,
    };
    await this.save(failed);
    return failed;
  }

  private async markCancelled(run: ProjectTaskRun): Promise<ProjectTaskRun> {
    const cancelledAt = this.timestamp();
    const cancelled: ProjectTaskRun = {
      ...cloneProjectTaskRun(run),
      status: 'cancelled',
      cancelledAt,
      updatedAt: cancelledAt,
      suspendedAt: undefined,
      approval: undefined,
      completedAt: undefined,
      failedAt: undefined,
      failure: undefined,
      output: undefined,
    };
    await this.save(cancelled);
    return cancelled;
  }

  private controllerFor(runId: string): AbortController {
    const existing = this.cancellation.get(runId);
    if (existing) return existing;
    const controller = new AbortController();
    this.cancellation.set(runId, controller);
    return controller;
  }

  private async requireProject(projectId: string): Promise<ProjectGraph> {
    const project = await this.projects.get(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return project;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async save(run: ProjectTaskRun): Promise<void> {
    await this.runs.save(run);
    this.onStateChange(run.projectId);
  }
}
