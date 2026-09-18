import {
  projectTaskVersion,
  projectResultVersion,
  requireProjectQualityCoverage,
  validQualityReviews,
  validQualityRejections,
  projectRepairProposal,
  type ProjectQualityReview,
  type ProjectQualityRejection,
  type QualityReviewInput,
  type QualityReviewReceipt,
} from './qualityReview';
export * from './qualityReview';
export * from './retention';
import { previousQualityVersion } from './retention';
import {
  checkProjectResults,
  cloneProjectChecks,
  sameProjectChecks,
  validProjectChecks,
  validProjectCheckReports,
  requireUnchangedProjectCheckEvidence,
  type ProjectResultCheck,
  type ProjectCheckReport,
  type ProjectResultChecker,
} from './resultChecks';
export * from './resultChecks';
export * from './projectQueue';
export * from './projectRunOrder';
import {
  occupiesProjectExecution,
  projectWorkerRunReservationOwner,
  ProjectWorkerBusyError,
  ProjectWorkerNotLaunchedError,
  type ProjectWorkerReservation,
} from './projectQueue';
import { isNewerProjectRun } from './projectRunOrder';

export interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  resultChecks?: ProjectResultCheck[];
  turnLimit?: number;
  /** A real wall-clock budget for one worker run. Omit for no time limit. */
  timeLimitMinutes?: number;
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
  | 'queued'
  | 'running'
  | 'suspended'
  | 'awaiting-review'
  | 'needs-attention'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

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
  returnedAt?: string;
  stopReason?: 'tool-limit' | 'check-failed' | 'check-error';
  checkReports?: ProjectCheckReport[];
  acceptanceCriteria?: string;
  resultChecks?: ProjectResultCheck[];
  turnLimit?: number;
  turnsUsed?: number;
  timeLimitMinutes?: number;
  deadlineAt?: string;
  pauseRequested?: boolean;
  pausedAt?: string;
  previousRunId?: string;
  previousQualityVersion?: string;
  continuation?: string;
  qualityReviews?: ProjectQualityReview[];
  qualityRejections?: ProjectQualityRejection[];
  verification?: {
    method: 'human-review';
    reviewedAt: string;
    note: string;
    checkReport?: ProjectCheckReport;
  };
}

/** Internal review receipt, created by the runtime from actual reads, never worker output. */
export interface ProjectRunReviewEvidence {
  expectedRun: ProjectTaskRun;
  checkReport?: ProjectCheckReport;
}

export interface ProjectRunCommitter {
  reviewQuality?(runId: string, receipt: QualityReviewReceipt): Promise<ProjectTaskRun>;
  attemptVerify?(
    runId: string,
    note: string,
    at: string,
    evidence: ProjectRunReviewEvidence,
    rejectionId: string,
  ): Promise<{ run: ProjectTaskRun; error?: string }>;
  reserve?(run: ProjectTaskRun): Promise<void>;
  pause?(runId: string, at: string): Promise<ProjectTaskRun>;
  resume?(runId: string, at: string): Promise<ProjectTaskRun>;
  verify(
    runId: string,
    note: string,
    reviewedAt: string,
    evidence?: ProjectRunReviewEvidence,
  ): Promise<ProjectTaskRun>;
}

export interface ProjectTaskRunRepository {
  list(projectId?: string): Promise<ProjectTaskRun[]>;
  get(id: string): Promise<ProjectTaskRun | null>;
  save(run: ProjectTaskRun): Promise<void>;
}

/**
 * IRIS Phase 2I.2 — a durable project run had already reached a terminal state when a stale
 * execution continuation tried to write a different state over it. The write was refused inside
 * the repository transaction, and the terminal record is carried here so the caller can adopt
 * durable truth instead of resurrecting the run.
 */
export class ProjectRunStateConflictError extends Error {
  constructor(readonly durable: ProjectTaskRun) {
    super(
      `The project run ${durable.id} is already ${durable.status}; a later execution state cannot overwrite it.`,
    );
    this.name = 'ProjectRunStateConflictError';
  }
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

/**
 * The real state machine of one scheduled occurrence:
 *
 * ```
 * queued ──claim──▶ running ──approval-required──▶ suspended ──resolve──▶ running ──▶ terminal
 *    │                  │                              │
 *    └──────────────────┴──────────────────────────────┴──▶ failed (never a silent replay)
 * ```
 *
 * `running` is the only state that means work is happening right now. `suspended` means the agent
 * turn stopped on an approval and nothing runs until that decision arrives — including one made on a
 * different surface, which is why a suspended run is reconciled against its recorded approval and
 * turn before it is allowed to block anything. The terminal states are the existing `completed` and
 * `failed`; a run is never replayed after an interruption whose outcome is unknown.
 */
export type ScheduledRunStatus = 'queued' | 'running' | 'suspended' | 'completed' | 'failed';

export interface ScheduledRun {
  queueVersion?: 1;
  executionClaimedAt?: string;
  retrySafe?: boolean;
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
  /**
   * The agent turn this run started. Together with `approvalId` and `agentId` it correlates the run
   * with exactly one turn's outcome, so a terminal state can be recovered without guessing which
   * transcript looks newest.
   */
  turnId?: string;
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

export type ScheduledRunEvent =
  | { type: 'started'; turnId?: string }
  | { type: 'approval-required'; approvalId: string }
  | { type: 'completed'; output: string };

/**
 * What actually happened to a run recorded as `suspended`. `suspended` means it is genuinely still
 * waiting; the terminal variants describe an outcome already produced by the agent turn.
 */
export type ScheduledRunReconciliation =
  /** Still waiting. `approvalId` re-correlates the run when the pending decision changed. */
  | { status: 'suspended'; approvalId?: string }
  | { status: 'completed'; output: string }
  | { status: 'failed'; failure: string };

export interface ScheduleRunner {
  available?(agentId: string): Promise<boolean>;
  /** Read-only configuration checks; this method must not execute the agent or tools. */
  prepare?(input: { schedule: ScheduleDefinition; run: ScheduledRun }): Promise<void>;
  run(input: {
    schedule: ScheduleDefinition;
    run: ScheduledRun;
  }): AsyncIterable<ScheduledRunEvent>;
  resume(
    input: { schedule: ScheduleDefinition; run: ScheduledRun },
    approvalId: string,
    decision: 'approve' | 'deny',
  ): AsyncIterable<ScheduledRunEvent>;
  /**
   * Reports the real state of a suspended run without running anything. Called before a suspended run
   * may block new work, so a run whose approval was resolved on another surface — or whose approval
   * and turn are both gone — can never strand its agent as permanently busy.
   */
  reconcileSuspended?(run: ScheduledRun): Promise<ScheduledRunReconciliation>;
}

export interface ScheduleQueueCommitter {
  enqueue(
    schedule: ScheduleDefinition,
    run: ScheduledRun,
    next: ScheduleDefinition,
  ): Promise<ScheduledRun | null>;
  claim(
    runId: string,
    at: string,
    status: 'queued' | 'failed' | 'suspended',
  ): Promise<ScheduledRun | null>;
}
export interface ScheduleDispatcherOptions {
  now?: () => Date;
  id?: () => string;
  onChange?: () => void;
  isPaused?: () => Promise<boolean>;
  queue?: ScheduleQueueCommitter;
}

/** Durable queue. All effects follow a persisted execution claim. */
export class ScheduleDispatcher {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly onChange: () => void;
  private ticking = false;
  private readonly active = new Set<string>();
  constructor(
    private readonly schedules: ScheduleRepository,
    private readonly runs: ScheduledRunRepository,
    private readonly runner: ScheduleRunner,
    private readonly options: ScheduleDispatcherOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => `scheduled-run-${crypto.randomUUID()}`);
    this.onChange = options.onChange ?? (() => undefined);
  }
  /** The host must acquire exclusive schedule ownership before reconciliation. */
  async reconcile(): Promise<void> {
    for (const run of await this.runs.list()) {
      if (this.active.has(run.id)) continue;
      if (run.status === 'suspended') {
        await this.reconcileSuspendedRun(run);
        continue;
      }
      if (!['queued', 'running'].includes(run.status)) continue;
      if (
        run.status === 'queued' &&
        run.queueVersion === 1 &&
        !run.startedAt &&
        !run.executionClaimedAt
      )
        continue;
      await this.runs.save({
        ...run,
        status: 'failed',
        retryAt: undefined,
        retrySafe: false,
        failedAt: this.now().toISOString(),
        updatedAt: this.now().toISOString(),
        failure:
          run.startedAt || run.executionClaimedAt
            ? `IRIS stopped while this run was executing (started at ${run.startedAt ?? run.executionClaimedAt}). Inspect its actual outcome before creating new work.`
            : 'This older queue entry has no durable execution claim. Its outcome is unknown; it will not be replayed automatically.',
      });
    }
    this.onChange();
  }
  async tick(): Promise<ScheduledRun[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      if (await this.options.isPaused?.()) return [];
      const now = this.now();
      // Materialize every due occurrence before running any worker, so slow jobs do not lose later jobs.
      for (const schedule of await this.schedules.list()) {
        if (!schedule.enabled || !schedule.nextRunAt || new Date(schedule.nextRunAt) > now)
          continue;
        const existing = (await this.runs.list(schedule.id)).find(
          (run) => run.scheduledFor === schedule.nextRunAt,
        );
        const run: ScheduledRun = existing ?? {
          version: 1,
          queueVersion: 1,
          id: this.id(),
          scheduleId: schedule.id,
          agentId: schedule.agentId,
          prompt: schedule.prompt,
          status: 'queued',
          scheduledFor: schedule.nextRunAt,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          attempt: 1,
          maxAttempts: schedule.maxAttempts ?? 1,
        };
        const next: ScheduleDefinition = {
          ...schedule,
          enabled: schedule.recurrence === 'once' ? false : schedule.enabled,
          nextRunAt:
            schedule.recurrence === 'idle'
              ? undefined
              : nextScheduleRun(schedule, new Date(schedule.nextRunAt)),
          updatedAt: now.toISOString(),
        };
        if (this.options.queue) await this.options.queue.enqueue(schedule, run, next);
        else {
          if (!existing) await this.runs.save(run);
          await this.schedules.save(next);
        }
        this.onChange();
      }
      // Reconcile before selecting work: a `suspended` run that can no longer be resumed would
      // otherwise make the same-agent guard below skip every future occurrence of that agent's
      // schedule, permanently. Reconciliation never runs anything; it only records what happened.
      for (const run of await this.runs.list()) {
        if (run.status === 'suspended' && !this.active.has(run.id)) {
          await this.reconcileSuspendedRun(run);
        }
      }
      const results: ScheduledRun[] = [];
      const pending = (await this.runs.list()).filter(
        (run) =>
          run.status === 'queued' ||
          (run.status === 'failed' &&
            run.retrySafe === true &&
            !!run.retryAt &&
            new Date(run.retryAt) <= now),
      );
      pending.sort(
        (a, b) =>
          a.scheduledFor.localeCompare(b.scheduledFor) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
      for (const run of pending) {
        if (await this.options.isPaused?.()) break;
        if (this.active.has(run.id)) continue;
        const schedule = await this.schedules.get(run.scheduleId);
        if (!schedule) {
          await this.runs.save({
            ...run,
            status: 'failed',
            retryAt: undefined,
            retrySafe: false,
            failure: 'The schedule was removed before this queued job started.',
            failedAt: this.now().toISOString(),
            updatedAt: this.now().toISOString(),
          });
          this.onChange();
          continue;
        }
        if (run.queueVersion !== 1 && run.retrySafe !== true) continue;
        if (
          (await this.runs.list()).some(
            (other) =>
              other.id !== run.id &&
              other.agentId === run.agentId &&
              ['running', 'suspended'].includes(other.status),
          )
        )
          continue;
        if (this.runner.available && !(await this.runner.available(run.agentId))) continue;
        // A saved occurrence retains its original prompt and agent even if future occurrences are edited.
        const snapshot = { ...schedule, prompt: run.prompt, agentId: run.agentId };
        this.active.add(run.id);
        try {
          let prepared = run;
          if (run.status === 'failed') prepared = { ...run, attempt: (run.attempt ?? 1) + 1 };
          try {
            await this.runner.prepare?.({ schedule: snapshot, run: prepared });
          } catch (error) {
            results.push(await this.fail(prepared, error, true));
            continue;
          }
          const claimed = await this.claim(run, run.status === 'failed' ? 'failed' : 'queued');
          if (!claimed) continue;
          results.push(
            await this.consume(claimed, () =>
              this.runner.run({ schedule: snapshot, run: claimed }),
            ),
          );
        } finally {
          this.active.delete(run.id);
        }
      }
      return results;
    } finally {
      this.ticking = false;
    }
  }
  /**
   * Records a terminal outcome that was observed outside this dispatcher — an approval resolved from
   * the global permissions surface, a chat window, or a remote channel. It never resumes the run
   * again, so the agent turn cannot be started twice; a run that is no longer suspended (or a
   * `suspended` reconciliation) leaves the stored state untouched.
   */
  async settleSuspended(
    runId: string,
    resolution: ScheduledRunReconciliation,
  ): Promise<ScheduledRun> {
    const run = await this.runs.get(runId);
    if (!run) throw new Error(`Unknown scheduled run: ${runId}.`);
    if (run.status !== 'suspended' || this.active.has(runId)) return run;
    if (resolution.status === 'suspended') {
      if (!resolution.approvalId || resolution.approvalId === run.approvalId) return run;
      const recalled = {
        ...run,
        approvalId: resolution.approvalId,
        updatedAt: this.now().toISOString(),
      };
      await this.runs.save(recalled);
      this.onChange();
      return recalled;
    }
    return this.applyResolution(run, resolution);
  }

  /** Ask the runner what really happened; record it only when the answer is terminal. */
  private async reconcileSuspendedRun(run: ScheduledRun): Promise<void> {
    if (!this.runner.reconcileSuspended) return;
    const resolution = await this.runner.reconcileSuspended(run);
    if (resolution.status === 'suspended') return;
    await this.applyResolution(run, resolution);
  }

  private async applyResolution(
    run: ScheduledRun,
    resolution: { status: 'completed'; output: string } | { status: 'failed'; failure: string },
  ): Promise<ScheduledRun> {
    const at = this.now().toISOString();
    const settled: ScheduledRun =
      resolution.status === 'completed'
        ? {
            ...run,
            status: 'completed',
            output: resolution.output,
            completedAt: at,
            updatedAt: at,
            approvalId: undefined,
            retryAt: undefined,
            retrySafe: false,
          }
        : {
            ...run,
            status: 'failed',
            failure: resolution.failure,
            failedAt: at,
            updatedAt: at,
            approvalId: undefined,
            // Never retried automatically: the real outcome of the interrupted turn is unknown, and
            // re-running it could duplicate whatever it already did.
            retryAt: undefined,
            retrySafe: false,
          };
    await this.runs.save(settled);
    this.onChange();
    return settled;
  }

  async resolveApproval(runId: string, decision: 'approve' | 'deny'): Promise<ScheduledRun> {
    if (this.active.has(runId)) throw new Error('This scheduled run is already being resumed.');
    this.active.add(runId);
    try {
      const run = await this.runs.get(runId);
      if (!run || run.status !== 'suspended' || !run.approvalId)
        throw new Error('This scheduled run is not waiting for approval.');
      const schedule = await this.schedules.get(run.scheduleId);
      if (!schedule) throw new Error('The schedule for this run is no longer available.');
      const claimed = await this.claim(run, 'suspended');
      if (!claimed) throw new Error('This scheduled run was claimed elsewhere. Refresh its state.');
      return this.consume(claimed, () =>
        this.runner.resume(
          { schedule: { ...schedule, prompt: run.prompt, agentId: run.agentId }, run: claimed },
          run.approvalId!,
          decision,
        ),
      );
    } finally {
      this.active.delete(runId);
    }
  }
  private async claim(
    run: ScheduledRun,
    status: 'queued' | 'failed' | 'suspended',
  ): Promise<ScheduledRun | null> {
    const at = this.now().toISOString();
    if (this.options.queue) return this.options.queue.claim(run.id, at, status);
    const current = await this.runs.get(run.id);
    if (!current || current.status !== status) return null;
    const claimed = claimScheduledRun(current, at);
    await this.runs.save(claimed);
    this.onChange();
    return claimed;
  }
  private async consume(
    run: ScheduledRun,
    events: () => ReturnType<ScheduleRunner['run']>,
  ): Promise<ScheduledRun> {
    try {
      for await (const event of events()) {
        const at = this.now().toISOString();
        if (event.type === 'started')
          run = {
            ...run,
            status: 'running',
            updatedAt: at,
            ...(event.turnId ? { turnId: event.turnId } : {}),
          };
        else if (event.type === 'approval-required')
          run = { ...run, status: 'suspended', approvalId: event.approvalId, updatedAt: at };
        else
          run = {
            ...run,
            status: 'completed',
            output: event.output,
            completedAt: at,
            updatedAt: at,
            approvalId: undefined,
          };
        await this.runs.save(run);
        this.onChange();
      }
      if (run.status === 'running')
        throw new Error('The scheduled worker stopped without a final outcome.');
      return run;
    } catch (error) {
      return this.fail(run, error, false);
    }
  }
  private async fail(run: ScheduledRun, error: unknown, retrySafe: boolean): Promise<ScheduledRun> {
    const at = this.now();
    const failed: ScheduledRun = {
      ...run,
      status: 'failed',
      failedAt: at.toISOString(),
      updatedAt: at.toISOString(),
      failure: error instanceof Error ? error.message : String(error),
      retrySafe,
      retryAt:
        retrySafe && (run.attempt ?? 1) < (run.maxAttempts ?? 1)
          ? new Date(at.getTime() + (run.attempt ?? 1) * 60_000).toISOString()
          : undefined,
    };
    await this.runs.save(failed);
    this.onChange();
    return failed;
  }
}

export function claimScheduledRun(run: ScheduledRun, at: string): ScheduledRun {
  if (run.status === 'failed' && (!run.retrySafe || (run.attempt ?? 1) >= (run.maxAttempts ?? 1)))
    throw new Error('This run cannot be retried safely.');
  return {
    ...run,
    queueVersion: 1,
    status: 'running',
    startedAt: run.startedAt ?? at,
    executionClaimedAt: at,
    updatedAt: at,
    retryAt: undefined,
    retrySafe: false,
    failure: undefined,
    failedAt: undefined,
    attempt: (run.attempt ?? 1) + (run.status === 'failed' ? 1 : 0),
  };
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
    (run.queueVersion === undefined || run.queueVersion === 1) &&
    (run.retrySafe === undefined || typeof run.retrySafe === 'boolean') &&
    (run.executionClaimedAt === undefined ||
      (typeof run.executionClaimedAt === 'string' &&
        !Number.isNaN(Date.parse(run.executionClaimedAt)))) &&
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
  previousRun?: ProjectTaskRun;
}

export type ProjectWorkerEvent =
  | { type: 'started'; runtimeTurnId: string }
  | {
      type: 'approval-required';
      runtimeTurnId: string;
      approval: ProjectTaskRunApproval;
    }
  | { type: 'returned'; runtimeTurnId: string; output: string; stopReason?: 'tool-limit' };

export type ProjectWorkerRecovery =
  | { status: 'running'; runtimeTurnId: string }
  | {
      status: 'suspended';
      runtimeTurnId: string;
      approval: ProjectTaskRunApproval;
    }
  | { status: 'returned'; runtimeTurnId: string; output?: string; stopReason?: 'tool-limit' }
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
  continue?(
    input: ProjectWorkerExecutionInput,
    signal?: AbortSignal,
  ): AsyncIterable<ProjectWorkerEvent>;
  cancel(run: ProjectTaskRun): Promise<void>;
  recover(run: ProjectTaskRun): Promise<ProjectWorkerRecovery>;
}

export interface LaunchProjectTaskInput {
  projectId: string;
  taskId: string;
  agentId: string;
  previousRunId?: string;
  expectedPreviousRun?: ProjectTaskRun;
  continuation?: string;
  /**
   * A queue entry that already holds this agent's exclusive reservation and is handing ownership to
   * the run this launch creates. Omitted for a direct launch, which reserves on its own.
   */
  reservationOwnerId?: string;
  /**
   * Called once the worker run record is durable and before the worker starts executing.
   *
   * This is the launch boundary: from here the run exists, so a dispatcher can persist the real run
   * identity before any work happens rather than only after the worker returns. A rejection or a
   * failure here never fails the launch — the run is already real.
   */
  onRunCreated?: (run: ProjectTaskRun) => void | Promise<void>;
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
  acceptanceCriteria?: string;
  resultChecks?: ProjectResultCheck[];
  turnLimit?: number;
  timeLimitMinutes?: number;
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
    tasks: graph.tasks.map((task) => ({
      ...task,
      resultChecks: cloneProjectChecks(task.resultChecks),
      dependencyIds: [...task.dependencyIds],
    })),
  };
}

export function cloneProjectTaskRun(run: ProjectTaskRun): ProjectTaskRun {
  return {
    ...run,
    ...(run.qualityReviews ? { qualityReviews: structuredClone(run.qualityReviews) } : {}),
    ...(run.qualityRejections ? { qualityRejections: structuredClone(run.qualityRejections) } : {}),
    resultChecks: cloneProjectChecks(run.resultChecks),
    checkReports: run.checkReports?.map((report) => ({
      ...report,
      results: report.results.map((result) => ({ ...result })),
    })),
    ...(run.verification
      ? {
          verification: {
            ...run.verification,
            ...(run.verification.checkReport
              ? { checkReport: structuredClone(run.verification.checkReport) }
              : {}),
          },
        }
      : {}),
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
  if (input.resultChecks !== undefined && !validProjectChecks(input.resultChecks))
    throw new Error('Choose up to eight valid result checks.');
  if (input.turnLimit !== undefined && !validTurnLimit(input.turnLimit))
    throw new Error('Choose a turn limit from 1 to 10.');
  if (input.timeLimitMinutes !== undefined && !validTimeLimit(input.timeLimitMinutes))
    throw new Error('Choose a time limit from 1 to 1,440 minutes.');
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
      ...graph.tasks.map((task) => ({
        ...task,
        resultChecks: cloneProjectChecks(task.resultChecks),
        dependencyIds: [...task.dependencyIds],
      })),
      {
        id,
        title: requireText(input.title, 'a task title'),
        ...(description ? { description } : {}),
        ...(input.acceptanceCriteria?.trim()
          ? { acceptanceCriteria: input.acceptanceCriteria.trim() }
          : {}),
        ...(input.resultChecks?.length
          ? { resultChecks: cloneProjectChecks(input.resultChecks) }
          : {}),
        ...(input.turnLimit !== undefined ? { turnLimit: input.turnLimit } : {}),
        ...(input.timeLimitMinutes !== undefined
          ? { timeLimitMinutes: input.timeLimitMinutes }
          : {}),
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
  updatedAt: string,
): ProjectGraph {
  const task = taskById(graph, taskId);
  if (completed && (task.acceptanceCriteria?.trim() || task.resultChecks?.length))
    throw new Error(
      'This task requires a saved run and explicit criterion review before completion.',
    );
  return updateProjectTaskCompletion(graph, taskId, completed, updatedAt);
}

function updateProjectTaskCompletion(
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
      (task.acceptanceCriteria !== undefined && typeof task.acceptanceCriteria !== 'string') ||
      (task.resultChecks !== undefined && !validProjectChecks(task.resultChecks)) ||
      (task.turnLimit !== undefined && !validTurnLimit(task.turnLimit)) ||
      (task.timeLimitMinutes !== undefined && !validTimeLimit(task.timeLimitMinutes)) ||
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
    [
      'queued',
      'running',
      'suspended',
      'awaiting-review',
      'needs-attention',
      'paused',
      'completed',
      'failed',
      'cancelled',
    ].includes(run.status ?? '') &&
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
  if (
    run.qualityReviews !== undefined &&
    !validQualityReviews(run.qualityReviews, run as ProjectTaskRun)
  )
    return false;
  if (run.qualityRejections !== undefined && !validQualityRejections(run.qualityRejections))
    return false;
  if (run.turnLimit !== undefined && !validTurnLimit(run.turnLimit)) return false;
  if (run.timeLimitMinutes !== undefined && !validTimeLimit(run.timeLimitMinutes)) return false;
  if (
    run.deadlineAt !== undefined &&
    (typeof run.deadlineAt !== 'string' || Number.isNaN(Date.parse(run.deadlineAt)))
  )
    return false;
  if ((run.timeLimitMinutes === undefined) !== (run.deadlineAt === undefined)) return false;
  if (
    run.turnsUsed !== undefined &&
    (!Number.isInteger(run.turnsUsed) || run.turnsUsed < 0 || run.turnsUsed > (run.turnLimit ?? 1))
  )
    return false;
  if (run.pauseRequested !== undefined && typeof run.pauseRequested !== 'boolean') return false;
  if (run.pausedAt !== undefined && typeof run.pausedAt !== 'string') return false;
  if (
    run.stopReason !== undefined &&
    !['tool-limit', 'check-failed', 'check-error'].includes(run.stopReason)
  )
    return false;
  if (run.resultChecks !== undefined && !validProjectChecks(run.resultChecks)) return false;
  if (
    run.checkReports !== undefined &&
    !validProjectCheckReports(run.checkReports, run.resultChecks ?? [])
  )
    return false;
  const latestCheck = run.checkReports?.at(-1);
  if (
    run.stopReason === 'check-failed' &&
    (!latestCheck ||
      latestCheck.runtimeTurnId !== run.runtimeTurnId ||
      !latestCheck.results.some((result) => result.status === 'failed'))
  )
    return false;
  if (
    run.stopReason === 'check-error' &&
    (!latestCheck ||
      latestCheck.runtimeTurnId !== run.runtimeTurnId ||
      !latestCheck.results.some((result) => result.status === 'error'))
  )
    return false;
  if (
    run.resultChecks?.length &&
    ['awaiting-review', 'completed'].includes(run.status ?? '') &&
    (!latestCheck ||
      latestCheck.runtimeTurnId !== run.runtimeTurnId ||
      latestCheck.results.some((result) => result.status !== 'passed'))
  )
    return false;
  for (const value of [
    run.returnedAt,
    run.acceptanceCriteria,
    run.previousRunId,
    run.previousQualityVersion,
    run.continuation,
  ]) {
    if (value !== undefined && typeof value !== 'string') return false;
  }
  if (
    run.verification !== undefined &&
    (!run.verification ||
      run.verification.method !== 'human-review' ||
      typeof run.verification.reviewedAt !== 'string' ||
      Number.isNaN(Date.parse(run.verification.reviewedAt)) ||
      typeof run.verification.note !== 'string' ||
      !run.verification.note.trim() ||
      run.status !== 'completed')
  )
    return false;
  // Older completed runs may lack this receipt; do not invent historical verification.
  if (run.verification?.checkReport !== undefined) {
    if (!run.resultChecks?.length) return false;
    try {
      requireUnchangedProjectCheckEvidence(
        run.resultChecks,
        latestCheck,
        run.verification.checkReport,
        run.runtimeTurnId,
        run.verification.reviewedAt,
      );
    } catch {
      return false;
    }
  }
  if (run.status === 'paused') {
    return (
      Boolean(run.startedAt && run.pausedAt && run.runtimeTurnId && run.returnedAt) &&
      !Number.isNaN(Date.parse(run.pausedAt!)) &&
      typeof run.output === 'string' &&
      !run.approval &&
      !run.suspendedAt &&
      !run.completedAt &&
      (run.stopReason === 'tool-limit' || run.stopReason === 'check-failed') &&
      (run.turnsUsed ?? 0) > 0 &&
      (run.turnsUsed ?? 1) < (run.turnLimit ?? 1)
    );
  }
  if (run.status === 'awaiting-review' || run.status === 'needs-attention') {
    return (
      Boolean(run.startedAt && run.runtimeTurnId && run.returnedAt) &&
      typeof run.output === 'string' &&
      !run.completedAt &&
      !run.approval &&
      !run.suspendedAt &&
      (run.status === 'needs-attention' ? Boolean(run.stopReason) : !run.stopReason)
    );
  }
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
  private readonly deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly timedOut = new Set<string>();
  private readonly cancelling = new Set<string>();

  constructor(
    private readonly projects: ProjectGraphRepository,
    private readonly runs: ProjectTaskRunRepository,
    private readonly workers: ProjectWorkerExecutor,
    private readonly onStateChange: (projectId: string) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = () => `run-${crypto.randomUUID()}`,
    private readonly runCommitter?: ProjectRunCommitter,
    private readonly resultChecker?: ProjectResultChecker,
    private readonly reservations?: ProjectWorkerReservation,
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
    const previousRun = input.previousRunId ? await this.runs.get(input.previousRunId) : null;
    if (
      input.previousRunId &&
      (!previousRun ||
        previousRun.projectId !== project.id ||
        previousRun.taskId !== task.id ||
        !['awaiting-review', 'needs-attention', 'failed', 'cancelled'].includes(previousRun.status))
    ) {
      throw new Error('Choose a stopped run of this task to continue.');
    }
    if (
      previousRun &&
      existing.some(
        (other) =>
          other.projectId === project.id &&
          other.taskId === task.id &&
          other.id !== previousRun.id &&
          (other.previousRunId === previousRun.id || isNewerProjectRun(other, previousRun)),
      )
    ) {
      throw new Error('A newer run exists for this task. Continue that run instead.');
    }
    if (
      input.expectedPreviousRun &&
      (!previousRun || !sameProjectRunSnapshot(previousRun, input.expectedPreviousRun))
    )
      throw new Error('The repair source changed. Refresh the proposal.');
    // §9 — take the exclusive reservation for this agent *before* the expensive provider/keyring
    // preparation, so two simultaneous launches cannot both observe the agent as free and both
    // prepare. A queue entry that already reserved the agent hands its ownership to this run.
    const runId = this.createId();
    const reservationOwner = projectWorkerRunReservationOwner(runId);
    const preparationOwner = input.reservationOwnerId ?? reservationOwner;
    if (this.reservations) {
      const held = input.reservationOwnerId
        ? this.reservations.transfer(
            input.agentId,
            input.reservationOwnerId,
            reservationOwner,
            this.timestamp(),
            runId,
          )
        : this.reservations.reserve(input.agentId, reservationOwner, this.timestamp());
      if (!held)
        throw new ProjectWorkerBusyError(input.agentId, this.reservations.holder(input.agentId)?.ownerId);
      // Phase 2H.1 — the local reservation is provisional until the cross-process authority
      // confirms no other live IRIS process is executing this agent. A refusal here is a busy
      // outcome for the launch, never a concurrent execution.
      if (this.reservations.crossProcess) {
        let acquired: boolean;
        try {
          acquired = await this.reservations.crossProcess.acquire(
            input.agentId,
            reservationOwner,
            this.timestamp(),
          );
        } catch (error) {
          // Phase 2J.2 / F-2J2-SCH-01 — an authority that cannot be evaluated (a corrupt lease
          // document, a failing process-identity probe, an unavailable repository) must release the
          // provisional local reservation before the failure escapes, exactly as
          // `acquireRunAuthority` already does. Without this the agent stays falsely "already
          // executing" for the lifetime of the process: every retry mints a fresh run id, so
          // `reserve` can never succeed again and only an application restart clears it. The
          // original failure still propagates unchanged, and a refusal below remains the only
          // busy outcome.
          this.reservations.release(input.agentId, reservationOwner);
          throw error;
        }
        if (!acquired) {
          this.reservations.release(input.agentId, reservationOwner);
          const holder = await this.reservations.crossProcess.inspect(input.agentId);
          throw new ProjectWorkerBusyError(input.agentId, holder?.ownerId);
        }
      }
    }
    const releaseReservation = (): void => {
      // Never fabricate free state for a run that was really created.
      this.reservations?.release(input.agentId, reservationOwner);
      this.reservations?.crossProcess?.release(input.agentId, reservationOwner);
      if (preparationOwner !== reservationOwner)
        this.reservations?.release(input.agentId, preparationOwner);
    };
    let prepared: ProjectWorkerPreparation;
    try {
      prepared = await this.workers.prepare(input.agentId);
    } catch (error) {
      // Preparation provably created nothing, so this rejection is retry-safe by construction.
      releaseReservation();
      throw new ProjectWorkerNotLaunchedError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const createdAt = this.timestamp();
    const run: ProjectTaskRun = {
      version: 1,
      id: runId,
      projectId: project.id,
      taskId: task.id,
      agentId: input.agentId,
      agentName: requireText(prepared.agentName, 'a worker agent name'),
      acceptanceCriteria: task.acceptanceCriteria,
      resultChecks: cloneProjectChecks(task.resultChecks),
      turnLimit: task.turnLimit ?? 1,
      ...(task.timeLimitMinutes
        ? {
            timeLimitMinutes: task.timeLimitMinutes,
            deadlineAt: new Date(
              new Date(createdAt).getTime() + task.timeLimitMinutes * 60_000,
            ).toISOString(),
          }
        : {}),
      turnsUsed: 0,
      ...(previousRun
        ? {
            previousRunId: previousRun.id,
            previousQualityVersion: previousQualityVersion(previousRun),
            continuation: input.continuation?.trim(),
          }
        : {}),
      status: 'queued',
      createdAt,
      updatedAt: createdAt,
    };
    try {
      if (this.runCommitter?.reserve) {
        await this.runCommitter.reserve(run);
        this.onStateChange(run.projectId);
      } else await this.save(run);
    } catch (error) {
      // The run record is what makes a launch real; without it there is nothing to correlate.
      releaseReservation();
      throw new ProjectWorkerNotLaunchedError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (input.onRunCreated) {
      // Bookkeeping at the launch boundary must never turn a real launch into a failure.
      try {
        await input.onRunCreated(cloneProjectTaskRun(run));
      } catch {
        /* the run exists; the caller reports its own bookkeeping failure */
      }
    }
    const controller = this.controllerFor(run.id, run.deadlineAt);
    const operation = this.drive(
      run,
      this.workers.execute(
        { run, project, task, ...(previousRun ? { previousRun } : {}) },
        controller.signal,
      ),
    );
    this.activeOperations.set(run.id, operation);
    void operation.finally(() => this.activeOperations.delete(run.id));
    return operation;
  }

  async continueRun(runId: string, instructions = ''): Promise<ProjectTaskRun> {
    const run = await this.runs.get(runId);
    if (!run) throw new Error('The previous worker run is unavailable.');
    return this.launch({
      projectId: run.projectId,
      taskId: run.taskId,
      agentId: run.agentId,
      previousRunId: run.id,
      continuation: instructions,
    });
  }

  async reviewQuality(
    runId: string,
    input: QualityReviewInput,
    expectedRun: ProjectTaskRun,
    expectedTask: string,
  ): Promise<ProjectTaskRun> {
    if (!this.runCommitter?.reviewQuality)
      throw new Error('Quality review storage is unavailable.');
    const pending = await this.runs.get(runId);
    if (!pending || !sameProjectRunSnapshot(pending, expectedRun))
      throw new Error('The worker result changed during review. Refresh and review it again.');
    const project = await this.requireProject(pending.projectId);
    const task = taskById(project, pending.taskId);
    if (projectTaskVersion(task) !== expectedTask)
      throw new Error(
        'The task changed while this review was open. Refresh and inspect its current instructions.',
      );
    const report = pending.resultChecks?.length
      ? await checkProjectResults(
          pending.resultChecks,
          this.resultChecker,
          pending.runtimeTurnId!,
          this.timestamp(),
        )
      : undefined;
    const id = this.createId();
    const review: ProjectQualityReview = {
      ...structuredClone(input),
      id,
      method: 'human-review',
      reviewedAt: this.timestamp(),
      projectId: pending.projectId,
      taskId: pending.taskId,
      runId,
      criteriaVersion: pending.acceptanceCriteria ?? '',
      taskVersion: projectTaskVersion(task),
      resultVersion: projectResultVersion(pending),
      ...(report ? { checkReport: report } : {}),
      findings: input.findings.map((finding, index) => ({ ...finding, id: `${id}:${index}` })),
    };
    const saved = await this.runCommitter.reviewQuality(runId, {
      expectedRun: pending,
      expectedTask: projectTaskVersion(task),
      review,
    });
    this.onStateChange(saved.projectId);
    return saved;
  }

  async continueRepair(runId: string, expectedRun: ProjectTaskRun): Promise<ProjectTaskRun> {
    const run = await this.runs.get(runId);
    if (!run || !sameProjectRunSnapshot(run, expectedRun))
      throw new Error('The worker result changed. Refresh the repair proposal.');
    const proposal = projectRepairProposal(run, await this.runs.list(run.projectId));
    if (!proposal) throw new Error('There are no open quality items to repair.');
    return this.launch({
      projectId: run.projectId,
      taskId: run.taskId,
      agentId: run.agentId,
      previousRunId: run.id,
      expectedPreviousRun: run,
      continuation: proposal,
    });
  }

  async requestPause(runId: string): Promise<ProjectTaskRun> {
    let run: ProjectTaskRun;
    if (this.runCommitter?.pause) run = await this.runCommitter.pause(runId, this.timestamp());
    else {
      const stored = await this.runs.get(runId);
      if (!stored || !activeRun(stored)) throw new Error('Only a running worker can be paused.');
      run = { ...stored, pauseRequested: true, updatedAt: this.timestamp() };
      await this.runs.save(run);
    }
    this.onStateChange(run.projectId);
    return run;
  }

  async resumeRun(runId: string): Promise<ProjectTaskRun> {
    if (!this.workers.continue) throw new Error('This worker cannot resume checkpoints.');
    const stored = await this.runs.get(runId);
    if (!stored) throw new Error('The paused worker is unavailable.');
    // Phase 2I.2 / H6 — resuming a paused run is execution. Confirm the authoritative agent lease
    // before any durable resume state or worker entry, and defer truthfully when a foreign process
    // still owns the agent.
    const ownerId = projectWorkerRunReservationOwner(runId);
    await this.acquireRunAuthority(stored.agentId, ownerId, runId);
    let run: ProjectTaskRun;
    try {
      if (this.runCommitter?.resume) run = await this.runCommitter.resume(runId, this.timestamp());
      else {
        const project = await this.requireProject(stored.projectId);
        run = resumeProjectRun(project, stored, await this.runs.list(), this.timestamp());
        run = await this.save(run);
      }
    } catch (error) {
      await this.releaseRunAuthority(stored.agentId, ownerId);
      throw error;
    }
    if (!occupiesProjectExecution(run)) {
      await this.releaseRunAuthority(stored.agentId, ownerId);
      return run;
    }
    let project: ProjectGraph;
    let task: ProjectTask;
    try {
      project = await this.requireProject(run.projectId);
      task = taskById(project, run.taskId);
    } catch (error) {
      return this.fail(run, error);
    }
    this.onStateChange(run.projectId);
    if (this.expired(run)) return this.expire(run);
    const operation = this.drive(
      run,
      this.workers.continue(
        { run, project, task },
        this.controllerFor(run.id, run.deadlineAt).signal,
      ),
    );
    this.activeOperations.set(run.id, operation);
    void operation.finally(() => this.activeOperations.delete(run.id));
    return operation;
  }

  async verifyRun(
    runId: string,
    note: string,
    expectedRun?: ProjectTaskRun,
  ): Promise<ProjectTaskRun> {
    if (!this.runCommitter) throw new Error('Project result review storage is unavailable.');
    const pending = await this.runs.get(runId);
    if (!pending) throw new Error('The worker result is unavailable.');
    // Validate before reading artifacts; validate again inside the atomic completion transaction.
    if (pending.status !== 'awaiting-review')
      throw new Error(
        'Only a result awaiting review can be verified. Continue stopped work first.',
      );
    if (!note.trim()) throw new Error('Record what you checked before verifying this result.');
    if (!validateProjectTaskRun(pending)) throw new Error('The saved worker result is invalid.');
    if (expectedRun && !sameProjectRunSnapshot(pending, expectedRun)) {
      if (this.runCommitter.attemptVerify) {
        const rejected = await this.runCommitter.attemptVerify(
          runId,
          note,
          this.timestamp(),
          { expectedRun },
          this.createId(),
        );
        this.onStateChange(rejected.run.projectId);
        if (rejected.error) throw new Error(rejected.error);
        return rejected.run;
      }
      throw new Error('The worker result changed during review. Refresh and review it again.');
    }
    const evidence: ProjectRunReviewEvidence = { expectedRun: cloneProjectTaskRun(pending) };
    if (pending.resultChecks?.length)
      evidence.checkReport = await checkProjectResults(
        pending.resultChecks,
        this.resultChecker,
        pending.runtimeTurnId!,
        this.timestamp(),
      );
    if (this.runCommitter.attemptVerify) {
      const result = await this.runCommitter.attemptVerify(
        runId,
        note,
        this.timestamp(),
        evidence,
        this.createId(),
      );
      this.onStateChange(result.run.projectId);
      if (result.error) throw new Error(result.error);
      return result.run;
    }
    const run = await this.runCommitter.verify(runId, note, this.timestamp(), evidence);
    this.onStateChange(run.projectId);
    return run;
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
    if (this.expired(resumed)) return this.expire(resumed);
    // Phase 2I.2 / H6 — an approval settlement is not execution authority. Confirm the
    // authoritative agent lease for this exact worker run before the durable status changes or any
    // resumed worker/provider/tool path is entered. A live foreign owner refuses here; unknown
    // liveness fails closed through the same authority; a proven-dead holder is recoverable.
    const ownerId = projectWorkerRunReservationOwner(run.id);
    await this.acquireRunAuthority(run.agentId, ownerId, run.id);
    try {
      const saved = await this.save(resumed);
      // A concurrent cancellation is terminal and wins: do not drive a resurrected run.
      if (!occupiesProjectExecution(saved)) {
        await this.releaseRunAuthority(run.agentId, ownerId);
        return saved;
      }
      const operation = this.drive(
        saved,
        this.workers.resume(
          { run: saved, project, task },
          approvalId,
          decision,
          this.controllerFor(saved.id, saved.deadlineAt).signal,
        ),
      );
      this.activeOperations.set(saved.id, operation);
      void operation.finally(() => this.activeOperations.delete(saved.id));
      return operation;
    } catch (error) {
      await this.releaseRunAuthority(run.agentId, ownerId);
      throw error;
    }
  }

  async cancel(runId: string): Promise<ProjectTaskRun> {
    const run = await this.runs.get(runId);
    if (run?.status === 'paused') return this.markCancelled(run);
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
      // Phase 2I.2 — reconciliation is not execution authority. A run whose agent is held by a
      // foreign process that is alive or of unknown liveness must be deferred untouched: recovery
      // reads and mutates durable turn truth, which belongs to the live owner. Only a proven-dead
      // holder (or no holder) may enter existing recovery semantics.
      if (await this.foreignOwnerBlocks(run.agentId)) continue;
      try {
        const recovery = await this.workers.recover(run);
        await this.applyRecovery(run, recovery);
      } catch (error) {
        await this.fail(run, error);
      }
    }
    const settled = await this.runs.list(projectId);
    // §8 — a run that is still active still owns its agent. IRIS must never fabricate a free agent
    // while real work remains, and it never steals an agent another owner already holds.
    for (const run of settled) {
      if (!occupiesProjectExecution(run) || this.activeRuns.has(run.id)) continue;
      // A live or unknown foreign owner already holds this agent. Do not even take the local
      // reservation: the Phase 2I.0 harness proved that a refused cross-process acquisition left a
      // process-lifetime phantom that blocked legitimate work.
      if (await this.foreignOwnerBlocks(run.agentId)) continue;
      const reserved = this.reservations?.reserve(
        run.agentId,
        projectWorkerRunReservationOwner(run.id),
        this.timestamp(),
      );
      // Phase 2H.1 — a recovered active run re-establishes its cross-process lease too, so a
      // same-agent chat in another process cannot start while this run is still live.
      if (reserved && this.reservations?.crossProcess) {
        const authorityOwner = projectWorkerRunReservationOwner(run.id);
        let acquired: boolean;
        try {
          acquired = await this.reservations.crossProcess.acquire(
            run.agentId,
            authorityOwner,
            this.timestamp(),
            run.id,
          );
        } catch (error) {
          // Phase 2J.2 / F-2J2-SCH-01 — the same provisional-reservation invariant `launch` now
          // enforces: an acquisition that throws must not leave this local reservation behind.
          // Otherwise the run's phantom ownership outlives the run itself and blocks every later
          // launch for that agent, while the truthful failure is lost behind a busy refusal.
          this.reservations.release(run.agentId, authorityOwner);
          throw error;
        }
        // Phase 2I.2 / H5b — a refusal is a truthful busy outcome, never a silent local claim.
        if (!acquired) this.reservations.release(run.agentId, authorityOwner);
      }
    }
    return settled;
  }

  /**
   * True when a foreign process holds the agent lease and cannot be proven dead. `unknown`
   * liveness is fail-closed, and a missing `holderStatus` port falls back to the authority's own
   * `inspect`, which only reports holders that block acquisition (foreign alive or unknown).
   */
  private async foreignOwnerBlocks(agentId: string): Promise<boolean> {
    const crossProcess = this.reservations?.crossProcess;
    if (!crossProcess) return false;
    try {
      if (crossProcess.holderStatus) {
        const holder = await crossProcess.holderStatus(agentId);
        if (!holder) return false;
        return holder.foreign && holder.liveness !== 'dead';
      }
      return Boolean(await crossProcess.inspect(agentId));
    } catch {
      // A probe that cannot be evaluated establishes nothing, so it must never authorize a
      // destructive recovery. Defer and leave the durable record untouched.
      return true;
    }
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
    events: AsyncIterable<ProjectWorkerEvent>,
  ): Promise<ProjectTaskRun> {
    if (this.activeRuns.has(initial.id)) throw new Error('This worker run is already active.');
    this.activeRuns.add(initial.id);
    let run = cloneProjectTaskRun(initial);
    try {
      if (run.status === 'queued') {
        const startedAt = this.timestamp();
        run = { ...run, status: 'running', startedAt, updatedAt: startedAt };
        run = await this.save(run);
        // A terminal durable state that appeared concurrently (another process cancelled the run)
        // wins immediately; this driver must not continue to write execution progress.
        if (!occupiesProjectExecution(run)) return cloneProjectTaskRun(run);
      }
      while (true) {
        let returned = false;
        const previousTurnId = run.runtimeTurnId;
        const needsNewTurn = Boolean(run.returnedAt && run.stopReason);
        for await (const event of events) {
          if (this.cancelling.has(initial.id)) {
            run = await this.markCancelled(run);
            return run;
          }
          if (this.timedOut.has(initial.id) || this.expired(run)) {
            run = await this.expire(run);
            return run;
          }
          const stored = await this.runs.get(run.id);
          if (stored?.pauseRequested) run = { ...run, pauseRequested: true };
          if (event.type === 'started') {
            const turnsUsed =
              (run.turnsUsed ?? 0) + (event.runtimeTurnId !== run.runtimeTurnId ? 1 : 0);
            if (turnsUsed > (run.turnLimit ?? 1))
              throw new Error('The project turn limit has been reached.');
            run = {
              ...run,
              turnsUsed,
              runtimeTurnId: event.runtimeTurnId,
              returnedAt: undefined,
              stopReason: undefined,
              updatedAt: this.timestamp(),
            };
            run = await this.save(run);
            if (!occupiesProjectExecution(run)) return cloneProjectTaskRun(run);
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
            run = await this.save(run);
            if (!occupiesProjectExecution(run)) return cloneProjectTaskRun(run);
          } else {
            returned = true;
            if (needsNewTurn && event.runtimeTurnId === previousTurnId)
              throw new Error('The worker did not start a new turn.');
            if (event.runtimeTurnId !== run.runtimeTurnId)
              run = { ...run, turnsUsed: (run.turnsUsed ?? 0) + 1 };
            if ((run.turnsUsed ?? 0) > (run.turnLimit ?? 1))
              throw new Error('The project turn limit has been reached.');
            run = await this.recordReturn(run, event.runtimeTurnId, event.output, event.stopReason);
          }
        }
        if (!returned) {
          if (run.status === 'running')
            throw new Error('The project worker stopped without a final runtime state.');
          return cloneProjectTaskRun(run);
        }
        if (
          !['tool-limit', 'check-failed'].includes(run.stopReason ?? '') ||
          (run.turnsUsed ?? 1) >= (run.turnLimit ?? 1) ||
          !this.workers.continue
        )
          return cloneProjectTaskRun(run);
        const stored = await this.runs.get(run.id);
        if (stored?.pauseRequested || run.pauseRequested) {
          run = {
            ...run,
            status: 'paused',
            pauseRequested: true,
            pausedAt: this.timestamp(),
            updatedAt: this.timestamp(),
          };
          run = await this.save(run);
          return cloneProjectTaskRun(run);
        }
        const project = await this.requireProject(run.projectId);
        const task = taskById(project, run.taskId);
        if (
          projectTaskState(project, task.id) !== 'ready' ||
          task.acceptanceCriteria !== run.acceptanceCriteria ||
          !sameProjectChecks(task.resultChecks, run.resultChecks)
        )
          throw new Error('The task changed during execution. Review it before continuing.');
        run = { ...run, status: 'running', updatedAt: this.timestamp() };
        run = await this.save(run);
        if (!occupiesProjectExecution(run)) return cloneProjectTaskRun(run);
        if (this.expired(run)) {
          run = await this.expire(run);
          return run;
        }
        events = this.workers.continue(
          { run, project, task },
          this.controllerFor(run.id, run.deadlineAt).signal,
        );
      }
    } catch (error) {
      if (this.cancelling.has(initial.id)) run = await this.markCancelled(run);
      else if (this.timedOut.has(initial.id) || this.expired(run)) run = await this.expire(run);
      else run = await this.fail(run, error);
      return run;
    } finally {
      this.activeRuns.delete(initial.id);
      this.cancellation.delete(initial.id);
      const timer = this.deadlineTimers.get(initial.id);
      if (timer) clearTimeout(timer);
      this.deadlineTimers.delete(initial.id);
      this.timedOut.delete(initial.id);
      this.cancelling.delete(initial.id);
      // §11 — the agent stays busy exactly as long as the correlated worker run is non-terminal,
      // not merely while a transient queue status says so.
      if (!occupiesProjectExecution(run)) {
        this.reservations?.release(run.agentId, projectWorkerRunReservationOwner(run.id));
        void this.reservations?.crossProcess?.release(
          run.agentId,
          projectWorkerRunReservationOwner(run.id),
        );
      }
    }
  }

  private async applyRecovery(run: ProjectTaskRun, recovery: ProjectWorkerRecovery): Promise<void> {
    if (recovery.status === 'failed') {
      await this.fail(run, recovery.failure);
      return;
    }
    if (recovery.status === 'returned') {
      const returned = await this.recordReturn(
        run,
        recovery.runtimeTurnId,
        recovery.output ?? run.output ?? '',
        recovery.stopReason,
      );
      if (returned.status === 'running')
        await this.save({
          ...returned,
          status: 'paused',
          pausedAt: this.timestamp(),
          pauseRequested: true,
        });
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

  private async recordReturn(
    run: ProjectTaskRun,
    runtimeTurnId: string,
    output: string,
    stopReason?: 'tool-limit',
  ): Promise<ProjectTaskRun> {
    const returnedAt = this.timestamp();
    let returned: ProjectTaskRun = {
      ...run,
      turnsUsed: Math.max(1, run.turnsUsed ?? 0),
      status: stopReason
        ? (run.turnsUsed ?? 1) < (run.turnLimit ?? 1) && this.workers.continue
          ? 'running'
          : 'needs-attention'
        : 'awaiting-review',
      runtimeTurnId,
      returnedAt,
      output,
      stopReason,
      updatedAt: returnedAt,
      suspendedAt: undefined,
      approval: undefined,
      completedAt: undefined,
      failedAt: undefined,
      failure: undefined,
    };
    if (!stopReason && run.resultChecks?.length) {
      const report = await checkProjectResults(
        run.resultChecks,
        this.resultChecker,
        runtimeTurnId,
        this.timestamp(),
      );
      if (this.cancelling.has(run.id)) return this.markCancelled(returned);
      const reason = report.results.some((result) => result.status === 'error')
        ? 'check-error'
        : report.results.some((result) => result.status === 'failed')
          ? 'check-failed'
          : undefined;
      returned = {
        ...returned,
        stopReason: reason,
        checkReports: [
          ...(run.checkReports ?? []).filter((old) => old.runtimeTurnId !== runtimeTurnId),
          report,
        ],
        status: !reason
          ? 'awaiting-review'
          : reason === 'check-failed' &&
              returned.turnsUsed! < (run.turnLimit ?? 1) &&
              this.workers.continue
            ? 'running'
            : 'needs-attention',
      };
    }
    const stored = await this.runs.get(run.id);
    if (stored?.pauseRequested) returned = { ...returned, pauseRequested: true };
    return this.save(returned);
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
      cancelledAt: undefined,
    };
    return this.save(failed);
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
    };
    return this.save(cancelled);
  }

  private controllerFor(runId: string, deadlineAt?: string): AbortController {
    const existing = this.cancellation.get(runId);
    if (existing) return existing;
    const controller = new AbortController();
    this.cancellation.set(runId, controller);
    if (deadlineAt) {
      const remaining = Date.parse(deadlineAt) - this.now().getTime();
      if (remaining <= 0) {
        this.timedOut.add(runId);
        controller.abort();
      } else {
        this.deadlineTimers.set(
          runId,
          setTimeout(() => {
            this.timedOut.add(runId);
            controller.abort();
          }, remaining),
        );
      }
    }
    return controller;
  }

  private expired(run: ProjectTaskRun): boolean {
    return Boolean(run.deadlineAt && Date.parse(run.deadlineAt) <= this.now().getTime());
  }

  private async expire(run: ProjectTaskRun): Promise<ProjectTaskRun> {
    return this.fail(
      run,
      `The ${run.timeLimitMinutes}-minute wall-clock limit expired. IRIS stopped the worker; inspect the actual outcome before continuing manually.`,
    );
  }

  private async requireProject(projectId: string): Promise<ProjectGraph> {
    const project = await this.projects.get(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return project;
  }

  /**
   * Phase 2I.2 — the one admission step every project resume path shares: take the atomic local
   * reservation and then confirm it with the authoritative cross-process lease before any durable
   * execution state changes or worker entry. A refusal releases the provisional local reservation
   * on every path, so a denied resume leaves no process-lifetime phantom.
   */
  private async acquireRunAuthority(
    agentId: string,
    ownerId: string,
    runId?: string,
  ): Promise<void> {
    const reservations = this.reservations;
    if (!reservations) return;
    if (!reservations.reserve(agentId, ownerId, this.timestamp())) {
      throw new ProjectWorkerBusyError(agentId, reservations.holder(agentId)?.ownerId);
    }
    const crossProcess = reservations.crossProcess;
    if (!crossProcess) return;
    try {
      const acquired = await crossProcess.acquire(agentId, ownerId, this.timestamp(), runId);
      if (acquired) return;
    } catch (error) {
      reservations.release(agentId, ownerId);
      throw error;
    }
    reservations.release(agentId, ownerId);
    const holder = await crossProcess.inspect(agentId);
    throw new ProjectWorkerBusyError(agentId, holder?.ownerId);
  }

  /** Releases both halves of one admission attempt; a foreign lease is never touched. */
  private async releaseRunAuthority(agentId: string, ownerId: string): Promise<void> {
    this.reservations?.release(agentId, ownerId);
    await this.reservations?.crossProcess?.release(agentId, ownerId);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async save(run: ProjectTaskRun): Promise<ProjectTaskRun> {
    try {
      await this.runs.save(run);
      this.onStateChange(run.projectId);
      return run;
    } catch (error) {
      // Phase 2I.2 / H4 — a durable terminal state wins over any stale execution continuation.
      // The repository refused the write inside its transaction; adopt the terminal record and let
      // the caller stop, rather than resurrecting a cancelled/completed/failed run.
      if (error instanceof ProjectRunStateConflictError) {
        this.onStateChange(run.projectId);
        return error.durable;
      }
      throw error;
    }
  }
}

/** Human review is distinct from a model's completion claim. Call inside a repository transaction. */
function sameProjectRunSnapshot(a: ProjectTaskRun, b: ProjectTaskRun): boolean {
  return JSON.stringify(cloneProjectTaskRun(a)) === JSON.stringify(cloneProjectTaskRun(b));
}

export function verifyProjectRun(
  project: ProjectGraph,
  run: ProjectTaskRun,
  runs: ProjectTaskRun[],
  note: string,
  reviewedAt: string,
  evidence?: ProjectRunReviewEvidence,
): { project: ProjectGraph; run: ProjectTaskRun } {
  if (run.projectId !== project.id || run.status !== 'awaiting-review')
    throw new Error('Only a result awaiting review can be verified. Continue stopped work first.');
  if (!validateProjectTaskRun(run))
    throw new Error('The saved result is invalid or its checks have not passed.');
  if (!note.trim()) throw new Error('Record what you checked before verifying this result.');
  if (Number.isNaN(Date.parse(reviewedAt))) throw new Error('Review requires a valid timestamp.');
  const task = taskById(project, run.taskId);
  if (projectTaskState(project, task.id) !== 'ready')
    throw new Error('This task is no longer ready for review. Refresh the project.');
  if (!sameProjectChecks(task.resultChecks, run.resultChecks))
    throw new Error('The result checks changed. Run the task again.');
  if ((task.acceptanceCriteria ?? '') !== (run.acceptanceCriteria ?? ''))
    throw new Error('The acceptance criteria changed. Run the task again before verifying it.');
  if (evidence && !sameProjectRunSnapshot(run, evidence.expectedRun))
    throw new Error('The worker result changed during review. Refresh and review it again.');
  if (run.resultChecks?.length)
    requireUnchangedProjectCheckEvidence(
      run.resultChecks,
      run.checkReports?.at(-1),
      evidence?.checkReport,
      run.runtimeTurnId,
      reviewedAt,
    );
  if (
    runs.some(
      (other) =>
        other.id !== run.id &&
        other.projectId === run.projectId &&
        other.taskId === run.taskId &&
        (activeRun(other) || other.previousRunId === run.id || isNewerProjectRun(other, run)),
    )
  )
    throw new Error('A newer or active run exists for this task. Review its result instead.');
  requireProjectQualityCoverage(task, run, runs);
  return {
    project: updateProjectTaskCompletion(project, task.id, true, reviewedAt),
    run: {
      ...cloneProjectTaskRun(run),
      status: 'completed',
      completedAt: reviewedAt,
      updatedAt: reviewedAt,
      verification: {
        method: 'human-review',
        reviewedAt,
        note: note.trim(),
        ...(run.resultChecks?.length && evidence?.checkReport
          ? { checkReport: structuredClone(evidence.checkReport) }
          : {}),
      },
    },
  };
}

/** Re-check readiness and exclusivity in the same transaction that reserves the run. */
export function validateProjectRunReservation(
  project: ProjectGraph,
  run: ProjectTaskRun,
  runs: ProjectTaskRun[],
): void {
  if (run.projectId !== project.id || run.status !== 'queued' || !validateProjectTaskRun(run))
    throw new Error('Cannot reserve an invalid project worker run.');
  const task = taskById(project, run.taskId);
  if (projectTaskState(project, task.id) !== 'ready')
    throw new Error('Only a ready project task can be launched.');
  if (!sameProjectChecks(task.resultChecks, run.resultChecks))
    throw new Error('The result checks changed. Run the task again.');
  if ((task.acceptanceCriteria ?? '') !== (run.acceptanceCriteria ?? ''))
    throw new Error('The acceptance criteria changed. Launch the task again.');
  if ((task.timeLimitMinutes ?? undefined) !== (run.timeLimitMinutes ?? undefined))
    throw new Error('The time limit changed. Launch the task again.');
  if (
    runs.some(
      (other) =>
        // Only *another* active run may block the reservation. Testing `other.id === run.id` here
        // made a list that already contained the candidate refuse the candidate as "already active",
        // so a re-validated or re-reserved run could never pass its own check.
        other.id !== run.id &&
        activeRun(other) &&
        (other.agentId === run.agentId ||
          (other.projectId === project.id && other.taskId === task.id)),
    )
  )
    throw new Error('This task or agent already has an active worker run.');
  if (run.previousRunId) {
    const previous = runs.find((other) => other.id === run.previousRunId);
    if (
      !previous ||
      previous.projectId !== project.id ||
      previous.taskId !== task.id ||
      !['awaiting-review', 'needs-attention', 'failed', 'cancelled'].includes(previous.status)
    )
      throw new Error('The previous run is no longer available to continue.');
    if (
      run.previousQualityVersion !== undefined &&
      run.previousQualityVersion !== previousQualityVersion(previous)
    )
      throw new Error('The quality findings changed before launch. Refresh the repair proposal.');
    if (
      runs.some(
        (other) =>
          other.id !== previous.id &&
          other.projectId === project.id &&
          other.taskId === task.id &&
          (other.previousRunId === previous.id || isNewerProjectRun(other, previous)),
      )
    )
      throw new Error('A newer run exists for this task. Continue that run instead.');
  }
}

function validTurnLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 10;
}

function validTimeLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 1_440;
}

export function resumeProjectRun(
  project: ProjectGraph,
  run: ProjectTaskRun,
  runs: ProjectTaskRun[],
  at: string,
): ProjectTaskRun {
  if (run.status !== 'paused' || (run.turnsUsed ?? 1) >= (run.turnLimit ?? 1))
    throw new Error('This worker has no paused turns left to resume.');
  if (
    runs.some(
      (other) =>
        other.id !== run.id &&
        other.projectId === run.projectId &&
        other.taskId === run.taskId &&
        isNewerProjectRun(other, run),
    )
  )
    throw new Error('A newer run exists. Resume its work instead.');
  if (run.deadlineAt && Date.parse(run.deadlineAt) <= Date.parse(at))
    throw new Error(
      'The worker time limit has expired. Inspect the actual outcome before continuing manually.',
    );
  const reservation = { ...run, status: 'queued' as const };
  validateProjectRunReservation(
    project,
    reservation,
    runs.filter((other) => other.id !== run.id),
  );
  return { ...run, status: 'running', pauseRequested: false, pausedAt: undefined, updatedAt: at };
}
