import { describe, expect, it, vi } from 'vitest';
import {
  AuditedPermissionEngine,
  GatedToolExecutor,
  StaticPermissionEngine,
  ToolPermissionError,
  ToolRegistry,
  setToolAssigned,
  type PermissionAuditEvent,
  type PermissionAuditRepository,
  type RegisteredTool,
  type ToolApprovalRepository,
  type ToolApprovalRequest,
  type ToolApprovalStatus,
} from './index';

const agent = {
  id: 'agent-1',
  name: 'Operator',
  autonomy: 'act' as const,
  skillIds: [],
  toolIds: ['files.read'],
};

function registryWithRunner(run: RegisteredTool['run'], alwaysRequireApproval = false) {
  const registry = new ToolRegistry();
  registry.register({
    id: 'files.read',
    name: 'Read file',
    description: 'Reads one approved file.',
    risk: 'read',
    alwaysRequireApproval,
    run,
  });
  return registry;
}

class MemoryApprovalRepository implements ToolApprovalRepository {
  readonly requests: ToolApprovalRequest[] = [];

  async list() {
    return this.requests.map((request) => ({ ...request }));
  }

  async get(id: string) {
    const request = this.requests.find((item) => item.id === id);
    return request ? { ...request } : null;
  }

  async save(request: ToolApprovalRequest) {
    const index = this.requests.findIndex((item) => item.id === request.id);
    if (index === -1) this.requests.push({ ...request });
    else this.requests[index] = { ...request };
  }

  async clearResolved() {
    const pending = this.requests.filter(
      (request) => request.status === 'pending' || request.status === 'approved',
    );
    this.requests.splice(0, this.requests.length, ...pending);
  }

  async compareAndSet(id: string, expected: ToolApprovalStatus, request: ToolApprovalRequest) {
    const index = this.requests.findIndex((item) => item.id === id && item.status === expected);
    if (index < 0) return false;
    this.requests[index] = { ...request };
    return true;
  }
}

describe('permission-gated tool execution', () => {
  it('executes a shared approval only once across concurrent executors', async () => {
    const run = vi.fn(async () => 'done');
    const registry = registryWithRunner(run, true);
    const permissions = new StaticPermissionEngine([{ id: 'ask', agentId: '*', toolId: '*', decision: 'ask' }]);
    const repository = new MemoryApprovalRepository();
    const first = new GatedToolExecutor(registry, permissions, repository);
    const second = new GatedToolExecutor(registry, permissions, repository);
    const requested = await first.execute(agent, 'files.read', {});
    if (requested.status !== 'approval-required') throw new Error('Expected approval');
    const results = await Promise.allSettled([
      first.resolve(requested.approval.id, 'approve'),
      second.resolve(requested.approval.id, 'approve'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
    await expect(second.resume(requested.approval.id)).rejects.toThrow();
  });
  it('denies by default and never calls the tool', async () => {
    const run = vi.fn(async () => 'secret');
    const executor = new GatedToolExecutor(
      registryWithRunner(run),
      new StaticPermissionEngine(),
      new MemoryApprovalRepository(),
    );
    await expect(
      executor.execute(agent, 'files.read', { path: 'notes.txt' }),
    ).rejects.toBeInstanceOf(ToolPermissionError);
    expect(run).not.toHaveBeenCalled();
  });

  it('requires assignment even when a broad rule allows the tool', async () => {
    const run = vi.fn(async () => 'done');
    const executor = new GatedToolExecutor(
      registryWithRunner(run),
      new StaticPermissionEngine([
        { id: 'allow-all', agentId: '*', toolId: '*', decision: 'allow' },
      ]),
      new MemoryApprovalRepository(),
    );
    await expect(executor.execute({ ...agent, toolIds: [] }, 'files.read', {})).rejects.toThrow(
      'Tool is not assigned to this agent.',
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('allows assigned tools in YOLO mode without an approval', async () => {
    const run = vi.fn(async () => 'done');
    const executor = new GatedToolExecutor(
      registryWithRunner(run),
      new StaticPermissionEngine([
        { id: 'default-ask', agentId: '*', toolId: '*', decision: 'ask' },
      ]),
      new MemoryApprovalRepository(),
    );

    await expect(
      executor.execute({ ...agent, approvalMode: 'yolo' }, 'files.read', {}),
    ).resolves.toMatchObject({
      status: 'completed',
      output: 'done',
      evaluation: { decision: 'allow' },
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it('keeps explicit deny rules effective in YOLO mode', async () => {
    const run = vi.fn(async () => 'done');
    const executor = new GatedToolExecutor(
      registryWithRunner(run),
      new StaticPermissionEngine([
        { id: 'default-ask', agentId: '*', toolId: '*', decision: 'ask' },
        { id: 'deny-read', agentId: agent.id, toolId: 'files.read', decision: 'deny' },
      ]),
      new MemoryApprovalRepository(),
    );

    await expect(
      executor.execute({ ...agent, approvalMode: 'yolo' }, 'files.read', {}),
    ).rejects.toThrow('deny');
    expect(run).not.toHaveBeenCalled();
  });

  it('requires a fresh approval for mandatory tools even in YOLO mode with an allow rule', async () => {
    const run = vi.fn(async () => 'published');
    const approvals = new MemoryApprovalRepository();
    const executor = new GatedToolExecutor(
      registryWithRunner(run, true),
      new StaticPermissionEngine([
        { id: 'allow-release', agentId: agent.id, toolId: 'files.read', decision: 'allow' },
      ]),
      approvals,
      () => 'approval-mandatory',
    );

    await expect(
      executor.execute({ ...agent, approvalMode: 'yolo' }, 'files.read', {}),
    ).resolves.toMatchObject({
      status: 'approval-required',
      evaluation: { decision: 'ask', reason: expect.stringContaining('always requires') },
      approval: { id: 'approval-mandatory', status: 'pending' },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('returns approval-required without executing ask rules', async () => {
    const run = vi.fn(async () => 'done');
    const approvals = new MemoryApprovalRepository();
    const executor = new GatedToolExecutor(
      registryWithRunner(run),
      new StaticPermissionEngine([
        { id: 'confirm-read', agentId: agent.id, toolId: 'files.read', decision: 'ask' },
      ]),
      approvals,
      () => 'approval-1',
      () => new Date('2026-08-27T10:00:00.000Z'),
    );
    await expect(executor.execute(agent, 'files.read', {})).resolves.toMatchObject({
      status: 'approval-required',
      approval: {
        id: 'approval-1',
        status: 'pending',
        agentId: agent.id,
        toolId: 'files.read',
      },
    });
    expect(run).not.toHaveBeenCalled();
    expect(approvals.requests).toHaveLength(1);
  });

  it('persists approval before running the exact saved invocation', async () => {
    const run = vi.fn(async (input) => ({ input }));
    const approvals = new MemoryApprovalRepository();
    const executor = new GatedToolExecutor(
      registryWithRunner(run),
      new StaticPermissionEngine([
        { id: 'confirm-read', agentId: agent.id, toolId: 'files.read', decision: 'ask' },
      ]),
      approvals,
      () => 'approval-1',
      () => new Date('2026-08-27T10:00:00.000Z'),
    );
    await executor.execute(agent, 'files.read', { path: 'notes.txt' });
    await expect(executor.resolve('approval-1', 'approve')).resolves.toMatchObject({
      status: 'completed',
      output: { input: { path: 'notes.txt' } },
      approval: { status: 'completed' },
    });
    expect(run).toHaveBeenCalledWith(
      { path: 'notes.txt' },
      expect.objectContaining({ agentId: agent.id, agentName: agent.name }),
    );
    await expect(executor.resume('approval-1')).rejects.toThrow('cannot execute from completed');
  });

  it('records denial without running the requested tool', async () => {
    const run = vi.fn(async () => 'unused');
    const approvals = new MemoryApprovalRepository();
    const executor = new GatedToolExecutor(
      registryWithRunner(run),
      new StaticPermissionEngine([
        { id: 'confirm-read', agentId: agent.id, toolId: 'files.read', decision: 'ask' },
      ]),
      approvals,
      () => 'approval-1',
    );
    await executor.execute(agent, 'files.read', {});
    await expect(executor.resolve('approval-1', 'deny')).resolves.toMatchObject({
      status: 'approval-denied',
      approval: { status: 'denied' },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('executes only after an explicit allow decision', async () => {
    const run = vi.fn(async () => 'contents');
    const executor = new GatedToolExecutor(
      registryWithRunner(run),
      new StaticPermissionEngine([
        { id: 'allow-read', agentId: agent.id, toolId: 'files.read', decision: 'allow' },
      ]),
      new MemoryApprovalRepository(),
    );
    await expect(executor.execute(agent, 'files.read', { path: 'notes.txt' })).resolves.toEqual({
      status: 'completed',
      output: 'contents',
      evaluation: {
        decision: 'allow',
        reason: 'Permission rule allow-read returned allow.',
        ruleId: 'allow-read',
      },
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it('preserves agent turn provenance through approval and resume', async () => {
    const run = vi.fn(async (_input, context) => context);
    const approvals = new MemoryApprovalRepository();
    const executor = new GatedToolExecutor(
      registryWithRunner(run),
      new StaticPermissionEngine([
        { id: 'confirm-read', agentId: agent.id, toolId: 'files.read', decision: 'ask' },
      ]),
      approvals,
      () => 'approval-1',
    );
    await executor.execute(agent, 'files.read', {}, undefined, {
      turnId: 'turn-1',
      toolCallId: 'call-1',
    });
    await executor.resolve('approval-1', 'approve');

    expect(run).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        agentId: agent.id,
        agentName: agent.name,
        turnId: 'turn-1',
        toolCallId: 'call-1',
      }),
    );
  });

  it('prefers the most specific rule', async () => {
    const permissions = new StaticPermissionEngine([
      { id: 'deny-all', agentId: '*', toolId: '*', decision: 'deny' },
      { id: 'allow-agent-tool', agentId: agent.id, toolId: 'files.read', decision: 'allow' },
    ]);
    await expect(
      permissions.evaluate(agent, {
        id: 'files.read',
        name: 'Read file',
        description: 'Reads one approved file.',
        risk: 'read',
      }),
    ).resolves.toMatchObject({ decision: 'allow', ruleId: 'allow-agent-tool' });
  });
});

class MemoryAuditRepository implements PermissionAuditRepository {
  readonly events: PermissionAuditEvent[] = [];

  async list() {
    return this.events.map((event) => ({ ...event }));
  }

  async append(event: PermissionAuditEvent) {
    this.events.push({ ...event });
  }

  async clear() {
    this.events.length = 0;
  }
}

describe('permission inspection and audit', () => {
  it('records deny decisions with their source and subject', async () => {
    const audit = new MemoryAuditRepository();
    const permissions = new AuditedPermissionEngine(
      new StaticPermissionEngine(),
      audit,
      () => 'audit-1',
      () => new Date('2026-08-27T10:00:00.000Z'),
    );
    await permissions.evaluate(
      { ...agent, toolIds: [] },
      {
        id: 'files.read',
        name: 'Read file',
        description: 'Reads one approved file.',
        risk: 'read',
      },
      { source: 'inspection' },
    );
    await expect(audit.list()).resolves.toEqual([
      {
        id: 'audit-1',
        timestamp: '2026-08-27T10:00:00.000Z',
        source: 'inspection',
        agentId: 'agent-1',
        agentName: 'Operator',
        toolId: 'files.read',
        toolName: 'Read file',
        decision: 'deny',
        reason: 'Tool is not assigned to this agent.',
      },
    ]);
  });

  it('marks executor evaluations as execution decisions', async () => {
    const audit = new MemoryAuditRepository();
    const permissions = new AuditedPermissionEngine(
      new StaticPermissionEngine([
        { id: 'confirm-read', agentId: agent.id, toolId: 'files.read', decision: 'ask' },
      ]),
      audit,
    );
    const executor = new GatedToolExecutor(
      registryWithRunner(async () => 'unused'),
      permissions,
      new MemoryApprovalRepository(),
    );
    await executor.execute(agent, 'files.read', {});
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ source: 'execution', decision: 'ask' });
  });

  it('updates tool assignments without mutating the agent definition', () => {
    const tool = {
      id: 'files.read',
      name: 'Read file',
      description: 'Reads one approved file.',
      risk: 'read' as const,
    };
    const unassigned = { ...agent, toolIds: [] };
    const assigned = setToolAssigned(unassigned, tool, true);
    expect(assigned.toolIds).toEqual(['files.read']);
    expect(unassigned.toolIds).toEqual([]);
    expect(setToolAssigned(assigned, tool, false).toolIds).toEqual([]);
  });
});
