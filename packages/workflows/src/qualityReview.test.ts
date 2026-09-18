import { describe, expect, it } from 'vitest';
import {
  addProjectTask,
  createProjectGraph,
  verifyProjectRun,
  projectTaskState,
  cloneProjectTaskRun,
  projectTaskVersion,
  projectResultVersion,
  projectCriteria,
  recordProjectQualityReview,
  currentQualityReview,
  openQualityFindings,
  projectRepairProposal,
  validateProjectTaskRun,
  setProjectTaskCompletion,
  validateProjectRunReservation,
  type ProjectTaskRun,
  type QualityReviewReceipt,
  type QualityReviewInput,
} from './index';

const at = '2026-09-11T10:00:00.000Z';
function fixture() {
  let project = createProjectGraph({
    id: 'p',
    title: 'Export',
    objective: 'Usable export',
    createdAt: at,
  });
  project = addProjectTask(project, {
    id: 't',
    title: 'Write export',
    acceptanceCriteria: 'Opens correctly\nIncludes totals',
    createdAt: at,
  });
  project = addProjectTask(project, {
    id: 'next',
    title: 'Publish',
    dependencyIds: ['t'],
    createdAt: at,
  });
  const run: ProjectTaskRun = {
    version: 1,
    id: 'r',
    projectId: 'p',
    taskId: 't',
    agentId: 'a',
    agentName: 'Controlled test worker',
    status: 'awaiting-review',
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    returnedAt: at,
    runtimeTurnId: 'turn',
    output: 'A report, not proof.',
    acceptanceCriteria: project.tasks[0]!.acceptanceCriteria,
  };
  const input: QualityReviewInput = {
    assessments: [0, 1].map((criterion) => ({
      criterion,
      outcome: 'met',
      rationale: 'Inspected the output.',
      evidence: 'Opened export revision 1 and compared totals.',
    })),
    findings: [],
    resolutions: [],
  };
  function receipt(target = run, data = input, id = 'review'): QualityReviewReceipt {
    return {
      expectedRun: cloneProjectTaskRun(target),
      expectedTask: projectTaskVersion(project.tasks[0]!),
      review: {
        ...structuredClone(data),
        id,
        method: 'human-review',
        reviewedAt: at,
        projectId: 'p',
        taskId: 't',
        runId: target.id,
        criteriaVersion: target.acceptanceCriteria ?? '',
        taskVersion: projectTaskVersion(project.tasks[0]!),
        resultVersion: projectResultVersion(target),
        findings: data.findings.map((finding, index) => ({ ...finding, id: `${id}:${index}` })),
      },
    };
  }
  return { project, run, input, receipt };
}

describe('explicit criterion coverage and durable quality findings', () => {
  it('preserves line identity, duplicates and checkless legacy history without inventing assessments', () => {
    expect(projectCriteria('First\r\n\nFirst\nSecond')).toEqual(['First', 'First', 'Second']);
    const { run } = fixture();
    expect(validateProjectTaskRun(run)).toBe(true);
    expect(cloneProjectTaskRun(run).qualityReviews).toBeUndefined();
    expect(validateProjectTaskRun({ ...run, status: 'completed', completedAt: at })).toBe(true);
  });
  it.each(['missing', 'unmet', 'unverified', 'blank evidence'] as const)(
    'blocks %s criterion coverage and never frees dependents',
    (kind) => {
      const f = fixture();
      if (kind === 'missing') f.input.assessments.pop();
      else if (kind === 'blank evidence') f.input.assessments[1]!.evidence = '';
      else f.input.assessments[1]!.outcome = kind;
      if (kind === 'blank evidence') {
        expect(() => recordProjectQualityReview(f.project, f.run, [f.run], f.receipt())).toThrow(
          'invalid',
        );
        return;
      }
      const run = recordProjectQualityReview(f.project, f.run, [f.run], f.receipt());
      expect(() => verifyProjectRun(f.project, run, [run], 'Checked.', at)).toThrow(
        'every required criterion',
      );
      expect(projectTaskState(f.project, 'next')).toBe('blocked');
    },
  );
  it('requires explicit final approval after complete coverage and protects manual completion', () => {
    const f = fixture();
    const run = recordProjectQualityReview(f.project, f.run, [f.run], f.receipt());
    expect(run.status).toBe('awaiting-review');
    expect(() => setProjectTaskCompletion(f.project, 't', true, at)).toThrow('criterion review');
    expect(() => verifyProjectRun(f.project, run, [run], '', at)).toThrow('Record what');
    const result = verifyProjectRun(f.project, run, [run], 'Inspected both criteria.', at);
    expect(projectTaskState(result.project, 'next')).toBe('ready');
    expect(validateProjectTaskRun(result.run)).toBe(true);
  });
  it('keeps blocking findings across runs and requires an explicit grounded resolution', () => {
    const f = fixture();
    f.input.findings.push({
      blocking: true,
      reason: 'Total uses the wrong currency.',
      repair: 'Use EUR consistently in the total column.',
    });
    const old = recordProjectQualityReview(f.project, f.run, [f.run], f.receipt());
    const next = {
      ...f.run,
      id: 'next-run',
      previousRunId: old.id,
      createdAt: '2026-09-11T10:01:00Z',
    };
    const input = { ...f.input, findings: [] };
    const reviewed = recordProjectQualityReview(
      f.project,
      next,
      [old, next],
      f.receipt(next, input, 'review2'),
    );
    expect(() => verifyProjectRun(f.project, reviewed, [old, reviewed], 'Checked.', at)).toThrow(
      'blocking quality finding',
    );
    input.resolutions = [
      { findingId: 'review:0', note: 'Inspected corrected EUR totals in revision 2.' },
    ];
    const resolved = recordProjectQualityReview(
      f.project,
      reviewed,
      [old, reviewed],
      f.receipt(reviewed, input, 'review3'),
    );
    expect(openQualityFindings(resolved, [old, resolved])).toEqual([]);
    expect(verifyProjectRun(f.project, resolved, [old, resolved], 'Checked.', at).run.status).toBe(
      'completed',
    );
    expect(old.qualityReviews![0]!.findings).toHaveLength(1);
  });
  it('advisory findings remain visible but do not block acceptance', () => {
    const f = fixture();
    f.input.findings.push({
      blocking: false,
      reason: 'Optional caption.',
      repair: 'Consider a caption in a later task.',
    });
    const run = recordProjectQualityReview(f.project, f.run, [f.run], f.receipt());
    expect(openQualityFindings(run, [run])).toHaveLength(1);
    expect(verifyProjectRun(f.project, run, [run], 'Checked.', at).run.status).toBe('completed');
  });
  it.each(['output', 'runtimeTurnId', 'acceptanceCriteria'] as const)(
    'invalidates a review when %s changes',
    (key) => {
      const f = fixture();
      const run = recordProjectQualityReview(f.project, f.run, [f.run], f.receipt());
      expect(currentQualityReview({ ...run, [key]: 'Changed' })).toBeUndefined();
    },
  );
  it('rejects concurrent task edits and competing reviews without dropping the first history', () => {
    const f = fixture();
    const receipt = f.receipt();
    const saved = recordProjectQualityReview(f.project, f.run, [f.run], receipt);
    expect(() => recordProjectQualityReview(f.project, saved, [saved], receipt)).toThrow(
      'changed during review',
    );
    f.project.tasks[0]!.description = 'Changed instructions';
    expect(() => recordProjectQualityReview(f.project, f.run, [f.run], receipt)).toThrow(
      'changed during review',
    );
    expect(() => verifyProjectRun(f.project, saved, [saved], 'Checked.', at)).toThrow(
      'every required criterion',
    );
  });
  it('does not let a review claim a missing or already resolved finding', () => {
    const f = fixture();
    f.input.resolutions.push({ findingId: 'unknown', note: 'Trust me.' });
    expect(() => recordProjectQualityReview(f.project, f.run, [f.run], f.receipt())).toThrow(
      'finding changed',
    );
  });
  it('rejects duplicate assessments, invalid outcomes and blank finding repairs on hydration', () => {
    const f = fixture();
    const run = recordProjectQualityReview(f.project, f.run, [f.run], f.receipt());
    run.qualityReviews![0]!.assessments.push(run.qualityReviews![0]!.assessments[0]!);
    expect(validateProjectTaskRun(run)).toBe(false);
    f.input.findings.push({ blocking: true, reason: 'Missing summary.', repair: '' });
    expect(() => recordProjectQualityReview(f.project, f.run, [f.run], f.receipt())).toThrow(
      'invalid',
    );
  });
  it('bounds repair scope, identifies missing criteria and preserves immutable review evidence', () => {
    const f = fixture();
    f.input.findings = Array.from({ length: 12 }, (_, i) => ({
      blocking: true,
      reason: `Missing section ${i}`,
      repair: `Write section ${i}.`,
    }));
    const run = recordProjectQualityReview(f.project, f.run, [f.run], f.receipt());
    const proposal = projectRepairProposal(run, [run]);
    expect(proposal).toContain('covers 8 of 12');
    expect(proposal).toContain('do not replay');
    expect(proposal.length).toBeLessThan(10000);
    expect(projectRepairProposal(f.run, [f.run])).toContain('Not yet verified');
    const copy = cloneProjectTaskRun(run);
    copy.qualityReviews![0]!.findings[0]!.reason = 'Changed';
    expect(run.qualityReviews![0]!.findings[0]!.reason).toBe('Missing section 0');
  });
  it('refuses a reservation if review findings changed while the worker was preparing', () => {
    const f = fixture();
    const next: ProjectTaskRun = {
      ...f.run,
      id: 'new',
      status: 'queued',
      previousRunId: f.run.id,
      previousQualityVersion: JSON.stringify([[], []]),
      createdAt: '2026-09-11T10:01:00Z',
    };
    const changed = recordProjectQualityReview(f.project, f.run, [f.run], f.receipt());
    expect(() => validateProjectRunReservation(f.project, next, [changed])).toThrow(
      'quality findings changed',
    );
  });
});

it('uses the existing bounded continuation and retains permissions after a repair proposal', async () => {
  const { ProjectWorkflowRuntime } = await import('./index');
  const f = fixture();
  f.project.tasks[0]!.turnLimit = 2;
  f.project.tasks[0]!.timeLimitMinutes = 10;
  f.input.findings = [
    { blocking: true, reason: 'Missing total.', repair: 'Add the total row only.' },
  ];
  let original = recordProjectQualityReview(f.project, f.run, [f.run], f.receipt());
  const values = new Map([[original.id, original]]);
  let seenProposal = '';
  let now = Date.parse(at) + 1000;
  let serial = 0;
  const projects = {
    list: async () => [f.project],
    get: async () => f.project,
    save: async () => undefined,
    remove: async () => undefined,
  };
  const runs = {
    list: async () => [...values.values()].map(cloneProjectTaskRun),
    get: async (id: string) => (values.has(id) ? cloneProjectTaskRun(values.get(id)!) : null),
    save: async (run: ProjectTaskRun) => {
      values.set(run.id, cloneProjectTaskRun(run));
    },
  };
  const runtime = new ProjectWorkflowRuntime(
    projects,
    runs,
    {
      prepare: async () => ({ agentName: 'Controlled test worker' }),
      async *execute(input) {
        seenProposal = input.run.continuation ?? '';
        yield { type: 'started', runtimeTurnId: 'repair-turn' };
        expect(input.previousRun?.qualityReviews).toEqual(original.qualityReviews);
        yield {
          type: 'approval-required',
          runtimeTurnId: 'repair-turn',
          approval: {
            id: 'permission',
            toolId: 'workspace.shell',
            toolName: 'Shell',
            reason: 'Mandatory permission remains required.',
          },
        };
      },
      async *resume(_input, _id, decision) {
        expect(decision).toBe('deny');
        yield {
          type: 'returned',
          runtimeTurnId: 'repair-turn',
          output: 'Permission denied; no change made.',
        };
      },
      cancel: async () => undefined,
      recover: async () => ({ status: 'failed', failure: 'No safe checkpoint.' }),
    },
    undefined,
    () => new Date(now++),
    () => `new-${++serial}`,
    {
      reserve: async (run) => {
        validateProjectRunReservation(f.project, run, [...values.values()]);
        await runs.save(run);
      },
      verify: async () => {
        throw new Error('Not used by this test.');
      },
    },
  );
  const suspended = await runtime.continueRepair(original.id, original);
  expect(suspended.status).toBe('suspended');
  expect(suspended.turnLimit).toBe(2);
  expect(suspended.timeLimitMinutes).toBe(10);
  expect(suspended.turnsUsed).toBe(1);
  expect(suspended.deadlineAt).toBeDefined();
  expect(seenProposal).toContain('Add the total row only.');
  const denied = await runtime.resolveApproval('permission', 'deny');
  expect(denied.status).toBe('awaiting-review');
  expect(denied.qualityReviews).toBeUndefined();
  expect(openQualityFindings(denied, [...values.values()])).toHaveLength(1);
  expect(() => verifyProjectRun(f.project, denied, [...values.values()], 'Checked.', at)).toThrow(
    'every required criterion',
  );
  original = { ...original, output: 'Changed during review.' };
  await runs.save(original);
  await expect(runtime.continueRepair(original.id, f.run)).rejects.toThrow('changed');
});

it('marks coverage stale when artifact evidence changes, and keeps QC-1 enforced after complete coverage', () => {
  const f = fixture();
  const check = {
    id: 'check',
    target: { kind: 'document' as const, title: 'Export' },
    assertion: 'nonempty' as const,
  };
  f.project.tasks[0]!.resultChecks = [check];
  f.run.resultChecks = [check];
  const report = {
    runtimeTurnId: 'turn',
    checkedAt: at,
    results: [
      {
        checkId: 'check',
        status: 'passed' as const,
        message: 'Non-empty.',
        evidence: 'revision-1',
      },
    ],
  };
  f.run.checkReports = [report];
  const receipt = f.receipt();
  receipt.review.checkReport = structuredClone(report);
  const run = recordProjectQualityReview(f.project, f.run, [f.run], receipt);
  const changed = { ...report, results: [{ ...report.results[0]!, evidence: 'revision-2' }] };
  expect(() =>
    verifyProjectRun(f.project, run, [run], 'Checked.', at, {
      expectedRun: run,
      checkReport: changed,
    }),
  ).toThrow('changed after');
  expect(currentQualityReview({ ...run, checkReports: [changed] })).toBeUndefined();
  expect(
    verifyProjectRun(f.project, run, [run], 'Checked.', at, {
      expectedRun: run,
      checkReport: report,
    }).run.status,
  ).toBe('completed');
});
