import type { AgentDefinition } from '@iris/core';

export type ToolRisk = 'read' | 'write' | 'execute' | 'external';
export type PermissionDecision = 'allow' | 'ask' | 'deny';

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  risk: ToolRisk;
  providerName?: string;
  inputSchema?: Record<string, unknown>;
  manualExecution?: boolean;
  /** Cannot be bypassed by an allow rule or YOLO mode; each invocation needs user approval. */
  alwaysRequireApproval?: boolean;
}

export interface ToolContext {
  agentId: string;
  agentName: string;
  turnId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
}

export interface ToolInvocation {
  turnId?: string;
  toolCallId?: string;
}

export interface RegisteredTool extends ToolDefinition {
  run(input: unknown, context: ToolContext): Promise<unknown>;
}

export interface PermissionRule {
  id: string;
  agentId: string | '*';
  toolId: string | '*';
  decision: PermissionDecision;
  reason?: string;
}

export interface PermissionEvaluation {
  decision: PermissionDecision;
  reason: string;
  ruleId?: string;
}

export type PermissionEvaluationSource = 'inspection' | 'execution';

export interface PermissionEvaluationContext {
  source: PermissionEvaluationSource;
}

export interface PermissionAuditEvent extends PermissionEvaluation {
  id: string;
  timestamp: string;
  source: PermissionEvaluationSource;
  agentId: string;
  agentName: string;
  toolId: string;
  toolName: string;
}

export interface PermissionRuleRepository {
  list(): Promise<PermissionRule[]>;
  save(rule: PermissionRule): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface PermissionAuditRepository {
  list(): Promise<PermissionAuditEvent[]>;
  append(event: PermissionAuditEvent): Promise<void>;
  clear(): Promise<void>;
}

export type ToolApprovalStatus = 'pending' | 'approved' | 'denied' | 'completed' | 'failed';

export interface ToolApprovalRequest {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: ToolApprovalStatus;
  agentId: string;
  agentName: string;
  toolId: string;
  toolName: string;
  input: unknown;
  evaluation: PermissionEvaluation;
  invocation?: ToolInvocation;
  resolvedAt?: string;
  error?: string;
}

export interface ToolApprovalRepository {
  list(): Promise<ToolApprovalRequest[]>;
  get(id: string): Promise<ToolApprovalRequest | null>;
  save(request: ToolApprovalRequest): Promise<void>;
  clearResolved(): Promise<void>;
}

export interface PermissionEngine {
  evaluate(
    agent: AgentDefinition,
    tool: ToolDefinition,
    context?: PermissionEvaluationContext,
  ): Promise<PermissionEvaluation>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.id)) throw new Error(`Tool already registered: ${tool.id}`);
    this.tools.set(tool.id, tool);
  }

  /** Tools discovered from a connected server replace whatever that server exposed before. */
  replace(tool: RegisteredTool): void {
    this.tools.set(tool.id, tool);
  }

  unregister(id: string): boolean {
    return this.tools.delete(id);
  }

  unregisterWhere(predicate: (tool: ToolDefinition) => boolean): string[] {
    const removed = this.list()
      .filter(predicate)
      .map((tool) => tool.id);
    removed.forEach((id) => this.tools.delete(id));
    return removed;
  }

  get(id: string): RegisteredTool | undefined {
    return this.tools.get(id);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      providerName: tool.providerName,
      inputSchema: tool.inputSchema,
      manualExecution: tool.manualExecution,
      alwaysRequireApproval: tool.alwaysRequireApproval,
    }));
  }
}

export class StaticPermissionEngine implements PermissionEngine {
  constructor(private readonly rules: PermissionRule[] = []) {}

  async evaluate(agent: AgentDefinition, tool: ToolDefinition): Promise<PermissionEvaluation> {
    if (!agent.toolIds.includes(tool.id)) {
      return { decision: 'deny', reason: 'Tool is not assigned to this agent.' };
    }

    const matching = this.rules
      .filter(
        (rule) =>
          (rule.agentId === '*' || rule.agentId === agent.id) &&
          (rule.toolId === '*' || rule.toolId === tool.id),
      )
      .sort(
        (left, right) =>
          specificity(right, agent.id, tool.id) - specificity(left, agent.id, tool.id),
      );
    const rule = matching[0];
    if (!rule) {
      if (agent.approvalMode === 'yolo' && tool.alwaysRequireApproval) {
        return {
          decision: 'ask',
          reason: `${tool.name} always requires explicit approval, including in YOLO mode.`,
        };
      }
      return agent.approvalMode === 'yolo'
        ? {
            decision: 'allow',
            reason: `YOLO mode allows assigned tool ${tool.name}; explicit deny rules remain enforced.`,
          }
        : { decision: 'deny', reason: 'No permission rule allows this tool.' };
    }
    if (rule.decision === 'deny') {
      return {
        decision: 'deny',
        reason: rule.reason ?? `Permission rule ${rule.id} returned deny.`,
        ruleId: rule.id,
      };
    }
    if (tool.alwaysRequireApproval) {
      return {
        decision: 'ask',
        reason: `${tool.name} always requires explicit approval, including in YOLO mode.`,
        ruleId: rule.id,
      };
    }
    if (agent.approvalMode === 'yolo') {
      return {
        decision: 'allow',
        reason: `YOLO mode allows assigned tool ${tool.name}; explicit deny rules remain enforced.`,
        ruleId: rule.id,
      };
    }
    return {
      decision: rule.decision,
      reason: rule.reason ?? `Permission rule ${rule.id} returned ${rule.decision}.`,
      ruleId: rule.id,
    };
  }
}

export class AuditedPermissionEngine implements PermissionEngine {
  constructor(
    private readonly permissions: PermissionEngine,
    private readonly audit: PermissionAuditRepository,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async evaluate(
    agent: AgentDefinition,
    tool: ToolDefinition,
    context: PermissionEvaluationContext = { source: 'inspection' },
  ): Promise<PermissionEvaluation> {
    const evaluation = await this.permissions.evaluate(agent, tool, context);
    await this.audit.append({
      ...evaluation,
      id: this.createId(),
      timestamp: this.now().toISOString(),
      source: context.source,
      agentId: agent.id,
      agentName: agent.name,
      toolId: tool.id,
      toolName: tool.name,
    });
    return evaluation;
  }
}

export function setToolAssigned(
  agent: AgentDefinition,
  tool: ToolDefinition,
  assigned: boolean,
): AgentDefinition {
  const toolIds = new Set(agent.toolIds);
  if (assigned) toolIds.add(tool.id);
  else toolIds.delete(tool.id);
  return { ...agent, toolIds: [...toolIds] };
}

function specificity(rule: PermissionRule, agentId: string, toolId: string): number {
  return (rule.agentId === agentId ? 2 : 0) + (rule.toolId === toolId ? 1 : 0);
}

export class ToolPermissionError extends Error {
  constructor(readonly evaluation: PermissionEvaluation) {
    super(evaluation.reason);
    this.name = 'ToolPermissionError';
  }
}

export type ToolExecutionResult =
  | { status: 'completed'; output: unknown; evaluation: PermissionEvaluation }
  | {
      status: 'approval-required';
      evaluation: PermissionEvaluation;
      approval: ToolApprovalRequest;
    };

export type ToolApprovalResult =
  | { status: 'approval-denied'; approval: ToolApprovalRequest }
  | { status: 'completed'; output: unknown; approval: ToolApprovalRequest };

export class ToolApprovalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolApprovalStateError';
  }
}

export class GatedToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissions: PermissionEngine,
    private readonly approvals: ToolApprovalRepository,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(
    agent: AgentDefinition,
    toolId: string,
    input: unknown,
    signal?: AbortSignal,
    invocation?: ToolInvocation,
  ): Promise<ToolExecutionResult> {
    const tool = this.registry.get(toolId);
    if (!tool) throw new Error(`Unknown tool: ${toolId}`);
    const evaluation = await this.permissions.evaluate(agent, tool, { source: 'execution' });
    if (evaluation.decision === 'deny') throw new ToolPermissionError(evaluation);
    if (evaluation.decision === 'ask') {
      const timestamp = this.now().toISOString();
      const approval: ToolApprovalRequest = {
        id: this.createId(),
        createdAt: timestamp,
        updatedAt: timestamp,
        status: 'pending',
        agentId: agent.id,
        agentName: agent.name,
        toolId: tool.id,
        toolName: tool.name,
        input,
        evaluation,
        invocation,
      };
      await this.approvals.save(approval);
      return { status: 'approval-required', evaluation, approval };
    }
    const output = await tool.run(input, {
      agentId: agent.id,
      agentName: agent.name,
      ...invocation,
      signal,
    });
    return { status: 'completed', output, evaluation };
  }

  async resolve(
    approvalId: string,
    decision: 'approve' | 'deny',
    signal?: AbortSignal,
  ): Promise<ToolApprovalResult> {
    const approval = await this.requireApproval(approvalId);
    if (approval.status !== 'pending') {
      throw new ToolApprovalStateError(
        `Approval ${approvalId} cannot be resolved from ${approval.status}.`,
      );
    }

    const timestamp = this.now().toISOString();
    const resolved: ToolApprovalRequest = {
      ...approval,
      status: decision === 'approve' ? 'approved' : 'denied',
      resolvedAt: timestamp,
      updatedAt: timestamp,
    };
    await this.approvals.save(resolved);
    if (decision === 'deny') return { status: 'approval-denied', approval: resolved };
    return this.resume(approvalId, signal);
  }

  async resume(approvalId: string, signal?: AbortSignal): Promise<ToolApprovalResult> {
    const approval = await this.requireApproval(approvalId);
    if (approval.status !== 'approved') {
      throw new ToolApprovalStateError(
        `Approval ${approvalId} cannot execute from ${approval.status}.`,
      );
    }

    const tool = this.registry.get(approval.toolId);
    if (!tool) {
      const failed = await this.markFailed(approval, `Unknown tool: ${approval.toolId}`);
      throw new ToolApprovalStateError(failed.error!);
    }

    try {
      const output = await tool.run(approval.input, {
        agentId: approval.agentId,
        agentName: approval.agentName,
        ...approval.invocation,
        signal,
      });
      const completed: ToolApprovalRequest = {
        ...approval,
        status: 'completed',
        updatedAt: this.now().toISOString(),
      };
      await this.approvals.save(completed);
      return { status: 'completed', output, approval: completed };
    } catch (error) {
      await this.markFailed(
        approval,
        error instanceof Error ? error.message : 'Tool execution failed after approval.',
      );
      throw error;
    }
  }

  private async requireApproval(id: string): Promise<ToolApprovalRequest> {
    const approval = await this.approvals.get(id);
    if (!approval) throw new ToolApprovalStateError(`Unknown approval: ${id}`);
    return approval;
  }

  private async markFailed(
    approval: ToolApprovalRequest,
    error: string,
  ): Promise<ToolApprovalRequest> {
    const failed: ToolApprovalRequest = {
      ...approval,
      status: 'failed',
      error,
      updatedAt: this.now().toISOString(),
    };
    await this.approvals.save(failed);
    return failed;
  }
}

export * from './webTools';
export * from './imageTools';
export * from './browserTools';
