import { describe, expect, it } from 'vitest';
import type { ProjectTaskRun } from './index';
import type { ProjectQueueEntry, ProjectQueueStatus } from './projectQueue';
import {
  isTerminalProjectQueueEntry,
  isTerminalProjectTaskRun,
  retainProjectQueueEntries,
  retainProjectTaskRuns,
} from './retention';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 9, 12, minutes, 0)).toISOString();

function entry(id: string, status: ProjectQueueStatus, minutes: number): ProjectQueueEntry {
  return {
    version: 1,
    id,
    projectId: 'project',
    taskId: `task-${id}`,
    agentId: `agent-${id}`,
    status,
    queuedAt: at(minutes),
    updatedAt: at(minutes),
  };
}

function run(
  id: string,
  status: ProjectTaskRun['status'],
  minutes: number,
  extra: Partial<ProjectTaskRun> = {},
): ProjectTaskRun {
  return {
    version: 1,
    id,
    projectId: 'project',
    taskId: 'task',
    agentId: 'agent',
    agentName: 'Worker',
    status,
    createdAt: at(minutes),
    updatedAt: at(minutes),
    ...extra,
  };
}

describe('project queue retention', () => {
  it('does not prune anything while the queue is within its limit', () => {
    const entries = [entry('a', 'queued', 0), entry('b', 'cancelled', 1), entry('c', 'claimed', 2)];
    expect(retainProjectQueueEntries(entries, 10).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('prunes only terminal history when the queue is over its limit', () => {
    const entries = [
      entry('new-cancelled', 'cancelled', 9),
      entry('live', 'launched', 8),
      entry('old-cancelled', 'cancelled', 1),
    ];
    const retained = retainProjectQueueEntries(entries, 2);
    expect(retained.map((item) => item.id)).toEqual(['new-cancelled', 'live']);
  });

  it('never removes a queued, claimed, launched or needs-attention entry', () => {
    const entries = [
      entry('queued', 'queued', 1),
      entry('claimed', 'claimed', 2),
      entry('launched', 'launched', 3),
      entry('attention', 'needs-attention', 4),
      entry('terminal-1', 'cancelled', 5),
      entry('terminal-2', 'cancelled', 6),
    ];
    const retained = retainProjectQueueEntries(entries, 1);
    expect(retained.map((item) => item.id)).toEqual([
      'queued',
      'claimed',
      'launched',
      'attention',
    ]);
  });

  it('keeps every live entry and intentionally exceeds the cap when live work alone overflows', () => {
    const entries = [
      entry('a', 'queued', 1),
      entry('b', 'claimed', 2),
      entry('c', 'launched', 3),
    ];
    const retained = retainProjectQueueEntries(entries, 1);
    expect(retained).toHaveLength(3);
  });

  it('is deterministic: identical input yields identical retention', () => {
    const build = () => [
      entry('z', 'cancelled', 5),
      entry('a', 'cancelled', 5),
      entry('live', 'claimed', 9),
      entry('m', 'cancelled', 2),
    ];
    const first = retainProjectQueueEntries(build(), 2).map((item) => item.id);
    const second = retainProjectQueueEntries(build(), 2).map((item) => item.id);
    expect(first).toEqual(second);
    // Equal timestamps fall back to the id so the outcome never depends on sort instability.
    expect(first).toEqual(['z', 'live']);
  });

  it('classifies terminal and non-terminal statuses exhaustively', () => {
    const statuses: ProjectQueueStatus[] = [
      'queued',
      'claimed',
      'launched',
      'needs-attention',
      'cancelled',
    ];
    expect(statuses.filter((status) => isTerminalProjectQueueEntry({ status }))).toEqual([
      'cancelled',
    ]);
  });
});

describe('project task run retention', () => {
  const active = run('active-running', 'running', 10, { output: 'live model output' });
  const queued = run('active-queued', 'queued', 11);
  const suspended = run('active-suspended', 'suspended', 12, {
    startedAt: at(12),
    runtimeTurnId: 'turn-suspended',
    suspendedAt: at(12),
    approval: { id: 'approval', toolId: 'tool', toolName: 'Tool', reason: 'Ask.' },
  });
  const awaiting = run('active-awaiting', 'awaiting-review', 13, {
    startedAt: at(13),
    runtimeTurnId: 'turn-awaiting',
    returnedAt: at(13),
    output: 'Report',
  });
  const needsAttention = run('active-attention', 'needs-attention', 14, {
    startedAt: at(14),
    runtimeTurnId: 'turn-attention',
    returnedAt: at(14),
    output: 'Report',
    stopReason: 'tool-limit',
  });
  const paused = run('active-paused', 'paused', 15, {
    startedAt: at(15),
    runtimeTurnId: 'turn-paused',
    returnedAt: at(15),
    pausedAt: at(15),
    output: 'Report',
    stopReason: 'tool-limit',
    turnsUsed: 1,
    turnLimit: 2,
  });

  it('does not prune anything while the history is within its limit', () => {
    const runs = [run('a', 'completed', 1), active, run('b', 'failed', 2)];
    expect(retainProjectTaskRuns(runs, 10).map((item) => item.id)).toEqual(['a', active.id, 'b']);
  });

  it('prunes only terminal history over the limit, oldest first', () => {
    const runs = [
      run('newest-terminal', 'completed', 30),
      run('oldest-terminal', 'cancelled', 1),
      run('middle-terminal', 'failed', 20),
    ];
    expect(retainProjectTaskRuns(runs, 2).map((item) => item.id)).toEqual([
      'newest-terminal',
      'middle-terminal',
    ]);
  });

  it('never prunes a paused, awaiting-review, suspended or needs-attention run', () => {
    const runs = [
      paused,
      awaiting,
      needsAttention,
      suspended,
      run('a', 'completed', 1),
      run('b', 'failed', 2),
      run('c', 'cancelled', 3),
    ];
    const retained = retainProjectTaskRuns(runs, 1).map((item) => item.id);
    expect(retained).toEqual([paused.id, awaiting.id, needsAttention.id, suspended.id]);
  });

  it('keeps every active run and its model output when active work alone overflows the cap', () => {
    const runs = [active, queued, suspended];
    const retained = retainProjectTaskRuns(runs, 1);
    expect(retained.map((item) => item.id)).toEqual([active.id, queued.id, suspended.id]);
    expect(retained.find((item) => item.id === active.id)?.output).toBe('live model output');
  });

  it('keeps the run a live continuation was launched from', () => {
    const source = run('source', 'failed', 1, { failure: 'Stopped.', failedAt: at(1) });
    const continuation = run('continuation', 'running', 2, { previousRunId: 'source' });
    expect(retainProjectTaskRuns([continuation, source], 1).map((item) => item.id)).toEqual([
      'continuation',
      'source',
    ]);
  });

  it('never prunes a run that carries human review provenance', () => {
    const reviewed = run('reviewed', 'completed', 1, {
      startedAt: at(1),
      runtimeTurnId: 'turn',
      completedAt: at(1),
      // Presence alone is what protects the record; schema validity is enforced by the repository.
      qualityReviews: [{ id: 'review' }] as unknown as ProjectTaskRun['qualityReviews'],
    });
    const rejected = run('rejected', 'failed', 2, {
      failedAt: at(2),
      failure: 'Rejected.',
      qualityRejections: [{ id: 'rejection' }] as unknown as ProjectTaskRun['qualityRejections'],
    });
    expect(retainProjectTaskRuns([reviewed, rejected], 1).map((item) => item.id)).toEqual([
      'reviewed',
      'rejected',
    ]);
  });

  it('bounds each project task independently so one task cannot delete another task history', () => {
    const runs = [
      run('p1-a', 'completed', 1, { projectId: 'project-1', taskId: 'task-1' }),
      run('p1-b', 'completed', 2, { projectId: 'project-1', taskId: 'task-1' }),
      run('p1-c', 'completed', 3, { projectId: 'project-1', taskId: 'task-1' }),
      run('p2-a', 'completed', 1, { projectId: 'project-2', taskId: 'task-2' }),
      run('p2-b', 'completed', 2, { projectId: 'project-2', taskId: 'task-2' }),
    ];
    const retained = retainProjectTaskRuns(runs, 2).map((item) => item.id);
    expect(retained).toEqual(['p1-b', 'p1-c', 'p2-a', 'p2-b']);
  });

  it('is deterministic for identical input', () => {
    const build = () => [
      run('b', 'completed', 5),
      run('a', 'completed', 5),
      run('live', 'running', 9),
      run('c', 'cancelled', 5),
    ];
    const first = retainProjectTaskRuns(build(), 2).map((item) => item.id);
    const second = retainProjectTaskRuns(build(), 2).map((item) => item.id);
    expect(first).toEqual(second);
    expect(first).toEqual(['live', 'c']);
  });

  it('classifies terminal and non-terminal statuses exhaustively', () => {
    const statuses: ProjectTaskRun['status'][] = [
      'queued',
      'running',
      'suspended',
      'awaiting-review',
      'needs-attention',
      'paused',
      'completed',
      'failed',
      'cancelled',
    ];
    const terminal = statuses.filter((status) => isTerminalProjectTaskRun({ status }));
    const nonTerminal = statuses.filter((status) => !isTerminalProjectTaskRun({ status }));
    expect(terminal).toEqual(['completed', 'failed', 'cancelled']);
    expect(nonTerminal).toEqual([
      'queued',
      'running',
      'suspended',
      'awaiting-review',
      'needs-attention',
      'paused',
    ]);
  });
});
