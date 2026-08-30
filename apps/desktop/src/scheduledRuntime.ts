import {
  ScheduleDispatcher,
  type ScheduleRunner,
  type ScheduledRun,
} from '@iris/workflows';
import { agentRuntime, scheduledAgentEvents } from './agentRuntime';
import { scheduleRepository, scheduledRunRepository } from './persistence';
import { refreshIdleSchedules } from './userActivity';

const listeners = new Set<() => void>();

const runner: ScheduleRunner = {
  run(input) {
    return scheduledAgentEvents(agentRuntime.send(input.schedule.agentId, input.schedule.prompt));
  },
  resume(input, approvalId, decision) {
    if (input.run.approvalId !== approvalId) {
      throw new Error('The scheduled approval does not match its persisted run.');
    }
    return scheduledAgentEvents(agentRuntime.resolveApproval(approvalId, decision));
  },
};

export const scheduleDispatcher = new ScheduleDispatcher(
  scheduleRepository,
  scheduledRunRepository,
  runner,
  { onChange: () => listeners.forEach((listener) => listener()) },
);

let timer: number | undefined;
let started = false;

export function subscribeScheduleRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function startScheduledRuntime(): () => void {
  if (started) return () => undefined;
  started = true;
  // Give every enabled idle schedule a fresh baseline at startup — "idle" is tracked only for
  // this running session (never persisted across restarts), so the idle window starts counting
  // from launch, not from whatever nextRunAt an old, possibly-stale session last wrote.
  void refreshIdleSchedules(new Date());
  void scheduleDispatcher
    .reconcile()
    .then(() => scheduleDispatcher.tick())
    .then(() => listeners.forEach((listener) => listener()));
  timer = window.setInterval(() => void scheduleDispatcher.tick(), 30_000);
  return () => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    started = false;
  };
}

export async function resolveScheduledApproval(
  run: ScheduledRun,
  decision: 'approve' | 'deny',
): Promise<ScheduledRun> {
  return scheduleDispatcher.resolveApproval(run.id, decision);
}
