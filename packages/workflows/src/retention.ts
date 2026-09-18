/**
 * IRIS Phase 2B — bounded, lifecycle-aware retention.
 *
 * Invariant: **a retention policy must never automatically delete live work.**
 *
 * These helpers are pure and deterministic. They only ever drop records that are:
 *  - finally closed (terminal status), AND
 *  - not needed by any retained record (no live lineage reference), AND
 *  - free of human review provenance.
 *
 * If the protected records alone exceed the cap, every one of them is kept and the cap is
 * exceeded on purpose: exceeding a storage budget is recoverable, deleting active work is not.
 */
import type { ProjectTaskRun } from './index';
import type { ProjectQualityRejection, ProjectQualityReview } from './qualityReview';
import type { ProjectQueueEntry, ProjectQueueStatus } from './projectQueue';

// --- Project task queue -------------------------------------------------------------------------

/** Statuses that still require runtime or user action. A retention cap must never delete these. */
export const nonTerminalProjectQueueStatuses = ['queued', 'claimed', 'launched', 'needs-attention'] as const;

/** Statuses whose work is finally closed and which no dispatcher will ever act on again. */
export const terminalProjectQueueStatuses = ['cancelled'] as const;

export function isTerminalProjectQueueEntry(entry: Pick<ProjectQueueEntry, 'status'>): boolean {
  return (terminalProjectQueueStatuses as readonly ProjectQueueStatus[]).includes(entry.status);
}

export function isNonTerminalProjectQueueEntry(
  entry: Pick<ProjectQueueEntry, 'status'>,
): boolean {
  return !isTerminalProjectQueueEntry(entry);
}

/**
 * Applies the queue retention cap. All non-terminal entries survive; only terminal history is
 * pruned, oldest first (`updatedAt`, then `id`), so identical input always yields identical output.
 * The returned array keeps the caller's original order.
 */
export function retainProjectQueueEntries(
  entries: readonly ProjectQueueEntry[],
  limit: number,
): ProjectQueueEntry[] {
  if (entries.length <= limit) return [...entries];
  const removable = entries
    .filter(isTerminalProjectQueueEntry)
    .sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    );
  const pruned = new Set<string>();
  let remaining = entries.length;
  for (const entry of removable) {
    if (remaining <= limit) break;
    pruned.add(entry.id);
    remaining -= 1;
  }
  return entries.filter((entry) => !pruned.has(entry.id));
}

// --- Project task runs --------------------------------------------------------------------------

/**
 * Statuses that still need the runtime or the user: active work, work awaiting review, work that
 * was paused at a checkpoint, and work that stopped for attention. None of these may be pruned.
 */
export const nonTerminalProjectTaskRunStatuses = [
  'queued',
  'running',
  'suspended',
  'awaiting-review',
  'needs-attention',
  'paused',
] as const;

/** Statuses that describe a run whose lifecycle has ended by itself. */
export const terminalProjectTaskRunStatuses = ['completed', 'failed', 'cancelled'] as const;

export function isTerminalProjectTaskRun(run: Pick<ProjectTaskRun, 'status'>): boolean {
  return (terminalProjectTaskRunStatuses as readonly ProjectTaskRun['status'][]).includes(
    run.status,
  );
}

export function isNonTerminalProjectTaskRun(run: Pick<ProjectTaskRun, 'status'>): boolean {
  return !isTerminalProjectTaskRun(run);
}

/**
 * A run carries human review provenance when it holds quality reviews or recorded rejections.
 * `openQualityFindings` resolves findings across a task's whole run history, so pruning such a run
 * could silently drop an unresolved blocking finding.
 */
export function carriesQualityProvenance(run: ProjectTaskRun): boolean {
  return Boolean(run.qualityReviews?.length || run.qualityRejections?.length);
}

/**
 * Bounded per project task. Never prunes a non-terminal run, the `previousRunId` target a
 * non-terminal run still needs, or a run carrying review provenance. Terminal history is pruned
 * oldest first, deterministically by `(updatedAt || createdAt, id)`.
 */
export function retainProjectTaskRuns(
  runs: readonly ProjectTaskRun[],
  limitPerTask: number,
): ProjectTaskRun[] {
  const protectedIds = new Set<string>();
  for (const run of runs) {
    if (isNonTerminalProjectTaskRun(run) || carriesQualityProvenance(run)) {
      protectedIds.add(run.id);
      // A live repair/continue chain still needs the run it was launched from.
      if (isNonTerminalProjectTaskRun(run) && run.previousRunId) {
        protectedIds.add(run.previousRunId);
      }
    }
  }
  const groups = new Map<string, ProjectTaskRun[]>();
  for (const run of runs) {
    const key = `${run.projectId}\u0000${run.taskId}`;
    const group = groups.get(key);
    if (group) group.push(run);
    else groups.set(key, [run]);
  }
  const pruned = new Set<string>();
  for (const group of groups.values()) {
    const removable = group
      .filter((run) => !protectedIds.has(run.id))
      .sort(
        (left, right) =>
          (left.updatedAt || left.createdAt).localeCompare(right.updatedAt || right.createdAt) ||
          left.id.localeCompare(right.id),
      );
    let remaining = group.length;
    for (const run of removable) {
      if (remaining <= limitPerTask) break;
      pruned.add(run.id);
      remaining -= 1;
    }
  }
  return runs.filter((run) => !pruned.has(run.id));
}

// --- Project run quality history ----------------------------------------------------------------

/**
 * IRIS Phase 2G §19–§20 — a bound on the append-only quality history of a single run.
 *
 * `qualityReviews` and `qualityRejections` only ever grow: every rejection of the same run appends
 * another record, and every re-review appends another review. Nothing bounded them.
 *
 * A bound must not falsify acceptance, so this is a *provenance-aware* cap, not a truncation:
 *
 *  - the newest review is always kept — it is the lineage current review state is read from;
 *  - a review that recorded a resolution is always kept — dropping it would re-open findings the
 *    human already answered;
 *  - a review holding a finding that no recorded resolution closes is always kept — that finding
 *    still blocks acceptance, and deleting it would silently weaken the decision;
 *  - the newest rejection is always kept — the repair proposal reads it.
 *
 * Only reviews whose findings are all already resolved, and older rejections, are terminal history
 * that no longer influences the current decision. Those are pruned oldest-first, deterministically
 * by `(reviewedAt|at, id)`. If the protected records alone exceed the cap, every one of them is
 * kept: exceeding a storage budget is recoverable, falsifying an acceptance decision is not.
 */
export const projectQualityHistoryLimit = 40;

export interface RetainedProjectQualityHistory {
  qualityReviews: ProjectQualityReview[];
  qualityRejections: ProjectQualityRejection[];
}

function resolvedFindingIds(reviews: readonly ProjectQualityReview[]): Set<string> {
  const resolved = new Set<string>();
  for (const review of reviews)
    for (const resolution of review.resolutions) resolved.add(resolution.findingId);
  return resolved;
}

/**
 * The records a prune is never allowed to drop, computed from one run.
 *
 * These are exactly the records that still decide something: the current review, every review that
 * carries a resolution, every review whose findings are not all resolved, and the newest rejection.
 * A repository can compare this subset against a write to prove nothing required was lost.
 */
export function protectedProjectQualityHistory(
  run: Pick<ProjectTaskRun, 'qualityReviews' | 'qualityRejections'>,
): RetainedProjectQualityHistory {
  const reviews = run.qualityReviews ?? [];
  const rejections = run.qualityRejections ?? [];
  const resolved = resolvedFindingIds(reviews);
  const newestReviewId = reviews.at(-1)?.id;
  const newestRejectionId = rejections.at(-1)?.id;
  return {
    qualityReviews: reviews.filter(
      (review) =>
        review.id === newestReviewId ||
        review.resolutions.length > 0 ||
        review.findings.some((finding) => !resolved.has(finding.id)),
    ),
    qualityRejections: rejections.filter((rejection) => rejection.id === newestRejectionId),
  };
}

/**
 * Deterministic and side-effect free: identical input always yields identical output, and every
 * protected record survives regardless of the cap.
 */
export function retainProjectQualityHistory(
  run: Pick<ProjectTaskRun, 'qualityReviews' | 'qualityRejections'>,
  limit: number = projectQualityHistoryLimit,
): RetainedProjectQualityHistory {
  const reviews = run.qualityReviews ?? [];
  const rejections = run.qualityRejections ?? [];
  const protectedReviews = new Set(
    protectedProjectQualityHistory(run).qualityReviews.map((review) => review.id),
  );

  const prunableReviews = reviews
    .filter((review) => !protectedReviews.has(review.id))
    .sort(
      (left, right) => left.reviewedAt.localeCompare(right.reviewedAt) || left.id.localeCompare(right.id),
    );
  const prunedReviews = new Set<string>();
  let remainingReviews = reviews.length;
  for (const review of prunableReviews) {
    if (remainingReviews <= limit) break;
    prunedReviews.add(review.id);
    remainingReviews -= 1;
  }

  const protectedRejections = new Set(
    protectedProjectQualityHistory(run).qualityRejections.map((rejection) => rejection.id),
  );
  const prunableRejections = rejections
    .filter((rejection) => !protectedRejections.has(rejection.id))
    .sort(
      (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
    );
  const prunedRejections = new Set<string>();
  let remainingRejections = rejections.length;
  for (const rejection of prunableRejections) {
    if (remainingRejections <= limit) break;
    prunedRejections.add(rejection.id);
    remainingRejections -= 1;
  }

  return {
    qualityReviews: reviews.filter((review) => !prunedReviews.has(review.id)),
    qualityRejections: rejections.filter((rejection) => !prunedRejections.has(rejection.id)),
  };
}

/**
 * The exact quality provenance a continuation run pins, computed through the same retention rule the
 * repository applies. Without this, a permitted prune of the previous run would invalidate the
 * continuation's pin and block a legitimate launch.
 */
export function previousQualityVersion(
  run: Pick<ProjectTaskRun, 'qualityReviews' | 'qualityRejections'>,
  limit: number = projectQualityHistoryLimit,
): string {
  const retained = retainProjectQualityHistory(run, limit);
  return JSON.stringify([retained.qualityReviews, retained.qualityRejections]);
}
