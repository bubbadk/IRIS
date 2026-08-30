import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@iris/agents';
import { mapAgentWorkerEvents } from './projectRuntime';

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
      { type: 'completed', runtimeTurnId: 'turn-worker', output: 'Verified build.' },
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
});
