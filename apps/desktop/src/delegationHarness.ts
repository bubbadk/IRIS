/**
 * Test-only harness for the delegated-agent lifecycle suites.
 *
 * It wires the *production* orchestration — the real `AgentRuntimeCoordinator`, `AgentSession`,
 * delegation tools, permission engine and gated executor — against in-memory repositories and a
 * scripted fake model provider, so the lifecycle under test is the real one and only the model is a
 * fake. It is not imported by application code.
 */
import type { AgentDefinition } from '@iris/core';
import {
  AgentRuntimeCoordinator,
  type AgentProviderResolver,
  type AgentRepository,
  type AgentToolRuntime,
  type ConversationMessage,
  type ConversationRepository,
  type SuspendedAgentTurn,
  type SuspendedAgentTurnRepository,
} from '@iris/agents';
import type { ModelChunk, ModelMessage, ModelProvider } from '@iris/providers';
import {
  GatedToolExecutor,
  StaticPermissionEngine,
  ToolPermissionError,
  ToolRegistry,
  snapshotApprovalInput,
  type PermissionRule,
  type RegisteredTool,
  type ToolApprovalRepository,
  type ToolApprovalRequest,
  type ToolApprovalStatus,
} from '@iris/tools';
import {
  createSubAgentTeamTool,
  createSubAgentTool,
  delegatedExecutionResult,
  subAgentTeamToolId,
  subAgentToolId,
} from './subagentTool';

export const privilegedToolId = 'shell.exec';
export const ruleGatedToolId = 'system.configure';
export const delegateCallName = 'cortex_delegate_subagent';
export const teamCallName = 'cortex_delegate_team';

/**
 * Copies a stored approval so no caller can reach the stored invocation's arguments. The input is
 * snapshotted as well as the record: an approval must stay bound to exactly what the user saw, even
 * if the object the caller still holds is mutated afterwards.
 */
function cloneApprovalRequest(request: ToolApprovalRequest): ToolApprovalRequest {
  return { ...request, input: snapshotApprovalInput(request.input) };
}

export class MemoryApprovalRepository implements ToolApprovalRepository {
  readonly requests: ToolApprovalRequest[] = [];

  async list() {
    return this.requests.map(cloneApprovalRequest);
  }

  async get(id: string) {
    const request = this.requests.find((item) => item.id === id);
    return request ? cloneApprovalRequest(request) : null;
  }

  async save(request: ToolApprovalRequest) {
    const index = this.requests.findIndex((item) => item.id === request.id);
    if (index === -1) this.requests.push(cloneApprovalRequest(request));
    else this.requests[index] = cloneApprovalRequest(request);
  }

  async compareAndSet(
    id: string,
    expected: ToolApprovalStatus,
    request: ToolApprovalRequest,
  ): Promise<boolean> {
    const index = this.requests.findIndex((item) => item.id === id);
    if (index === -1 || this.requests[index].status !== expected) return false;
    this.requests[index] = cloneApprovalRequest(request);
    return true;
  }

  async clearResolved() {
    const keep = this.requests.filter(
      (request) => request.status === 'pending' || request.status === 'approved',
    );
    this.requests.splice(0, this.requests.length, ...keep);
  }
}

export class MemoryAgentRepository implements AgentRepository {
  constructor(private readonly agents: AgentDefinition[] = []) {}

  async list() {
    return this.agents;
  }

  async get(id: string) {
    return this.agents.find((agent) => agent.id === id) ?? null;
  }

  async save(agent: AgentDefinition) {
    const index = this.agents.findIndex((candidate) => candidate.id === agent.id);
    if (index === -1) this.agents.push(agent);
    else this.agents[index] = agent;
  }

  async remove(id: string) {
    const index = this.agents.findIndex((candidate) => candidate.id === id);
    if (index !== -1) this.agents.splice(index, 1);
  }
}

export class MemoryConversationRepository implements ConversationRepository {
  readonly conversations = new Map<string, ConversationMessage[]>();

  async list(agentId: string) {
    return this.conversations.get(agentId) ?? [];
  }

  async save(agentId: string, messages: ConversationMessage[]) {
    this.conversations.set(agentId, messages.map((message) => ({ ...message })));
  }

  async clear(agentId: string) {
    this.conversations.delete(agentId);
  }
}

export class MemorySuspendedTurnRepository implements SuspendedAgentTurnRepository {
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

export type ScriptStep = { text: string } | { call: string; input?: unknown };

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
          ? { toolCalls: [{ id: `call-${callSequence}`, name: step.call, input: step.input ?? {} }] }
          : {}),
      };
    }
    return { text: step.text, done: last };
  });
}

export function planProvider(plan: (toolResults: ModelMessage[]) => ScriptStep[]): ModelProvider {
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
      for (const chunk of chunksFor(plan(toolResults))) yield chunk;
    },
  };
}

export interface IntegrationHarness {
  coordinator: AgentRuntimeCoordinator;
  approvals: MemoryApprovalRepository;
  suspended: MemorySuspendedTurnRepository;
  conversations: MemoryConversationRepository;
  agents: MemoryAgentRepository;
  executions: unknown[];
  seen: { agentId: string; depth?: number; ancestors: string[] }[];
  denials: string[];
  registry: ToolRegistry;
}

export interface IntegrationConfig {
  agents: AgentDefinition[];
  rules: PermissionRule[];
  resolve: AgentProviderResolver['resolve'];
}

/**
 * The production wiring at the level that matters here: the real `AgentRuntimeCoordinator` driving
 * the real `AgentSession`, the real delegation tools, the real permission engine and the real
 * approval/suspension stores. Only the model provider is a bounded fake.
 */
export function createIntegrationHarness(config: IntegrationConfig): IntegrationHarness {
  const approvals = new MemoryApprovalRepository();
  const suspended = new MemorySuspendedTurnRepository();
  const conversations = new MemoryConversationRepository();
  const agents = new MemoryAgentRepository(config.agents);
  const executions: unknown[] = [];
  const seen: { agentId: string; depth?: number; ancestors: string[] }[] = [];
  const denials: string[] = [];
  const registry = new ToolRegistry();

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

  const executor = new GatedToolExecutor(
    registry,
    new StaticPermissionEngine(config.rules),
    approvals,
  );

  const toolRuntime: AgentToolRuntime = {
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
      seen.push({
        agentId: agent.id,
        ...(agent.delegationDepth !== undefined ? { depth: agent.delegationDepth } : {}),
        ancestors: (delegation?.ancestors ?? []).map((ancestor) => ancestor.id),
      });
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
        // Exactly the production translation: a delegation whose child waits for approval is a
        // suspension, never a completion.
        return delegatedExecutionResult(result.output);
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
          ? delegatedExecutionResult(result.output)
          : { status: 'approval-denied' };
      } catch (error) {
        return {
          status: 'failed',
          reason: error instanceof Error ? error.message : 'Approval resolution failed.',
        };
      }
    },
  };

  const options = {
    agentRepository: agents,
    providerResolver: { resolve: config.resolve },
    agentToolRuntime: toolRuntime,
    suspendedTurns: suspended,
    conversations,
    toolRegistry: registry,
  };

  const delegateHolder: { tool?: RegisteredTool; team?: RegisteredTool } = {};
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
  delegateHolder.tool = createSubAgentTool(options);
  delegateHolder.team = createSubAgentTeamTool(options);
  registry.register(proxy(delegateHolder.tool, delegateCallName));
  registry.register(proxy(delegateHolder.team, teamCallName));

  const coordinator = new AgentRuntimeCoordinator(
    agents,
    conversations,
    suspended,
    { resolve: config.resolve },
    toolRuntime,
  );

  return { coordinator, approvals, suspended, conversations, agents, executions, seen, denials, registry };
}

export async function collect<T extends { type: string }>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

export function rootAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'integration-root',
    name: 'Integration root',
    providerPolicyId: 'mock-provider',
    model: 'mock-model',
    autonomy: 'operate',
    approvalMode: 'ask',
    toolIds: [subAgentToolId, subAgentTeamToolId, ruleGatedToolId, privilegedToolId],
    skillIds: [],
    ...overrides,
  };
}

/**
 * Delegation must never require a rule of its own: the delegation tools are gated by the same
 * policy engine as any other tool. Kept empty so a test can assert nothing was added.
 */
export const delegateAllow: PermissionRule[] = [];
export function allowRules(agentId: string): PermissionRule[] {
  return [
    { id: `${agentId}-delegate`, agentId, toolId: subAgentToolId, decision: 'allow' },
    { id: `${agentId}-team`, agentId, toolId: subAgentTeamToolId, decision: 'allow' },
  ];
}

/** The parent's plan: delegate, then report verbatim what the delegation tool answered. */
export function parentPlan(): (toolResults: ModelMessage[]) => ScriptStep[] {
  return (toolResults) =>
    toolResults.length === 0
      ? [
          {
            call: delegateCallName,
            input: { role: 'Operator', objective: 'Reconfigure', instructions: 'Do it' },
          },
        ]
      : [{ text: `Parent report: ${toolResults.at(-1)!.content}` }];
}

/** The child's plan: call a rule-gated tool, then finish with a report once it has a result. */
export function childPlan(toolName = 'system_configure'): (toolResults: ModelMessage[]) => ScriptStep[] {
  return (toolResults) =>
    toolResults.length === 0
      ? [{ call: toolName, input: { setting: 'enabled' } }]
      : [{ text: `Child report: ${toolResults.at(-1)!.content}` }];
}

export function depthAwareResolver(
  parent: (toolResults: ModelMessage[]) => ScriptStep[],
  child: (toolResults: ModelMessage[]) => ScriptStep[],
): AgentProviderResolver['resolve'] {
  return async (agent) => ({
    provider: planProvider(agent.delegationDepth === undefined ? parent : child),
    model: 'mock-model',
  });
}
