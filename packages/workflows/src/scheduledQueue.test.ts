import { describe, expect, it } from 'vitest';
import {
  ScheduleDispatcher,
  type ScheduleDefinition,
  type ScheduledRun,
  type ScheduleRunner,
} from './index';
const at = '2026-09-09T10:00:00.000Z';
const schedule: ScheduleDefinition = {
  version: 1,
  id: 'schedule',
  name: 'Test schedule',
  agentId: 'agent',
  prompt: 'Original instructions',
  recurrence: 'once',
  runAt: at,
  timeOfDay: '10:00',
  timeZone: 'UTC',
  enabled: true,
  createdAt: at,
  updatedAt: at,
  nextRunAt: at,
};
const job: ScheduledRun = {
  version: 1,
  queueVersion: 1,
  id: 'job',
  scheduleId: 'schedule',
  agentId: 'agent',
  prompt: 'Original instructions',
  status: 'queued',
  scheduledFor: at,
  createdAt: at,
  updatedAt: at,
};
function setup(initialSchedule = schedule, initialRuns: ScheduledRun[] = []) {
  let current = structuredClone(initialSchedule);
  let saved = structuredClone(initialRuns);
  const schedules = {
    list: async () => [structuredClone(current)],
    get: async () => structuredClone(current),
    save: async (next: ScheduleDefinition) => {
      current = structuredClone(next);
    },
    remove: async () => {},
  };
  const runs = {
    list: async () => structuredClone(saved),
    get: async (id: string) => structuredClone(saved.find((run) => run.id === id) ?? null),
    save: async (run: ScheduledRun) => {
      saved = [structuredClone(run), ...saved.filter((old) => old.id !== run.id)];
    },
  };
  return { schedules, runs };
}
const options = { now: () => new Date(at), id: () => 'job' };
describe('durable schedule queue', () => {
  it('dispatches an already saved one-time job after restart even though its schedule advanced and disabled', async () => {
    const state = setup(
      {
        ...schedule,
        enabled: false,
        nextRunAt: undefined,
        agentId: 'changed',
        prompt: 'Future instructions',
      },
      [job],
    );
    const runner: ScheduleRunner = {
      async *run(input) {
        expect(input.schedule.agentId).toBe('agent');
        expect(input.schedule.prompt).toBe('Original instructions');
        const persisted = await state.runs.get('job');
        expect(persisted).toMatchObject({ status: 'running', executionClaimedAt: at });
        yield { type: 'completed', output: 'Executed once' };
      },
      async *resume() {},
    };
    const dispatcher = new ScheduleDispatcher(state.schedules, state.runs, runner, options);
    await dispatcher.reconcile();
    expect((await dispatcher.tick())[0]?.status).toBe('completed');
    expect(await dispatcher.tick()).toEqual([]);
    expect(await state.runs.list()).toHaveLength(1);
  });
  it('keeps due work untouched while paused and queued work waits for its agent', async () => {
    const state = setup();
    let paused = true;
    let available = false;
    const runner: ScheduleRunner = {
      available: async () => available,
      async *run() {
        yield { type: 'completed', output: 'Done' };
      },
      async *resume() {},
    };
    const dispatcher = new ScheduleDispatcher(state.schedules, state.runs, runner, {
      ...options,
      isPaused: async () => paused,
    });
    expect(await dispatcher.tick()).toEqual([]);
    expect(await state.runs.list()).toHaveLength(0);
    paused = false;
    expect(await dispatcher.tick()).toEqual([]);
    expect((await state.runs.get('job'))?.status).toBe('queued');
    available = true;
    expect((await dispatcher.tick())[0]?.status).toBe('completed');
  });
  it('does not replay a failure after dispatch even if it occurs before the first worker event', async () => {
    const state = setup({ ...schedule, maxAttempts: 3 });
    let effects = 0;
    const dispatcher = new ScheduleDispatcher(
      state.schedules,
      state.runs,
      {
        run() {
          effects++;
          throw new Error('Connection lost after an external action');
        },
        async *resume() {},
      },
      options,
    );
    const failed = (await dispatcher.tick())[0]!;
    expect(failed).toMatchObject({ status: 'failed', retrySafe: false, executionClaimedAt: at });
    expect(failed.retryAt).toBeUndefined();
    await dispatcher.reconcile();
    await dispatcher.tick();
    expect(effects).toBe(1);
  });
  it('refuses uncertain legacy queue entries and old claimed runs after restart', async () => {
    const state = setup({ ...schedule, enabled: false }, [
      { ...job, queueVersion: undefined, id: 'legacy' },
      { ...job, id: 'claimed', status: 'running', executionClaimedAt: at, startedAt: at },
    ]);
    let effects = 0;
    const dispatcher = new ScheduleDispatcher(
      state.schedules,
      state.runs,
      {
        async *run() {
          effects++;
          yield { type: 'completed', output: 'Unexpected' };
        },
        async *resume() {},
      },
      options,
    );
    await dispatcher.reconcile();
    await dispatcher.tick();
    expect(effects).toBe(0);
    expect((await state.runs.list()).every((run) => run.status === 'failed' && !run.retryAt)).toBe(
      true,
    );
  });
});
