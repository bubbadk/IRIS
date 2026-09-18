import { describe, expect, it } from 'vitest';
import {
  GatedToolExecutor,
  StaticPermissionEngine,
  ToolRegistry,
  snapshotApprovalInput,
  type RegisteredTool,
  type ToolApprovalRepository,
  type ToolApprovalRequest,
  type ToolApprovalStatus,
} from './index';

/**
 * A repository that stores whatever the executor hands it and returns shallow copies — the weakest
 * shape a real repository can take. The binding guarantee must not depend on the repository.
 */
class WeakApprovalRepository implements ToolApprovalRepository {
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
    this.requests.splice(0, this.requests.length);
  }
}

const agent = {
  id: 'agent-1',
  name: 'Operator',
  autonomy: 'act' as const,
  approvalMode: 'yolo' as const,
  skillIds: [],
  toolIds: ['shell.exec'],
};

function harness() {
  const executed: unknown[] = [];
  const registry = new ToolRegistry();
  const tool: RegisteredTool = {
    id: 'shell.exec',
    name: 'Shell execute',
    description: 'Runs one command.',
    risk: 'execute',
    alwaysRequireApproval: true,
    async run(input) {
      executed.push(input);
      return { ok: true };
    },
  };
  registry.register(tool);
  const approvals = new WeakApprovalRepository();
  const executor = new GatedToolExecutor(
    registry,
    new StaticPermissionEngine([]),
    approvals,
    () => 'approval-1',
    () => new Date('2026-01-01T00:00:00.000Z'),
  );
  return { executor, approvals, executed };
}

describe('approved invocations are immutable', () => {
  it('executes exactly the arguments the user approved, not the caller‘s later mutation', async () => {
    const { executor, executed, approvals } = harness();
    const callerInput: Record<string, unknown> = {
      command: 'rm -rf build',
      isolation: 'host',
    };
    const pending = await executor.execute(agent, 'shell.exec', callerInput);
    expect(pending.status).toBe('approval-required');

    // The caller (or a model that produced the call) keeps its object and rewrites it between the
    // prompt and the decision. The approved operation must not change.
    callerInput.command = 'rm -rf /';
    callerInput.isolation = 'host';

    const result = await executor.resolve('approval-1', 'approve');
    expect(result.status).toBe('completed');
    expect(executed).toEqual([{ command: 'rm -rf build', isolation: 'host' }]);
    const stored = await approvals.get('approval-1');
    expect((stored?.input as Record<string, unknown>).command).toBe('rm -rf build');
  });

  it('detaches the stored input from the object it was created from', async () => {
    const { executor, approvals } = harness();
    const callerInput = { command: 'echo one', nested: { list: ['a'] } };
    const pending = await executor.execute(agent, 'shell.exec', callerInput);
    if (pending.status !== 'approval-required') throw new Error('expected an approval');
    expect(pending.approval.input).not.toBe(callerInput);
    expect((pending.approval.input as typeof callerInput).nested).not.toBe(callerInput.nested);

    callerInput.nested.list.push('b');
    const stored = await approvals.get('approval-1');
    expect((stored?.input as typeof callerInput).nested.list).toEqual(['a']);
  });

  it('cannot be mutated through the record handed to the caller', async () => {
    const { executor, executed } = harness();
    const pending = await executor.execute(agent, 'shell.exec', { command: 'echo approved' });
    if (pending.status !== 'approval-required') throw new Error('expected an approval');

    // The record that reaches a session or a UI never aliases the invocation the executor stored,
    // so mutating it — accidentally or otherwise — cannot change what runs.
    (pending.approval.input as Record<string, unknown>).command = 'echo tampered';

    await executor.resolve('approval-1', 'approve');
    expect(executed).toEqual([{ command: 'echo approved' }]);
  });

  it('snapshots plain values, deep structures and cycles', () => {
    expect(snapshotApprovalInput('text')).toBe('text');
    expect(snapshotApprovalInput(42)).toBe(42);
    expect(snapshotApprovalInput(null)).toBeNull();
    const nested = { a: [{ b: 1 }] };
    const clone = snapshotApprovalInput(nested) as typeof nested;
    expect(clone).toEqual(nested);
    expect(clone.a[0]).not.toBe(nested.a[0]);
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    const circularClone = snapshotApprovalInput(circular) as Record<string, unknown>;
    expect(circularClone.name).toBe('loop');
    expect(circularClone.self).toBe(circularClone);
  });

  it('fails closed rather than executing an invocation that cannot be captured', () => {
    const uncapturable: Record<string, unknown> = { run: () => undefined };
    uncapturable.itself = uncapturable;
    // A function may not be captured by either copy strategy, so approval creation refuses instead
    // of holding a live reference to the caller's object.
    expect(() => snapshotApprovalInput(uncapturable)).toThrow(/cannot be captured/);
  });
});
