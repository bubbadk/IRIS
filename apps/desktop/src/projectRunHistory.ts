import type { ProjectTaskRun } from '@iris/workflows';

const runStatusLabels: Record<ProjectTaskRun['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  suspended: 'Waiting for approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Returns a defensive, newest-first view of persisted project runs. */
export function sortProjectTaskRuns(runs: ProjectTaskRun[]): ProjectTaskRun[] {
  return [...runs].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || left.createdAt);
    const rightTime = Date.parse(right.updatedAt || right.createdAt);
    return rightTime - leftTime || right.createdAt.localeCompare(left.createdAt);
  });
}

export function projectRunStatusLabel(status: ProjectTaskRun['status']): string {
  return runStatusLabels[status];
}
