import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '@iris/core';
import type { ScheduledRun, ScheduleDefinition } from '@iris/workflows';
import { ScheduleDispatcher, claimScheduledRun } from '@iris/workflows';
import { createAgentApprovalBridge } from './agentApproval';
import {
  allowRules,
  collect,
  createIntegrationHarness,
  delegateCallName,
  type IntegrationHarness,
  planProvider,
  rootAgent,
  ruleGatedToolId,
} from './delegationHarness';
import { createScheduledRunner } from './scheduledRunner';

/**
 * Phase 2C.1 §10–§16: a scheduled run's lifecycle must not depend on which surface resolved its
 * approval, and a suspended run must never be able to strand its agent forever.
 *
 * The orchestration under test is production code end to end — the real `ScheduleDispatcher`, the
 * real scheduled runner, the real scheduled-event mapping, the real coordinator and the real
 * approval bridge. Only the model provider is a scripted fake.
 */

class MemoryScheduleRepository {
  readonly schedules = new Map<string, ScheduleDefinition>();

  async list(): Promise<ScheduleDefinition[]> {
    return [...this.schedules.values()];
  }

  async get(id: string): Promise<ScheduleDefinition | null> {
    return this.schedules.get(id) ?? null;
  }

  async save(schedule: ScheduleDefinition): Promise<void> {
    this.schedules.set(schedule.id, schedule);
  }

  async remove(id: string): Promise<void> {
    this.schedules.delete(id);
  }
}

class MemoryScheduledRunRepository {
  readonly runs = new Map<string, ScheduledRun>();

  async list(scheduleId?: string): Promise<ScheduledRun[]> {
    return [...this.runs.values()].filter(
      (run) => scheduleId === undefined || run.scheduleId === scheduleId,
    );
  }

  async get(id: string): Promise<ScheduledRun | null> {
    return this.runs.get(id) ?? null;
  }

  async save(run: ScheduledRun): Promise<void> {
    this.runs.set(run.id, run);
  }
}

interface ScheduledHarness {
  harness: IntegrationHarness;
  root: AgentDefinition;
  schedules: MemoryScheduleRepository;
  runs: MemoryScheduledRunRepository;
  dispatcher: ScheduleDispatcher;
  settle: (runId: string, resolution: Parameters<ScheduleDispatcher['settleSuspended']>[1]) => Promise<ScheduledRun>;
  /** Resolves an approval the way the global permissions surface, a chat window or a channel does. */
  resolveFromAnySurface: (
    approvalId: string,
    decision: 'approve' | 'deny',
  ) => ReturnType<ReturnType<typeof createAgentApprovalBridge>['resolve']>;
  scheduleId: string;
}

let runSequence = 0;
let scheduleSequence = 0;

/**
 * A scheduled occurrence that is due immediately, dispatched through the production dispatcher and
 * runner against the same coordinator the delegation suites use.
 */
function createScheduledHarness(
  resolve: Parameters<typeof createIntegrationHarness>[0]['resolve'],
  overrides: Partial<AgentDefinition> = {},
): ScheduledHarness {
  const root = rootAgent(overrides);
  const harness = createIntegrationHarness({
    agents: [root],
    rules: [
      ...allowRules(root.id),
      { id: 'root-ask', agentId: root.id, toolId: ruleGatedToolId, decision: 'ask' },
    ],
    resolve,
  });
  const schedules = new MemoryScheduleRepository();
  const runs = new MemoryScheduledRunRepository();
  const runner = createScheduledRunner({
    runtime: harness.coordinator,
    agents: harness.agents,
    providers: { resolve },
    approvals: harness.approvals,
    conversations: harness.conversations,
  });
  const scheduleId = `schedule-${(scheduleSequence += 1)}`;
  const dispatcher = new ScheduleDispatcher(schedules, runs, runner, {
    now: () => new Date('2026-01-01T09:00:00.000Z'),
    id: () => `scheduled-run-${(runSequence += 1)}`,
  });
  const bridge = createAgentApprovalBridge({
    runtime: harness.coordinator,
    runs,
    settle: (runId, resolution) => dispatcher.settleSuspended(runId, resolution),
  });
  return {
    harness,
    root,
    schedules,
    runs,
    dispatcher,
    settle: (runId, resolution) => dispatcher.settleSuspended(runId, resolution),
    resolveFromAnySurface: (approvalId, decision) => bridge.resolve(approvalId, decision),
    scheduleId,
  };
}

/** Seeds one due schedule occurrence for the root agent. */
async function seedDueSchedule(
  scheduled: ScheduledHarness,
  prompt = 'Run the scheduled job',
): Promise<void> {
  await scheduled.schedules.save({
    version: 1,
    id: scheduled.scheduleId,
    name: 'Scheduled job',
    agentId: scheduled.root.id,
    prompt,
    recurrence: 'once',
    timeOfDay: '09:00',
    timeZone: 'UTC',
    enabled: true,
    maxAttempts: 1,
    createdAt: '2026-01-01T08:00:00.000Z',
    updatedAt: '2026-01-01T08:00:00.000Z',
    nextRunAt: '2026-01-01T08:59:00.000Z',
  });
}

/**
 * Plans a run that stops on an approval-required tool, then reports once it has a result. Requests
 * alternate because a second occurrence continues the same conversation and would otherwise already
 * see tool results from the first one.
 */
function approvalPlan(): Parameters<typeof createIntegrationHarness>[0]['resolve'] {
  let streams = 0;
  return async () => ({
    provider: planProvider((toolResults) => {
      streams += 1;
      return streams % 2 === 1
        ? [{ call: 'system_configure', input: { setting: 'enabled' } }]
        : [{ text: `Scheduled report: ${toolResults.at(-1)?.content ?? ''}` }];
    }),
    model: 'mock-model',
  });
}

/** Plans a run that delegates to a child which stops on an approval-required tool. */
function nestedApprovalPlan(): Parameters<typeof createIntegrationHarness>[0]['resolve'] {
  return async (agent) => {
    const depth = agent.delegationDepth ?? 0;
    return {
      provider: planProvider((toolResults) => {
        if (toolResults.length > 0) {
          return [{ text: `depth ${depth} report: ${toolResults.at(-1)!.content}` }];
        }
        return depth === 0
          ? [
              {
                call: delegateCallName,
                input: { role: 'Child', objective: 'configure', instructions: 'go' },
              },
            ]
          : [{ call: 'system_configure', input: { setting: 'enabled' } }];
      }),
      model: 'mock-model',
      agent,
    };
  };
}

describe('scheduled run approval lifecycle (Phase 2C.1)', () => {
  /** §14 A/B: a normal run completes, and a run that stops for approval is recorded as suspended. */
  it('records a suspended run with its approval and turn identity, and completes a normal run', async () => {
    const scheduled = createScheduledHarness(approvalPlan());
    await seedDueSchedule(scheduled);

    const [run] = await scheduled.dispatcher.tick();

    expect(run.status).toBe('suspended');
    expect(run.approvalId).toBe(scheduled.harness.approvals.requests[0].id);
    // Correlated with the exact turn it started, never with "the newest transcript".
    expect(run.turnId).toBeDefined();
    expect(run.agentId).toBe(scheduled.root.id);
    expect(scheduled.harness.executions).toHaveLength(0);
    // The agent turn is genuinely waiting, so the run may legitimately block further work.
    expect(await scheduled.harness.coordinator.suspendedForAgent(scheduled.root.id)).not.toBeNull();

    // A second, uninterrupted schedule completes normally.
    const plain = createScheduledHarness(async () => ({
      provider: planProvider(() => [{ text: 'Nothing to do.' }]),
      model: 'mock-model',
    }));
    await seedDueSchedule(plain);
    const [completed] = await plain.dispatcher.tick();
    expect(completed.status).toBe('completed');
    expect(completed.output).toBe('Nothing to do.');
    expect(completed.approvalId).toBeUndefined();
  });

  /** §14 C/§18: resolving through the global permissions path resumes the agent and settles the run. */
  it('completes the run when its approval is resolved from another surface', async () => {
    const scheduled = createScheduledHarness(approvalPlan());
    await seedDueSchedule(scheduled);
    const [suspended] = await scheduled.dispatcher.tick();
    const approvalId = suspended.approvalId!;

    const resolution = await scheduled.resolveFromAnySurface(approvalId, 'approve');

    expect(resolution.scheduledRun?.id).toBe(suspended.id);
    expect(resolution.scheduledRun?.status).toBe('completed');
    expect(resolution.scheduledRun?.output).toContain('Scheduled report: ');
    expect(resolution.output).toContain('Scheduled report: ');
    expect(resolution.suspended).toBe(false);
    // Exactly one execution, and nothing is left waiting.
    expect(scheduled.harness.executions).toEqual([{ setting: 'enabled' }]);
    expect(await scheduled.harness.coordinator.suspendedForAgent(scheduled.root.id)).toBeNull();
    // The settled run is no longer correlated with a decision that is already done.
    const stored = await scheduled.runs.get(suspended.id);
    expect(stored?.status).toBe('completed');
    expect(stored?.approvalId).toBeUndefined();
  });

  /** §10: a descendant's approval is the run's approval, and resolving it finishes the run. */
  it('tracks a nested delegated approval and completes the run when the chain resumes', async () => {
    const scheduled = createScheduledHarness(nestedApprovalPlan());
    await seedDueSchedule(scheduled);

    const [run] = await scheduled.dispatcher.tick();

    // The run is suspended on the *child's* approval, and the parent turn owns the delegation wait.
    expect(run.status).toBe('suspended');
    const child = await scheduled.harness.coordinator.suspendedForApproval(run.approvalId!);
    expect(child?.agentId).toMatch(/^subagent-/);
    const parentTurn = await scheduled.harness.coordinator.suspendedForAgent(scheduled.root.id);
    expect(parentTurn?.pending.kind).toBe('delegation');
    expect(scheduled.harness.executions).toHaveLength(0);

    const resolution = await scheduled.resolveFromAnySurface(run.approvalId!, 'approve');

    expect(resolution.scheduledRun?.status).toBe('completed');
    expect(resolution.scheduledRun?.output).toContain('depth 0 report');
    expect(scheduled.harness.executions).toEqual([{ setting: 'enabled' }]);
    expect(await scheduled.harness.coordinator.suspendedForAgent(scheduled.root.id)).toBeNull();
  });

  /** §14 D/F: a denied approval executes nothing, and the run still reaches a truthful terminal state. */
  it('leaves no permanent suspension when the approval is denied', async () => {
    const scheduled = createScheduledHarness(approvalPlan());
    await seedDueSchedule(scheduled);
    const [suspended] = await scheduled.dispatcher.tick();

    const resolution = await scheduled.resolveFromAnySurface(suspended.approvalId!, 'deny');

    expect(scheduled.harness.executions).toHaveLength(0);
    expect(resolution.scheduledRun?.status).toBe('completed');
    expect(resolution.scheduledRun?.output).toContain('denied');
    expect(await scheduled.harness.coordinator.suspendedForAgent(scheduled.root.id)).toBeNull();
  });

  /** §14 H/§8: a duplicate resolution cannot resume the turn twice or settle the run twice. */
  it('rejects a second resolution and never runs the tool twice', async () => {
    const scheduled = createScheduledHarness(approvalPlan());
    await seedDueSchedule(scheduled);
    const [suspended] = await scheduled.dispatcher.tick();
    const approvalId = suspended.approvalId!;

    const first = await scheduled.resolveFromAnySurface(approvalId, 'approve');
    await expect(scheduled.resolveFromAnySurface(approvalId, 'approve')).rejects.toThrow();
    // The Schedules window's own path is equally idempotent.
    await expect(scheduled.dispatcher.resolveApproval(suspended.id, 'approve')).rejects.toThrow(
      /not waiting for approval/,
    );

    expect(scheduled.harness.executions).toEqual([{ setting: 'enabled' }]);
    expect(first.scheduledRun?.status).toBe('completed');
    const stored = await scheduled.runs.get(suspended.id);
    expect(stored?.status).toBe('completed');
    expect(stored?.output).toBe(first.scheduledRun?.output);
  });

  /** §14 E/§11: the Schedules window's own path keeps working and is equally central. */
  it('resolves a scheduled approval through the dispatcher path as well', async () => {
    const scheduled = createScheduledHarness(approvalPlan());
    await seedDueSchedule(scheduled);
    const [suspended] = await scheduled.dispatcher.tick();

    const resolved = await scheduled.dispatcher.resolveApproval(suspended.id, 'approve');

    expect(resolved.status).toBe('completed');
    expect(resolved.output).toContain('Scheduled report: ');
    expect(scheduled.harness.executions).toEqual([{ setting: 'enabled' }]);
    expect(await scheduled.harness.coordinator.suspendedForAgent(scheduled.root.id)).toBeNull();
  });

  /** §15/§16: reconciliation never invents an outcome, and the run stops blocking its agent. */
  it('reconciles a stale suspended run to a truthful failure, never to a completion', async () => {
    const scheduled = createScheduledHarness(approvalPlan());
    await seedDueSchedule(scheduled);
    const [suspended] = await scheduled.dispatcher.tick();

    // Corruption: the approval record is gone, so the turn can never be resumed again.
    scheduled.harness.approvals.requests.splice(0, scheduled.harness.approvals.requests.length);

    await scheduled.dispatcher.reconcile();

    const reconciled = await scheduled.runs.get(suspended.id);
    expect(reconciled?.status).toBe('failed');
    expect(reconciled?.status).not.toBe('completed');
    expect(reconciled?.failure).toMatch(/no longer pending|no final outcome/i);
    // No automatic retry: the real outcome of the interrupted turn is unknown.
    expect(reconciled?.retrySafe).toBe(false);
    expect(reconciled?.retryAt).toBeUndefined();
    // Nothing is left claiming this agent's suspension, so the same-agent guard in `tick` and in the
    // queue's `claim` can no longer see a stale `suspended` run for it.
    expect(
      (await scheduled.runs.list()).filter(
        (run) => run.agentId === scheduled.root.id && ['running', 'suspended'].includes(run.status),
      ),
    ).toEqual([]);
  });

  /** §15: an old suspended run without a recorded turn id fails closed instead of guessing. */
  it('fails closed when a suspended run has no recorded turn to recover', async () => {
    const scheduled = createScheduledHarness(approvalPlan());
    await scheduled.runs.save({
      version: 1,
      id: 'legacy-run',
      scheduleId: 'legacy-schedule',
      agentId: scheduled.root.id,
      prompt: 'Legacy',
      status: 'suspended',
      approvalId: 'legacy-approval',
      scheduledFor: '2026-01-01T08:00:00.000Z',
      createdAt: '2026-01-01T08:00:00.000Z',
      updatedAt: '2026-01-01T08:00:00.000Z',
    });

    const settled = await scheduled.settle('legacy-run', { status: 'suspended' });
    expect(settled.status).toBe('suspended');
    await scheduled.dispatcher.reconcile();

    const reconciled = await scheduled.runs.get('legacy-run');
    expect(reconciled?.status).toBe('failed');
    expect(reconciled?.failure).toMatch(/no recorded agent turn/i);
  });

  /** §15: a resolution that happened elsewhere is recovered from the exact turn, not re-run. */
  it('recovers a completed run from the recorded turn after a restart', async () => {
    const scheduled = createScheduledHarness(approvalPlan());
    await seedDueSchedule(scheduled);
    const [suspended] = await scheduled.dispatcher.tick();
    const approvalId = suspended.approvalId!;

    // The agent turn is resumed (approval resolved) but the process dies before the run is updated:
    // simulate that by settling the agent without touching the run.
    await collect(scheduled.harness.coordinator.resolveApproval(approvalId, 'approve'));
    expect((await scheduled.runs.get(suspended.id))?.status).toBe('suspended');

    await scheduled.dispatcher.reconcile();

    const reconciled = await scheduled.runs.get(suspended.id);
    expect(reconciled?.status).toBe('completed');
    expect(reconciled?.output).toContain('Scheduled report: ');
    // Recovery reads the recorded turn; it never runs the tool again.
    expect(scheduled.harness.executions).toEqual([{ setting: 'enabled' }]);
  });

  /** §16: a suspended run that is genuinely still waiting stays suspended across reconciliation. */
  it('keeps a genuinely waiting run suspended across reconciliation', async () => {
    const scheduled = createScheduledHarness(approvalPlan());
    await seedDueSchedule(scheduled);
    const [suspended] = await scheduled.dispatcher.tick();

    await scheduled.dispatcher.reconcile();

    const stored = await scheduled.runs.get(suspended.id);
    expect(stored?.status).toBe('suspended');
    expect(stored?.approvalId).toBe(suspended.approvalId);
    expect(scheduled.harness.executions).toHaveLength(0);
  });

  /**
   * §19 adversarial: the agent turn is cancelled while the approval is still pending. Resolving the
   * orphaned approval must never be reported as a completed run.
   */
  it('never reports a completed run when the agent turn was cancelled', async () => {
    const scheduled = createScheduledHarness(approvalPlan());
    await seedDueSchedule(scheduled);
    const [suspended] = await scheduled.dispatcher.tick();

    await scheduled.harness.coordinator.cancelSuspended(scheduled.root.id);
    scheduled.harness.approvals.requests.splice(0, scheduled.harness.approvals.requests.length);

    await scheduled.dispatcher.reconcile();

    const reconciled = await scheduled.runs.get(suspended.id);
    expect(reconciled?.status).toBe('failed');
    expect(reconciled?.output).toBeUndefined();
    expect(reconciled?.failure).toMatch(/no final outcome|no recorded agent turn/i);
  });

  /** §15: a settled run never blocks a new occurrence of the same agent's schedule. */
  it('lets a new occurrence run after a suspended run reached a terminal state', async () => {
    const scheduled = createScheduledHarness(approvalPlan());
    await seedDueSchedule(scheduled);
    const [suspended] = await scheduled.dispatcher.tick();
    await scheduled.resolveFromAnySurface(suspended.approvalId!, 'approve');

    await scheduled.schedules.save({
      ...(await scheduled.schedules.get(scheduled.scheduleId))!,
      enabled: true,
      nextRunAt: '2026-01-01T08:59:30.000Z',
    });
    const runs = await scheduled.dispatcher.tick();

    const next = runs.find((run) => run.id !== suspended.id);
    expect(next).toBeDefined();
    // It starts, and stops again on a *fresh* approval: the previous suspension did not block it and
    // did not leak into the new run.
    expect(next?.status).toBe('suspended');
    expect(next?.approvalId).toBeDefined();
    expect(next?.approvalId).not.toBe(suspended.approvalId);
  });

  /** §15: the queue's own claim guard sees a reconciled run, not a permanent block. */
  it('does not let a reconciled run block the queue claim for its agent', async () => {
    const scheduled = createScheduledHarness(approvalPlan());
    const stale: ScheduledRun = {
      version: 1,
      queueVersion: 1,
      id: 'stale-run',
      scheduleId: scheduled.scheduleId,
      agentId: scheduled.root.id,
      prompt: 'Stale',
      status: 'suspended',
      approvalId: 'missing-approval',
      scheduledFor: '2026-01-01T08:00:00.000Z',
      createdAt: '2026-01-01T08:00:00.000Z',
      updatedAt: '2026-01-01T08:00:00.000Z',
      startedAt: '2026-01-01T08:00:00.000Z',
    };
    await scheduled.runs.save(stale);
    await scheduled.runs.save({
      ...claimScheduledRun(
        {
          version: 1,
          queueVersion: 1,
          id: 'new-run',
          scheduleId: scheduled.scheduleId,
          agentId: scheduled.root.id,
          prompt: 'New',
          status: 'queued',
          scheduledFor: '2026-01-01T08:30:00.000Z',
          createdAt: '2026-01-01T08:30:00.000Z',
          updatedAt: '2026-01-01T08:30:00.000Z',
        },
        '2026-01-01T08:30:01.000Z',
      ),
      output: undefined,
    });

    // Before reconciliation the stale suspension is indistinguishable from real work; the guard that
    // reads it lives in the dispatcher and in the queue, so reconciliation must run first.
    await scheduled.dispatcher.reconcile();
    expect((await scheduled.runs.get('stale-run'))?.status).toBe('failed');
    expect(
      (await scheduled.runs.list()).filter(
        (run) => run.agentId === scheduled.root.id && run.status === 'suspended',
      ),
    ).toEqual([]);
  });
});
