import { nextIdleScheduleRun } from '@iris/workflows';
import { scheduleRepository } from './persistence';

/**
 * Tracks real user activity (sending a chat message) so 'idle' schedules — e.g. a Dreaming
 * pass that reviews the day and saves what is worth remembering — know when the user has
 * actually gone quiet. Scheduled/automatic sends never call this, so a Dreaming turn can
 * never reset its own idle window.
 */

let lastActivityAt: Date = new Date(0);
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const refreshDebounceMs = 10_000;

export function lastUserActivityAt(): Date {
  return lastActivityAt;
}

/** Recomputes and persists `nextRunAt` for every enabled 'idle' schedule from `activityAt`. */
export async function refreshIdleSchedules(activityAt: Date = lastActivityAt): Promise<void> {
  const schedules = await scheduleRepository.list();
  await Promise.all(
    schedules
      .filter((schedule) => schedule.recurrence === 'idle' && schedule.enabled)
      .map((schedule) =>
        scheduleRepository.save({
          ...schedule,
          nextRunAt: nextIdleScheduleRun(schedule, activityAt),
        }),
      ),
  );
}

/** Call on every real user-initiated send. Debounced so a burst of messages does not hammer
 * the schedule repository — only the idle window's *end* matters, not every keystroke. */
export function recordUserActivity(now: Date = new Date()): void {
  lastActivityAt = now;
  if (refreshTimer !== undefined) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refreshIdleSchedules(lastActivityAt);
  }, refreshDebounceMs);
}
