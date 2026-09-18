import type { ProjectGraph, ProjectTask, ProjectTaskRun } from './index';
import { isNewerProjectRun } from './projectRunOrder';
import {
  requireUnchangedProjectCheckEvidence,
  sameProjectChecks,
  validProjectCheckReports,
  type ProjectCheckReport,
} from './resultChecks';

export type CriterionOutcome = 'met' | 'unmet' | 'unverified';
export interface CriterionAssessment {
  criterion: number;
  outcome: CriterionOutcome;
  rationale: string;
  evidence: string;
}
export interface QualityFinding {
  id: string;
  criterion?: number;
  blocking: boolean;
  reason: string;
  repair: string;
}
export interface QualityReviewInput {
  assessments: CriterionAssessment[];
  findings: Omit<QualityFinding, 'id'>[];
  resolutions: { findingId: string; note: string }[];
}
export interface ProjectQualityReview extends QualityReviewInput {
  id: string;
  method: 'human-review';
  reviewedAt: string;
  projectId: string;
  taskId: string;
  runId: string;
  /** Exact source text is the criterion version; edits, reordering and duplicates are significant. */
  criteriaVersion: string;
  taskVersion: string;
  resultVersion: string;
  checkReport?: ProjectCheckReport;
  findings: QualityFinding[];
}
export interface ProjectQualityRejection {
  id: string;
  at: string;
  reason: string;
  resultVersion: string;
}
export interface QualityReviewReceipt {
  expectedRun: ProjectTaskRun;
  expectedTask: string;
  review: ProjectQualityReview;
}

export function projectCriteria(text?: string): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
export function projectTaskVersion(task: ProjectTask): string {
  return JSON.stringify([
    task.title,
    task.description ?? '',
    task.acceptanceCriteria ?? '',
    task.resultChecks ?? [],
  ]);
}
export function projectResultVersion(run: ProjectTaskRun): string {
  return JSON.stringify([
    run.projectId,
    run.taskId,
    run.id,
    run.runtimeTurnId ?? '',
    run.acceptanceCriteria ?? '',
    run.resultChecks ?? [],
    run.output ?? '',
    run.checkReports?.at(-1) ?? null,
  ]);
}
export function taskQualityReviews(
  run: ProjectTaskRun,
  runs: ProjectTaskRun[],
): ProjectQualityReview[] {
  return runs
    .filter((other) => other.projectId === run.projectId && other.taskId === run.taskId)
    .flatMap((other) => other.qualityReviews ?? [])
    .sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt) || a.id.localeCompare(b.id));
}
export function openQualityFindings(run: ProjectTaskRun, runs: ProjectTaskRun[]): QualityFinding[] {
  const reviews = taskQualityReviews(run, runs);
  const resolved = new Set(
    reviews.flatMap((review) => review.resolutions.map((entry) => entry.findingId)),
  );
  return reviews
    .flatMap((review) => review.findings)
    .filter((finding) => !resolved.has(finding.id));
}
function sameEvidence(a?: ProjectCheckReport, b?: ProjectCheckReport): boolean {
  return (
    JSON.stringify(a?.results) === JSON.stringify(b?.results) &&
    a?.runtimeTurnId === b?.runtimeTurnId
  );
}
export function currentQualityReview(
  run: ProjectTaskRun,
  task?: ProjectTask,
): ProjectQualityReview | undefined {
  const review = run.qualityReviews?.at(-1);
  return review &&
    review.runId === run.id &&
    review.criteriaVersion === (run.acceptanceCriteria ?? '') &&
    review.resultVersion === projectResultVersion(run) &&
    (!task || review.taskVersion === projectTaskVersion(task)) &&
    sameEvidence(review.checkReport, run.checkReports?.at(-1))
    ? review
    : undefined;
}
export function requireProjectQualityCoverage(
  task: ProjectTask,
  run: ProjectTaskRun,
  runs: ProjectTaskRun[],
): void {
  const criteria = projectCriteria(task.acceptanceCriteria);
  const review = currentQualityReview(run, task);
  if (
    criteria.length &&
    (!review ||
      criteria.some(
        (_, criterion) =>
          !review.assessments.some(
            (assessment) => assessment.criterion === criterion && assessment.outcome === 'met',
          ),
      ))
  )
    throw new Error(
      'Acceptance blocked: every required criterion needs a current human assessment marked Met with rationale and evidence. Missing, unmet or stale assessments are not approval.',
    );
  if (openQualityFindings(run, runs).some((finding) => finding.blocking))
    throw new Error(
      'Acceptance blocked: resolve every open blocking quality finding with a recorded explanation.',
    );
}
function text(value: unknown, max = 4000): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max;
}
export function validQualityReviews(
  value: unknown,
  run: Pick<ProjectTaskRun, 'id' | 'taskId' | 'projectId' | 'resultChecks'>,
): value is ProjectQualityReview[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false;
    const review = item as ProjectQualityReview;
    if (
      !text(review.id) ||
      ids.has(review.id) ||
      review.method !== 'human-review' ||
      !text(review.reviewedAt) ||
      !Number.isFinite(Date.parse(review.reviewedAt)) ||
      review.runId !== run.id ||
      review.taskId !== run.taskId ||
      review.projectId !== run.projectId ||
      typeof review.criteriaVersion !== 'string' ||
      !text(review.taskVersion, 1000000) ||
      !text(review.resultVersion, 10000000)
    )
      return false;
    ids.add(review.id);
    const count = projectCriteria(review.criteriaVersion).length;
    if (
      !Array.isArray(review.assessments) ||
      review.assessments.length > count ||
      new Set(review.assessments.map((a) => a?.criterion)).size !== review.assessments.length ||
      !review.assessments.every(
        (a) =>
          a &&
          Number.isInteger(a.criterion) &&
          a.criterion >= 0 &&
          a.criterion < count &&
          ['met', 'unmet', 'unverified'].includes(a.outcome) &&
          typeof a.rationale === 'string' &&
          a.rationale.length <= 4000 &&
          typeof a.evidence === 'string' &&
          a.evidence.length <= 4000 &&
          (a.outcome === 'unverified' || (text(a.rationale) && text(a.evidence))),
      )
    )
      return false;
    if (
      !Array.isArray(review.findings) ||
      review.findings.length > 32 ||
      new Set(review.findings.map((f) => f?.id)).size !== review.findings.length ||
      !review.findings.every(
        (f) =>
          f &&
          text(f.id) &&
          typeof f.blocking === 'boolean' &&
          text(f.reason) &&
          text(f.repair) &&
          (f.criterion === undefined ||
            (Number.isInteger(f.criterion) && f.criterion >= 0 && f.criterion < count)),
      )
    )
      return false;
    if (
      !Array.isArray(review.resolutions) ||
      !review.resolutions.every((r) => r && text(r.findingId) && text(r.note)) ||
      new Set(review.resolutions.map((r) => r.findingId)).size !== review.resolutions.length
    )
      return false;
    return (
      review.checkReport === undefined ||
      validProjectCheckReports([review.checkReport], run.resultChecks ?? [])
    );
  });
}
export function validQualityRejections(value: unknown): value is ProjectQualityRejection[] {
  return (
    Array.isArray(value) &&
    value.every((r: unknown) => {
      if (!r || typeof r !== 'object') return false;
      const rejection = r as ProjectQualityRejection;
      return (
        text(rejection.id) &&
        text(rejection.at) &&
        Number.isFinite(Date.parse(rejection.at)) &&
        text(rejection.reason) &&
        text(rejection.resultVersion, 10000000)
      );
    })
  );
}

/** Pure validation and append; the adapter calls this inside its existing transaction. */
export function recordProjectQualityReview(
  project: ProjectGraph,
  run: ProjectTaskRun,
  runs: ProjectTaskRun[],
  receipt: QualityReviewReceipt,
): ProjectTaskRun {
  const task = project.tasks.find((candidate) => candidate.id === run.taskId);
  if (
    !task ||
    project.id !== run.projectId ||
    !['awaiting-review', 'needs-attention', 'failed', 'cancelled'].includes(run.status)
  )
    throw new Error('Only stopped, unfinished work can receive a quality review.');
  if (
    JSON.stringify(run) !== JSON.stringify(receipt.expectedRun) ||
    projectTaskVersion(task) !== receipt.expectedTask
  )
    throw new Error(
      'The task or worker result changed during review. Refresh and review it again.',
    );
  if (
    (task.acceptanceCriteria ?? '') !== (run.acceptanceCriteria ?? '') ||
    !sameProjectChecks(task.resultChecks, run.resultChecks)
  )
    throw new Error(
      'The task criteria or checks changed. Continue with the current task definition before reviewing.',
    );
  if (
    runs.some(
      (other) =>
        other.id !== run.id &&
        other.taskId === run.taskId &&
        other.projectId === run.projectId &&
        (other.previousRunId === run.id || isNewerProjectRun(other, run)),
    )
  )
    throw new Error('A newer run exists for this task. Review its result instead.');
  const review = receipt.review;
  if (
    !validQualityReviews([review], run) ||
    review.criteriaVersion !== (run.acceptanceCriteria ?? '') ||
    review.taskVersion !== projectTaskVersion(task) ||
    review.resultVersion !== projectResultVersion(run) ||
    taskQualityReviews(run, runs).some(
      (old) =>
        old.id === review.id ||
        old.findings.some((finding) => review.findings.some((next) => next.id === finding.id)),
    )
  )
    throw new Error('The quality review is invalid or stale.');
  // §23 — evidence correctness never depends on whether the reviewer wrote resolutions. A review
  // with failed, stale or mismatched evidence is rejected whether or not it carries any.
  if (run.resultChecks?.length)
    requireUnchangedProjectCheckEvidence(
      run.resultChecks,
      run.checkReports?.at(-1),
      review.checkReport,
      run.runtimeTurnId,
      review.reviewedAt,
    );
  const open = openQualityFindings(run, runs);
  if (review.resolutions.some((resolution) => !open.some((f) => f.id === resolution.findingId)))
    throw new Error('A finding changed during review. Refresh its current state.');
  return {
    ...run,
    updatedAt: review.reviewedAt,
    qualityReviews: [...(run.qualityReviews ?? []), structuredClone(review)],
  };
}

/** A bounded proposal only. Launch/permissions/checkpoints remain owned by the existing runtime. */
export function projectRepairProposal(run: ProjectTaskRun, runs: ProjectTaskRun[]): string {
  const review = currentQualityReview(run);
  const missing = projectCriteria(run.acceptanceCriteria).flatMap((criterion, index) => {
    const assessment = review?.assessments.find((a) => a.criterion === index);
    return assessment?.outcome === 'met'
      ? []
      : [
          `Criterion ${index + 1}: ${criterion.slice(0, 500)} — ${assessment?.rationale.slice(0, 500) || 'Not yet verified. Inspect the deliverable and obtain evidence; do not assume it is correct.'}`,
        ];
  });
  const findings = openQualityFindings(run, runs).map(
    (finding) =>
      `Finding ${finding.id}: ${finding.reason.slice(0, 500)} Required change: ${finding.repair.slice(0, 500)}`,
  );
  const rejected = run.qualityRejections?.at(-1);
  const rejection = rejected
    ? [
        `Latest acceptance rejection: ${rejected.reason.slice(0, 1000)} Inspect and correct the cause, then obtain fresh evidence for human review.`,
      ]
    : [];
  const items = [...findings, ...missing, ...rejection];
  if (!items.length) return '';
  return [
    "Repair proposal for this task only. Inspect current state first; do not replay actions with unknown outcomes. Human review is still required. Stay within this run's configured budget and existing permissions.",
    ...items.slice(0, 8).map((item, i) => `${i + 1}. ${item}`),
    ...(items.length > 8
      ? [
          `This proposal covers 8 of ${items.length} items. Remaining items stay open for a later bounded continuation.`,
        ]
      : []),
    'Return the changed deliverables and evidence for each addressed item. Do not mark findings resolved or claim human acceptance.',
  ].join('\n');
}
