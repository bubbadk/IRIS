import { useMemo, useState } from 'react';
import { diffWorkspaceText, type WorkspaceTextDiff, type WorkspaceDiffLine } from '@iris/workspaces';

export interface DiffViewerProps {
  originalText?: string;
  modifiedText?: string;
  diff?: WorkspaceTextDiff;
  title?: string;
  maxLines?: number;
  className?: string;
}

interface NumberedDiffLine {
  kind: 'context' | 'addition' | 'deletion';
  text: string;
  beforeNumber?: number;
  afterNumber?: number;
}

export function DiffViewer({
  originalText,
  modifiedText,
  diff: directDiff,
  title,
  maxLines = 500,
  className = '',
}: DiffViewerProps) {
  const [copied, setCopied] = useState(false);

  const diff = useMemo<WorkspaceTextDiff>(() => {
    if (directDiff) return directDiff;
    if (originalText !== undefined && modifiedText !== undefined) {
      return diffWorkspaceText(originalText, modifiedText, maxLines);
    }
    return { changed: false, truncated: false, lines: [] };
  }, [directDiff, originalText, modifiedText, maxLines]);

  const { numberedLines, addedCount, removedCount } = useMemo(() => {
    let before = 1;
    let after = 1;
    let added = 0;
    let removed = 0;

    const lines: NumberedDiffLine[] = diff.lines.map((line: WorkspaceDiffLine) => {
      if (line.kind === 'addition') {
        added += 1;
        const lineAfter = after;
        after += 1;
        return { ...line, afterNumber: lineAfter };
      }
      if (line.kind === 'deletion') {
        removed += 1;
        const lineBefore = before;
        before += 1;
        return { ...line, beforeNumber: lineBefore };
      }
      const lineBefore = before;
      const lineAfter = after;
      before += 1;
      after += 1;
      return { ...line, beforeNumber: lineBefore, afterNumber: lineAfter };
    });

    return { numberedLines: lines, addedCount: added, removedCount: removed };
  }, [diff]);

  const handleCopy = async () => {
    const raw = diff.lines.map((line: WorkspaceDiffLine) => line.text).join('\n');
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Best-effort clipboard copy
    }
  };

  return (
    <div className={`diff-viewer ${className}`.trim()} role="region" aria-label={title ?? 'Diff Viewer'}>
      <div className="diff-viewer-header">
        <div className="diff-viewer-title-group">
          {title ? <span className="diff-viewer-title">{title}</span> : null}
          <div className="diff-viewer-stats">
            {diff.changed ? (
              <>
                {addedCount > 0 ? (
                  <span className="diff-stat diff-stat-added">+{addedCount}</span>
                ) : null}
                {removedCount > 0 ? (
                  <span className="diff-stat diff-stat-removed">-{removedCount}</span>
                ) : null}
              </>
            ) : (
              <span className="diff-stat diff-stat-neutral">No changes</span>
            )}
          </div>
        </div>
        <button
          type="button"
          className="icon-button diff-copy-btn"
          onClick={handleCopy}
          aria-label="Copy diff"
          title="Copy diff to clipboard"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="diff-viewer-body">
        {numberedLines.length === 0 ? (
          <div className="diff-viewer-empty">Empty diff</div>
        ) : (
          <table className="diff-table">
            <tbody>
              {numberedLines.map((line, index) => (
                <tr key={index} className={`diff-line diff-line-${line.kind}`}>
                  <td className="diff-gutter diff-gutter-before">
                    {line.beforeNumber ?? ''}
                  </td>
                  <td className="diff-gutter diff-gutter-after">
                    {line.afterNumber ?? ''}
                  </td>
                  <td className="diff-marker">
                    {line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ' '}
                  </td>
                  <td className="diff-content">
                    <code>{line.text.slice(2)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {diff.truncated ? (
          <div className="diff-viewer-truncated">
            <span>… preview truncated to {maxLines} lines</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
