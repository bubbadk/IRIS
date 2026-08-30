import { beforeEach, describe, expect, it } from 'vitest';
import {
  memoryRepository,
  permissionAuditRepository,
  permissionRuleRepository,
  toolApprovalRepository,
} from './persistence';
import { agentToolRuntime } from './tooling';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
});

describe('desktop agent tool runtime', () => {
  it('exposes only assigned tools through provider-safe definitions', () => {
    expect(
      agentToolRuntime.definitions({
        id: 'agent-1',
        name: 'Operator',
        autonomy: 'act',
        skillIds: [],
        toolIds: ['system.inspect-host'],
      }),
    ).toEqual([
      {
        name: 'system_inspect_host',
        description: 'Reads the local operating system, architecture and installed IRIS version.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ]);
  });

  it('exposes the memory writer only when assigned and records its agent turn provenance', async () => {
    const agent = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'act' as const,
      skillIds: [],
      toolIds: ['memory.remember'],
    };
    await permissionRuleRepository.save({
      id: 'allow-memory',
      agentId: agent.id,
      toolId: 'memory.remember',
      decision: 'allow',
    });

    expect(agentToolRuntime.definitions(agent)).toEqual([
      expect.objectContaining({ name: 'memory_remember' }),
    ]);
    await expect(
      agentToolRuntime.execute(
        agent,
        'memory_remember',
        { content: 'The workspace language is Danish.' },
        { turnId: 'turn-1', toolCallId: 'call-1' },
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      output: { saved: true },
    });
    await expect(memoryRepository.list()).resolves.toEqual([
      expect.objectContaining({
        content: 'The workspace language is Danish.',
        provenance: expect.objectContaining({
          source: 'agent',
          actorId: agent.id,
          actorName: agent.name,
          turnId: 'turn-1',
          toolCallId: 'call-1',
        }),
      }),
    ]);
  });

  it('routes model requests through audited permissions and the persistent approval queue', async () => {
    const agent = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'act' as const,
      skillIds: [],
      toolIds: ['system.inspect-host'],
    };
    await permissionRuleRepository.save({
      id: 'confirm-host',
      agentId: agent.id,
      toolId: 'system.inspect-host',
      decision: 'ask',
      reason: 'Confirm native inspection.',
    });

    await expect(
      agentToolRuntime.execute(
        agent,
        'system_inspect_host',
        {},
        { turnId: 'turn-1', toolCallId: 'call-1' },
      ),
    ).resolves.toMatchObject({
      status: 'approval-required',
      approval: {
        toolId: 'system.inspect-host',
        toolName: 'Inspect IRIS host',
        reason: 'Confirm native inspection.',
      },
    });
    await expect(toolApprovalRepository.list()).resolves.toHaveLength(1);
    await expect(permissionAuditRepository.list()).resolves.toEqual([
      expect.objectContaining({
        source: 'execution',
        agentId: agent.id,
        toolId: 'system.inspect-host',
        decision: 'ask',
      }),
    ]);
  });

  it('returns deny-by-default as a model-visible denial instead of a runtime error', async () => {
    const agent = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'assist' as const,
      skillIds: [],
      toolIds: ['workspace.read'],
    };

    await expect(
      agentToolRuntime.execute(
        agent,
        'workspace_read',
        { path: 'notes.md' },
        { turnId: 'turn-denied', toolCallId: 'call-denied' },
      ),
    ).resolves.toEqual({
      status: 'denied',
      reason: 'No permission rule allows this tool.',
    });
    await expect(permissionAuditRepository.list()).resolves.toEqual([
      expect.objectContaining({
        source: 'execution',
        agentId: agent.id,
        toolId: 'workspace.read',
        decision: 'deny',
        reason: 'No permission rule allows this tool.',
      }),
    ]);
  });

  it('returns an allowed tool failure to the model instead of breaking the runtime turn', async () => {
    const agent = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'assist' as const,
      skillIds: [],
      toolIds: ['workspace.read'],
    };
    await permissionRuleRepository.save({
      id: 'allow-workspace-read',
      agentId: agent.id,
      toolId: 'workspace.read',
      decision: 'allow',
    });

    await expect(
      agentToolRuntime.execute(
        agent,
        'workspace_read',
        { path: 'notes.md' },
        { turnId: 'turn-failed', toolCallId: 'call-failed' },
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: expect.stringMatching(/workspace|native desktop/i),
    });
  });

  it('exposes workspace writes and persists their exact input before approval', async () => {
    const agent = {
      id: 'agent-1',
      name: 'Operator',
      autonomy: 'act' as const,
      skillIds: [],
      toolIds: ['workspace.mkdir', 'workspace.write'],
    };
    await permissionRuleRepository.save({
      id: 'ask-workspace-write',
      agentId: agent.id,
      toolId: 'workspace.write',
      decision: 'ask',
      reason: 'Approve each workspace file write.',
    });

    expect(agentToolRuntime.definitions(agent)).toEqual([
      expect.objectContaining({ name: 'workspace_create_directory' }),
      expect.objectContaining({ name: 'workspace_write_file' }),
    ]);
    await expect(
      agentToolRuntime.execute(
        agent,
        'workspace_write_file',
        { path: 'notes/hej.txt', content: 'Hej', overwrite: false },
        { turnId: 'turn-write', toolCallId: 'call-write' },
      ),
    ).resolves.toMatchObject({
      status: 'approval-required',
      approval: { toolId: 'workspace.write' },
    });
    await expect(toolApprovalRepository.list()).resolves.toEqual([
      expect.objectContaining({
        toolId: 'workspace.write',
        input: { path: 'notes/hej.txt', content: 'Hej', overwrite: false },
        invocation: { turnId: 'turn-write', toolCallId: 'call-write' },
      }),
    ]);
  });
});
