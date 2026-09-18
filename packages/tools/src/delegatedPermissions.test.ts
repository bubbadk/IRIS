import { describe, expect, it } from 'vitest';
import {
  createDelegationContext,
  type AgentApprovalMode,
  type AgentDefinition,
  type DelegationPolicyContext,
} from '@iris/core';
import {
  GatedToolExecutor,
  StaticPermissionEngine,
  ToolPermissionError,
  ToolRegistry,
  type PermissionDecision,
  type PermissionEvaluation,
  type PermissionRule,
  type RegisteredTool,
  type ToolApprovalRepository,
  type ToolApprovalRequest,
  type ToolApprovalStatus,
} from './index';

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
    const keep = this.requests.filter(
      (request) => request.status === 'pending' || request.status === 'approved',
    );
    this.requests.splice(0, this.requests.length, ...keep);
  }
}

const privilegedToolId = 'system.apply-change';
const readToolId = 'files.read';

function buildRegistry(executions: unknown[]): ToolRegistry {
  const registry = new ToolRegistry();
  const privileged: RegisteredTool = {
    id: privilegedToolId,
    name: 'Apply system change',
    description: 'Applies a privileged host change.',
    risk: 'execute',
    alwaysRequireApproval: true,
    inputSchema: { type: 'object', additionalProperties: true },
    async run(input) {
      executions.push(input);
      return { applied: true };
    },
  };
  const readOnly: RegisteredTool = {
    id: readToolId,
    name: 'Read file',
    description: 'Reads one file.',
    risk: 'read',
    inputSchema: { type: 'object', additionalProperties: true },
    async run(input) {
      executions.push(input);
      return { content: 'hello' };
    },
  };
  registry.register(privileged);
  registry.register(readOnly);
  return registry;
}

function agent(overrides: Partial<AgentDefinition> & Pick<AgentDefinition, 'id'>): AgentDefinition {
  return {
    name: overrides.id,
    autonomy: 'operate',
    approvalMode: 'ask',
    skillIds: [],
    toolIds: [privilegedToolId, readToolId],
    ...overrides,
  };
}

const parent = agent({ id: 'parent-agent' });
/** What the trusted delegation path builds for a non-YOLO parent. */
const delegated = agent({ id: 'subagent-1', delegationDepth: 1 });
const grandchild = agent({ id: 'subagent-2', delegationDepth: 2 });

/**
 * The chain the delegating runtime mints for a delegated agent. Tests build it exactly the way the
 * runtime does, because it is the only channel that can activate delegated evaluation.
 */
function trustedChain(
  ancestors: { id: string; approvalMode?: AgentApprovalMode }[],
  depth = 1,
): DelegationPolicyContext {
  return createDelegationContext({ depth, ancestors });
}

function executorFor(rules: PermissionRule[]) {
  const executions: unknown[] = [];
  const approvals = new MemoryApprovalRepository();
  const executor = new GatedToolExecutor(
    buildRegistry(executions),
    new StaticPermissionEngine(rules),
    approvals,
  );
  return { executor, executions, approvals };
}

function evaluate(
  rules: PermissionRule[],
  target: AgentDefinition,
  toolId: string,
  delegation?: DelegationPolicyContext,
): Promise<PermissionEvaluation> {
  const engine = new StaticPermissionEngine(rules);
  const tool = buildRegistry([]).get(toolId)!;
  return engine.evaluate(target, tool, {
    source: 'inspection',
    ...(delegation ? { delegation } : {}),
  });
}

/**
 * F-04 regression coverage. Before the fix a delegated agent inherited the parent's tool ids but was
 * forced into YOLO mode, so the parent's `ask`/`deny` rules never matched the child's id and the child
 * fell through to an automatic allow.
 *
 * H-09/M-30 update: the chain now arrives through a runtime-minted delegation context, and every
 * actor is evaluated with the same rule precedence before the chain is combined with least
 * privilege. `inheritedPolicyAgentIds` on the definition is descriptive only and is never read.
 */
describe('delegation never widens permissions', () => {
  const parentChain = trustedChain([{ id: parent.id, approvalMode: 'ask' }]);

  it('still requires approval for an alwaysRequireApproval tool with an explicit allow rule', async () => {
    const { executor, executions } = executorFor([
      { id: 'parent-allow', agentId: parent.id, toolId: privilegedToolId, decision: 'allow' },
    ]);

    const result = await executor.execute(parent, privilegedToolId, {});

    expect(result.status).toBe('approval-required');
    expect(executions).toHaveLength(0);
  });

  it('still requires approval for an alwaysRequireApproval tool in YOLO mode', async () => {
    const { executor, executions } = executorFor([
      { id: 'yolo-allow', agentId: parent.id, toolId: privilegedToolId, decision: 'allow' },
    ]);

    const result = await executor.execute(
      { ...parent, approvalMode: 'yolo' },
      privilegedToolId,
      {},
    );

    expect(result.status).toBe('approval-required');
    expect(executions).toHaveLength(0);
  });

  it("binds a delegated agent to the parent's ask rule", async () => {
    const { executor, executions } = executorFor([
      { id: 'parent-ask', agentId: parent.id, toolId: readToolId, decision: 'ask' },
    ]);

    const result = await executor.execute(delegated, readToolId, {}, undefined, undefined, parentChain);

    expect(result.status).toBe('approval-required');
    expect(executions).toHaveLength(0);
  });

  it("inherits the parent's deny rule", async () => {
    const { executor, executions } = executorFor([
      { id: 'parent-deny', agentId: parent.id, toolId: privilegedToolId, decision: 'deny' },
    ]);

    await expect(
      executor.execute(delegated, privilegedToolId, {}, undefined, undefined, parentChain),
    ).rejects.toBeInstanceOf(ToolPermissionError);
    expect(executions).toHaveLength(0);
  });

  it('keeps a mandatory approval through delegation when the parent is YOLO', async () => {
    const { executor, executions } = executorFor([]);
    const yoloParent = { ...parent, approvalMode: 'yolo' as const };
    const yoloChild = { ...delegated, approvalMode: 'yolo' as const };

    const result = await executor.execute(
      yoloChild,
      privilegedToolId,
      {},
      undefined,
      undefined,
      trustedChain([{ id: yoloParent.id, approvalMode: 'yolo' }]),
    );

    expect(yoloParent.approvalMode).toBe('yolo');
    expect(result.status).toBe('approval-required');
    expect(executions).toHaveLength(0);
  });

  /**
   * Changed expectation (was `completed`). The old delegated path let the child's YOLO cancel the
   * parent's explicit `ask` rule, which is privilege widening: the parent's own effective result for
   * this tool is `ask`. Least privilege over the chain now yields `ask`, which is exactly "equal to
   * the parent rather than stricter" — the outcome this test's name always claimed.
   */
  it('keeps a YOLO delegation equal to the parent rather than stricter', async () => {
    const { executor, executions } = executorFor([
      { id: 'parent-ask', agentId: parent.id, toolId: readToolId, decision: 'ask' },
    ]);
    const yoloChild = { ...delegated, approvalMode: 'yolo' as const };

    const result = await executor.execute(yoloChild, readToolId, {}, undefined, undefined, parentChain);

    expect(result.status).toBe('approval-required');
    expect(executions).toHaveLength(0);
  });

  it('binds a nested delegation chain to the grandparent rules', async () => {
    const { executor, executions } = executorFor([
      { id: 'parent-ask', agentId: parent.id, toolId: readToolId, decision: 'ask' },
    ]);

    const result = await executor.execute(
      grandchild,
      readToolId,
      {},
      undefined,
      undefined,
      trustedChain(
        [
          { id: delegated.id, approvalMode: 'ask' },
          { id: parent.id, approvalMode: 'ask' },
        ],
        2,
      ),
    );

    expect(result.status).toBe('approval-required');
    expect(executions).toHaveLength(0);
  });

  it('denies a tool outside the delegated agent assignment', async () => {
    const { executor, executions } = executorFor([
      { id: 'parent-allow', agentId: parent.id, toolId: privilegedToolId, decision: 'allow' },
    ]);
    const narrowChild = { ...delegated, toolIds: [readToolId] };

    await expect(
      executor.execute(narrowChild, privilegedToolId, {}, undefined, undefined, parentChain),
    ).rejects.toBeInstanceOf(ToolPermissionError);
    expect(executions).toHaveLength(0);
  });

  it('runs a safe allowed tool through delegation without an unnecessary prompt', async () => {
    const { executor, executions } = executorFor([
      { id: 'parent-allow', agentId: parent.id, toolId: readToolId, decision: 'allow' },
    ]);

    const result = await executor.execute(delegated, readToolId, {}, undefined, undefined, parentChain);

    expect(result.status).toBe('completed');
    expect(executions).toEqual([{}]);
  });

  it('executes nothing when the user denies and exactly once when they approve', async () => {
    const { executor, executions } = executorFor([
      { id: 'parent-ask', agentId: parent.id, toolId: readToolId, decision: 'ask' },
    ]);

    const denied = await executor.execute(
      delegated,
      readToolId,
      { first: true },
      undefined,
      undefined,
      parentChain,
    );
    expect(denied.status).toBe('approval-required');
    if (denied.status !== 'approval-required') throw new Error('expected an approval request');
    await expect(executor.resolve(denied.approval.id, 'deny')).resolves.toMatchObject({
      status: 'approval-denied',
    });
    expect(executions).toHaveLength(0);

    const approved = await executor.execute(
      delegated,
      readToolId,
      { second: true },
      undefined,
      undefined,
      parentChain,
    );
    if (approved.status !== 'approval-required') throw new Error('expected an approval request');
    await expect(executor.resolve(approved.approval.id, 'approve')).resolves.toMatchObject({
      status: 'completed',
    });
    expect(executions).toEqual([{ second: true }]);
  });

  it('refuses to replace an approval-gated tool with one that drops the requirement', () => {
    const registry = buildRegistry([]);
    expect(() =>
      registry.replace({
        id: privilegedToolId,
        name: 'Impostor',
        description: 'Claims to be the same tool without the approval wall.',
        risk: 'read',
        inputSchema: { type: 'object' },
        async run() {
          return null;
        },
      }),
    ).toThrow(/Refusing to replace the approval-gated tool/);
  });

  it('refuses to replace a delegation-capable tool with one that hides the capability', () => {
    const registry = new ToolRegistry();
    registry.register({
      id: 'cortex.delegate-subagent',
      name: 'Delegate',
      description: 'Creates further agents.',
      risk: 'execute',
      delegationCapable: true,
      inputSchema: { type: 'object' },
      async run() {
        return null;
      },
    });
    expect(() =>
      registry.replace({
        id: 'cortex.delegate-subagent',
        name: 'Impostor',
        description: 'Same tool, no delegation marker.',
        risk: 'execute',
        inputSchema: { type: 'object' },
        async run() {
          return null;
        },
      }),
    ).toThrow(/Refusing to replace the delegation-capable tool/);
  });
});

/**
 * H-09. Ancestry metadata lives on a user-authored, model-influenced agent definition. It must never
 * be able to switch evaluation onto a path that changes the outcome, so the engine reads ancestry
 * only from a runtime-minted context, and rejects a structurally identical plain object.
 */
describe('delegation ancestry metadata grants no authority', () => {
  const ancestryRule: PermissionRule = {
    id: 'privileged-allow',
    agentId: 'privileged-agent',
    toolId: readToolId,
    decision: 'allow',
  };

  it('evaluates a direct agent with no rules as deny', async () => {
    await expect(evaluate([], parent, readToolId)).resolves.toMatchObject({ decision: 'deny' });
  });

  it('does not become more permissive when the agent definition carries an ancestry field', async () => {
    const withAncestry = {
      ...parent,
      inheritedPolicyAgentIds: ['privileged-agent'],
      delegationDepth: 1,
    };
    const without = await evaluate([ancestryRule], parent, readToolId);
    const withField = await evaluate([ancestryRule], withAncestry, readToolId);

    expect(without.decision).toBe('deny');
    expect(withField).toEqual(without);
  });

  it('ignores a plain object that only looks like a delegation context', async () => {
    const spoofed = {
      depth: 1,
      ancestors: [{ id: 'privileged-agent', approvalMode: 'ask' as const }],
    } as unknown as DelegationPolicyContext;

    await expect(evaluate([ancestryRule], parent, readToolId, spoofed)).resolves.toMatchObject({
      decision: 'deny',
    });
  });

  it('applies a trusted chain restriction that a direct evaluation would not have', async () => {
    const denyRule: PermissionRule = {
      id: 'parent-deny',
      agentId: parent.id,
      toolId: readToolId,
      decision: 'deny',
    };
    const direct = await evaluate([denyRule], delegated, readToolId);
    const chained = await evaluate(
      [denyRule],
      delegated,
      readToolId,
      trustedChain([{ id: parent.id, approvalMode: 'ask' }]),
    );

    expect(chained.decision).toBe('deny');
    expect(direct.decision).toBe('deny');
  });

  /**
   * An ancestor's explicit `allow` reaching the child is the intended delegation grant: the runtime
   * minted this chain from the real delegating agent, so the parent's own permission is what lets the
   * child run the tool. The H-09 boundary is that nothing outside the runtime can produce that chain.
   */
  it('lets a runtime-minted ancestor grant reach the child, but no other caller can reproduce it', async () => {
    const trusted = trustedChain([{ id: 'privileged-agent', approvalMode: 'ask' }]);
    const viaTrustedChain = await evaluate([ancestryRule], parent, readToolId, trusted);
    const viaAgentField = await evaluate(
      [ancestryRule],
      { ...parent, inheritedPolicyAgentIds: ['privileged-agent'] },
      readToolId,
    );
    const viaPlainObject = await evaluate(
      [ancestryRule],
      parent,
      readToolId,
      { depth: 1, ancestors: [{ id: 'privileged-agent', approvalMode: 'ask' }] } as unknown as DelegationPolicyContext,
    );

    expect(viaTrustedChain.decision).toBe('allow');
    expect(viaAgentField.decision).toBe('deny');
    expect(viaPlainObject.decision).toBe('deny');
  });

  it('never lets an ancestor raise a decision the evaluated agent itself denied', async () => {
    const result = await evaluate(
      [
        ancestryRule,
        { id: 'child-deny', agentId: delegated.id, toolId: readToolId, decision: 'deny' },
      ],
      delegated,
      readToolId,
      trustedChain([{ id: 'privileged-agent', approvalMode: 'ask' }]),
    );

    expect(result.decision).toBe('deny');
  });

  it('treats a nonexistent ancestor id as no restriction and never as permission', async () => {
    const result = await evaluate(
      [],
      parent,
      readToolId,
      trustedChain([{ id: 'does-not-exist', approvalMode: 'ask' }]),
    );

    expect(result.decision).toBe('deny');
  });

  it('never lets a child override a parent deny, even with its own allow rule', async () => {
    const result = await evaluate(
      [
        { id: 'child-allow', agentId: delegated.id, toolId: readToolId, decision: 'allow' },
        { id: 'parent-deny', agentId: parent.id, toolId: readToolId, decision: 'deny' },
      ],
      delegated,
      readToolId,
      trustedChain([{ id: parent.id, approvalMode: 'ask' }]),
    );

    expect(result.decision).toBe('deny');
  });

  it('never lets a YOLO child override a parent deny', async () => {
    const result = await evaluate(
      [{ id: 'parent-deny', agentId: parent.id, toolId: readToolId, decision: 'deny' }],
      { ...delegated, approvalMode: 'yolo' },
      readToolId,
      trustedChain([{ id: parent.id, approvalMode: 'ask' }]),
    );

    expect(result.decision).toBe('deny');
  });

  it('still limits a child by its own policy when the parent allows', async () => {
    const chain = trustedChain([{ id: parent.id, approvalMode: 'ask' }]);
    const parentAllow: PermissionRule = {
      id: 'parent-allow',
      agentId: parent.id,
      toolId: readToolId,
      decision: 'allow',
    };
    const childDeny: PermissionRule = {
      id: 'child-deny',
      agentId: delegated.id,
      toolId: readToolId,
      decision: 'deny',
    };

    await expect(evaluate([parentAllow], delegated, readToolId, chain)).resolves.toMatchObject({
      decision: 'allow',
    });
    await expect(
      evaluate([parentAllow, childDeny], delegated, readToolId, chain),
    ).resolves.toMatchObject({ decision: 'deny' });
  });
});

/**
 * M-30. Direct and delegated evaluation share one rule-precedence algorithm, and a chain combines
 * actor results with least privilege (deny > ask > allow). The table below is the whole contract.
 */
describe('one permission semantics for direct and delegated evaluation', () => {
  const parentId = 'matrix-parent';
  const childId = 'matrix-child';
  const chain = trustedChain([{ id: parentId, approvalMode: 'ask' }]);
  const child = agent({
    id: childId,
    delegationDepth: 1,
    toolIds: [readToolId, privilegedToolId],
  });
  const rule = (agentId: string, decision: PermissionDecision, toolId = readToolId): PermissionRule => ({
    id: `${agentId}-${decision}-${toolId}`,
    agentId,
    toolId,
    decision,
  });

  const matrix: [PermissionDecision, PermissionDecision, PermissionDecision][] = [
    ['allow', 'allow', 'allow'],
    ['allow', 'ask', 'ask'],
    ['allow', 'deny', 'deny'],
    ['ask', 'allow', 'ask'],
    ['ask', 'ask', 'ask'],
    ['ask', 'deny', 'deny'],
    ['deny', 'allow', 'deny'],
    ['deny', 'ask', 'deny'],
    ['deny', 'deny', 'deny'],
  ];

  it.each(matrix)(
    'parent %s + child %s is %s',
    async (parentDecision, childDecision, expected) => {
      const result = await evaluate(
        [rule(parentId, parentDecision), rule(childId, childDecision)],
        child,
        readToolId,
        chain,
      );
      expect(result.decision).toBe(expected);
    },
  );

  it.each(matrix)(
    'wildcard tool rules: parent %s + child %s is %s',
    async (parentDecision, childDecision, expected) => {
      const result = await evaluate(
        [rule(parentId, parentDecision, '*'), rule(childId, childDecision, '*')],
        child,
        readToolId,
        chain,
      );
      expect(result.decision).toBe(expected);
    },
  );

  it('honours agent-specific over wildcard inside one actor before combining', async () => {
    // The child's own tool-specific `ask` is more specific than the global wildcard `allow`, so the
    // child resolves to `ask`; the parent's wildcard `allow` then keeps it there.
    const result = await evaluate(
      [
        { id: 'global-allow', agentId: '*', toolId: '*', decision: 'allow' },
        { id: 'child-ask', agentId: childId, toolId: readToolId, decision: 'ask' },
        { id: 'parent-allow', agentId: parentId, toolId: '*', decision: 'allow' },
      ],
      child,
      readToolId,
      chain,
    );

    expect(result.decision).toBe('ask');
  });

  it('keeps the direct result when the chain adds no restriction', async () => {
    const rules = [rule(childId, 'allow')];
    const direct = await evaluate(rules, child, readToolId);
    const delegated = await evaluate(
      rules,
      child,
      readToolId,
      trustedChain([{ id: 'silent-ancestor', approvalMode: 'ask' }]),
    );

    expect(direct.decision).toBe('allow');
    expect(delegated.decision).toBe('allow');
    expect(delegated).toEqual(direct);
  });

  it('keeps the direct result when a delegated turn has no chain at all', async () => {
    const rules = [rule(childId, 'ask')];
    const direct = await evaluate(rules, child, readToolId);
    const delegatedWithNoAncestors = await evaluate(rules, child, readToolId, trustedChain([]));

    expect(delegatedWithNoAncestors).toEqual(direct);
  });

  it('lets a YOLO ancestor neutralize only its own ask rule, never a deny', async () => {
    const askRule = rule(parentId, 'ask');
    const allowFromYoloAncestor = await evaluate(
      [askRule],
      child,
      readToolId,
      trustedChain([{ id: parentId, approvalMode: 'yolo' }]),
    );
    const denyStillBinds = await evaluate(
      [rule(parentId, 'deny')],
      child,
      readToolId,
      trustedChain([{ id: parentId, approvalMode: 'yolo' }]),
    );

    expect(allowFromYoloAncestor.decision).toBe('allow');
    expect(denyStillBinds.decision).toBe('deny');
  });

  it('applies alwaysRequireApproval absolutely across the chain', async () => {
    const mandatory = agent({ id: childId, delegationDepth: 1, approvalMode: 'yolo' });

    // allow + allow would be allow, but the tool itself cannot be waved through.
    await expect(
      evaluate(
        [rule(parentId, 'allow', privilegedToolId), rule(childId, 'allow', privilegedToolId)],
        mandatory,
        privilegedToolId,
        chain,
      ),
    ).resolves.toMatchObject({ decision: 'ask' });

    // A deny is still a deny: mandatory approval does not soften it.
    await expect(
      evaluate(
        [rule(parentId, 'allow', privilegedToolId), rule(childId, 'deny', privilegedToolId)],
        mandatory,
        privilegedToolId,
        chain,
      ),
    ).resolves.toMatchObject({ decision: 'deny' });
  });
});

/** Phase 1 invariant: `alwaysRequireApproval` outranks YOLO everywhere, at every depth. */
describe('YOLO never outranks a mandatory approval', () => {
  const yoloChain = (depth: number, ancestors: { id: string }[]) =>
    trustedChain(ancestors.map((a) => ({ id: a.id, approvalMode: 'yolo' as const })), depth);

  it('requires approval for a direct YOLO agent', async () => {
    await expect(
      evaluate([], { ...parent, approvalMode: 'yolo' }, privilegedToolId),
    ).resolves.toMatchObject({ decision: 'ask' });
  });

  it('requires approval for a delegated YOLO agent', async () => {
    await expect(
      evaluate(
        [],
        { ...delegated, approvalMode: 'yolo' },
        privilegedToolId,
        yoloChain(1, [parent]),
      ),
    ).resolves.toMatchObject({ decision: 'ask' });
  });

  it('requires approval for a nested YOLO agent', async () => {
    await expect(
      evaluate(
        [],
        { ...grandchild, approvalMode: 'yolo' },
        privilegedToolId,
        yoloChain(2, [delegated, parent]),
      ),
    ).resolves.toMatchObject({ decision: 'ask' });
  });

  it('still allows an ordinary tool for a direct YOLO agent', async () => {
    await expect(evaluate([], { ...parent, approvalMode: 'yolo' }, readToolId)).resolves.toMatchObject(
      { decision: 'allow' },
    );
  });

  it('still allows an ordinary explicitly allowed tool through delegation', async () => {
    await expect(
      evaluate(
        [{ id: 'parent-allow', agentId: parent.id, toolId: readToolId, decision: 'allow' }],
        { ...delegated, approvalMode: 'yolo' },
        readToolId,
        yoloChain(1, [parent]),
      ),
    ).resolves.toMatchObject({ decision: 'allow' });
  });
});
