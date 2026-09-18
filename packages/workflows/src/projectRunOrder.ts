/**
 * IRIS Phase 2G §21–§22 — a total, deterministic order over project runs.
 *
 * Project runs used to be compared with `other.createdAt >= run.createdAt`. Two runs created in the
 * same millisecond therefore each looked "not older" than the other, so both could be rejected as
 * "a newer run exists" and neither could ever be reviewed, continued, resumed or verified. A
 * timestamp alone is not a total order.
 *
 * `(createdAt, id)` is: two distinct runs always compare strictly, exactly one run is the newest,
 * and the answer does not depend on input order or on when it is asked. `id` is the durable run
 * identity, so the order also survives a restart.
 */

export interface OrderedProjectRun {
  id: string;
  createdAt: string;
}

/**
 * Newest first. Negative when `left` is newer than `right`, positive when it is older, zero only
 * for the same run identity.
 */
export function compareProjectRunsNewestFirst(
  left: OrderedProjectRun,
  right: OrderedProjectRun,
): number {
  if (left.id === right.id) return 0;
  const byTime = right.createdAt.localeCompare(left.createdAt);
  return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
}

/** True only when `candidate` is strictly newer than `than`. Never symmetric between two runs. */
export function isNewerProjectRun(
  candidate: OrderedProjectRun,
  than: OrderedProjectRun,
): boolean {
  return compareProjectRunsNewestFirst(candidate, than) < 0;
}

/** The newest run of a non-empty list, by the same total order. */
export function newestProjectRun<T extends OrderedProjectRun>(runs: readonly T[]): T | undefined {
  return [...runs].sort(compareProjectRunsNewestFirst)[0];
}
