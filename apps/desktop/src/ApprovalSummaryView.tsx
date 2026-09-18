import { useEffect, useState } from 'react';
import {
  describeApproval,
  formatApprovalText,
  type ApprovalDescription,
  type ToolRisk,
} from '@iris/tools';
import { toolApprovalRepository } from './persistence';

/**
 * The single approval renderer.
 *
 * Chat, the permissions window, the schedules view and the project stream all mount this component,
 * so the same invocation is described identically wherever a human is asked to approve it — and
 * always with the concrete command, arguments, isolation, path or target on screen. Credentials are
 * replaced before rendering by `describeApproval`; the raw values never reach the DOM, a transcript
 * or a log.
 */
export interface ApprovalSummaryViewProps {
  toolId: string;
  toolName: string;
  risk?: ToolRisk;
  input: unknown;
  agentName?: string;
  /** Compact form for tight surfaces such as the activity feed. */
  compact?: boolean;
}

function DescriptionLines({ description }: { description: ApprovalDescription }) {
  return (
    <>
      <p className="approval-summary-headline">{description.headline}</p>
      <ul className="approval-summary-details">
        {description.details.map((line, index) => (
          <li key={`${index}-${line}`}>{line}</li>
        ))}
      </ul>
      <details className="approval-summary-raw">
        <summary>
          Full approved arguments{description.redacted ? ' (credentials redacted)' : ''}
        </summary>
        <pre>{JSON.stringify(description.redactedInput, null, 2)}</pre>
      </details>
    </>
  );
}

export function ApprovalSummaryView({
  toolId,
  toolName,
  risk,
  input,
  agentName,
  compact,
}: ApprovalSummaryViewProps) {
  const description = describeApproval({ toolId, toolName, risk, input, agentName });
  if (compact) {
    return (
      <div className="approval-summary approval-summary-compact">
        <pre>{formatApprovalText(description)}</pre>
      </div>
    );
  }
  return (
    <div className="approval-summary">
      <DescriptionLines description={description} />
    </div>
  );
}

/** Renders a stored approval record's own immutable input, not a later copy of the call. */
export function ApprovalRecordSummary({
  approval,
  risk,
  compact,
}: {
  approval: { toolId: string; toolName: string; agentName?: string; input: unknown };
  risk?: ToolRisk;
  compact?: boolean;
}) {
  return (
    <ApprovalSummaryView
      toolId={approval.toolId}
      toolName={approval.toolName}
      agentName={approval.agentName}
      risk={risk}
      input={approval.input}
      {...(compact ? { compact } : {})}
    />
  );
}

/**
 * Resolves an approval by id for surfaces that only carry `approvalId` (a suspended scheduled run,
 * a suspended project worker). It reads the same persisted record the executor will run, so the
 * description cannot drift from the approved invocation.
 */
export function ApprovalSummaryById({ approvalId }: { approvalId: string }) {
  const [approval, setApproval] = useState<{
    toolId: string;
    toolName: string;
    agentName?: string;
    input: unknown;
  } | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let active = true;
    toolApprovalRepository
      .get(approvalId)
      .then((record) => {
        if (!active) return;
        if (!record) {
          setMissing(true);
          setApproval(null);
          return;
        }
        setMissing(false);
        setApproval({
          toolId: record.toolId,
          toolName: record.toolName,
          agentName: record.agentName,
          input: record.input,
        });
      })
      .catch(() => {
        if (active) setMissing(true);
      });
    return () => {
      active = false;
    };
  }, [approvalId]);

  if (missing)
    return <span className="approval-summary-missing">Approval {approvalId} is not available.</span>;
  if (!approval) return <span className="approval-summary-missing">Loading approval…</span>;
  return <ApprovalRecordSummary approval={approval} />;
}
