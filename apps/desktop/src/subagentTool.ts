import {
  createDelegationContext,
  isDelegatedChildRef,
  type AgentDefinition,
  type DelegatedChildRef,
  type DelegationChain,
  type DelegationPolicyContext,
  type PolicyActor,
} from '@iris/core';
import type {
  AgentProviderResolver,
  AgentRepository,
  AgentToolRuntime,
  AgentToolSuspension,
  ConversationRepository,
  PendingApprovalRef,
  SuspendedAgentTurn,
  SuspendedAgentTurnRepository,
} from '@iris/agents';
import { AgentSession, suspendedApprovals } from '@iris/agents';
import type { RegisteredTool, ToolContext, ToolDefinition, ToolRegistry } from '@iris/tools';

export const subAgentToolId = 'cortex.delegate-subagent';
export const subAgentTeamToolId = 'cortex.delegate-team';

export interface SubAgentToolInput {
  role: string;
  objective: string;
  instructions: string;
  model?: string;
}

export interface SubAgentTeamInput {
  tasks: SubAgentToolInput[];
}

/**
 * The real lifecycle state of one delegated sub-agent turn:
 *
 * ```
 * running ──approval-required──▶ suspended ──resolved──▶ running ──▶ completed | failed
 *    │                                │                                  ▲
 *    └────────────────────────────────┴──────────────────────────────────┴── cancelled
 * ```
 *
 * `suspended` is not terminal and not a failure: the child's tool has not run, its remaining work has
 * not happened, and it stays suspended — through the whole delegation chain above it — until the
 * deepest owner's approval is resolved. `completed` therefore always means the child turn really
 * finished. `cancelled` covers an aborted turn.
 */
export type SubAgentLifecycleStatus = 'completed' | 'failed' | 'suspended' | 'cancelled';

export interface SubAgentToolOutput {
  status: SubAgentLifecycleStatus;
  role: string;
  objective: string;
  toolsUsed: string[];
  output: string;
  /** Set only for `suspended`: the approval that must be resolved for this child turn to continue. */
  approvalId?: string;
  /** Set only for `suspended`: the tool the child is waiting to run. */
  pendingTool?: string;
  /**
   * Every delegated child of this invocation, in request order. A child that is waiting for approval
   * carries its `approvalId` (which may belong to a deeper descendant), which is how a suspended
   * delegation is resumed as the very same child instead of a fresh one.
   */
  children?: DelegatedChildRef[];
}

export interface SubAgentTeamOutput {
  status: 'completed' | 'partial' | 'failed' | 'suspended' | 'cancelled';
  results: SubAgentToolOutput[];
  /** Every team member in request order, with the approval of any member that is waiting. */
  children?: DelegatedChildRef[];
}

export interface SubAgentToolOptions {
  agentRepository: AgentRepository;
  providerResolver: AgentProviderResolver;
  agentToolRuntime: AgentToolRuntime;
  maxRecursionDepth?: number;
  /**
   * Persists a suspended child turn so the permission UI resolves it through the same coordinator
   * path a normal agent turn uses, and the child — not an orphaned tool execution — continues with
   * its own context. Without it a suspension is still reported truthfully, but cannot be resumed.
   */
  suspendedTurns?: SuspendedAgentTurnRepository;
  /**
   * Tool ids beyond this module's own delegation tools that can also create further agents (an alias
   * or wrapper). They follow the same nesting policy instead of being a hardcoded single-tool case.
   */
  delegationToolIds?: readonly string[];
  /** Registry consulted for `delegationCapable` metadata when the nesting limit is enforced. */
  toolRegistry?: ToolRegistry;
  /**
   * Recorded transcripts of delegated children. A resumed parent turn reads a child's recorded final
   * report from here instead of running the child again, so a chain that was interrupted by an
   * approval still reports the work that actually happened — exactly once.
   */
  conversations?: ConversationRepository;
}

const MAX_TEAM_SIZE = 4;

/**
 * Fields a model must never be able to set: they decide privilege and delegation depth, not the
 * task. The delegating runtime derives all of them from trusted state, so any caller that supplies
 * one is rejected instead of silently ignored.
 */
const privilegeFields = [
  'approvalMode',
  'toolIds',
  'inheritedPolicyAgentIds',
  'delegationDepth',
  'delegationChain',
  'ancestors',
  'agent',
  '_depth',
] as const;

export function hasPrivilegeArguments(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  return privilegeFields.some((field) => field in (input as Record<string, unknown>));
}

export function validateSubAgentInput(input: unknown): input is SubAgentToolInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  return (
    !hasPrivilegeArguments(value) &&
    typeof value.role === 'string' &&
    Boolean(value.role.trim()) &&
    typeof value.objective === 'string' &&
    Boolean(value.objective.trim()) &&
    typeof value.instructions === 'string' &&
    Boolean(value.instructions.trim()) &&
    (value.model === undefined || typeof value.model === 'string')
  );
}

export function validateSubAgentTeamInput(input: unknown): input is SubAgentTeamInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) return false;
  return value.tasks.every(validateSubAgentInput);
}

interface RunSubAgentContext {
  agentId: string;
  agentName: string;
  delegation?: DelegationPolicyContext;
  signal?: AbortSignal;
}

/**
 * Every tool that can create further agents: this module's two tools, anything the host declares,
 * and anything registered with `delegationCapable` metadata. Used to strip delegation capability at
 * the nesting limit, so no depth can open another agent through a different door.
 */
function delegationCapableToolIds(options: SubAgentToolOptions): Set<string> {
  const ids = new Set<string>([
    subAgentToolId,
    subAgentTeamToolId,
    ...(options.delegationToolIds ?? []),
  ]);
  for (const tool of options.toolRegistry?.list() ?? []) {
    if ((tool as ToolDefinition).delegationCapable) ids.add(tool.id);
  }
  return ids;
}

/**
 * The tools a delegated child may use. A child at the nesting limit keeps every ordinary tool but
 * loses every delegation capability, so it may run and report but cannot fan out further.
 */
export function assignSubAgentTools(
  toolIds: readonly string[],
  childDepth: number,
  maxDepth: number,
  options: SubAgentToolOptions,
): string[] {
  if (childDepth < maxDepth) return [...toolIds];
  const delegationTools = delegationCapableToolIds(options);
  return toolIds.filter((id) => !delegationTools.has(id));
}

function policyActorOf(agent: AgentDefinition): PolicyActor {
  return {
    id: agent.id,
    ...(agent.approvalMode ? { approvalMode: agent.approvalMode } : {}),
  };
}

/**
 * The agent that is delegating, from the authoritative invocation context.
 *
 * A delegated child is ephemeral and deliberately never persisted as a roster agent, so a repository
 * lookup would miss for exactly the nested delegations that matter, and a synthetic replacement
 * would silently reset depth and drop the policy chain. The runtime therefore passes the real
 * definition with the invocation; the repository is only consulted for a host that invokes the tool
 * with no agent context at all (a roster agent, which is a root), and anything unknown fails closed.
 */
async function resolveParentAgent(
  options: SubAgentToolOptions,
  context: ToolContext,
): Promise<AgentDefinition> {
  if (context.agent) {
    if (context.agent.id !== context.agentId) {
      throw new Error(
        'Delegation refused: the invoking agent identity does not match its runtime context.',
      );
    }
    // A delegated agent always carries its trusted chain. Claiming a depth without one is an
    // inconsistent runtime context, and treating it as a root could reset delegation depth.
    if (context.agent.delegationDepth !== undefined && !context.delegation) {
      throw new Error(
        'Delegation refused: this agent reports a delegation depth without a trusted delegation context.',
      );
    }
    return context.agent;
  }
  const stored = await options.agentRepository.get(context.agentId);
  if (stored) return stored;
  throw new Error(
    `Delegation refused: agent ${context.agentId} is unknown in this runtime, so its delegation depth and policy chain cannot be trusted.`,
  );
}

function outputText(streamed: string, terminal: string | null): string {
  if (terminal !== null && terminal.trim()) return terminal;
  if (streamed.trim()) return streamed;
  return 'Sub-agent completed without returning text output.';
}

/**
 * The delegated-child record for a child turn that stopped, including the approval blocking it. A
 * child may itself be blocked on a deeper descendant's approval, in which case the deepest owner is
 * recorded — the chain is resolved from the bottom up, one owner at a time.
 */
function childRefOf(
  childAgentId: string,
  childDepth: number,
  blocking: PendingApprovalRef | undefined,
  partialOutput?: string,
): DelegatedChildRef {
  return {
    childAgentId,
    depth: childDepth,
    ...(partialOutput?.trim() ? { partialOutput } : {}),
    ...(blocking
      ? {
          approvalId: blocking.approvalId,
          ownerAgentId: blocking.ownerAgentId,
          ...(blocking.toolId ? { toolId: blocking.toolId } : {}),
          ...(blocking.toolName ? { toolName: blocking.toolName } : {}),
        }
      : {}),
  };
}

/**
 * The delegated children a delegation-tool output reports, or `null` when the output is not one of
 * ours. The runtime reads this to learn that a call is waiting on a descendant instead of finished.
 */
export function delegatedChildrenOf(output: unknown): DelegatedChildRef[] | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const children = (output as { children?: unknown }).children;
  if (!Array.isArray(children) || children.length === 0) return null;
  return children.every(isDelegatedChildRef) ? children : null;
}

/**
 * Translates a completed tool execution into the runtime's lifecycle vocabulary.
 *
 * A delegation tool that hands its work to a child which is waiting for approval is not finished,
 * even though the tool itself returned normally: its output names the delegated children, and any
 * child holding an approval means the turn must report a suspension and stop. Reporting `completed`
 * here is what let an ancestor claim success while a descendant still waited.
 */
export function delegatedExecutionResult(output: unknown): DelegatedExecutionResult {
  const children = delegatedChildrenOf(output);
  if (children?.some((child) => child.approvalId)) {
    return { status: 'suspended', suspension: { children } };
  }
  return { status: 'completed', output };
}

export type DelegatedExecutionResult =
  | { status: 'completed'; output: unknown }
  | { status: 'suspended'; suspension: AgentToolSuspension };

interface RecoveredChild {
  ref: DelegatedChildRef;
  status: SubAgentLifecycleStatus;
  output: string;
  blocking?: PendingApprovalRef;
}

/**
 * What actually happened to a delegated child while its parent turn was suspended: still waiting for
 * approval, or finished with a recorded report. Recovery reads durable state only — it never runs a
 * child again, so a resumed chain cannot duplicate a child's side effects.
 */
async function recoverChild(
  options: SubAgentToolOptions,
  child: DelegatedChildRef,
): Promise<RecoveredChild> {
  const suspended: SuspendedAgentTurn | null =
    (await options.suspendedTurns?.getByAgentId(child.childAgentId)) ?? null;
  if (suspended) {
    const blocking = suspendedApprovals(suspended)[0];
    // The child's own suspension is the durable record of what it produced before stopping, so a
    // chain that is resumed while this child still waits reports that progress verbatim.
    const partial = suspended.pending.assistantText.trim() || child.partialOutput?.trim() || '';
    const ref = childRefOf(child.childAgentId, child.depth ?? 0, blocking, partial);
    return {
      ref,
      status: 'suspended',
      output: partial
        ? partial
        : blocking?.toolName
          ? `Sub-agent is waiting for approval to run ${blocking.toolName}.`
          : 'Sub-agent is waiting for approval.',
      ...(blocking ? { blocking } : {}),
    };
  }

  const messages = (await options.conversations?.list(child.childAgentId)) ?? [];
  const report = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim());
  const settled: DelegatedChildRef = {
    childAgentId: child.childAgentId,
    ...(child.depth !== undefined ? { depth: child.depth } : {}),
  };
  if (!report) {
    return {
      ref: settled,
      status: 'failed',
      output: 'Sub-agent ended without recording a final report.',
    };
  }
  return { ref: settled, status: 'completed', output: report.content };
}

function outputForRecovered(
  task: SubAgentToolInput,
  recovered: RecoveredChild,
): SubAgentToolOutput {
  const base = { role: task.role.trim(), objective: task.objective.trim() };
  if (recovered.status === 'suspended') {
    return {
      ...base,
      status: 'suspended',
      toolsUsed: [],
      output: recovered.output,
      ...(recovered.blocking
        ? {
            approvalId: recovered.blocking.approvalId,
            ...(recovered.blocking.toolName
              ? { pendingTool: recovered.blocking.toolName }
              : {}),
          }
        : {}),
      children: [recovered.ref],
    } satisfies SubAgentToolOutput;
  }
  return {
    ...base,
    status: recovered.status,
    toolsUsed: [],
    output: recovered.output,
    children: [recovered.ref],
  } satisfies SubAgentToolOutput;
}

/**
 * Re-invocation of a single delegation that previously suspended. The child is identified by the
 * runtime's recorded reference, so this resumes the same child — it never delegates again.
 */
async function resumeSubAgent(
  options: SubAgentToolOptions,
  task: SubAgentToolInput,
  children: DelegatedChildRef[],
): Promise<SubAgentToolOutput> {
  if (children.length !== 1) {
    throw new Error(
      `cortex_delegate_subagent cannot resume ${children.length} delegated children; exactly one is required.`,
    );
  }
  const recovered = await recoverChild(options, children[0]);
  return outputForRecovered(task, recovered);
}

/** Re-invocation of a team delegation, recovering each member's recorded outcome in task order. */
async function resumeSubAgentTeam(
  options: SubAgentToolOptions,
  input: SubAgentTeamInput,
  children: DelegatedChildRef[],
): Promise<SubAgentTeamOutput> {
  if (children.length !== input.tasks.length) {
    throw new Error(
      `cortex_delegate_team cannot resume ${children.length} delegated members for ${input.tasks.length} tasks.`,
    );
  }
  const recovered = await Promise.all(
    children.map((child) => recoverChild(options, child)),
  );
  const results = recovered.map((entry, index) => outputForRecovered(input.tasks[index], entry));
  return {
    status: teamStatusOf(results),
    results,
    children: recovered.map((entry) => entry.ref),
  };
}

function teamStatusOf(results: SubAgentToolOutput[]): SubAgentTeamOutput['status'] {
  const stranded = results.filter(
    (result) => result.status === 'failed' || result.status === 'cancelled',
  ).length;
  return results.some((result) => result.status === 'suspended')
    ? 'suspended'
    : results.every((result) => result.status === 'cancelled')
      ? 'cancelled'
      : stranded === 0
        ? 'completed'
        : stranded === results.length
          ? 'failed'
          : 'partial';
}

/**
 * Builds an ephemeral specialist AgentDefinition and runs one focused session to completion. Shared
 * by the single-delegation and parallel-team tools so both get identical depth guards, delegation
 * policy and output shaping.
 */
async function runSubAgent(
  options: SubAgentToolOptions,
  parentAgent: AgentDefinition,
  task: SubAgentToolInput,
  childDepth: number,
  maxDepth: number,
  context: RunSubAgentContext,
): Promise<SubAgentToolOutput> {
  const role = task.role.trim();
  const objective = task.objective.trim();
  const base = { role, objective };

  if (childDepth > maxDepth) {
    return {
      ...base,
      status: 'failed',
      toolsUsed: [],
      output: `Sub-agent recursion depth limit exceeded (maximum allowed depth is ${maxDepth}).`,
    };
  }

  // The trusted delegation chain is transported, never reconstructed: depth comes from the invoking
  // agent's own runtime context (a root agent is depth 0) and the ancestors are the invoking agent
  // plus everything above it. This is the authority for depth, for stopping further delegation, and
  // for binding the child to every ancestor's explicit permission rules.
  const chain: DelegationChain = {
    depth: childDepth,
    ancestors: [policyActorOf(parentAgent), ...(context.delegation?.ancestors ?? [])],
  };
  const delegation = createDelegationContext(chain);

  // Ephemeral sub-agent definition scoped for this delegation task. Privilege only ever stays equal
  // or shrinks: the child inherits the parent's approval mode (never a more permissive one), keeps
  // the parent's tool assignment minus delegation capability at the nesting limit, and carries the
  // whole delegation chain so every ancestor's deny/ask rule still binds it. `inheritedPolicyAgentIds`
  // and `delegationDepth` below are descriptive only — the trusted chain above is what the permission
  // engine reads, so populating them can never change an outcome.
  const subAgent: AgentDefinition = {
    id: `subagent-${crypto.randomUUID()}`,
    name: role,
    providerPolicyId: parentAgent.providerPolicyId,
    model: task.model?.trim() || parentAgent.model,
    persona: `You are an autonomous specialist sub-agent working as "${role}". Your objective is: "${objective}". Solve this task thoroughly using your available tools, and conclude with a clear, concise, verified summary of your findings and results.`,
    autonomy: parentAgent.autonomy,
    approvalMode: parentAgent.approvalMode,
    inheritedPolicyAgentIds: [parentAgent.id, ...(parentAgent.inheritedPolicyAgentIds ?? [])],
    delegationDepth: childDepth,
    toolIds: assignSubAgentTools(parentAgent.toolIds, childDepth, maxDepth, options),
    skillIds: [...parentAgent.skillIds],
  };

  try {
    const { provider, model } = await options.providerResolver.resolve(subAgent);
    const session = new AgentSession(
      subAgent,
      provider,
      model,
      [],
      options.agentToolRuntime,
      undefined,
      [],
      undefined,
      delegation,
    );

    const prompt = `Specialist Assignment: ${role}\nObjective: ${objective}\n\nDetailed Instructions:\n${task.instructions.trim()}\n\nPlease execute your task using your tools and return your final report.`;

    const events = session.send(prompt, context.signal);
    let streamedOutput = '';
    let terminalOutput: string | null = null;
    const toolsUsed: string[] = [];

    for await (const event of events) {
      if (event.type === 'tool-call') {
        toolsUsed.push(event.call.name);
      }
      if (event.type === 'assistant-chunk') {
        streamedOutput += event.text;
      }
      if (event.type === 'assistant-complete') {
        terminalOutput = event.message.content;
      }
    }

    // The session — not the fact that the event stream ended — decides whether the turn finished. A
    // turn that stopped to ask for approval is suspended, and any text it already produced is partial
    // progress, not a final report.
    const suspended = session.suspendedTurn();
    if (suspended) {
      await options.suspendedTurns?.save(suspended);
      // The chain is resolved from its deepest owner upward, so a child that is itself waiting on a
      // grandchild reports that grandchild's approval — and never a "completed" of its own.
      const blocking = suspendedApprovals(suspended)[0];
      const ref = childRefOf(subAgent.id, childDepth, blocking, streamedOutput);
      return {
        ...base,
        status: 'suspended',
        toolsUsed: [...new Set(toolsUsed)],
        // Whatever the child produced before the approval is reported verbatim; only a child that
        // produced nothing gets a truthful placeholder instead of a fabricated report.
        output: streamedOutput.trim()
          ? streamedOutput
          : blocking?.toolName
            ? `Sub-agent is waiting for approval to run ${blocking.toolName}.`
            : 'Sub-agent is waiting for approval.',
        ...(blocking
          ? {
              approvalId: blocking.approvalId,
              ...(blocking.toolName ? { pendingTool: blocking.toolName } : {}),
            }
          : {}),
        children: [ref],
      } satisfies SubAgentToolOutput;
    }

    // A child that reached a terminal state records its transcript, so a parent turn whose own
    // delegation is resumed later reports this child's real report instead of re-running it.
    await options.conversations?.save(subAgent.id, session.messages());
    const settledRef = childRefOf(subAgent.id, childDepth, undefined);

    if (terminalOutput !== null) {
      return {
        ...base,
        status: 'completed',
        toolsUsed: [...new Set(toolsUsed)],
        output: outputText(streamedOutput, terminalOutput),
        children: [settledRef],
      } satisfies SubAgentToolOutput;
    }

    // A stream that ended without completion and without a suspension is a failure, never a success.
    return {
      ...base,
      status: 'failed',
      toolsUsed: [...new Set(toolsUsed)],
      output: 'Sub-agent ended without reaching a terminal state.',
      children: [settledRef],
    } satisfies SubAgentToolOutput;
  } catch (error) {
    if (context.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return {
        ...base,
        status: 'cancelled',
        toolsUsed: [],
        output: 'Sub-agent was cancelled before it finished.',
        children: [childRefOf(subAgent.id, childDepth, undefined)],
      } satisfies SubAgentToolOutput;
    }
    return {
      ...base,
      status: 'failed',
      toolsUsed: [],
      output:
        error instanceof Error && error.message.trim()
          ? `Sub-agent failed: ${error.message}`
          : 'Sub-agent failed without returning a reason.',
      children: [childRefOf(subAgent.id, childDepth, undefined)],
    } satisfies SubAgentToolOutput;
  }
}

function runContextFor(context: ToolContext): RunSubAgentContext {
  return {
    agentId: context.agentId,
    agentName: context.agentName,
    delegation: context.delegation,
    signal: context.signal,
  };
}

export function createSubAgentTool(options: SubAgentToolOptions): RegisteredTool {
  const maxDepth = options.maxRecursionDepth ?? 2;

  return {
    id: subAgentToolId,
    name: 'cortex_delegate_subagent',
    providerName: 'cortex_delegate_subagent',
    description:
      'Delegate a specialized sub-task to an autonomous specialist sub-agent (e.g. "Code Reviewer", "Deep Researcher", "System Diagnostician", "Workspace Explorer") that runs in its own focused execution context and returns a verified summary of its results.',
    risk: 'execute',
    delegationCapable: true,
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description:
            'The specialized role of the sub-agent (e.g. "Code Reviewer", "Workspace Researcher", "System Diagnostician", "Architecture Critic").',
        },
        objective: {
          type: 'string',
          description: 'The primary goal or question the sub-agent must solve.',
        },
        instructions: {
          type: 'string',
          description: 'Detailed instructions, context, constraints, and steps for the sub-agent.',
        },
        model: {
          type: 'string',
          description: 'Optional model override for the sub-agent (defaults to parent agent model).',
        },
      },
      required: ['role', 'objective', 'instructions'],
      additionalProperties: false,
    },
    async run(input: unknown, context: ToolContext): Promise<unknown> {
      if (hasPrivilegeArguments(input)) {
        throw new Error(
          'cortex_delegate_subagent cannot choose permissions: approvalMode, toolIds, inheritedPolicyAgentIds, delegationDepth, delegationChain and _depth are derived from the delegating agent.',
        );
      }
      if (!validateSubAgentInput(input)) {
        throw new Error(
          'cortex_delegate_subagent requires "role", "objective", and "instructions" as non-empty text.',
        );
      }

      const resume = context.resume?.children;
      if (resume?.length) return resumeSubAgent(options, input, resume);

      const parentAgent = await resolveParentAgent(options, context);
      const childDepth = (context.delegation?.depth ?? 0) + 1;
      return runSubAgent(options, parentAgent, input, childDepth, maxDepth, runContextFor(context));
    },
  };
}

export function createSubAgentTeamTool(options: SubAgentToolOptions): RegisteredTool {
  const maxDepth = options.maxRecursionDepth ?? 2;

  return {
    id: subAgentTeamToolId,
    name: 'cortex_delegate_team',
    providerName: 'cortex_delegate_team',
    description:
      'Fan a task out to a team of 1-4 specialist sub-agents that run in parallel and return individual reports. Use this when several independent perspectives or work streams are needed at once (e.g. a researcher, a reviewer and a tester working simultaneously). Each member inherits the parent agent\'s tools and model unless overridden per task.',
    risk: 'execute',
    delegationCapable: true,
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_TEAM_SIZE,
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', description: 'Specialist role, e.g. "Security Reviewer".' },
              objective: { type: 'string', description: 'The goal this member must solve.' },
              instructions: {
                type: 'string',
                description: 'Detailed instructions, context, constraints, and steps.',
              },
              model: {
                type: 'string',
                description: 'Optional model override for this member.',
              },
            },
            required: ['role', 'objective', 'instructions'],
            additionalProperties: false,
          },
          description: `The team members to run in parallel (1-${MAX_TEAM_SIZE}).`,
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
    async run(input: unknown, context: ToolContext): Promise<unknown> {
      if (hasPrivilegeArguments(input)) {
        throw new Error(
          'cortex_delegate_team cannot choose permissions: approvalMode, toolIds, inheritedPolicyAgentIds, delegationDepth, delegationChain and _depth are derived from the delegating agent.',
        );
      }
      if (!validateSubAgentTeamInput(input)) {
        throw new Error(
          'cortex_delegate_team requires "tasks": a non-empty array (max ' +
            `${MAX_TEAM_SIZE}) of {role, objective, instructions} objects.`,
        );
      }
      if (input.tasks.length > MAX_TEAM_SIZE) {
        throw new Error(
          `cortex_delegate_team runs at most ${MAX_TEAM_SIZE} members in parallel.`,
        );
      }

      const resume = context.resume?.children;
      if (resume?.length) return resumeSubAgentTeam(options, input, resume);

      const parentAgent = await resolveParentAgent(options, context);
      const childDepth = (context.delegation?.depth ?? 0) + 1;
      const runContext = runContextFor(context);

      const results = await Promise.all(
        input.tasks.map((task) =>
          runSubAgent(options, parentAgent, task, childDepth, maxDepth, runContext),
        ),
      );

      return {
        status: teamStatusOf(results),
        results,
        children: results.map((result) => result.children?.[0] ?? { childAgentId: '' }).filter(
          (child) => child.childAgentId,
        ),
      } satisfies SubAgentTeamOutput;
    },
  };
}
