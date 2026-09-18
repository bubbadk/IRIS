import { describe, expect, it } from 'vitest';
import {
  createDelegationContext,
  validateAgentDefinition,
  type AgentDefinition,
  type DelegationPolicyContext,
} from '@iris/core';
import type {
  AgentProviderResolver,
  AgentRepository,
  AgentToolRuntime,
  SuspendedAgentTurn,
  SuspendedAgentTurnRepository,
} from '@iris/agents';
import { AgentSession } from '@iris/agents';
import type { ModelChunk, ModelMessage, ModelProvider } from '@iris/providers';
import {
  GatedToolExecutor,
  StaticPermissionEngine,
  ToolPermissionError,
  ToolRegistry,
  type PermissionRule,
  type RegisteredTool,
  type ToolApprovalRepository,
  type ToolApprovalRequest,
  type ToolApprovalStatus,
} from '@iris/tools';
import {
  assignSubAgentTools,
  createSubAgentTeamTool,
  createSubAgentTool,
  hasPrivilegeArguments,
  validateSubAgentTeamInput,
  validateSubAgentInput,
  subAgentTeamToolId,
  subAgentToolId,
  type SubAgentLifecycleStatus,
  type SubAgentToolOptions,
  type SubAgentToolOutput,
} from './subagentTool';

const privilegedToolId = 'shell.exec';
const readToolId = 'files.read';
/** Rule-gated only: no alwaysRequireApproval, so its protection comes purely from the ask rule. */
const ruleGatedToolId = 'system.configure';

const delegateCallName = 'cortex_delegate_subagent';
const teamCallName = 'cortex_delegate_team';

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

/** Mirrors `LocalSuspendedAgentTurnRepository`: one turn per agent, keyed by agent or turn id. */
class MemorySuspendedTurnRepository implements SuspendedAgentTurnRepository {
  readonly turns: SuspendedAgentTurn[] = [];

  async getByAgentId(agentId: string) {
    return this.turns.find((turn) => turn.agentId === agentId) ?? null;
  }

  async list() {
    return [...this.turns];
  }

  async getByApprovalId(approvalId: string) {
    return (
      this.turns.find(
        (turn) => turn.pending.kind === 'tool-approval' && turn.pending.approval.id === approvalId,
      ) ?? null
    );
  }

  async save(turn: SuspendedAgentTurn) {
    const index = this.turns.findIndex(
      (stored) =>
        stored.agentId === turn.agentId || stored.pending.turnId === turn.pending.turnId,
    );
    if (index === -1) this.turns.push(turn);
    else this.turns[index] = turn;
  }

  async removeByTurnId(turnId: string) {
    const index = this.turns.findIndex((turn) => turn.pending.turnId === turnId);
    if (index !== -1) this.turns.splice(index, 1);
  }
}

type ScriptStep = { text: string } | { call: string; input?: unknown };

let callSequence = 0;

function chunksFor(steps: ScriptStep[]): ModelChunk[] {
  return steps.map((step, index) => {
    const last = index === steps.length - 1;
    if ('call' in step) {
      callSequence += 1;
      return {
        text: '',
        done: last,
        ...(last
          ? {
              toolCalls: [
                { id: `call-${callSequence}`, name: step.call, input: step.input ?? {} },
              ],
            }
          : {}),
      };
    }
    return { text: step.text, done: last };
  });
}

/**
 * A provider whose next round is decided by the message history rather than an internal counter, so
 * it behaves identically when the runtime resolves a fresh provider instance to resume a turn.
 */
function planProvider(
  plan: (toolResults: ModelMessage[], request: { tools?: unknown[] }) => ScriptStep[],
): ModelProvider {
  return {
    definition: {
      id: 'mock-provider',
      name: 'Mock Provider',
      kind: 'openai-compatible',
      capabilities: ['chat', 'streaming', 'tools'],
      local: true,
    },
    capabilities: () => ['chat', 'streaming', 'tools'],
    testConnection: async () => {},
    async *stream(request) {
      const toolResults = request.messages.filter((message) => message.role === 'tool');
      for (const chunk of chunksFor(plan(toolResults, request))) yield chunk;
    },
  };
}

/** Binds the plan to the delegated agent's depth, exactly as the runtime resolves providers. */
function depthScriptedResolver(
  plan: (depth: number, toolResults: ModelMessage[]) => ScriptStep[],
): AgentProviderResolver['resolve'] {
  return async (agent, suspended) => {
    const depth =
      (suspended ? undefined : agent.delegationDepth) ??
      agent.delegationDepth ??
      0;
    return { provider: planProvider((toolResults) => plan(depth, toolResults)), model: 'mock-model' };
  };
}

function textOnlyResolver(text: string): AgentProviderResolver['resolve'] {
  return async () => ({ provider: planProvider(() => [{ text }]), model: 'mock-model' });
}

function repositoryFor(agents: AgentDefinition[]): AgentRepository {
  return {
    list: async () => agents,
    get: async (id) => agents.find((candidate) => candidate.id === id) ?? null,
    save: async (agent) => {
      if (!agents.some((candidate) => candidate.id === agent.id)) agents.push(agent);
    },
    remove: async () => {},
  };
}

interface HarnessConfig {
  resolve: AgentProviderResolver['resolve'];
  rules?: PermissionRule[];
  agents?: AgentDefinition[];
  maxRecursionDepth?: number;
  extraTools?: RegisteredTool[];
  agentRepository?: AgentRepository;
}

interface DelegationHarness {
  registry: ToolRegistry;
  executor: GatedToolExecutor;
  runtime: AgentToolRuntime;
  approvals: MemoryApprovalRepository;
  suspended: MemorySuspendedTurnRepository;
  executions: unknown[];
  seen: { agent: AgentDefinition; delegation?: DelegationPolicyContext }[];
  denials: string[];
  options: SubAgentToolOptions;
}

/**
 * The real delegation wiring: registry → `GatedToolExecutor` → `StaticPermissionEngine`, with an
 * `AgentToolRuntime` that forwards the invoking agent and its trusted delegation chain exactly like
 * the desktop runtime does.
 */
function createDelegationHarness(config: HarnessConfig): DelegationHarness {
  const executions: unknown[] = [];
  const approvals = new MemoryApprovalRepository();
  const suspended = new MemorySuspendedTurnRepository();
  const seen: { agent: AgentDefinition; delegation?: DelegationPolicyContext }[] = [];
  const denials: string[] = [];
  const registry = new ToolRegistry();

  registry.register({
    id: privilegedToolId,
    name: 'Run command in workspace',
    description: 'Runs a shell command. Always requires approval.',
    risk: 'execute',
    alwaysRequireApproval: true,
    providerName: 'shell_exec',
    inputSchema: { type: 'object', additionalProperties: true },
    async run(input) {
      executions.push(input);
      return { exitCode: 0 };
    },
  });
  registry.register({
    id: readToolId,
    name: 'Read file',
    description: 'Reads one file.',
    risk: 'read',
    providerName: 'files_read',
    inputSchema: { type: 'object', additionalProperties: true },
    async run(input) {
      executions.push(input);
      return { content: 'hello' };
    },
  });
  registry.register({
    id: ruleGatedToolId,
    name: 'Configure system',
    description: 'Applies a configuration change that an ask rule protects.',
    risk: 'execute',
    providerName: 'system_configure',
    inputSchema: { type: 'object', additionalProperties: true },
    async run(input) {
      executions.push(input);
      return { configured: true };
    },
  });
  for (const tool of config.extraTools ?? []) registry.register(tool);

  const executor = new GatedToolExecutor(
    registry,
    new StaticPermissionEngine(config.rules ?? []),
    approvals,
  );

  const runtime: AgentToolRuntime = {
    definitions: (agent) =>
      registry
        .list()
        .filter((tool) => agent.toolIds.includes(tool.id))
        .map((tool) => ({
          name: tool.providerName ?? tool.id,
          description: tool.description,
          inputSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true },
        })),
    async execute(agent, toolName, input, invocation, signal, delegation) {
      seen.push({ agent, ...(delegation ? { delegation } : {}) });
      const definition = registry
        .list()
        .find((candidate) => (candidate.providerName ?? candidate.id) === toolName);
      if (!definition) throw new Error(`Model requested an unknown tool: ${toolName}`);
      try {
        const result = await executor.execute(
          agent,
          definition.id,
          input,
          signal,
          invocation,
          delegation,
        );
        if (result.status === 'approval-required') {
          return {
            status: 'approval-required',
            approval: {
              id: result.approval.id,
              toolId: result.approval.toolId,
              toolName: result.approval.toolName,
              reason: result.approval.evaluation.reason,
            },
          };
        }
        return { status: 'completed', output: result.output };
      } catch (error) {
        if (error instanceof ToolPermissionError) {
          denials.push(error.evaluation.reason);
          return { status: 'denied', reason: error.evaluation.reason };
        }
        return {
          status: 'failed',
          reason: error instanceof Error ? error.message : 'The tool failed.',
        };
      }
    },
    async resolve(approvalId, decision, signal) {
      const approval = await approvals.get(approvalId);
      if (!approval) throw new Error(`Unknown approval: ${approvalId}`);
      try {
        const result =
          decision === 'approve' && approval.status === 'approved'
            ? await executor.resume(approvalId, signal)
            : await executor.resolve(approvalId, decision, signal);
        return result.status === 'completed'
          ? { status: 'completed', output: result.output }
          : { status: 'approval-denied' };
      } catch (error) {
        return {
          status: 'failed',
          reason: error instanceof Error ? error.message : 'Approval resolution failed.',
        };
      }
    },
  };

  const options: SubAgentToolOptions = {
    agentRepository: config.agentRepository ?? repositoryFor(config.agents ?? []),
    providerResolver: { resolve: config.resolve },
    agentToolRuntime: runtime,
    suspendedTurns: suspended,
    toolRegistry: registry,
    ...(config.maxRecursionDepth !== undefined
      ? { maxRecursionDepth: config.maxRecursionDepth }
      : {}),
  };

  // Register proxies so nested delegation passes through the real permission engine exactly like
  // production, where both delegation tools live in the shared registry.
  const holder: { single?: RegisteredTool; team?: RegisteredTool } = {};
  const proxy = (tool: RegisteredTool, providerName: string): RegisteredTool => ({
    id: tool.id,
    name: providerName,
    description: tool.description,
    risk: tool.risk,
    providerName,
    delegationCapable: true,
    inputSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true },
    run: (input, context) => tool.run(input, context),
  });
  holder.single = createSubAgentTool(options);
  holder.team = createSubAgentTeamTool(options);
  registry.register(proxy(holder.single, delegateCallName));
  registry.register(proxy(holder.team, teamCallName));

  return {
    registry,
    executor,
    runtime,
    approvals,
    suspended,
    seen,
    denials,
    executions,
    options,
  };
}

function delegationAllowRules(agentId: string): PermissionRule[] {
  return [
    { id: `${agentId}-delegate`, agentId, toolId: subAgentToolId, decision: 'allow' },
    { id: `${agentId}-team`, agentId, toolId: subAgentTeamToolId, decision: 'allow' },
  ];
}

function rootAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'root-agent',
    name: 'Root agent',
    providerPolicyId: 'mock-provider',
    model: 'mock-model',
    autonomy: 'operate',
    approvalMode: 'ask',
    toolIds: [subAgentToolId, subAgentTeamToolId, readToolId, ruleGatedToolId, privilegedToolId],
    skillIds: [],
    ...overrides,
  };
}

async function collect(events: AsyncIterable<{ type: string }>): Promise<{ type: string }[]> {
  const collected: { type: string }[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

/** Runs the delegation tool the way the parent's session does, through the tool runtime bridge. */
async function delegateThroughRuntime(
  harness: DelegationHarness,
  agent: AgentDefinition,
  toolName: string,
  input: unknown,
  delegation?: DelegationPolicyContext,
): Promise<SubAgentToolOutput> {
  const result = await harness.runtime.execute(
    agent,
    toolName,
    input,
    { turnId: 'turn-1', toolCallId: 'parent-call-1' },
    undefined,
    delegation,
  );
  if (result.status !== 'completed') {
    throw new Error(`Delegation did not run: ${JSON.stringify(result)}`);
  }
  return result.output as SubAgentToolOutput;
}

describe('subagentTool input validation', () => {
  it('accepts valid sub-agent input with role, objective and instructions', () => {
    expect(
      validateSubAgentInput({
        role: 'Code Reviewer',
        objective: 'Review security rules',
        instructions: 'Check for open write access',
      }),
    ).toBe(true);
  });

  it('rejects missing or empty required fields', () => {
    expect(validateSubAgentInput(null)).toBe(false);
    expect(validateSubAgentInput({})).toBe(false);
    expect(
      validateSubAgentInput({
        role: '',
        objective: 'Analyze',
        instructions: 'Do work',
      }),
    ).toBe(false);
    expect(
      validateSubAgentInput({
        role: 'Researcher',
        objective: '',
        instructions: 'Do work',
      }),
    ).toBe(false);
  });

  it('rejects every privilege and delegation field a model might try to set', () => {
    for (const privileged of [
      { approvalMode: 'yolo' },
      { toolIds: ['shell.exec'] },
      { _depth: 0 },
      { inheritedPolicyAgentIds: ['someone-else'] },
      { delegationDepth: 0 },
      { delegationChain: { depth: 0, ancestors: [] } },
      { ancestors: [{ id: 'root-agent' }] },
      { agent: { id: 'root-agent' } },
    ]) {
      expect(
        hasPrivilegeArguments({
          role: 'Sneaky',
          objective: 'Escalate',
          instructions: 'Try',
          ...privileged,
        }),
      ).toBe(true);
      expect(
        validateSubAgentInput({
          role: 'Sneaky',
          objective: 'Escalate',
          instructions: 'Try',
          ...privileged,
        }),
      ).toBe(false);
    }
  });
});

describe('subagentTeamTool input validation', () => {
  it('accepts a non-empty tasks array with valid members', () => {
    expect(
      validateSubAgentTeamInput({
        tasks: [
          { role: 'Researcher', objective: 'Find facts', instructions: 'Search the web' },
          { role: 'Reviewer', objective: 'Review draft', instructions: 'Check claims' },
        ],
      }),
    ).toBe(true);
  });

  it('rejects empty or malformed task arrays', () => {
    expect(validateSubAgentTeamInput({ tasks: [] })).toBe(false);
    expect(validateSubAgentTeamInput({ tasks: 'nope' })).toBe(false);
    expect(validateSubAgentTeamInput(null)).toBe(false);
    expect(
      validateSubAgentTeamInput({
        tasks: [{ role: '', objective: 'X', instructions: 'Y' }],
      }),
    ).toBe(false);
  });
});

/**
 * H-02. A delegated child turn that stops for approval is suspended, not finished. These tests drive
 * the delegation tool through the real tool runtime, so the child session, the permission engine and
 * the approval store are all the real ones.
 */
describe('subagent lifecycle truth (H-02)', () => {
  const task = { role: 'Operator', objective: 'Apply a change', instructions: 'Do it' };

  function lifecycleHarness(
    plan: (depth: number, toolResults: ModelMessage[]) => ScriptStep[],
    rules: PermissionRule[],
  ) {
    const agent = rootAgent();
    return {
      agent,
      harness: createDelegationHarness({
        resolve: depthScriptedResolver(plan),
        rules: [...delegationAllowRules(agent.id), ...rules],
        agents: [agent],
      }),
    };
  }

  /**
   * An `alwaysRequireApproval` tool reached under a non-YOLO agent still needs an explicit rule to
   * become `ask` — with no rule at all it is denied. This allow rule is what the mandatory-approval
   * wall then upgrades to `ask`, which is the suspension these tests exercise.
   */
  const privilegedAllow: PermissionRule = {
    id: 'root-privileged-allow',
    agentId: 'root-agent',
    toolId: privilegedToolId,
    decision: 'allow',
  };

  /** Test A: a read-only tool needs no approval, so the child genuinely completes. */
  it('reports completed when the child only runs an allowed read-only tool', async () => {
    const { agent, harness } = lifecycleHarness(
      (depth, toolResults) =>
        depth === 0
          ? [{ call: delegateCallName, input: task }]
          : toolResults.length === 0
            ? [{ text: 'Reading the file.' }, { call: 'files_read' }]
            : [{ text: 'Read complete.' }],
      [
        { id: 'parent-read-allow', agentId: 'root-agent', toolId: readToolId, decision: 'allow' },
      ],
    );

    const result = await delegateThroughRuntime(harness, agent, delegateCallName, task);

    expect(result.status).toBe('completed');
    // The agent loop accumulates every round's streamed text into one final reply.
    expect(result.output).toBe('Reading the file.Read complete.');
    expect(result.approvalId).toBeUndefined();
    expect(harness.approvals.requests).toHaveLength(0);
    expect(harness.executions).toEqual([{}]);
    expect(harness.suspended.turns).toHaveLength(0);
  });

  /** Test B: `alwaysRequireApproval` suspends the child. It is never reported as completed. */
  it('reports suspended, never completed, when the child hits a mandatory approval', async () => {
    const { agent, harness } = lifecycleHarness(
      (depth, toolResults) =>
        depth === 0
          ? [{ call: delegateCallName, input: task }]
          : toolResults.length === 0
            ? [{ call: 'shell_exec' }]
            : [{ text: 'Command finished.' }],
      [privilegedAllow],
    );

    const result = await delegateThroughRuntime(harness, agent, delegateCallName, task);

    expect(result.status).toBe('suspended');
    expect(result.status).not.toBe('completed');
    expect(result.pendingTool).toBe('Run command in workspace');
    expect(result.approvalId).toBeDefined();
    expect(harness.executions).toHaveLength(0);
    expect(harness.approvals.requests).toHaveLength(1);
    expect(harness.approvals.requests[0].status).toBe('pending');
  });

  /** Test C: denial runs nothing and leaves no false completion behind. */
  it('records a denial without running the tool and without a fabricated completion', async () => {
    const plan = (depth: number, toolResults: ModelMessage[]): ScriptStep[] =>
      depth === 0
        ? [{ call: delegateCallName, input: task }]
        : toolResults.length === 0
          ? [{ call: 'shell_exec' }]
          : [{ text: 'I could not run the command.' }];
    const { agent, harness } = lifecycleHarness(plan, [privilegedAllow]);

    const result = await delegateThroughRuntime(harness, agent, delegateCallName, task);
    if (!result.approvalId) throw new Error('expected a suspended delegation');
    expect(result.status).toBe('suspended');

    // The child turn is the owner: the same session resumes, not a loose tool execution.
    const persisted = await harness.suspended.getByApprovalId(result.approvalId);
    expect(persisted).not.toBeNull();
    const childAgent = persisted!.delegatedAgent!;
    const { provider } = await depthScriptedResolver(plan)(childAgent);
    const session = AgentSession.restore(
      childAgent,
      provider,
      persisted!,
      harness.runtime,
      createDelegationContext(persisted!.delegationChain!),
    );

    const events = await collect(session.resolveApproval(result.approvalId, 'deny'));

    expect(events.map((event) => event.type)).toContain('tool-denied');
    expect(events.map((event) => event.type)).toContain('assistant-complete');
    expect(harness.executions).toHaveLength(0);
  });

  /** Test D: approval runs the tool exactly once, and completion follows the resumed turn. */
  it('runs the approved tool exactly once and completes only after the child turn resumes', async () => {
    const plan = (depth: number, toolResults: ModelMessage[]): ScriptStep[] =>
      depth === 0
        ? [{ call: delegateCallName, input: task }]
        : toolResults.length === 0
          ? [{ call: 'shell_exec', input: { command: 'echo hi' } }]
          : [{ text: 'Command finished with the recorded result.' }];
    const { agent, harness } = lifecycleHarness(plan, [privilegedAllow]);

    const result = await delegateThroughRuntime(harness, agent, delegateCallName, task);
    if (!result.approvalId) throw new Error('expected a suspended delegation');
    expect(harness.executions).toHaveLength(0);

    const persisted = await harness.suspended.getByApprovalId(result.approvalId);
    expect(persisted).not.toBeNull();
    const childAgent = persisted!.delegatedAgent!;
    expect(validateAgentDefinition(childAgent)).toBe(true);
    expect(childAgent.delegationDepth).toBe(1);
    const { provider } = await depthScriptedResolver(plan)(childAgent);
    const session = AgentSession.restore(
      childAgent,
      provider,
      persisted!,
      harness.runtime,
      createDelegationContext(persisted!.delegationChain!),
    );

    const events = (await collect(
      session.resolveApproval(result.approvalId, 'approve'),
    )) as { type: string; message?: { content: string } }[];

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes[0]).toBe('tool-complete');
    expect(eventTypes.at(-1)).toBe('assistant-complete');
    expect(eventTypes).not.toContain('tool-approval-required');
    expect(harness.executions).toEqual([{ command: 'echo hi' }]);
    const completion = events.find((event) => event.type === 'assistant-complete');
    expect(completion?.message?.content).toBe('Command finished with the recorded result.');
  });

  /** Attack G: a second resolution attempt must not run the tool again. */
  it('refuses a duplicate approval resolution and keeps exactly one execution', async () => {
    const { agent, harness } = lifecycleHarness(
      (depth, toolResults) =>
        depth === 0
          ? [{ call: delegateCallName, input: task }]
          : toolResults.length === 0
            ? [{ call: 'shell_exec' }]
            : [{ text: 'Done.' }],
      [privilegedAllow],
    );

    const result = await delegateThroughRuntime(harness, agent, delegateCallName, task);
    if (!result.approvalId) throw new Error('expected a suspended delegation');

    const first = await harness.runtime.resolve(result.approvalId, 'approve');
    expect(first.status).toBe('completed');
    expect(harness.executions).toHaveLength(1);

    const second = await harness.runtime.resolve(result.approvalId, 'approve');
    expect(second.status).toBe('failed');
    expect(harness.executions).toHaveLength(1);
  });

  /** Test F: text streamed before the approval is partial progress, never the final report. */
  it('keeps pre-approval text as partial output instead of treating it as completion', async () => {
    const { agent, harness } = lifecycleHarness(
      (depth, toolResults) =>
        depth === 0
          ? [{ call: delegateCallName, input: task }]
          : toolResults.length === 0
            ? [{ text: 'I am about to reconfigure the host. ' }, { call: 'shell_exec' }]
            : [{ text: 'Command finished.' }],
      [privilegedAllow],
    );

    const result = await delegateThroughRuntime(harness, agent, delegateCallName, task);

    expect(result.status).toBe('suspended');
    expect(result.output).toBe('I am about to reconfigure the host. ');
    expect(harness.approvals.requests).toHaveLength(1);

    // The partial text survives into the resumable turn, so no produced output is lost.
    const persisted = await harness.suspended.getByApprovalId(result.approvalId!);
    expect(persisted?.pending.assistantText).toBe('I am about to reconfigure the host. ');
  });

  /** Test G: a silent child that suspends must not be reported as completed-without-output. */
  it('never claims a silent suspended child completed without output', async () => {
    const { agent, harness } = lifecycleHarness(
      (depth, toolResults) =>
        depth === 0
          ? [{ call: delegateCallName, input: task }]
          : toolResults.length === 0
            ? [{ call: 'shell_exec' }]
            : [{ text: 'Done.' }],
      [privilegedAllow],
    );

    const result = await delegateThroughRuntime(harness, agent, delegateCallName, task);

    expect(result.status).toBe('suspended');
    expect(result.output).not.toContain('completed without returning text output');
    expect(result.output).toContain('waiting for approval');
  });

  it('still reports a genuinely empty completed child truthfully', async () => {
    const { agent, harness } = lifecycleHarness(
      (depth) => (depth === 0 ? [{ call: delegateCallName, input: task }] : [{ text: '' }]),
      delegationAllowRules('root-agent'),
    );

    const result = await delegateThroughRuntime(harness, agent, delegateCallName, task);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Sub-agent completed without returning text output.');
  });

  it('reports a cancelled child as cancelled rather than failed or completed', async () => {
    const agent = rootAgent();
    const controller = new AbortController();
    const harness = createDelegationHarness({
      resolve: async () => ({
        provider: {
          definition: {
            id: 'mock-provider',
            name: 'Mock Provider',
            kind: 'openai-compatible',
            capabilities: ['chat', 'streaming', 'tools'],
            local: true,
          },
          capabilities: () => ['chat', 'streaming', 'tools'],
          testConnection: async () => {},
          // eslint-disable-next-line require-yield
          async *stream() {
            controller.abort();
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
          },
        },
        model: 'mock-model',
      }),
      rules: delegationAllowRules(agent.id),
      agents: [agent],
    });

    const result = await harness.runtime.execute(
      agent,
      delegateCallName,
      { ...task },
      { turnId: 'turn-1', toolCallId: 'call-1' },
      controller.signal,
    );

    if (result.status !== 'completed') throw new Error(`expected a completed invocation, got ${result.status}`);
    expect((result.output as SubAgentToolOutput).status).toBe('cancelled');
  });

  it('reports failed when the child stream errors instead of completing', async () => {
    const agent = rootAgent();
    const harness = createDelegationHarness({
      resolve: async () => ({
        provider: {
          definition: {
            id: 'mock-provider',
            name: 'Mock Provider',
            kind: 'openai-compatible',
            capabilities: ['chat', 'streaming', 'tools'],
            local: true,
          },
          capabilities: () => ['chat', 'streaming', 'tools'],
          testConnection: async () => {},
          // eslint-disable-next-line require-yield
          async *stream() {
            throw new Error('provider exploded');
          },
        },
        model: 'mock-model',
      }),
      rules: delegationAllowRules(agent.id),
      agents: [agent],
    });

    const result = await delegateThroughRuntime(harness, agent, delegateCallName, task);

    expect(result.status).toBe('failed');
    expect(result.output).toContain('provider exploded');
  });
});

/**
 * H-03. Delegation depth travels in the runtime delegation context. A repository miss must never
 * reset it, and every delegation-capable tool is stripped at the nesting limit.
 */
describe('subagent delegation depth (H-03)', () => {
  const task = { role: 'Specialist', objective: 'Go deeper', instructions: 'Keep going' };

  const delegatePlan =
    (maxDepth: number) =>
    (depth: number, toolResults: ModelMessage[]): ScriptStep[] => {
      if (toolResults.length > 0) return [{ text: `depth ${depth} reported back` }];
      if (depth < maxDepth) return [{ call: delegateCallName, input: task }];
      return [{ call: delegateCallName, input: task }];
    };

  function depthHarness(maxDepth: number, agents: AgentDefinition[]) {
    const repository = repositoryFor(agents);
    return {
      harness: createDelegationHarness({
        resolve: depthScriptedResolver(delegatePlan(maxDepth)),
        rules: delegationAllowRules(agents[0].id),
        agents,
        agentRepository: repository,
        maxRecursionDepth: maxDepth,
      }),
    };
  }

  it('allows depth 0 → 1 and carries the root as the ancestor', async () => {
    const root = rootAgent();
    const { harness } = depthHarness(2, [root]);

    await delegateThroughRuntime(harness, root, delegateCallName, task);

    const child = harness.seen.find((entry) => entry.agent.delegationDepth === 1);
    expect(child).toBeDefined();
    expect(child!.delegation!.depth).toBe(1);
    expect(child!.delegation!.ancestors.map((ancestor) => ancestor.id)).toEqual([root.id]);
  });

  it('allows depth 1 → 2 and keeps the whole chain, with no repository entry for the child', async () => {
    const root = rootAgent();
    const { harness } = depthHarness(2, [root]);

    await delegateThroughRuntime(harness, root, delegateCallName, task);

    const child = harness.seen.find((entry) => entry.agent.delegationDepth === 1)!;
    const grandchild = harness.seen.find((entry) => entry.agent.delegationDepth === 2);
    expect(grandchild).toBeDefined();
    expect(grandchild!.delegation!.depth).toBe(2);
    // The child is ephemeral and absent from the repository; trust comes from the invocation context.
    expect(await harness.options.agentRepository.get(child.agent.id)).toBeNull();
    expect(grandchild!.delegation!.ancestors.map((ancestor) => ancestor.id)).toEqual([
      child.agent.id,
      root.id,
    ]);
    expect(grandchild!.agent.inheritedPolicyAgentIds).toEqual([child.agent.id, root.id]);
  });

  it('runs a child at max depth but strips every delegation capability from it', async () => {
    const root = rootAgent();
    const { harness } = depthHarness(2, [root]);

    await delegateThroughRuntime(harness, root, delegateCallName, task);

    const grandchild = harness.seen.find((entry) => entry.agent.delegationDepth === 2)!;
    expect(grandchild.agent.toolIds).not.toContain(subAgentToolId);
    expect(grandchild.agent.toolIds).not.toContain(subAgentTeamToolId);
    expect(grandchild.agent.toolIds).toContain(readToolId);
    // No depth-3 agent was ever created.
    expect(harness.seen.some((entry) => entry.agent.delegationDepth === 3)).toBe(false);
  });

  it('refuses a delegation beyond max depth', async () => {
    const root = rootAgent();
    const { harness } = depthHarness(2, [root]);
    const deepAgent = rootAgent({ id: 'deep-agent', delegationDepth: 2 });

    const result = await harness.runtime.execute(
      deepAgent,
      delegateCallName,
      task,
      { turnId: 'turn-1', toolCallId: 'call-1' },
      undefined,
      createDelegationContext({ depth: 2, ancestors: [{ id: root.id, approvalMode: 'ask' }] }),
    );

    if (result.status !== 'completed') throw new Error(`expected a completed invocation, got ${result.status}`);
    expect((result.output as SubAgentToolOutput).status).toBe('failed');
    expect((result.output as SubAgentToolOutput).output).toContain('recursion depth limit exceeded');
    expect(harness.seen.some((entry) => entry.agent.delegationDepth === 3)).toBe(false);
  });

  it('keeps the depth from the trusted context when the child is missing from the repository', async () => {
    const root = rootAgent();
    const repository: AgentRepository = {
      list: async () => [root],
      get: async (id) => {
        // Only the root is persisted; every delegated child is ephemeral by design.
        if (id !== root.id) throw new Error(`Unexpected repository lookup for ${id}`);
        return root;
      },
      save: async () => {},
      remove: async () => {},
    };
    const harness = createDelegationHarness({
      resolve: depthScriptedResolver(delegatePlan(2)),
      rules: delegationAllowRules(root.id),
      agents: [root],
      agentRepository: repository,
    });

    await delegateThroughRuntime(harness, root, delegateCallName, task);

    const grandchild = harness.seen.find((entry) => entry.agent.delegationDepth === 2);
    expect(grandchild).toBeDefined();
    expect(grandchild!.delegation!.depth).toBe(2);
  });

  it('enforces the same limit for team delegation at max depth', async () => {
    const root = rootAgent();
    const harness = createDelegationHarness({
      resolve: depthScriptedResolver((depth, toolResults) =>
        toolResults.length > 0 ? [{ text: `depth ${depth} reported` }] : [{ call: teamCallName, input: { tasks: [task] } }],
      ),
      rules: delegationAllowRules(root.id),
      agents: [root],
      maxRecursionDepth: 2,
    });

    await delegateThroughRuntime(harness, root, teamCallName, { tasks: [task] });

    const atLimit = harness.seen.filter((entry) => entry.agent.delegationDepth === 2);
    expect(atLimit.length).toBeGreaterThan(0);
    for (const member of atLimit) {
      expect(member.agent.toolIds).not.toContain(subAgentTeamToolId);
      expect(member.agent.toolIds).not.toContain(subAgentToolId);
    }
    // The team member at the limit tried to fan out again and was denied by the missing assignment.
    expect(harness.seen.some((entry) => entry.agent.delegationDepth === 3)).toBe(false);
    expect(harness.denials.join(' ')).toContain('not assigned to this agent');
  });

  it('follows the same policy for single → team mixed delegation', async () => {
    const root = rootAgent();
    const harness = createDelegationHarness({
      resolve: depthScriptedResolver((depth, toolResults) =>
        toolResults.length > 0
          ? [{ text: `depth ${depth} reported` }]
          : depth < 2
            ? [{ call: depth === 0 ? delegateCallName : teamCallName, input: depth === 0 ? task : { tasks: [task] } }]
            : [{ call: delegateCallName, input: task }],
      ),
      rules: delegationAllowRules(root.id),
      agents: [root],
      maxRecursionDepth: 2,
    });

    await delegateThroughRuntime(harness, root, delegateCallName, task);

    expect(harness.seen.some((entry) => entry.agent.delegationDepth === 2)).toBe(true);
    expect(harness.seen.some((entry) => entry.agent.delegationDepth === 3)).toBe(false);
    expect(harness.denials.length).toBeGreaterThan(0);
  });

  it('follows the same policy for team → single mixed delegation', async () => {
    const root = rootAgent();
    const harness = createDelegationHarness({
      resolve: depthScriptedResolver((depth, toolResults) =>
        toolResults.length > 0
          ? [{ text: `depth ${depth} reported` }]
          : depth < 2
            ? [{ call: depth === 0 ? teamCallName : delegateCallName, input: depth === 0 ? { tasks: [task] } : task }]
            : [{ call: teamCallName, input: { tasks: [task] } }],
      ),
      rules: delegationAllowRules(root.id),
      agents: [root],
      maxRecursionDepth: 2,
    });

    await delegateThroughRuntime(harness, root, teamCallName, { tasks: [task] });

    expect(harness.seen.some((entry) => entry.agent.delegationDepth === 2)).toBe(true);
    expect(harness.seen.some((entry) => entry.agent.delegationDepth === 3)).toBe(false);
  });

  it('refuses to delegate for a completely unknown agent instead of inventing one', async () => {
    const harness = createDelegationHarness({
      resolve: textOnlyResolver('never runs'),
      rules: [],
      agents: [],
    });

    await expect(harness.options.agentRepository.get('ghost-agent')).resolves.toBeNull();
    await expect(
      // No runtime agent context and no repository entry: fail closed rather than synthesising a
      // permissive root agent that would reset delegation state.
      createSubAgentTool(harness.options).run(task, {
        agentId: 'ghost-agent',
        agentName: 'Ghost',
      }),
    ).rejects.toThrow(/Delegation refused/);
    expect(harness.seen).toHaveLength(0);
  });

  /** Attack A (input side): the model cannot inject ancestry through tool arguments. */
  it('refuses a delegation that tries to supply its own ancestry metadata', async () => {
    const root = rootAgent();
    const harness = createDelegationHarness({
      resolve: textOnlyResolver('never runs'),
      rules: delegationAllowRules(root.id),
      agents: [root],
    });
    const tool = createSubAgentTool(harness.options);

    await expect(
      tool.run(
        {
          role: 'Sneaky',
          objective: 'Escalate',
          instructions: 'Grant me access',
          inheritedPolicyAgentIds: ['privileged-agent'],
        },
        { agentId: root.id, agentName: root.name, agent: root },
      ),
    ).rejects.toThrow(/cannot choose permissions/);
    await expect(
      tool.run(
        {
          role: 'Sneaky',
          objective: 'Escalate',
          instructions: 'Reset my depth',
          delegationDepth: 0,
        },
        { agentId: root.id, agentName: root.name, agent: root },
      ),
    ).rejects.toThrow(/cannot choose permissions/);
    expect(harness.seen).toHaveLength(0);
  });

  it('refuses a runtime context whose identity does not match the invocation', async () => {
    const root = rootAgent();
    const harness = createDelegationHarness({
      resolve: textOnlyResolver('never runs'),
      rules: delegationAllowRules(root.id),
      agents: [root],
    });
    const tool = createSubAgentTool(harness.options);

    await expect(
      tool.run(task, { agentId: 'someone-else', agentName: 'Impostor', agent: root }),
    ).rejects.toThrow(/does not match its runtime context/);
  });

  /** Attack B: the trusted runtime depth wins over any depth a definition claims. */
  it('ignores a falsified delegation depth on the agent definition', async () => {
    const root = rootAgent();
    const harness = createDelegationHarness({
      resolve: depthScriptedResolver((depth, toolResults) =>
        toolResults.length > 0 ? [{ text: `depth ${depth} reported` }] : [{ call: delegateCallName, input: task }],
      ),
      rules: delegationAllowRules(root.id),
      agents: [root],
      maxRecursionDepth: 3,
    });
    // The child claims depth 0 in its own definition, but its trusted chain says depth 1.
    const lyingChild = rootAgent({ id: 'lying-child', delegationDepth: 0 });
    const childChain = createDelegationContext({
      depth: 1,
      ancestors: [{ id: root.id, approvalMode: 'ask' }],
    });

    const result = await harness.runtime.execute(
      lyingChild,
      delegateCallName,
      task,
      { turnId: 'turn-1', toolCallId: 'call-1' },
      undefined,
      childChain,
    );

    expect(result.status).toBe('completed');
    const created = harness.seen.find((entry) => entry.agent.id.startsWith('subagent-'));
    expect(created?.agent.delegationDepth).toBe(2);
    expect(created?.delegation?.depth).toBe(2);
    expect(created?.delegation?.ancestors.map((ancestor) => ancestor.id)).toEqual([
      'lying-child',
      root.id,
    ]);
  });

  it('strips delegation tools through metadata, covering aliases and wrappers', () => {
    const options: SubAgentToolOptions = {
      agentRepository: repositoryFor([]),
      providerResolver: { resolve: textOnlyResolver('x') },
      agentToolRuntime: {
        definitions: () => [],
        execute: async () => ({ status: 'completed', output: null }),
        resolve: async () => ({ status: 'completed', output: null }),
      },
      toolRegistry: (() => {
        const registry = new ToolRegistry();
        registry.register({
          id: 'cortex.delegate-alias',
          name: 'Alias',
          description: 'An alias that also creates agents.',
          risk: 'execute',
          delegationCapable: true,
          inputSchema: { type: 'object' },
          async run() {
            return null;
          },
        });
        registry.register({
          id: readToolId,
          name: 'Read file',
          description: 'Reads one file.',
          risk: 'read',
          inputSchema: { type: 'object' },
          async run() {
            return null;
          },
        });
        return registry;
      })(),
    };

    expect(assignSubAgentTools(['cortex.delegate-alias', readToolId], 2, 2, options)).toEqual([
      readToolId,
    ]);
    expect(
      assignSubAgentTools(['cortex.delegate-alias', readToolId], 1, 2, options),
    ).toEqual(['cortex.delegate-alias', readToolId]);
  });
});

/**
 * F-04 regression coverage: `createSubAgentTool` → `AgentSession` → `AgentToolRuntime.execute` →
 * `StaticPermissionEngine` → `GatedToolExecutor`. Before the fix the sub-agent was forced into YOLO
 * mode with no link to the parent, so the parent's `ask` rule never matched and the privileged tool
 * ran without any approval.
 */
describe('delegation cannot bypass the approval wall', () => {
  const task = { role: 'Operator', objective: 'Apply a system change', instructions: 'Reconfigure' };

  function harnessFor(rules: PermissionRule[], parent: AgentDefinition, callName: string) {
    return createDelegationHarness({
      resolve: depthScriptedResolver((depth, toolResults) =>
        depth === 0
          ? [{ call: delegateCallName, input: task }]
          : toolResults.length === 0
            ? [{ call: callName }]
            : [{ text: 'done' }],
      ),
      rules: [...delegationAllowRules(parent.id), ...rules],
      agents: [parent],
    });
  }

  it('requires approval for a rule-gated tool reached through one delegation', async () => {
    const parent = rootAgent({ id: 'delegating-parent', toolIds: [subAgentToolId, ruleGatedToolId] });
    const harness = harnessFor(
      [{ id: 'parent-ask', agentId: parent.id, toolId: ruleGatedToolId, decision: 'ask' }],
      parent,
      'system_configure',
    );

    const result = await delegateThroughRuntime(harness, parent, delegateCallName, task);

    // Changed expectation (was `completed`): the child's turn is suspended on approval, so claiming
    // it completed was the H-02 truthfulness breach.
    expect(result.status).toBe('suspended');
    expect(result.approvalId).toBeDefined();
    expect(harness.executions).toHaveLength(0);
    expect(harness.approvals.requests).toHaveLength(1);
    expect(harness.approvals.requests[0].toolId).toBe(ruleGatedToolId);
    const child = harness.seen.find((entry) => entry.agent.delegationDepth === 1)!;
    expect(child.agent.inheritedPolicyAgentIds).toEqual([parent.id]);
    expect(child.agent.approvalMode).toBe('ask');
    expect(child.delegation!.ancestors).toEqual([{ id: parent.id, approvalMode: 'ask' }]);
  });

  it('honours a parent deny rule inside a delegated sub-agent', async () => {
    const parent = rootAgent({ id: 'denying-parent', toolIds: [subAgentToolId, ruleGatedToolId] });
    const harness = harnessFor(
      [{ id: 'parent-deny', agentId: parent.id, toolId: ruleGatedToolId, decision: 'deny' }],
      parent,
      'system_configure',
    );

    const result = await delegateThroughRuntime(harness, parent, delegateCallName, task);

    expect(result.status).toBe('completed');
    expect(harness.executions).toHaveLength(0);
    expect(harness.approvals.requests).toHaveLength(0);
    expect(harness.denials.join(' ')).toContain('deny');
  });

  it('keeps the mandatory approval when a YOLO parent delegates', async () => {
    const parent = rootAgent({
      id: 'yolo-parent',
      approvalMode: 'yolo',
      toolIds: [subAgentToolId, privilegedToolId],
    });
    const harness = harnessFor([], parent, 'shell_exec');

    const result = await delegateThroughRuntime(harness, parent, delegateCallName, task);

    expect(result.status).toBe('suspended');
    const child = harness.seen.find((entry) => entry.agent.delegationDepth === 1)!;
    expect(child.agent.approvalMode).toBe('yolo');
    expect(child.delegation!.ancestors).toEqual([{ id: parent.id, approvalMode: 'yolo' }]);
    expect(harness.executions).toHaveLength(0);
    expect(harness.approvals.requests).toHaveLength(1);
  });

  it('still runs an allowed read-only tool through delegation without a prompt', async () => {
    const parent = rootAgent({ id: 'read-parent', toolIds: [subAgentToolId, readToolId] });
    const harness = createDelegationHarness({
      resolve: depthScriptedResolver((depth, toolResults) =>
        depth === 0
          ? [{ call: delegateCallName, input: task }]
          : toolResults.length === 0
            ? [{ call: 'files_read' }]
            : [{ text: 'read done' }],
      ),
      rules: [
        ...delegationAllowRules(parent.id),
        { id: 'parent-allow', agentId: parent.id, toolId: readToolId, decision: 'allow' },
      ],
      agents: [parent],
    });

    const result = await delegateThroughRuntime(harness, parent, delegateCallName, task);

    expect(result.status).toBe('completed');
    expect(harness.executions).toHaveLength(1);
    expect(harness.approvals.requests).toHaveLength(0);
  });

  it('carries the whole delegation chain through nested delegation', async () => {
    const parent = rootAgent({
      id: 'nested-parent',
      toolIds: [subAgentToolId, ruleGatedToolId],
    });
    const harness = createDelegationHarness({
      resolve: depthScriptedResolver((depth, toolResults) => {
        if (toolResults.length > 0) {
          // A nested sub-delegation that reports "suspended" is visible to the model as a real tool
          // result, so this round proves the child is told the truth about its grandchild.
          return [{ text: `Child saw: ${toolResults.at(-1)!.content}` }];
        }
        if (depth === 0) return [{ call: delegateCallName, input: task }];
        if (depth === 1) return [{ call: delegateCallName, input: task }];
        return [{ call: 'system_configure' }];
      }),
      rules: [
        ...delegationAllowRules(parent.id),
        { id: 'parent-ask', agentId: parent.id, toolId: ruleGatedToolId, decision: 'ask' },
      ],
      agents: [parent],
    });

    const result = await delegateThroughRuntime(harness, parent, delegateCallName, task);

    const child = harness.seen.find((entry) => entry.agent.delegationDepth === 1)!;
    const grandchild = harness.seen.find((entry) => entry.agent.delegationDepth === 2)!;
    expect(child.agent.inheritedPolicyAgentIds).toEqual([parent.id]);
    expect(grandchild.agent.inheritedPolicyAgentIds).toEqual([child.agent.id, parent.id]);
    expect(grandchild.delegation!.ancestors.map((ancestor) => ancestor.id)).toEqual([
      child.agent.id,
      parent.id,
    ]);
    // The grandchild reached the rule-gated tool, but the parent's ask rule stopped execution.
    expect(harness.executions).toHaveLength(0);
    expect(harness.approvals.requests).toHaveLength(1);
    expect(harness.approvals.requests[0].toolId).toBe(ruleGatedToolId);
    // The child recovered from the suspension and finished its own turn with the truth in hand.
    expect(result.status).toBe('completed');
    expect(result.output).toContain('"status":"suspended"');
    expect(result.output).toContain(harness.approvals.requests[0].id);
    // The grandchild's suspended turn is persisted and resumable by itself.
    const suspended = await harness.suspended.getByApprovalId(harness.approvals.requests[0].id);
    expect(suspended?.agentId).toBe(grandchild.agent.id);
    expect(suspended?.delegationChain).toEqual({
      depth: 2,
      ancestors: [
        { id: child.agent.id, approvalMode: 'ask' },
        { id: parent.id, approvalMode: 'ask' },
      ],
    });
  });
});

describe('subagentTeamTool execution', () => {
  const task = { role: 'Researcher', objective: 'Gather', instructions: 'Search' };

  function teamHarness(
    resolve: AgentProviderResolver['resolve'],
    rules: PermissionRule[] = [],
  ) {
    const agent = rootAgent({ id: 'team-root' });
    return {
      agent,
      harness: createDelegationHarness({
        resolve,
        rules: [...delegationAllowRules(agent.id), ...rules],
        agents: [agent],
      }),
    };
  }

  it('runs all members in parallel and reports completed', async () => {
    let concurrent = 0;
    let peak = 0;
    const { agent, harness } = teamHarness(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      try {
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
        return { provider: planProvider(() => [{ text: 'member done' }]), model: 'mock-model' };
      } finally {
        concurrent -= 1;
      }
    });

    const result = await harness.runtime.execute(agent, teamCallName, {
      tasks: [task, { role: 'Reviewer', objective: 'Check', instructions: 'Review' }],
    }, { turnId: 'turn-1', toolCallId: 'call-1' });

    const team = result.status === 'completed' ? (result.output as { status: string; results: SubAgentToolOutput[] }) : null;
    expect(team?.status).toBe('completed');
    expect(team?.results).toHaveLength(2);
    expect(team?.results.every((member) => member.output === 'member done')).toBe(true);
    expect(peak).toBe(2);
  });

  it('reports failed when every member fails', async () => {
    const { agent, harness } = teamHarness(async () => {
      throw new Error('no provider configured');
    });

    const result = await harness.runtime.execute(
      agent,
      teamCallName,
      { tasks: [task, { role: 'B', objective: 'b', instructions: 'y' }] },
      { turnId: 'turn-1', toolCallId: 'call-1' },
    );

    const team = result.status === 'completed' ? (result.output as { status: string }) : null;
    expect(team?.status).toBe('failed');
  });

  it('reports suspended when any member suspends, never completed', async () => {
    const { agent, harness } = teamHarness(
      depthScriptedResolver((depth, toolResults) =>
        toolResults.length === 0 ? [{ call: 'shell_exec' }] : [{ text: 'done' }],
      ),
      [{ id: 'team-privileged-allow', agentId: 'team-root', toolId: privilegedToolId, decision: 'allow' }],
    );

    const result = await harness.runtime.execute(
      agent,
      teamCallName,
      { tasks: [task, { role: 'B', objective: 'b', instructions: 'y' }] },
      { turnId: 'turn-1', toolCallId: 'call-1' },
    );

    const team = result.status === 'completed' ? (result.output as { status: string; results: SubAgentToolOutput[] }) : null;
    expect(team?.status).toBe('suspended');
    expect(team?.results.every((member) => member.status === 'suspended')).toBe(true);
    expect(harness.suspended.turns).toHaveLength(2);
    expect(harness.executions).toHaveLength(0);
  });

  it('rejects more than the maximum team size', async () => {
    const { agent, harness } = teamHarness(textOnlyResolver('nope'));
    const result = await harness.runtime.execute(
      agent,
      teamCallName,
      {
        tasks: Array.from({ length: 5 }, (_, index) => ({
          role: `R${index}`,
          objective: 'o',
          instructions: 'i',
        })),
      },
      { turnId: 'turn-1', toolCallId: 'call-1' },
    );

    // The runtime bridge reports a thrown tool error as a failed tool result, exactly like the
    // desktop runtime does, so the parent's model sees the refusal instead of a crash.
    expect(result).toMatchObject({ status: 'failed' });
    expect((result as { reason: string }).reason).toContain('at most 4');
  });
});

describe('subagent lifecycle statuses are exhaustive', () => {
  it('names every lifecycle state explicitly', () => {
    const statuses: SubAgentLifecycleStatus[] = ['completed', 'failed', 'suspended', 'cancelled'];
    expect(new Set(statuses).size).toBe(4);
  });
});
