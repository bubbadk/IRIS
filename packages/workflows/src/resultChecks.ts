/** Read-only acceptance checks. Natural-language quality still requires human review. */
export type ProjectCheckTarget =
  { kind: 'document'; title: string } | { kind: 'workspace-file'; rootPath: string; path: string };
export interface ProjectResultCheck {
  id: string;
  target: ProjectCheckTarget;
  assertion: 'nonempty' | 'contains' | 'json';
  expected?: string;
}
export interface ProjectCheckResult {
  checkId: string;
  status: 'passed' | 'failed' | 'error';
  message: string;
  evidence?: string;
}
export interface ProjectCheckReport {
  runtimeTurnId: string;
  checkedAt: string;
  results: ProjectCheckResult[];
}
export interface ProjectCheckArtifact {
  content: string;
  evidence: string;
}
export interface ProjectResultChecker {
  read(target: ProjectCheckTarget): Promise<ProjectCheckArtifact | null>;
}

/** Rechecking a weak predicate is insufficient if the reviewed artifact itself changed. */
export function requireUnchangedProjectCheckEvidence(
  checks: ProjectResultCheck[],
  previous: ProjectCheckReport | undefined,
  fresh: ProjectCheckReport | undefined,
  runtimeTurnId: string | undefined,
  reviewedAt: string,
): void {
  if (
    !previous ||
    !fresh ||
    !validProjectCheckReports([previous, fresh], checks) ||
    previous.runtimeTurnId !== runtimeTurnId ||
    fresh.runtimeTurnId !== runtimeTurnId ||
    !Number.isFinite(Date.parse(reviewedAt)) ||
    Date.parse(fresh.checkedAt) < Date.parse(previous.checkedAt) ||
    Date.parse(fresh.checkedAt) > Date.parse(reviewedAt)
  )
    throw new Error('Fresh result checks for this worker turn are required before verification.');

  for (const [index, result] of fresh.results.entries()) {
    const old = previous.results[index]!;
    const target = checks[index]!.target;
    const label = `check ${index + 1} (${JSON.stringify(target.kind === 'document' ? target.title : target.path)})`;
    if (result.status !== 'passed')
      throw new Error(`Verification blocked by ${label}: ${result.message}`);
    if (old.status !== 'passed' || !old.evidence?.trim() || !result.evidence?.trim())
      throw new Error(
        'Result check evidence is missing. Continue the task to obtain new evidence.',
      );
    if (old.evidence !== result.evidence)
      throw new Error(
        `The deliverable for ${label} changed after its recorded checks. Inspect current content and continue the task to obtain new evidence before verifying it.`,
      );
  }
}
export function validProjectChecks(value: unknown): value is ProjectResultCheck[] {
  if (!Array.isArray(value) || value.length > 8) return false;
  const ids = new Set<string>();
  return value.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false;
    const check = item as Partial<ProjectResultCheck>;
    if (typeof check.id !== 'string' || !check.id.trim() || ids.has(check.id)) return false;
    ids.add(check.id);
    if (!['nonempty', 'contains', 'json'].includes(check.assertion ?? '')) return false;
    if (check.assertion === 'contains') {
      if (
        typeof check.expected !== 'string' ||
        !check.expected.trim() ||
        check.expected.length > 4096
      )
        return false;
    } else if (check.expected !== undefined) return false;
    const target = check.target;
    if (!target || typeof target !== 'object') return false;
    if (target.kind === 'document')
      return (
        typeof target.title === 'string' && !!target.title.trim() && target.title.length <= 180
      );
    return (
      target.kind === 'workspace-file' &&
      typeof target.rootPath === 'string' &&
      !!target.rootPath.trim() &&
      typeof target.path === 'string' &&
      !!target.path.trim() &&
      target.path.length <= 4096 &&
      !target.path.startsWith('/') &&
      !target.path.includes('\\') &&
      !target.path.includes('\0') &&
      !target.path.split('/').some((part) => part === '..' || part === '.' || !part)
    );
  });
}
export function sameProjectChecks(a?: ProjectResultCheck[], b?: ProjectResultCheck[]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}
export function cloneProjectChecks(
  checks?: ProjectResultCheck[],
): ProjectResultCheck[] | undefined {
  return checks?.map((check) => ({ ...check, target: { ...check.target } }));
}
export function describeProjectCheck(check: ProjectResultCheck): string {
  const target =
    check.target.kind === 'document'
      ? `Document titled ${JSON.stringify(check.target.title)} (exact title, one match)`
      : `File ${JSON.stringify(check.target.path)} in ${JSON.stringify(check.target.rootPath)}`;
  return `${target}: ${check.assertion === 'contains' ? `contains the exact text ${JSON.stringify(check.expected)}` : check.assertion === 'json' ? 'contains valid JSON' : 'contains non-whitespace text'}`;
}
export async function checkProjectResults(
  checks: ProjectResultCheck[],
  checker: ProjectResultChecker | undefined,
  runtimeTurnId: string,
  checkedAt: string,
): Promise<ProjectCheckReport> {
  if (!validProjectChecks(checks)) throw new Error('The result checks are invalid.');
  // Read each artifact once, so related assertions use the same snapshot.
  const reads = new Map<string, Promise<ProjectCheckArtifact | null>>();
  const results: ProjectCheckResult[] = [];
  for (const check of checks) {
    try {
      if (!checker) throw new Error('Result checking is unavailable.');
      const key = JSON.stringify(check.target);
      if (!reads.has(key)) reads.set(key, checker.read(check.target));
      const artifact = await reads.get(key)!;
      let passed = false;
      let message = 'The target does not exist.';
      if (artifact) {
        if (check.assertion === 'nonempty') {
          passed = !!artifact.content.trim();
          message = passed
            ? 'Non-empty text confirmed.'
            : 'The target contains no non-whitespace text.';
        } else if (check.assertion === 'contains') {
          passed = artifact.content.includes(check.expected!);
          message = passed
            ? 'Required text found (case-sensitive).'
            : 'Required text was not found (case-sensitive).';
        } else {
          try {
            JSON.parse(artifact.content);
            passed = true;
          } catch {
            /* Invalid JSON fails the check. */
          }
          message = passed ? 'Valid JSON confirmed.' : 'The target is not valid JSON.';
        }
      }
      results.push({
        checkId: check.id,
        status: passed ? 'passed' : 'failed',
        message,
        ...(artifact ? { evidence: artifact.evidence } : {}),
      });
    } catch (error) {
      results.push({
        checkId: check.id,
        status: 'error',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      });
    }
  }
  return { runtimeTurnId, checkedAt, results };
}
export function validProjectCheckReports(
  value: unknown,
  checks: ProjectResultCheck[],
): value is ProjectCheckReport[] {
  if (!Array.isArray(value) || value.length > 10) return false;
  return value.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false;
    const report = item as Partial<ProjectCheckReport>;
    return (
      typeof report.runtimeTurnId === 'string' &&
      !!report.runtimeTurnId &&
      typeof report.checkedAt === 'string' &&
      !Number.isNaN(Date.parse(report.checkedAt)) &&
      Array.isArray(report.results) &&
      report.results.length === checks.length &&
      report.results.every(
        (result, index) =>
          result &&
          result.checkId === checks[index]?.id &&
          ['passed', 'failed', 'error'].includes(result.status) &&
          typeof result.message === 'string' &&
          (result.evidence === undefined || typeof result.evidence === 'string'),
      )
    );
  });
}
