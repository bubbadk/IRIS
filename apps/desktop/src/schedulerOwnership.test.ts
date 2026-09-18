// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startScheduledRuntime, scheduledRuntimeStatus } from './scheduledRuntime';
import { startProjectQueueRuntime, projectQueueRuntimeStatus } from './projectQueueRuntime';

const { invoke, isTauriRuntime } = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriRuntime: vi.fn(() => true),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('./credentials', () => ({ isTauriRuntime }));
vi.mock('./scheduledQueue', () => ({
  scheduledQueue: {
    isPaused: vi.fn(async () => false),
    setPaused: vi.fn(async () => undefined),
    claim: vi.fn(async () => null),
  },
}));
// The runtimes only reach these repositories; everything else is mocked out so the ownership
// contract is tested in isolation instead of pulling the whole desktop runtime graph in.
vi.mock('./persistence', () => ({
  agentRepository: { get: vi.fn(async () => undefined) },
  scheduleRepository: { list: vi.fn(async () => []) },
  scheduledRunRepository: {
    list: vi.fn(async () => []),
    save: vi.fn(async () => undefined),
  },
  // The scheduled runner reads the approval and the agent transcript when it reconciles a
  // suspended run; ownership tests never have one.
  toolApprovalRepository: { get: vi.fn(async () => undefined) },
  conversationRepository: { list: vi.fn(async () => []) },
  projectGraphRepository: { list: vi.fn(async () => []) },
  projectQueueRepository: { list: vi.fn(async () => []) },
  projectTaskRunRepository: { list: vi.fn(async () => []) },
}));
vi.mock('./agentRuntime', () => ({
  agentRuntime: {
    runningAgentIds: [],
    suspendedForAgent: vi.fn(async () => false),
    send: vi.fn(),
    resolveApproval: vi.fn(),
    reconcileExecutionReservations: vi.fn(async () => 0),
  },
  providerResolver: { resolve: vi.fn() },
  scheduledAgentEvents: vi.fn(),
}));
vi.mock('./userActivity', () => ({ refreshIdleSchedules: vi.fn(async () => undefined) }));
vi.mock('./projectRuntime', () => ({
  isProjectAgentAvailable: vi.fn(async () => false),
  projectWorkflowRuntime: {
    suspendedForApproval: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => []),
  },
  subscribeProjectRuntime: vi.fn(() => () => undefined),
}));

/** Lets the fire-and-forget ownership task settle before assertions. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.resetAllMocks();
  isTauriRuntime.mockReturnValue(true);
});

describe('scheduler ownership degradation', () => {
  /**
   * H-04 Test 1: when ownership is granted, the schedule runtime reports the real running state.
   */
  it('reports running only after ownership is truly acquired', async () => {
    invoke.mockResolvedValue(true);
    const stop = startScheduledRuntime();
    await settle();
    expect(invoke).toHaveBeenCalledWith('acquire_schedule_owner');
    expect(scheduledRuntimeStatus().status).toBe('running');
    stop();
  });

  /**
   * H-04 Test 2 + 4: when another process owns the lock, the runtime must never report running.
   */
  it('never reports running when another process owns the lock', async () => {
    invoke.mockResolvedValue(false);
    const stop = startScheduledRuntime();
    await settle();
    const status = scheduledRuntimeStatus();
    expect(status.status).toBe('unavailable');
    expect(status.status).not.toBe('running');
    expect(status.message).toContain('Another IRIS process');
    stop();
  });

  /**
   * H-04 Test 3 + 4: a real lock failure (filesystem/permission error) is surfaced as unavailable
   * with the underlying reason, never as a false success and never as an application failure.
   */
  it('surfaces a lock I/O failure as unavailable instead of a false success', async () => {
    invoke.mockRejectedValue('The schedule owner lock is unavailable: Permission denied (os error 13)');
    const stop = startScheduledRuntime();
    await settle();
    const status = scheduledRuntimeStatus();
    expect(status.status).toBe('unavailable');
    expect(status.status).not.toBe('running');
    expect(status.message).toContain('Permission denied');
    stop();
  });

  /** H-04 Test 2: the guarantee holds identically for the project queue runtime. */
  it('keeps the project queue unavailable when the lock cannot be acquired', async () => {
    invoke.mockResolvedValue(false);
    const stop = startProjectQueueRuntime();
    await settle();
    const status = projectQueueRuntimeStatus();
    expect(status.status).toBe('unavailable');
    expect(status.status).not.toBe('running');
    stop();
  });

  /** H-04: a failed acquisition must not leave a polling timer behind that fakes activity. */
  it('does not start polling when ownership was not acquired', async () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    invoke.mockResolvedValue(false);
    const stop = startScheduledRuntime();
    await settle();
    expect(setInterval).not.toHaveBeenCalled();
    stop();
    setInterval.mockRestore();
  });
});
