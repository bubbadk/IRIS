import {
  isTrustedDelegationContext,
  type AgentDefinition,
  type DelegatedChildRef,
  type DelegationPolicyContext,
  type PolicyActor,
} from '@iris/core';

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
  /**
   * Marks a tool that can create further agents. The delegating runtime reads this metadata to strip
   * every delegation capability once the nesting limit is reached, so a team tool, an alias or a
   * wrapper is covered by the same policy instead of one hardcoded tool id.
   */
  delegationCapable?: boolean;
}

export interface ToolContext {
  agentId: string;
  agentName: string;
  /**
   * Authoritative runtime definition of the invoking agent. Present on every agent-driven
   * execution; absent only for a host that invokes a tool with no agent behind it.
   */
  agent?: AgentDefinition;
  /**
   * Trusted delegation chain of the invoking agent, minted by the runtime that delegated to it.
   * This — not any field on an agent definition — is what carries delegation depth and ancestry.
   */
  delegation?: DelegationPolicyContext;
  /**
   * Present only when the runtime re-invokes a call that previously reported a nested suspension.
   * The delegated children travel back verbatim so the tool can recover their recorded outcomes
   * instead of creating the same work (and its side effects) a second time.
   */
  resume?: ToolInvocationResume;
  turnId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
}

/**
 * The delegated children a re-invoked tool call is resuming, as the runtime recorded them. The shape
 * is trusted runtime data, not model output: it is minted by the runtime from its own suspension
 * state and never from tool arguments.
 */
export interface ToolInvocationResume {
  children: DelegatedChildRef[];
}

export interface ToolInvocation {
  turnId?: string;
  toolCallId?: string;
  resume?: ToolInvocationResume;
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
  /**
   * Trusted delegation chain for this evaluation, minted by the delegating runtime. Only a context
   * passed here activates delegated evaluation; ancestry metadata stored on the agent definition is
   * never read as authority. Ancestors are combined with least privilege, so a chain can keep or
   * lower authority but never raise it.
   */
  delegation?: DelegationPolicyContext;
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

export type ToolApprovalStatus = 'pending' | 'approved' | 'executing' | 'denied' | 'completed' | 'failed';

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
  /** Atomically replace an existing request only if its status still matches. */
  compareAndSet(id: string, expected: ToolApprovalStatus, request: ToolApprovalRequest): Promise<boolean>;
  clearResolved(): Promise<void>;
}

export interface PermissionEngine {
  evaluate(
    agent: AgentDefinition,
    tool: ToolDefinition,
    context?: PermissionEvaluationContext,
  ): Promise<PermissionEvaluation>;
}

/**
 * Field names that must never arrive as tool arguments. Tool input is untrusted model output, so a
 * credential supplied there has no authority and is rejected instead of silently ignored.
 */
const credentialArgumentFields = [
  'apikey',
  'api_key',
  'authorization',
  'token',
  'accesstoken',
  'access_token',
  'secret',
  'clientsecret',
  'client_secret',
  'password',
] as const;

export function assertNoCredentialArguments(input: unknown): void {
  if (!input || typeof input !== 'object') return;
  for (const key of Object.keys(input as Record<string, unknown>)) {
    if ((credentialArgumentFields as readonly string[]).includes(key.toLowerCase())) {
      throw new Error(
        `Tool input must not carry credentials ("${key}"). Credentials are resolved from the trusted credential store, not from tool arguments.`,
      );
    }
  }
}

/** Only configuration readers/writers may translate these retired identities. Never register aliases. */
const legacyToolIds: Readonly<Record<string, string>> = {
  'subagent.delegate': 'cortex.delegate-subagent',
  // The diagnostics constructor now registers health; do not grant projectcockpit implicitly.
  'janitor.diagnostics': 'janitor.health',
  // Fresher onboarding presets named these after their factory functions rather than the IDs the
  // registry publishes. The capability is exactly the canonical tool, so configuration and
  // durable data are translated to the canonical identity *before* validity and authority
  // evaluation. Nothing is granted beyond the canonical permission, and no duplicate alias tool
  // is registered: `ToolRegistry.register` refuses every legacy ID in this table.
  'workspace.directory': 'workspace.mkdir',
  'host.inspect': 'system.inspect-host',
};

export class InvalidToolConfigurationError extends Error {
  constructor(readonly toolId: string) {
    super(`Invalid tool configuration: unknown or unavailable tool ID "${toolId}". Restore the tool or repair the configuration.`);
    this.name = 'InvalidToolConfigurationError';
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (Object.hasOwn(legacyToolIds, tool.id)) throw new InvalidToolConfigurationError(tool.id);
    if (this.tools.has(tool.id)) throw new Error(`Tool already registered: ${tool.id}`);
    this.tools.set(tool.id, tool);
  }

  /** Tools discovered from a connected server replace whatever that server exposed before. */
  replace(tool: RegisteredTool): void {
    if (Object.hasOwn(legacyToolIds, tool.id)) throw new InvalidToolConfigurationError(tool.id);
    const existing = this.tools.get(tool.id);
    // `alwaysRequireApproval` is a security boundary, not metadata: replacing an approval-gated
    // tool with a definition that drops the requirement would bypass every approval path.
    if (existing?.alwaysRequireApproval && !tool.alwaysRequireApproval) {
      throw new Error(
        `Refusing to replace the approval-gated tool ${tool.id} with a definition that does not require approval.`,
      );
    }
    // `delegationCapable` is what the recursion policy reads to strip delegation at the nesting
    // limit; dropping it would let a replacement escape that policy.
    if (existing?.delegationCapable && !tool.delegationCapable) {
      throw new Error(
        `Refusing to replace the delegation-capable tool ${tool.id} with a definition that hides its delegation capability.`,
      );
    }
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
      delegationCapable: tool.delegationCapable,
    }));
  }
}

/** Configuration/migration boundary only. Runtime lookup and permission evaluation stay exact. */
export function canonicalConfiguredToolId(id: string, registry: ToolRegistry): string {
  const canonical = Object.hasOwn(legacyToolIds, id) ? legacyToolIds[id] : id;
  if (!registry.get(canonical)) throw new InvalidToolConfigurationError(id);
  return canonical;
}

export function canonicalConfiguredToolIds(ids: readonly string[], registry: ToolRegistry): string[] {
  return [...new Set(ids.map((id) => canonicalConfiguredToolId(id, registry)))];
}

/**
 * Preserve every rule ID and decision, including denies. A legacy/canonical collision is ambiguous:
 * reject conflicting decisions instead of allowing repository order to turn a deny into an allow.
 */
export function canonicalConfiguredPermissionRules(
  rules: readonly PermissionRule[],
  registry: ToolRegistry,
): PermissionRule[] {
  const canonical = rules.map((rule) => ({
    ...rule,
    toolId: rule.toolId === '*' ? '*' : canonicalConfiguredToolId(rule.toolId, registry),
  }));
  for (const rule of canonical) {
    if (canonical.some((other) => other.agentId === rule.agentId &&
      other.toolId === rule.toolId && other.decision !== rule.decision)) {
      throw new Error(`Invalid tool configuration: conflicting permission rules for ${rule.toolId}. Resolve the conflict explicitly.`);
    }
  }
  return canonical;
}

/** The decision an explicit rule produced for one actor, before the chain is combined. */
interface ActorRule {
  decision: PermissionDecision;
  reason: string;
  ruleId: string;
}

/** Least privilege order: deny outranks ask outranks allow. */
function restrictionRank(decision: PermissionDecision): number {
  if (decision === 'deny') return 2;
  if (decision === 'ask') return 1;
  return 0;
}

/**
 * The one rule-precedence algorithm IRIS uses, for direct and delegated evaluation alike.
 *
 * Precedence inside a single actor:
 * 1. The tool must be assigned to the agent, otherwise the answer is `deny`.
 * 2. The most specific matching rule wins: agent-specific (2) + tool-specific (1); a wildcard agent
 *    or wildcard tool matches with lower specificity. Equal specificity keeps repository order.
 * 3. `deny` from that rule always wins.
 * 4. Otherwise `alwaysRequireApproval` forces `ask` — before YOLO gets a say.
 * 5. Otherwise YOLO turns an `ask` rule into `allow`; an explicit `allow` is already `allow`.
 * 6. With no matching rule at all: YOLO + `alwaysRequireApproval` is `ask`, YOLO alone is `allow`,
 *    and every other mode is `deny`.
 *
 * Delegation combines actors with the same algorithm, per actor, and then folds the results with
 * least privilege. An ancestor that configured no rule for the tool adds no restriction; an
 * ancestor that did can only keep or lower the result. `alwaysRequireApproval` is applied last and
 * absolutely, so it outranks YOLO at every depth.
 */
export class StaticPermissionEngine implements PermissionEngine {
  constructor(private readonly rules: PermissionRule[] = []) {}

  async evaluate(
    agent: AgentDefinition,
    tool: ToolDefinition,
    context?: PermissionEvaluationContext,
  ): Promise<PermissionEvaluation> {
    if (!agent.toolIds.includes(tool.id)) {
      return { decision: 'deny', reason: 'Tool is not assigned to this agent.' };
    }

    // Only a runtime-minted context counts. A structurally identical plain object (rebuilt from
    // persisted state, read off an agent definition, or supplied by a caller) is ignored, so nobody
    // can switch evaluation onto the delegation path by writing ancestry metadata.
    const delegation = isTrustedDelegationContext(context?.delegation)
      ? context.delegation
      : undefined;

    const own = this.ruleFor(
      { id: agent.id, ...(agent.approvalMode ? { approvalMode: agent.approvalMode } : {}) },
      tool,
    );
    const ancestorRules = (delegation?.ancestors ?? [])
      .map((ancestor) => this.ruleFor(ancestor, tool))
      .filter((rule): rule is ActorRule => rule !== undefined);

    if (!own && ancestorRules.length === 0) {
      return this.defaultEvaluation(agent, tool, Boolean(delegation));
    }

    const deciding = [...(own ? [own] : []), ...ancestorRules].reduce((best, next) =>
      restrictionRank(next.decision) > restrictionRank(best.decision) ? next : best,
    );

    if (tool.alwaysRequireApproval && deciding.decision !== 'deny') {
      return {
        decision: 'ask',
        reason: `${tool.name} always requires explicit approval, including in YOLO mode.`,
        ruleId: deciding.ruleId,
      };
    }
    return { decision: deciding.decision, reason: deciding.reason, ruleId: deciding.ruleId };
  }

  /**
   * The rules that bind one actor for one tool. The argument is a `PolicyActor`, not a full agent
   * definition: an ancestor's policy depends on nothing else, which is what lets a delegated turn
   * evaluate its chain without trusting anything a caller supplied.
   */
  private ruleFor(actor: PolicyActor, tool: ToolDefinition): ActorRule | undefined {
    const matching = this.rules
      .filter(
        (rule) =>
          (rule.agentId === '*' || rule.agentId === actor.id) &&
          (rule.toolId === '*' || rule.toolId === tool.id),
      )
      .sort(
        (left, right) =>
          specificity(right, actor.id, tool.id) - specificity(left, actor.id, tool.id),
      );
    const rule = matching[0];
    if (!rule) return undefined;
    if (rule.decision === 'deny') {
      return {
        decision: 'deny',
        reason: rule.reason ?? `Permission rule ${rule.id} returned deny.`,
        ruleId: rule.id,
      };
    }
    if (actor.approvalMode === 'yolo') {
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

  private defaultEvaluation(
    agent: AgentDefinition,
    tool: ToolDefinition,
    delegated: boolean,
  ): PermissionEvaluation {
    if (agent.approvalMode === 'yolo' && tool.alwaysRequireApproval) {
      return {
        decision: 'ask',
        reason: `${tool.name} always requires explicit approval, including in YOLO mode.`,
      };
    }
    if (agent.approvalMode === 'yolo') {
      return {
        decision: 'allow',
        reason: `YOLO mode allows ${delegated ? 'delegated' : 'assigned'} tool ${tool.name}; explicit deny rules remain enforced.`,
      };
    }
    return {
      decision: 'deny',
      reason: delegated
        ? 'No permission rule allows this delegated tool.'
        : 'No permission rule allows this tool.',
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

/**
 * Detaches a tool invocation's arguments from the object the caller still holds.
 *
 * An approval record must be bound to the invocation the user actually saw and approved: after the
 * prompt appears, the caller (or a model that produced the call) must not be able to mutate
 * `command`, `args`, `path`, `isolation` or `target` and have a different operation run. The
 * snapshot is taken once, at approval-creation time, and `resume` executes exactly that.
 */
export function snapshotApprovalInput(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return input;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(input);
    } catch {
      // Fall through to the JSON copy for values structuredClone cannot represent.
    }
  }
  try {
    return JSON.parse(JSON.stringify(input));
  } catch {
    throw new Error('This tool input cannot be captured for approval. Pass a JSON-serializable value.');
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
    delegation?: DelegationPolicyContext,
  ): Promise<ToolExecutionResult> {
    const tool = this.registry.get(toolId);
    if (!tool) throw new Error(`Unknown tool: ${toolId}`);
    const evaluation = await this.permissions.evaluate(agent, tool, {
      source: 'execution',
      ...(delegation ? { delegation } : {}),
    });
    if (evaluation.decision === 'deny') throw new ToolPermissionError(evaluation);
    if (evaluation.decision === 'ask') {
      const timestamp = this.now().toISOString();
      const capture = snapshotApprovalInput(input);
      const approval: ToolApprovalRequest = {
        id: this.createId(),
        createdAt: timestamp,
        updatedAt: timestamp,
        status: 'pending',
        agentId: agent.id,
        agentName: agent.name,
        toolId: tool.id,
        toolName: tool.name,
        // The approved invocation is detached from the caller's object. Without this, a model or
        // caller that mutated its own argument object after the prompt appeared could change what
        // runs between the user's approval and the execution (`resume` below runs exactly this).
        input: capture,
        evaluation,
        invocation,
      };
      await this.approvals.save(approval);
      // The caller gets its own snapshot too: a repository may keep the record it was handed, and
      // nothing that reaches a UI or a session may alias the invocation that will actually run.
      return {
        status: 'approval-required',
        evaluation,
        approval: { ...approval, input: snapshotApprovalInput(capture) },
      };
    }
    const output = await tool.run(input, {
      agentId: agent.id,
      agentName: agent.name,
      agent,
      ...(delegation ? { delegation } : {}),
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
    if (!await this.approvals.compareAndSet(approvalId, 'pending', resolved)) {
      throw new ToolApprovalStateError(`Approval ${approvalId} was already resolved.`);
    }
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

    // Persist the claim before side effects. An interrupted executing request must
    // never be replayed automatically: its external outcome may be unknown.
    if (!await this.approvals.compareAndSet(approvalId, 'approved', {
      ...approval, status: 'executing', updatedAt: this.now().toISOString(),
    })) {
      throw new ToolApprovalStateError(`Approval ${approvalId} is already executing or finished.`);
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
export * from './approvalSummary';
