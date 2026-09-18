import { ProjectQualityReview } from './ProjectQualityReview';
import { useState } from 'react';
import { describeProjectCheck, type ProjectTaskRun } from '@iris/workflows';
import { projectWorkflowRuntime } from './projectRuntime';

/** Both project surfaces use the same explicit result-review controls. */
export function ProjectRunReview({
  run,
  canAct = true,
}: {
  run: ProjectTaskRun;
  canAct?: boolean;
}) {
  const [note, setNote] = useState('');
  const [instructions, setInstructions] = useState('');
  const [criteriaReviewed, setCriteriaReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reviewable = run.status === 'awaiting-review';
  const continuable = ['awaiting-review', 'needs-attention', 'failed', 'cancelled'].includes(
    run.status,
  );

  async function act(action: 'verify' | 'continue' | 'pause' | 'resume' | 'cancel') {
    if (action !== 'pause') setBusy(true);
    setError('');
    try {
      if (action === 'verify') await projectWorkflowRuntime.verifyRun(run.id, note, run);
      else if (action === 'pause') await projectWorkflowRuntime.requestPause(run.id);
      else if (action === 'cancel') await projectWorkflowRuntime.cancel(run.id);
      else if (action === 'resume') {
        const resumed = await projectWorkflowRuntime.resumeRun(run.id);
        if (resumed.status === 'failed')
          setError(resumed.failure ?? 'The worker could not resume.');
      } else {
        const next = await projectWorkflowRuntime.continueRun(run.id, instructions);
        if (next.status === 'failed') setError(next.failure ?? 'The worker could not continue.');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The result could not be updated.');
    } finally {
      if (action !== 'pause') setBusy(false);
    }
  }

  return (
    <section className="project-run-review" aria-label="Worker result review">
      {run.turnLimit && (
        <small>
          Agent turns: {run.turnsUsed ?? 0} / {run.turnLimit}
        </small>
      )}
      {run.deadlineAt && (
        <small>
          Wall-clock deadline: {new Date(run.deadlineAt).toLocaleString()}
          {run.status === 'failed' ? ' — expired runs require inspection.' : ''}
        </small>
      )}
      {['queued', 'running', 'suspended'].includes(run.status) && (
        <button
          type="button"
          className="row-button"
          disabled={run.pauseRequested}
          onClick={() => void act('pause')}
        >
          {run.pauseRequested ? 'Pause requested — finishing this turn' : 'Pause after this turn'}
        </button>
      )}
      {run.status === 'paused' && (
        <div className="project-review-notice">
          <strong>Paused at a safe checkpoint</strong>
          <p>
            Recorded tool results are saved. Resume uses the remaining turn budget and the original
            model.
          </p>
          {canAct && (
            <button
              type="button"
              className="soft-button primary-button"
              disabled={busy}
              onClick={() => void act('resume')}
            >
              Resume remaining turns
            </button>
          )}
          {canAct && (
            <button
              type="button"
              className="row-button"
              disabled={busy}
              onClick={() => void act('cancel')}
            >
              Stop paused run
            </button>
          )}
        </div>
      )}
      {run.acceptanceCriteria && (
        <div>
          <strong>Acceptance criteria</strong>
          <p>{run.acceptanceCriteria}</p>
        </div>
      )}
      {!!run.resultChecks?.length && (
        <div className="project-check-results">
          <strong>Automatic result checks</strong>
          <p>
            Read-only snapshots of saved deliverables. Verification reads them again and requires
            unchanged revision or file-hash evidence. Inspect the actual content before completing
            the task; these checks do not establish overall quality.
          </p>
          {!run.checkReports?.length && <p>No checks have run yet.</p>}
          {run.checkReports?.map((report, index) => (
            <details key={report.runtimeTurnId} open={index === run.checkReports!.length - 1}>
              <summary>
                Check round {index + 1} ·{' '}
                {report.results.filter((result) => result.status === 'passed').length} /{' '}
                {report.results.length} passed · {new Date(report.checkedAt).toLocaleString()}
              </summary>
              <ul>
                {report.results.map((result) => {
                  const check = run.resultChecks!.find((item) => item.id === result.checkId);
                  return (
                    <li key={result.checkId}>
                      <strong>
                        {result.status === 'passed'
                          ? 'Passed'
                          : result.status === 'failed'
                            ? 'Failed'
                            : 'Could not check'}
                      </strong>
                      <p>{check ? describeProjectCheck(check) : result.checkId}</p>
                      <p>{result.message}</p>
                      {result.evidence && <small>{result.evidence}</small>}
                    </li>
                  );
                })}
              </ul>
            </details>
          ))}
        </div>
      )}
      {run.output && (
        <div>
          <strong>Last saved worker report</strong>
          <p>{run.output}</p>
        </div>
      )}
      {run.previousRunId && <small>Continued from a saved run report.</small>}
      {run.status === 'needs-attention' && (
        <p className="project-review-notice">
          {run.stopReason === 'check-error'
            ? 'A result check could not run. Resolve the reported problem before continuing; the task remains unfinished.'
            : run.stopReason === 'check-failed'
              ? 'Result checks still fail and no automatic correction turns remain. The task remains unfinished.'
              : 'The worker reached its execution limit. Its report is saved; the task remains unfinished.'}
        </p>
      )}
      {reviewable && (
        <p className="project-review-notice">
          {run.resultChecks?.length
            ? 'The configured checks passed. They do not prove overall quality or factual accuracy. Review the deliverable before completing this task.'
            : 'The worker has returned a report. IRIS has not independently verified it. Check the result before completing this task.'}
        </p>
      )}
      {run.verification && (
        <div className="project-review-notice">
          <strong>Verified by you</strong>
          <p>{run.verification.note}</p>
          {run.verification.checkReport && (
            <p>
              Deliverables rechecked at{' '}
              {new Date(run.verification.checkReport.checkedAt).toLocaleString()}. All configured
              checks passed with unchanged evidence.
            </p>
          )}
        </div>
      )}
      <ProjectQualityReview run={run} canAct={canAct} />
      {reviewable && canAct && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act('verify');
          }}
        >
          <label>
            What did you verify?
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder="Record the checks and evidence you reviewed."
              disabled={busy}
            />
          </label>
          {run.acceptanceCriteria && (
            <label>
              <input
                type="checkbox"
                checked={criteriaReviewed}
                disabled={busy}
                onChange={(event) => setCriteriaReviewed(event.target.checked)}
              />{' '}
              I reviewed the acceptance criteria above against the saved deliverable.
            </label>
          )}
          <button
            className="soft-button primary-button"
            disabled={
              busy || !note.trim() || (Boolean(run.acceptanceCriteria) && !criteriaReviewed)
            }
          >
            Verify & complete task
          </button>
        </form>
      )}
      {continuable && canAct && (
        <details>
          <summary>Continue task</summary>
          <p>
            Starts a new run with a fresh turn budget, the saved report and available tool history.
            After an interrupted action, the worker must inspect current state before continuing.
            Existing permissions still apply.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void act('continue');
            }}
          >
            <label>
              Next instructions <span>optional</span>
              <textarea
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                rows={2}
                placeholder="Explain what remains or what should change."
                disabled={busy}
              />
            </label>
            <button className="row-button" disabled={busy}>
              {busy ? 'Working…' : 'Continue from report'}
            </button>
          </form>
        </details>
      )}
      {error && (
        <p className="project-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
