import { describe, expect, it, vi } from 'vitest';
import {
  addProjectTask,
  checkProjectResults,
  cloneProjectTaskRun,
  createProjectGraph,
  projectTaskState,
  projectTaskVersion,
  recordProjectQualityReview,
  ProjectWorkflowRuntime,
  validateProjectTaskRun,
  verifyProjectRun,
  type ProjectCheckArtifact,
  type ProjectGraphRepository,
  type ProjectRunReviewEvidence,
  type ProjectTaskRun,
  type ProjectTaskRunRepository,
  type ProjectWorkerExecutor,
  type QualityReviewReceipt,
} from './index';

const at = '2026-09-10T12:00:00.000Z';
const later = '2026-09-10T12:01:00.000Z';
async function fixture() {
  let graph = createProjectGraph({
    id: 'p',
    title: 'Export',
    objective: 'Usable export',
    createdAt: at,
  });
  const checks = [
    {
      id: 'c',
      target: { kind: 'document' as const, title: 'Export' },
      assertion: 'nonempty' as const,
    },
  ];
  graph = addProjectTask(graph, {
    id: 't',
    title: 'Write export',
    resultChecks: checks,
    createdAt: at,
  });
  graph = addProjectTask(graph, {
    id: 'next',
    title: 'Use export',
    dependencyIds: ['t'],
    createdAt: at,
  });
  const read = vi.fn<() => Promise<ProjectCheckArtifact | null>>(async () => ({
    content: 'Export',
    evidence: 'revision-1',
  }));
  let run: ProjectTaskRun = {
    version: 1,
    id: 'r',
    projectId: 'p',
    taskId: 't',
    agentId: 'a',
    agentName: 'Worker',
    status: 'awaiting-review',
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    returnedAt: at,
    runtimeTurnId: 'turn',
    output: 'Everything works.',
    resultChecks: checks,
    checkReports: [await checkProjectResults(checks, { read }, 'turn', at)],
  };
  const original = cloneProjectTaskRun(run);
  const projects: ProjectGraphRepository = {
    list: async () => [structuredClone(graph)],
    get: async () => structuredClone(graph),
    save: async (next) => {
      graph = structuredClone(next);
    },
    remove: async () => undefined,
  };
  const runs: ProjectTaskRunRepository = {
    list: async () => [cloneProjectTaskRun(run)],
    get: async () => cloneProjectTaskRun(run),
    save: async (next) => {
      run = cloneProjectTaskRun(next);
    },
  };
  const workers: ProjectWorkerExecutor = {
    prepare: vi.fn(),
    execute: vi.fn(),
    resume: vi.fn(),
    continue: vi.fn(),
    cancel: vi.fn(),
    recover: vi.fn(),
  };
  const committer = {
    reviewQuality: vi.fn(async (_id: string, receipt: QualityReviewReceipt) => {
      run = recordProjectQualityReview(graph, run, [run], receipt);
      return cloneProjectTaskRun(run);
    }),
    verify: vi.fn(
      async (
        _id: string,
        note: string,
        reviewedAt: string,
        evidence?: ProjectRunReviewEvidence,
      ) => {
        const result = verifyProjectRun(graph, run, [run], note, reviewedAt, evidence);
        run = result.run;
        graph = result.project;
        return cloneProjectTaskRun(run);
      },
    ),
  };
  const runtime = new ProjectWorkflowRuntime(
    projects,
    runs,
    workers,
    undefined,
    () => new Date(later),
    undefined,
    committer,
    { read },
  );
  read.mockClear();
  return { runtime, runs, projects, original, read, workers, committer };
}

describe('fresh evidence at project acceptance', () => {
  it.each(['before save', 'during artifact reads'])(
    'rejects a quality review when task instructions change %s',
    async (when) => {
      const f = await fixture();
      const project = (await f.projects.get('p'))!;
      const expectedTask = projectTaskVersion(project.tasks[0]!);
      const change = async () => {
        project.tasks[0]!.description = 'Additional instructions the open review did not show.';
        await f.projects.save(project);
      };
      if (when === 'before save') await change();
      else
        f.read.mockImplementationOnce(async () => {
          await change();
          return { content: 'Export', evidence: 'revision-1' };
        });
      await expect(
        f.runtime.reviewQuality(
          'r',
          {
            assessments: [],
            findings: [],
            resolutions: [],
          },
          f.original,
          expectedTask,
        ),
      ).rejects.toThrow('changed');
      expect((await f.runs.get('r'))!.qualityReviews).toBeUndefined();
      expect(f.workers.execute).not.toHaveBeenCalled();
      expect(projectTaskState((await f.projects.get('p'))!, 'next')).toBe('blocked');
    },
  );
  it('rechecks unchanged deliverables, persists fresh evidence and only then unlocks dependencies', async () => {
    const f = await fixture();
    const result = await f.runtime.verifyRun('r', 'Inspected the export.', f.original);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(result.verification?.checkReport).toMatchObject({
      checkedAt: later,
      runtimeTurnId: 'turn',
    });
    expect(result.checkReports?.[0]?.checkedAt).toBe(at);
    expect(validateProjectTaskRun(result)).toBe(true);
    expect(projectTaskState((await f.projects.get('p'))!, 'next')).toBe('ready');
    expect(f.workers.execute).not.toHaveBeenCalled();
    expect(f.workers.continue).not.toHaveBeenCalled();
    const copy = cloneProjectTaskRun(result);
    copy.verification!.checkReport!.results[0]!.evidence = 'changed';
    expect(result.verification?.checkReport?.results[0]?.evidence).toBe('revision-1');
    expect(validateProjectTaskRun(copy)).toBe(false);
  });

  it.each([
    [
      'changed but still passing',
      { content: 'A different nonempty export', evidence: 'revision-2' },
      'changed after',
    ],
    ['missing', null, 'does not exist'],
    ['empty', { content: ' ', evidence: 'revision-2' }, 'no non-whitespace'],
    ['without evidence', { content: 'Export', evidence: '' }, 'evidence is missing'],
  ] as const)(
    'rejects %s content and preserves unfinished task state',
    async (_label, artifact, message) => {
      const f = await fixture();
      f.read.mockResolvedValue(artifact);
      await expect(f.runtime.verifyRun('r', 'Reviewed.', f.original)).rejects.toThrow(message);
      expect(await f.runs.get('r')).toEqual(f.original);
      expect(projectTaskState((await f.projects.get('p'))!, 'next')).toBe('blocked');
      expect(f.workers.continue).not.toHaveBeenCalled();
    },
  );

  it('fails closed when reads become unavailable', async () => {
    const f = await fixture();
    f.read.mockRejectedValue(new Error('Workspace is unavailable.'));
    await expect(f.runtime.verifyRun('r', 'Reviewed.')).rejects.toThrow('Workspace is unavailable');
    expect((await f.runs.get('r'))?.status).toBe('awaiting-review');
  });

  it('rejects a changed visible run before reading and a concurrent run change after reading', async () => {
    const f = await fixture();
    const changed = { ...f.original, output: 'A changed worker report.' };
    await f.runs.save(changed);
    await expect(f.runtime.verifyRun('r', 'Reviewed.', f.original)).rejects.toThrow(
      'changed during review',
    );
    expect(f.read).not.toHaveBeenCalled();
    await f.runs.save(f.original);
    f.read.mockImplementation(async () => {
      await f.runs.save(changed);
      return { content: 'Export', evidence: 'revision-1' };
    });
    await expect(f.runtime.verifyRun('r', 'Reviewed.', f.original)).rejects.toThrow(
      'changed during review',
    );
    expect(projectTaskState((await f.projects.get('p'))!, 'next')).toBe('blocked');
  });

  it('cannot bypass rechecking through the repository committer', async () => {
    const f = await fixture();
    await expect(f.committer.verify('r', 'Reviewed.', later)).rejects.toThrow(
      'Fresh result checks',
    );
    const report = structuredClone(f.original.checkReports![0]!);
    report.runtimeTurnId = 'unrelated-turn';
    await expect(
      f.committer.verify('r', 'Reviewed.', later, { expectedRun: f.original, checkReport: report }),
    ).rejects.toThrow('Fresh result checks');
    report.runtimeTurnId = 'turn';
    for (const checkedAt of ['2026-09-09T12:00:00Z', '2026-09-11T12:00:00Z']) {
      report.checkedAt = checkedAt;
      await expect(
        f.committer.verify('r', 'Reviewed.', later, {
          expectedRun: f.original,
          checkReport: report,
        }),
      ).rejects.toThrow('Fresh result checks');
    }
  });
});
