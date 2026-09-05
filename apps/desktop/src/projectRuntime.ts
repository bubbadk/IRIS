import { AgentRuntimeCoordinator, type AgentEvent } from '@iris/agents';
import type { AgentDefinition } from '@iris/core';
import {
  ProjectWorkflowRuntime,
  type ProjectTaskRun,
  type ProjectWorkerEvent,
  type ProjectWorkerExecutionInput,
  type ProjectWorkerExecutor,
} from '@iris/workflows';
import { agentContextBuilder } from './memory';
import {
  agentRepository,
  projectGraphRepository,
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

type ProjectRuntimeListener = (projectId: string) => void;

const listeners = new Set<ProjectRuntimeListener>();

const agentListeners = new Set<() => void>();
export function subscribeProjectAgentRuntime(listener: () => void): () => void {
  agentListeners.add(listener);
  return () => { agentListeners.delete(listener); };
}

export const projectAgentRuntime = new AgentRuntimeCoordinator(
  agentRepository,
  projectWorkerConversationRepository,
  projectWorkerSuspendedTurnRepository,
  providerResolver,
  agentToolRuntime,
  () => agentListeners.forEach((listener) => listener()),
  agentContextBuilder,
  projectWorkerContextPackRepository,
  projectWorkerCortexTurnRepository,
  undefined,
  agentWorkspaceContext,
  undefined,
  projectWorkerCortexTurnStepRepository,
);

function projectWorkerPrompt({ project, task }: ProjectWorkerExecutionInput): string {
  const detail = task.description ? `\nTask completion detail:\n${task.description}` : '';
  return [
    'You are a temporary IRIS project worker. Work only on the assigned task below.',
    'Use only your configured tools and obey every permission decision.',
    'Do not claim actions or results that you did not actually perform.',
    'When finished, return a concise factual completion report.',
    `Project: ${project.title}`,
    `Project objective:\n${project.objective}`,
    `Assigned task:\n${task.title}${detail}`,
  ].join('\n\n');
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
        type: 'completed',
        runtimeTurnId: completedTurnId,
        output: event.message.content,
      };
    }
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

const projectWorkerExecutor: ProjectWorkerExecutor = {
  async prepare(agentId) {
    const agent = await requireConfiguredAgent(agentId);
    await cleanupWorker(agent.id);
    return { agentName: agent.name };
  },

  async *execute(input, signal) {
    let suspended = false;
    try {
      for await (const event of mapAgentWorkerEvents(
        projectAgentRuntime.send(input.run.agentId, projectWorkerPrompt(input), signal),
      )) {
        if (event.type === 'approval-required') suspended = true;
        yield event;
      }
    } finally {
      if (!suspended) await cleanupWorker(input.run.agentId);
    }
  },

  async *resume(input, approvalId, decision, signal) {
    let suspended = false;
    try {
      for await (const event of mapAgentWorkerEvents(
        projectAgentRuntime.resolveApproval(approvalId, decision, signal),
        input.run.runtimeTurnId,
      )) {
        if (event.type === 'approval-required') suspended = true;
        yield event;
      }
    } finally {
      if (!suspended) await cleanupWorker(input.run.agentId);
    }
  },

  async cancel(run) {
    await projectAgentRuntime.cancelSuspended(run.agentId);
  },

  async recover(run) {
    if (!run.runtimeTurnId) {
      return { status: 'failed', failure: 'IRIS stopped before this worker turn started.' };
    }
    await projectAgentRuntime.cortexTurnsForAgent(run.agentId);
    const record = await projectWorkerCortexTurnRepository.get(run.runtimeTurnId);
    if (!record) {
      return {
        status: 'failed',
        runtimeTurnId: run.runtimeTurnId,
        failure: 'The persisted Cortex record for this worker turn is unavailable.',
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
      await cleanupWorker(run.agentId);
      return {
        status: 'failed',
        runtimeTurnId: record.turnId,
        failure: record.failure.message,
      };
    }
    if (record.status === 'completed') {
      const conversation = await projectWorkerConversationRepository.list(run.agentId);
      const output = conversation
        .filter((message) => message.role === 'assistant' && message.turnId === run.runtimeTurnId)
        .at(-1)?.content;
      await cleanupWorker(run.agentId);
      return { status: 'completed', runtimeTurnId: record.turnId, output };
    }
    return { status: 'running', runtimeTurnId: record.turnId };
  },
};

export const projectWorkflowRuntime = new ProjectWorkflowRuntime(
  projectGraphRepository,
  projectTaskRunRepository,
  projectWorkerExecutor,
  (projectId) => listeners.forEach((listener) => listener(projectId)),
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
