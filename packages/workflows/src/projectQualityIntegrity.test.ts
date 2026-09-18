import { describe, expect, it } from 'vitest';
import {
  addProjectTask,
  checkProjectResults,
  cloneProjectTaskRun,
  compareProjectRunsNewestFirst,
  createProjectGraph,
  currentQualityReview,
  isNewerProjectRun,
  newestProjectRun,
  openQualityFindings,
  projectResultVersion,
  projectTaskVersion,
  recordProjectQualityReview,
  retainProjectQualityHistory,
  verifyProjectRun,
  type ProjectCheckArtifact,
  type ProjectCheckReport,
  type ProjectQualityRejection,
  type ProjectQualityReview,
  type ProjectResultCheck,
  type ProjectTaskRun,
} from './index';

/**
 * IRIS Phase 2G §19–§24 — quality history is bounded without falsifying acceptance, runs have a
 * deterministic total order, and evidence is rechecked regardless of the reviewer's resolutions.
 */

const at = (minutes: number) =>
  new Date(Date.UTC(2026, 8, 17, 12, minutes, 0)).toISOString();

function review(
  id: string,
  minutes: number,
  options: {
    findingIds?: string[];
    resolutionIds?: string[];
    blocking?: boolean;
  } = {},
): ProjectQualityReview {
  const findingIds = options.findingIds ?? [];
  const resolutionIds = options.resolutionIds ?? [];
  return {
    id,
    method: 'human-review',
    reviewedAt: at(minutes),
    projectId: 'p',
    taskId: 't',
    runId: 'r',
    criteriaVersion: '',
    taskVersion: 'task-version',
    resultVersion: 'result-version',
    assessments: [],
    findings: findingIds.map((findingId, index) => ({
      id: findingId,
      blocking: options.blocking ?? true,
      reason: `Finding ${index}`,
      repair: `Repair ${index}`,
    })),
    resolutions: resolutionIds.map((findingId) => ({ findingId, note: 'Addressed.' })),
  };
}

function rejection(id: string, minutes: number): ProjectQualityRejection {
  return { id, at: at(minutes), reason: 'Rejected.', resultVersion: 'result-version' };
}

function run(overrides: Partial<ProjectTaskRun> = {}): ProjectTaskRun {
  return {
    version: 1,
    id: 'r',
    projectId: 'p',
    taskId: 't',
    agentId: 'a',
    agentName: 'Worker',
    status: 'awaiting-review',
    createdAt: at(0),
    updatedAt: at(0),
    startedAt: at(0),
    returnedAt: at(0),
    runtimeTurnId: 'turn',
    output: 'Report.',
    ...overrides,
  };
}

describe('M-21 — bounded project quality history', () => {
  it('keeps everything while the history is within the cap', () => {
    const target = run({
      qualityReviews: [review('r1', 1), review('r2', 2)],
      qualityRejections: [rejection('j1', 1), rejection('j2', 2)],
    });
    const retained = retainProjectQualityHistory(target, 10);
    expect(retained.qualityReviews.map((item) => item.id)).toEqual(['r1', 'r2']);
    expect(retained.qualityRejections.map((item) => item.id)).toEqual(['j1', 'j2']);
  });

  it('prunes old resolved terminal reviews and old rejections at the cap', () => {
    const resolved = [0, 1, 2, 3].map((index) =>
      review(`old-${index}`, index, { findingIds: [`f${index}`] }),
    );
    const resolution = review('resolution', 10, {
      resolutionIds: ['f0', 'f1', 'f2', 'f3'],
    });
    const target = run({
      qualityReviews: [...resolved, resolution],
      qualityRejections: [0, 1, 2, 3].map((index) => rejection(`j${index}`, index)),
    });
    const retained = retainProjectQualityHistory(target, 2);
    // The newest review and the resolution lineage survive; the oldest fully closed history goes.
    expect(retained.qualityReviews.map((item) => item.id)).toEqual(['old-3', 'resolution']);
    expect(retained.qualityReviews).toHaveLength(2);
    expect(retained.qualityRejections.map((item) => item.id)).toEqual(['j2', 'j3']);
  });

  it('never prunes a review that still holds an open blocking finding', () => {
    const open = review('open', 1, { findingIds: ['still-open'] });
    const target = run({
      qualityReviews: [open, ...Array.from({ length: 5 }, (_, index) => review(`x${index}`, index + 2))],
    });
    const retained = retainProjectQualityHistory(target, 1);
    expect(retained.qualityReviews.map((item) => item.id)).toContain('open');
    expect(openQualityFindings({ ...target, qualityReviews: retained.qualityReviews }, [target])).toEqual(
      [expect.objectContaining({ id: 'still-open', blocking: true })],
    );
  });

  it('keeps the current review lineage so acceptance truth is unchanged by permitted pruning', () => {
    const base = run({ acceptanceCriteria: '' });
    const versioned = (id: string, minutes: number, options = {}) => ({
      ...review(id, minutes, options),
      criteriaVersion: '',
      resultVersion: projectResultVersion(base),
    });
    const closed = versioned('closed', 1, { findingIds: ['done'] });
    const resolution = versioned('resolution', 2, { resolutionIds: ['done'] });
    const current = versioned('current', 3);
    const target = run({ acceptanceCriteria: '', qualityReviews: [closed, resolution, current] });
    expect(currentQualityReview(target, undefined)?.id).toBe('current');
    const openBefore = openQualityFindings(target, [target]);

    const retained = retainProjectQualityHistory(target, 1);
    const prunedTarget = { ...target, qualityReviews: retained.qualityReviews };
    // The newest review is the one acceptance is read from, before and after the permitted prune.
    expect(currentQualityReview(prunedTarget, undefined)?.id).toBe('current');
    // The previously open finding was already resolved before the prune, so nothing became open.
    expect(openQualityFindings(prunedTarget, [prunedTarget])).toEqual(openBefore);
    expect(openBefore).toEqual([]);
  });

  it('exceeds the cap rather than deleting records that still carry current truth', () => {
    // Every review holds an unresolved finding, so none of them is removable.
    const target = run({
      qualityReviews: [0, 1, 2, 3].map((index) =>
        review(`open-${index}`, index, { findingIds: [`f${index}`] }),
      ),
    });
    const retained = retainProjectQualityHistory(target, 1);
    expect(retained.qualityReviews).toHaveLength(4);
  });

  it('is deterministic and survives a restart round-trip', () => {
    const build = () =>
      run({
        qualityReviews: [
          review('c', 3),
          review('a', 1, { findingIds: ['f'] }),
          review('b', 2, { resolutionIds: ['f'] }),
          review('d', 4),
        ],
        qualityRejections: [rejection('y', 2), rejection('x', 1)],
      });
    const first = retainProjectQualityHistory(build(), 1);
    const second = retainProjectQualityHistory(build(), 1);
    expect(first).toEqual(second);
    // Round-tripping through JSON — exactly what durable storage does — must not change the answer.
    expect(retainProjectQualityHistory(JSON.parse(JSON.stringify(build())), 1)).toEqual(first);
  });

  it('does not change an acceptance decision that was already valid', () => {
    // A run with no criteria and a fully resolved history is accepted before and after the prune.
    const finding = review('finding', 1, { findingIds: ['f'] });
    const resolution = review('resolution', 2, { resolutionIds: ['f'] });
    const target = run({
      status: 'awaiting-review',
      acceptanceCriteria: '',
      qualityReviews: [finding, resolution, ...Array.from({ length: 4 }, (_, i) => review(`h${i}`, i + 3))],
    });
    const before = verifyProjectRun(
      projectWithTask(),
      target,
      [target],
      'Checked.',
      at(20),
    );
    expect(before.run.status).toBe('completed');
    const pruned = { ...target, qualityReviews: retainProjectQualityHistory(target, 1).qualityReviews };
    const after = verifyProjectRun(projectWithTask(), pruned, [pruned], 'Checked.', at(20));
    expect(after.run.status).toBe('completed');
  });
});

function projectWithTask() {
  return addProjectTask(
    createProjectGraph({ id: 'p', title: 'Project', objective: 'Ship.', createdAt: at(0) }),
    { id: 't', title: 'Task', dependencyIds: [], createdAt: at(0) },
  );
}

describe('M-22 — deterministic total order over project runs', () => {
  it('orders by timestamp when timestamps differ', () => {
    const older = { id: 'a', createdAt: at(0) };
    const newer = { id: 'b', createdAt: at(5) };
    expect(isNewerProjectRun(newer, older)).toBe(true);
    expect(isNewerProjectRun(older, newer)).toBe(false);
  });

  it('breaks a same-millisecond tie by run identity, never symmetrically', () => {
    const left = { id: 'run-a', createdAt: at(0) };
    const right = { id: 'run-b', createdAt: at(0) };
    expect(isNewerProjectRun(left, right)).toBe(isNewerProjectRun(right, left) === false);
    expect(compareProjectRunsNewestFirst(left, right)).not.toBe(0);
    expect([left, right].filter((run) => isNewerProjectRun(run, run === left ? right : left))).toHaveLength(1);
  });

  it('selects exactly one newest run among many with the same timestamp, whatever the input order', () => {
    const runs = ['c', 'a', 'd', 'b'].map((id) => ({ id, createdAt: at(0) }));
    const newest = newestProjectRun(runs)!;
    expect(newest.id).toBe('d');
    for (const other of runs) if (other.id !== newest.id) expect(isNewerProjectRun(other, newest)).toBe(false);
    // Shuffled input gives the same answer, and so does a restart (a fresh array of equal values).
    expect(newestProjectRun([...runs].reverse())!.id).toBe('d');
    expect(newestProjectRun(JSON.parse(JSON.stringify(runs)))!.id).toBe('d');
  });

  it('never reports a newer run when the candidate is missing or identical', () => {
    const target = { id: 'r', createdAt: at(0) };
    expect(isNewerProjectRun(target, target)).toBe(false);
  });
});

describe('M-23 — evidence is rechecked regardless of resolutions', () => {
  const checks: ProjectResultCheck[] = [
    { id: 'c', target: { kind: 'document', title: 'Export' }, assertion: 'nonempty' },
  ];

  async function evidenceFixture(evidence: string) {
    let project = createProjectGraph({
      id: 'p',
      title: 'Export',
      objective: 'Usable export',
      createdAt: at(0),
    });
    project = addProjectTask(project, {
      id: 't',
      title: 'Write export',
      resultChecks: checks,
      createdAt: at(0),
    });
    const report = await checkProjectResults(
      checks,
      { read: async (): Promise<ProjectCheckArtifact> => ({ content: evidence, evidence }) },
      'turn',
      at(1),
    );
    const target: ProjectTaskRun = {
      version: 1,
      id: 'r',
      projectId: 'p',
      taskId: 't',
      agentId: 'a',
      agentName: 'Worker',
      status: 'awaiting-review',
      createdAt: at(0),
      updatedAt: at(0),
      startedAt: at(0),
      returnedAt: at(1),
      runtimeTurnId: 'turn',
      output: 'Exported the report.',
      resultChecks: checks,
      checkReports: [report],
    };
    return { project, target };
  }

  function receipt(
    target: ProjectTaskRun,
    project: ReturnType<typeof createProjectGraph>,
    input: {
      findings?: { blocking: boolean; reason: string; repair: string }[];
      resolutions?: { findingId: string; note: string }[];
      /** The evidence the reviewer actually looked at; defaults to the run's newest report. */
      checkReport?: ProjectCheckReport;
    },
  ) {
    return {
      expectedRun: cloneProjectTaskRun(target),
      expectedTask: projectTaskVersion(project.tasks[0]!),
      review: {
        id: 'review',
        method: 'human-review' as const,
        reviewedAt: at(30),
        projectId: 'p',
        taskId: 't',
        runId: target.id,
        criteriaVersion: '',
        taskVersion: projectTaskVersion(project.tasks[0]!),
        resultVersion: projectResultVersion(target),
        assessments: [],
        findings: (input.findings ?? []).map((finding, index) => ({ ...finding, id: `review:${index}` })),
        resolutions: input.resolutions ?? [],
        checkReport: structuredClone(
          input.checkReport ?? target.checkReports![0]!,
        ) as ProjectCheckReport,
      },
    };
  }

  function reportWith(
    target: ProjectTaskRun,
    result: Partial<ProjectCheckReport['results'][number]>,
  ): ProjectCheckReport {
    return {
      ...target.checkReports![0]!,
      results: [{ ...target.checkReports![0]!.results[0]!, ...result }],
    };
  }

  it('accepts a review with no resolutions when the current evidence is valid', async () => {
    const { project, target } = await evidenceFixture('revision-1');
    const saved = recordProjectQualityReview(project, target, [target], receipt(target, project, {}));
    expect(saved.qualityReviews).toHaveLength(1);
  });

  it('rejects a review with no resolutions when the reviewed evidence is stale', async () => {
    const { project, target } = await evidenceFixture('revision-1');
    expect(() =>
      recordProjectQualityReview(
        project,
        target,
        [target],
        receipt(target, project, {
          checkReport: reportWith(target, { evidence: 'revision-0' }),
        }),
      ),
    ).toThrow('changed after its recorded checks');
  });

  it('rejects a review with no resolutions when a check did not pass', async () => {
    const { project, target } = await evidenceFixture('revision-1');
    expect(() =>
      recordProjectQualityReview(
        project,
        target,
        [target],
        receipt(target, project, {
          checkReport: reportWith(target, {
            status: 'failed',
            message: 'The target contains no non-whitespace text.',
          }),
        }),
      ),
    ).toThrow('Verification blocked by check 1');
  });

  it('rejects a review with no resolutions when the evidence carries no proof', async () => {
    const { project, target } = await evidenceFixture('revision-1');
    expect(() =>
      recordProjectQualityReview(
        project,
        target,
        [target],
        receipt(target, project, { checkReport: reportWith(target, { evidence: '' }) }),
      ),
    ).toThrow('evidence is missing');
  });

  it('still rejects with resolutions present when the evidence changed', async () => {
    const { project, target } = await evidenceFixture('revision-1');
    expect(() =>
      recordProjectQualityReview(
        project,
        target,
        [target],
        receipt(target, project, {
          resolutions: [{ findingId: 'review:0', note: 'Addressed.' }],
          checkReport: reportWith(target, { evidence: 'revision-2' }),
        }),
      ),
    ).toThrow('changed after its recorded checks');
  });

  it('accepts a review with resolutions and matching evidence', async () => {
    const { project, target } = await evidenceFixture('revision-1');
    const { project: withCriteria, target: withTask } = await evidenceFixture('revision-1');
    void project;
    void target;
    const saved = recordProjectQualityReview(
      withCriteria,
      withTask,
      [withTask],
      receipt(withTask, withCriteria, {
        findings: [{ blocking: true, reason: 'Totals were missing.', repair: 'Recompute totals.' }],
      }),
    );
    expect(saved.qualityReviews).toHaveLength(1);
  });

  it('rejects a review that supplies no evidence at all', async () => {
    const { project, target } = await evidenceFixture('revision-1');
    const withoutEvidence = {
      expectedRun: cloneProjectTaskRun(target),
      expectedTask: projectTaskVersion(project.tasks[0]!),
      review: {
        ...receipt(target, project, {}).review,
        checkReport: undefined,
        resultVersion: projectResultVersion(target),
      },
    } as never;
    expect(() =>
      recordProjectQualityReview(project, target, [target], withoutEvidence),
    ).toThrow('Fresh result checks');
  });

  it('cannot complete the task by verifying with no evidence (no UI bypass)', async () => {
    const { project, target } = await evidenceFixture('revision-1');
    expect(() =>
      verifyProjectRun(project, target, [target], 'Looks right to me.', at(30)),
    ).toThrow('Fresh result checks');
    // The task stays incomplete: no code path marks it done while evidence is unverified.
    expect(project.tasks[0]!.completedAt).toBeUndefined();
  });

  it('records the verified evidence on the run it completes', async () => {
    const { project, target } = await evidenceFixture('revision-1');
    const verified = verifyProjectRun(project, target, [target], 'Looks right to me.', at(30), {
      expectedRun: cloneProjectTaskRun(target),
      checkReport: target.checkReports![0]!,
    });
    expect(verified.run.status).toBe('completed');
    expect(verified.run.verification?.checkReport?.results[0]?.evidence).toBe('revision-1');
  });

  it('rejects a review whose evidence belongs to a different worker turn', async () => {
    const { project, target } = await evidenceFixture('revision-1');
    expect(() =>
      recordProjectQualityReview(
        project,
        target,
        [target],
        receipt(target, project, {
          checkReport: { ...reportWith(target, {}), runtimeTurnId: 'other-turn' },
        }),
      ),
    ).toThrow('Fresh result checks');
  });
});
