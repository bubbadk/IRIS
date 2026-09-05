import { type CortexTurnRecord, type CortexTurnStep } from '@iris/cortex';
import { useState } from 'react';
import { shortToolLabel, ToolRequestView } from './ChatContent';

export function describeCortexTurn(turn: CortexTurnRecord): string {
  if (turn.status === 'running') return 'Provider execution is currently in progress.';
  if (turn.status === 'completed') {
    return 'The assistant response completed and was saved to the conversation.';
  }
  if (turn.status === 'failed') return `The turn failed: ${turn.failure.message}`;
  return `${turn.suspension.toolName} is paused for explicit approval. ${turn.suspension.reason}`;
}

/** Wall time between a step's request and its last recorded update. Empty when either timestamp
 * is missing or malformed — never a guessed duration. */
function formatStepDuration(step: CortexTurnStep): string {
  const started = new Date(step.startedAt).getTime();
  const updated = new Date(step.updatedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(updated) || updated < started) return '';
  const ms = updated - started;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function describeTurnStepStatus(step: CortexTurnStep): string {
  if (step.status === 'running') return 'Running';
  if (step.status === 'awaiting-approval') return 'Awaiting approval';
  if (step.status === 'completed') return 'Completed';
  if (step.status === 'denied') return 'Denied';
  return 'Failed';
}

function describeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2) ?? String(output);
  } catch {
    return String(output);
  }
}

export function TurnStepRow({ step }: { step: CortexTurnStep }) {
  const [expanded, setExpanded] = useState(false);
  const duration = formatStepDuration(step);
  return (
    <article className={`turn-step turn-step-${step.status}`}>
      <button
        type="button"
        className="turn-step-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="turn-step-name">{shortToolLabel({ name: step.toolName })}</span>
        <span className="turn-step-status">{describeTurnStepStatus(step)}</span>
        {duration && <span className="turn-step-duration">{duration}</span>}
      </button>
      {expanded && (
        <div className="turn-step-detail">
          <div>
            <span>Request</span>
            <ToolRequestView input={step.input} output={step.output} />
          </div>
          {step.status === 'completed' && step.toolName !== 'cortex_delegate_subagent' && (
            <p>
              <span>Result</span>
              <pre>{describeToolOutput(step.output)}</pre>
            </p>
          )}
          {(step.status === 'denied' || step.status === 'failed') && step.reason && (
            <p>
              <span>{step.status === 'denied' ? 'Denied' : 'Failed'}</span>
              <pre>{step.reason}</pre>
            </p>
          )}
        </div>
      )}
    </article>
  );
}
