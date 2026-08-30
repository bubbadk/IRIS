import { describe, expect, it } from 'vitest';
import type { ProjectTaskRun } from '@iris/workflows';
import { projectRunStatusLabel, sortProjectTaskRuns } from './projectRunHistory';

function run(id: string, updatedAt: string): ProjectTaskRun {
  return {
    version: 1,
    id,
    projectId: 'project-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    agentName: 'Release worker',
    status: 'completed',
    createdAt: '2026-08-27T12:00:00.000Z',
    updatedAt,
    startedAt: '2026-08-27T12:00:01.000Z',
    runtimeTurnId: `turn-${id}`,
    completedAt: updatedAt,
  };
}

describe('project run history', () => {
  it('sorts a copy by the persisted update time without mutating storage order', () => {
    const stored = [
      run('older', '2026-08-27T12:01:00.000Z'),
      run('newer', '2026-08-27T12:02:00.000Z'),
    ];

    expect(sortProjectTaskRuns(stored).map((item) => item.id)).toEqual(['newer', 'older']);
    expect(stored.map((item) => item.id)).toEqual(['older', 'newer']);
  });

  it('uses honest labels for every persisted lifecycle state', () => {
    expect(projectRunStatusLabel('suspended')).toBe('Waiting for approval');
    expect(projectRunStatusLabel('cancelled')).toBe('Cancelled');
    expect(projectRunStatusLabel('failed')).toBe('Failed');
  });
});
