import { agentRuntime } from './agentRuntime';
import { resolveAgentApproval } from './agentApproval';
import { projectWorkflowRuntime } from './projectRuntime';
import { permissionRuleRepository, toolApprovalRepository } from './persistence';
import { createToolExecutor } from './tooling';
import { ProjectWorkerBusyError } from '@iris/workflows';
import {
  describeApproval,
  formatApprovalText,
  ToolApprovalStateError,
  type ToolApprovalRequest,
} from '@iris/tools';

export function parseRemoteApproval(
  text: string,
): { decision: 'approve' | 'deny'; approvalId: string } | null {
  const match = /^(approve|deny)\s+([A-Za-z0-9:_-]{1,200})$/i.exec(text.trim());
  return match
    ? { decision: match[1].toLowerCase() as 'approve' | 'deny', approvalId: match[2] }
    : null;
}

/**
 * The remote approval message. It may be short — it is read on a phone — but the operation being
 * approved is not optional: the concrete command, arguments, isolation, target or path is always
 * present, and credential-shaped values are already replaced by `describeApproval`.
 */
export function remoteApprovalMessage(approval: ToolApprovalRequest): string {
  const description = describeApproval({
    toolId: approval.toolId,
    toolName: approval.toolName,
    input: approval.input,
    agentName: approval.agentName,
  });
  return [
    `Approval ${approval.id} is waiting.`,
    formatApprovalText(description),
    `Reply "approve ${approval.id}" or "deny ${approval.id}" to decide.`,
  ].join('\n');
}

const ALREADY_RESOLVED = 'That approval is unavailable or already resolved.';

/**
 * The truthful message for a failure that happened while resolving an existing, still-pending
 * approval. The durable record decides what is true, not the message that happened to be thrown:
 * if it is terminal now, the settlement succeeded even though this call failed; if it is still
 * pending, nothing was settled and the remote user must be told that plainly instead of receiving
 * a channel failure.
 */
async function describeUnsettledFailure(approvalId: string): Promise<string> {
  const current = await toolApprovalRepository.get(approvalId);
  if (current && current.status !== 'pending') return ALREADY_RESOLVED;
  return 'The approval could not be resolved by this IRIS runtime, so nothing was settled. The approval is still pending; reply again once the owning process is free.';
}

/** Resolves only an existing persisted approval; messages never create work or bypass policy. */
export async function resolveRemoteApproval(text: string): Promise<string | null> {
  const request = parseRemoteApproval(text);
  if (!request) return null;
  const approval = await toolApprovalRepository.get(request.approvalId);
  if (!approval || approval.status !== 'pending') return ALREADY_RESOLVED;
  // The decision is reported back with the same description the prompt carried, so the message
  // confirms the exact operation that was approved or denied.
  const operation = formatApprovalText(
    describeApproval({
      toolId: approval.toolId,
      toolName: approval.toolName,
      input: approval.input,
      agentName: approval.agentName,
    }),
  );
  try {
    const agent = await agentRuntime.suspendedForApproval(approval.id);
    if (agent) {
      // Every surface resolves an agent approval through the same path, so a scheduled run whose turn
      // owns the approval is completed too — no matter where the decision came from.
      const resolution = await resolveAgentApproval(approval.id, request.decision);
      return resolution.scheduledRun
        ? `Approval ${request.decision}d for the active agent turn; scheduled run is now ${resolution.scheduledRun.status}.\n${operation}`
        : `Approval ${request.decision}d for the active agent turn.\n${operation}`;
    }
    const project = await projectWorkflowRuntime.suspendedForApproval(approval.id);
    if (project) {
      try {
        await projectWorkflowRuntime.resolveApproval(approval.id, request.decision);
        return `Approval ${request.decision}d for the project worker.\n${operation}`;
      } catch (error) {
        // A live foreign process owns the agent's execution lease, so the resume was refused. The
        // approval is untouched and still pending: that must read as a deferral, never as a failure
        // and never as a successful approval.
        if (error instanceof ProjectWorkerBusyError)
          return `The approval was not applied: another IRIS process is currently executing this agent, so the work was deferred and the approval is still pending.\n${operation}`;
        throw error;
      }
    }
    const result = await createToolExecutor(await permissionRuleRepository.list()).resolve(
      approval.id,
      request.decision,
    );
    return result.status === 'completed'
      ? `Approval ${request.decision}d and the tool invocation completed.\n${operation}`
      : `Approval ${request.decision}d. The tool did not run.\n${operation}`;
  } catch (error) {
    // A duplicate channel delivery loses the durable compareAndSet race. That loser must be
    // answered truthfully as already-resolved — not thrown at the polling loop as a failure.
    if (error instanceof ToolApprovalStateError) return ALREADY_RESOLVED;
    return describeUnsettledFailure(approval.id);
  }
}
