import { invoke } from '@tauri-apps/api/core';
import { ScheduleDispatcher, type ScheduleRunner, type ScheduledRun } from '@iris/workflows';
import { agentRuntime, providerResolver } from './agentRuntime';
import { createScheduledRunner } from './scheduledRunner';
import {
  agentRepository,
  conversationRepository,
  scheduleRepository,
  scheduledRunRepository,
  toolApprovalRepository,
} from './persistence';
import { refreshIdleSchedules } from './userActivity';
import { isTauriRuntime } from './credentials';
import { scheduledQueue } from './scheduledQueue';
import { projectWorkerReservations, crossProcessAuthority, attachCrossProcessAuthority } from './agentExecution';

const listeners = new Set<() => void>();
let owned = false;
let state: {
  status: 'starting' | 'running' | 'paused' | 'unavailable' | 'stopped';
  message: string;
} = { status: 'stopped', message: 'The schedule runtime has not started.' };
const notify = () => listeners.forEach((listener) => listener());
export function scheduledRuntimeStatus() {
  return { ...state };
}
const runner: ScheduleRunner = createScheduledRunner({
  runtime: agentRuntime,
  agents: agentRepository,
  providers: providerResolver,
  approvals: toolApprovalRepository,
  conversations: conversationRepository,
  reservations: projectWorkerReservations,
});
export const scheduleDispatcher = new ScheduleDispatcher(
  scheduleRepository,
  scheduledRunRepository,
  runner,
  {
    onChange: notify,
    isPaused: () => scheduledQueue.isPaused(),
    queue: scheduledQueue,
  },
);
let timer: number | undefined;
let generation = 0;
let started = false;
let reconciled = false;

export function subscribeScheduleRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
async function updateStatus() {
  const paused = await scheduledQueue.isPaused();
  state = {
    status: paused ? 'paused' : 'running',
    message: paused
      ? 'New jobs are paused. Current work and permission decisions can finish.'
      : 'Queue active while IRIS is running, including in the system tray. Quit stops execution.',
  };
  notify();
}
function reportError(error: unknown) {
  state = {
    status: 'unavailable',
    message: error instanceof Error ? error.message : String(error),
  };
  notify();
}
async function tick() {
  if (!owned || !started) return;
  try {
    await updateStatus();
    await scheduleDispatcher.tick();
  } catch (error) {
    reportError(error);
  }
}
export async function setScheduledQueuePaused(paused: boolean): Promise<void> {
  await scheduledQueue.setPaused(paused);
  if (owned) await updateStatus();
  else notify();
  if (!paused) void tick();
}
export function startScheduledRuntime(): () => void {
  if (started) return () => undefined;
  started = true;
  // Phase 2H.1: attach the shared cross-process authority before any dispatch can claim an
  // agent. Resolved here — not at module import — so importing this module never touches
  // native storage and browser tests stay isolated.
  void crossProcessAuthority().then((port) => {
    if (port) attachCrossProcessAuthority(port);
  });
  const epoch = ++generation;
  state = { status: 'starting', message: 'Checking exclusive queue ownership…' };
  notify();
  void (async () => {
    try {
      if (!isTauriRuntime())
        throw new Error(
          'Scheduled execution requires the native desktop app. Browser preview does not run queued jobs.',
        );
      owned = await invoke<boolean>('acquire_schedule_owner');
      if (epoch !== generation) return;
      if (!owned)
        throw new Error(
          'Another IRIS process owns scheduled execution. Manage the queue in that process.',
        );
      if (!reconciled) {
        // The OS lock remains held for this native process, including UI view changes.
        await refreshIdleSchedules(new Date());
        if (epoch !== generation) return;
        // §8 — a suspended turn still owns its agent until it is resolved. Rebuild that ownership
        // before anything is dispatched, so a restart never fabricates a free agent.
        await agentRuntime.reconcileExecutionReservations();
        if (epoch !== generation) return;
        await scheduleDispatcher.reconcile();
        reconciled = true;
      }
      if (epoch !== generation) return;
      await updateStatus();
      // Real due-time polling, never simulated activity.
      timer = window.setInterval(() => void tick(), 30_000);
      void tick();
    } catch (error) {
      if (epoch === generation) reportError(error);
    }
  })();
  return () => {
    generation++;
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    started = false;
  };
}
export async function resolveScheduledApproval(
  run: ScheduledRun,
  decision: 'approve' | 'deny',
): Promise<ScheduledRun> {
  if (!owned)
    throw new Error('Resolve this approval in the IRIS process that owns the schedule queue.');
  return scheduleDispatcher.resolveApproval(run.id, decision);
}
