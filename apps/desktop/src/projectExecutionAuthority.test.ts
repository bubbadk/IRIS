/**
 * IRIS Phase 2I.2 — product regression coverage for cross-process execution authority.
 *
 * These tests use the real `ProjectWorkflowRuntime`, the real `LocalProjectTaskRunRepository`
 * (including its transaction-scoped terminal-state guard), the real `AgentExecutionLeaseRegistry`
 * and the real `createLeaseAuthority` optimistic-CAS authority. Two runtimes with separate local
 * registries share one durable store and one lease backend, which is the same topology the Phase
 * 2I.0 two-OS-process harness uses. The real two-process adversarial proof remains in
 * `.audit-validation/harness/xproc`.
 */
import { describe, expect, it } from 'vitest';
import {
  AgentExecutionLeaseRegistry,
  agentLeaseStorageKey,
  createLeaseAuthority,
  type CrossProcessLeasePort,
  type CrossProcessLeaseIdentity,
  type ProcessLiveness,
} from '@iris/agents';
import {
  ProjectWorkerBusyError,
  ProjectWorkflowRuntime,
  addProjectTask,
  createProjectGraph,
  type ProjectGraph,
  type ProjectTaskRun,
  type ProjectWorkerExecutor,
  type ProjectWorkerRecovery,
  type ProjectWorkerReservation,
} from '@iris/workflows';
import { LocalProjectGraphRepository, LocalProjectTaskRunRepository } from './persistence';
import {
  RepositoryTransactions,
  type RepositoryBackend,
  type StorageSnapshot,
} from './repositoryStorage';
import { FaultStorage } from './projectQueueHarness';

const at = '2026-09-18T00:00:00.000Z';

class CasBackend implements RepositoryBackend {
  data: StorageSnapshot = { values: {}, revisions: {} };
  async snapshot(): Promise<StorageSnapshot> {
    return structuredClone(this.data);
  }
  async commit(expected: Record<string, number>, changes: Record<string, string | null>) {
    if (
      Object.entries(expected).some(([key, revision]) => (this.data.revisions[key] ?? 0) !== revision)
    )
      return false;
    for (const [key, value] of Object.entries(changes)) {
      this.data.revisions[key] = (this.data.revisions[key] ?? 0) + 1;
      if (value === null) delete this.data.values[key];
      else this.data.values[key] = value;
    }
    return true;
  }
}

function identity(
  pid: number,
  instance: string,
  verdicts: Record<number, 'alive' | 'dead' | 'unknown'>,
): CrossProcessLeaseIdentity {
  return {
    pid: async () => pid,
    instance: () => instance,
    liveness: async (candidate: number): Promise<ProcessLiveness> => {
      const verdict = verdicts[candidate] ?? 'dead';
      return verdict === 'unknown'
        ? { status: 'unknown', reason: 'Injected probe failure.' }
        : { status: verdict };
    },
  };
}

function authority(
  backend: CasBackend,
  pid: number,
  instance: string,
  verdicts: Record<number, 'alive' | 'dead' | 'unknown'>,
): CrossProcessLeasePort {
  return createLeaseAuthority(new RepositoryTransactions(backend), identity(pid, instance, verdicts));
}

function reservationsFor(
  leases: AgentExecutionLeaseRegistry,
  port: CrossProcessLeasePort,
): ProjectWorkerReservation {
  return {
    reserve: (agentId, ownerId, reservedAt) =>
      leases.reserve({ agentId, ownerId, ownerKind: 'project', acquiredAt: reservedAt }),
    holder: (agentId) => {
      const holder = leases.holder(agentId);
      return holder ? { ownerId: holder.ownerId } : undefined;
    },
    transfer: (agentId, fromOwnerId, toOwnerId, transferredAt, runId) =>
      leases.transfer(agentId, fromOwnerId, toOwnerId, transferredAt, runId),
    release: (agentId, ownerId) => leases.release(agentId, ownerId),
    crossProcess: {
      acquire: (agentId, ownerId, acquiredAt, runId) =>
        port.acquire(agentId, ownerId, 'project', acquiredAt, runId),
      release: (agentId, ownerId) => port.release(agentId, ownerId),
      inspect: (agentId) => port.inspect(agentId),
      ...(port.holderStatus
        ? {
            holderStatus: (agentId) =>
              port.holderStatus!(agentId).then((holder) =>
                holder
                  ? { ownerId: holder.ownerId, foreign: holder.foreign, liveness: holder.liveness }
                  : undefined,
              ),
          }
        : {}),
    },
  };
}

function graph(): ProjectGraph {
  return addProjectTask(
    createProjectGraph({
      id: 'project',
      title: 'Authority project',
      objective: 'Verify cross-process execution authority.',
      createdAt: at,
    }),
    { id: 'task', title: 'Task', dependencyIds: [], createdAt: at },
  );
}

function activeRun(overrides: Partial<ProjectTaskRun> = {}): ProjectTaskRun {
  return {
    version: 1,
    id: 'run-active',
    projectId: 'project',
    taskId: 'task',
    agentId: 'agent',
    agentName: 'Agent',
    acceptanceCriteria: 'Deterministic.',
    turnLimit: 1,
    turnsUsed: 1,
    runtimeTurnId: 'turn-active',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    ...overrides,
  };
}

function suspendedRun(overrides: Partial<ProjectTaskRun> = {}): ProjectTaskRun {
  return activeRun({
    id: 'run-appr',
    runtimeTurnId: 'turn-appr',
    status: 'suspended',
    suspendedAt: at,
    approval: {
      id: 'approval-appr',
      toolId: 'workspace.write',
      toolName: 'Write workspace file',
      reason: 'Awaiting approval.',
    },
    ...overrides,
  });
}

function worker(script: {
  gate?: Promise<void>;
  onResume?: () => void;
  onRecover?: (run: ProjectTaskRun) => Promise<ProjectWorkerRecovery>;
}): ProjectWorkerExecutor {
  return {
    async prepare(id) {
      return { agentName: `Agent ${id}` };
    },
    async *execute() {
      if (script.gate) await script.gate;
      yield { type: 'returned', runtimeTurnId: 'turn-active', output: 'Report.' };
    },
    async *resume() {
      script.onResume?.();
      yield { type: 'returned', runtimeTurnId: 'turn-appr', output: 'Resumed report.' };
    },
    async *continue() {
      yield { type: 'returned', runtimeTurnId: 'turn-active', output: 'Continued report.' };
    },
    async cancel() {
      /* no local cancellation state in the observing process */
    },
    async recover(run) {
      if (script.onRecover) return script.onRecover(run);
      return { status: 'failed', failure: 'Recovered as stale.', runtimeTurnId: run.runtimeTurnId };
    },
  };
}

function runtime(
  projects: LocalProjectGraphRepository,
  runs: LocalProjectTaskRunRepository,
  workers: ProjectWorkerExecutor,
  reservations?: ProjectWorkerReservation,
  createId: () => string = () => 'run-test',
): ProjectWorkflowRuntime {
  return new ProjectWorkflowRuntime(
    projects,
    runs,
    workers,
    () => undefined,
    () => new Date(at),
    createId,
    undefined,
    undefined,
    reservations,
  );
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('The expected durable state was not observed.');
}

describe('Phase 2I.2 cross-process execution authority', () => {
  it('H4: a stale execution write cannot resurrect a run cancelled by another process', async () => {
    const storage = new FaultStorage();
    const projects = new LocalProjectGraphRepository(storage);
    const runs = new LocalProjectTaskRunRepository(storage);
    await projects.save(graph());

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = runtime(projects, runs, worker({ gate }), undefined, () => 'run-h4');
    const launch = owner.launch({ projectId: 'project', taskId: 'task', agentId: 'agent' });
    await eventually(async () => (await runs.get('run-h4'))?.status === 'running');

    const nonOwner = runtime(projects, runs, worker({}), undefined, () => 'run-other');
    const cancelled = await nonOwner.cancel('run-h4');
    expect(cancelled.status).toBe('cancelled');

    release();
    const result = await launch;
    expect(result.status).toBe('cancelled');
    const durable = await runs.get('run-h4');
    expect(durable?.status).toBe('cancelled');
    expect(durable?.cancelledAt).toBeTruthy();
  });

  it.each([
    ['alive', 'alive'],
    ['unknown', 'unknown'],
  ] as const)(
    'H5a: reconcile does not mutate a live foreign run when its owner is %s',
    async (_label, verdict) => {
      const backend = new CasBackend();
      const storage = new FaultStorage();
      const projects = new LocalProjectGraphRepository(storage);
      const runs = new LocalProjectTaskRunRepository(storage);
      await projects.save(graph());
      await runs.save(activeRun({ id: 'run-h5a' }));

      const owner = authority(backend, 100, 'owner', { 100: 'alive' });
      expect(await owner.acquire('agent', 'project-run:run-h5a', 'project', at, 'run-h5a')).toBe(true);

      const observer = authority(backend, 200, 'observer', { 100: verdict });
      let recoveries = 0;
      const observing = runtime(
        projects,
        runs,
        worker({
          onRecover: async (run) => {
            recoveries += 1;
            return { status: 'failed', failure: 'Must not happen.', runtimeTurnId: run.runtimeTurnId };
          },
        }),
        reservationsFor(new AgentExecutionLeaseRegistry(), observer),
      );
      await observing.reconcile();
      expect(recoveries).toBe(0);
      expect((await runs.get('run-h5a'))?.status).toBe('running');
      expect(await observer.holderStatus?.('agent')).toMatchObject({ foreign: true });
    },
  );

  it('H5a: reconcile recovers only after the foreign owner is proven dead', async () => {
    const backend = new CasBackend();
    const storage = new FaultStorage();
    const projects = new LocalProjectGraphRepository(storage);
    const runs = new LocalProjectTaskRunRepository(storage);
    await projects.save(graph());
    await runs.save(activeRun({ id: 'run-dead' }));

    const owner = authority(backend, 100, 'dead-owner', { 100: 'alive' });
    expect(await owner.acquire('agent', 'project-run:run-dead', 'project', at, 'run-dead')).toBe(true);

    const observer = authority(backend, 200, 'observer', { 100: 'dead' });
    let recoveries = 0;
    const observing = runtime(
      projects,
      runs,
      worker({
        onRecover: async (run) => {
          recoveries += 1;
          return { status: 'failed', failure: 'Recovered a dead owner.', runtimeTurnId: run.runtimeTurnId };
        },
      }),
      reservationsFor(new AgentExecutionLeaseRegistry(), observer),
    );
    await observing.reconcile();
    expect(recoveries).toBe(1);
    expect((await runs.get('run-dead'))?.status).toBe('failed');
  });

  it('H5b: a refused cross-process acquisition releases the provisional local reservation', async () => {
    const storage = new FaultStorage();
    const projects = new LocalProjectGraphRepository(storage);
    const runs = new LocalProjectTaskRunRepository(storage);
    await projects.save(graph());
    await runs.save(activeRun({ id: 'run-h5b' }));

    const leases = new AgentExecutionLeaseRegistry();
    let releases = 0;
    const reservations: ProjectWorkerReservation = {
      reserve: (agentId, ownerId, reservedAt) =>
        leases.reserve({ agentId, ownerId, ownerKind: 'project', acquiredAt: reservedAt }),
      holder: (agentId) => {
        const holder = leases.holder(agentId);
        return holder ? { ownerId: holder.ownerId } : undefined;
      },
      transfer: (agentId, fromOwnerId, toOwnerId, transferredAt, runId) =>
        leases.transfer(agentId, fromOwnerId, toOwnerId, transferredAt, runId),
      release: (agentId, ownerId) => {
        releases += 1;
        return leases.release(agentId, ownerId);
      },
      crossProcess: {
        acquire: async () => false,
        release: async () => undefined,
        inspect: async () => undefined,
      },
    };
    const observing = runtime(
      projects,
      runs,
      worker({
        onRecover: async (run) => ({
          status: 'running',
          runtimeTurnId: run.runtimeTurnId ?? 'turn-active',
        }),
      }),
      reservations,
    );
    await observing.reconcile();
    expect(releases).toBe(1);
    expect(leases.holder('agent')).toBeUndefined();
  });

  it('H6: approval settlement is not execution authority under reserveTurns:false', async () => {
    const backend = new CasBackend();
    const storage = new FaultStorage();
    const projects = new LocalProjectGraphRepository(storage);
    const runs = new LocalProjectTaskRunRepository(storage);
    await projects.save(graph());
    await runs.save(suspendedRun());

    const owner = authority(backend, 100, 'owner', { 100: 'alive' });
    expect(await owner.acquire('agent', 'project-run:run-appr', 'project', at, 'run-appr')).toBe(true);

    const second = authority(backend, 200, 'second', { 100: 'alive' });
    let resumeEntries = 0;
    const resuming = runtime(
      projects,
      runs,
      worker({ onResume: () => void (resumeEntries += 1) }),
      reservationsFor(new AgentExecutionLeaseRegistry(), second),
    );

    await expect(resuming.resolveApproval('approval-appr', 'approve')).rejects.toBeInstanceOf(
      ProjectWorkerBusyError,
    );
    expect(resumeEntries).toBe(0);
    expect((await runs.get('run-appr'))?.status).toBe('suspended');

    // The deferred approval is not lost: once the live owner releases, the same resume succeeds
    // exactly once and a duplicate settlement finds nothing left to resolve.
    await owner.release('agent', 'project-run:run-appr');
    const resumed = await resuming.resolveApproval('approval-appr', 'approve');
    expect(resumed.status).toBe('awaiting-review');
    expect(resumeEntries).toBe(1);
    await expect(resuming.resolveApproval('approval-appr', 'approve')).rejects.toThrow(
      'No suspended project worker',
    );
  });

  it('H6: unknown foreign liveness fails closed for approval resume', async () => {
    const backend = new CasBackend();
    const storage = new FaultStorage();
    const projects = new LocalProjectGraphRepository(storage);
    const runs = new LocalProjectTaskRunRepository(storage);
    await projects.save(graph());
    await runs.save(suspendedRun({ id: 'run-unknown' }));

    const owner = authority(backend, 100, 'owner', { 100: 'alive' });
    expect(await owner.acquire('agent', 'project-run:run-unknown', 'project', at, 'run-unknown')).toBe(
      true,
    );
    const second = authority(backend, 200, 'second', { 100: 'unknown' });
    let resumeEntries = 0;
    const resuming = runtime(
      projects,
      runs,
      worker({ onResume: () => void (resumeEntries += 1) }),
      reservationsFor(new AgentExecutionLeaseRegistry(), second),
    );
    await expect(resuming.resolveApproval('approval-appr', 'approve')).rejects.toBeInstanceOf(
      ProjectWorkerBusyError,
    );
    expect(resumeEntries).toBe(0);
    expect((await runs.get('run-unknown'))?.status).toBe('suspended');
  });

  it('H6: a proven dead owner still permits safe approval recovery', async () => {
    const backend = new CasBackend();
    const storage = new FaultStorage();
    const projects = new LocalProjectGraphRepository(storage);
    const runs = new LocalProjectTaskRunRepository(storage);
    await projects.save(graph());
    await runs.save(suspendedRun({ id: 'run-dead-approval' }));

    const owner = authority(backend, 100, 'owner', { 100: 'alive' });
    expect(
      await owner.acquire('agent', 'project-run:run-dead-approval', 'project', at, 'run-dead-approval'),
    ).toBe(true);
    const second = authority(backend, 200, 'second', { 100: 'dead' });
    let resumeEntries = 0;
    const resuming = runtime(
      projects,
      runs,
      worker({ onResume: () => void (resumeEntries += 1) }),
      reservationsFor(new AgentExecutionLeaseRegistry(), second),
    );
    await expect(
      resuming.resolveApproval('approval-appr', 'approve'),
    ).resolves.toMatchObject({ status: 'awaiting-review' });
    expect(resumeEntries).toBe(1);
  });
});

/**
 * Phase 2J.2 — regression coverage for the release blocker F-2J2-SCH-01.
 *
 * The defect: `ProjectWorkflowRuntime.launch` released its provisional local reservation only when
 * the cross-process authority *refused* (`acquire === false`). When the acquisition *threw* —
 * which a corrupt `iris.agents.execution-leases.v1` document or a failing `process_own_pid` IPC
 * probe both do — the await escaped before any cleanup, so the local reservation stayed held for
 * the lifetime of the process. Every later launch for that agent was then refused with a false
 * "already executing", and only an application restart cleared it. The same unguarded shape existed
 * at the reservation re-establishment step inside `reconcile()`.
 *
 * Every case below drives the real `ProjectWorkflowRuntime`, the real `AgentExecutionLeaseRegistry`
 * and the real `createLeaseAuthority` over a real `RepositoryTransactions`, with isolated in-memory
 * storage only. Each one fails against the pre-repair control flow.
 */
interface PidFault {
  active: boolean;
}

type LivenessVerdicts = Record<number, 'alive' | 'dead' | 'unknown'>;

/** The local runtime's identity: a working pid probe that can be made to fail transiently. */
function launchIdentity(fault: PidFault, verdicts: LivenessVerdicts): CrossProcessLeaseIdentity {
  return {
    pid: async () => {
      if (fault.active) throw new Error('process_own_pid IPC unavailable');
      return 555;
    },
    instance: () => 'local',
    liveness: async (candidate): Promise<ProcessLiveness> => {
      const verdict = verdicts[candidate] ?? 'dead';
      return verdict === 'unknown'
        ? { status: 'unknown', reason: 'Injected probe failure.' }
        : { status: verdict };
    },
  };
}

/** The standard worker, plus an entry counter so overlapping execution can be detected. */
function countingWorker(script: { gate?: Promise<void>; onExecute?: () => void }): ProjectWorkerExecutor {
  return {
    async prepare(agentId) {
      return { agentName: `Agent ${agentId}` };
    },
    async *execute() {
      script.onExecute?.();
      if (script.gate) await script.gate;
      yield { type: 'returned', runtimeTurnId: 'turn-active', output: 'Report.' };
    },
    async *resume() {
      yield { type: 'returned', runtimeTurnId: 'turn-appr', output: 'Resumed report.' };
    },
    async *continue() {
      yield { type: 'returned', runtimeTurnId: 'turn-active', output: 'Continued report.' };
    },
    async cancel() {
      /* no local cancellation state in the observing process */
    },
    async recover(run) {
      return { status: 'failed', failure: 'Recovered as stale.', runtimeTurnId: run.runtimeTurnId ?? 'turn-active' };
    },
  };
}

async function launchHarness(
  options: {
    backend?: CasBackend;
    fault?: PidFault;
    verdicts?: LivenessVerdicts;
    gate?: Promise<void>;
    createId?: () => string;
    onRelease?: () => void;
  } = {},
) {
  const backend = options.backend ?? new CasBackend();
  const fault = options.fault ?? { active: false };
  const storage = new FaultStorage();
  const projects = new LocalProjectGraphRepository(storage);
  const runs = new LocalProjectTaskRunRepository(storage);
  await projects.save(graph());
  const leases = new AgentExecutionLeaseRegistry();
  const port = createLeaseAuthority(
    new RepositoryTransactions(backend),
    launchIdentity(fault, options.verdicts ?? {}),
  );
  let ids = 0;
  let executions = 0;
  const workers = countingWorker({
    gate: options.gate,
    onExecute: () => void (executions += 1),
  });
  const base = reservationsFor(leases, port);
  const reservations: ProjectWorkerReservation = options.onRelease
    ? {
        ...base,
        release: (agentId, ownerId) => {
          options.onRelease?.();
          return leases.release(agentId, ownerId);
        },
      }
    : base;
  const instance = runtime(
    projects,
    runs,
    workers,
    reservations,
    options.createId ?? (() => `run-${++ids}`),
  );
  return {
    backend,
    fault,
    leases,
    port,
    runs,
    runtime: instance,
    executions: () => executions,
  };
}

/** Settles to the rejection reason instead of throwing, so a specific message can be asserted. */
async function failureOf(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('The operation was expected to fail but succeeded.');
}

const launchAgent = { projectId: 'project', taskId: 'task', agentId: 'agent' } as const;

describe('Phase 2J.2 F-2J2-SCH-01 provisional reservation cleanup', () => {
  it('2J.2 A: a refused cross-process acquisition releases the provisional local reservation', async () => {
    const harness = await launchHarness({ verdicts: { 100: 'alive' } });
    // A live foreign runtime already holds the authoritative lease for this agent.
    const foreign = createLeaseAuthority(
      new RepositoryTransactions(harness.backend),
      identity(100, 'foreign', { 100: 'alive' }),
    );
    expect(
      await foreign.acquire('agent', 'project-run:foreign', 'project', at, 'run-foreign'),
    ).toBe(true);

    const failure = await failureOf(harness.runtime.launch(launchAgent));
    expect(failure).toBeInstanceOf(ProjectWorkerBusyError);
    expect(harness.leases.holder('agent')).toBeUndefined();
    expect((await harness.runs.list()).length).toBe(0);
  });

  it('2J.2 B: a throwing acquisition (corrupt lease document) releases the provisional local reservation', async () => {
    const backend = new CasBackend();
    await backend.commit({}, { [agentLeaseStorageKey]: '{ corrupt' });
    const harness = await launchHarness({ backend });

    const failure = await failureOf(harness.runtime.launch(launchAgent));
    expect(failure.message).toMatch(/invalid/i);
    expect(harness.leases.holder('agent')).toBeUndefined();
    expect((await harness.runs.list()).length).toBe(0);
    // No durable authority was written, so the corrupt document is untouched.
    expect(backend.data.values[agentLeaseStorageKey]).toBe('{ corrupt');
  });

  it('2J.2 C: a retry after a throwing acquisition proceeds once the transient fault is removed', async () => {
    const fault: PidFault = { active: true };
    const harness = await launchHarness({ fault });

    const failure = await failureOf(harness.runtime.launch(launchAgent));
    expect(failure.message).toMatch(/IPC unavailable/);
    expect(harness.leases.holder('agent')).toBeUndefined();

    // The fault clears. No process restart is required, and no durable run was fabricated.
    fault.active = false;
    const run = await harness.runtime.launch(launchAgent);
    expect(run.id).toBe('run-2');
    expect((await harness.runs.list()).length).toBe(1);
  });

  it('2J.2 D: corrupt lease state fails truthfully and never fabricates a busy owner', async () => {
    const backend = new CasBackend();
    await backend.commit({}, { [agentLeaseStorageKey]: '{ corrupt' });
    const harness = await launchHarness({ backend });

    const first = await failureOf(harness.runtime.launch(launchAgent));
    const second = await failureOf(harness.runtime.launch(launchAgent));
    // The infrastructure failure must not be hidden behind an exclusivity message.
    expect(first.message).not.toMatch(/already executing/i);
    expect(second.message).not.toMatch(/already executing/i);
    expect(second.message).toMatch(/invalid/i);
    expect(harness.leases.holder('agent')).toBeUndefined();

    // Repairing the document lets the next launch proceed normally.
    await backend.commit(
      { [agentLeaseStorageKey]: backend.data.revisions[agentLeaseStorageKey] ?? 0 },
      { [agentLeaseStorageKey]: '{}' },
    );
    const run = await harness.runtime.launch(launchAgent);
    expect(run.id).toBe('run-3');
  });

  it('2J.2 E: a transient process-identity failure fails truthfully and leaks nothing', async () => {
    const fault: PidFault = { active: true };
    const harness = await launchHarness({ fault });

    const first = await failureOf(harness.runtime.launch(launchAgent));
    const second = await failureOf(harness.runtime.launch(launchAgent));
    expect(first.message).toMatch(/IPC unavailable/);
    expect(second.message).toMatch(/IPC unavailable/);
    expect(second.message).not.toMatch(/already executing/i);
    expect(harness.leases.holder('agent')).toBeUndefined();
    expect((await harness.runs.list()).length).toBe(0);
  });

  it('2J.2 F: a successful acquisition keeps the authority until the run stops occupying execution', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await launchHarness({ gate });

    const launch = harness.runtime.launch(launchAgent);
    await eventually(async () => (await harness.runs.get('run-1'))?.status === 'running');
    // Ownership was handed over, not dropped: the run really holds the agent, locally and durably.
    expect(harness.leases.holder('agent')?.ownerId).toBe('project-run:run-1');
    const durable = JSON.parse(harness.backend.data.values[agentLeaseStorageKey]!) as Record<
      string,
      { ownerId: string }
    >;
    expect(durable.agent.ownerId).toBe('project-run:run-1');

    release();
    const run = await launch;
    expect(run.status).toBe('awaiting-review');
    expect(harness.leases.holder('agent')).toBeUndefined();
  });

  it('2J.2 G: no false exclusivity after a throwing attempt, and no overlapping execution', async () => {
    const fault: PidFault = { active: true };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await launchHarness({ fault, gate });

    await expect(harness.runtime.launch(launchAgent)).rejects.toThrow(/IPC unavailable/);
    const refused = await failureOf(harness.runtime.launch(launchAgent));
    expect(refused.message).toMatch(/IPC unavailable/);
    expect(refused.message).not.toMatch(/already executing/i);
    expect(harness.leases.holder('agent')).toBeUndefined();

    fault.active = false;
    const first = harness.runtime.launch(launchAgent);
    await eventually(async () => (await harness.runs.get('run-3'))?.status === 'running');
    expect(harness.executions()).toBe(1);
    // Exclusivity is intact: a competing launch cannot enter while the real run is live.
    await expect(harness.runtime.launch(launchAgent)).rejects.toThrow();
    expect(harness.executions()).toBe(1);

    release();
    await first;
    expect(harness.leases.holder('agent')).toBeUndefined();
  });

  it('2J.2 H: the throwing branch releases the provisional reservation exactly once', async () => {
    const fault: PidFault = { active: true };
    let releases = 0;
    const harness = await launchHarness({ fault, onRelease: () => void (releases += 1) });

    await expect(harness.runtime.launch(launchAgent)).rejects.toThrow(/IPC unavailable/);
    expect(releases).toBe(1);
    expect(harness.leases.holder('agent')).toBeUndefined();
  });
});

describe('Phase 2J.2 F-2J2-SCH-01 reconcile-path provisional reservation', () => {
  /** The H5b topology, but with an acquisition that throws instead of refusing. */
  async function reconcileHarness(script: {
    acquire: () => Promise<boolean>;
    recovery: () => ProjectWorkerRecovery;
  }) {
    const storage = new FaultStorage();
    const projects = new LocalProjectGraphRepository(storage);
    const runs = new LocalProjectTaskRunRepository(storage);
    await projects.save(graph());
    await runs.save(activeRun({ id: 'run-2j2' }));
    const leases = new AgentExecutionLeaseRegistry();
    let releases = 0;
    const reservations: ProjectWorkerReservation = {
      reserve: (agentId, ownerId, reservedAt) =>
        leases.reserve({ agentId, ownerId, ownerKind: 'project', acquiredAt: reservedAt }),
      holder: (agentId) => {
        const holder = leases.holder(agentId);
        return holder ? { ownerId: holder.ownerId } : undefined;
      },
      transfer: (agentId, fromOwnerId, toOwnerId, transferredAt, runId) =>
        leases.transfer(agentId, fromOwnerId, toOwnerId, transferredAt, runId),
      release: (agentId, ownerId) => {
        releases += 1;
        return leases.release(agentId, ownerId);
      },
      crossProcess: {
        acquire: script.acquire,
        release: async () => undefined,
        inspect: async () => undefined,
      },
    };
    const observing = runtime(
      projects,
      runs,
      worker({ onRecover: async () => script.recovery() }),
      reservations,
    );
    return { leases, observing, releases: () => releases, runs };
  }

  it('2J.2 R1: a throwing acquisition during reconcile releases the provisional local reservation', async () => {
    const harness = await reconcileHarness({
      acquire: async () => {
        throw new Error('process_own_pid IPC unavailable');
      },
      recovery: () => ({ status: 'running', runtimeTurnId: 'turn-2j2' }),
    });

    await expect(harness.observing.reconcile()).rejects.toThrow(/IPC unavailable/);
    expect(harness.releases()).toBe(1);
    expect(harness.leases.holder('agent')).toBeUndefined();
  });

  it('2J.2 R2: a throwing acquisition during reconcile cannot leave a phantom owner that blocks a retry', async () => {
    let acquireFails = true;
    let recovery: ProjectWorkerRecovery = { status: 'running', runtimeTurnId: 'turn-2j2' };
    const harness = await reconcileHarness({
      acquire: async () => {
        if (acquireFails) throw new Error('process_own_pid IPC unavailable');
        return true;
      },
      recovery: () => recovery,
    });

    await expect(harness.observing.reconcile()).rejects.toThrow(/IPC unavailable/);
    expect(harness.leases.holder('agent')).toBeUndefined();

    // The transient fault clears and the stale run settles on the next reconcile.
    acquireFails = false;
    recovery = { status: 'failed', failure: 'Recovered as stale.', runtimeTurnId: 'turn-2j2' };
    await harness.observing.reconcile();
    expect((await harness.runs.get('run-2j2'))?.status).toBe('failed');

    // A fresh launch for the same agent must reach the normal next stage, not a phantom busy.
    const launched = await harness.observing.launch(launchAgent);
    expect(launched.status).toBe('awaiting-review');
  });
});
