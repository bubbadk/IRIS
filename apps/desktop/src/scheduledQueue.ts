import { claimScheduledRun, type ScheduleDefinition, type ScheduledRun } from '@iris/workflows';
import { LocalScheduleRepository, LocalScheduledRunRepository } from './persistence';
import { isPlainRecord, readPersistedValue } from './persistenceIntegrity';
import { createDesktopRepository } from './repositoryStorage';

const controlKey = 'iris.schedules.queue-control.v1';
export class LocalScheduledQueue {
  constructor(private readonly storage?: Storage) {}
  private get store(): Storage {
    return this.storage ?? globalThis.localStorage;
  }
  async isPaused(): Promise<boolean> {
    const control = readPersistedValue({
      repository: 'schedule queue controls',
      storageKey: controlKey,
      raw: this.store.getItem(controlKey),
      decode: (value) =>
        isPlainRecord(value) && typeof value.paused === 'boolean'
          ? { paused: value.paused }
          : null,
    });
    if (!control) return false;
    return control.paused;
  }
  async setPaused(paused: boolean): Promise<void> {
    this.store.setItem(controlKey, JSON.stringify({ version: 1, paused }));
  }
  async enqueue(
    schedule: ScheduleDefinition,
    run: ScheduledRun,
    next: ScheduleDefinition,
  ): Promise<ScheduledRun | null> {
    if (await this.isPaused()) return null;
    const schedules = new LocalScheduleRepository(this.store);
    const runs = new LocalScheduledRunRepository(this.store);
    const current = await schedules.get(schedule.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(schedule) || !current.enabled)
      return null;
    const existing = (await runs.list(schedule.id)).find(
      (item) => item.scheduledFor === run.scheduledFor,
    );
    if (!existing) await runs.save(run);
    await schedules.save(next);
    return existing ?? run;
  }
  async claim(
    runId: string,
    at: string,
    status: 'queued' | 'failed' | 'suspended',
  ): Promise<ScheduledRun | null> {
    if (status !== 'suspended' && (await this.isPaused())) return null;
    const runs = new LocalScheduledRunRepository(this.store);
    const run = await runs.get(runId);
    if (!run || run.status !== status) return null;
    if (status === 'queued' && (run.queueVersion !== 1 || run.executionClaimedAt)) return null;
    if (
      (await runs.list()).some(
        (other) =>
          other.id !== run.id &&
          other.agentId === run.agentId &&
          ['running', 'suspended'].includes(other.status),
      )
    )
      return null;
    const claimed = claimScheduledRun(run, at);
    await runs.save(claimed);
    return claimed;
  }
}
export const scheduledQueue = createDesktopRepository(
  (storage) => new LocalScheduledQueue(storage),
  [controlKey, 'iris.schedules.v1', 'iris.schedules.runs.v1'],
);
