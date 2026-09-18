import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@iris/agents';
import {
  mapAgentWorkerEvents,
  projectWorkerPrompt,
  recoverProjectWorker,
  projectAgentRuntime,
} from './projectRuntime';
import {
  projectWorkerCortexTurnRepository,
  projectWorkerConversationRepository,
} from './persistence';
import { projectCheckpointRepository } from './projectCheckpoints';
import { startCortexTurn, transitionCortexTurn } from '@iris/cortex';
import type { ProjectTaskRun } from '@iris/workflows';
afterEach(() => vi.restoreAllMocks());

async function collect(events: AsyncIterable<AgentEvent>) {
  const mapped = [];
  for await (const event of mapAgentWorkerEvents(events)) mapped.push(event);
  return mapped;
}

describe('project worker event boundary', () => {
  it('maps an isolated agent turn to a persistent worker identity and output', async () => {
    const events = async function* (): AsyncGenerator<AgentEvent> {
      yield {
        type: 'user-message',
        message: { role: 'user', content: 'Worker prompt', turnId: 'turn-worker' },
      };
      yield { type: 'assistant-chunk', text: 'Verified ' };
      yield {
        type: 'assistant-complete',
        message: { role: 'assistant', content: 'Verified build.', turnId: 'turn-worker' },
      };
    };

    await expect(collect(events())).resolves.toEqual([
      { type: 'started', runtimeTurnId: 'turn-worker' },
      {
        type: 'returned',
        runtimeTurnId: 'turn-worker',
        output: 'Verified build.',
        stopReason: undefined,
      },
    ]);
  });

  it('retains the real approval request for restart-safe resume', async () => {
    const events = async function* (): AsyncGenerator<AgentEvent> {
      yield {
        type: 'context-pack-ready',
        pack: {
          version: 2,
          id: 'context-worker',
          agentId: 'agent-1',
          turnId: 'turn-worker',
          prompt: 'Inspect host',
          createdAt: '2026-08-27T12:00:00.000Z',
          sources: [],
          selections: [],
        },
      };
      yield {
        type: 'tool-approval-required',
        call: { id: 'call-1', name: 'system_inspect_host', input: {} },
        approval: {
          id: 'approval-1',
          toolId: 'system.inspect-host',
          toolName: 'Inspect IRIS host',
          reason: 'Ask every time.',
        },
      };
    };

    await expect(collect(events())).resolves.toEqual([
      { type: 'started', runtimeTurnId: 'turn-worker' },
      {
        type: 'approval-required',
        runtimeTurnId: 'turn-worker',
        approval: {
          id: 'approval-1',
          toolId: 'system.inspect-host',
          toolName: 'Inspect IRIS host',
          reason: 'Ask every time.',
        },
      },
    ]);
  });
  it('preserves the runtime tool limit instead of accepting a model success claim', async () => {
    const events = async function* (): AsyncGenerator<AgentEvent> {
      yield {
        type: 'assistant-complete',
        message: {
          role: 'assistant',
          turnId: 'stopped',
          content: 'All done!',
          stopReason: 'tool-limit',
        },
      };
    };
    await expect(collect(events())).resolves.toEqual([
      { type: 'returned', runtimeTurnId: 'stopped', output: 'All done!', stopReason: 'tool-limit' },
    ]);
  });

  it('carries acceptance criteria and the previous report into a continuation', () => {
    const run = {
      version: 1 as const,
      id: 'r2',
      projectId: 'p',
      taskId: 't',
      agentId: 'a',
      agentName: 'Worker',
      status: 'running' as const,
      createdAt: '2026-09-07',
      updatedAt: '2026-09-07',
      continuation: 'Check error cases.',
    };
    const task = {
      id: 't',
      title: 'Build',
      dependencyIds: [],
      createdAt: '2026-09-07',
      acceptanceCriteria: 'Tests pass.',
    };
    const prompt = projectWorkerPrompt({
      run,
      task,
      project: {
        version: 1,
        id: 'p',
        title: 'Project',
        objective: 'Working feature',
        tasks: [task],
        createdAt: '',
        updatedAt: '',
      },
      previousRun: {
        ...run,
        id: 'r1',
        status: 'needs-attention',
        output: 'Files changed, tests pending.',
      },
    });
    expect(prompt).toContain('Tests pass.');
    expect(prompt).toContain('Files changed, tests pending.');
    expect(prompt).toContain('Check error cases.');
    expect(prompt).toContain('not a replay of previous tools');
  });
});

describe('project checkpoint recovery', () => {
  const at = '2026-09-07T10:00:00.000Z';
  const run: ProjectTaskRun = {
    version: 1,
    id: 'run',
    projectId: 'p',
    taskId: 't',
    agentId: 'a',
    agentName: 'Worker',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    runtimeTurnId: 'turn',
    turnLimit: 3,
    turnsUsed: 1,
  };
  const completed = transitionCortexTurn(
    startCortexTurn({
      turnId: 'turn',
      agentId: 'a',
      providerId: 'test',
      model: 'test',
      startedAt: at,
    }),
    { status: 'completed' },
    at,
  );
  const conversation = [
    {
      role: 'assistant' as const,
      turnId: 'turn',
      content: 'Saved progress.',
      stopReason: 'tool-limit' as const,
    },
  ];

  it.each([true, false])(
    'requires a matching durable checkpoint before offering resume (saved=%s)',
    async (saved) => {
      vi.spyOn(projectAgentRuntime, 'cortexTurnsForAgent').mockResolvedValue([completed]);
      vi.spyOn(projectWorkerCortexTurnRepository, 'get').mockResolvedValue(completed);
      vi.spyOn(projectWorkerConversationRepository, 'list').mockResolvedValue(conversation);
      vi.spyOn(projectCheckpointRepository, 'get').mockResolvedValue(
        saved
          ? {
              version: 1,
              agentId: 'a',
              providerId: 'test',
              model: 'test',
              turnId: 'turn',
              conversation,
              modelHistory: [{ role: 'assistant', content: 'Saved progress.' }],
            }
          : null,
      );
      const recovered = await recoverProjectWorker(run);
      expect(recovered.status).toBe(saved ? 'returned' : 'failed');
      if (recovered.status === 'failed')
        expect(recovered.failure).toContain('no matching safe checkpoint');
    },
  );

  it('rejects an old checkpoint when a newer turn started before project progress was saved', async () => {
    const newer = startCortexTurn({
      turnId: 'newer',
      agentId: 'a',
      providerId: 'test',
      model: 'test',
      startedAt: '2026-09-07T10:01:00.000Z',
    });
    vi.spyOn(projectAgentRuntime, 'cortexTurnsForAgent').mockResolvedValue([newer, completed]);
    vi.spyOn(projectWorkerCortexTurnRepository, 'get').mockResolvedValue(completed);
    const recovered = await recoverProjectWorker(run);
    expect(recovered).toMatchObject({
      status: 'failed',
      failure: expect.stringContaining('outcome may be unknown'),
    });
  });
});
