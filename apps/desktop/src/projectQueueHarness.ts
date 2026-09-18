/**
 * IRIS Phase 2G test harness — the real project queue dispatch path, wired exactly like
 * `projectQueueRuntime.ts`, with deterministic control over the model worker and a fault-injectable
 * durable store.
 *
 * Only the worker executor (the model) and the storage failure mode are fakes. The dispatcher, the
 * run committer, the run/graph/queue repositories, the workflow runtime and every state transition
 * under test are production code.
 */
import {
  ProjectQueueDispatcher,
  ProjectWorkflowRuntime,
  isNonTerminalProjectTaskRun,
  newestRunForEntry,
  type ProjectGraph,
  type ProjectQueueEntry,
  type ProjectTaskRun,
  type ProjectWorkerEvent,
  type ProjectWorkerExecutionInput,
  type ProjectWorkerExecutor,
  type ProjectWorkerRecovery,
  type ProjectWorkerReservation,
} from '@iris/workflows';
import {
  LocalProjectGraphRepository,
  LocalProjectQueueRepository,
  LocalProjectRunCommitter,
  LocalProjectTaskRunRepository,
} from './persistence';

/** One durable key, named so a failure can be aimed at exactly one repository. */
export type FaultKey = 'graph' | 'runs' | 'queue';

const storageKeys: Record<FaultKey, string> = {
  graph: 'iris.projects.graph.v1',
  runs: 'iris.projects.task-runs.v1',
  queue: 'iris.projects.queue.v1',
};

/**
 * A `Storage` that is a real in-memory store except for explicitly armed write failures. It is the
 * only way the queue path can be shown to lose a worker it genuinely started.
 */
export class FaultStorage implements Storage {
  private readonly values = new Map<string, string>();
  private readonly failing = new Map<string, number>();
  readonly writes: string[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  /** Fails the next `count` writes of one durable key, exactly like a rejected durable commit. */
  failWrites(key: FaultKey, count = 1): void {
    this.failing.set(storageKeys[key], count);
  }

  written(key: FaultKey): string | null {
    return this.values.get(storageKeys[key]) ?? null;
  }

  writeCount(key: FaultKey): number {
    return this.writes.filter((candidate) => candidate === storageKeys[key]).length;
  }

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    const remaining = this.failing.get(key) ?? 0;
    if (remaining > 0) {
      this.failing.set(key, remaining - 1);
      throw new Error(`Durable storage rejected the write for ${key}.`);
    }
    this.values.set(key, value);
    this.writes.push(key);
  }

  removeItem(key: string): void {
    this.values.delete(key);
    this.writes.push(key);
  }

  clear(): void {
    this.values.clear();
  }
}

export interface WorkerScript {
  /** Resolves once the fake model may finish its turn. */
  readonly gate: Promise<void>;
  release(): void;
  /** Rejects the preparation step (provider/keyring resolution) instead of running. */
  failPrepare?: Error;
  /** When armed, `prepare` waits for this before returning, so a race can be aimed at the gap. */
  prepareGate?: Promise<void>;
  holdPreparation(): void;
  releasePrepare(): void;
  /** Number of times `prepare` was entered. */
  prepares: number;
  /** Number of times `execute` was entered. */
  executions: number;
  /** Runs the launcher observed, in order. */
  launchedRunIds: string[];
}

export function scriptedWorker(): WorkerScript {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releasePrepare!: () => void;
  const script: WorkerScript = {
    gate,
    release,
    holdPreparation() {
      script.prepareGate = new Promise<void>((resolve) => {
        releasePrepare = resolve;
      });
    },
    releasePrepare: () => releasePrepare?.(),
    prepares: 0,
    executions: 0,
    launchedRunIds: [],
  };
  return script;
}

export interface ProjectQueueHarnessOptions {
  readonly storage?: FaultStorage;
  readonly graph: ProjectGraph;
  readonly script: WorkerScript;
  readonly now?: () => Date;
  readonly createId?: () => string;
  /** Wires the shared exclusive-execution reservation, as production does. Defaults to on. */
  readonly reservations?: boolean;
}

export interface ProjectQueueHarness {
  readonly storage: FaultStorage;
  readonly graphs: LocalProjectGraphRepository;
  readonly runs: LocalProjectTaskRunRepository;
  readonly queue: LocalProjectQueueRepository;
  readonly committer: LocalProjectRunCommitter;
  readonly runtime: ProjectWorkflowRuntime;
  readonly dispatcher: ProjectQueueDispatcher;
  readonly script: WorkerScript;
  readonly reservations?: ProjectWorkerReservation;
  /** What the production `isProjectAgentAvailable` port resolves. */
  setAgentAvailable(available: boolean): void;
  /** Agent ids the availability port was asked about, in order. */
  readonly availabilityChecks: string[];
  /** Records a worker run the launcher created but the harness did not run through the runtime. */
  enqueue(entry: ProjectQueueEntry): Promise<void>;
  /** Cancels an entry exactly as the Projects UI does, through durable storage. */
  cancel(id: string, message?: string): Promise<void>;
  /** The reservation holder for an agent, from the shared registry (or `undefined` when free). */
  leasesHolder(agentId: string): { ownerId: string } | undefined;
  /** Reserves an agent on behalf of another runtime, e.g. the scheduled runtime. */
  reserveForOtherRuntime(agentId: string, ownerId: string): boolean;
  releaseForOtherRuntime(agentId: string, ownerId: string): boolean;
}

/** A minimal in-memory stand-in for `AgentExecutionLeaseRegistry`, same atomic semantics. */
function createReservations(): ProjectWorkerReservation {
  const holders = new Map<string, string>();
  return {
    reserve: (agentId, ownerId) => {
      const existing = holders.get(agentId);
      if (existing && existing !== ownerId) return false;
      holders.set(agentId, ownerId);
      return true;
    },
    holder: (agentId) => {
      const ownerId = holders.get(agentId);
      return ownerId === undefined ? undefined : { ownerId };
    },
    transfer: (agentId, fromOwnerId, toOwnerId) => {
      if (holders.get(agentId) !== fromOwnerId) return false;
      holders.set(agentId, toOwnerId);
      return true;
    },
    release: (agentId, ownerId) => {
      if (holders.get(agentId) !== ownerId) return false;
      holders.delete(agentId);
      return true;
    },
  };
}

/**
 * Builds the production project queue path over a fault-injectable store.
 *
 * This mirrors `projectQueueRuntime.ts`: the same dispatcher, the same launcher closure over
 * `ProjectWorkflowRuntime.launch`, the same repositories and committer.
 */
export async function createProjectQueueHarness(
  options: ProjectQueueHarnessOptions,
): Promise<ProjectQueueHarness> {
  const storage = options.storage ?? new FaultStorage();
  const now = options.now ?? (() => new Date());
  const graphs = new LocalProjectGraphRepository(storage);
  const runs = new LocalProjectTaskRunRepository(storage);
  const queue = new LocalProjectQueueRepository(storage);
  const committer = new LocalProjectRunCommitter(storage);
  const script = options.script;
  let available = true;
  const availabilityChecks: string[] = [];

  const workers: ProjectWorkerExecutor = {
    async prepare(agentId) {
      script.prepares += 1;
      if (script.prepareGate) await script.prepareGate;
      if (script.failPrepare) throw script.failPrepare;
      return { agentName: `Agent ${agentId}` };
    },
    async *execute(input: ProjectWorkerExecutionInput): AsyncGenerator<ProjectWorkerEvent> {
      script.executions += 1;
      script.launchedRunIds.push(input.run.id);
      await script.gate;
      yield { type: 'started', runtimeTurnId: `turn-${input.run.id}` };
      yield { type: 'returned', runtimeTurnId: `turn-${input.run.id}`, output: 'Saved report.' };
    },
    async *resume(input: ProjectWorkerExecutionInput): AsyncGenerator<ProjectWorkerEvent> {
      yield { type: 'started', runtimeTurnId: `turn-${input.run.id}` };
      yield { type: 'returned', runtimeTurnId: `turn-${input.run.id}`, output: 'Resumed report.' };
    },
    async *continue(input: ProjectWorkerExecutionInput): AsyncGenerator<ProjectWorkerEvent> {
      yield { type: 'started', runtimeTurnId: `turn-${input.run.id}` };
      yield { type: 'returned', runtimeTurnId: `turn-${input.run.id}`, output: 'Continued report.' };
    },
    async cancel(): Promise<void> {
      script.release();
    },
    async recover(run: ProjectTaskRun): Promise<ProjectWorkerRecovery> {
      return { status: 'failed', failure: 'Recovery is not scripted for this run.', runtimeTurnId: run.runtimeTurnId };
    },
  };

  await graphs.save(options.graph);

  const reservations = options.reservations === false ? undefined : createReservations();

  const runtime = new ProjectWorkflowRuntime(
    graphs,
    runs,
    workers,
    undefined,
    now,
    options.createId,
    committer,
    undefined,
    reservations,
  );

  const dispatcher = new ProjectQueueDispatcher(
    graphs,
    queue,
    {
      available: async (agentId) => {
        availabilityChecks.push(agentId);
        return available;
      },
      launch: (input) =>
        runtime.launch({
          projectId: input.projectId,
          taskId: input.taskId,
          agentId: input.agentId,
          ...(input.reservationOwnerId ? { reservationOwnerId: input.reservationOwnerId } : {}),
          ...(input.onRunCreated ? { onRunCreated: input.onRunCreated } : {}),
        }),
      busyAgentIds: async () =>
        (await runs.list()).filter(isNonTerminalProjectTaskRun).map((run) => run.agentId),
      findRun: async (input) =>
        newestRunForEntry(await runs.list(input.projectId), input) ?? null,
    },
    now,
    reservations,
  );

  return {
    storage,
    graphs,
    runs,
    queue,
    committer,
    runtime,
    dispatcher,
    script,
    reservations,
    setAgentAvailable(value) {
      available = value;
    },
    availabilityChecks,
    enqueue: (entry) => queue.enqueue(entry),
    leasesHolder: (agentId) => reservations?.holder(agentId),
    reserveForOtherRuntime: (agentId, ownerId) =>
      reservations?.reserve(agentId, ownerId, now().toISOString()) ?? false,
    releaseForOtherRuntime: (agentId, ownerId) => reservations?.release(agentId, ownerId) ?? false,
    async cancel(id, message = 'Removed from the project queue before dispatch.') {
      const entry = await queue.get(id);
      if (!entry) throw new Error(`Unknown queue entry: ${id}`);
      await queue.save({
        ...entry,
        status: 'cancelled',
        updatedAt: new Date(Date.parse(entry.updatedAt) + 1000).toISOString(),
        message,
      });
    },
  };
}

/**
 * Drains pending microtasks and one macrotask turn so fire-and-forget dispatch continuations settle
 * deterministically without sleeping on a wall-clock timer.
 */
export async function settle(times = 12): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}
