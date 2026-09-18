import type {
  ScheduleRunner,
  ScheduledRun,
  ScheduledRunReconciliation,
  ProjectWorkerReservation,
} from '@iris/workflows';
import type {
  AgentProviderResolver,
  AgentRepository,
  AgentRuntimeCoordinator,
  ConversationRepository,
} from '@iris/agents';
import type { ToolApprovalRepository } from '@iris/tools';
import { scheduledAgentEvents } from './agentRuntime';

/**
 * The scheduled-run runner: it translates one scheduled occurrence into agent-runtime events and,
 * crucially, can report what really happened to a run that is recorded as suspended — without
 * running anything.
 *
 * Written against injected ports so the exact orchestration the app uses can be exercised with a
 * fake model instead of a fake lifecycle.
 */
export interface ScheduledRunnerDeps {
  runtime: Pick<
    AgentRuntimeCoordinator,
    'send' | 'resolveApproval' | 'suspendedForAgent' | 'suspendedForApproval' | 'runningAgentIds'
  >;
  agents: Pick<AgentRepository, 'get'>;
  providers: AgentProviderResolver;
  approvals: Pick<ToolApprovalRepository, 'get'>;
  conversations: Pick<ConversationRepository, 'list'>;
  /** The shared cross-runtime exclusive-execution reservation, when the host has one. */
  reservations?: ProjectWorkerReservation;
}

/**
 * The production scheduled-run runner, written against injected ports so the exact orchestration the
 * app uses can be exercised with a fake model instead of a fake lifecycle.
 */
export function createScheduledRunner(deps: ScheduledRunnerDeps): ScheduleRunner {
  return {
    async available(agentId) {
      // §6, §12 — scheduled execution must see the same exclusive agent as every other runtime, not
      // only its own coordinator's busy set. A project worker (or a project approval suspension)
      // that owns the agent blocks this run just as a scheduled turn would. Phase 2H.1: an agent
      // executing in another live IRIS process defers this occurrence instead of failing it.
      if (deps.reservations?.holder(agentId)) return false;
      if (
        deps.reservations?.crossProcess &&
        (await deps.reservations.crossProcess.inspect(agentId))
      )
        return false;
      return (
        !deps.runtime.runningAgentIds.includes(agentId) &&
        !(await deps.runtime.suspendedForAgent(agentId))
      );
    },
    async prepare({ schedule }) {
      const agent = await deps.agents.get(schedule.agentId);
      if (!agent) throw new Error('The scheduled agent is unavailable.');
      await deps.providers.resolve(agent);
    },
    run(input) {
      return scheduledAgentEvents(deps.runtime.send(input.run.agentId, input.run.prompt));
    },
    resume(input, approvalId, decision) {
      if (input.run.approvalId !== approvalId)
        throw new Error('The scheduled approval does not match its persisted run.');
      return scheduledAgentEvents(deps.runtime.resolveApproval(approvalId, decision));
    },
    /**
     * Reports what really happened to a suspended run without running anything.
     *
     * A run stays suspended only while the approval it recorded is still pending AND the agent that
     * owns it is still waiting for that decision. Anything else means the approval was already
     * resolved — on whichever surface — or the turn can never be resumed again, so the run is
     * settled from the exact turn it started. When that turn recorded no final message the outcome
     * is reported as unknown; it is never invented as a success.
     */
    async reconcileSuspended(run): Promise<ScheduledRunReconciliation> {
      if (run.approvalId) {
        const [approval, owner, agentTurn] = await Promise.all([
          deps.approvals.get(run.approvalId),
          deps.runtime.suspendedForApproval(run.approvalId),
          deps.runtime.suspendedForAgent(run.agentId),
        ]);
        if (approval?.status === 'pending' && owner && agentTurn) return { status: 'suspended' };
      }
      const output = await recordedTurnOutput(deps.conversations, run);
      if (output !== null) return { status: 'completed', output };
      return {
        status: 'failed',
        failure: run.turnId
          ? 'The approval for this run was no longer pending, and the recorded turn produced no final outcome. Inspect what happened before creating new work.'
          : 'This suspended run has no recorded agent turn, so its outcome cannot be recovered. It is not retried automatically.',
      };
    },
  };
}

/** The final assistant text of exactly the turn this run started, or `null` when there is none. */
async function recordedTurnOutput(
  conversations: Pick<ConversationRepository, 'list'>,
  run: ScheduledRun,
): Promise<string | null> {
  if (!run.turnId) return null;
  const messages = await conversations.list(run.agentId);
  const match = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' &&
        message.turnId === run.turnId &&
        message.content.trim().length > 0,
    );
  return match?.content ?? null;
}
