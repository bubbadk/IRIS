import type { ProjectGraphRepository, ProjectTaskRun } from './index';
import { compareProjectRunsNewestFirst } from './projectRunOrder';

export type ProjectQueueStatus =
  'queued' | 'claimed' | 'launched' | 'needs-attention' | 'cancelled';

export interface ProjectQueueEntry {
  version: 1;
  id: string;
  projectId: string;
  taskId: string;
  agentId: string;
  status: ProjectQueueStatus;
  queuedAt: string;
  updatedAt: string;
  claimedAt?: string;
  runId?: string;
  message?: string;
  /** How many retry-safe pre-launch attempts have been spent. Bounds automatic retries. */
  attempts?: number;
  /** Earliest time a retry-safe `queued` entry may be dispatched again. */
  retryAt?: string;
  /** Classified cause of the last failure, so the UI can state what IRIS actually knows. */
  failureKind?: ProjectLaunchFailureKind;
}

/**
 * IRIS Phase 2G §13 — what IRIS actually knows after a failed dispatch.
 *
 * `not-launched` is the only retry-safe outcome. `launched` must never launch again. `unknown` must
 * never auto-retry. `configuration` is a permanent setup failure that needs a human.
 */
export type ProjectLaunchFailureKind =
  | 'not-launched'
  | 'unknown'
  | 'launched'
  | 'configuration';

/** The default bounded retry budget for a retry-safe pre-launch failure. */
export const projectQueueMaxAttempts = 3;

/** Backoff before a retry-safe entry is dispatched again, so a broken setup cannot hot-loop. */
export const projectQueueRetryDelayMs = 60_000;

export interface ProjectQueueRepository {
  list(projectId?: string): Promise<ProjectQueueEntry[]>;
  get(id: string): Promise<ProjectQueueEntry | null>;
  enqueue(entry: ProjectQueueEntry): Promise<void>;
  /** Atomically move a queued entry to claimed, returning null when another owner won. */
  claim(id: string, claimedAt: string): Promise<ProjectQueueEntry | null>;
  save(entry: ProjectQueueEntry): Promise<void>;
  /**
   * Replaces an entry only while it still matches `expected`. Returns false when a concurrent writer
   * (a user cancellation, another dispatcher) changed it first, so a stale async callback always
   * loses instead of overwriting a decision the user already made.
   */
  saveIfUnchanged?(
    entry: ProjectQueueEntry,
    expected: ProjectQueueTransitionExpectation,
  ): Promise<boolean>;
}

/** The exact prior state a guarded transition still expects to find. */
export interface ProjectQueueTransitionExpectation {
  status: ProjectQueueStatus;
  updatedAt: string;
  runId?: string;
}

export interface ProjectQueueDispatchInput {
  projectId: string;
  taskId: string;
  agentId: string;
  /**
   * The queue entry that already holds this agent's exclusive reservation. The launcher hands
   * ownership to the worker run it creates instead of acquiring it a second time.
   */
  reservationOwnerId?: string;
  /**
   * Called as soon as the worker run record is durable, before the worker executes. The dispatcher
   * records the real run identity at this exact boundary, so a run is never started without IRIS
   * first knowing it exists.
   */
  onRunCreated?: (run: ProjectTaskRun) => void | Promise<void>;
}

export interface ProjectQueueLauncher {
  available(agentId: string): Promise<boolean>;
  launch(input: ProjectQueueDispatchInput): Promise<ProjectTaskRun>;
  /**
   * The authoritative set of agents that still have non-terminal worker work.
   *
   * §11, §24 — the one-worker-per-agent guard must be driven by the real worker/run lifecycle, not
   * by a transient queue status: after an entry becomes `launched` it used to leave the guard set
   * even though its worker was still running.
   */
  busyAgentIds?(): Promise<readonly string[]>;
  /**
   * Reports whether a worker run already exists for an entry whose launched state was never
   * persisted. This is how a restart reconciles a real run instead of declaring a failed launch.
   */
  findRun?(input: {
    projectId: string;
    taskId: string;
    agentId: string;
    queuedAt: string;
  }): Promise<ProjectTaskRun | null>;
}

/**
 * The cross-process view of one agent lease holder, with the Phase 2H.3 tri-state liveness
 * verdict. `unknown` is never treated as `dead`.
 */
export interface ProjectWorkerLeaseHolderStatus {
  ownerId: string;
  /** False when the holder is this runtime's own record. */
  foreign: boolean;
  liveness: 'alive' | 'dead' | 'unknown';
}

/**
 * The exclusive-execution reservation a dispatcher must hold before it prepares or launches a
 * worker. `reserve` is atomic; ownership is handed to the worker run through `transfer`.
 */
export interface ProjectWorkerReservation {
  reserve(agentId: string, ownerId: string, at: string): boolean;
  holder(agentId: string): { ownerId: string } | undefined;
  transfer(
    agentId: string,
    fromOwnerId: string,
    toOwnerId: string,
    at: string,
    runId?: string,
  ): boolean;
  release(agentId: string, ownerId: string): boolean;
  /**
   * IRIS Phase 2H.1 — the cross-process authority behind the local reservation, when the host
   * provides one. Launch, resume and reconcile confirm the agent lease across processes; a
   * refusal is a busy outcome, never a concurrent execution.
   */
  crossProcess?: {
    acquire(agentId: string, ownerId: string, at: string, runId?: string): Promise<boolean>;
    release(agentId: string, ownerId: string): Promise<void>;
    inspect(agentId: string): Promise<{ ownerId?: string } | undefined>;
    /**
     * IRIS Phase 2I.2 — read-only ownership classification for reconciliation. A live or
     * unknown foreign holder blocks destructive recovery; only a proven-dead holder permits it.
     */
    holderStatus?(agentId: string): Promise<ProjectWorkerLeaseHolderStatus | undefined>;
  };
}

/** A worker run owns the reservation it created, or inherited from the queue entry that launched it. */
export function projectWorkerRunReservationOwner(runId: string): string {
  return `project-run:${runId}`;
}

/**
 * A launch that provably created no worker run. Only this failure is retry-safe; any other rejection
 * may have created a run whose state IRIS has not yet observed.
 */
export class ProjectWorkerNotLaunchedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectWorkerNotLaunchedError';
  }
}

/** A launch refused because another owner already holds the agent's exclusive reservation. */
export class ProjectWorkerBusyError extends Error {
  constructor(
    readonly agentId: string,
    readonly holderOwnerId: string | undefined,
  ) {
    super('Another IRIS worker is already executing this agent.');
    this.name = 'ProjectWorkerBusyError';
  }
}

export function cloneProjectQueueEntry(entry: ProjectQueueEntry): ProjectQueueEntry {
  return { ...entry };
}

export function validateProjectQueueEntry(value: unknown): value is ProjectQueueEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<ProjectQueueEntry>;
  return (
    entry.version === 1 &&
    typeof entry.id === 'string' &&
    !!entry.id.trim() &&
    typeof entry.projectId === 'string' &&
    !!entry.projectId.trim() &&
    typeof entry.taskId === 'string' &&
    !!entry.taskId.trim() &&
    typeof entry.agentId === 'string' &&
    !!entry.agentId.trim() &&
    ['queued', 'claimed', 'launched', 'needs-attention', 'cancelled'].includes(
      entry.status ?? '',
    ) &&
    typeof entry.queuedAt === 'string' &&
    !Number.isNaN(Date.parse(entry.queuedAt)) &&
    typeof entry.updatedAt === 'string' &&
    !Number.isNaN(Date.parse(entry.updatedAt)) &&
    (entry.claimedAt === undefined || typeof entry.claimedAt === 'string') &&
    (entry.runId === undefined || typeof entry.runId === 'string') &&
    (entry.message === undefined || typeof entry.message === 'string') &&
    (entry.attempts === undefined ||
      (Number.isInteger(entry.attempts) && entry.attempts >= 0 && entry.attempts <= 1000)) &&
    (entry.retryAt === undefined ||
      (typeof entry.retryAt === 'string' && !Number.isNaN(Date.parse(entry.retryAt)))) &&
    (entry.failureKind === undefined ||
      ['not-launched', 'unknown', 'launched', 'configuration'].includes(entry.failureKind))
  );
}

function taskIsReady(
  project: { tasks: Array<{ id: string; completedAt?: string; dependencyIds: string[] }> },
  taskId: string,
): boolean {
  const task = project.tasks.find((candidate) => candidate.id === taskId);
  return Boolean(
    task &&
    !task.completedAt &&
    task.dependencyIds.every(
      (id) => project.tasks.find((candidate) => candidate.id === id)?.completedAt,
    ),
  );
}

/**
 * IRIS Phase 2G §12 — the statuses in which a worker run genuinely occupies its agent's exclusive
 * execution. `awaiting-review`, `needs-attention`, `paused`, `completed`, `failed` and `cancelled`
 * all mean the agent is no longer executing, even though several of them still need a human.
 */
export const projectRunOccupiesExecution = ['queued', 'running', 'suspended'] as const;

export function occupiesProjectExecution(run: Pick<ProjectTaskRun, 'status'>): boolean {
  return (projectRunOccupiesExecution as readonly ProjectTaskRun['status'][]).includes(run.status);
}

/** Statuses in which a queue entry still owns, or is about to own, the agent's execution. */
export const projectQueueOccupiesWorker = ['queued', 'claimed', 'launched'] as const;

export function queueEntryOccupiesWorker(entry: Pick<ProjectQueueEntry, 'status'>): boolean {
  return (projectQueueOccupiesWorker as readonly ProjectQueueStatus[]).includes(entry.status);
}

/**
 * IRIS Phase 2G §3, §4, §14, §25 — pure queue coordinator.
 *
 * Invariant: **IRIS must never lose the truth about whether a project worker was actually
 * started.** Once `launch` returns a run id, that run exists. A later persistence failure may
 * report a reconciliation problem, but it may never rewrite the outcome as "launch failed".
 *
 * Every state write that follows an async step is guarded by the exact state it was computed from
 * ({@link ProjectQueueRepository.saveIfUnchanged}), so a stale callback loses to a user's
 * cancellation instead of resurrecting a cancelled entry.
 */
export class ProjectQueueDispatcher {
  private ticking = false;
  constructor(
    private readonly projects: ProjectGraphRepository,
    private readonly entries: ProjectQueueRepository,
    private readonly launcher: ProjectQueueLauncher,
    private readonly now: () => Date = () => new Date(),
    private readonly reservations?: ProjectWorkerReservation,
  ) {}

  /**
   * Rebuilds the truth about entries that were mid-dispatch when IRIS stopped.
   *
   * A `claimed` entry whose worker run really exists is reconciled to `launched` with the real run
   * id — that run is genuine and must never be launched again. Only an entry with no correlated run
   * is reported as needing attention, because then its outcome is genuinely unknown.
   */
  async reconcile(): Promise<void> {
    for (const entry of await this.entries.list()) {
      if (entry.status !== 'claimed') continue;
      const run = await this.findRun(entry);
      try {
        if (run) {
          await this.transition(entry, {
            status: 'launched',
            runId: run.id,
            updatedAt: this.now().toISOString(),
            message: `IRIS restarted while dispatching this task. Worker run ${run.id} was really created, so it is recorded here and will never be launched again.`,
            failureKind: 'launched',
            retryAt: undefined,
          });
          continue;
        }
        await this.transition(entry, {
          status: 'needs-attention',
          updatedAt: this.now().toISOString(),
          message:
            'IRIS stopped after dispatching this queued task and found no worker run. Inspect the actual outcome before queueing it again.',
          failureKind: 'unknown',
        });
      } catch {
        // Storage is still rejecting writes. The entry keeps its exact prior state rather than a
        // half-written one, and the next reconcile retries the same reconstruction.
      }
    }
  }

  async tick(): Promise<ProjectQueueEntry[]> {
    if (this.ticking) return [];
    this.ticking = true;
    try {
      const dispatched: ProjectQueueEntry[] = [];
      const all = await this.entries.list();
      // §11, §24 — busy is the authoritative worker lifecycle plus entries that reserved but have
      // not produced a run yet. A `launched` entry is *not* a busy source by itself: its run is.
      const busyAgentIds = new Set(
        all.filter((entry) => entry.status === 'claimed').map((entry) => entry.agentId),
      );
      for (const agentId of (await this.launcher.busyAgentIds?.()) ?? []) busyAgentIds.add(agentId);
      const at = this.now();
      for (const entry of all
        .filter(
          (candidate) =>
            candidate.status === 'queued' &&
            (!candidate.retryAt || Date.parse(candidate.retryAt) <= at.getTime()),
        )
        .sort(
          (left, right) =>
            left.queuedAt.localeCompare(right.queuedAt) || left.id.localeCompare(right.id),
        )) {
        // §4 — an entry that already carries a run identity must never be launched again.
        if (entry.runId) {
          await this.transition(entry, {
            status: 'launched',
            runId: entry.runId,
            updatedAt: at.toISOString(),
            message: `Worker run ${entry.runId} already exists for this entry.`,
          });
          continue;
        }
        const project = await this.projects.get(entry.projectId);
        const task = project?.tasks.find((candidate) => candidate.id === entry.taskId);
        if (!project || !task) {
          await this.transition(entry, {
            status: 'needs-attention',
            updatedAt: at.toISOString(),
            message: 'The project or task was removed before this queue entry could start.',
            failureKind: 'configuration',
          });
          continue;
        }
        if (!taskIsReady(project, task.id)) continue;
        if (busyAgentIds.has(entry.agentId)) continue;

        // §9 — reserve the agent atomically *before* any await. Whoever wins this synchronous
        // check-and-set is the only caller that may prepare or launch a worker for this agent.
        const reserved =
          this.reservations?.reserve(entry.agentId, entry.id, at.toISOString()) ?? true;
        if (!reserved) continue;

        let claimed: ProjectQueueEntry | null;
        try {
          if (!(await this.launcher.available(entry.agentId))) {
            this.release(entry.agentId, entry.id);
            continue;
          }
          claimed = await this.entries.claim(entry.id, at.toISOString());
        } catch (error) {
          this.release(entry.agentId, entry.id);
          await this.recordPreLaunchFailure(entry, error, at.toISOString());
          continue;
        }
        if (!claimed) {
          this.release(entry.agentId, entry.id);
          continue;
        }
        busyAgentIds.add(claimed.agentId);
        dispatched.push(claimed);
        // Ownership of the reservation now travels with the dispatch continuation, which either
        // hands it to the real worker run or releases it.
        void this.dispatch(claimed);
      }
      return dispatched;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Runs one claimed entry to a durable, honest outcome.
   *
   * The two outcomes are handled by two separate, independently-failing steps: a persistence failure
   * while recording a *successful* launch can never be reinterpreted as a launch failure, because
   * the failure path is only reachable when no run was created.
   */
  private async dispatch(claimed: ProjectQueueEntry): Promise<void> {
    let run: ProjectTaskRun;
    try {
      run = await this.launcher.launch({
        projectId: claimed.projectId,
        taskId: claimed.taskId,
        agentId: claimed.agentId,
        reservationOwnerId: this.reservations ? claimed.id : undefined,
        // The launch boundary: persist the real run identity before the worker does any work.
        onRunCreated: (created) => this.recordLaunched(claimed, created),
      });
    } catch (error) {
      if (error instanceof ProjectWorkerBusyError) {
        // The reservation was lost to another owner: this is not a launch failure at all.
        this.release(claimed.agentId, claimed.id);
        await this.transition(claimed, {
          status: 'queued',
          updatedAt: this.now().toISOString(),
          claimedAt: undefined,
          message: undefined,
          failureKind: undefined,
          retryAt: undefined,
        });
        return;
      }
      await this.recordPreLaunchFailure(claimed, error, this.now().toISOString());
      return;
    }
    await this.recordLaunched(claimed, run);
  }

  /**
   * §3, §4, §14 — a launch that returned a run id is real. This method never writes anything that
   * says otherwise.
   *
   * It is called twice: at the launch boundary (as soon as the run record is durable) and again when
   * the worker returns, so the entry's record converges even if the first write was lost. Only a
   * user cancellation overrides it, and then the run identity is attached to the cancelled entry
   * instead of the cancellation being undone.
   */
  private async recordLaunched(claimed: ProjectQueueEntry, run: ProjectTaskRun): Promise<void> {
    const current = (await this.entries.get(claimed.id)) ?? claimed;
    if (current.runId === run.id && current.status === 'launched') return;
    if (current.status === 'cancelled') {
      await this.recordRunIdentityOnCancellation(current, run);
      return;
    }
    const base = current.runId === run.id ? current : current;
    const launched: Partial<ProjectQueueEntry> & { status: ProjectQueueStatus } = {
      status: 'launched',
      runId: run.id,
      updatedAt: this.now().toISOString(),
      claimedAt: base.claimedAt,
      message: `Worker run ${run.id} was created. Follow its real status in project history.`,
      failureKind: 'launched',
      retryAt: undefined,
    };
    try {
      if (await this.transition(base, launched)) return;
      // The guarded write lost: something else decided this entry's fate. Never resurrect it, but do
      // keep the truth that a real run exists.
      const latest = await this.entries.get(claimed.id);
      if (latest) await this.recordRunIdentityOnCancellation(latest, run);
      return;
    } catch (error) {
      // Keep the launch truth: a persistence failure is reported as a persistence failure.
      const reason = error instanceof Error ? error.message : String(error);
      try {
        await this.transition(base, {
          ...launched,
          message: `Worker run ${run.id} was created, but IRIS could not save the queue update (${reason}). The run exists and is the truth; reconcile before retrying this entry.`,
          failureKind: 'launched',
        });
      } catch {
        // Both writes were rejected. The run itself is the durable truth of the launch and
        // `reconcile` reconstructs the entry from it; nothing here may claim the launch failed.
      }
    }
  }

  /**
   * §14, §16 — a stale dispatch continuation may never undo a decision the user already made.
   *
   * The entry stays cancelled. The real run identity is attached to it so the UI can state that a
   * worker exists and must be cancelled itself, instead of implying nothing happened.
   */
  private async recordRunIdentityOnCancellation(
    cancelled: ProjectQueueEntry,
    run: ProjectTaskRun,
  ): Promise<void> {
    if (cancelled.status !== 'cancelled' || cancelled.runId === run.id) return;
    try {
      await this.transition(cancelled, {
        status: 'cancelled',
        runId: run.id,
        updatedAt: this.now().toISOString(),
        failureKind: 'launched',
        message: `This entry was cancelled, but worker run ${run.id} had already been created. That run is real; cancel it in project history to stop it.`,
      });
    } catch {
      // Keep the cancellation exactly as the user left it.
    }
  }

  /**
   * §13 — classify a rejection that happened before a run was observed.
   *
   * Only a rejection the runtime proved created nothing is retry-safe. Anything else may have left
   * a run behind, so it is recorded as unknown and never retried automatically.
   */
  private async recordPreLaunchFailure(
    entry: ProjectQueueEntry,
    error: unknown,
    at: string,
  ): Promise<void> {
    this.release(entry.agentId, entry.id);
    const reason = error instanceof Error ? error.message : String(error);
    const retrySafe = error instanceof ProjectWorkerNotLaunchedError;
    const attempts = (entry.attempts ?? 0) + 1;
    if (retrySafe && attempts < projectQueueMaxAttempts) {
      await this.transition(entry, {
        status: 'queued',
        updatedAt: at,
        claimedAt: undefined,
        attempts,
        retryAt: new Date(Date.parse(at) + projectQueueRetryDelayMs).toISOString(),
        failureKind: 'not-launched',
        message: `Attempt ${attempts} of ${projectQueueMaxAttempts} did not start a worker: ${reason}`,
      });
      return;
    }
    const kind: ProjectLaunchFailureKind = retrySafe ? 'configuration' : 'unknown';
    await this.transition(entry, {
      status: 'needs-attention',
      updatedAt: at,
      attempts,
      retryAt: undefined,
      failureKind: kind,
      message: retrySafe
        ? `No worker was started after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${reason} IRIS will not retry automatically.`
        : `IRIS could not tell whether a worker was started: ${reason} Inspect the actual outcome before queueing this task again.`,
    });
  }

  /** Applies a transition that is only allowed to win while the entry is still what we read. */
  private async transition(
    expected: ProjectQueueEntry,
    patch: Partial<ProjectQueueEntry> & { status: ProjectQueueStatus },
  ): Promise<boolean> {
    const next: ProjectQueueEntry = { ...expected };
    const target = next as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      // An explicit `undefined` in the patch clears the field instead of leaving a stale value.
      if (value === undefined) delete target[key];
      else target[key] = value;
    }
    next.status = patch.status;
    next.updatedAt = patch.updatedAt ?? this.now().toISOString();
    if (!this.entries.saveIfUnchanged) {
      await this.entries.save(next);
      return true;
    }
    return this.entries.saveIfUnchanged(next, {
      status: expected.status,
      updatedAt: expected.updatedAt,
      ...(expected.runId !== undefined ? { runId: expected.runId } : {}),
    });
  }

  private release(agentId: string, ownerId: string): void {
    this.reservations?.release(agentId, ownerId);
  }

  private async findRun(entry: ProjectQueueEntry): Promise<ProjectTaskRun | null> {
    if (!this.launcher.findRun) return null;
    return this.launcher.findRun({
      projectId: entry.projectId,
      taskId: entry.taskId,
      agentId: entry.agentId,
      queuedAt: entry.queuedAt,
    });
  }
}

/** Newest of the runs that could belong to a queue entry, by the shared total run order. */
export function newestRunForEntry(
  runs: readonly ProjectTaskRun[],
  entry: Pick<ProjectQueueEntry, 'projectId' | 'taskId' | 'agentId' | 'queuedAt'>,
): ProjectTaskRun | undefined {
  const candidates = runs.filter(
    (run) =>
      run.projectId === entry.projectId &&
      run.taskId === entry.taskId &&
      run.agentId === entry.agentId &&
      run.createdAt >= entry.queuedAt,
  );
  return [...candidates].sort(compareProjectRunsNewestFirst)[0];
}
