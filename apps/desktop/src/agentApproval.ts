import type {
  AgentEvent,
  AgentRuntimeCoordinator,
  SuspendedAgentTurn,
} from '@iris/agents';
import { suspendedApprovals } from '@iris/agents';
import type { ModelImage } from '@iris/providers';
import type { ScheduledRun, ScheduledRunRepository, ScheduledRunReconciliation } from '@iris/workflows';
import { agentRuntime } from './agentRuntime';
import { scheduledRunRepository } from './persistence';
import { scheduleDispatcher } from './scheduledRuntime';

/**
 * The typed outcome of resolving one approval, whatever surface resolved it.
 *
 * `suspended` means the chain stopped again on another pending approval — an approval being resolved
 * is not the same as the turn being finished. `output` is the final text of the turn that owns the
 * approval, and `scheduledRun` is the run whose lifecycle was updated as a result, when the approval
 * belonged to one.
 */
export interface AgentApprovalResolution {
  approvalId: string;
  decision: 'approve' | 'deny';
  /** The agent that owned the decision, when the runtime still knows it. */
  agentId: string | null;
  events: AgentEvent[];
  output: string | null;
  /** True while the turn (or a descendant of it) is still waiting for an approval. */
  suspended: boolean;
  scheduledRun: ScheduledRun | null;
}

export interface AgentApprovalDeps {
  runtime: Pick<
    AgentRuntimeCoordinator,
    'resolveApproval' | 'suspendedForAgent' | 'suspendedForApproval'
  >;
  runs: Pick<ScheduledRunRepository, 'list'>;
  /** Records an observed outcome on the owning run without resuming it a second time. */
  settle(runId: string, resolution: ScheduledRunReconciliation): Promise<ScheduledRun>;
}

/** The suspended run an approval belongs to, correlated by the approval id it persisted. */
async function scheduledRunForApproval(
  runs: Pick<ScheduledRunRepository, 'list'>,
  approvalId: string,
): Promise<ScheduledRun | null> {
  return (
    (await runs.list()).find(
      (run) => run.status === 'suspended' && run.approvalId === approvalId,
    ) ?? null
  );
}

/**
 * Resolves approvals through one central path, independent of the surface that produced the click.
 *
 * The agent chain is always resumed through the runtime, so a nested approval resumes the whole
 * chain from the deepest owner upward. The scheduled run — when the approval belonged to one — is
 * then completed from the same typed outcome, so which window resolved the approval cannot change
 * the run's lifecycle, and resolving it twice cannot resume the agent twice.
 */
export function createAgentApprovalBridge(deps: AgentApprovalDeps) {
  async function resolve(
    approvalId: string,
    decision: 'approve' | 'deny',
    signal?: AbortSignal,
  ): Promise<AgentApprovalResolution> {
    const owner: SuspendedAgentTurn | null = await deps.runtime.suspendedForApproval(approvalId);
    const events: AgentEvent[] = [];
    for await (const event of deps.runtime.resolveApproval(approvalId, decision, signal)) {
      events.push(event);
    }
    const terminal = [...events]
      .reverse()
      .find((event) => event.type === 'assistant-complete');
    const output = terminal?.message.content ?? null;

    const ownerTurn = owner ? await deps.runtime.suspendedForAgent(owner.agentId) : null;
    const run = await scheduledRunForApproval(deps.runs, approvalId);
    // A scheduled run is finished only when *its* agent turn is finished. When that turn stopped
    // again on a different pending approval, the run is re-correlated with that approval instead of
    // being settled, so the next decision still finds it by exact id.
    const runTurn = run ? await deps.runtime.suspendedForAgent(run.agentId) : null;
    const nextApprovalId = runTurn ? suspendedApprovals(runTurn)[0]?.approvalId : undefined;

    let scheduledRun = run;
    if (run) {
      const resolution: ScheduledRunReconciliation = runTurn
        ? { status: 'suspended', ...(nextApprovalId ? { approvalId: nextApprovalId } : {}) }
        : output !== null
          ? { status: 'completed', output }
          : {
              status: 'failed',
              failure: `Approval ${approvalId} was resolved, but the scheduled turn recorded no final outcome.`,
            };
      scheduledRun = await deps.settle(run.id, resolution);
    }

    return {
      approvalId,
      decision,
      agentId: owner?.agentId ?? null,
      events,
      output,
      suspended: ownerTurn !== null || runTurn !== null,
      scheduledRun,
    };
  }

  /** The same resolution as an event stream, for surfaces that render the resumed turn. */
  async function* stream(
    approvalId: string,
    decision: 'approve' | 'deny',
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const resolution = await resolve(approvalId, decision, signal);
    yield* resolution.events;
  }

  return { resolve, stream };
}

export const agentApprovalBridge = createAgentApprovalBridge({
  runtime: agentRuntime,
  runs: scheduledRunRepository,
  settle: (runId, resolution) => scheduleDispatcher.settleSuspended(runId, resolution),
});

/** Resolves one approval through the central path; used by every approval surface. */
export function resolveAgentApproval(
  approvalId: string,
  decision: 'approve' | 'deny',
  signal?: AbortSignal,
): Promise<AgentApprovalResolution> {
  return agentApprovalBridge.resolve(approvalId, decision, signal);
}

/**
 * The chat window's runtime. It is the coordinator with one change: approvals go through the central
 * path, so a decision made in a chat window updates the scheduled run the approval belongs to.
 */
export const chatAgentRuntime: Pick<
  AgentRuntimeCoordinator,
  | 'send'
  | 'resolveApproval'
  | 'suspendedForAgent'
  | 'clearConversation'
  | 'cancelSuspended'
  | 'runningAgentIds'
> = {
  get runningAgentIds() {
    return agentRuntime.runningAgentIds;
  },
  send: (agentId: string, text: string, signal?: AbortSignal, images?: ModelImage[]) =>
    agentRuntime.send(agentId, text, signal, images),
  suspendedForAgent: (agentId) => agentRuntime.suspendedForAgent(agentId),
  clearConversation: (agentId) => agentRuntime.clearConversation(agentId),
  cancelSuspended: (agentId) => agentRuntime.cancelSuspended(agentId),
  resolveApproval: (approvalId, decision, signal) =>
    agentApprovalBridge.stream(approvalId, decision, signal),
};
