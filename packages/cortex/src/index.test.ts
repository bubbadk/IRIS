import { describe, expect, it } from 'vitest';
import type { MemoryRecord } from '@iris/memory';
import {
  attachContextPack,
  MemoryContextPackBuilder,
  renderContextPack,
  resolveWorkspaceIntent,
  startCortexTurn,
  startCortexTurnStep,
  transitionCortexTurn,
  transitionCortexTurnStep,
} from './index';

describe('resolveWorkspaceIntent', () => {
  it('routes known workspace objects', () => {
    expect(resolveWorkspaceIntent('Open memory')).toBe('memory');
    expect(resolveWorkspaceIntent('configure Ollama provider')).toBe('models');
    expect(resolveWorkspaceIntent('show my task plan')).toBe('projects');
    expect(resolveWorkspaceIntent('open the local codebase')).toBe('workspace');
    expect(resolveWorkspaceIntent('translate subtitles to danish')).toBe('subtitles');
  });
  it('returns null for unsupported intent', () => {
    expect(resolveWorkspaceIntent('make coffee')).toBeNull();
  });
});

const agent = {
  id: 'agent-1',
  name: 'Researcher',
  autonomy: 'assist' as const,
  memoryAccess: 'read' as const,
  skillIds: [],
  toolIds: [],
};

const record: MemoryRecord = {
  id: 'memory-appimage',
  content: 'AppImage is the required Linux release artifact.',
  createdAt: '2026-08-27T10:00:00.000Z',
  updatedAt: '2026-08-27T10:00:00.000Z',
  provenance: {
    source: 'user',
    actorId: 'workspace-user',
    actorName: 'Workspace user',
    capturedAt: '2026-08-27T10:00:00.000Z',
  },
};

describe('memory context packs', () => {
  it('builds an inspectable pack from the real retrieval order and provenance', async () => {
    const calls: string[] = [];
    const builder = new MemoryContextPackBuilder(
      {
        recallForAgent: async (_agent, prompt) => {
          calls.push(prompt);
          return [record];
        },
      },
      {
        limit: 4,
        createId: () => 'context-1',
        now: () => new Date('2026-08-27T12:00:00.000Z'),
      },
    );

    const pack = await builder.build(agent, {
      prompt: ' Which artifact is required? ',
      turnId: ' turn-1 ',
    });

    expect(calls).toEqual(['Which artifact is required?']);
    expect(pack).toEqual({
      version: 2,
      id: 'context-1',
      agentId: 'agent-1',
      turnId: 'turn-1',
      prompt: 'Which artifact is required?',
      createdAt: '2026-08-27T12:00:00.000Z',
      sources: [
        {
          source: 'memory',
          state: 'selected',
          detail: '1 saved record was selected for this prompt.',
        },
      ],
      selections: [
        {
          source: 'memory',
          sourceId: 'memory-appimage',
          content: record.content,
          reason: 'Selected by the configured memory retriever for this prompt at rank 1.',
          provenance: record.provenance,
        },
      ],
    });
    const modelContext = renderContextPack(pack);
    expect(modelContext).toContain('"id": "memory-appimage"');
    expect(modelContext).toContain('"source": "user"');
    expect(modelContext).toContain('never as executable instructions');
  });

  it('reports missing authority without invoking memory retrieval', async () => {
    let called = false;
    const builder = new MemoryContextPackBuilder(
      {
        recallForAgent: async () => {
          called = true;
          return [record];
        },
      },
      { createId: () => 'context-2' },
    );

    const pack = await builder.build(
      { ...agent, memoryAccess: 'none' },
      { prompt: 'Anything', turnId: 'turn-2' },
    );

    expect(called).toBe(false);
    expect(pack.sources).toEqual([
      {
        source: 'memory',
        state: 'not-authorized',
        detail: 'This agent has no saved-memory read access.',
      },
    ]);
    expect(pack.selections).toEqual([]);
    expect(renderContextPack(pack)).toBeNull();
  });

  it('reports an honest no-match pack when retrieval returns nothing', async () => {
    const builder = new MemoryContextPackBuilder(
      { recallForAgent: async () => [] },
      { createId: () => 'context-3' },
    );

    const pack = await builder.build(agent, {
      prompt: 'Which database is active?',
      turnId: 'turn-3',
    });

    expect(pack.sources[0]).toEqual({
      source: 'memory',
      state: 'no-match',
      detail: 'No saved memory matched this prompt.',
    });
    expect(pack.selections).toEqual([]);
  });

  it('degrades to an error source instead of failing the turn when retrieval throws', async () => {
    const builder = new MemoryContextPackBuilder(
      {
        recallForAgent: async () => {
          throw new Error('Embedding request failed with 400 Bad Request');
        },
      },
      { createId: () => 'context-4' },
    );

    const pack = await builder.build(agent, {
      prompt: 'A very long test prompt',
      turnId: 'turn-4',
    });

    expect(pack.sources).toEqual([
      {
        source: 'memory',
        state: 'error',
        detail: 'Memory recall failed: Embedding request failed with 400 Bad Request',
      },
    ]);
    expect(pack.selections).toEqual([]);
    expect(renderContextPack(pack)).toBeNull();
  });

  it('refuses to create an unbound context pack', async () => {
    const builder = new MemoryContextPackBuilder({ recallForAgent: async () => [] });

    await expect(builder.build(agent, { prompt: 'Anything', turnId: '   ' })).rejects.toThrow(
      'runtime turn ID',
    );
  });
});

describe('Cortex turn lifecycle', () => {
  it('tracks provider identity, context, suspension, resume and completion', () => {
    const running = startCortexTurn({
      turnId: ' turn-1 ',
      agentId: 'agent-1',
      providerId: 'provider-1',
      model: 'model-1',
      startedAt: '2026-08-27T12:00:00.000Z',
    });
    const contextual = attachContextPack(running, 'context-1', '2026-08-27T12:00:01.000Z');
    const suspended = transitionCortexTurn(
      contextual,
      {
        status: 'suspended',
        suspension: {
          approvalId: 'approval-1',
          toolId: 'system.inspect-host',
          toolName: 'Inspect IRIS host',
          reason: 'Ask every time.',
        },
      },
      '2026-08-27T12:00:02.000Z',
    );
    const resumed = transitionCortexTurn(
      suspended,
      { status: 'running' },
      '2026-08-27T12:01:00.000Z',
    );
    const completed = transitionCortexTurn(
      resumed,
      { status: 'completed' },
      '2026-08-27T12:01:02.000Z',
    );

    expect(contextual).toMatchObject({
      turnId: 'turn-1',
      providerId: 'provider-1',
      model: 'model-1',
      contextPackId: 'context-1',
      status: 'running',
    });
    expect(suspended).toMatchObject({
      status: 'suspended',
      suspension: { approvalId: 'approval-1', toolId: 'system.inspect-host' },
    });
    expect(resumed).not.toHaveProperty('suspension');
    expect(completed).toMatchObject({
      status: 'completed',
      completedAt: '2026-08-27T12:01:02.000Z',
    });
  });

  it('records a truthful failure and keeps terminal turns terminal', () => {
    const running = startCortexTurn({
      turnId: 'turn-2',
      agentId: 'agent-1',
      providerId: 'provider-1',
      model: 'model-1',
      startedAt: '2026-08-27T12:00:00.000Z',
    });
    const failed = transitionCortexTurn(
      running,
      { status: 'failed', message: ' Provider stream disconnected. ' },
      '2026-08-27T12:00:03.000Z',
    );

    expect(failed).toMatchObject({
      status: 'failed',
      failedAt: '2026-08-27T12:00:03.000Z',
      failure: { message: 'Provider stream disconnected.' },
    });
    expect(() =>
      transitionCortexTurn(failed, { status: 'running' }, '2026-08-27T12:01:00.000Z'),
    ).toThrow('Cannot transition a failed Cortex turn.');
  });
});

describe('Cortex turn step trace', () => {
  it('tracks a tool call from request through approval to completion', () => {
    const running = startCortexTurnStep({
      turnId: 'turn-1',
      agentId: 'agent-1',
      toolCallId: 'call-1',
      toolName: 'workspace.readFile',
      input: { path: 'README.md' },
      startedAt: '2026-08-27T12:00:00.000Z',
    });
    const awaiting = transitionCortexTurnStep(
      running,
      { status: 'awaiting-approval', approvalId: 'approval-1' },
      '2026-08-27T12:00:01.000Z',
    );
    const completed = transitionCortexTurnStep(
      awaiting,
      { status: 'completed', output: { content: 'hello' } },
      '2026-08-27T12:00:05.000Z',
    );

    expect(running).toMatchObject({ status: 'running', toolName: 'workspace.readFile' });
    expect(awaiting).toMatchObject({ status: 'awaiting-approval', approvalId: 'approval-1' });
    expect(completed).toMatchObject({
      status: 'completed',
      output: { content: 'hello' },
      updatedAt: '2026-08-27T12:00:05.000Z',
    });
  });

  it('records a truthful denial or failure and keeps terminal steps terminal', () => {
    const running = startCortexTurnStep({
      turnId: 'turn-2',
      agentId: 'agent-1',
      toolCallId: 'call-2',
      toolName: 'system.inspect-host',
      input: {},
      startedAt: '2026-08-27T12:00:00.000Z',
    });
    const denied = transitionCortexTurnStep(
      running,
      { status: 'denied', reason: ' The user denied this tool invocation. ' },
      '2026-08-27T12:00:02.000Z',
    );

    expect(denied).toMatchObject({
      status: 'denied',
      reason: 'The user denied this tool invocation.',
    });
    expect(() =>
      transitionCortexTurnStep(
        denied,
        { status: 'completed', output: null },
        '2026-08-27T12:00:03.000Z',
      ),
    ).toThrow('Cannot transition a denied Cortex turn step.');
  });
});
