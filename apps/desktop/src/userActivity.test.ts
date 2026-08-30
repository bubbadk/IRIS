import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleDefinition } from '@iris/workflows';
import { scheduleRepository } from './persistence';
import { lastUserActivityAt, recordUserActivity, refreshIdleSchedules } from './userActivity';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function schedule(overrides: Partial<ScheduleDefinition>): ScheduleDefinition {
  return {
    version: 1,
    id: 'schedule-1',
    name: 'Dreaming',
    agentId: 'agent-1',
    prompt: 'Review today.',
    recurrence: 'idle',
    timeOfDay: '00:00',
    timeZone: 'UTC',
    enabled: true,
    createdAt: '2026-08-29T08:00:00.000Z',
    updatedAt: '2026-08-29T08:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('refreshIdleSchedules', () => {
  it('advances nextRunAt for enabled idle schedules only', async () => {
    await scheduleRepository.save(schedule({ id: 'idle-on', idleMinutes: 30 }));
    await scheduleRepository.save(
      schedule({ id: 'idle-off', enabled: false, idleMinutes: 30 }),
    );
    await scheduleRepository.save(
      schedule({ id: 'daily', recurrence: 'daily', timeOfDay: '09:00' }),
    );

    await refreshIdleSchedules(new Date('2026-08-29T10:00:00.000Z'));

    const saved = await scheduleRepository.list();
    expect(saved.find((s) => s.id === 'idle-on')?.nextRunAt).toBe('2026-08-29T10:30:00.000Z');
    expect(saved.find((s) => s.id === 'idle-off')?.nextRunAt).toBeUndefined();
    expect(saved.find((s) => s.id === 'daily')?.nextRunAt).toBeUndefined();
  });
});

describe('recordUserActivity', () => {
  it('records the timestamp immediately and refreshes idle schedules once, debounced', async () => {
    vi.useFakeTimers();
    await scheduleRepository.save(schedule({ id: 'idle-on', idleMinutes: 15 }));

    const first = new Date('2026-08-29T12:00:00.000Z');
    recordUserActivity(first);
    expect(lastUserActivityAt()).toEqual(first);

    // A second activity before the debounce fires should not schedule a second refresh —
    // only the latest timestamp should ultimately be used.
    const second = new Date('2026-08-29T12:00:05.000Z');
    recordUserActivity(second);
    expect(lastUserActivityAt()).toEqual(second);

    await vi.advanceTimersByTimeAsync(10_000);

    const saved = await scheduleRepository.list();
    expect(saved.find((s) => s.id === 'idle-on')?.nextRunAt).toBe('2026-08-29T12:15:05.000Z');
  });
});
