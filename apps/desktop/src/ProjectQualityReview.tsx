import { useEffect, useState } from 'react';
import {
  currentQualityReview,
  openQualityFindings,
  projectCriteria,
  projectRepairProposal,
  projectTaskVersion,
  taskQualityReviews,
  type CriterionAssessment,
  type CriterionOutcome,
  type ProjectTaskRun,
  type ProjectTask,
} from '@iris/workflows';
import { projectGraphRepository, projectTaskRunRepository } from './persistence';
import { projectWorkflowRuntime } from './projectRuntime';

/** Human observations only; no model calls or automatic semantic approval. */
export function ProjectQualityReview({ run, canAct }: { run: ProjectTaskRun; canAct: boolean }) {
  const [runs, setRuns] = useState<ProjectTaskRun[]>([run]);
  const [assessments, setAssessments] = useState<CriterionAssessment[]>([]);
  const [reason, setReason] = useState('');
  const [repair, setRepair] = useState('');
  const [blocking, setBlocking] = useState(true);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [task, setTask] = useState<ProjectTask>();
  const criteria = projectCriteria(run.acceptanceCriteria);
  const saved = task ? currentQualityReview(run, task) : undefined;
  const editable =
    canAct && ['awaiting-review', 'needs-attention', 'failed', 'cancelled'].includes(run.status);
  useEffect(() => {
    let active = true;
    setLoaded(false);
    setTask(undefined);
    setAssessments([]);
    setResolutions({});
    void Promise.all([
      projectTaskRunRepository.list(run.projectId),
      projectGraphRepository.get(run.projectId),
    ])
      .then(([values, project]) => {
        const currentTask = project?.tasks.find((value) => value.id === run.taskId);
        if (!currentTask) throw new Error('The reviewed task is unavailable.');
        if (active) {
          setTask(currentTask);
          setAssessments(currentQualityReview(run, currentTask)?.assessments ?? []);
          setRuns([...values.filter((value) => value.id !== run.id), run]);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active) setError('Quality history could not be loaded. Refresh before reviewing.');
      });
    return () => {
      active = false;
    };
  }, [run]);
  const findings = openQualityFindings(run, runs);
  const proposal = projectRepairProposal(run, runs);
  const history = taskQualityReviews(run, runs);
  function change(criterion: number, update: Partial<CriterionAssessment>) {
    setAssessments((values) => [
      ...values.filter((value) => value.criterion !== criterion),
      {
        criterion,
        outcome: 'unverified',
        rationale: '',
        evidence: '',
        ...values.find((value) => value.criterion === criterion),
        ...update,
      },
    ]);
  }
  async function save() {
    if (!loaded || !task) return;
    setBusy(true);
    setError('');
    try {
      await projectWorkflowRuntime.reviewQuality(
        run.id,
        {
          assessments,
          findings: reason.trim() || repair.trim() ? [{ reason, repair, blocking }] : [],
          resolutions: Object.entries(resolutions)
            .filter(([, note]) => note.trim())
            .map(([findingId, note]) => ({ findingId, note })),
        },
        run,
        projectTaskVersion(task),
      );
      setReason('');
      setRepair('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Quality review could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  async function continueRepair() {
    setBusy(true);
    setError('');
    try {
      const next = await projectWorkflowRuntime.continueRepair(run.id, run);
      if (next.status === 'failed') setError(next.failure ?? 'The repair worker failed.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Repair could not start.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="project-quality-review"
      aria-label="Criterion coverage and quality findings"
    >
      <strong>Criterion coverage</strong>
      {task && (
        <div>
          <strong>Reviewed task: {task.title}</strong>
          {task.description && <p>{task.description}</p>}
        </div>
      )}
      <p>
        Each non-empty line is required. Record your own inspection, rationale and evidence. Text
        checks and worker claims do not establish semantic correctness. Save this review before
        final approval.
      </p>
      {!criteria.length && (
        <p>No explicit criteria were recorded. Human approval is still required.</p>
      )}
      {!!criteria.length && (
        <p>
          {
            criteria.filter((_, index) =>
              saved?.assessments.some((a) => a.criterion === index && a.outcome === 'met'),
            ).length
          }{' '}
          / {criteria.length} criteria met in the saved current review.
        </p>
      )}
      {!!run.qualityReviews?.length && !saved && (
        <p className="project-review-notice">
          The saved assessments are stale. Inspect the current result and record a new review.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {criteria.map((criterion, index) => {
          const assessment = assessments.find((a) => a.criterion === index);
          return (
            <fieldset key={`${run.id}:${index}`} disabled={!editable || busy || !loaded}>
              <legend>
                Criterion {index + 1}: {criterion}
              </legend>
              <label>
                Assessment {index + 1}
                <select
                  aria-label={`Assessment ${index + 1}`}
                  value={assessment?.outcome ?? 'unverified'}
                  onChange={(event) =>
                    change(index, { outcome: event.target.value as CriterionOutcome })
                  }
                >
                  <option value="unverified">Not yet verified</option>
                  <option value="met">Met</option>
                  <option value="unmet">Not met</option>
                </select>
              </label>
              <label>
                Rationale {index + 1}
                <textarea
                  value={assessment?.rationale ?? ''}
                  maxLength={4000}
                  rows={2}
                  onChange={(event) => change(index, { rationale: event.target.value })}
                />
              </label>
              <label>
                Evidence {index + 1}
                <textarea
                  value={assessment?.evidence ?? ''}
                  maxLength={4000}
                  rows={2}
                  placeholder="Name the inspected deliverable, location and observation. This is your report, not independent verification."
                  onChange={(event) => change(index, { evidence: event.target.value })}
                />
              </label>
            </fieldset>
          );
        })}
        <strong>Open quality findings</strong>
        {loaded && !findings.length && <p>No open findings recorded.</p>}
        {findings.map((finding) => (
          <div key={finding.id} className="project-review-notice">
            <strong>
              {finding.blocking ? 'Blocking' : 'Advisory'}: {finding.reason}
            </strong>
            <p>Proposed repair: {finding.repair}</p>
            {editable && (
              <label>
                Resolution for {finding.reason}
                <textarea
                  maxLength={4000}
                  rows={2}
                  value={resolutions[finding.id] ?? ''}
                  placeholder="Leave blank to keep open. To resolve, explain the correction and evidence you inspected."
                  disabled={busy || !loaded}
                  onChange={(event) =>
                    setResolutions({ ...resolutions, [finding.id]: event.target.value })
                  }
                />
              </label>
            )}
          </div>
        ))}
        {editable && (
          <>
            <details>
              <summary>Add a quality finding or rejection reason</summary>
              <label>
                Finding or rejection reason
                <textarea
                  maxLength={4000}
                  rows={2}
                  value={reason}
                  disabled={busy}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <label>
                Concrete repair needed
                <textarea
                  maxLength={4000}
                  rows={2}
                  value={repair}
                  disabled={busy}
                  onChange={(event) => setRepair(event.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={blocking}
                  disabled={busy}
                  onChange={(event) => setBlocking(event.target.checked)}
                />
                Blocks task acceptance
              </label>
            </details>
            <button className="soft-button" disabled={busy || !loaded}>
              Save quality review
            </button>
          </>
        )}
      </form>
      {editable && proposal && (
        <details>
          <summary>Bounded repair proposal</summary>
          <p className="quality-proposal">{proposal}</p>
          <p>
            Starts the existing continuation with a fresh configured turn/time budget and saved
            history. Permissions still apply. Unsaved review edits are not included.
          </p>
          <button
            type="button"
            className="row-button"
            disabled={busy || !loaded}
            onClick={() => void continueRepair()}
          >
            Continue with saved repair proposal
          </button>
        </details>
      )}
      {!!history.length && (
        <details>
          <summary>Saved review history ({history.length})</summary>
          {history.map((review) => (
            <div key={review.id}>
              <strong>Human review · {new Date(review.reviewedAt).toLocaleString()}</strong>
              <small> Run: {review.runId}</small>
              <p>Criteria version: {review.criteriaVersion || 'No explicit criteria'}</p>
              {review.assessments.map((a) => (
                <p key={a.criterion}>
                  Criterion {a.criterion + 1} —{' '}
                  {a.outcome === 'met'
                    ? 'Met'
                    : a.outcome === 'unmet'
                      ? 'Not met'
                      : 'Not yet verified'}
                  : {a.rationale} Evidence: {a.evidence}
                </p>
              ))}
              {review.checkReport?.results.map((result) => (
                <p key={result.checkId}>
                  {result.message} {result.evidence}
                </p>
              ))}
              {review.findings.map((f) => (
                <p key={f.id}>
                  {f.blocking ? 'Blocking' : 'Advisory'} finding: {f.reason} Repair: {f.repair}
                </p>
              ))}
              {review.resolutions.map((r) => (
                <p key={r.findingId}>
                  Resolved {r.findingId}: {r.note}
                </p>
              ))}
            </div>
          ))}
        </details>
      )}
      {runs.flatMap((other) =>
        other.taskId === run.taskId
          ? (other.qualityRejections ?? []).map((rejection) => (
              <p className="project-review-notice" key={rejection.id}>
                Acceptance rejected · {new Date(rejection.at).toLocaleString()}: {rejection.reason}
              </p>
            ))
          : [],
      )}
      {error && (
        <p className="project-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
