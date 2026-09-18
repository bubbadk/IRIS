import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GatedToolExecutor,
  StaticPermissionEngine,
  ToolRegistry,
  describeApproval,
  formatApprovalText,
  type PermissionRule,
  type ToolApprovalRepository,
  type ToolApprovalRequest,
  type ToolApprovalStatus,
} from '@iris/tools';
import { createDelegationContext, type AgentDefinition } from '@iris/core';
import { createJanitorCommandTool } from './janitorTool';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const { requestSudoPassword } = vi.hoisted(() => ({ requestSudoPassword: vi.fn() }));
vi.mock('./sudoPasswordPrompt', () => ({ requestSudoPassword }));

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

  async compareAndSet(
    id: string,
    expected: ToolApprovalStatus,
    request: ToolApprovalRequest,
  ): Promise<boolean> {
    const index = this.requests.findIndex((item) => item.id === id);
    if (index === -1 || this.requests[index].status !== expected) return false;
    this.requests[index] = { ...request };
    return true;
  }

  async clearResolved() {
    this.requests.splice(0, this.requests.length, ...this.requests.filter((r) => r.status === 'pending'));
  }
}

function agentWith(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'janitor-agent',
    name: 'Janitor',
    autonomy: 'janitor',
    approvalMode: 'yolo',
    skillIds: [],
    toolIds: ['janitor.command'],
    ...overrides,
  } as AgentDefinition;
}

function harness(rules: PermissionRule[] = []) {
  const registry = new ToolRegistry();
  registry.register(createJanitorCommandTool());
  const approvals = new MemoryApprovalRepository();
  let counter = 0;
  const executor = new GatedToolExecutor(
    registry,
    new StaticPermissionEngine(rules),
    approvals,
    () => `approval-${++counter}`,
    () => new Date('2026-01-01T00:00:00.000Z'),
  );
  return { executor, approvals };
}

beforeEach(() => {
  invoke.mockReset();
  requestSudoPassword.mockReset();
  invoke.mockResolvedValue({ target: 'local', exitCode: 0, stdout: 'ok', stderr: '' });
});

describe('janitor.command is mandatory-approval', () => {
  it('declares alwaysRequireApproval on the tool definition', () => {
    const tool = createJanitorCommandTool();
    expect(tool.alwaysRequireApproval).toBe(true);
    expect(tool.risk).toBe('execute');
  });

  it('cannot be executed by YOLO mode without a decision', async () => {
    const { executor, approvals } = harness();
    const result = await executor.execute(agentWith({ approvalMode: 'yolo' }), 'janitor.command', {
      target: 'local',
      command: 'sudo systemctl restart docker',
    });
    expect(result.status).toBe('approval-required');
    expect(invoke).not.toHaveBeenCalled();
    expect(approvals.requests).toHaveLength(1);
    expect(approvals.requests[0]?.status).toBe('pending');
  });

  it('cannot be executed by an explicit allow rule', async () => {
    const rules: PermissionRule[] = [
      {
        id: 'rule-allow',
        agentId: '*',
        toolId: 'janitor.command',
        decision: 'allow',
        reason: 'Allowlisted for testing.',
      },
    ];
    const { executor } = harness(rules);
    const result = await executor.execute(agentWith({ approvalMode: 'ask' }), 'janitor.command', {
      target: 'unraid',
      command: 'docker ps',
    });
    expect(result.status).toBe('approval-required');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('still honours an explicit deny rule', async () => {
    const rules: PermissionRule[] = [
      {
        id: 'rule-deny',
        agentId: '*',
        toolId: 'janitor.command',
        decision: 'deny',
        reason: 'Janitor commands are forbidden here.',
      },
    ];
    const { executor, approvals } = harness(rules);
    await expect(
      executor.execute(agentWith({ approvalMode: 'yolo' }), 'janitor.command', {
        target: 'local',
        command: 'ls',
      }),
    ).rejects.toThrow(/forbidden/);
    expect(invoke).not.toHaveBeenCalled();
    expect(approvals.requests).toHaveLength(0);
  });

  it('cannot be executed by a delegated child without its own decision', async () => {
    const { executor } = harness();
    const child = agentWith({ id: 'child', name: 'Child', approvalMode: 'yolo' });
    const result = await executor.execute(
      child,
      'janitor.command',
      { target: 'local', command: 'ls' },
      undefined,
      undefined,
      createDelegationContext({
        depth: 1,
        ancestors: [
          { id: 'janitor-agent', approvalMode: 'yolo' },
          { id: 'child', approvalMode: 'yolo' },
        ],
      }),
    );
    expect(result.status).toBe('approval-required');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('surfaces the delegated child operation in the child approval, not just its tool name', async () => {
    const { executor, approvals } = harness();
    // YOLO is the strongest case: the child still cannot run it, and the prompt it produces carries
    // the child's own command.
    const child = agentWith({ id: 'child', name: 'Child worker', approvalMode: 'yolo' });
    const pending = await executor.execute(
      child,
      'janitor.command',
      { target: 'unraid', command: 'docker stop plex' },
      undefined,
      undefined,
      createDelegationContext({ depth: 1, ancestors: [{ id: 'janitor-agent' }] }),
    );
    if (pending.status !== 'approval-required') throw new Error('expected an approval');
    // The child's own persisted record is what a nested approval surface resolves, so the concrete
    // command must be there — and the parent agent identity must not be substituted for it.
    const stored = await approvals.get(pending.approval.id);
    expect(stored?.agentId).toBe('child');
    const description = describeApproval({
      toolId: stored!.toolId,
      toolName: stored!.toolName,
      input: stored!.input,
      agentName: stored!.agentName,
    });
    expect(description.details).toContain('Command · docker stop plex');
    expect(description.details).toContain('Target · unraid');
  });

  it('refuses a delegated child that has no rule allowing the tool at all', async () => {
    const { executor, approvals } = harness();
    const child = agentWith({ id: 'child', name: 'Child worker', approvalMode: 'ask' });
    await expect(
      executor.execute(
        child,
        'janitor.command',
        { target: 'local', command: 'ls' },
        undefined,
        undefined,
        createDelegationContext({ depth: 1, ancestors: [{ id: 'janitor-agent' }] }),
      ),
    ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    expect(approvals.requests).toHaveLength(0);
  });
});

describe('janitor.command approval lifecycle', () => {
  it('runs nothing when the decision is deny', async () => {
    const { executor, approvals } = harness();
    const pending = await executor.execute(agentWith(), 'janitor.command', {
      target: 'local',
      command: 'sudo rm -rf /var/tmp/x',
    });
    if (pending.status !== 'approval-required') throw new Error('expected an approval');
    const denied = await executor.resolve(pending.approval.id, 'deny');
    expect(denied.status).toBe('approval-denied');
    expect(invoke).not.toHaveBeenCalled();
    expect((await approvals.get(pending.approval.id))?.status).toBe('denied');
  });

  it('runs the approved command exactly once', async () => {
    const { executor } = harness();
    const pending = await executor.execute(agentWith(), 'janitor.command', {
      target: 'local',
      command: 'df -h',
    });
    if (pending.status !== 'approval-required') throw new Error('expected an approval');
    const approved = await executor.resolve(pending.approval.id, 'approve');
    expect(approved.status).toBe('completed');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('run_janitor_command', {
      target: 'local',
      command: 'df -h',
    });
  });

  it('refuses a duplicate decision and never runs the command twice', async () => {
    const { executor } = harness();
    const pending = await executor.execute(agentWith(), 'janitor.command', {
      target: 'local',
      command: 'df -h',
    });
    if (pending.status !== 'approval-required') throw new Error('expected an approval');
    await executor.resolve(pending.approval.id, 'approve');
    await expect(executor.resolve(pending.approval.id, 'approve')).rejects.toThrow(
      /cannot be resolved from completed|cannot execute from completed|already/i,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('executes the approved command even if the caller mutates its own object afterwards', async () => {
    const { executor } = harness();
    const callerInput = { target: 'local' as const, command: 'df -h' };
    const pending = await executor.execute(agentWith(), 'janitor.command', callerInput);
    if (pending.status !== 'approval-required') throw new Error('expected an approval');
    callerInput.command = 'rm -rf /';
    await executor.resolve(pending.approval.id, 'approve');
    expect(invoke).toHaveBeenCalledWith('run_janitor_command', {
      target: 'local',
      command: 'df -h',
    });
  });
});

describe('janitor approval surface', () => {
  it('names the target and the exact command in the approval summary', async () => {
    const { executor } = harness();
    const pending = await executor.execute(agentWith(), 'janitor.command', {
      target: 'unraid',
      command: 'docker system prune -af',
    });
    if (pending.status !== 'approval-required') throw new Error('expected an approval');
    const description = describeApproval({
      toolId: pending.approval.toolId,
      toolName: pending.approval.toolName,
      input: pending.approval.input,
      agentName: pending.approval.agentName,
    });
    expect(description.headline).toBe('Run Janitor command on unraid');
    expect(description.details).toContain('Command · docker system prune -af');
    expect(formatApprovalText(description)).toContain('docker system prune -af');
  });

  it('never carries the sudo password into the approval record, summary or tool arguments', async () => {
    requestSudoPassword.mockResolvedValue('hunter2');
    const { executor, approvals } = harness();
    const pending = await executor.execute(agentWith(), 'janitor.command', {
      target: 'local',
      command: 'sudo systemctl restart docker',
    });
    if (pending.status !== 'approval-required') throw new Error('expected an approval');

    // The password prompt only happens after the decision, so nothing before execution can hold it.
    expect(requestSudoPassword).not.toHaveBeenCalled();
    const stored = await approvals.get(pending.approval.id);
    const rendered = JSON.stringify(stored);
    expect(rendered).not.toContain('hunter2');
    expect(rendered).not.toContain('sudoPassword');

    await executor.resolve(pending.approval.id, 'approve');
    expect(requestSudoPassword).toHaveBeenCalledWith('sudo systemctl restart docker');
    const afterExecution = JSON.stringify(await approvals.get(pending.approval.id));
    expect(afterExecution).not.toContain('hunter2');
    // The password reaches the backend as a separate invoke argument and nowhere else.
    const invokeArgs = invoke.mock.calls.map((call) => JSON.stringify(call[1] ?? {}));
    expect(invokeArgs).toHaveLength(1);
    expect(invokeArgs[0]).toContain('sudoPassword');
    expect(invokeArgs[0]).toContain('hunter2');
  });

  it('runs nothing and stores no credential when the sudo prompt is cancelled', async () => {
    requestSudoPassword.mockResolvedValue(null);
    const { executor, approvals } = harness();
    const pending = await executor.execute(agentWith(), 'janitor.command', {
      target: 'local',
      command: 'sudo reboot',
    });
    if (pending.status !== 'approval-required') throw new Error('expected an approval');
    await expect(executor.resolve(pending.approval.id, 'approve')).rejects.toThrow(
      /did not enter a sudo password/,
    );
    expect(invoke).not.toHaveBeenCalled();
    const stored = await approvals.get(pending.approval.id);
    expect(stored?.status).toBe('failed');
    const rendered = JSON.stringify(stored);
    expect(rendered).not.toContain('hunter2');
    expect(rendered).toContain('did not enter a sudo password');
  });
});
