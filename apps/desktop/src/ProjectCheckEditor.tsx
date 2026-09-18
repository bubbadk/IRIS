import { useState } from 'react';
import { describeProjectCheck, validProjectChecks, type ProjectResultCheck } from '@iris/workflows';
import { workspaceRepository } from './persistence';

export function ProjectCheckEditor({
  checks,
  onChange,
}: {
  checks: ProjectResultCheck[];
  onChange: (checks: ProjectResultCheck[]) => void;
}) {
  const [kind, setKind] = useState<'document' | 'workspace-file'>('document');
  const [target, setTarget] = useState('');
  const [assertion, setAssertion] = useState<ProjectResultCheck['assertion']>('nonempty');
  const [expected, setExpected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function add() {
    setBusy(true);
    setError('');
    try {
      const mount = kind === 'workspace-file' ? await workspaceRepository.get() : null;
      if (kind === 'workspace-file' && !mount)
        throw new Error('Mount a folder in Workspace before adding a file check.');
      const check: ProjectResultCheck = {
        id: `check-${crypto.randomUUID()}`,
        target:
          kind === 'document'
            ? { kind, title: target.trim() }
            : { kind, rootPath: mount!.rootPath, path: target.trim() },
        assertion,
        ...(assertion === 'contains' ? { expected } : {}),
      };
      if (!validProjectChecks([...checks, check]))
        throw new Error('Choose a valid title or relative file path and up to eight checks.');
      onChange([...checks, check]);
      setTarget('');
      setExpected('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The result check could not be added.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="project-check-editor">
      <summary>
        Automatic result checks {checks.length ? `(${checks.length})` : '— optional'}
      </summary>
      <p>
        Read saved text after each final report. Failed checks allow corrections within the turn
        budget. Human review still decides completion.
      </p>
      {checks.length > 0 && (
        <ul>
          {checks.map((check, index) => (
            <li key={check.id}>
              <span>{describeProjectCheck(check)}</span>
              <button
                type="button"
                className="row-button"
                aria-label={`Remove result check ${index + 1}`}
                onClick={() => onChange(checks.filter((item) => item.id !== check.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {checks.length < 8 && (
        <fieldset disabled={busy}>
          <legend>Add a check</legend>
          <label>
            Check target
            <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
              <option value="document">IRIS document</option>
              <option value="workspace-file">Workspace text file</option>
            </select>
          </label>
          <label>
            {kind === 'document' ? 'Exact document title' : 'File path within the mounted folder'}
            <input
              value={target}
              maxLength={kind === 'document' ? 180 : 4096}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={kind === 'document' ? 'Project brief' : 'reports/summary.md'}
            />
          </label>
          <label>
            Required result
            <select
              value={assertion}
              onChange={(event) => setAssertion(event.target.value as typeof assertion)}
            >
              <option value="nonempty">Contains non-empty text</option>
              <option value="contains">Contains exact text</option>
              <option value="json">Valid JSON</option>
            </select>
          </label>
          {assertion === 'contains' && (
            <label>
              Expected text (case-sensitive)
              <textarea
                rows={2}
                maxLength={4096}
                value={expected}
                onChange={(event) => setExpected(event.target.value)}
              />
            </label>
          )}
          <button
            type="button"
            className="row-button"
            disabled={!target.trim() || (assertion === 'contains' && !expected.trim())}
            onClick={() => void add()}
          >
            Add result check
          </button>
        </fieldset>
      )}
      {error && (
        <p className="project-error" role="alert">
          {error}
        </p>
      )}
      <small>
        Document titles must be unique. File checks stay bound to the selected folder and read UTF-8
        text up to 1 MiB. Checks do not prove factual accuracy or run test commands.
      </small>
    </details>
  );
}
