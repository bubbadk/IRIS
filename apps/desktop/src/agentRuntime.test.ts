import { describe, expect, it } from 'vitest';
import type { AgentActivity } from '@iris/agents';
import type { AgentDefinition } from '@iris/core';
import { configuredAgentModel, reasoningHygieneContext, summarizeActivity } from './agentRuntime';

describe('configured agent model', () => {
  const provider = {
    model: 'deepseek-v4-flash',
    availableModels: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-vision'],
  };

  it('uses the model selected on the agent instead of the provider default', () => {
    expect(configuredAgentModel({ model: 'deepseek-v4-pro' }, provider)).toBe('deepseek-v4-pro');
  });

  it('keeps existing agents on the provider default', () => {
    expect(configuredAgentModel({}, provider)).toBe('deepseek-v4-flash');
  });

  it('resumes a suspended turn with its original model identity', () => {
    expect(configuredAgentModel({ model: 'deepseek-v4-pro' }, provider, 'deepseek-v4-vision')).toBe(
      'deepseek-v4-vision',
    );
  });

  it('refuses a stale explicit model after provider discovery changes', () => {
    expect(() =>
      configuredAgentModel(
        { model: 'deepseek-v4-pro' },
        { ...provider, availableModels: ['deepseek-v4-flash'] },
      ),
    ).toThrow('no longer reported');
  });
});

describe('summarizeActivity', () => {
  const base = { agentId: 'agent-1', agentName: 'IRIS', at: '2026-08-30T12:00:00.000Z' };

  it('describes each meaningful agent event with the agent name', () => {
    const cases: [AgentActivity['event'], string, string][] = [
      [{ type: 'user-message', message: { role: 'user', content: 'hi' } }, 'info', 'IRIS received a new message'],
      [
        { type: 'tool-call', call: { id: 'c1', name: 'workspace_write', input: {} } },
        'tool',
        'IRIS is running workspace_write',
      ],
      [
        { type: 'tool-complete', call: { id: 'c1', name: 'workspace_write', input: {} }, output: {} },
        'success',
        'IRIS finished workspace_write',
      ],
      [
        { type: 'tool-denied', call: { id: 'c1', name: 'workspace_write', input: {} }, reason: 'no' },
        'warn',
        'IRIS: workspace_write was denied',
      ],
      [
        { type: 'tool-failed', call: { id: 'c1', name: 'workspace_write', input: {} }, reason: 'boom' },
        'error',
        'IRIS: workspace_write failed',
      ],
      [
        {
          type: 'tool-approval-required',
          call: { id: 'c1', name: 'workspace_write', input: {} },
          approval: { id: 'a1', toolId: 'workspace.write', toolName: 'Write file', reason: 'Ask' },
        },
        'warn',
        'IRIS is waiting for approval to run workspace_write',
      ],
      [
        { type: 'assistant-complete', message: { role: 'assistant', content: 'done' } },
        'success',
        'IRIS finished replying',
      ],
    ];
    for (const [event, kind, summary] of cases) {
      expect(summarizeActivity({ ...base, event })).toEqual({ kind, summary });
    }
  });

  it('skips streamed chunks so the feed is not drowned by every token', () => {
    expect(summarizeActivity({ ...base, event: { type: 'assistant-chunk', text: 'Hi' } })).toBeNull();
    expect(
      summarizeActivity({ ...base, event: { type: 'reasoning-chunk', text: 'thinking' } }),
    ).toBeNull();
  });
});

describe('reasoningHygieneContext', () => {
  it('tells the model to act through tools instead of drafting the real output in its reasoning', async () => {
    const agent: AgentDefinition = {
      id: 'agent',
      name: 'Builder',
      autonomy: 'act',
      skillIds: [],
      toolIds: [],
    };
    const messages = await reasoningHygieneContext.build(agent);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/reasoning/i);
    expect(messages[0]).toMatch(/tool call/i);
  });
});
