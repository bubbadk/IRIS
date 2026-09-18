import { projectResultChecker } from './projectResultChecks';
import { projectCheckpointRepository } from './projectCheckpoints';
import { AgentRuntimeCoordinator, type AgentEvent } from '@iris/agents';
import type { AgentDefinition } from '@iris/core';
import {
  ProjectWorkflowRuntime,
  describeProjectCheck,
  type ProjectTaskRun,
  type ProjectWorkerEvent,
  type ProjectWorkerExecutionInput,
  type ProjectWorkerExecutor,
  type ProjectWorkerRecovery,
} from '@iris/workflows';
import { projectAgentContextBuilder } from './memory';
import { projectKnowledgeContext } from './knowledgeContext';
import {
  agentRepository,
  projectGraphRepository,
  projectRunCommitter,
  projectTaskRunRepository,
  projectWorkerContextPackRepository,
  projectWorkerConversationRepository,
  projectWorkerCortexTurnRepository,
  projectWorkerCortexTurnStepRepository,
  projectWorkerSuspendedTurnRepository,
} from './persistence';
import { providerResolver } from './agentRuntime';
import { agentToolRuntime } from './tooling';
import { agentWorkspaceContext } from './workspace';
import { agentExecutionLeases, projectWorkerReservations } from './agentExecution';

type ProjectRuntimeListener = (projectId: string) => void;

const listeners = new Set<ProjectRuntimeListener>();

const agentListeners = new Set<() => void>();
export function subscribeProjectAgentRuntime(listener: () => void): () => void {
  agentListeners.add(listener);
  return () => {
    agentListeners.delete(listener);
  };
}

export const projectAgentRuntime = new AgentRuntimeCoordinator(
  agentRepository,
  projectWorkerConversationRepository,
  projectWorkerSuspendedTurnRepository,
  providerResolver,
  agentToolRuntime,
  () => agentListeners.forEach((listener) => listener()),
  projectAgentContextBuilder,
  projectWorkerContextPackRepository,
  projectWorkerCortexTurnRepository,
  undefined,
  agentWorkspaceContext,
  undefined,
  projectWorkerCortexTurnStepRepository,
  undefined,
  {
    leases: agentExecutionLeases,
    ownerKind: 'project',
    ownerId: (agentId: string) => `project-runtime:${agentId}`,
    // A project worker turn runs *inside* a run that already owns the agent's exclusive
    // reservation (taken by the queue dispatcher before preparation, or by `launch` directly), so
    // the coordinator must not try to acquire it again from its own owner.
    reserveTurns: false,
  },
);

export function projectWorkerPrompt({
  project,
  task,
  run,
  previousRun,
}: ProjectWorkerExecutionInput): string {
  const detail = task.description ? `\nTask completion detail:\n${task.description}` : '';
  return [
    'You are a temporary IRIS project worker. Work only on the assigned task below.',
    'Use only your configured tools and obey every permission decision.',
    'Do not claim actions or results that you did not actually perform.',
    'When finished, report what you changed, what you actually checked, and what remains unfinished. Your report goes to human review; do not mark the project task complete yourself.',
    `Acceptance criteria:\n${task.acceptanceCriteria || 'No explicit criteria provided. Explain what you checked against the task instructions.'}`,
    ...(run.resultChecks?.length
      ? [
          'IRIS will read the actual saved deliverables after you return. These read-only checks do not execute commands. Correct any failed checks using your assigned tools and existing permissions.',
          ...run.resultChecks.map((check) => `[${check.id}] ${describeProjectCheck(check)}`),
          ...((run.checkReports?.at(-1) ?? previousRun?.checkReports?.at(-1))?.results.map(
            (result) =>
              `Last check [${result.checkId}]: ${result.status}. ${result.message}${result.evidence ? ` Evidence: ${result.evidence}` : ''}`,
          ) ?? []),
        ]
      : []),
    ...(previousRun
      ? [
          'Continue from the saved report below. This is a new turn, not a replay of previous tools. Inspect current state before acting. Do not repeat external actions whose outcome is unknown. Ask for help when the report is insufficient.',
          `Previous run status: ${previousRun.status}`,
          `Previous report:\n${previousRun.output || 'No final report was saved.'}`,
          ...(previousRun.failure ? [`Previous failure: ${previousRun.failure}`] : []),
          ...(run.continuation ? [`User continuation instructions:\n${run.continuation}`] : []),
        ]
      : []),
    `Project: ${project.title} (id: ${project.id})`,
    `Project objective:\n${project.objective}`,
    `Assigned task:\n${task.title}${detail}`,
  ].join('\n\n');
}

export async function currentProjectWorkerPrompt(
  input: ProjectWorkerExecutionInput,
): Promise<string> {
  const agent = await agentRepository.get(input.run.agentId);
  if (!agent) throw new Error('The project agent is unavailable.');
  return [projectWorkerPrompt(input), await projectKnowledgeContext(agent, input.project.id)].join(
    '\n\n',
  );
}

export async function* mapAgentWorkerEvents(
  events: AsyncIterable<AgentEvent>,
  initialTurnId?: string,
): AsyncGenerator<ProjectWorkerEvent> {
  let runtimeTurnId = initialTurnId;
  let announcedTurnId = Boolean(initialTurnId);
  for await (const event of events) {
    if (event.type === 'context-pack-ready') runtimeTurnId = event.pack.turnId;
    if (event.type === 'user-message') runtimeTurnId = event.message.turnId;
    if (runtimeTurnId && !announcedTurnId) {
      announcedTurnId = true;
      yield { type: 'started', runtimeTurnId };
    }
    if (event.type === 'tool-approval-required') {
      if (!runtimeTurnId) throw new Error('Project worker approval has no runtime turn identity.');
      yield {
        type: 'approval-required',
        runtimeTurnId,
        approval: { ...event.approval },
      };
    }
    if (event.type === 'assistant-complete') {
      const completedTurnId = event.message.turnId ?? runtimeTurnId;
      if (!completedTurnId)
        throw new Error('Project worker completion has no runtime turn identity.');
      yield {
        type: 'returned',
        runtimeTurnId: completedTurnId,
        stopReason: event.message.stopReason,
        output: event.message.content,
      };
    }
  }
}

async function* checkpointWorkerEvents(
  runId: string,
  agentId: string,
  events: AsyncIterable<AgentEvent>,
  turnId?: string,
): AsyncGenerator<ProjectWorkerEvent> {
  for await (const event of mapAgentWorkerEvents(events, turnId)) {
    if (event.type === 'returned') {
      await projectCheckpointRepository.save(
        runId,
        projectAgentRuntime.checkpointForAgent(agentId),
      );
    }
    yield event;
  }
}

async function cleanupWorker(agentId: string): Promise<void> {
  projectAgentRuntime.refreshConfiguration(agentId);
  await projectWorkerConversationRepository.clear(agentId);
}

async function requireConfiguredAgent(agentId: string): Promise<AgentDefinition> {
  const agent = await agentRepository.get(agentId);
  if (!agent) throw new Error('Choose an existing agent before launching this task.');
  if (await projectAgentRuntime.suspendedForAgent(agentId)) {
    throw new Error('Resolve this agent’s suspended project worker before starting another task.');
  }
  await providerResolver.resolve(agent);
  return agent;
}

/** Queue admission only checks present local configuration; execution still performs full setup. */
export async function isProjectAgentAvailable(agentId: string): Promise<boolean> {
  if (projectAgentRuntime.runningAgentIds.includes(agentId)) return false;
  if (await projectAgentRuntime.suspendedForAgent(agentId)) return false;
  const agent = await agentRepository.get(agentId);
  if (!agent) return false;
  try {
    await providerResolver.resolve(agent);
    return true;
  } catch {
    return false;
  }
}

const projectWorkerExecutor: ProjectWorkerExecutor = {
  async prepare(agentId) {
    const agent = await requireConfiguredAgent(agentId);
    return { agentName: agent.name };
  },

  async *execute(input, signal) {
    const checkpoint = input.previousRun
      ? await projectCheckpointRepository.get(input.previousRun.id)
      : null;
    if (checkpoint) await projectAgentRuntime.restoreCheckpoint(input.run.agentId, checkpoint);
    else await cleanupWorker(input.run.agentId);
    yield* checkpointWorkerEvents(
      input.run.id,
      input.run.agentId,
      projectAgentRuntime.send(input.run.agentId, await currentProjectWorkerPrompt(input), signal),
    );
  },

  async *resume(input, approvalId, decision, signal) {
    yield* checkpointWorkerEvents(
      input.run.id,
      input.run.agentId,
      projectAgentRuntime.resolveApproval(approvalId, decision, signal),
      input.run.runtimeTurnId,
    );
  },

  async *continue(input, signal) {
    const checkpoint = await projectCheckpointRepository.get(input.run.id);
    if (!checkpoint || checkpoint.turnId !== input.run.runtimeTurnId)
      throw new Error(
        'The safe checkpoint for this run is unavailable. Continue manually from its saved report after inspecting current state.',
      );
    await projectAgentRuntime.restoreCheckpoint(input.run.agentId, checkpoint);
    yield* checkpointWorkerEvents(
      input.run.id,
      input.run.agentId,
      projectAgentRuntime.send(
        input.run.agentId,
        [
          await currentProjectWorkerPrompt(input),
          'Continue the unfinished work using the recorded tool results. Do not repeat completed actions. Finish the task if possible, then report evidence and remaining limitations.',
          `This is turn ${(input.run.turnsUsed ?? 0) + 1} of ${input.run.turnLimit ?? 1}.`,
        ].join('\n\n'),
        signal,
      ),
    );
  },

  async cancel(run) {
    await projectAgentRuntime.cancelSuspended(run.agentId);
  },

  recover: recoverProjectWorker,
};

export async function recoverProjectWorker(run: ProjectTaskRun): Promise<ProjectWorkerRecovery> {
  if (!run.runtimeTurnId) {
    return { status: 'failed', failure: 'IRIS stopped before this worker turn started.' };
  }
  const records = await projectAgentRuntime.cortexTurnsForAgent(run.agentId);
  const record = await projectWorkerCortexTurnRepository.get(run.runtimeTurnId);
  if (!record) {
    return {
      status: 'failed',
      runtimeTurnId: run.runtimeTurnId,
      failure: 'The persisted Cortex record for this worker turn is unavailable.',
    };
  }
  if (
    records.some((other) => other.turnId !== record.turnId && other.startedAt > record.startedAt)
  ) {
    return {
      status: 'failed',
      runtimeTurnId: run.runtimeTurnId,
      failure:
        'A later worker turn exists without matching project progress. Its outcome may be unknown. Inspect current state before continuing manually.',
    };
  }
  if (record.status === 'suspended') {
    return {
      status: 'suspended',
      runtimeTurnId: record.turnId,
      approval: {
        id: record.suspension.approvalId,
        toolId: record.suspension.toolId,
        toolName: record.suspension.toolName,
        reason: record.suspension.reason,
      },
    };
  }
  if (record.status === 'failed') {
    return {
      status: 'failed',
      runtimeTurnId: record.turnId,
      failure: record.failure.message,
    };
  }
  if (record.status === 'completed') {
    const conversation = await projectWorkerConversationRepository.list(run.agentId);
    const message = conversation
      .filter((message) => message.role === 'assistant' && message.turnId === run.runtimeTurnId)
      .at(-1);
    const checkpoint = await projectCheckpointRepository.get(run.id);
    if (
      !message ||
      (conversation.at(-1)?.turnId && conversation.at(-1)?.turnId !== record.turnId)
    ) {
      return {
        status: 'failed',
        runtimeTurnId: record.turnId,
        failure:
          'The final report does not match the latest saved worker turn. Inspect current state before continuing manually.',
      };
    }
    if (
      message.stopReason === 'tool-limit' &&
      (run.turnsUsed ?? 1) < (run.turnLimit ?? 1) &&
      (!checkpoint || checkpoint.turnId !== record.turnId || checkpoint.agentId !== run.agentId)
    ) {
      return {
        status: 'failed',
        runtimeTurnId: record.turnId,
        failure:
          'The completed turn has no matching safe checkpoint. Inspect current state before continuing manually.',
      };
    }
    return {
      status: 'returned',
      runtimeTurnId: record.turnId,
      output: message?.content,
      stopReason: message?.stopReason,
    };
  }
  return { status: 'running', runtimeTurnId: record.turnId };
}

export const projectWorkflowRuntime = new ProjectWorkflowRuntime(
  projectGraphRepository,
  projectTaskRunRepository,
  projectWorkerExecutor,
  (projectId) => listeners.forEach((listener) => listener(projectId)),
  undefined,
  undefined,
  projectRunCommitter,
  projectResultChecker,
  projectWorkerReservations,
);

export function subscribeProjectRuntime(listener: ProjectRuntimeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function resolveProjectWorkerApproval(
  run: ProjectTaskRun,
  decision: 'approve' | 'deny',
): Promise<ProjectTaskRun> {
  if (run.status !== 'suspended' || !run.approval) {
    throw new Error('This project worker is not waiting for approval.');
  }
  return projectWorkflowRuntime.resolveApproval(run.approval.id, decision);
}
